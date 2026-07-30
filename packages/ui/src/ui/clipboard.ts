/**
 * The OS clipboard for filesystem operations.
 *
 * Deliberately holds a *path*, not contents: a cut/copy is resolved at paste
 * time, so pasting a file that changed after being copied yields the current
 * version, matching what every desktop OS does.
 */

export type ClipMode = "copy" | "cut";

export interface ClipItem {
  path: string;
  mode: ClipMode;
}

let item: ClipItem | null = null;
const listeners = new Set<() => void>();

export const clipboard = {
  set(path: string, mode: ClipMode): void {
    item = { path, mode };
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
