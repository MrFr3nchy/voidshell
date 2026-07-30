import { createHash, randomBytes } from "node:crypto";
import { open, rename, readFile, mkdir } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { emptyDb, emptyWorkspace, type Db, type SessionDoc, type UserDoc, type Workspace } from "./types.js";

/** How long a session cookie stays good. Matches the cookie's Max-Age. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Hex sha256. Used for keys and session tokens alike. */
export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The whole database.
 *
 * Loaded once at boot and served from memory thereafter. Reads are map lookups;
 * writes mutate memory and then persist the entire document. At the scale this
 * thing is built for — one droplet, a handful of dashboards — that is both
 * correct and considerably faster than anything with a query planner. If it
 * ever stops being either, the replacement is SQLite behind this same class.
 */
export class Store {
  private doc: Db = emptyDb();
  private loaded = false;

  /**
   * Serializes persistence. Every write goes through this chain, so two
   * requests landing at once can't interleave their way into a half-written
   * file or lose whichever update finished second.
   */
  private queue: Promise<void> = Promise.resolve();

  /**
   * The write that callers arriving right now will share. Cleared the instant
   * a write begins, so anyone whose mutation lands after that snapshot gets
   * scheduled into the next one rather than being told a stale write covered
   * them.
   */
  private coalesced: Promise<void> | null = null;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<Db>;
      this.doc = {
        version: 1,
        users: parsed.users ?? {},
        sessions: parsed.sessions ?? {},
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // First boot. An empty database is the correct state, not an error.
        this.doc = emptyDb();
      } else {
        // Anything else — corrupt JSON, bad permissions — must not be papered
        // over by silently starting empty and then overwriting the file with
        // nothing. Refusing to boot keeps the damaged copy intact for repair.
        throw new Error(
          `[store] refusing to start: ${this.path} exists but could not be read as a database (${String(err)})`
        );
      }
    }
    this.loaded = true;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("[store] used before load()");
  }

  /* ---------------- reads ---------------- */

  async getUserByKeyHash(hash: string): Promise<UserDoc | null> {
    this.assertLoaded();
    return this.doc.users[hash] ?? null;
  }

  async getUserById(id: string): Promise<UserDoc | null> {
    this.assertLoaded();
    for (const u of Object.values(this.doc.users)) if (u.id === id) return u;
    return null;
  }

  userCount(): number {
    return Object.keys(this.doc.users).length;
  }

  /* ---------------- writes ---------------- */

  async createUser(hash: string): Promise<UserDoc> {
    this.assertLoaded();
    const now = new Date().toISOString();
    const user: UserDoc = {
      id: `usr_${randomBytes(6).toString("hex")}`,
      createdAt: now,
      lastSeenAt: now,
      workspace: emptyWorkspace(),
    };
    this.doc.users[hash] = user;
    await this.persist();
    return user;
  }

  async updateWorkspace(userId: string, ws: Workspace): Promise<void> {
    this.assertLoaded();
    const user = await this.getUserById(userId);
    if (!user) throw new Error(`[store] no such user: ${userId}`);
    user.workspace = ws;
    user.lastSeenAt = new Date().toISOString();
    await this.persist();
  }

  async touchUser(userId: string): Promise<void> {
    this.assertLoaded();
    const user = await this.getUserById(userId);
    if (!user) return;
    user.lastSeenAt = new Date().toISOString();
    await this.persist();
  }

  /* ---------------- sessions ---------------- */

  /** Mints a session and returns the raw token. Only the hash is stored. */
  async createSession(userId: string): Promise<string> {
    this.assertLoaded();
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    this.doc.sessions[sha256(token)] = {
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    };
    await this.persist();
    return token;
  }

  async getSession(tokenHash: string): Promise<SessionDoc | null> {
    this.assertLoaded();
    const s = this.doc.sessions[tokenHash];
    if (!s) return null;
    // An expired record is gone as far as callers are concerned, whether or not
    // the sweep has got to it yet. Checking here rather than trusting the sweep
    // means a session cannot outlive its expiry just because the box was idle.
    if (Date.parse(s.expiresAt) <= Date.now()) return null;
    return s;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.assertLoaded();
    if (!(tokenHash in this.doc.sessions)) return;
    delete this.doc.sessions[tokenHash];
    await this.persist();
  }

  /** Drops expired records. Returns how many went. */
  async sweepExpiredSessions(): Promise<number> {
    this.assertLoaded();
    const now = Date.now();
    let dropped = 0;
    for (const [hash, s] of Object.entries(this.doc.sessions)) {
      if (Date.parse(s.expiresAt) <= now) {
        delete this.doc.sessions[hash];
        dropped++;
      }
    }
    if (dropped) await this.persist();
    return dropped;
  }

  /* ---------------- persistence ---------------- */

  /**
   * Resolves once a snapshot taken at or after this call is durably on disk.
   *
   * Callers that arrive while a write is merely *queued* share it, because
   * their mutation is already in memory and will be caught by that write's
   * snapshot. Callers that arrive once a write has begun get a fresh one.
   */
  private persist(): Promise<void> {
    if (this.coalesced) return this.coalesced;

    const p = this.queue
      // A failed write must not poison the chain: the next attempt should still
      // run, and callers after it should not inherit an old rejection.
      .catch(() => {})
      .then(() => {
        this.coalesced = null;
        return this.writeAtomically();
      });

    this.coalesced = p;
    this.queue = p;
    return p;
  }

  /**
   * Temp file, fsync, rename. A rename within a directory is atomic on POSIX,
   * so a reader either sees the whole previous database or the whole new one —
   * there is no window in which db.json is a truncated fragment. Losing every
   * dashboard to a write interrupted at the wrong moment is not a recoverable
   * class of mistake, and it is entirely avoidable.
   */
  private async writeAtomically(): Promise<void> {
    // Synchronous, and first: this is the snapshot the coalescing above
    // promises callers. Nothing may mutate `doc` between here and the caller
    // that scheduled this write.
    const body = JSON.stringify(this.doc);

    const dir = dirname(this.path);
    const tmp = join(dir, `.${basename(this.path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);

    const fh = await open(tmp, "w", 0o600);
    try {
      await fh.writeFile(body, "utf8");
      // Without this the rename can land while the contents are still in page
      // cache, which on a hard power loss produces an atomically-renamed empty
      // file — the exact failure the rename was supposed to prevent.
      await fh.sync();
    } finally {
      await fh.close();
    }

    await rename(tmp, this.path);

    // The rename itself is metadata, and metadata is buffered too. fsync the
    // directory so the new name survives a crash.
    try {
      const dh = await open(dir, "r");
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // Not every platform lets you open a directory for reading. The rename
      // has already happened; this is the last few percent of durability, not
      // a reason to fail the request.
    }
  }

  /** Waits for all queued writes to settle. For tests and clean shutdown. */
  async drain(): Promise<void> {
    await this.queue.catch(() => {});
  }
}
