import type { FsEntry, KernelContext } from "../../kernel/types";
import { basename, dirname } from "../../kernel/vfs";
import { moveToTrash } from "../../kernel/trash";
import { promptInline, showContextMenu } from "../../ui/contextMenu";
import { clipboard } from "../../ui/clipboard";
import { copyRecursive } from "../desktop";
import { isRunnable } from "../../runtime/program";

/**
 * The file list half of the Workspace.
 *
 * It knows nothing about where files come from — /home and /projects are the
 * same API to it. There is no preview pane: the console occupies that space,
 * and double-clicking a file opens it in the editor, which is a better viewer
 * than anything worth reimplementing here.
 */

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export interface BrowserHandle {
  el: HTMLElement;
  /** Point the list at a directory (used when the console cd's). */
  setCwd(path: string): void;
  /** Inline-prompt for a new folder / file in the current directory. */
  newFolder(x: number, y: number): void;
  newFile(x: number, y: number): void;
  dispose(): void;
}

export function createBrowser(
  ctx: KernelContext,
  opts: { cwd: string; onCwd(path: string): void }
): BrowserHandle {
  const el = document.createElement("div");
  el.className = "fm-list";

  let cwd = opts.cwd;
  let selected: string | null = null;

  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "warn");
    }
  };

  const uniqueName = (dir: string, base: string): string => {
    if (!ctx.fs.exists(`${dir}/${base}`)) return base;
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    for (let i = 2; i < 500; i++) {
      if (!ctx.fs.exists(`${dir}/${stem} ${i}${ext}`)) return `${stem} ${i}${ext}`;
    }
    return `${stem}-${Date.now()}${ext}`;
  };

  /** Navigate, telling the workspace so the console follows. */
  const goTo = (path: string) => {
    cwd = path;
    selected = null;
    render();
    opts.onCwd(path);
  };

  const rowMenu = (entry: FsEntry, x: number, y: number) => {
    const clip = clipboard.get();
    showContextMenu(x, y, [
      { label: "Open", action: () => ctx.openPath(entry.path) },
      ...(isRunnable(entry.path)
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
        label: "Copy",
        separated: true,
        action: () => clipboard.set(entry.path, "copy"),
      },
      {
        label: "Cut",
        action: entry.readonly ? undefined : () => clipboard.set(entry.path, "cut"),
      },
      {
        label: clip ? `Paste "${basename(clip.path)}"` : "Paste",
        action:
          clip && !ctx.fs.stat(cwd).readonly
            ? () =>
                guard(() => {
                  const dest = `${cwd}/${uniqueName(cwd, basename(clip.path))}`;
                  if (clip.mode === "cut") {
                    ctx.fs.mv(clip.path, dest);
                    clipboard.clear();
                  } else copyRecursive(ctx, clip.path, dest);
                })
            : undefined,
      },
      {
        label: "Rename…",
        separated: true,
        action: entry.readonly
          ? undefined
          : () =>
              promptInline(x, y, entry.name, "new name", (n) =>
                guard(() => ctx.fs.mv(entry.path, `${dirname(entry.path)}/${n}`))
              ),
      },
      {
        label: "Move to Trash",
        danger: true,
        action: entry.readonly
          ? undefined
          : () =>
              guard(() => {
                const name = moveToTrash(ctx, entry.path);
                ctx.notify(`${entry.name} → trash · restore ${name}`);
              }),
      },
    ]);
  };

  function render(): void {
    el.replaceChildren();

    let items: FsEntry[];
    try {
      // Dotfiles are hidden here for the same reason every file manager hides
      // them: ~/.Trash and ~/.desktop-layout.json are the shell's bookkeeping,
      // not the user's documents. `ls -a` in the console still shows them.
      items = ctx.fs.ls(cwd).filter((e) => !e.name.startsWith("."));
    } catch (err) {
      const e = document.createElement("div");
      e.className = "fm-note warn";
      e.textContent = err instanceof Error ? err.message : String(err);
      el.appendChild(e);
      return;
    }

    if (!items.length) {
      const e = document.createElement("div");
      e.className = "fm-note";
      e.textContent = "empty directory";
      el.appendChild(e);
    }

    for (const entry of items) {
      const row = document.createElement("button");
      row.className = `fm-row ${entry.kind}${selected === entry.path ? " sel" : ""}`;

      const glyph = document.createElement("span");
      glyph.className = "fm-glyph";
      glyph.textContent = entry.kind === "dir" ? "▸" : entry.omitted ? "◌" : "·";

      const name = document.createElement("span");
      name.className = "fm-name";
      name.textContent = entry.name;

      const size = document.createElement("span");
      size.className = "fm-size";
      size.textContent = entry.kind === "dir" ? "" : fmtSize(entry.size);

      row.append(glyph, name, size);

      row.addEventListener("click", () => {
        if (entry.kind === "dir") goTo(entry.path);
        else {
          selected = entry.path;
          render();
        }
      });

      // Double-click opens in the associated app, as in any file manager.
      row.addEventListener("dblclick", (e) => {
        e.preventDefault();
        ctx.openPath(entry.path);
      });

      // Drag a row out onto the void to put it on the desktop. HTML5 DnD rather
      // than pointer events, because the drop lands on a different element tree
      // (the void) than the drag started in (this panel).
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        e.dataTransfer?.setData("text/voidshell-path", entry.path);
        e.dataTransfer?.setData("text/plain", entry.path);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));

      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        rowMenu(entry, e.clientX, e.clientY);
      });

      el.appendChild(row);
    }
  }

  // Dropping onto the list moves the item into the current directory — the
  // inverse of dragging a file out to the desktop.
  el.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("text/voidshell-path")) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add("drop-target");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
  el.addEventListener("drop", (e) => {
    el.classList.remove("drop-target");
    const src = e.dataTransfer?.getData("text/voidshell-path");
    if (!src) return;
    e.preventDefault();
    e.stopPropagation();
    if (dirname(src) === cwd) return; // already here
    guard(() => {
      const dest = `${cwd}/${uniqueName(cwd, basename(src))}`;
      if (ctx.fs.stat(src).readonly) copyRecursive(ctx, src, dest);
      else ctx.fs.mv(src, dest);
    });
  });

  render();
  const off = ctx.fs.onChange(render);

  return {
    el,
    setCwd(path) {
      cwd = path;
      selected = null;
      render();
    },
    newFolder(x, y) {
      promptInline(x, y, "New Folder", "folder name", (n) =>
        guard(() => ctx.fs.mkdir(`${cwd}/${uniqueName(cwd, n)}`))
      );
    },
    newFile(x, y) {
      promptInline(x, y, "untitled.md", "file name", (n) =>
        guard(() => ctx.fs.write(`${cwd}/${uniqueName(cwd, n)}`, ""))
      );
    },
    dispose() {
      off();
      el.replaceChildren();
    },
  };
}
