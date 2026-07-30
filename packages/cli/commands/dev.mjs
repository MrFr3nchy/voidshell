import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { run, must, have } from "../lib/sh.mjs";
import { REPO, load } from "../lib/config.mjs";
import { step, ok, info, say, warn, fail, dim, bold, green, cyan, yellow, table } from "../lib/ui.mjs";

export const help = `
${bold("voidshell dev")} [options]

  Runs both halves locally: the API on :3000 against a throwaway database, and
  Vite on :5173 proxying /api to it. One Ctrl-C stops both.

  ${dim("--port <n>")}     API port ${dim("(default: 3000)")}
  ${dim("--db <path>")}    database file ${dim("(default: .voidshell-dev/db.json)")}
  ${dim("--fresh")}        delete the dev database first
  ${dim("--api-only")}     skip Vite
`;

/** Tags each child's output so two interleaved streams stay readable. */
function pipe(child, label, tint) {
  const prefix = tint(label.padEnd(3));
  const emit = (stream) => (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) console.log(`${prefix} ${dim("│")} ${line}`);
    }
    void stream;
  };
  child.stdout?.on("data", emit("out"));
  child.stderr?.on("data", emit("err"));
}

export async function dev(_args, flags) {
  const config = load();
  const port = flags.port ?? config.port ?? 3000;
  const dbPath = flags.db ?? join(REPO, ".voidshell-dev", "db.json");

  if (flags.fresh) {
    await run("rm", ["-f", dbPath]);
    info(`removed ${dbPath}`);
  }
  await mkdir(join(dbPath, ".."), { recursive: true });

  // tsc emits into dist/ and the server runs from dist/, so the first run of
  // the day needs a build before there is anything to watch.
  step("Building the API once so there's something to run");
  await must("npm", ["run", "build", "--workspace", "@voidshell/api"], {
    cwd: REPO,
    message: "the API failed to build — fix that first",
  });

  const children = [];
  const spawnChild = (label, tint, cmd, args, env = {}) => {
    const child = spawn(cmd, args, { cwd: REPO, env: { ...process.env, ...env } });
    pipe(child, label, tint);
    child.on("exit", (code, signal) => {
      // A child dying on its own means something is wrong; take the rest down
      // rather than leaving a half-running stack that looks fine.
      if (!shuttingDown && code !== 0 && !signal) {
        warn(`${label} exited with code ${code} — stopping the rest`);
        shutdown(1);
      }
    });
    children.push(child);
    return child;
  };

  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    say();
    step("Stopping");
    for (const child of children) child.kill("SIGTERM");
    // SIGTERM lets the API drain its write queue; anything still alive after
    // a grace period gets the harder signal.
    setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
      process.exit(code);
    }, 2000).unref();
    Promise.all(children.map((c) => new Promise((r) => c.on("exit", r)))).then(() => process.exit(code));
  };

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  say();
  spawnChild("tsc", yellow, "npm", ["run", "dev", "--workspace", "@voidshell/api"]);
  spawnChild("api", cyan, "node", ["--watch", "packages/api/dist/server.js"], {
    VOIDSHELL_DB: dbPath,
    PORT: String(port),
    // Secure cookies would never be set back over plain http on localhost, so
    // every request after signin would arrive anonymous.
    NODE_ENV: "development",
    // --watch is chatty about restarts on every tsc emit.
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=ExperimentalWarning`.trim(),
  });

  if (!flags["api-only"]) {
    if (!(await have("npx"))) fail("npx is not on PATH");
    spawnChild("ui", green, "npm", ["run", "dev"]);
  }

  say();
  ok("Running");
  table([
    ["client", flags["api-only"] ? dim("skipped") : "http://localhost:5173"],
    ["api", `http://127.0.0.1:${port}/api/health`],
    ["database", dbPath],
  ]);
  say();
  info("The client proxies /api to the API, so the session cookie behaves as it does in production.");
  info(`Ctrl-C stops both. ${dim("--fresh")} starts from an empty database.`);
  say();
}
