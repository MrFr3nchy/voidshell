/**
 * The trash.
 *
 * Until now `Delete` was immediate and permanent, in a shell whose entire
 * filesystem lives in localStorage and has no backups behind it. One mistyped
 * `rm -r` took your notes with it.
 *
 * The implementation is deliberately the boring one: trashing is a **move** to
 * ~/.Trash, so it costs nothing, keeps working with every existing FS tool, and
 * can't corrupt anything. What a move can't carry is where the file came from,
 * so that goes into a manifest in the store — which is also why restoring is
 * possible at all rather than just "here is a folder of orphaned files".
 *
 * The manifest lives in the store rather than as a dotfile in ~/.Trash so that
 * emptying the trash is a plain recursive delete with nothing to preserve.
 */

import type { KernelContext } from "./types";
import { basename, dirname, normalize } from "./vfs";

export const TRASH_DIR = "/home/void/.Trash";
export const TRASH_KEY = "system.trash";

export interface TrashItem {
  /** The name it has *inside* ~/.Trash, which may be uniquified. */
  name: string;
  /** Where it was when it was deleted. */
  from: string;
  at: number;
  kind: "file" | "dir";
}

export function listTrash(ctx: KernelContext): TrashItem[] {
  const items = ctx.state.get<TrashItem[]>(TRASH_KEY, []);
  if (!Array.isArray(items)) return [];
  // The store and the directory can drift — a manual `rm -f ~/.Trash/x`, or a
  // wipe. The directory is the truth; the manifest only annotates it.
  return items.filter((i) => ctx.fs.exists(`${TRASH_DIR}/${i.name}`));
}

/** Move a path to the trash. Returns the name it landed under. */
export function moveToTrash(ctx: KernelContext, path: string): string {
  const src = normalize(path);
  if (src === TRASH_DIR || src.startsWith(`${TRASH_DIR}/`)) {
    throw new Error("already in the trash — use `rm -f` to delete it for good");
  }
  const entry = ctx.fs.stat(src);
  if (entry.readonly) {
    throw new Error(`read-only filesystem: ${path}`);
  }

  ctx.fs.mkdirp(TRASH_DIR);

  // Two files called notes.md deleted from different directories must both
  // survive, so the second one gets a suffix rather than clobbering the first.
  let name = basename(src);
  if (ctx.fs.exists(`${TRASH_DIR}/${name}`)) {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let n = 2;
    while (ctx.fs.exists(`${TRASH_DIR}/${stem}-${n}${ext}`)) n++;
    name = `${stem}-${n}${ext}`;
  }

  ctx.fs.mv(src, `${TRASH_DIR}/${name}`);
  ctx.state.set(TRASH_KEY, [
    ...listTrash(ctx),
    { name, from: src, at: Date.now(), kind: entry.kind },
  ]);
  return name;
}

/** Put a trashed item back where it came from. Returns the restored path. */
export function restoreFromTrash(ctx: KernelContext, name: string): string {
  const items = listTrash(ctx);
  const item = items.find((i) => i.name === name);
  if (!item) throw new Error(`nothing in the trash called "${name}"`);
  if (ctx.fs.exists(item.from)) {
    throw new Error(`something is already at ${item.from}`);
  }

  // The directory it lived in may itself have been deleted since.
  ctx.fs.mkdirp(dirname(item.from));
  ctx.fs.mv(`${TRASH_DIR}/${name}`, item.from);
  ctx.state.set(
    TRASH_KEY,
    items.filter((i) => i.name !== name)
  );
  return item.from;
}

/** Delete everything in the trash for good. Returns how many items went. */
export function emptyTrash(ctx: KernelContext): number {
  if (!ctx.fs.exists(TRASH_DIR)) return 0;
  const children = ctx.fs.ls(TRASH_DIR);
  for (const c of children) ctx.fs.rm(c.path, true);
  ctx.state.set(TRASH_KEY, []);
  return children.length;
}
