import type { AnchorHandle, FsEntry, KernelContext, VoidModule, Vec3 } from "../../kernel/types";
import { basename, dirname, normalize } from "../../kernel/vfs";
import { moveToTrash } from "../../kernel/trash";
import { closeContextMenu, promptInline, showContextMenu } from "../../ui/contextMenu";
import { clipboard } from "../../ui/clipboard";

/**
 * The desktop.
 *
 * The whole design rests on one idea: **the desktop is a directory**. Icons are
 * `ls /home/void/Desktop` rendered into the void, so "drag a file to the
 * desktop" is an ordinary filesystem move and needs no special-casing. Delete
 * a file in the shell and its icon disappears, because the shell and the
 * desktop are looking at the same tree.
 *
 * Icons are anchored in 3D like windows rather than pinned to the screen, which
 * keeps one coherent world instead of a flat HUD layer pasted over a 3D scene.
 */

const DESKTOP_DIR = "/home/void/Desktop";
/** Icon positions, kept beside the directory the way a real OS does. */
const LAYOUT_FILE = "/home/void/.desktop-layout.json";

type Layout = Record<string, Vec3>;

const GLYPHS: Record<string, string> = {
  dir: "▸",
  md: "✎", txt: "✎", json: "{}", ts: "TS", tsx: "TS", js: "JS", jsx: "JS",
  css: "#", html: "<>", py: "PY", rs: "RS", sh: "$", toml: "⚙", yml: "⚙", yaml: "⚙",
};

function glyphFor(entry: FsEntry): string {
  if (entry.kind === "dir") return GLYPHS.dir;
  const ext = entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase();
  return GLYPHS[ext] ?? "·";
}

export const desktop: VoidModule = {
  manifest: {
    id: "desktop",
    name: "Desktop",
    // A service, not an app: it has no launcher entry and no window. It simply
    // exists from boot, like a real desktop shell.
    kind: "service",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.fs.mkdirp(DESKTOP_DIR);

    const icons = new Map<string, { el: HTMLElement; handle: AnchorHandle }>();
    let layout: Layout = {};

    const loadLayout = (): void => {
      try {
        layout = JSON.parse(ctx.fs.read(LAYOUT_FILE));
      } catch {
        layout = {};
      }
    };
    const saveLayout = (): void => {
      try {
        ctx.fs.write(LAYOUT_FILE, JSON.stringify(layout));
      } catch (err) {
        console.warn("[desktop] could not save layout:", err);
      }
    };
    loadLayout();

    /**
     * Positions for icons that have never been placed: a grid laid out in the
     * plane the camera faced at boot, so a fresh desktop reads as a tidy column
     * rather than a random scatter.
     */
    const autoPlace = (index: number): Vec3 => {
      const perCol = 5;
      const col = Math.floor(index / perCol);
      const row = index % perCol;
      return { x: -520 + col * 150, y: 250 - row * 115, z: -640 };
    };

    // ---------- actions ----------

    const uniqueName = (dir: string, base: string): string => {
      if (!ctx.fs.exists(`${dir}/${base}`)) return base;
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      for (let i = 2; i < 500; i++) {
        const candidate = `${stem} ${i}${ext}`;
        if (!ctx.fs.exists(`${dir}/${candidate}`)) return candidate;
      }
      return `${stem}-${Date.now()}${ext}`;
    };

    /**
     * Filesystem errors here are user-facing (EROFS, EEXIST, ENOTEMPTY) and
     * must not disappear into a console nobody is reading. The shell owns the
     * toast layer, so this goes through the kernel rather than hand-rolling a
     * second, differently-styled notification.
     */
    const notify = (msg: string): void => {
      ctx.emit("desktop.notice", { message: msg });
      ctx.notify(msg, "warn");
    };

    const guard = (fn: () => void) => {
      try {
        fn();
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err));
        console.warn("[desktop]", err);
      }
    };

    const newFolder = (x: number, y: number) =>
      promptInline(x, y, "New Folder", "folder name", (name) =>
        guard(() => {
          const target = `${DESKTOP_DIR}/${uniqueName(DESKTOP_DIR, name)}`;
          ctx.fs.mkdir(target);
          placeAt(target, x, y);
        })
      );

    const newFile = (x: number, y: number) =>
      promptInline(x, y, "untitled.md", "file name", (name) =>
        guard(() => {
          const target = `${DESKTOP_DIR}/${uniqueName(DESKTOP_DIR, name)}`;
          ctx.fs.write(target, "");
          placeAt(target, x, y);
        })
      );

    /**
     * Pin a path's icon to the world point under a screen coordinate. Renders
     * first so the icon exists, then moves it: creating the file already fired
     * a render that auto-placed it on the grid, and that has to be overridden
     * or a new item lands somewhere other than where you asked for it.
     */
    const placeAt = (path: string, screenX: number, screenY: number): void => {
      render();
      layout[path] = ctx.screenToWorld(screenX, screenY, 640);
      icons.get(path)?.handle.setAnchor(layout[path]);
      saveLayout();
    };

    const rename = (entry: FsEntry, x: number, y: number) =>
      promptInline(x, y, entry.name, "new name", (name) =>
        guard(() => {
          const dest = `${dirname(entry.path)}/${name}`;
          ctx.fs.mv(entry.path, dest);
          if (layout[entry.path]) {
            layout[dest] = layout[entry.path];
            delete layout[entry.path];
            saveLayout();
          }
        })
      );

    // Delete on the desktop is recoverable, like delete everywhere else. The
    // icon's saved position is dropped either way: if it comes back it should
    // land wherever the tidy pass puts it, not on top of whatever took its spot.
    const remove = (entry: FsEntry) =>
      guard(() => {
        const name = moveToTrash(ctx, entry.path);
        delete layout[entry.path];
        saveLayout();
        ctx.notify(`${entry.name} → trash · restore ${name}`);
      });

    const paste = (x: number, y: number) =>
      guard(() => {
        const item = clipboard.get();
        if (!item) return;
        const dest = `${DESKTOP_DIR}/${uniqueName(DESKTOP_DIR, basename(item.path))}`;
        if (item.mode === "cut") {
          ctx.fs.mv(item.path, dest);
          clipboard.clear();
        } else {
          copyRecursive(ctx, item.path, dest);
        }
        placeAt(dest, x, y);
      });

    // ---------- icon rendering ----------

    const makeIcon = (entry: FsEntry): HTMLElement => {
      const el = document.createElement("div");
      el.className = "vs-icon";
      el.tabIndex = 0;
      el.dataset.path = entry.path;

      const glyph = document.createElement("div");
      glyph.className = `vs-icon-glyph ${entry.kind}`;
      glyph.textContent = glyphFor(entry);

      const label = document.createElement("div");
      label.className = "vs-icon-label";
      label.textContent = entry.name;

      el.append(glyph, label);

      // Double-click opens; single click just selects.
      el.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        ctx.openPath(entry.path);
      });
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        for (const i of icons.values()) i.el.classList.remove("sel");
        el.classList.add("sel");
      });

      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const runnable = /\.(py|js|mjs|cjs)$/i.test(entry.name);
        showContextMenu(e.clientX, e.clientY, [
          { label: "Open", action: () => ctx.openPath(entry.path) },
          ...(runnable
            ? [
                {
                  label: "Run",
                  action: () => ctx.launch("editor", { path: entry.path, run: true }),
                },
              ]
            : []),
          ...(entry.kind === "file"
            ? [{ label: "Edit", action: () => ctx.launch("editor", { path: entry.path }) }]
            : []),
          {
            label: "Open in Workspace",
            action: () =>
              ctx.launch("workspace", {
                path: entry.kind === "dir" ? entry.path : dirname(entry.path),
              }),
          },
          { label: "Rename…", separated: true, action: () => rename(entry, e.clientX, e.clientY) },
          { label: "Copy", action: () => clipboard.set(entry.path, "copy") },
          { label: "Cut", action: () => clipboard.set(entry.path, "cut") },
          { label: "Delete", separated: true, danger: true, action: () => remove(entry) },
        ]);
      });

      bindIconDrag(el, entry.path);
      return el;
    };

    /** Drag an icon to reposition it in the void; its anchor is persisted. */
    const bindIconDrag = (el: HTMLElement, path: string): void => {
      let dragging = false;
      let moved = false;
      let dist = 640;

      el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        dragging = true;
        moved = false;
        const a = layout[path];
        if (a) {
          const f = ctx.focalPoint(0);
          dist = Math.hypot(a.x - f.x, a.y - f.y, a.z - f.z) || 640;
        }
        el.setPointerCapture(e.pointerId);
        el.classList.add("dragging");
      });

      el.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        moved = true;
        layout[path] = ctx.screenToWorld(e.clientX, e.clientY, dist);
        icons.get(path)?.handle.setAnchor(layout[path]);
      });

      const end = (e: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        el.releasePointerCapture(e.pointerId);
        el.classList.remove("dragging");
        if (moved) saveLayout();
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    };

    // ---------- reconciliation ----------

    /**
     * Reconcile icons against the directory.
     *
     * Guarded against reentrancy: this runs on every fs change, and it *writes*
     * the layout file for newly-placed icons — which is itself an fs change.
     * Without the latch the nested call creates each icon a second time and the
     * desktop fills with duplicates.
     */
    let rendering = false;
    const render = (): void => {
      if (rendering) return;
      rendering = true;
      try {
        let entries: FsEntry[] = [];
        try {
          entries = ctx.fs.ls(DESKTOP_DIR).filter((e) => !e.name.startsWith("."));
        } catch {
          entries = [];
        }
        const live = new Set(entries.map((e) => e.path));
        let layoutDirty = false;

        // Drop icons for paths that no longer exist.
        for (const [path, icon] of icons) {
          if (!live.has(path)) {
            icon.handle.dispose();
            icons.delete(path);
            if (layout[path]) {
              delete layout[path];
              layoutDirty = true;
            }
          }
        }

        entries.forEach((entry, i) => {
          const existing = icons.get(entry.path);
          if (existing) {
            // Keep the label fresh without rebuilding (and losing) the element.
            const label = existing.el.querySelector(".vs-icon-label");
            if (label && label.textContent !== entry.name) label.textContent = entry.name;
            return;
          }
          if (!layout[entry.path]) {
            layout[entry.path] = autoPlace(i);
            layoutDirty = true;
          }
          const el = makeIcon(entry);
          const handle = ctx.mountAnchored(el, layout[entry.path]);
          icons.set(entry.path, { el, handle });
        });

        // One write after the loop, never inside it.
        if (layoutDirty) saveLayout();
      } finally {
        rendering = false;
      }
    };

    // ---------- desktop background menu ----------

    const onVoidContextMenu = (e: MouseEvent) => {
      // Only when the click really landed on empty void, not on a window.
      const target = e.target as HTMLElement;
      if (target.closest(".vs-panel") || target.closest(".vs-icon") || target.closest("#hud")) {
        return;
      }
      e.preventDefault();
      const item = clipboard.get();
      showContextMenu(e.clientX, e.clientY, [
        { label: "New Folder", action: () => newFolder(e.clientX, e.clientY) },
        { label: "New File", action: () => newFile(e.clientX, e.clientY) },
        {
          label: item ? `Paste "${basename(item.path)}"` : "Paste",
          action: item ? () => paste(e.clientX, e.clientY) : undefined,
        },
        {
          label: "Open Workspace Here",
          separated: true,
          action: () => ctx.launch("workspace", { path: DESKTOP_DIR }),
        },
        {
          label: "Tidy Icons",
          separated: true,
          action: () => {
            ctx.fs.ls(DESKTOP_DIR).forEach((entry, i) => {
              layout[entry.path] = autoPlace(i);
              icons.get(entry.path)?.handle.setAnchor(layout[entry.path]);
            });
            saveLayout();
          },
        },
      ]);
    };

    window.addEventListener("contextmenu", onVoidContextMenu);

    // ---------- drops from the file manager ----------

    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("text/voidshell-path")) return;
      const target = e.target as HTMLElement;
      if (target.closest(".vs-panel")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      document.body.classList.add("vs-dropping");
    };

    const onDragLeave = () => document.body.classList.remove("vs-dropping");

    const onDrop = (e: DragEvent) => {
      document.body.classList.remove("vs-dropping");
      const src = e.dataTransfer?.getData("text/voidshell-path");
      if (!src) return;
      const target = e.target as HTMLElement;
      if (target.closest(".vs-panel")) return;
      e.preventDefault();

      guard(() => {
        const dest = `${DESKTOP_DIR}/${uniqueName(DESKTOP_DIR, basename(src))}`;
        // Read-only sources (anything under /projects) are copied, not moved —
        // the alternative is an EROFS failure the user can't act on.
        if (ctx.fs.stat(src).readonly) copyRecursive(ctx, src, dest);
        else ctx.fs.mv(src, dest);
        placeAt(dest, e.clientX, e.clientY);
      });
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);

    // Keyboard: Delete removes the selected icon, Escape clears selection.
    const onKey = (e: KeyboardEvent) => {
      const sel = document.querySelector(".vs-icon.sel") as HTMLElement | null;
      if (!sel || (e.target as HTMLElement)?.matches("input, textarea")) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const path = sel.dataset.path!;
        guard(() => remove(ctx.fs.stat(path)));
      } else if (e.key === "Escape") {
        sel.classList.remove("sel");
      } else if (e.key === "Enter") {
        e.preventDefault();
        ctx.openPath(sel.dataset.path!);
      }
    };
    window.addEventListener("keydown", onKey);

    render();
    const offFs = ctx.fs.onChange(render);

    return () => {
      offFs();
      window.removeEventListener("contextmenu", onVoidContextMenu);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("keydown", onKey);
      for (const i of icons.values()) i.handle.dispose();
      icons.clear();
      closeContextMenu();
    };
  },
};

/** Deep copy within the VFS — used for paste and for read-only sources. */
export function copyRecursive(ctx: KernelContext, from: string, to: string): void {
  const src = normalize(from);
  const dest = normalize(to);
  if (ctx.fs.isDir(src)) {
    ctx.fs.mkdir(dest);
    for (const child of ctx.fs.ls(src)) {
      copyRecursive(ctx, child.path, `${dest}/${child.name}`);
    }
  } else {
    let text = "";
    try {
      text = ctx.fs.read(src);
    } catch {
      text = ""; // binary or unembedded: copy as an empty placeholder
    }
    ctx.fs.write(dest, text);
  }
}
