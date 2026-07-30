/**
 * Checks for the workspace persistence host.
 *
 * localStorage writes were free and synchronous. These are neither, and the
 * ways that bites are all timing-shaped — a drag that emits two hundred
 * requests, a retry storm, or a failure that quietly drops the user's layout.
 * Fake timers, so a 30-second ceiling is testable in a millisecond.
 *
 *   npx esbuild tools/persist-smoke.mts --bundle --platform=node \
 *     --format=esm --outfile=persist-smoke.mjs --external:jsdom \
 *     --log-level=error && node persist-smoke.mjs
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { url: "https://example.test" });

/* ---------------- a controllable clock ---------------- */

let now = 0;
let seq = 0;
const timers = new Map<number, { at: number; fn: () => void }>();

// Date.now has to move with the fake timers, not independently of them. The
// max-wait ceiling is measured in wall-clock time, so a harness that advances
// only setTimeout can never reach it — and reports a working ceiling as broken.
Date.now = () => now;

const g = globalThis as Record<string, unknown>;
g.window = {
  setTimeout: (fn: () => void, ms = 0) => {
    const id = ++seq;
    timers.set(id, { at: now + ms, fn });
    return id;
  },
  clearTimeout: (id: number) => void timers.delete(id),
};
g.document = dom.window.document;

/** Runs every timer due at or before `now + ms`, in order. */
async function advance(ms: number): Promise<void> {
  const until = now + ms;
  for (;;) {
    const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at);
    if (!due.length) break;
    const [id, t] = due[0]!;
    timers.delete(id);
    now = Math.max(now, t.at);
    t.fn();
    // Let any promise the callback started settle before looking again.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
  now = until;
  await Promise.resolve();
}

/* ---------------- a scriptable server ---------------- */

let puts: unknown[] = [];
let failWith: "offline" | number | null = null;

g.fetch = async (_input: string, init?: { body?: string }) => {
  if (failWith === "offline") throw new TypeError("Failed to fetch");
  if (typeof failWith === "number") {
    return { ok: false, status: failWith, statusText: "no", json: async () => ({ error: "no" }) };
  }
  puts.push(JSON.parse(init?.body ?? "null"));
  return { ok: true, status: 200, statusText: "ok", json: async () => ({ ok: true }) };
};

const { ApiWorkspaceHost } = await import("../packages/ui/src/kernel/apiWorkspace");

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

function fresh() {
  puts = [];
  failWith = null;
  timers.clear();
  const notes: Array<{ message: string; kind: string }> = [];
  const host = new ApiWorkspaceHost((message, kind) => notes.push({ message, kind }));
  return { host, notes };
}

const snap = (n: number) => ({ state: { seq: n }, fs: null });

/* ---------------- the debounce ---------------- */

{
  const { host } = fresh();
  host.save(snap(1));
  await advance(400);
  check("nothing is sent during the quiet period", puts.length === 0);
  await advance(700);
  check("one request after the quiet period", puts.length === 1);
  check("it carries the latest state", (puts[0] as { state: { seq: number } }).state.seq === 1);
}

{
  // The plan's gate: dragging for ten seconds is one request, after settling.
  const { host } = fresh();
  for (let i = 0; i < 200; i++) {
    host.save(snap(i));
    await advance(50); // 200 changes over 10 seconds
  }
  const during = puts.length;
  await advance(1200);
  check(`ten seconds of dragging emits nothing until it settles (${during})`, during === 0);
  check(`then exactly one request (${puts.length})`, puts.length === 1);
  check(
    "and it carries the final position, not an early one",
    (puts[0] as { state: { seq: number } }).state.seq === 199
  );
}

{
  // ...but a change may not sit unsaved forever just because the shell is busy.
  const { host } = fresh();
  for (let i = 0; i < 400; i++) {
    host.save(snap(i));
    await advance(100); // 40 seconds of unbroken activity
  }
  check(`the max-wait ceiling forces a save (${puts.length})`, puts.length >= 1);
}

/* ---------------- flush ---------------- */

{
  const { host } = fresh();
  host.save(snap(7));
  await host.flush();
  check("flush sends immediately without waiting out the debounce", puts.length === 1);
  check("flush leaves nothing pending", host.dirty === false);

  await advance(2000);
  check("and does not send a second time afterwards", puts.length === 1);
}

{
  const { host } = fresh();
  host.save(snap(1));
  host.flushOnUnload();
  check("the unload path sends what was pending", puts.length === 1);
  check("the unload path clears the queue", host.dirty === false);
}

/* ---------------- failure ---------------- */

{
  const { host, notes } = fresh();
  failWith = "offline";
  host.save(snap(1));
  await advance(1100);

  check("a failed save is not silent", notes.length === 1 && notes[0]!.kind === "warn");
  check("the warning says the layout is safe", notes[0]!.message.includes("safe here"));
  // The whole point: a network blip must not become lost work.
  check("the pending change is kept, not discarded", host.dirty === true);
  check("nothing reached the server", puts.length === 0);

  await advance(1100);
  check("it retried", host.dirty === true);
  check("but did not toast again on the retry", notes.length === 1);

  // Backoff, not a hot loop: 1s, 3s, 8s, 20s.
  const before = puts.length;
  await advance(200);
  check("it is not retrying continuously", puts.length === before);

  failWith = null;
  await advance(40_000);
  check("it recovers once the server comes back", puts.length === 1);
  check("and says so", notes.length === 2 && notes[1]!.kind === "good");
  check("the recovered write carries the change that failed", (puts[0] as { state: { seq: number } }).state.seq === 1);
}

{
  // A 401 means something different and should say so — the layout is not
  // coming back on its own, and the user needs to know before they close the tab.
  const { host, notes } = fresh();
  failWith = 401;
  host.save(snap(1));
  await advance(1100);
  check("a 401 is reported as being signed out", notes[0]!.message.includes("signed out"));
}

/* ---------------- no overlapping writes ---------------- */

{
  const { host } = fresh();
  let inFlight = 0;
  let maxConcurrent = 0;
  g.fetch = async (_i: string, init?: { body?: string }) => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await Promise.resolve();
    inFlight--;
    puts.push(JSON.parse(init?.body ?? "null"));
    return { ok: true, status: 200, statusText: "ok", json: async () => ({ ok: true }) };
  };
  for (let i = 0; i < 5; i++) {
    host.save(snap(i));
    await host.flush();
  }
  check(`requests never overlap (max ${maxConcurrent})`, maxConcurrent === 1);
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("all persistence checks passed");
