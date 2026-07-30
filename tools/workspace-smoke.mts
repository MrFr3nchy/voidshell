/**
 * Checks for the workspace endpoints.
 *
 *   npx esbuild tools/workspace-smoke.mts --bundle --platform=node \
 *     --format=esm --packages=external --outfile=ws-smoke.mjs \
 *     --log-level=error && node ws-smoke.mjs
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../packages/api/src/index.js";
import { COOKIE } from "../packages/api/src/auth.js";
import { MAX_WORKSPACE_BYTES } from "../packages/api/src/workspace.js";

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

const root = await mkdtemp(join(tmpdir(), "voidshell-ws-"));
const dbPath = join(root, "db.json");
const { app, store } = await build(dbPath);

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : [raw];
  for (const c of all) {
    const m = typeof c === "string" ? c.match(new RegExp(`${COOKIE}=([^;]+)`)) : null;
    if (m && m[1]) return m[1];
  }
  return "";
}

async function newUser(): Promise<{ cookie: string; key: string; id: string }> {
  const res = await app.inject({ method: "POST", url: "/api/auth/signup" });
  const body = res.json() as { key: string; user: { id: string } };
  return { cookie: cookieFrom(res), key: body.key, id: body.user.id };
}

const put = (cookie: string, payload: unknown) =>
  app.inject({ method: "PUT", url: "/api/workspace", payload, cookies: { [COOKIE]: cookie } });

const get = (cookie: string) =>
  app.inject({ method: "GET", url: "/api/session", cookies: { [COOKIE]: cookie } });

/* ---------------- round trip ---------------- */

const alice = await newUser();
{
  const ws = {
    state: { "aurora.hue": 210, "launcher.count": 3, "notes.doc.a": "hello void" },
    fs: { n: "void", k: "d", ch: [{ n: "welcome.md", k: "f", c: "# hi" }] },
  };
  const res = await put(alice.cookie, ws);
  check("PUT workspace returns 200", res.statusCode === 200);

  const back = await get(alice.cookie);
  check("the workspace reads back identically", JSON.stringify((back.json() as { workspace: unknown }).workspace) === JSON.stringify(ws));

  await store.drain();
  const raw = JSON.parse(await readFile(dbPath, "utf8")) as {
    users: Record<string, { workspace: { state: Record<string, unknown> } }>;
  };
  const stored = Object.values(raw.users)[0]!;
  check("it persisted to disk", stored.workspace.state["aurora.hue"] === 210);
}

/* ---------------- replace, not merge ---------------- */

{
  await put(alice.cookie, { state: { kept: 1 }, fs: null });
  const back = await get(alice.cookie);
  const ws = (back.json() as { workspace: { state: Record<string, unknown>; fs: unknown } }).workspace;
  // A merge would leave aurora.hue behind, and deleting a panel or a setting
  // would become impossible to express.
  check("PUT replaces rather than merges", !("aurora.hue" in ws.state) && ws.state.kept === 1);
  check("fs can be cleared back to null", ws.fs === null);
}

/* ---------------- auth ---------------- */

{
  const anon = await app.inject({ method: "PUT", url: "/api/workspace", payload: { state: {}, fs: null } });
  check("PUT without a cookie is 401", anon.statusCode === 401);

  const bogus = await put("f".repeat(64), { state: {}, fs: null });
  check("PUT with an invented token is 401", bogus.statusCode === 401);

  // The gate that matters: two dashboards, and no way to reach across.
  const bob = await newUser();
  await put(bob.cookie, { state: { owner: "bob" }, fs: null });
  await put(alice.cookie, { state: { owner: "alice" }, fs: null });

  const aliceSees = (await get(alice.cookie)).json() as { workspace: { state: { owner: string } } };
  const bobSees = (await get(bob.cookie)).json() as { workspace: { state: { owner: string } } };
  check("each session sees only its own workspace", aliceSees.workspace.state.owner === "alice" && bobSees.workspace.state.owner === "bob");

  // A client-supplied id must be ignored entirely, not honoured.
  await put(bob.cookie, { state: { owner: "bob" }, fs: null, userId: alice.id });
  const aliceAfter = (await get(alice.cookie)).json() as { workspace: { state: { owner: string } } };
  check("a client-supplied userId cannot redirect a write", aliceAfter.workspace.state.owner === "alice");

  // Two browsers, one key: the same dashboard, not two.
  const second = await app.inject({ method: "POST", url: "/api/auth/signin", payload: { key: alice.key } });
  const elsewhere = (await get(cookieFrom(second))).json() as { workspace: { state: { owner: string } } };
  check("the same key on a second session loads the same dashboard", elsewhere.workspace.state.owner === "alice");
}

/* ---------------- validation ---------------- */

{
  const cases: Array<[string, unknown]> = [
    ["a bare array", []],
    ["null", null],
    ["a missing state", { fs: null }],
    ["a state that is an array", { state: [], fs: null }],
    ["a state that is a string", { state: "x", fs: null }],
    ["an fs that is an array", { state: {}, fs: [] }],
    ["an fs that is a number", { state: {}, fs: 3 }],
  ];
  for (const [label, payload] of cases) {
    const res = await put(alice.cookie, payload);
    check(`${label} is rejected with 400 (got ${res.statusCode})`, res.statusCode === 400);
  }

  // A JSON body that parses to a string rather than an object. Sent with an
  // explicit content-type, since inject() otherwise omits it and the request
  // never reaches the handler.
  const jsonString = await app.inject({
    method: "PUT",
    url: "/api/workspace",
    payload: '"nope"',
    headers: { "content-type": "application/json" },
    cookies: { [COOKIE]: alice.cookie },
  });
  check(`a JSON string body is rejected with 400 (got ${jsonString.statusCode})`, jsonString.statusCode === 400);

  // text/plain has a built-in parser, so this reaches the handler as a raw
  // string — which makes it a test of the validator rather than of Fastify's
  // content-type table. The validator is the backstop that has to hold.
  const plain = await app.inject({
    method: "PUT",
    url: "/api/workspace",
    payload: "nope",
    headers: { "content-type": "text/plain" },
    cookies: { [COOKIE]: alice.cookie },
  });
  check(`a text/plain body reaches the validator and is rejected (got ${plain.statusCode})`, plain.statusCode === 400);

  // An unregistered media type never reaches the handler at all.
  const xml = await app.inject({
    method: "PUT",
    url: "/api/workspace",
    payload: "<nope/>",
    headers: { "content-type": "application/xml" },
    cookies: { [COOKIE]: alice.cookie },
  });
  check(`an unsupported media type is refused with 415 (got ${xml.statusCode})`, xml.statusCode === 415);

  const good = await put(alice.cookie, { state: {}, fs: null });
  check("an empty-but-valid workspace is accepted", good.statusCode === 200);

  // Unknown fields are dropped rather than rejected, so a newer client doesn't
  // fail outright — but they must not be stored either.
  await put(alice.cookie, { state: { a: 1 }, fs: null, smuggled: "x".repeat(1000) });
  const back = await get(alice.cookie);
  check(
    "unknown top-level fields are dropped, not stored",
    !JSON.stringify((back.json() as { workspace: unknown }).workspace).includes("smuggled")
  );
}

/* ---------------- limits ---------------- */

{
  // Deep nesting is a stack overflow in the next JSON.stringify, which would
  // take the process down while it holds the write queue.
  let deep: Record<string, unknown> = {};
  const leaf = deep;
  for (let i = 0; i < 200; i++) deep = { n: deep };
  void leaf;
  const res = await put(alice.cookie, { state: { deep }, fs: null });
  check(`200 levels of nesting is rejected (${res.statusCode})`, res.statusCode === 400);

  const shallow = await put(alice.cookie, { state: { deep: { a: { b: { c: 1 } } } }, fs: null });
  check("ordinary nesting is fine", shallow.statusCode === 200);

  // Oversized bodies are refused by Fastify before parsing.
  const huge = { state: { pad: "x".repeat(MAX_WORKSPACE_BYTES + 1024) }, fs: null };
  const big = await put(alice.cookie, huge);
  check(`a body over 512KB is refused (${big.statusCode})`, big.statusCode === 413);

  // And the dashboard is untouched by the attempt.
  const after = await get(alice.cookie);
  check("a refused oversized write left the workspace intact", after.statusCode === 200);
}

/* ---------------- concurrent writes from one session ---------------- */

{
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => put(alice.cookie, { state: { seq: i }, fs: null }))
  );
  check("ten concurrent PUTs all succeed", results.every((r) => r.statusCode === 200));
  await store.drain();

  const raw = await readFile(dbPath, "utf8");
  let parsed = true;
  try {
    JSON.parse(raw);
  } catch {
    parsed = false;
  }
  check("db.json is still valid JSON after concurrent PUTs", parsed);

  const back = await get(alice.cookie);
  const seq = (back.json() as { workspace: { state: { seq: number } } }).workspace.state.seq;
  check(`the last write wins cleanly (seq=${seq})`, typeof seq === "number" && seq >= 0 && seq < 10);
}

await app.close();
await rm(root, { recursive: true, force: true });

console.log("");
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("all workspace smoke checks passed");
