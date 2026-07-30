import type { KernelContext, LaunchArgs, VoidModule } from "../../kernel/types";

/**
 * Hosts a running dev server as a window.
 *
 * The iframe points at the host bridge's proxy rather than straight at
 * `localhost:<port>`: same-origin means the frame isn't blocked by our
 * cross-origin isolation, and the proxy stamps on the headers the nested
 * document needs to be embeddable at all.
 */
export const webapp: VoidModule = {
  manifest: {
    id: "webapp",
    name: "Web App",
    kind: "app",
    glyph: "◱",
    version: "0.1.0",
  },

  activate() {},

  launch(ctx: KernelContext, args?: LaunchArgs) {
    // `path` carries the port; the shell passes it as a string.
    const port = Number(args?.path ?? 0);
    const jobId = typeof args?.jobId === "string" ? args.jobId : null;

    ctx.openSurface({
      title: port ? `:${port}` : "web app",
      width: 900,
      height: 600,
      render: (root) => {
        root.innerHTML = "";
        root.className = "wa-root";

        if (!port) {
          const msg = document.createElement("div");
          msg.className = "wa-empty";
          msg.textContent =
            "No port. Start a dev server in the console (e.g. `npm run dev`) and " +
            "this opens automatically, or use `open webapp` after one is running.";
          root.appendChild(msg);
          return () => root.replaceChildren();
        }

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
