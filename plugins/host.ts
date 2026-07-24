import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import fs from "node:fs";
import type { Plugin, ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The host bridge: lets the shell inside the browser run real commands on the
 * machine serving it.
 *
 * A browser has no process API, so `npm run dev` can only work if something
 * outside the page spawns it. That something is this plugin — it runs inside
 * the Vite dev server, spawns children, and streams their output back over SSE.
 *
 * DEV ONLY, BY CONSTRUCTION. `configureServer` never runs for a production
 * build, so the deployed static site has no bridge and no way to execute
 * anything. Commands are also confined to directories beneath the scan root,
 * so a stray request can't cd into /etc and start poking around.
 */

const EXEC = "/__vs/exec";
const JOBS = "/__vs/jobs";
const KILL = "/__vs/kill/";
const BROWSE = "/__vs/browse";

/**
 * How many remote origins may hold a proxy port at once. Each is a live
 * http.Server, so this is a real resource; browsing hops between origins
 * constantly and without a cap a long session would leak listeners.
 */
const MAX_ORIGINS = 24;

/**
 * Injected into every proxied HTML document so the framed page can tell the
 * shell where it just went.
 *
 * The page is served from `localhost:<proxyPort>`, so `location.href` is the
 * proxy's URL, not the real one — the origin is baked in here and the path
 * taken from the live location, which reconstitutes the address the user
 * should actually see. History is patched because single-page apps navigate
 * without ever firing a load event.
 */
const reporter = (origin: string) => `<script>(function(){
  var ORIGIN = ${JSON.stringify(origin)};
  function report() {
    try {
      parent.postMessage({
        __voidshell: "nav",
        url: ORIGIN + location.pathname + location.search + location.hash,
        title: document.title
      }, "*");
    } catch (e) {}
  }
  if (document.readyState !== "loading") report();
  document.addEventListener("DOMContentLoaded", report);
  addEventListener("popstate", report);
  addEventListener("hashchange", report);
  ["pushState", "replaceState"].forEach(function (k) {
    var orig = history[k];
    history[k] = function () { var r = orig.apply(this, arguments); report(); return r; };
  });
})();</script>`;

interface Job {
  id: string;
  cmd: string;
  cwd: string;
  proc: ChildProcess;
  /** Ring buffer of recent output, so a late subscriber still sees context. */
  backlog: { kind: string; text: string }[];
  subscribers: Set<ServerResponse>;
  status: "running" | "exited";
  exitCode: number | null;
  /** Port sniffed out of the child's own output, for the app proxy. */
  port: number | null;
}

const jobs = new Map<string, Job>();
let counter = 0;

const MAX_BACKLOG = 400;

/** Pull "localhost:3000" / "http://127.0.0.1:5000" out of dev-server chatter. */
function sniffPort(text: string): number | null {
  const m = text.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/);
  if (!m) return null;
  const port = Number(m[1]);
  return port > 0 && port < 65536 ? port : null;
}

function send(job: Job, kind: string, text: string): void {
  const line = { kind, text };
  job.backlog.push(line);
  if (job.backlog.length > MAX_BACKLOG) job.backlog.shift();

  if (!job.port) {
    const p = sniffPort(text);
    // Ignore our own port; we want the child's.
    if (p) job.port = p;
  }

  const payload = `data: ${JSON.stringify(line)}\n\n`;
  for (const res of job.subscribers) {
    try {
      res.write(payload);
    } catch {
      job.subscribers.delete(res);
    }
  }
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};

export interface HostPluginOptions {
  /** Commands may only run at or below this directory. Defaults to vite root's parent. */
  root?: string;
}

export function voidshellHost(opts: HostPluginOptions = {}): Plugin {
  let sandboxRoot = "";

  return {
    name: "voidshell-host",
    apply: "serve", // never present in a production build

    configResolved(config) {
      sandboxRoot = opts.root ?? path.resolve(config.root, "..");
    },

    configureServer(server: ViteDevServer) {
      /** Reject anything outside the sandbox, including via symlink or "..". */
      const safeCwd = (raw: string | undefined): string => {
        const candidate = path.resolve(sandboxRoot, raw || ".");
        const real = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
        const rootReal = fs.realpathSync(sandboxRoot);
        if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
          throw new Error(`outside sandbox: ${raw}`);
        }
        if (!fs.existsSync(real) || !fs.statSync(real).isDirectory()) {
          throw new Error(`not a directory: ${raw}`);
        }
        return real;
      };

      // ---- spawn ----
      server.middlewares.use(EXEC, async (req, res, next) => {
        if (req.method !== "POST") return next();
        const body = await readBody(req);
        const cmd = String(body.cmd ?? "").trim();
        if (!cmd) return json(res, 400, { error: "no command" });

        let cwd: string;
        try {
          cwd = safeCwd(body.cwd);
        } catch (err) {
          return json(res, 400, { error: String((err as Error).message) });
        }

        const id = `job-${++counter}`;
        // shell:true so "npm run dev", pipes, and && behave as typed.
        const proc = spawn(cmd, {
          cwd,
          shell: true,
          // Own process group, so killing -pid takes the whole tree with it.
          // `npm run dev` spawns a child of its own that would otherwise leak.
          detached: true,
          env: {
            ...process.env,
            FORCE_COLOR: "0",
            NO_COLOR: "1",
            CI: "1",
            // Children buffer stdout when it isn't a tty, which hides a dev
            // server's "listening on :PORT" line until it exits. Python honours
            // this; Node tooling generally flushes on its own.
            PYTHONUNBUFFERED: "1",
          },
        });

        const job: Job = {
          id,
          cmd,
          cwd,
          proc,
          backlog: [],
          subscribers: new Set(),
          status: "running",
          exitCode: null,
          port: null,
        };
        jobs.set(id, job);

        proc.stdout?.on("data", (b) => send(job, "out", b.toString()));
        proc.stderr?.on("data", (b) => send(job, "err", b.toString()));
        proc.on("error", (e) => send(job, "err", e.message));
        proc.on("close", (code) => {
          job.status = "exited";
          job.exitCode = code;
          send(job, "exit", `— exited with code ${code} —`);
          for (const r of job.subscribers) {
            try {
              r.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`);
              r.end();
            } catch {
              /* subscriber already gone */
            }
          }
          job.subscribers.clear();
        });

        json(res, 200, { id, cmd, cwd });
      });

      // ---- stream (SSE) ----
      server.middlewares.use(`${EXEC}/`, (req, res, next) => {
        if (req.method !== "GET") return next();
        const id = (req.url ?? "").replace(/^\//, "").split("?")[0];
        const job = jobs.get(id);
        if (!job) return json(res, 404, { error: "no such job" });

        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
        });
        for (const line of job.backlog) res.write(`data: ${JSON.stringify(line)}\n\n`);
        if (job.status === "exited") {
          res.write(`event: done\ndata: ${JSON.stringify({ code: job.exitCode })}\n\n`);
          return res.end();
        }
        job.subscribers.add(res);
        req.on("close", () => job.subscribers.delete(res));
      });

      // ---- kill ----
      server.middlewares.use(KILL, (req, res) => {
        const id = (req.url ?? "").replace(/^\//, "").split("?")[0];
        const job = jobs.get(id);
        if (!job) return json(res, 404, { error: "no such job" });
        try {
          // Negative pid kills the whole group, so `npm run dev`'s children die too.
          process.kill(-job.proc.pid!, "SIGTERM");
        } catch {
          job.proc.kill("SIGTERM");
        }
        json(res, 200, { ok: true });
      });

      // ---- list ----
      server.middlewares.use(JOBS, (_req, res) => {
        json(
          res,
          200,
          [...jobs.values()].map((j) => ({
            id: j.id,
            cmd: j.cmd,
            cwd: j.cwd,
            status: j.status,
            exitCode: j.exitCode,
            port: j.port,
          }))
        );
      });

      /**
       * A dedicated proxy port per framed app.
       *
       * Mounting a child under `/__vs/app/<port>/` cannot work: the child's
       * HTML and modules use *absolute* paths (`/src/main.jsx`,
       * `/node_modules/.vite/deps/react.js`), which resolve against the origin
       * root and hit voidshell instead. Referer routing only fixes the first
       * level — a module imported by a module carries the importing module's
       * URL, not the frame's.
       *
       * So each app gets its own ephemeral port serving it at root. Absolute
       * paths then resolve correctly, and because we own the response we can
       * inject the COEP/CORP headers the child needs to be embeddable inside a
       * cross-origin-isolated parent — which the child's own server won't send.
       */
      const frameServers = new Map<number, number>(); // child port -> frame port

      const ensureFrameServer = (port: number): Promise<number> => {
        const existing = frameServers.get(port);
        if (existing) return Promise.resolve(existing);

        return new Promise((resolve, reject) => {
          const proxy = http.createServer((preq, pres) => {
            const up = http.request(
              {
                host: "localhost",
                port,
                path: preq.url,
                method: preq.method,
                headers: { ...preq.headers, host: `localhost:${port}` },
              },
              (ures) => {
                const headers = { ...ures.headers };
                delete headers["x-frame-options"];
                delete headers["content-security-policy"];
                headers["cross-origin-resource-policy"] = "cross-origin";
                headers["cross-origin-embedder-policy"] = "credentialless";
                pres.writeHead(ures.statusCode ?? 502, headers);
                ures.pipe(pres);
              }
            );
            up.on("error", (e) => {
              if (!pres.headersSent) pres.statusCode = 502;
              pres.end(`proxy: ${e.message}`);
            });
            // The client can disconnect mid-response; drop the upstream request
            // rather than letting the write fail unhandled.
            pres.on("error", () => up.destroy());
            preq.on("error", () => up.destroy());
            preq.pipe(up);
          });

          // Forward HMR websockets too, so hot reload still works in the frame.
          proxy.on("upgrade", (preq, socket, head) => {
            // Piped sockets emit 'error' when the peer goes away mid-write.
            // Unhandled, that error propagates and kills the whole dev server,
            // so both ends are wired to tear the pair down quietly instead.
            const bind = (a: import("node:net").Socket, b: import("node:net").Socket) => {
              a.on("error", () => b.destroy());
              a.on("close", () => b.destroy());
            };

            socket.on("error", () => socket.destroy());

            const up = http.request({
              host: "localhost",
              port,
              path: preq.url,
              method: preq.method,
              headers: preq.headers,
            });
            up.end();
            up.on("upgrade", (ures, usocket, uhead) => {
              const lines = Object.entries(ures.headers).map(
                ([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`
              );
              socket.write(
                `HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`
              );
              if (uhead?.length) socket.unshift(uhead);
              bind(socket, usocket);
              bind(usocket, socket);
              usocket.pipe(socket);
              socket.pipe(usocket);
            });
            up.on("error", () => socket.destroy());
            if (head?.length) socket.unshift(head);
          });

          proxy.on("error", reject);
          proxy.listen(0, "127.0.0.1", () => {
            const addr = proxy.address();
            const framePort = typeof addr === "object" && addr ? addr.port : 0;
            frameServers.set(port, framePort);
            frameProxies.push(proxy);
            resolve(framePort);
          });
        });
      };

      const frameProxies: http.Server[] = [];

      /**
       * The same trick, pointed at the open web.
       *
       * A browser refuses to frame a document whose server sends
       * `X-Frame-Options: DENY` or a CSP `frame-ancestors` — and Google,
       * YouTube, GitHub and every major search engine send one or the other.
       * No client-side code can defeat that, because the enforcement is in the
       * browser, not the page. The only way to embed those is to be the one
       * serving the response, which is what this does.
       *
       * One proxy port **per origin**, for exactly the reason the app proxy
       * uses one per port: a page's absolute URLs (`/w/load.php`,
       * `/static/app.js`) resolve against the origin root. Serving wikipedia at
       * the root of its own port means those resolve back through the proxy;
       * mounting it under a path would send them to voidshell instead.
       *
       * DEV ONLY, like the rest of this plugin. `configureServer` never runs
       * for a production build, so a deployed voidshell has no proxy and the
       * browser falls back to framing directly — which works only for sites
       * that permit it.
       */
      const originProxies = new Map<string, number>();
      const originOrder: string[] = [];

      /** Normalise to scheme://host[:port], the unit a proxy port serves. */
      const originOf = (raw: string): URL => {
        const url = new URL(raw);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error(`unsupported scheme: ${url.protocol}`);
        }
        return url;
      };

      const ensureOriginProxy = (origin: string): Promise<number> => {
        const existing = originProxies.get(origin);
        if (existing) return Promise.resolve(existing);

        const target = new URL(origin);
        const secure = target.protocol === "https:";
        const agent = secure ? https : http;

        return new Promise((resolve, reject) => {
          const proxy = http.createServer((preq, pres) => {
            const headers: Record<string, unknown> = { ...preq.headers };
            // The upstream must see its own name, not localhost:41234.
            headers.host = target.host;
            // Both would otherwise announce a localhost proxy port, which some
            // servers reject outright as a cross-site request.
            delete headers.origin;
            delete headers.referer;
            // Hop-by-hop; forwarding it upstream is meaningless and confusing.
            delete headers.connection;
            // HTML gets a reporter script injected below, which means reading
            // the body. Asking for identity avoids having to gunzip and
            // re-gzip it; this is localhost, so the bytes are free.
            headers["accept-encoding"] = "identity";

            const up = agent.request(
              {
                protocol: target.protocol,
                host: target.hostname,
                port: target.port || (secure ? 443 : 80),
                path: preq.url,
                method: preq.method,
                headers,
              },
              async (ures) => {
                const out: Record<string, unknown> = { ...ures.headers };

                // The entire point: strip what forbids framing.
                delete out["x-frame-options"];
                delete out["content-security-policy"];
                delete out["content-security-policy-report-only"];
                // And add what our cross-origin-isolated parent requires.
                out["cross-origin-resource-policy"] = "cross-origin";
                out["cross-origin-embedder-policy"] = "credentialless";

                // Cookies scoped to the real domain would be dropped by the
                // browser, since the page is being served from localhost.
                // Rewriting them keeps sessions working per proxy port.
                const cookies = ures.headers["set-cookie"];
                if (Array.isArray(cookies)) {
                  out["set-cookie"] = cookies.map((c) =>
                    c
                      .replace(/;\s*Domain=[^;]*/gi, "")
                      .replace(/;\s*Secure/gi, "")
                      .replace(/;\s*SameSite=None/gi, "; SameSite=Lax")
                  );
                }

                // A redirect to another origin needs its own proxy port, or the
                // browser would leave the proxy and hit the blocked site
                // directly. http->https and bare->www both land here constantly.
                const location = ures.headers.location;
                if (typeof location === "string" && location) {
                  try {
                    const next = new URL(location, origin);
                    const nextOrigin = next.origin;
                    if (nextOrigin !== origin) {
                      const port = await ensureOriginProxy(nextOrigin);
                      out.location = `http://localhost:${port}${next.pathname}${next.search}${next.hash}`;
                    } else {
                      out.location = `${next.pathname}${next.search}${next.hash}`;
                    }
                  } catch {
                    /* not a URL we can rewrite — pass it through untouched */
                  }
                }

                const status = ures.statusCode ?? 502;
                const type = String(out["content-type"] ?? "");

                // Anything that isn't a document streams straight through.
                if (!type.includes("text/html")) {
                  pres.writeHead(status, out as http.OutgoingHttpHeaders);
                  ures.pipe(pres);
                  return;
                }

                // A framed page is cross-origin, so the shell cannot read its
                // location — click a link and the URL bar would silently go
                // stale. Since we're the one serving the bytes, we can have the
                // page report its own navigation instead. This is what makes
                // back/forward and the address bar behave like a browser's
                // rather than like a bookmark list.
                const chunks: Buffer[] = [];
                ures.on("data", (c: Buffer) => chunks.push(c));
                ures.on("end", () => {
                  const body = Buffer.concat(chunks).toString("utf8");
                  const patched = body.replace(/<head([^>]*)>/i, (m) => m + reporter(origin));
                  delete out["content-length"];
                  out["content-length"] = Buffer.byteLength(patched);
                  pres.writeHead(status, out as http.OutgoingHttpHeaders);
                  pres.end(patched);
                });
                ures.on("error", () => pres.destroy());
              }
            );

            up.on("error", (e) => {
              if (!pres.headersSent) pres.statusCode = 502;
              pres.end(`proxy: ${e.message}`);
            });
            pres.on("error", () => up.destroy());
            preq.on("error", () => up.destroy());
            preq.pipe(up);
          });

          proxy.on("error", reject);
          // 127.0.0.1, never 0.0.0.0: this forwards arbitrary URLs, and it must
          // not be reachable from anywhere but this machine.
          proxy.listen(0, "127.0.0.1", () => {
            const addr = proxy.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            originProxies.set(origin, port);
            originOrder.push(origin);
            frameProxies.push(proxy);

            // Evict the oldest origin once past the cap.
            while (originOrder.length > MAX_ORIGINS) {
              const stale = originOrder.shift()!;
              originProxies.delete(stale);
            }
            resolve(port);
          });
        });
      };

      server.middlewares.use(BROWSE, async (req, res, next) => {
        if (req.method !== "POST") return next();
        const body = await readBody(req);
        try {
          const url = originOf(String(body.url ?? ""));
          const port = await ensureOriginProxy(url.origin);
          json(res, 200, {
            framePort: port,
            path: `${url.pathname}${url.search}${url.hash}`,
            origin: url.origin,
          });
        } catch (err) {
          json(res, 400, { error: String((err as Error).message) });
        }
      });

      // Ask for (or create) the framing port for a running app.
      server.middlewares.use("/__vs/frame", async (req, res, next) => {
        if (req.method !== "POST") return next();
        const body = await readBody(req);
        const port = Number(body.port);
        if (!port) return json(res, 400, { error: "no port" });
        try {
          json(res, 200, { port, framePort: await ensureFrameServer(port) });
        } catch (err) {
          json(res, 500, { error: String((err as Error).message) });
        }
      });

      // Don't leave orphaned dev servers behind when vite restarts.
      const cleanup = () => {
        for (const proxy of frameProxies) {
          try {
            proxy.close();
          } catch {
            /* already closed */
          }
        }
        frameProxies.length = 0;
        frameServers.clear();
        originProxies.clear();
        originOrder.length = 0;
        for (const job of jobs.values()) {
          try {
            process.kill(-job.proc.pid!, "SIGTERM");
          } catch {
            job.proc.kill("SIGTERM");
          }
        }
      };
      server.httpServer?.on("close", cleanup);
      process.once("exit", cleanup);
    },
  };
}
