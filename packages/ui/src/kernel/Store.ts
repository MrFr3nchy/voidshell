type Sub = (value: unknown) => void;

/** Keys under this namespace are scratch: they are never persisted. */
const EPHEMERAL = "tmp.";

/**
 * The OS's shared memory. Any module can read/write keys and subscribe to
 * changes. Kept intentionally schema-less: modules namespace their own keys
 * (e.g. "aurora.hue", "chronos.format").
 *
 * Everything except the `tmp.` namespace is part of the persisted workspace,
 * which is the entire persistence story for the OS — settings, launcher
 * bindings, saved dashboards and notes all ride on it for free. The Store
 * itself neither knows nor cares where that goes; it just says when it
 * changed. The kernel owns the answer.
 */
export class Store {
  private data = new Map<string, unknown>();
  private subs = new Map<string, Set<Sub>>();
  private dirty: (() => void) | null = null;

  /** Told when any persisted key changes. The kernel wires this to the host. */
  onChange(handler: () => void): void {
    this.dirty = handler;
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
    if (!key.startsWith(EPHEMERAL)) this.dirty?.();
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
    this.dirty?.();
  }

  /**
   * Load a workspace in. Called once at boot, before any module activates, so
   * defineSetting() sees the user's values rather than overwriting them with
   * defaults.
   */
  hydrate(state: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(state)) {
      if (!k.startsWith(EPHEMERAL)) this.data.set(k, v);
    }
  }

  /** Everything worth persisting, as a plain object. */
  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of this.data) {
      if (k.startsWith(EPHEMERAL)) continue;
      out[k] = v;
    }
    return out;
  }
}
