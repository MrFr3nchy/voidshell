import type { KernelContext, VoidModule } from "../../kernel/types";
import { loadModuleSource } from "../../runtime/loadModule";
import { EXAMPLE_SOURCE } from "./example";

/**
 * Loading a module is a privileged act, so the capability is handed in rather
 * than reached for.
 *
 * This deliberately does not go on `KernelContext`. Every module gets that
 * surface, and "can install other modules" is not something every module
 * should get — the same reasoning that has `createPower` receive `closeAll`
 * from the shell instead of finding it on the context. The Kernel satisfies
 * this shape structurally; main.ts is the only place that hands it over.
 */
export interface ModuleHost {
  /** Register and activate a module the shell was not built with. */
  install(mod: VoidModule): string;
  /** Remove a runtime-installed module and everything it published. */
  uninstall(id: string): boolean;
  /** Ids of every module installed at runtime, in install order. */
  runtimeModules(): string[];
}

/** Where hand-written modules live. */
const DIR = "/home/void/modules";
/** Paths that were loaded, so the next boot can bring them back. */
const LOADED_KEY = "devkit.loaded";
const AUTOLOAD_KEY = "devkit.autoload";
/** Raised whenever the installed set changes, so open windows redraw. */
const CHANGED = "devkit.changed";

const isModuleFile = (name: string) => name.endsWith(".js") || name.endsWith(".mjs");

export function createDevkit(host: ModuleHost): VoidModule {
  /** path -> module id, for everything this devkit put in. */
  const installed = new Map<string, string>();

  const remember = (ctx: KernelContext) =>
    ctx.state.set(LOADED_KEY, [...installed.keys()]);

  /**
   * Read a file and install whatever module it exports.
   *
   * Re-loading a path that is already in is an *update*, not a collision: the
   * old module is torn down first. Without that, the second Reload would fail
   * on a duplicate id and hot reload would be a one-shot trick.
   */
  async function loadPath(ctx: KernelContext, path: string): Promise<string> {
    const source = ctx.fs.read(path);
    const mod = await loadModuleSource(source);
    const id = mod.manifest.id;

    const previous = installed.get(path);
    if (previous && previous !== id) host.uninstall(previous);
    if (host.runtimeModules().includes(id)) host.uninstall(id);

    host.install(mod);
    installed.set(path, id);
    remember(ctx);
    ctx.emit(CHANGED, { path, id });
    return id;
  }

  function unloadPath(ctx: KernelContext, path: string): void {
    const id = installed.get(path);
    if (!id) return;
    host.uninstall(id);
    installed.delete(path);
    remember(ctx);
    ctx.emit(CHANGED, { path, id: null });
  }

  return {
    manifest: {
      id: "devkit",
      name: "devkit",
      kind: "app",
      glyph: "⌬",
      blurb: "write a module and load it without rebuilding",
    },

    activate(ctx) {
      // First run only: leave something to actually load, so the app opens
      // demonstrating itself rather than showing an empty directory.
      if (!ctx.fs.exists(DIR)) {
        ctx.fs.mkdirp(DIR);
        ctx.fs.write(`${DIR}/hello.js`, EXAMPLE_SOURCE);
      }

      ctx.defineSetting({
        key: AUTOLOAD_KEY,
        label: "Load my modules at startup",
        kind: "toggle",
        group: "System",
        hint: "Re-install everything devkit was holding when the session ended",
        default: true,
        order: 60,
      });

      ctx.defineCommand({
        id: "devkit.open",
        label: "devkit: manage modules",
        glyph: "⌬",
        run: (c) => c.launch("devkit"),
      });

      // Bring back what was loaded last time. Fired rather than awaited —
      // activate() is synchronous, and a module that fails to come back must
      // not be able to hold up the boot of everything after it.
      if (ctx.state.get<boolean>(AUTOLOAD_KEY, true)) {
        const paths = ctx.state.get<string[]>(LOADED_KEY, []);
        for (const path of paths) {
          if (!ctx.fs.exists(path)) {
            ctx.log(`devkit: ${path} is gone, not reloading`, "warn");
            continue;
          }
          void loadPath(ctx, path).catch((err) => {
            // Deliberately not a notification storm at startup: one journal
            // line each, and the app itself shows the error when it opens.
            ctx.log(`devkit: ${path} failed to load: ${err}`, "error");
          });
        }
      }

      return () => {
        for (const id of [...installed.values()]) host.uninstall(id);
        installed.clear();
      };
    },

    launch(ctx) {
      ctx.openSurface({
        title: "devkit",
        width: 460,
        height: 380,
        render: (root, c) => {
          root.classList.add("dk-root");

          const head = document.createElement("div");
          head.className = "dk-head";
          const blurb = document.createElement("div");
          blurb.className = "dk-blurb";
          blurb.textContent = `modules in ${DIR}`;
          head.append(blurb);

          const list = document.createElement("div");
          list.className = "dk-list";

          const note = document.createElement("div");
          note.className = "dk-note";
          note.hidden = true;

          const say = (text: string, bad = false) => {
            note.textContent = text;
            note.classList.toggle("is-bad", bad);
            note.hidden = false;
          };

          /** One row per file on disk, whether or not it is loaded. */
          const draw = () => {
            list.replaceChildren();

            let files: string[] = [];
            try {
              files = c.fs
                .ls(DIR)
                .filter((e) => e.kind === "file" && isModuleFile(e.name))
                .map((e) => e.path);
            } catch {
              /* directory removed out from under us */
            }

            // Anything loaded from outside the directory still deserves a row,
            // or it becomes impossible to unload from the UI.
            for (const path of installed.keys()) {
              if (!files.includes(path)) files.push(path);
            }

            if (!files.length) {
              const empty = document.createElement("div");
              empty.className = "dk-empty";
              empty.textContent = `nothing in ${DIR} yet — write a .js file there`;
              list.append(empty);
              return;
            }

            for (const path of files.sort()) {
              const id = installed.get(path);
              const row = document.createElement("div");
              row.className = "dk-row";
              if (id) row.classList.add("is-live");

              const name = document.createElement("div");
              name.className = "dk-name";
              name.textContent = path.slice(path.lastIndexOf("/") + 1);

              const state = document.createElement("div");
              state.className = "dk-state";
              state.textContent = id ? id : "not loaded";

              const actions = document.createElement("div");
              actions.className = "dk-actions";

              const button = (label: string, run: () => void) => {
                const b = document.createElement("button");
                b.className = "dk-btn";
                b.type = "button";
                b.textContent = label;
                b.addEventListener("click", run);
                return b;
              };

              const load = () => {
                loadPath(c, path)
                  .then((loaded) => {
                    say(`${loaded} loaded`);
                    c.notify(`${loaded} loaded`, "good");
                  })
                  .catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    say(message, true);
                    c.log(`devkit: ${path}: ${message}`, "error");
                  });
              };

              actions.append(button(id ? "reload" : "load", load));
              if (id) {
                actions.append(
                  button("unload", () => {
                    unloadPath(c, path);
                    say(`${id} unloaded`);
                  })
                );
                actions.append(button("open", () => c.launch(id)));
              }
              actions.append(button("edit", () => c.openPath(path)));

              row.append(name, state, actions);
              list.append(row);
            }
          };

          draw();
          root.append(head, list, note);

          // Redraw when the directory changes on disk, and when anything is
          // installed or removed — including by another devkit window.
          const offFs = c.fs.onChange(draw);
          const offChanged = c.on(CHANGED, draw);
          return () => {
            offFs();
            offChanged();
          };
        },
      });
    },
  };
}
