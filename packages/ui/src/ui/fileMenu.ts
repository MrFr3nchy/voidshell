/**
 * One file menu, for every place a file appears.
 *
 * The desktop and the file browser each grew their own right-click menu, and
 * they disagreed: the desktop offered "Open in Workspace" and no paste-into,
 * the browser offered paste and no rename-with-layout, only one of them had
 * "Run", and the two "Delete" entries were spelled differently for the same
 * operation. Two menus for the same object is two chances to be inconsistent,
 * and the user is the one who has to hold both versions in their head.
 *
 * This builds the menu once. Callers pass the entry and the few behaviours
 * that genuinely differ — the desktop remembers icon positions, the browser
 * knows its own working directory — and get the same verbs in the same order
 * either way.
 */

import type { FsEntry, KernelContext, ModuleManifest } from "../kernel/types";
import { basename, dirname } from "../kernel/vfs";
import { copyRecursive, formatSize, timeAgo, tildify, uniqueName } from "../kernel/fsutil";
import { TEMPLATES, fileTypeFor } from "../kernel/filetypes";
import { moveToTrash, restoreFromTrash } from "../kernel/trash";
import { isRunnable } from "../runtime/program";
import { clipboard } from "./clipboard";
import {
  promptInline,
  showContextMenu,
  showMenuPanel,
  type MenuItem,
} from "./contextMenu";

export interface FileMenuHooks {
  /** Report a failed operation. Both callers already have their own guard. */
  guard(fn: () => void): void;
  /** Called after something is created, so a caller can place its icon. */
  onCreated?(path: string, x: number, y: number): void;
  /** Called after a rename, so a caller can carry an icon position across. */
  onRenamed?(from: string, to: string): void;
  /** Called after a delete, so a caller can forget an icon position. */
  onDeleted?(path: string): void;
  /** Where "Paste" puts things, when the menu was opened on a file. */
  pasteDir?: string;
}

/**
 * Trash something and offer to undo it.
 *
 * Deletion used to be reported as `note.md → trash · restore note.md`, which
 * is a sentence telling you to go and type something in a console you may not
 * have open. Notices can carry an action; an undo belongs on the notice.
 */
export function trashWithUndo(ctx: KernelContext, entry: FsEntry, hooks?: FileMenuHooks): void {
  const name = moveToTrash(ctx, entry.path);
  hooks?.onDeleted?.(entry.path);
  ctx.notify(`${entry.name} moved to trash`, {
    action: {
      label: "undo",
      run: (c) => {
        try {
          c.notify(`restored ${tildify(restoreFromTrash(c, name))}`, "good");
        } catch (err) {
          c.notify(err instanceof Error ? err.message : String(err), "warn");
        }
      },
    },
  });
}

/** The "Open With…" flyout: every app that can take this file, plus a default. */
function openWithItems(ctx: KernelContext, entry: FsEntry): MenuItem[] {
  const apps: ModuleManifest[] = ctx.handlersFor(entry.path);
  if (!apps.length) return [{ label: "nothing opens this" }];

  const items: MenuItem[] = apps.map((m, i) => ({
    label: i === 0 ? `${m.name}  (default)` : m.name,
    action: () => ctx.openWith(entry.path, m.id),
  }));

  // Setting a default is a different kind of act from opening something once,
  // so it is separated and phrased as the sentence it performs.
  if (apps.length > 1 && entry.kind === "file") {
    const type = fileTypeFor(entry.path).label.toLowerCase();
    items.push({
      label: `always open ${type} here…`,
      separated: true,
      submenu: apps.map((m) => ({
        label: m.name,
        action: () => {
          ctx.setDefaultApp(entry.path, m.id);
          ctx.notify(`${type} files now open in ${m.name}`, "good");
        },
      })),
    });
  }
  return items;
}

/** The "New" flyout: a folder, or any of the file templates. */
export function newMenuItems(
  ctx: KernelContext,
  dir: string,
  at: { x: number; y: number },
  hooks: FileMenuHooks
): MenuItem[] {
  const make = (name: string, body: string | null) =>
    hooks.guard(() => {
      const target = `${dir}/${uniqueName(ctx, dir, name)}`;
      if (body === null) ctx.fs.mkdir(target);
      else ctx.fs.write(target, body);
      hooks.onCreated?.(target, at.x, at.y);
    });

  return [
    {
      label: "Folder",
      action: () =>
        promptInline(at.x, at.y, "New Folder", "folder name", (n) => make(n, null)),
    },
    ...TEMPLATES.map((t) => ({
      label: t.label,
      separated: t.id === "md",
      action: () =>
        promptInline(at.x, at.y, t.name, "file name", (n) => make(n, t.body)),
    })),
  ];
}

/** Everything you can do to one file or folder. */
export function fileMenuItems(
  ctx: KernelContext,
  entry: FsEntry,
  at: { x: number; y: number },
  hooks: FileMenuHooks
): MenuItem[] {
  const clip = clipboard.get();
  const pasteDir = hooks.pasteDir ?? (entry.kind === "dir" ? entry.path : dirname(entry.path));
  const canPasteHere = (() => {
    try {
      return Boolean(clip) && !ctx.fs.stat(pasteDir).readonly;
    } catch {
      return false;
    }
  })();

  return [
    { label: "Open", action: () => ctx.openPath(entry.path), accel: "↵" },
    {
      label: "Open With",
      submenu: openWithItems(ctx, entry),
    },
    ...(isRunnable(entry.path)
      ? [{ label: "Run", action: () => ctx.launch("editor", { path: entry.path, run: true }) }]
      : []),
    {
      label: "Reveal in Workspace",
      action: () =>
        ctx.launch("workspace", {
          path: entry.kind === "dir" ? entry.path : dirname(entry.path),
        }),
    },
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
      label: clip
        ? clip.paths.length > 1
          ? `Paste ${clip.paths.length} items`
          : `Paste "${basename(clip.path)}"`
        : "Paste",
      action: canPasteHere
        ? () =>
            hooks.guard(() => {
              for (const src of clip!.paths) {
                const dest = `${pasteDir}/${uniqueName(ctx, pasteDir, basename(src))}`;
                if (clip!.mode === "cut") ctx.fs.mv(src, dest);
                else copyRecursive(ctx, src, dest);
                hooks.onCreated?.(dest, at.x, at.y);
              }
              if (clip!.mode === "cut") clipboard.clear();
            })
        : undefined,
    },
    {
      label: "Rename…",
      separated: true,
      action: entry.readonly
        ? undefined
        : () =>
            promptInline(at.x, at.y, entry.name, "new name", (n) =>
              hooks.guard(() => {
                const dest = `${dirname(entry.path)}/${n}`;
                ctx.fs.mv(entry.path, dest);
                hooks.onRenamed?.(entry.path, dest);
              })
            ),
    },
    { label: "Get Info", accel: "⌘I", action: () => showFileInfo(ctx, entry.path, at.x, at.y) },
    {
      label: "Move to Trash",
      separated: true,
      danger: true,
      action: entry.readonly
        ? undefined
        : () => hooks.guard(() => trashWithUndo(ctx, entry, hooks)),
    },
  ];
}

/** Open the shared menu for an entry. */
export function showFileMenu(
  ctx: KernelContext,
  entry: FsEntry,
  x: number,
  y: number,
  hooks: FileMenuHooks
): void {
  showContextMenu(x, y, fileMenuItems(ctx, entry, { x, y }, hooks));
}

/**
 * A properties panel.
 *
 * Everything here was already knowable — `stat` has carried size, mtime and
 * the read-only flag from the start — and none of it was reachable without
 * opening a console and typing. Which mount a file is on is the one fact that
 * explains the most: it is why /projects won't save.
 */
export function showFileInfo(ctx: KernelContext, path: string, x: number, y: number): void {
  let entry: FsEntry;
  try {
    entry = ctx.fs.stat(path);
  } catch (err) {
    ctx.notify(err instanceof Error ? err.message : String(err), "warn");
    return;
  }

  const type = fileTypeFor(entry.path, entry.kind);
  const mount = [...ctx.fs.mounts()]
    .filter((m) => entry.path === m.at || entry.path.startsWith(`${m.at}/`))
    .sort((a, b) => b.at.length - a.at.length)[0];

  const rows: [string, string][] = [
    ["kind", type.label],
    ["where", tildify(dirname(entry.path))],
    ["size", entry.kind === "dir" ? `${countChildren(ctx, entry.path)} items` : formatSize(entry.size)],
    ["modified", `${timeAgo(entry.mtime)} · ${new Date(entry.mtime).toLocaleString()}`],
    ["access", entry.readonly ? "read-only" : "read & write"],
    ["volume", mount ? `${mount.at} (${mount.backing})` : "—"],
  ];
  if (entry.omitted) {
    rows.push(["contents", entry.omitted === "binary" ? "binary — not embedded" : "too large to embed"]);
  }
  for (const [k, v] of Object.entries(entry.meta ?? {})) rows.push([k, v]);

  const panel = document.createElement("div");
  panel.className = "vs-menu vs-info";

  const head = document.createElement("div");
  head.className = "vs-info-head";
  const glyph = document.createElement("span");
  glyph.className = "vs-info-glyph";
  glyph.textContent = type.glyph;
  const name = document.createElement("span");
  name.className = "vs-info-name";
  name.textContent = entry.name;
  head.append(glyph, name);
  panel.appendChild(head);

  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "vs-info-row";
    const key = document.createElement("span");
    key.className = "vs-info-key";
    key.textContent = k;
    const val = document.createElement("span");
    val.className = "vs-info-val";
    val.textContent = v;
    row.append(key, val);
    panel.appendChild(row);
  }

  // Lives in the menu layer, so it dismisses on the next click the way a menu
  // does — an info panel you have to close is a dialog, and this is not that.
  showMenuPanel(x, y, panel);
}

function countChildren(ctx: KernelContext, path: string): number {
  try {
    return ctx.fs.ls(path).length;
  } catch {
    return 0;
  }
}
