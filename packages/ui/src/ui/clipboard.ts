/**
 * The OS clipboard for filesystem operations.
 *
 * Deliberately holds *paths*, not contents: a cut/copy is resolved at paste
 * time, so pasting a file that changed after being copied yields the current
 * version, matching what every desktop OS does.
 *
 * It holds a list rather than a single path because the file manager can select
 * more than one thing now. `path` remains as the first item, so every caller
 * that only ever means "the one file" still reads naturally.
 */

export type ClipMode = "copy" | "cut";

export interface ClipItem {
  /** Everything on the clipboard, in the order it was picked up. */
  paths: string[];
  /** The first path. What single-item callers mean when they say "the file". */
  path: string;
  mode: ClipMode;
}

let item: ClipItem | null = null;
const listeners = new Set<() => void>();

export const clipboard = {
  set(paths: string | string[], mode: ClipMode): void {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
    item = list.length ? { paths: list, path: list[0], mode } : null;
    listeners.forEach((l) => l());
  },
  get(): ClipItem | null {
    return item;
  },
  clear(): void {
    item = null;
    listeners.forEach((l) => l());
  },
  onChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
