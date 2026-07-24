/**
 * The system journal.
 *
 * An OS that forgets what just happened doesn't feel like an OS. Toasts vanish
 * after three seconds, `console.log` goes to the browser's devtools where the
 * shell can't reach it, and neither leaves anything you can grep. This is the
 * one place the system writes down what it did.
 *
 * It's a fixed-size ring rather than an ever-growing array because this runs
 * for the whole session and a chatty module must not be able to exhaust memory.
 * Everything here is readable from the shell as /var/log/system.log, which is
 * the actual point: the log is a file, so `tail`, `grep` and `wc` already work
 * on it and no log-specific tooling had to be invented.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** Milliseconds since the kernel booted — a log is about relative time. */
  t: number;
  level: LogLevel;
  /** Who spoke: "kernel", "vfs", a module id. */
  tag: string;
  msg: string;
}

const CAPACITY = 600;

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Journal {
  private entries: LogEntry[] = [];
  private listeners = new Set<(e: LogEntry) => void>();
  readonly bootedAt = Date.now();

  /** Milliseconds the system has been up. */
  uptime(): number {
    return Date.now() - this.bootedAt;
  }

  write(tag: string, msg: string, level: LogLevel = "info"): void {
    const entry: LogEntry = { t: this.uptime(), level, tag, msg };
    this.entries.push(entry);
    // Drop from the front once full. Splice rather than shift-per-write so a
    // burst costs one copy instead of one per entry.
    if (this.entries.length > CAPACITY) {
      this.entries.splice(0, this.entries.length - CAPACITY);
    }
    for (const l of this.listeners) l(entry);
  }

  /** Everything held, oldest first. Optionally filtered by minimum level. */
  read(minLevel: LogLevel = "debug"): LogEntry[] {
    const floor = LEVEL_ORDER[minLevel];
    return this.entries.filter((e) => LEVEL_ORDER[e.level] >= floor);
  }

  /** Subscribe to new entries as they land. Returns an unsubscriber. */
  onWrite(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  clear(): void {
    this.entries = [];
  }

  /**
   * The journal rendered the way `dmesg` renders it: a bracketed uptime stamp,
   * the level, the tag, then the message. This is what /var/log/system.log
   * serves, so the shell's text tools operate on exactly what you see.
   */
  format(minLevel: LogLevel = "debug"): string {
    return this.read(minLevel)
      .map((e) => {
        const secs = (e.t / 1000).toFixed(3).padStart(10);
        return `[${secs}] ${e.level.padEnd(5)} ${e.tag.padEnd(10)} ${e.msg}`;
      })
      .join("\n");
  }
}
