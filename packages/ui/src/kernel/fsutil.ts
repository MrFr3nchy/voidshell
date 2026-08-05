/**
 * Filesystem operations that are neither syscalls nor any one app's business.
 *
 * These lived in `modules/desktop`, which meant the file manager imported them
 * *from the desktop* — a file browser depending on a background service for its
 * copy implementation, because that service happened to need it first. Nothing
 * about `cp -r` belongs to the desktop, and the import made the two impossible
 * to reason about separately.
 *
 * Everything here is written against `FsApi`, so it works for any consumer with
 * a KernelContext and stays honest about having no privileges of its own.
 */

import type { KernelContext } from "./types";
import { basename, dirname, normalize } from "./vfs";

/**
 * A name that isn't taken yet in `dir`, derived from `base`.
 *
 * Both the desktop and the file manager had their own copy of this, and they
 * had already drifted — one looped to 500 and the other to 500 with a different
 * fallback. It is the same question in both places: what do I call the second
 * copy of this?
 */
export function uniqueName(ctx: KernelContext, dir: string, base: string): string {
  if (!ctx.fs.exists(`${dir}/${base}`)) return base;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 2; i < 500; i++) {
    if (!ctx.fs.exists(`${dir}/${stem} ${i}${ext}`)) return `${stem} ${i}${ext}`;
  }
  return `${stem}-${Date.now()}${ext}`;
}

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

/**
 * Put `src` into `destDir`, copying when a move would fail.
 *
 * Every drop target in the shell wants exactly this: move within the writable
 * tree, copy out of a read-only mount, and never fail with EROFS at the user
 * for dragging something out of /projects. Returns the path it landed on.
 */
export function transferInto(ctx: KernelContext, src: string, destDir: string): string {
  const dest = `${destDir}/${uniqueName(ctx, destDir, basename(src))}`;
  if (ctx.fs.stat(src).readonly) copyRecursive(ctx, src, dest);
  else ctx.fs.mv(src, dest);
  return dest;
}

/** Human bytes. Every view of a file wants the same one. */
export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const HOME = "/home/void";

/** `/home/void/notes/x.md` → `~/notes/x.md`. For anything that shows a path. */
export function tildify(path: string): string {
  if (path === HOME) return "~";
  return path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path;
}

/** Every ancestor of a path, root first, for breadcrumbs. */
export function ancestry(path: string): { name: string; path: string }[] {
  const p = normalize(path);
  const out = [{ name: "/", path: "/" }];
  if (p === "/") return out;
  let cur = "";
  for (const seg of p.slice(1).split("/")) {
    cur += `/${seg}`;
    out.push({ name: seg, path: cur });
  }
  return out;
}

/** The directory a path implies: itself if a directory, else its parent. */
export function dirOf(ctx: KernelContext, path: string): string {
  return ctx.fs.exists(path) && ctx.fs.isDir(path) ? normalize(path) : dirname(path);
}

/**
 * A relative-time string — "2 minutes ago", "yesterday".
 *
 * File lists showed raw sizes and no dates at all, while the VFS has carried
 * mtime since it was written. A timestamp you have to decode is worse than one
 * phrased the way you'd say it out loud.
 */
export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
