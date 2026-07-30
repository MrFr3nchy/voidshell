import type { FastifyInstance } from "fastify";
import { requireUser } from "./auth.js";
import type { Store } from "./store.js";
import type { Workspace } from "./types.js";

/**
 * A dashboard is whatever the client says it is, within limits.
 *
 * The server deliberately has no schema for panels, constellations or module
 * state — those change every time a module ships, and a server that had to be
 * redeployed to accept a new setting would be a permanent tax on the client.
 * What it does enforce is shape and size, because those are the properties
 * that protect the *other* users of the box.
 */

/** Matches the Fastify bodyLimit. Anything larger is refused before parsing. */
export const MAX_WORKSPACE_BYTES = 512 * 1024;

/**
 * How deep a workspace may nest.
 *
 * The VFS tree is genuinely nested, so a flat limit won't do — but unbounded
 * nesting is a stack overflow in JSON.stringify during the next write, which
 * would take the process down while holding the write queue.
 */
const MAX_DEPTH = 64;

export type ValidationError = { ok: false; reason: string };
export type ValidationOk = { ok: true; workspace: Workspace };

export function validateWorkspace(body: unknown): ValidationOk | ValidationError {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "workspace must be an object" };
  }

  const { state, fs } = body as { state?: unknown; fs?: unknown };

  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    return { ok: false, reason: "workspace.state must be an object" };
  }

  // `fs` is the serialized home tree, or null before the client has saved one.
  if (fs !== null && (typeof fs !== "object" || Array.isArray(fs))) {
    return { ok: false, reason: "workspace.fs must be an object or null" };
  }

  const depth = depthOf(body, MAX_DEPTH);
  if (depth > MAX_DEPTH) {
    return { ok: false, reason: `workspace nests deeper than ${MAX_DEPTH} levels` };
  }

  // Only the two known fields are kept. An unrecognised key is dropped rather
  // than rejected — a client from a newer deploy shouldn't fail outright — but
  // it also isn't stored, so nobody can use a dashboard as free object storage.
  return { ok: true, workspace: { state: state as Record<string, unknown>, fs } };
}

/** Iterative, so measuring the depth can't itself overflow the stack. */
function depthOf(root: unknown, limit: number): number {
  let deepest = 0;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > deepest) deepest = depth;
    if (depth > limit) return depth;
    if (typeof node !== "object" || node === null) continue;
    for (const value of Object.values(node as Record<string, unknown>)) {
      stack.push({ node: value, depth: depth + 1 });
    }
  }
  return deepest;
}

export function registerWorkspace(app: FastifyInstance, store: Store): void {
  /**
   * Replaces the workspace wholesale.
   *
   * A replace rather than a merge, because the client is the authority on what
   * its own dashboard contains — a merge would make deleting a panel or a
   * setting impossible to express.
   */
  app.put("/api/workspace", async (req, reply) => {
    const user = await requireUser(store, req, reply);
    if (!user) return reply; // requireUser already answered 401

    const result = validateWorkspace(req.body);
    if (!result.ok) return reply.code(400).send({ error: result.reason });

    // The user id comes from the session, never from the request. A
    // client-supplied id would be the only thing standing between one
    // dashboard and all of them.
    await store.updateWorkspace(user.id, result.workspace);
    return reply.send({ ok: true });
  });
}
