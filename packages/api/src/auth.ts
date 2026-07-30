import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { generateKey, looksLikeKey, normalizeKey } from "./keys.js";
import { sha256, SESSION_TTL_MS, type Store } from "./store.js";
import type { UserDoc } from "./types.js";

export const COOKIE = "voidshell_session";

/**
 * Secure is dropped outside production so the dev server works over plain
 * http. Everywhere it matters, nginx/Caddy terminates TLS and this is set.
 */
const production = process.env.NODE_ENV === "production";

const cookieOptions = {
  httpOnly: true,
  secure: production,
  sameSite: "strict" as const,
  path: "/",
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
};

/**
 * Every signin takes at least this long, hit or miss.
 *
 * A hit mints a session and writes it to disk; a miss returns immediately off
 * a map lookup. That difference is measurable, and it turns the endpoint into
 * an oracle that answers "does this key exist" far faster than the rate limit
 * allows guessing. Holding the floor costs a valid user a fifth of a second
 * once per month.
 */
const SIGNIN_FLOOR_MS = 220;

/**
 * Holds until `ms` have passed since `started`.
 *
 * This has to happen before anything is sent. `reply.send()` dispatches the
 * response immediately, so padding *after* a send — including in a `finally`
 * that the handler's promise still awaits — delays only the handler, not the
 * bytes on the wire, and normalizes nothing.
 */
async function holdFloor(started: number): Promise<void> {
  const remaining = SIGNIN_FLOOR_MS - (Date.now() - started);
  if (remaining > 0) await sleep(remaining);
}

/** What the client is told about itself. Never includes anything secret. */
function profile(user: UserDoc) {
  return { id: user.id, createdAt: user.createdAt, lastSeenAt: user.lastSeenAt };
}

/**
 * Resolves the session on every request, from the cookie alone.
 *
 * There is deliberately no way for a caller to name the user it wants to be.
 * A client-supplied id would be the only thing standing between one dashboard
 * and all of them.
 */
export async function resolveUser(
  store: Store,
  req: FastifyRequest
): Promise<UserDoc | null> {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const session = await store.getSession(sha256(token));
  if (!session) return null;
  return store.getUserById(session.userId);
}

export async function requireUser(
  store: Store,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<UserDoc | null> {
  const user = await resolveUser(store, req);
  if (!user) {
    // Clear a cookie that no longer resolves, so a client holding a swept or
    // signed-out token stops presenting it on every subsequent request.
    reply.clearCookie(COOKIE, { path: "/" });
    await reply.code(401).send({ error: "not signed in" });
    return null;
  }
  return user;
}

export function registerAuth(app: FastifyInstance, store: Store): void {
  /**
   * Creates a dashboard and returns the key exactly once.
   *
   * This response body is the only time the plaintext key exists anywhere
   * outside the user's own screen. The server stores sha256(key) and keeps no
   * copy — which is what makes "lost key means lost dashboard" a true
   * statement about the system rather than a policy someone could reverse.
   */
  app.post("/api/auth/signup", async (req, reply) => {
    const key = generateKey();
    const user = await store.createUser(sha256(key));
    const token = await store.createSession(user.id);

    req.log.info({ userId: user.id }, "dashboard created");
    return reply.setCookie(COOKIE, token, cookieOptions).code(201).send({
      key,
      user: profile(user),
      warning:
        "Save this key now. It is your only credential, it cannot be recovered, " +
        "and anyone who has it has your dashboard.",
    });
  });

  app.post<{ Body: { key?: unknown } }>(
    "/api/auth/signin",
    {
      // Without this a 44-bit key is a suggestion. Ten tries per quarter hour
      // puts an exhaustive search past the heat death of the relevant droplet.
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    },
    async (req, reply) => {
      const started = Date.now();

      // All of the work happens first and decides only what to send. Nothing
      // touches `reply` until after the floor, so a hit and a miss are
      // indistinguishable from the outside.
      const submitted = req.body?.key;
      const user =
        typeof submitted === "string" && looksLikeKey(submitted)
          ? await store.getUserByKeyHash(sha256(normalizeKey(submitted)))
          : null;

      if (!user) {
        req.log.warn({ ip: req.ip }, "failed signin");
        await holdFloor(started);
        // A malformed key and a well-formed wrong one get the same answer:
        // whether a guess parsed is not information worth handing back.
        return reply.code(401).send({ error: "that key doesn't match a dashboard" });
      }

      const token = await store.createSession(user.id);
      await store.touchUser(user.id);
      req.log.info({ userId: user.id }, "signed in");
      await holdFloor(started);
      return reply.setCookie(COOKIE, token, cookieOptions).send({ user: profile(user) });
    }
  );

  /**
   * Signout deletes the session record. Clearing the cookie alone would leave
   * a token that still works for thirty days to anyone who captured it.
   */
  app.post("/api/auth/signout", async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await store.deleteSession(sha256(token));
    return reply.clearCookie(COOKIE, { path: "/" }).send({ ok: true });
  });

  app.get("/api/session", async (req, reply) => {
    const user = await resolveUser(store, req);
    if (!user) {
      reply.clearCookie(COOKIE, { path: "/" });
      return reply.code(401).send({ error: "not signed in" });
    }
    return reply.send({ user: profile(user), workspace: user.workspace });
  });
}
