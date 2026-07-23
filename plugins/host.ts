import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
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
