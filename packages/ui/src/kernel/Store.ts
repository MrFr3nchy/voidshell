type Sub = (value: unknown) => void;

const DISK_KEY = "voidshell:state";
/** Keys under this namespace are scratch: they never touch disk. */
const EPHEMERAL = "tmp.";

/**
 * The OS's shared memory. Any module can read/write keys and subscribe to
 * changes. Kept intentionally schema-less: modules namespace their own keys
 * (e.g. "aurora.hue", "chronos.format").
 *
 * Everything except the `tmp.` namespace is mirrored to localStorage on a
 * short debounce, which is the entire persistence story for the OS — settings,
 * launcher bindings, saved dashboards and notes all ride on it for free.
 */
export class Store {
  private data = new Map<string, unknown>();
  private subs = new Map<string, Set<Sub>>();
  private flushTimer = 0;

  constructor() {
    this.load();
  }

  get<T>(key: string, fallback: T): T {
    return this.data.has(key) ? (this.data.get(key) as T) : fallback;
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
    const set = this.subs.get(key);
    if (set) for (const s of [...set]) s(value);
    if (!key.startsWith(EPHEMERAL)) this.scheduleFlush();
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

  /** Nuke persisted state. The "factory reset" behind the Settings button. */
  wipe(): void {
    this.data.clear();
    try {
      localStorage.removeItem(DISK_KEY);
    } catch {
      /* storage unavailable — nothing to wipe */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(DISK_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) this.data.set(k, v);
    } catch (err) {
      // A corrupt blob must never stop the OS from booting.
      console.warn("[store] could not restore state:", err);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = 0;
      this.flush();
    }, 240);
  }

  private flush(): void {
    try {
      const out: Record<string, unknown> = {};
      for (const [k, v] of this.data) {
        if (k.startsWith(EPHEMERAL)) continue;
        out[k] = v;
      }
      localStorage.setItem(DISK_KEY, JSON.stringify(out));
    } catch (err) {
      console.warn("[store] could not persist state:", err);
    }
  }
}
