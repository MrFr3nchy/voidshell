import type { KernelContext, VoidModule } from "../../kernel/types";
import type { ProjectAppDef } from "../../apps/catalog";

/**
 * Frames a pre-built project as a window.
 *
 * This is the deployable sibling of `webapp`. That module frames a *running*
 * dev server, which means it depends on the host bridge and therefore only
 * exists on a developer's machine. This one frames a *built artifact* sitting
 * at `/apps/<id>/`, so it works identically in dev and on a static deploy —
 * there is no process to spawn and nothing to proxy.
 *
 * One module is manufactured per catalogue entry, so each project shows up in
 * the radial launcher, the drawer and the command palette as a first-class app
 * rather than as a row inside some "projects" browser.
 */

/**
 * Vite rewrites `import.meta.env` at build time; the smoke harness bundles this
 * file with plain esbuild, where it stays undefined. Reading through an
 * optional chain keeps both paths alive.
 */
function baseUrl(): string {
  const env = (import.meta as { env?: { BASE_URL?: string } }).env;
  return env?.BASE_URL ?? "/";
}

export function appUrl(id: string): string {
  return `${baseUrl()}apps/${id}/`;
}

/**
 * Probe for a built artifact.
 *
 * Deferred through a resolved promise on purpose: outside a browser there is no
 * document base, and Node's fetch rejects — in some versions *throws* — on a
 * relative URL. Letting that escape synchronously would take down whatever is
 * rendering the panel, which in the smoke harness is the whole test run.
 */
function artifactExists(url: string): Promise<boolean> {
  return Promise.resolve()
    .then(() => fetch(url, { method: "HEAD" }))
    .then((res) => res.ok)
    .catch(() => false);
}

export function createProjectApp(def: ProjectAppDef): VoidModule {
  return {
    manifest: {
      id: def.id,
      name: def.name,
      kind: "app",
      glyph: def.glyph,
      blurb: def.blurb,
      version: "0.1.0",
    },

    activate() {},

    launch(ctx: KernelContext) {
      const url = appUrl(def.id);

      ctx.openSurface({
        title: def.name,
        width: def.width,
        height: def.height,
        render: (root) => {
          root.replaceChildren();
          root.className = "pa-root";

          const bar = document.createElement("div");
          bar.className = "pa-bar";
          const label = document.createElement("span");
          label.className = "pa-url";
          label.textContent = `/apps/${def.id}/`;
          const reload = document.createElement("button");
          reload.className = "fm-btn";
          reload.textContent = "reload";
          const pop = document.createElement("a");
          pop.className = "fm-btn";
          pop.textContent = "open \u2197";
          pop.href = url;
          pop.target = "_blank";
          pop.rel = "noopener noreferrer";
          bar.append(label, reload, pop);

          const frame = document.createElement("iframe");
          frame.className = "pa-frame";
          frame.setAttribute("title", def.name);
          // Deliberately not sandboxed: the artifact is same-origin and built
          // from source we control. A sandbox attribute here would also strip
          // the worker and SharedArrayBuffer access a Godot export needs.
          frame.setAttribute("allow", "autoplay; fullscreen; gamepad");

          const note = document.createElement("div");
          note.className = "pa-note";

          root.append(bar, frame, note);

          // A Godot web export blocks on SharedArrayBuffer, which the browser
          // only hands out to a cross-origin-isolated document. When a deploy
          // forgets the COOP/COEP headers the engine dies with a stack trace
          // nobody can read, so say it plainly up front.
          if (
            def.builder === "godot" &&
            typeof crossOriginIsolated !== "undefined" &&
            !crossOriginIsolated
          ) {
            note.className = "pa-note warn";
            note.textContent =
              "not cross-origin isolated \u2014 the COOP/COEP headers are missing, " +
              "so this export cannot start. See DEPLOY.md.";
          }

          let alive = true;

          // Probe before framing. An artifact that was never built would
          // otherwise resolve to the shell's own index inside the panel, which
          // reads as a recursion bug rather than a missing build.
          void artifactExists(url).then((ok) => {
            if (!alive) return;
            if (ok) {
              frame.src = url;
              return;
            }
            frame.remove();
            const empty = document.createElement("div");
            empty.className = "pa-empty";
            empty.textContent =
              `${def.name} has not been built into this deploy. Run the ` +
              `"build project apps" workflow in the voidshell repo, or build ` +
              `it locally into public/apps/${def.id}/.`;
            root.insertBefore(empty, note);
          });

          reload.addEventListener("click", () => {
            if (frame.isConnected) frame.src = `${url}?t=${Date.now()}`;
          });

          return () => {
            alive = false;
            root.replaceChildren();
          };
        },
      });
    },
  };
}
