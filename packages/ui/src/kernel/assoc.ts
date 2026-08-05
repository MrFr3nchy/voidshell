/**
 * Which app opens what.
 *
 * The old rule was "the first registered module whose `handles` contains this
 * extension, else the first that declared `handles: ["*"]`". Two things were
 * wrong with that. Registration order silently decided behaviour — `main.ts`
 * carried a comment explaining that the Workspace had to be registered before
 * the editor or directories would open in a text editor, which is a landmine
 * dressed as a comment. And `"*"` meant *anything*, so the editor claimed
 * ownership of PNGs it cannot render.
 *
 * Now: a module states the extensions it handles and, separately, whether it
 * will take unclaimed text as a last resort. Ties break on `priority`, not on
 * the order somebody happened to write the register() calls in. And the user's
 * own choice — set from any "Open With…" menu — beats both.
 */

import { extensionOf } from "./filetypes";
import type { ModuleManifest, VoidModule } from "./types";

/** Where a user's chosen default for one extension is stored. */
export const assocKey = (ext: string) => `assoc.${ext || "_none"}`;

/** The pseudo-extension directories resolve under. */
export const DIR_EXT = "dir";

export interface AssocLookup {
  /** The user's stored default for an extension, if they set one. */
  override(ext: string): string;
}

/**
 * Every module that can open `path`, best first.
 *
 * "Best" means: the user's own choice, then modules that named this exact
 * extension (highest priority first), then anything willing to take unclaimed
 * text. Binary files get no text fallback — offering to open a PNG in a
 * textarea is an offer to show somebody a screenful of replacement characters.
 */
export function handlersFor(
  modules: VoidModule[],
  path: string,
  kind: "file" | "dir",
  lookup?: AssocLookup
): VoidModule[] {
  const ext = kind === "dir" ? DIR_EXT : extensionOf(path);

  const named = modules
    .filter((m) => m.handles?.includes(ext))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  // Only text falls back. A directory that no module claims is not something
  // the editor should be asked to render either.
  const fallbacks =
    kind === "dir" || isBinaryExt(ext)
      ? []
      : modules
          .filter((m) => m.fallback && !named.includes(m))
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  const ordered = [...named, ...fallbacks];

  const chosen = lookup?.override(ext);
  if (!chosen) return ordered;
  const preferred = ordered.find((m) => m.manifest.id === chosen);
  return preferred ? [preferred, ...ordered.filter((m) => m !== preferred)] : ordered;
}

/**
 * Extensions no text app should be offered for.
 *
 * Kept here rather than read from `filetypes` so association can't be broken by
 * a cosmetic edit to a glyph table — the two answer different questions and
 * only overlap on this one fact.
 */
const BINARY = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp",
  "mp3", "wav", "ogg", "flac", "m4a", "mp4", "webm", "mov", "mkv",
  "ttf", "otf", "woff", "woff2", "zip", "tar", "gz", "xz", "7z", "pdf",
  "wasm", "so", "dylib", "dll", "exe", "bin",
]);

export function isBinaryExt(ext: string): boolean {
  return BINARY.has(ext);
}

/** Manifests, for UI that only needs to name the candidates. */
export function manifestsOf(mods: VoidModule[]): ModuleManifest[] {
  return mods.map((m) => m.manifest);
}
