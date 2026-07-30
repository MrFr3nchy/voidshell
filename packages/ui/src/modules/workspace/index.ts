import type { KernelContext, LaunchArgs, VoidModule } from "../../kernel/types";
import { dirname } from "../../kernel/vfs";
import { createBrowser } from "./browser";
import { createConsole } from "./console";

/**
 * Files and the console, in one window, over one working directory.
 *
 * They were two apps and it never made sense: every `cd` had to be mirrored by
 * hand in the file manager, and every click in the file manager left the shell
 * somewhere else. Here the cwd is a single value both panes read and write —
 * click into a folder and the prompt follows; `cd` and the list follows.
 *
 * The divider is draggable so the window can be mostly-shell or mostly-files
 * depending on what you're doing.
 */

const HOME = "/home/void";
const SPLIT_KEY = "workspace.split";

export const workspace: VoidModule = {
  manifest: {
    id: "workspace",
    name: "Workspace",
    kind: "app",
    glyph: "▤",
    blurb: "files and shell, one directory",
    version: "0.1.0",
  },

  // Directories route here from `openPath`.
  handles: ["dir"],

  activate() {},

  launch(ctx: KernelContext, args?: LaunchArgs) {
    // Open where we were told to, falling back to home. A file argument opens
    // its containing directory — that's what "show me this" means here.
    const start =
      args?.path && ctx.fs.exists(args.path)
        ? ctx.fs.isDir(args.path)
          ? args.path
          : dirname(args.path)
        : HOME;

    ctx.openSurface({
      title: "workspace",
      width: 900,
      height: 520,
      render: (root) => {
        root.innerHTML = "";
        root.className = "ws-root";

        let cwd = start;

        /* ---------------- path bar ---------------- */

        const bar = document.createElement("div");
        bar.className = "fm-bar";
        const up = document.createElement("button");
        up.className = "fm-btn";
        up.textContent = "↑";
        up.title = "Parent directory";
        const homeBtn = document.createElement("button");
        homeBtn.className = "fm-btn";
        homeBtn.textContent = "~";
        homeBtn.title = "Home";
        const pathEl = document.createElement("span");
        pathEl.className = "fm-path";
        const newDirBtn = document.createElement("button");
        newDirBtn.className = "fm-btn";
        newDirBtn.textContent = "+ folder";
        const newFileBtn = document.createElement("button");
        newFileBtn.className = "fm-btn";
        newFileBtn.textContent = "+ file";
        bar.append(up, homeBtn, pathEl, newDirBtn, newFileBtn);

        /* ---------------- panes ---------------- */

        const body = document.createElement("div");
        body.className = "ws-body";

        // Each pane tells the workspace where it went; the workspace tells the
        // *other* pane. Neither pane calls the other, so there's no loop.
        const browser = createBrowser(ctx, {
          cwd,
          onCwd: (p) => {
            cwd = p;
            pathEl.textContent = p;
            console_.setCwd(p);
          },
        });

        const console_ = createConsole(ctx, {
          cwd,
          onCwd: (p) => {
            cwd = p;
            pathEl.textContent = p;
            browser.setCwd(p);
          },
        });

        const divider = document.createElement("div");
        divider.className = "ws-divider";
        divider.title = "drag to resize";

        body.append(browser.el, divider, console_.el);
        root.append(bar, body);

        /* ---------------- shared navigation ---------------- */

        const goTo = (p: string) => {
          if (!ctx.fs.exists(p) || !ctx.fs.isDir(p)) return;
          cwd = p;
          pathEl.textContent = p;
          browser.setCwd(p);
          console_.setCwd(p);
        };

        pathEl.textContent = cwd;
        up.addEventListener("click", () => cwd !== "/" && goTo(dirname(cwd)));
        homeBtn.addEventListener("click", () => goTo(HOME));
        newDirBtn.addEventListener("click", (e) => browser.newFolder(e.clientX, e.clientY));
        newFileBtn.addEventListener("click", (e) => browser.newFile(e.clientX, e.clientY));

        /* ---------------- draggable divider ---------------- */

        // Stored as a fraction rather than pixels so it survives the panel being
        // resized, which it will be — the panel is resizable on both axes now.
        const applySplit = (frac: number) => {
          browser.el.style.flex = `0 0 ${(frac * 100).toFixed(2)}%`;
        };
        applySplit(ctx.state.get<number>(SPLIT_KEY, 0.34));

        divider.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          divider.setPointerCapture(e.pointerId);
          divider.classList.add("dragging");

          const move = (ev: PointerEvent) => {
            const rect = body.getBoundingClientRect();
            if (rect.width <= 0) return;
            const frac = Math.min(0.75, Math.max(0.15, (ev.clientX - rect.left) / rect.width));
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
          browser.dispose();
          console_.dispose();
          root.replaceChildren();
        };
      },
    });
  },
};
