/**
 * End-to-end checks for the auth surface, against a real Fastify instance and
 * a real database file in a temp directory.
 *
 * Uses app.inject() rather than a socket, so the checks run without binding a
 * port, but the whole stack below the socket — cookies, rate limiting, the
 * store, the atomic writes — is the real thing.
 *
 *   npx esbuild tools/auth-smoke.mts --bundle --platform=node --format=esm \
 *     --outfile=auth-smoke.mjs --log-level=error && node auth-smoke.mjs
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../packages/api/src/index.js";
import { generateKey, normalizeKey, looksLikeKey, KEY_BITS } from "../packages/api/src/keys.js";
import { WORDS } from "../packages/api/src/wordlist.js";
import { COOKIE } from "../packages/api/src/auth.js";

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

const root = await mkdtemp(join(tmpdir(), "voidshell-auth-"));
const dbPath = join(root, "db.json");
const { app, store } = await build(dbPath);

/** Pulls the session token out of a Set-Cookie header. */
function cookieFrom(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : [raw];
  for (const c of all) {
    const m = typeof c === "string" ? c.match(new RegExp(`${COOKIE}=([^;]+)`)) : null;
    if (m && m[1]) return m[1];
  }
  return null;
}

function attrsFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : [raw];
  return all.filter((c): c is string => typeof c === "string").find((c) => c.includes(COOKIE)) ?? "";
}

/* ---------------- the wordlist and key generation ---------------- */

{
  check(`wordlist is exactly 2048 words (${WORDS.length})`, WORDS.length === 2048);
  check("every word is lowercase ascii, 3-8 chars", WORDS.every((w) => /^[a-z]{3,8}$/.test(w)));
  check("no duplicate words", new Set(WORDS).size === WORDS.length);
  check(`a four-word key carries 44 bits (${KEY_BITS})`, KEY_BITS === 44);

  // The distance rule is what stands in for homophone and confusable
  // blocklists, so it is worth confirming it actually holds in the shipped
  // list rather than trusting the generator that produced it.
  const dist = (a: string, b: string): number => {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i, ...new Array<number>(b.length).fill(0)];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length]!;
  };
  let tooClose: [string, string] | null = null;
  for (let i = 0; i < WORDS.length && !tooClose; i++) {
    for (let j = i + 1; j < WORDS.length; j++) {
      if (Math.abs(WORDS[i]!.length - WORDS[j]!.length) > 2) continue;
      if (dist(WORDS[i]!, WORDS[j]!) < 3) {
        tooClose = [WORDS[i]!, WORDS[j]!];
        break;
      }
    }
  }
  check(`every pair of words is 3+ edits apart${tooClose ? ` (${tooClose.join("/")})` : ""}`, !tooClose);

  const key = generateKey();
  check(`generateKey returns four words (${key})`, key.split("-").length === 4);
  check("generated keys look like keys", looksLikeKey(key));

  // 10,000 generations, no repeats. At 44 bits a collision here would mean the
  // generator is not doing what it claims.
  const seen = new Set<string>();
  for (let i = 0; i < 10_000; i++) seen.add(generateKey());
  check("10,000 generated keys are all distinct", seen.size === 10_000);

  // Every word position must actually vary; a bug pinning one index would
  // still pass the distinctness check above.
  const positions = [0, 1, 2, 3].map(() => new Set<string>());
  for (const k of seen) k.split("-").forEach((w, i) => positions[i]!.add(w));
  check(
    `all four positions vary (${positions.map((p) => p.size).join("/")})`,
    positions.every((p) => p.size > 1500)
  );

  check("keys normalize whitespace, case and stray dashes", normalizeKey("  Shiny_Gold  Tooth—Harbor ") === "shiny-gold-tooth-harbor");
  check("a three-word key is rejected on shape", !looksLikeKey("shiny-gold-tooth"));
}

/* ---------------- signup ---------------- */

let key = "";
let cookie = "";
{
  const res = await app.inject({ method: "POST", url: "/api/auth/signup" });
  check("signup returns 201", res.statusCode === 201);
  const body = res.json() as { key: string; user: { id: string }; warning: string };
  key = body.key;
  check(`signup returned a four-word key (${key})`, looksLikeKey(key));
  check("signup returned a user id", /^usr_[0-9a-f]{12}$/.test(body.user.id));
  check("signup warns about the key being unrecoverable", /cannot be recovered/i.test(body.warning));

  cookie = cookieFrom(res) ?? "";
  check("signup set a session cookie", cookie.length > 0);

  const attrs = attrsFrom(res);
  check("cookie is HttpOnly", /HttpOnly/i.test(attrs));
  check("cookie is SameSite=Strict", /SameSite=Strict/i.test(attrs));
  check("cookie is scoped to /", /Path=\/(;|$)/i.test(attrs));
  check("cookie expires in 30 days", /Max-Age=2592000/i.test(attrs));

  await store.drain();
  const raw = await readFile(dbPath, "utf8");
  check("the plaintext key is not in db.json", !raw.includes(key));
  check("the plaintext session token is not in db.json", !raw.includes(cookie));
}

/* ---------------- session ---------------- */

{
  const res = await app.inject({ method: "GET", url: "/api/session", cookies: { [COOKIE]: cookie } });
  check("session resolves with the cookie", res.statusCode === 200);
  const body = res.json() as { workspace: { state: Record<string, unknown>; fs: unknown } };
  check("session returns an empty workspace", JSON.stringify(body.workspace) === '{"state":{},"fs":null}');

  const anon = await app.inject({ method: "GET", url: "/api/session" });
  check("session without a cookie is 401", anon.statusCode === 401);

  const bogus = await app.inject({
    method: "GET",
    url: "/api/session",
    cookies: { [COOKIE]: "d".repeat(64) },
  });
  check("session with an invented token is 401", bogus.statusCode === 401);
}

/* ---------------- signin ---------------- */

{
  const wrong = await app.inject({
    method: "POST",
    url: "/api/auth/signin",
    payload: { key: "shiny-gold-tooth-harbor" },
  });
  check("signin with a wrong key is 401", wrong.statusCode === 401);
  check("a wrong key sets no cookie", cookieFrom(wrong) === null);

  const right = await app.inject({ method: "POST", url: "/api/auth/signin", payload: { key } });
  check("signin with the right key succeeds", right.statusCode === 200);
  const second = cookieFrom(right) ?? "";
  check("signin issued a new session token", second.length > 0 && second !== cookie);

  // Casing and stray whitespace are how a key comes back off a phone or a
  // notes app, and must not read as a wrong key.
  const messy = await app.inject({
    method: "POST",
    url: "/api/auth/signin",
    payload: { key: `  ${key.toUpperCase().replace(/-/g, " ")}  ` },
  });
  check("a pasted, mis-cased, space-separated key still signs in", messy.statusCode === 200);

  // Both sessions must work: signing in elsewhere may not evict the first.
  const stillGood = await app.inject({
    method: "GET",
    url: "/api/session",
    cookies: { [COOKIE]: cookie },
  });
  check("the original session survives a second signin", stillGood.statusCode === 200);
}

/* ---------------- timing ---------------- */

{
  // A fresh app, and a different source address per request. Sharing the app
  // above would put these attempts past the rate limit, and a 429 is refused
  // before the handler runs — so hits and misses would look identically fast
  // while proving nothing at all about the timing floor.
  const { app: timed } = await build(join(root, "timing.json"));
  const signup = await timed.inject({ method: "POST", url: "/api/auth/signup" });
  const timingKey = (signup.json() as { key: string }).key;

  let addr = 0;
  const time = async (payload: unknown): Promise<number> => {
    const t = process.hrtime.bigint();
    await timed.inject({
      method: "POST",
      url: "/api/auth/signin",
      payload,
      remoteAddress: `198.51.100.${++addr}`,
    });
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const hits: number[] = [];
  const misses: number[] = [];
  for (let i = 0; i < 5; i++) {
    hits.push(await time({ key: timingKey }));
    misses.push(await time({ key: generateKey() }));
  }
  await timed.close();
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const gap = Math.abs(mean(hits) - mean(misses));
  check(
    `hit and miss take the same time to ~20ms (hit ${mean(hits).toFixed(0)}ms, miss ${mean(misses).toFixed(0)}ms)`,
    gap < 20
  );
  check("both are held to the floor", mean(hits) >= 200 && mean(misses) >= 200);
}

/* ---------------- signout ---------------- */

{
  const fresh = await app.inject({ method: "POST", url: "/api/auth/signin", payload: { key } });
  const token = cookieFrom(fresh)!;

  const out = await app.inject({
    method: "POST",
    url: "/api/auth/signout",
    cookies: { [COOKIE]: token },
  });
  check("signout returns 200", out.statusCode === 200);
  check("signout clears the cookie", /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(attrsFrom(out)));

  // The point of the whole exercise: replaying the captured cookie must fail.
  // Clearing it browser-side would leave this working for thirty days.
  const replay = await app.inject({
    method: "GET",
    url: "/api/session",
    cookies: { [COOKIE]: token },
  });
  check("replaying the signed-out cookie is 401", replay.statusCode === 401);
}

/* ---------------- rate limiting ---------------- */

{
  // A separate app so the earlier signins don't count against this bucket.
  const { app: limited } = await build(join(root, "rl.json"));
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) {
    const res = await limited.inject({
      method: "POST",
      url: "/api/auth/signin",
      payload: { key: generateKey() },
      remoteAddress: "203.0.113.7",
    });
    codes.push(res.statusCode);
  }
  check(`the first 10 attempts are 401 (${codes.slice(0, 10).join(",")})`, codes.slice(0, 10).every((c) => c === 401));
  check(`the 11th attempt is 429 (${codes[10]})`, codes[10] === 429);
  check(`the 12th attempt is 429 (${codes[11]})`, codes[11] === 429);

  // The limit must be per-IP, or one attacker locks out every user.
  const other = await limited.inject({
    method: "POST",
    url: "/api/auth/signin",
    payload: { key: generateKey() },
    remoteAddress: "198.51.100.4",
  });
  check("a different IP is unaffected", other.statusCode === 401);

  const health = await limited.inject({ method: "GET", url: "/api/health" });
  check("health is not rate limited", health.statusCode === 200);

  await limited.close();
}

await app.close();
await rm(root, { recursive: true, force: true });

console.log("");
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("all auth smoke checks passed");
