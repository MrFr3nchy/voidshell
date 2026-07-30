/**
 * The shapes on disk.
 *
 * `db.json` is deliberately shaped like a Mongo collection rather than a set of
 * relational tables, so the day it stops being a JSON file the change is
 * confined to store.ts and nothing above it has to move.
 */

/**
 * Everything a dashboard is, from the server's point of view.
 *
 * This is intentionally not a schema of panels and constellations. The client
 * already funnels all of its persistence through exactly two places — the
 * kernel Store, which holds settings, the saved session, launcher bindings and
 * every module's own namespaced keys, and the VFS home tree. Mirroring those
 * two is the whole job. Giving the server opinions about panel geometry would
 * mean a translation layer on both ends that neither side needs.
 */
export interface Workspace {
  /** The kernel Store's persisted keys, minus its ephemeral `tmp.` namespace. */
  state: Record<string, unknown>;
  /** The serialized `/home/void` tree. Null until the client first saves one. */
  fs: unknown;
}

export interface UserDoc {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  workspace: Workspace;
}

export interface SessionDoc {
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface Db {
  version: 1;
  /**
   * Keyed by sha256(key) hex. The key itself is never written down — the hash
   * *is* the lookup, so signin is a single map read and there is no plaintext
   * on disk to leak.
   */
  users: Record<string, UserDoc>;
  /** Keyed by sha256(sessionToken) hex, for the same reason. */
  sessions: Record<string, SessionDoc>;
}

export function emptyWorkspace(): Workspace {
  return { state: {}, fs: null };
}

export function emptyDb(): Db {
  return { version: 1, users: {}, sessions: {} };
}
