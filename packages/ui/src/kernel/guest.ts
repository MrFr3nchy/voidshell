import { MemoryWorkspaceHost } from "./persistence";
import type { NotifyOptions } from "./types";

/**
 * A session with nothing behind it.
 *
 * Every route into the shell currently ends at an account: the client alone
 * gets a lock screen and a void it will not open, so the first thing a new
 * person is asked to do is create a credential to find out what they are
 * creating it for. That is a strange trade to offer for software whose entire
 * argument is visual, and it is the reason the project cannot be linked to.
 *
 * A guest session is the same kernel, the same compositor and the same
 * nineteen modules over a workspace that lives in the tab and dies with it.
 * Nothing is faked and nothing is a screenshot — the only difference from a
 * real session is where the snapshot goes.
 *
 * ## Why it isn't written down anywhere
 *
 * `localStorage` would survive a reload and is banned in the client for a
 * reason worth keeping: a dashboard that lives in the browser is a dashboard
 * that doesn't follow the account. Rather than carve an exception into that
 * rule for the one case that would be nice to have, a guest session is honest
 * about being a guest session, and says so on the way in.
 */

/**
 * Set while the shell is running without an account.
 *
 * `tmp.` so it is never persisted: it describes *this session*, not the
 * workspace, and a saved copy would follow a snapshot into a real account and
 * tell it that it wasn't one.
 */
export const GUEST_KEY = "tmp.sys.guest";

/**
 * Keeps a dashboard for exactly as long as the tab is open.
 *
 * `MemoryWorkspaceHost` already does the storage half of this. What it lacks
 * is the two methods the shell calls on whatever host it was given — a
 * notifier it can upgrade once toasts exist, and the last-ditch unload flush —
 * both of which are meaningless with no server and are therefore no-ops rather
 * than a branch at each call site.
 */
export class GuestWorkspaceHost extends MemoryWorkspaceHost {
  setNotifier(_notify: (message: string, opts: "warn" | "good" | NotifyOptions) => void): void {}

  flushOnUnload(): void {}
}
