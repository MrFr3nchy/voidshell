/**
 * Headless checks for the API's document store.
 *
 * The store is the one component here whose failure mode is losing every
 * dashboard at once, so its durability claims get exercised rather than
 * assumed — including the ugly ones: a process killed mid-write, and two
 * writers racing.
 *
 *   npx esbuild tools/api-smoke.mts --bundle --platform=node --format=esm \
 *     --outfile=api-smoke.mjs --log-level=error && node api-smoke.mjs
 */
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, sha256, SESSION_TTL_MS } from "../packages/api/src/store.js";

/**
 * Hammer mode. The SIGKILL check below re-invokes this same bundle rather than
 * generating a child script, which keeps the victim byte-identical to the code
 * under test and sidesteps the question of how a child would load TypeScript.
 */
if (process.env.VOIDSHELL_HAMMER) {
  const store = new Store(process.env.VOIDSHELL_HAMMER);
  await store.load();
  const u = await store.createUser(sha256("victim"));
  process.send?.("ready");
  for (let i = 0; ; i++) {
    // Padded so a write takes long enough that an arbitrary kill has a real
    // chance of landing inside writeAtomically rather than between writes.
    await store.updateWorkspace(u.id, { state: { i, pad: "x".repeat(200_000) }, fs: null });
  }
}

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

const root = await mkdtemp(join(tmpdir(), "voidshell-api-"));
const dbPath = join(root, "db.json");

/* ---------------- basics ---------------- */

{
  const store = new Store(dbPath);
  await store.load();
  check("first boot starts empty", store.userCount() === 0);

  const hash = sha256("shiny-gold-tooth-harbor");
  const user = await store.createUser(hash);
  check("createUser mints a usr_ id", /^usr_[0-9a-f]{12}$/.test(user.id));
  check("user is found by key hash", (await store.getUserByKeyHash(hash))?.id === user.id);
  check("an unknown key hash finds nothing", (await store.getUserByKeyHash(sha256("nope"))) === null);

  await store.updateWorkspace(user.id, { state: { "aurora.hue": 210 }, fs: { n: "void", k: "d" } });
  await store.drain();

  const onDisk = JSON.parse(await readFile(dbPath, "utf8"));
  check("workspace survived the round trip", onDisk.users[hash].workspace.state["aurora.hue"] === 210);
  check("db.json is version 1", onDisk.version === 1);
}

/* ---------------- the plaintext key must never be written ---------------- */

{
  const raw = await readFile(dbPath, "utf8");
  check("no plaintext key on disk", !raw.includes("shiny-gold-tooth-harbor"));
  check("the hash is the lookup key", raw.includes(sha256("shiny-gold-tooth-harbor")));
}

/* ---------------- sessions ---------------- */

{
  const store = new Store(dbPath);
  await store.load();
  const user = (await store.getUserByKeyHash(sha256("shiny-gold-tooth-harbor")))!;

  const token = await store.createSession(user.id);
  check("session token is 32 bytes of hex", /^[0-9a-f]{64}$/.test(token));

  const raw = await readFile(dbPath, "utf8");
  check("no plaintext session token on disk", !raw.includes(token));

  check("session resolves by token hash", (await store.getSession(sha256(token)))?.userId === user.id);

  await store.deleteSession(sha256(token));
  check("a deleted session is gone server-side", (await store.getSession(sha256(token))) === null);

  // An expired record must read as absent even before the sweep reaches it,
  // or a session outlives its expiry whenever the box happens to be idle.
  const stale = await store.createSession(user.id);
  const doc = JSON.parse(await readFile(dbPath, "utf8"));
  doc.sessions[sha256(stale)].expiresAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(dbPath, JSON.stringify(doc));

  const reloaded = new Store(dbPath);
  await reloaded.load();
  check("an expired session reads as absent", (await reloaded.getSession(sha256(stale))) === null);
  check("the sweep collects it", (await reloaded.sweepExpiredSessions()) === 1);
  check("the sweep is idempotent", (await reloaded.sweepExpiredSessions()) === 0);

  const ttlDays = Math.round(SESSION_TTL_MS / 86_400_000);
  check(`session ttl is 30 days (${ttlDays})`, ttlDays === 30);
}

/* ---------------- a corrupt database must not be silently overwritten ------ */

{
  const badPath = join(root, "corrupt.json");
  await writeFile(badPath, "{ this is not json");
  const store = new Store(badPath);
  let threw = false;
  try {
    await store.load();
  } catch {
    threw = true;
  }
  check("a corrupt db.json refuses to boot rather than starting empty", threw);
  check("the damaged file is left intact for repair", (await readFile(badPath, "utf8")).startsWith("{ this"));
}

/* ---------------- concurrent writes ---------------- */

{
  const racePath = join(root, "race.json");
  const store = new Store(racePath);
  await store.load();

  const users = await Promise.all(
    Array.from({ length: 8 }, (_, i) => store.createUser(sha256(`user-${i}`)))
  );

  // Every one of these mutates memory and schedules a persist. None may be
  // lost to coalescing, and the file must never be a half-written fragment.
  await Promise.all(
    users.map((u, i) => store.updateWorkspace(u.id, { state: { seat: i }, fs: null }))
  );
  await store.drain();

  const doc = JSON.parse(await readFile(racePath, "utf8"));
  check("concurrent writes did not corrupt the file", doc.version === 1);
  check("every concurrent user landed", Object.keys(doc.users).length === 8);
  const seats = Object.values(doc.users as Record<string, { workspace: { state: { seat: number } } }>)
    .map((u) => u.workspace.state.seat)
    .sort((a, b) => a - b);
  check("no concurrent update was lost", JSON.stringify(seats) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7]));
}

/* ---------------- SIGKILL mid-write ---------------- */

{
  const ROUNDS = 5;
  let survived = 0;
  let reachedWriteLoop = 0;
  let iterations = 0;

  for (let round = 0; round < ROUNDS; round++) {
    const killPath = join(root, `kill-${round}.json`);

    const ready = await new Promise<boolean>((resolve) => {
      let sawReady = false;
      const proc = spawn(process.execPath, [process.argv[1]!], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        env: { ...process.env, VOIDSHELL_HAMMER: killPath },
      });
      proc.on("message", () => {
        sawReady = true;
        // Let it get properly into the loop, then kill without warning. The
        // varying delay walks the kill across different points of the write.
        setTimeout(() => proc.kill("SIGKILL"), 40 + round * 25);
      });
      proc.on("exit", () => resolve(sawReady));
      proc.on("error", () => resolve(sawReady));
    });
    if (ready) reachedWriteLoop++;

    try {
      const doc = JSON.parse(await readFile(killPath, "utf8")) as {
        users: Record<string, { workspace: { state: { i?: number } } }>;
      };
      survived++;
      const u = Object.values(doc.users)[0];
      if (typeof u?.workspace.state.i === "number") iterations += u.workspace.state.i;
    } catch (err) {
      console.log(`      round ${round}: ${String(err)}`);
    }
  }

  // Without these two, the check above passes just as happily when the child
  // never ran at all — which is exactly how it passed before, on a db.json
  // that was never created.
  check(`the victim reached the write loop in all ${ROUNDS} rounds`, reachedWriteLoop === ROUNDS);
  check(`the victim was killed mid-write, not before it (${iterations} writes landed)`, iterations > 0);
  check(`db.json is still valid JSON after ${ROUNDS} SIGKILLs mid-write`, survived === ROUNDS);
}

await rm(root, { recursive: true, force: true });

console.log("");
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("all api smoke checks passed");
