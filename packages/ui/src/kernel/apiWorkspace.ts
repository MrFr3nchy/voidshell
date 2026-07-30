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
    res = await fetch(path, {
      // The session cookie is httpOnly, so it is only attached if we ask for
      // credentials. Without this every request is anonymous and every route
      // answers 401 for reasons that look nothing like the cause.
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      ...init,
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

/**
 * Persists a dashboard to the server.
 *
 * Writes are serialized: a save that arrives while one is in flight becomes
 * the next one rather than racing it, so two PUTs can't land out of order and
 * leave the server holding a stale layout.
 */
export class ApiWorkspaceHost implements WorkspaceHost {
  private pending: WorkspaceSnapshot | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private running = false;

  constructor(private readonly onError: (err: unknown) => void = () => {}) {}

  save(snapshot: WorkspaceSnapshot): void {
    this.pending = snapshot;
    void this.pump();
  }

  async flush(): Promise<void> {
    await this.pump();
    await this.inFlight;
  }

  private async pump(): Promise<void> {
    if (this.running) return this.inFlight;
    this.running = true;
    this.inFlight = (async () => {
      try {
        while (this.pending) {
          const snapshot = this.pending;
          this.pending = null;
          await api.putWorkspace(snapshot);
        }
      } catch (err) {
        // The in-memory dashboard is still correct; only the copy on the
        // server is behind. Losing the user's layout to a failed request would
        // be far worse than being out of date for a moment.
        this.onError(err);
      } finally {
        this.running = false;
      }
    })();
    return this.inFlight;
  }
}
