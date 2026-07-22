import type { KernelEvent } from "./types";

type Handler = (e: KernelEvent) => void;

/**
 * Dead-simple pub/sub. Modules never import each other; they shout into this
 * bus and listen for what they care about. That decoupling is what lets you
 * yank any module out without the rest noticing.
 */
export class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  emit(type: string, payload?: unknown): void {
    const set = this.handlers.get(type);
    if (!set) return;
    // Copy so a handler that unsubscribes mid-emit doesn't corrupt iteration.
    for (const h of [...set]) h({ type, payload });
  }

  on(type: string, handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }
}
