import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { Store } from "./store.js";

/**
 * The voidshell API.
 *
 * Binds loopback only. In production nothing reaches it except through the
 * reverse proxy, which is what lets the routes below assume TLS terminated
 * upstream and skip a layer of their own.
 */

const DB_PATH = process.env.VOIDSHELL_DB ?? "/var/lib/voidshell/db.json";
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";

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
    bodyLimit: 512 * 1024,
  });

  app.get("/api/health", async () => ({ ok: true, users: store.userCount() }));

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

/** Only start a listener when run directly, so tests can build() in-process. */
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const { app } = await build();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} — closing`);
      app.close().then(
        () => process.exit(0),
        () => process.exit(1)
      );
    });
  }

  try {
    await app.listen({ port: PORT, host: HOST });
  } catch (err) {
    app.log.error({ err }, "failed to listen");
    process.exit(1);
  }
}
