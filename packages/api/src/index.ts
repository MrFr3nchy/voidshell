import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { Store } from "./store.js";
import { registerAuth } from "./auth.js";
import { registerWorkspace, MAX_WORKSPACE_BYTES } from "./workspace.js";
import { registerStonks } from "./stonks.js";
import { registerPrices } from "./prices.js";

/**
 * The voidshell API.
 *
 * Binds loopback only. In production nothing reaches it except through the
 * reverse proxy, which is what lets the routes below assume TLS terminated
 * upstream and skip a layer of their own.
 */

const DB_PATH = process.env.VOIDSHELL_DB ?? "/var/lib/voidshell/db.json";

/** Expired sessions are swept at boot and then on this interval. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export async function build(dbPath = DB_PATH) {
  const store = new Store(dbPath);
  await store.load();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      // The proxy is the only thing that ever talks to us directly, so its
      // address is noise; X-Real-IP is the address that means anything.
      redact: ["req.headers.cookie"],
    },
    // Behind a reverse proxy, so trust the forwarded client address. Rate
    // limiting keys off it, and without this every request looks like 127.0.0.1
    // and the whole internet shares one bucket.
    trustProxy: true,
    // Refused before parsing, so an oversized dashboard costs a header read
    // rather than half a megabyte of JSON.parse.
    bodyLimit: MAX_WORKSPACE_BYTES,
  });

  /**
   * An empty body with a JSON content-type is not an error.
   *
   * Fastify's default parser rejects that combination outright, and browsers
   * produce it constantly: a bodyless POST — signup, signout — through any
   * fetch wrapper that sets the header once for every request. The client no
   * longer sends it, but a server that 400s on `curl -X POST -H
   * 'content-type: application/json'` is refusing something entirely
   * reasonable, and the failure reads as "signup is broken" rather than as a
   * header problem.
   *
   * The body limit is enforced on the raw stream before this runs, so the
   * 512KB cap is unaffected.
   */
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "") return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      const err = new Error("body is not valid JSON") as Error & { statusCode?: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  await app.register(cookie);
  // Registered globally but off by default, so only the routes that opt in are
  // limited. A global cap would throttle workspace saves, which are frequent
  // and legitimate.
  await app.register(rateLimit, { global: false });

  app.get("/api/health", async () => ({ ok: true, users: store.userCount() }));

  registerAuth(app, store);
  registerWorkspace(app, store);
  registerStonks(app, store);
  registerPrices(app, store);

  const swept = await store.sweepExpiredSessions();
  if (swept) app.log.info(`swept ${swept} expired session(s) at boot`);

  const sweep = setInterval(() => {
    store.sweepExpiredSessions().then(
      (n) => n && app.log.info(`swept ${n} expired session(s)`),
      (err) => app.log.error({ err }, "session sweep failed")
    );
  }, SWEEP_INTERVAL_MS);
  // A pending timer should not be the reason the process refuses to exit.
  sweep.unref();

  app.addHook("onClose", async () => {
    clearInterval(sweep);
    // Anything still queued is a user's dashboard. Let it land.
    await store.drain();
  });

  return { app, store };
}
