import type { NotifyOptions } from "./types";

/**
 * Where a dashboard lives between sessions.
 *
 * This used to be two browser-storage keys, which made persistence a property
 * of the device rather than of the account. The shape below is deliberately the
 * same two blobs — the kernel Store and the home tree — because that is what
 * the OS actually persists; nothing above this file had to learn a new schema.
 */

/**
 * Size of the last snapshot, in bytes, published by the kernel.
 *
 * Ephemeral on purpose: it describes the workspace rather than belonging to
 * it, and persisting a number that changes on every save would mean every save
 * dirties the state that triggers the next one.
 */
export const WORKSPACE_BYTES = "tmp.sys.workspaceBytes";

export interface WorkspaceSnapshot {
  /** Every non-ephemeral key in the kernel Store. */
  state: Record<string, unknown>;
  /** The serialized /home/void tree, or null before anything has been saved. */
  fs: unknown;
}

export interface WorkspaceHost {
  /**
   * Called on every change to persisted state. Implementations are expected to
   * coalesce: the kernel calls this far more often than anything should hit a
   * network.
   */
  save(snapshot: WorkspaceSnapshot): void;

  /**
   * Persist anything still pending, and resolve when it has landed. Used at
   * the points where "later" isn't available — signout, tab hidden, unload.
   */
  flush(): Promise<void>;
}

/**
 * What the *shell* needs from a host, on top of what the kernel needs.
 *
 * The kernel only ever calls `save` and `flush`, and deliberately knows
 * nothing else. `main.ts` calls two more — it hands the host real toasts once
 * there is a toast system, and it takes one last shot at persisting from
 * `beforeunload` — so the thing it holds is this, not `WorkspaceHost`. Stated
 * as an interface so a second implementation is a type error away from being
 * complete rather than a runtime error away.
 */
export interface ShellHost extends WorkspaceHost {
  /** Swapped in once the kernel exists and notices can actually be shown. */
  setNotifier(
    notify: (message: string, opts: "warn" | "good" | NotifyOptions) => void
  ): void;
  /** Best effort from `beforeunload`, which cannot await anything. */
  flushOnUnload(): void;
}

/**
 * A host that keeps a dashboard for exactly as long as the page is open.
 *
 * The default, so a kernel constructed without one — the smoke harness, or a
 * boot that hasn't reached the server yet — behaves sanely instead of throwing
 * on every keystroke.
 */
export class MemoryWorkspaceHost implements WorkspaceHost {
  latest: WorkspaceSnapshot = { state: {}, fs: null };

  save(snapshot: WorkspaceSnapshot): void {
    this.latest = snapshot;
  }

  async flush(): Promise<void> {}
}
