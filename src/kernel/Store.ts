type Sub = (value: unknown) => void;

const PERSIST_KEY = "voidshell:state";
/** Keys under these namespaces survive a reload. Everything else is ephemeral. */
const PERSIST_PREFIXES = ["settings.", "launcher.", "aurora.", "vista.", "session."];

/**
 * The OS's shared memory. Any module can read/write keys and subscribe to
 * changes. Kept intentionally schema-less: modules namespace their own keys
 * (e.g. "aurora.preset", "launcher.slots").
 *
 * Durable namespaces are mirrored to localStorage so your settings, launcher
 * layout and saved vistas survive a reload. Runtime junk (open window ids,
 * transient UI state) deliberately does not persist.
 */
export class Store {
  private data = new Map<string, unknown>();
  private subs = new Map<string, Set<Sub>>();
  private flushHandle = 0;

  constructor() {
    this.hydrate();
  }

  get<T>(key: string, fallback: T): T {
    return this.data.has(key) ? (this.data.get(key) as T) : fallback;
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
    const set = this.subs.get(key);
    if (set) for (const s of [...set]) s(value);
    if (this.isDurable(key)) this.scheduleFlush();
  }

  subscribe(key: string, handler: Sub): () => void {
    let set = this.subs.get(key);
    if (!set) {
      set = new Set();
      this.subs.set(key, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Wipe persisted state. Used by Settings' "reset everything". */
  clearPersisted(): void {
    for (const key of [...this.data.keys()]) {
      if (this.isDurable(key)) this.data.delete(key);
    }
    try {
      localStorage.removeItem(PERSIST_KEY);
    } catch {
      /* storage unavailable; nothing to clear */
    }
  }

  private isDurable(key: string): boolean {
    return PERSIST_PREFIXES.some((p) => key.startsWith(p));
  }

  private hydrate(): void {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (this.isDurable(k)) this.data.set(k, v);
      }
    } catch {
      // Corrupt or unavailable storage should never stop the OS from booting.
    }
  }

  /** Coalesce rapid writes (slider drags) into one storage hit per frame-ish. */
  private scheduleFlush(): void {
    if (this.flushHandle) return;
    this.flushHandle = window.setTimeout(() => {
      this.flushHandle = 0;
      const out: Record<string, unknown> = {};
      for (const [k, v] of this.data) if (this.isDurable(k)) out[k] = v;
      try {
        localStorage.setItem(PERSIST_KEY, JSON.stringify(out));
      } catch {
        /* quota or privacy mode; settings just won't persist */
      }
    }, 120);
  }
}
