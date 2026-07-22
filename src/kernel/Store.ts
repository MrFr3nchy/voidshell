type Sub = (value: unknown) => void;

/**
 * The OS's shared memory. Any module can read/write keys and subscribe to
 * changes. Kept intentionally schema-less: modules namespace their own keys
 * (e.g. "aurora.hue", "chronos.format"). Persistence can be layered on later
 * by mirroring this to localStorage in one place.
 */
export class Store {
  private data = new Map<string, unknown>();
  private subs = new Map<string, Set<Sub>>();

  get<T>(key: string, fallback: T): T {
    return this.data.has(key) ? (this.data.get(key) as T) : fallback;
  }

  set(key: string, value: unknown): void {
    this.data.set(key, value);
    const set = this.subs.get(key);
    if (set) for (const s of [...set]) s(value);
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
}
