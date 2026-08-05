import type { KernelContext, LaunchArgs, VoidModule } from "../../kernel/types";
import { fetchHostJobs, type HostJob } from "../../runtime/hostBridge";

/**
 * Hosts a running dev server as a window.
 *
 * The iframe points at the host bridge's proxy rather than straight at
 * `localhost:<port>`: same-origin means the frame isn't blocked by our
 * cross-origin isolation, and the proxy stamps on the headers the nested
 * document needs to be embeddable at all.
 *
 * Launched without a port it used to be a rectangle reading "No port." — a
 * launcher tile that could not do anything from the launcher, which is where
 * most people meet it. It now asks the host what is actually running and
 * offers those, and when there is no bridge at all it says *that* instead of
 * describing a console command that would also fail.
 */
export const webapp: VoidModule = {
  manifest: {
    id: "webapp",
    name: "Dev Server",
    kind: "app",
    glyph: "◱",
    blurb: "frame a running dev server",
    singleton: false,
    version: "0.2.0",
  },

  activate() {},

  launch(ctx: KernelContext, args?: LaunchArgs) {
    // `path` carries the port; the shell passes it as a string.
    const port = Number(args?.path ?? 0);
    const jobId = typeof args?.jobId === "string" ? args.jobId : null;

    ctx.openSurface({
      title: port ? `:${port}` : "dev server",
      width: 900,
      height: 600,
      render: (root) => {
        root.innerHTML = "";
        root.className = "wa-root";

        if (!port) return renderPicker(root, ctx);

        const bar = document.createElement("div");
        bar.className = "wa-bar";
        const url = document.createElement("span");
        url.className = "wa-url";
        url.textContent = `localhost:${port}`;
        const reload = document.createElement("button");
        reload.className = "fm-btn";
        reload.textContent = "reload";
        const pop = document.createElement("a");
        pop.className = "fm-btn";
        pop.textContent = "open ↗";
        pop.href = `http://localhost:${port}/`;
        pop.target = "_blank";
        pop.rel = "noopener noreferrer";
        bar.append(url, reload, pop);

        const frame = document.createElement("iframe");
        frame.className = "wa-frame";
        frame.setAttribute("title", `app on port ${port}`);

        const note = document.createElement("div");
        note.className = "wa-note";
        note.textContent = jobId ? `job ${jobId}` : "";

        root.append(bar, frame, note);

        let retry = 0;
        let framePort = 0;

        /**
         * Ask the host for a framing port. The app must be served at the root
         * of its own origin — mounting it under a path breaks every absolute
         * asset URL it emits.
         */
        fetch("/__vs/frame", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ port }),
        })
          .then((r) => {
            if (!(r.headers.get("content-type") ?? "").includes("application/json")) {
              throw new Error("no host bridge — apps can only be framed in dev");
            }
            return r.json();
          })
          .then((info) => {
            framePort = info.framePort;
            note.textContent = `${jobId ? `job ${jobId} · ` : ""}proxied :${framePort}`;
            frame.src = `http://localhost:${framePort}/`;

            // A dev server isn't always listening the instant it prints a URL.
            let tries = 0;
            retry = window.setInterval(() => {
              if (++tries > 5) return window.clearInterval(retry);
              frame.src = `http://localhost:${framePort}/?t=${Date.now()}`;
            }, 1800);
            frame.addEventListener("load", () => window.clearInterval(retry));
          })
          .catch((err) => {
            note.className = "wa-note warn";
            note.textContent = err instanceof Error ? err.message : String(err);
          });

        reload.addEventListener("click", () => {
          if (framePort) frame.src = `http://localhost:${framePort}/?t=${Date.now()}`;
        });

        return () => {
          window.clearInterval(retry);
          root.replaceChildren();
        };
      },
    });
  },
};

/**
 * What to show when nobody said which port.
 *
 * Three honest states, and the difference between them matters: there is no
 * bridge (a deployed build — nothing can run here, and that is by design), the
 * bridge is there and nothing is serving, or these are the servers you have.
 */
function renderPicker(root: HTMLElement, ctx: KernelContext): () => void {
  const head = document.createElement("div");
  head.className = "wa-bar";
  const title = document.createElement("span");
  title.className = "wa-url";
  title.textContent = "running servers";
  const refresh = document.createElement("button");
  refresh.className = "fm-btn";
  refresh.textContent = "refresh";
  head.append(title, refresh);

  const list = document.createElement("div");
  list.className = "wa-jobs";
  root.append(head, list);

  const say = (text: string, warn = false) => {
    list.replaceChildren();
    const msg = document.createElement("div");
    msg.className = `wa-empty${warn ? " warn" : ""}`;
    msg.textContent = text;
    list.appendChild(msg);
  };

  const paint = (jobs: HostJob[]) => {
    const serving = jobs.filter((j) => j.status === "running" && j.port);
    if (!serving.length) {
      say(
        "Nothing is serving yet. Start one in the console — `npm run dev` in a " +
          "project under /projects — and its window opens by itself."
      );
      return;
    }
    list.replaceChildren();
    for (const job of serving) {
      const row = document.createElement("button");
      row.className = "wa-job";
      const port = document.createElement("span");
      port.className = "wa-job-port";
      port.textContent = `:${job.port}`;
      const cmd = document.createElement("span");
      cmd.className = "wa-job-cmd";
      cmd.textContent = job.cmd;
      const where = document.createElement("span");
      where.className = "wa-job-cwd";
      where.textContent = job.cwd;
      row.append(port, cmd, where);
      row.addEventListener("click", () =>
        ctx.launch("webapp", { path: String(job.port), jobId: job.id })
      );
      list.appendChild(row);
    }
  };

  let alive = true;
  const load = () => {
    say("looking for running servers…");
    fetchHostJobs()
      .then((jobs) => alive && paint(jobs))
      .catch((err) => {
        if (!alive) return;
        // The bridge only exists under `npm run dev`, and saying so is more
        // use than a generic failure — nothing the user does in a deployed
        // build will make this work, and it shouldn't.
        say(err instanceof Error ? err.message : String(err), true);
      });
  };

  refresh.addEventListener("click", load);
  load();

  return () => {
    alive = false;
    root.replaceChildren();
  };
}
