import type { WorkspaceHost, WorkspaceSnapshot } from "./persistence";

/**
 * The client half of the workspace API.
 *
 * Kept deliberately thin. Coalescing, retry and the flush points that matter
 * (signout, hidden tab, unload) are layered on top of this in a later change;
 * what lives here is the wire format and nothing else.
 */

export interface SessionResponse {
  user: { id: string; createdAt: string; lastSeenAt: string };
  workspace: WorkspaceSnapshot;
}

/** Distinguishes "no session" from "no server", which need different answers. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when the request never got an answer at all. */
  get offline(): boolean {
    return this.status === null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    // Only declared when there is something to declare. `content-type:
    // application/json` on a bodyless POST — signup and signout — is a promise
    // of JSON that isn't there, and a strict server is right to refuse it.
    const headers: Record<string, string> =
      init?.body === undefined ? {} : { "content-type": "application/json" };

    res = await fetch(path, {
      // The session cookie is httpOnly, so it is only attached if we ask for
      // credentials. Without this every request is anonymous and every route
      // answers 401 for reasons that look nothing like the cause.
      credentials: "same-origin",
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    });
  } catch (err) {
    throw new ApiError(err instanceof Error ? err.message : "network error", null);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? res.statusText, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  session: () => request<SessionResponse>("/api/session"),

  signup: () =>
    request<{ key: string; user: SessionResponse["user"] }>("/api/auth/signup", {
      method: "POST",
    }),

  signin: (key: string) =>
    request<{ user: SessionResponse["user"] }>("/api/auth/signin", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),

  signout: () => request<{ ok: true }>("/api/auth/signout", { method: "POST" }),

  putWorkspace: (workspace: WorkspaceSnapshot) =>
    request<{ ok: true }>("/api/workspace", {
      method: "PUT",
      body: JSON.stringify(workspace),
    }),
};

/** Quiet period after the last change before anything hits the network. */
const DEBOUNCE_MS = 1000;

/**
 * Longest a change may sit unsaved, however busy the shell is.
 *
 * A trailing debounce alone can starve forever: the session heartbeat writes
 * every 15 seconds, so any continuous activity keeps resetting the timer and
 * nothing is ever persisted. This bounds the worst case at half a minute
 * while still leaving a ten-second drag to settle into a single request.
 */
const MAX_WAIT_MS = 30_000;

/** Backoff between retries, in ms. The last value repeats. */
const BACKOFF_MS = [1_000, 3_000, 8_000, 20_000];

/**
 * Persists a dashboard to the server.
 *
 * localStorage writes were free and synchronous. These are neither, so the
 * shape here is different in three ways that all matter: changes are debounced
 * into one request, requests never overlap, and a failed request never costs
 * the user their layout — the in-memory dashboard stays authoritative and the
 * write is retried.
 */
export class ApiWorkspaceHost implements WorkspaceHost {
  private pending: WorkspaceSnapshot | null = null;
  private timer = 0;
  /** When the oldest unsaved change arrived, for the max-wait ceiling. */
  private oldest = 0;
  private inFlight: Promise<void> | null = null;
  private attempt = 0;
  /** So a flapping connection doesn't produce a toast per retry. */
  private warned = false;

  constructor(private notify: (message: string, kind: "warn" | "good") => void = () => {}) {}

  /** Swapped in once the kernel exists and there is a toast system to use. */
  setNotifier(notify: (message: string, kind: "warn" | "good") => void): void {
    this.notify = notify;
  }

  save(snapshot: WorkspaceSnapshot): void {
    this.pending = snapshot;
    if (!this.oldest) this.oldest = Date.now();

    const waited = Date.now() - this.oldest;
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - waited));

    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.send(), delay);
  }

  /** Send now and wait for it. Signout, hidden tab, anything that can await. */
  async flush(): Promise<void> {
    window.clearTimeout(this.timer);
    await this.send();
  }

  /**
   * Best effort for `beforeunload`, which cannot await anything.
   *
   * `keepalive` lets the request outlive the document. It is capped at 64KB by
   * the spec, so a large dashboard falls back to a normal request that will
   * probably be cancelled — which is why visibilitychange carries the real
   * weight and this is only the last line of defence.
   */
  flushOnUnload(): void {
    if (!this.pending) return;
    const body = JSON.stringify(this.pending);
    this.pending = null;
    window.clearTimeout(this.timer);
    try {
      void fetch("/api/workspace", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body,
        keepalive: body.length < 60_000,
      });
    } catch {
      // Nothing useful to do here — the page is going away.
    }
  }

  /** True when there is unsaved work. Exposed for tests and diagnostics. */
  get dirty(): boolean {
    return this.pending !== null;
  }

  private send(): Promise<void> {
    // Never two at once: overlapping PUTs can land out of order and leave the
    // server holding a layout the user already moved on from.
    if (this.inFlight) return this.inFlight;
    if (!this.pending) return Promise.resolve();

    this.inFlight = (async () => {
      while (this.pending) {
        const snapshot = this.pending;
        this.pending = null;
        try {
          await api.putWorkspace(snapshot);
          this.oldest = 0;
          this.attempt = 0;
          if (this.warned) {
            this.warned = false;
            this.notify("reconnected \u2014 your layout is saved", "good");
          }
        } catch (err) {
          // The in-memory dashboard is still correct; only the server's copy
          // is behind. Discarding the snapshot here would turn a network blip
          // into lost work, which is the one outcome worth avoiding entirely.
          if (this.pending === null) this.pending = snapshot;

          if (!this.warned) {
            this.warned = true;
            this.notify(
              err instanceof ApiError && err.status === 401
                ? "signed out elsewhere \u2014 your layout is not being saved"
                : "can't reach the server \u2014 your layout is safe here but not saved",
              "warn"
            );
          }

          const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
          this.attempt++;
          window.clearTimeout(this.timer);
          this.timer = window.setTimeout(() => void this.send(), wait);
          break;
        }
      }
      this.inFlight = null;
    })();

    return this.inFlight;
  }
}
