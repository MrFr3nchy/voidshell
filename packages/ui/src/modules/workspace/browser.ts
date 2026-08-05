import type { FsEntry, KernelContext } from "../../kernel/types";
import { basename, dirname } from "../../kernel/vfs";
import {
  copyRecursive,
  formatSize,
  timeAgo,
  transferInto,
  uniqueName,
} from "../../kernel/fsutil";
import { fileTypeFor } from "../../kernel/filetypes";
import { moveToTrash } from "../../kernel/trash";
import { clipboard } from "../../ui/clipboard";
import { promptInline, showContextMenu } from "../../ui/contextMenu";
import {
  newMenuItems,
  showFileInfo,
  showFileMenu,
  trashWithUndo,
} from "../../ui/fileMenu";

/**
 * The file list half of the Workspace.
 *
 * It knows nothing about where files come from — /home and /projects are the
 * same API to it. There is no preview pane: the console occupies that space,
 * and double-clicking a file opens it in whatever app is associated with it.
 *
 * What changed here is everything a file manager is expected to do and this one
 * couldn't: sort, select more than one thing, work from the keyboard, search
 * below the current directory, and say what a file *is* rather than drawing
 * every one of them as a dot.
 */

const SORT_KEY = "files.sort";
const HIDDEN_KEY = "files.hidden";

type SortField = "name" | "size" | "modified" | "kind";
interface Sort {
  by: SortField;
  desc: boolean;
}

export interface BrowserHandle {
  el: HTMLElement;
  /** Point the list at a directory (used when the console cd's). */
  setCwd(path: string): void;
  /** Open the New menu — folder, or any file template — at a point. */
  newMenu(x: number, y: number): void;
  /** Move keyboard focus into the list, e.g. from the path bar. */
  focus(): void;
  dispose(): void;
}

export function createBrowser(
  ctx: KernelContext,
  opts: { cwd: string; onCwd(path: string): void }
): BrowserHandle {
  const el = document.createElement("div");
  el.className = "fm-list";
  el.tabIndex = 0;

  let cwd = opts.cwd;
  /** Selection, in the order rows appear. Multi-select is the normal case now. */
  let selected = new Set<string>();
  /** Where shift-click ranges start from. */
  let anchor: string | null = null;
  /** The row the keyboard is on, which is not always the selection. */
  let cursor = 0;
  /** Live filter. A non-empty query searches the whole subtree, not just here. */
  let query = "";
  /** The rows currently on screen, in display order. */
  let rows: FsEntry[] = [];

  const sort = (): Sort => ctx.state.get<Sort>(SORT_KEY, { by: "kind", desc: false });
  const showHidden = () => ctx.state.get<boolean>(HIDDEN_KEY, false);

  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      ctx.notify(err instanceof Error ? err.message : String(err), "warn");
    }
  };

  /** Navigate, telling the workspace so the console follows. */
  const goTo = (path: string) => {
    cwd = path;
    selected = new Set();
    anchor = null;
    cursor = 0;
    query = "";
    filterInput.value = "";
    render();
    opts.onCwd(path);
  };

  const hooks = {
    guard,
    onRenamed: () => {},
    onDeleted: (path: string) => selected.delete(path),
    pasteDir: undefined as string | undefined,
  };

  /* ---------------- toolbar: filter and sort ---------------- */

  const tools = document.createElement("div");
  tools.className = "fm-tools";

  const filterInput = document.createElement("input");
  filterInput.className = "fm-filter";
  filterInput.type = "text";
  filterInput.placeholder = "filter…  (searches below here)";
  filterInput.setAttribute("aria-label", "Filter files");

  const sortBtn = document.createElement("button");
  sortBtn.className = "fm-btn fm-sort";
  sortBtn.title = "Sort";

  tools.append(filterInput, sortBtn);

  const sortLabel = () => {
    const s = sort();
    const names: Record<SortField, string> = {
      kind: "kind",
      name: "name",
      size: "size",
      modified: "date",
    };
    sortBtn.textContent = `${names[s.by]} ${s.desc ? "↓" : "↑"}`;
  };

  sortBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const s = sort();
    const pick = (by: SortField) => ({
      label: by === s.by ? `${by} · reverse` : by,
      action: () => {
        ctx.state.set(SORT_KEY, { by, desc: by === s.by ? !s.desc : false });
        sortLabel();
        render();
      },
    });
    showContextMenu(e.clientX, e.clientY, [
      pick("kind"),
      pick("name"),
      pick("size"),
      pick("modified"),
      {
        label: showHidden() ? "Hide dotfiles" : "Show dotfiles",
        separated: true,
        action: () => {
          ctx.state.set(HIDDEN_KEY, !showHidden());
          render();
        },
      },
    ]);
  });

  filterInput.addEventListener("input", () => {
    query = filterInput.value.trim();
    cursor = 0;
    render();
  });
  filterInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      filterInput.value = "";
      query = "";
      render();
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      el.focus();
    }
  });

  const listEl = document.createElement("div");
  listEl.className = "fm-rows";
  el.append(tools, listEl);

  /* ---------------- reading the directory ---------------- */

  /**
   * Walk below `cwd` for a query.
   *
   * Bounded rather than exhaustive: /projects is tens of thousands of entries
   * and a file manager that freezes when you type into it is worse than one
   * with no search at all.
   */
  const searchBelow = (root: string, q: string, budget = 4000): FsEntry[] => {
    const needle = q.toLowerCase();
    const out: FsEntry[] = [];
    const queue = [root];
    let seen = 0;
    while (queue.length && seen < budget && out.length < 300) {
      const dir = queue.shift()!;
      let kids: FsEntry[];
      try {
        kids = ctx.fs.ls(dir);
      } catch {
        continue;
      }
      for (const k of kids) {
        seen++;
        if (!showHidden() && k.name.startsWith(".")) continue;
        if (k.name.toLowerCase().includes(needle)) out.push(k);
        if (k.kind === "dir") queue.push(k.path);
      }
    }
    return out;
  };

  const collect = (): FsEntry[] => {
    if (query) return searchBelow(cwd, query);
    // Dotfiles are hidden by default for the same reason every file manager
    // hides them: ~/.Trash and ~/.desktop-layout.json are the shell's
    // bookkeeping, not the user's documents. The toggle is in the sort menu.
    const items = ctx.fs.ls(cwd);
    return showHidden() ? items : items.filter((e) => !e.name.startsWith("."));
  };

  const sorted = (items: FsEntry[]): FsEntry[] => {
    const s = sort();
    const dir = s.desc ? -1 : 1;
    const cmp = (a: FsEntry, b: FsEntry): number => {
      switch (s.by) {
        case "size":
          return (a.size - b.size) * dir;
        case "modified":
          return (a.mtime - b.mtime) * dir;
        case "name":
          return a.name.localeCompare(b.name) * dir;
        default:
          // "kind" is the familiar default: folders first, then names.
          return a.kind === b.kind
            ? a.name.localeCompare(b.name) * dir
            : a.kind === "dir"
              ? -1
              : 1;
      }
    };
    return [...items].sort(cmp);
  };

  /* ---------------- selection ---------------- */

  const selectOnly = (path: string) => {
    selected = new Set([path]);
    anchor = path;
  };

  const toggleOne = (path: string) => {
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
    anchor = path;
  };

  const selectRange = (to: string) => {
    const from = anchor ?? to;
    const a = rows.findIndex((r) => r.path === from);
    const b = rows.findIndex((r) => r.path === to);
    if (a < 0 || b < 0) return selectOnly(to);
    selected = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.path));
  };

  /** Everything selected, as entries that still exist. */
  const selection = (): FsEntry[] =>
    [...selected].flatMap((p) => {
      try {
        return [ctx.fs.stat(p)];
      } catch {
        return [];
      }
    });

  /* ---------------- rendering ---------------- */

  function render(): void {
    listEl.replaceChildren();

    let items: FsEntry[];
    try {
      items = collect();
    } catch (err) {
      const e = document.createElement("div");
      e.className = "fm-note warn";
      e.textContent = err instanceof Error ? err.message : String(err);
      listEl.appendChild(e);
      rows = [];
      return;
    }

    rows = sorted(items);
    sortLabel();

    if (!rows.length) {
      const e = document.createElement("div");
      e.className = "fm-note";
      e.textContent = query ? `nothing below here matches "${query}"` : "empty directory";
      listEl.appendChild(e);
      return;
    }

    cursor = Math.min(cursor, rows.length - 1);

    rows.forEach((entry, i) => {
      const type = fileTypeFor(entry.path, entry.kind);
      const row = document.createElement("button");
      row.className = `fm-row ${entry.kind} fam-${type.family}`;
      row.classList.toggle("sel", selected.has(entry.path));
      row.classList.toggle("cursor", i === cursor);
      row.dataset.path = entry.path;

      const glyph = document.createElement("span");
      glyph.className = "fm-glyph";
      glyph.textContent = entry.omitted ? "◌" : type.glyph;
      glyph.title = type.label;

      const name = document.createElement("span");
      name.className = "fm-name";
      // A search result is somewhere else, so it has to say where.
      name.textContent = query ? entry.path.slice(cwd.length + 1) || entry.name : entry.name;

      const when = document.createElement("span");
      when.className = "fm-when";
      when.textContent = timeAgo(entry.mtime);

      const size = document.createElement("span");
      size.className = "fm-size";
      size.textContent = entry.kind === "dir" ? "" : formatSize(entry.size);

      row.append(glyph, name, when, size);

      row.addEventListener("click", (e) => {
        cursor = i;
        if (e.shiftKey) selectRange(entry.path);
        else if (e.metaKey || e.ctrlKey) toggleOne(entry.path);
        else selectOnly(entry.path);
        paintSelection();
      });

      // Double-click opens in the associated app, as in any file manager.
      row.addEventListener("dblclick", (e) => {
        e.preventDefault();
        if (entry.kind === "dir") goTo(entry.path);
        else ctx.openPath(entry.path);
      });

      // Drag a row out onto the void to put it on the desktop. HTML5 DnD rather
      // than pointer events, because the drop lands on a different element tree
      // (the void) than the drag started in (this panel).
      row.draggable = true;
      row.addEventListener("dragstart", (e) => {
        // Dragging an unselected row selects it first, or the drag would
        // silently carry something other than what is highlighted.
        if (!selected.has(entry.path)) {
          selectOnly(entry.path);
          paintSelection();
        }
        e.dataTransfer?.setData("text/voidshell-path", entry.path);
        e.dataTransfer?.setData("text/plain", [...selected].join("\n"));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "copyMove";
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));

      // Dropping onto a folder row moves things into it — the one gesture the
      // list was missing, and the reason organising anything meant using the
      // console.
      if (entry.kind === "dir") {
        row.addEventListener("dragover", (e) => {
          if (!e.dataTransfer?.types.includes("text/voidshell-path")) return;
          e.preventDefault();
          e.stopPropagation();
          row.classList.add("drop-target");
        });
        row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
        row.addEventListener("drop", (e) => {
          row.classList.remove("drop-target");
          const src = e.dataTransfer?.getData("text/voidshell-path");
          if (!src || src === entry.path) return;
          e.preventDefault();
          e.stopPropagation();
          guard(() => transferInto(ctx, src, entry.path));
        });
      }

      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        cursor = i;
        if (!selected.has(entry.path)) selectOnly(entry.path);
        paintSelection();
        // More than one thing selected is a different question — "what do I do
        // with these" has fewer sensible answers than "what do I do with this".
        if (selected.size > 1) bulkMenu(e.clientX, e.clientY);
        else showFileMenu(ctx, entry, e.clientX, e.clientY, { ...hooks, pasteDir: cwd });
      });

      listEl.appendChild(row);
    });
  }

  /** Repaint selection classes without rebuilding every row. */
  const paintSelection = () => {
    const kids = [...listEl.querySelectorAll<HTMLElement>(".fm-row")];
    kids.forEach((k, i) => {
      k.classList.toggle("sel", selected.has(k.dataset.path!));
      k.classList.toggle("cursor", i === cursor);
    });
    kids[cursor]?.scrollIntoView({ block: "nearest" });
  };

  const bulkMenu = (x: number, y: number) => {
    const items = selection();
    const writable = items.filter((i) => !i.readonly);
    showContextMenu(x, y, [
      { label: `${items.length} items selected` },
      {
        label: "Copy",
        separated: true,
        action: () => clipboard.set(items.map((i) => i.path), "copy"),
      },
      {
        label: "Cut",
        action: writable.length
          ? () => clipboard.set(writable.map((i) => i.path), "cut")
          : undefined,
      },
      {
        label: `Move ${writable.length} to Trash`,
        separated: true,
        danger: true,
        action: writable.length
          ? () =>
              guard(() => {
                for (const i of writable) moveToTrash(ctx, i.path);
                selected = new Set();
                ctx.notify(`${writable.length} items moved to trash`, {
                  action: { label: "open trash", run: (c) => c.launch("trash") },
                });
              })
          : undefined,
      },
    ]);
  };

  /* ---------------- keyboard ---------------- */

  el.addEventListener("keydown", (e) => {
    if (e.target === filterInput) return;
    const current = rows[cursor];

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      cursor = Math.max(0, Math.min(rows.length - 1, cursor + (e.key === "ArrowDown" ? 1 : -1)));
      const at = rows[cursor];
      if (at) {
        if (e.shiftKey) selectRange(at.path);
        else selectOnly(at.path);
      }
      paintSelection();
      return;
    }
    if (e.key === "Enter" && current) {
      e.preventDefault();
      e.stopPropagation();
      if (current.kind === "dir") goTo(current.path);
      else ctx.openPath(current.path);
      return;
    }
    if ((e.key === "Backspace" || e.key === "ArrowLeft") && cwd !== "/") {
      e.preventDefault();
      e.stopPropagation();
      goTo(dirname(cwd));
      return;
    }
    if (e.key === "ArrowRight" && current?.kind === "dir") {
      e.preventDefault();
      e.stopPropagation();
      goTo(current.path);
      return;
    }
    if (e.key === "Delete" && selected.size) {
      e.preventDefault();
      e.stopPropagation();
      const doomed = selection().filter((i) => !i.readonly);
      guard(() => {
        if (doomed.length === 1) trashWithUndo(ctx, doomed[0], hooks);
        else {
          for (const i of doomed) moveToTrash(ctx, i.path);
          ctx.notify(`${doomed.length} items moved to trash`, {
            action: { label: "open trash", run: (c) => c.launch("trash") },
          });
        }
        selected = new Set();
      });
      return;
    }
    if (e.key === "F2" && current && !current.readonly) {
      e.preventDefault();
      e.stopPropagation();
      const r = listEl.querySelectorAll<HTMLElement>(".fm-row")[cursor]?.getBoundingClientRect();
      promptInline(r?.left ?? 200, r?.top ?? 200, current.name, "new name", (n) =>
        guard(() => ctx.fs.mv(current.path, `${dirname(current.path)}/${n}`))
      );
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      e.stopPropagation();
      selected = new Set(rows.map((r) => r.path));
      paintSelection();
      return;
    }
    if (mod && e.key.toLowerCase() === "i" && current) {
      e.preventDefault();
      e.stopPropagation();
      const r = listEl.querySelectorAll<HTMLElement>(".fm-row")[cursor]?.getBoundingClientRect();
      showFileInfo(ctx, current.path, r?.right ?? 200, r?.top ?? 200);
      return;
    }
    if (mod && e.key.toLowerCase() === "c" && selected.size) {
      e.stopPropagation();
      clipboard.set([...selected], "copy");
      return;
    }
    if (mod && e.key.toLowerCase() === "x" && selected.size) {
      e.stopPropagation();
      clipboard.set([...selected], "cut");
      return;
    }
    if (mod && e.key.toLowerCase() === "v") {
      e.stopPropagation();
      const clip = clipboard.get();
      if (!clip) return;
      guard(() => {
        for (const p of clip.paths) {
          const dest = `${cwd}/${uniqueName(ctx, cwd, basename(p))}`;
          if (clip.mode === "cut") ctx.fs.mv(p, dest);
          else copyRecursive(ctx, p, dest);
        }
        if (clip.mode === "cut") clipboard.clear();
      });
      return;
    }
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      filterInput.focus();
      return;
    }
    // Type-ahead: jump to the next row starting with the character typed.
    // Swallowed, so that typing a name in a focused list can't also trip the
    // shell's global binds — space would otherwise summon the launcher.
    if (e.key.length === 1 && !mod) {
      e.preventDefault();
      e.stopPropagation();
      const from = cursor + 1;
      const hit = rows
        .map((r, i) => ({ r, i }))
        .find(({ r, i }) => i >= from && r.name.toLowerCase().startsWith(e.key.toLowerCase()))
        ?? rows
          .map((r, i) => ({ r, i }))
          .find(({ r }) => r.name.toLowerCase().startsWith(e.key.toLowerCase()));
      if (hit) {
        cursor = hit.i;
        selectOnly(hit.r.path);
        paintSelection();
      }
    }
  });

  /* ---------------- drops into the list itself ---------------- */

  // Dropping onto empty list space moves the item into the current directory —
  // the inverse of dragging a file out to the desktop.
  listEl.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("text/voidshell-path")) return;
    e.preventDefault();
    e.stopPropagation();
    listEl.classList.add("drop-target");
  });
  listEl.addEventListener("dragleave", () => listEl.classList.remove("drop-target"));
  listEl.addEventListener("drop", (e) => {
    listEl.classList.remove("drop-target");
    const src = e.dataTransfer?.getData("text/voidshell-path");
    if (!src) return;
    e.preventDefault();
    e.stopPropagation();
    if (dirname(src) === cwd) return; // already here
    guard(() => transferInto(ctx, src, cwd));
  });

  // Right-click on empty space is about the *directory*, not about any file.
  listEl.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".fm-row")) return;
    e.preventDefault();
    e.stopPropagation();
    const clip = clipboard.get();
    showContextMenu(e.clientX, e.clientY, [
      { label: "New", submenu: newMenuItems(ctx, cwd, { x: e.clientX, y: e.clientY }, hooks) },
      {
        label: clip ? `Paste ${clip.paths.length} item(s)` : "Paste",
        action: clip
          ? () =>
              guard(() => {
                for (const p of clip.paths) {
                  const dest = `${cwd}/${uniqueName(ctx, cwd, basename(p))}`;
                  if (clip.mode === "cut") ctx.fs.mv(p, dest);
                  else copyRecursive(ctx, p, dest);
                }
                if (clip.mode === "cut") clipboard.clear();
              })
          : undefined,
      },
      {
        label: "Get Info",
        separated: true,
        action: () => showFileInfo(ctx, cwd, e.clientX, e.clientY),
      },
    ]);
  });

  render();
  const off = ctx.fs.onChange(render);

  return {
    el,
    setCwd(path) {
      cwd = path;
      selected = new Set();
      anchor = null;
      cursor = 0;
      query = "";
      filterInput.value = "";
      render();
    },
    newMenu(x, y) {
      showContextMenu(x, y, newMenuItems(ctx, cwd, { x, y }, hooks));
    },
    focus() {
      el.focus();
    },
    dispose() {
      off();
      el.replaceChildren();
    },
  };
}
