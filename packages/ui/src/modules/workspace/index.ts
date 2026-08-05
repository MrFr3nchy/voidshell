import type { KernelContext, LaunchArgs, VoidModule } from "../../kernel/types";
import { dirname } from "../../kernel/vfs";
import { HOME, ancestry, dirOf, tildify } from "../../kernel/fsutil";
import { createBrowser } from "./browser";
import { createConsole } from "./console";
import { createPlaces } from "./places";

/**
 * Files and the console, in one window, over one working directory.
 *
 * They were two apps and it never made sense: every `cd` had to be mirrored by
 * hand in the file manager, and every click in the file manager left the shell
 * somewhere else. Here the cwd is a single value every pane reads and writes —
 * click into a folder and the prompt follows; `cd` and the list follows; click
 * a place in the sidebar and both go there.
 *
 * The divider is draggable so the window can be mostly-shell or mostly-files
 * depending on what you're doing.
 */

const SPLIT_KEY = "workspace.split";
const SIDEBAR_KEY = "workspace.sidebar";

export const workspace: VoidModule = {
  manifest: {
    id: "workspace",
    name: "Files",
    kind: "app",
    glyph: "▤",
    blurb: "files and shell, one directory",
    version: "0.2.0",
  },

  // Directories route here from `openPath`. The priority is what makes that
  // true regardless of the order modules happen to be registered in.
  handles: ["dir"],
  priority: 10,

  activate() {},

  launch(ctx: KernelContext, args?: LaunchArgs) {
    // Open where we were told to, falling back to home. A file argument opens
    // its containing directory — that's what "show me this" means here.
    const start = args?.path && ctx.fs.exists(args.path) ? dirOf(ctx, args.path) : HOME;

    // Assigned after openSurface returns; every read is inside a handler.
    let sid = "";

    const surface = ctx.openSurface({
      title: "files",
      width: 960,
      height: 560,
      render: (root) => {
        root.innerHTML = "";
        root.className = "ws-root";

        let cwd = start;

        /* ---------------- path bar ---------------- */

        const bar = document.createElement("div");
        bar.className = "fm-bar";

        const sideBtn = document.createElement("button");
        sideBtn.className = "fm-btn";
        sideBtn.textContent = "☰";
        sideBtn.title = "Show or hide the sidebar";

        const up = document.createElement("button");
        up.className = "fm-btn";
        up.textContent = "↑";
        up.title = "Parent directory";

        const crumbs = document.createElement("div");
        crumbs.className = "fm-crumbs";

        const newBtn = document.createElement("button");
        newBtn.className = "fm-btn";
        newBtn.textContent = "+ new";
        newBtn.title = "New folder or file";

        bar.append(sideBtn, up, crumbs, newBtn);

        /* ---------------- panes ---------------- */

        const body = document.createElement("div");
        body.className = "ws-body";

        // Each pane tells the workspace where it went; the workspace tells the
        // *others*. No pane calls another, so there's no loop.
        const places = createPlaces(ctx, { onGo: (p) => goTo(p) });

        const browser = createBrowser(ctx, {
          cwd,
          onCwd: (p) => {
            sync(p);
            console_.setCwd(p);
          },
        });

        const console_ = createConsole(ctx, {
          cwd,
          onCwd: (p) => {
            sync(p);
            browser.setCwd(p);
          },
        });

        const divider = document.createElement("div");
        divider.className = "ws-divider";
        divider.title = "drag to resize";

        body.append(places.el, browser.el, divider, console_.el);
        root.append(bar, body);

        /* ---------------- shared navigation ---------------- */

        /**
         * Where the breadcrumb stops walking up.
         *
         * A path bar that renders `/ home void notes` for `~/notes` spends four
         * segments telling you about a directory tree you never leave. Home is
         * the root of everywhere you work, so it is drawn as one crumb.
         */
        const crumbsFor = (p: string) => {
          if (p === HOME || p.startsWith(`${HOME}/`)) {
            const rest = p.slice(HOME.length).split("/").filter(Boolean);
            const out = [{ name: "~", path: HOME }];
            let cur = HOME;
            for (const seg of rest) {
              cur += `/${seg}`;
              out.push({ name: seg, path: cur });
            }
            return out;
          }
          return ancestry(p);
        };

        const paintCrumbs = () => {
          crumbs.replaceChildren();
          const parts = crumbsFor(cwd);
          parts.forEach((part, i) => {
            if (i) {
              const sep = document.createElement("span");
              sep.className = "fm-crumb-sep";
              sep.textContent = "/";
              crumbs.appendChild(sep);
            }
            const b = document.createElement("button");
            b.className = `fm-crumb${i === parts.length - 1 ? " on" : ""}`;
            b.textContent = part.name;
            b.title = part.path;
            b.addEventListener("click", () => goTo(part.path));
            // Dropping onto an ancestor moves things up the tree, which is
            // otherwise a two-step navigation.
            b.addEventListener("dragover", (e) => {
              if (!e.dataTransfer?.types.includes("text/voidshell-path")) return;
              e.preventDefault();
              b.classList.add("drop-target");
            });
            b.addEventListener("dragleave", () => b.classList.remove("drop-target"));
            b.addEventListener("drop", (e) => {
              b.classList.remove("drop-target");
              const src = e.dataTransfer?.getData("text/voidshell-path");
              if (!src) return;
              e.preventDefault();
              try {
                ctx.fs.mv(src, `${part.path}/${src.slice(src.lastIndexOf("/") + 1)}`);
              } catch (err) {
                ctx.notify(err instanceof Error ? err.message : String(err), "warn");
              }
            });
            crumbs.appendChild(b);
          });
        };

        /** A pane moved; bring everything else along. */
        const sync = (p: string) => {
          cwd = p;
          paintCrumbs();
          places.setCwd(p);
          // The window says where it is. Browsing and typing share a working
          // directory, so the one title can honestly describe every pane.
          ctx.setTitle(sid, tildify(p));
        };

        const goTo = (p: string) => {
          if (!ctx.fs.exists(p) || !ctx.fs.isDir(p)) {
            ctx.notify(`no such directory: ${p}`, "warn");
            return;
          }
          sync(p);
          browser.setCwd(p);
          console_.setCwd(p);
        };

        sync(cwd);
        up.addEventListener("click", () => cwd !== "/" && goTo(dirname(cwd)));
        newBtn.addEventListener("click", (e) => {
          const r = newBtn.getBoundingClientRect();
          browser.newMenu(e.clientX || r.left, r.bottom + 4);
        });

        /* ---------------- sidebar visibility ---------------- */

        const applySidebar = (on: boolean) => {
          places.el.classList.toggle("hidden", !on);
          sideBtn.classList.toggle("on", on);
        };
        applySidebar(ctx.state.get<boolean>(SIDEBAR_KEY, true));
        sideBtn.addEventListener("click", () => {
          const next = !ctx.state.get<boolean>(SIDEBAR_KEY, true);
          ctx.state.set(SIDEBAR_KEY, next);
          applySidebar(next);
        });

        /* ---------------- draggable divider ---------------- */

        // Stored as a fraction rather than pixels so it survives the panel being
        // resized, which it will be — the panel is resizable on both axes now.
        const applySplit = (frac: number) => {
          browser.el.style.flex = `0 0 ${(frac * 100).toFixed(2)}%`;
        };
        applySplit(ctx.state.get<number>(SPLIT_KEY, 0.42));

        divider.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          divider.setPointerCapture(e.pointerId);
          divider.classList.add("dragging");

          const move = (ev: PointerEvent) => {
            const rect = body.getBoundingClientRect();
            if (rect.width <= 0) return;
            const left = browser.el.getBoundingClientRect().left;
            const frac = Math.min(0.8, Math.max(0.15, (ev.clientX - left) / rect.width));
            applySplit(frac);
            ctx.state.set(SPLIT_KEY, frac);
          };
          const done = (ev: PointerEvent) => {
            divider.releasePointerCapture(ev.pointerId);
            divider.classList.remove("dragging");
            divider.removeEventListener("pointermove", move);
            divider.removeEventListener("pointerup", done);
            divider.removeEventListener("pointercancel", done);
          };
          divider.addEventListener("pointermove", move);
          divider.addEventListener("pointerup", done);
          divider.addEventListener("pointercancel", done);
        });

        requestAnimationFrame(() => console_.focus());

        return () => {
          places.dispose();
          browser.dispose();
          console_.dispose();
          root.replaceChildren();
        };
      },
    });

    sid = surface.id;
    // The initial directory is set before the surface exists, so name it now.
    ctx.setTitle(sid, tildify(start));
  },
};
