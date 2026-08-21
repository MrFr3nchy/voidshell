import type { WorkspaceSnapshot } from "./persistence";

/**
 * A void in a file.
 *
 * Guest sessions made this necessary rather than merely nice. A guest gets the
 * whole shell over a workspace that lives in the tab — which is honest, and
 * which means anybody who opens the demo, arranges something they like and
 * writes a few notes loses all of it on close, with nothing they could have
 * done about it. Browser storage is banned in the client for a good reason and
 * this is not an argument for an exception: a file is *better* than
 * localStorage here, because a file can be moved to another machine, kept in a
 * repository, or handed to somebody else.
 *
 * It is the same two blobs the server holds — the kernel Store and the home
 * tree — wrapped in enough envelope to recognise later. Deliberately the same
 * shape rather than a new export schema, so an exported file and a stored
 * dashboard can never drift apart.
 *
 * ## On validating it
 *
 * Everything below is about telling somebody *why* their file was refused. An
 * import replaces an entire workspace, so it is the one operation where "that
 * didn't work" is an unacceptable answer — the person is holding the only copy
 * of something and has just been told nothing about it. Every rejection names
 * what was expected and what arrived.
 */

/**
 * Bumped only when an old file can no longer be read correctly.
 *
 * Adding a key to the Store does not qualify: `hydrate` merges, so a file
 * written before that key existed restores exactly as well as it ever did.
 */
export const WORKSPACE_FILE_VERSION = 1;

export interface WorkspaceFile {
  /** Present, and equal to the version, on anything this can read. */
  voidshell: number;
  exportedAt: string;
  workspace: WorkspaceSnapshot;
}

/** Refused, with a sentence a person can act on. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

/** Rough weight of a workspace, for telling somebody what they are about to replace. */
export interface WorkspaceSummary {
  settings: number;
  files: number;
  dirs: number;
  bytes: number;
}

export function summarise(snapshot: WorkspaceSnapshot): WorkspaceSummary {
  const out: WorkspaceSummary = {
    settings: Object.keys(snapshot.state ?? {}).length,
    files: 0,
    dirs: 0,
    bytes: 0,
  };
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { k?: string; c?: string; ch?: unknown[] };
    if (n.k === "f") {
      out.files++;
      out.bytes += (n.c ?? "").length;
      return;
    }
    out.dirs++;
    for (const child of n.ch ?? []) walk(child);
  };
  walk(snapshot.fs);
  // The home directory itself is not a directory anybody put there.
  if (out.dirs > 0) out.dirs--;
  return out;
}

export function serialiseWorkspace(snapshot: WorkspaceSnapshot): string {
  const file: WorkspaceFile = {
    voidshell: WORKSPACE_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    workspace: snapshot,
  };
  // Indented: this is a file a person may open, diff, or keep in a repository,
  // and the saving from minifying it is nothing next to being able to read it.
  return JSON.stringify(file, null, 2);
}

/** A filename that sorts by date and says what it is. */
export function workspaceFilename(now = new Date()): string {
  const d = now.toISOString().slice(0, 10);
  const t = now.toISOString().slice(11, 16).replace(":", "");
  return `voidshell-${d}-${t}.json`;
}

/**
 * Read a file back, or throw an `ImportError` saying why not.
 *
 * The checks are ordered by how likely the mistake is, so the first thing a
 * person is told is the thing that most often went wrong: they picked the
 * wrong file.
 */
export function parseWorkspaceFile(text: string): WorkspaceFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImportError(
      "That file isn't JSON. A workspace export is a .json file — check you " +
        "picked the right one."
    );
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ImportError("That file is JSON, but not an object — it can't be a workspace.");
  }

  const file = raw as Partial<WorkspaceFile>;

  if (typeof file.voidshell !== "number") {
    // The most common wrong file is somebody's package.json, so say what is
    // missing rather than "invalid format".
    throw new ImportError(
      "That doesn't look like a voidshell export — it has no “voidshell” " +
        "version field. Exported files start with { “voidshell”: 1, … }."
    );
  }

  if (file.voidshell > WORKSPACE_FILE_VERSION) {
    throw new ImportError(
      `That file was written by a newer voidshell (format ${file.voidshell}, ` +
        `this one reads ${WORKSPACE_FILE_VERSION}). Update the shell, or export ` +
        `again from the version that made it.`
    );
  }

  const ws = file.workspace;
  if (!ws || typeof ws !== "object" || Array.isArray(ws)) {
    throw new ImportError("That export has no workspace in it. It may have been truncated.");
  }

  // `state` must be an object. An array would hydrate into nonsense keys and
  // present much later as settings that will not stick.
  if (ws.state !== undefined && (typeof ws.state !== "object" || ws.state === null || Array.isArray(ws.state))) {
    throw new ImportError("That export's settings block is the wrong shape.");
  }

  // `fs` is allowed to be null — that is what a workspace with nothing saved
  // in it looks like, and refusing one would refuse a legitimate export.
  if (ws.fs !== undefined && ws.fs !== null) {
    if (typeof ws.fs !== "object" || Array.isArray(ws.fs)) {
      throw new ImportError("That export's file tree is the wrong shape.");
    }
    const root = ws.fs as { k?: unknown; n?: unknown };
    if (root.k !== "d") {
      throw new ImportError(
        "That export's file tree does not start at a directory, so it can't be a home folder."
      );
    }
  }

  return {
    voidshell: file.voidshell,
    exportedAt: typeof file.exportedAt === "string" ? file.exportedAt : "",
    workspace: { state: (ws.state as Record<string, unknown>) ?? {}, fs: ws.fs ?? null },
  };
}
