import { build } from "./index.js";

/**
 * The process entrypoint, kept separate from index.ts on purpose.
 *
 * index.ts exports build() and nothing else runs at import time, so a test or
 * a harness can construct the app in-process without a listener appearing.
 * The alternative — an `import.meta.url === argv[1]` guard inside index.ts —
 * looks equivalent and isn't: anything that bundles the module collapses that
 * comparison into a match, and the "library" quietly boots a real server
 * against the production database path.
 */

const PORT = Number(process.env.PORT ?? 3000);
/** Loopback only. nginx/Caddy is the only thing that should ever reach us. */
const HOST = process.env.HOST ?? "127.0.0.1";

const { app } = await build();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} — closing`);
    // onClose drains the write queue, so an in-flight dashboard save lands
    // rather than being dropped by the restart.
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
