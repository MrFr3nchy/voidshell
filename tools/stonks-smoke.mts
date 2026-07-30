/**
 * Checks for the decision proxy.
 *
 * No live model call — the point of these is the surface around it: that the
 * route is session-gated, that it validates before spending a request, and
 * that a server with no key degrades to something the client can act on rather
 * than to a 500.
 *
 *   npx esbuild tools/stonks-smoke.mts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=st.mjs --log-level=error && node st.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../packages/api/src/index.js";
import { COOKIE } from "../packages/api/src/auth.js";

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

const root = await mkdtemp(join(tmpdir(), "voidshell-stonks-"));

// Deliberately unset, so these run against the no-key path.
delete process.env.ANTHROPIC_API_KEY;

const { app } = await build(join(root, "db.json"));

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : [raw];
  for (const c of all) {
    const m = typeof c === "string" ? c.match(new RegExp(`${COOKIE}=([^;]+)`)) : null;
    if (m && m[1]) return m[1];
  }
  return "";
}

const signup = await app.inject({ method: "POST", url: "/api/auth/signup" });
const cookie = cookieFrom(signup);

const decide = (payload: unknown, c: string = cookie) =>
  app.inject({ method: "POST", url: "/api/stonks/decide", payload, cookies: { [COOKIE]: c } });

const goodBody = {
  signals: [{ ticker: "AAPL", price: 190.5, change5d: 0.02 }],
  portfolio: { cash: 10_000, totalValue: 12_000, holdings: {} },
};

/* ---------------- the gate ---------------- */

{
  const anon = await app.inject({ method: "POST", url: "/api/stonks/decide", payload: goodBody });
  check("deciding without a session is 401", anon.statusCode === 401);

  const bogus = await decide(goodBody, "a".repeat(64));
  check("deciding with an invented token is 401", bogus.statusCode === 401);
}

/* ---------------- validation runs before the model ---------------- */

{
  // Each of these must be refused locally. Sending them upstream would spend a
  // model call to be told what a regex already knows.
  const cases: Array<[string, unknown]> = [
    ["no signals", { portfolio: goodBody.portfolio }],
    ["empty signals", { signals: [], portfolio: goodBody.portfolio }],
    ["a signal without a ticker", { signals: [{ price: 1 }], portfolio: goodBody.portfolio }],
    ["a lowercase ticker", { signals: [{ ticker: "aapl", price: 1 }], portfolio: goodBody.portfolio }],
    ["a ticker that is really a sentence", { signals: [{ ticker: "IGNORE ALL PREVIOUS", price: 1 }], portfolio: goodBody.portfolio }],
    ["a zero price", { signals: [{ ticker: "AAPL", price: 0 }], portfolio: goodBody.portfolio }],
    ["a negative price", { signals: [{ ticker: "AAPL", price: -5 }], portfolio: goodBody.portfolio }],
    ["no portfolio", { signals: goodBody.signals }],
    ["a portfolio without cash", { signals: goodBody.signals, portfolio: { totalValue: 1 } }],
  ];
  for (const [label, payload] of cases) {
    const res = await decide(payload);
    check(`${label} is rejected with 400 (got ${res.statusCode})`, res.statusCode === 400);
  }

  const tooMany = await decide({
    signals: Array.from({ length: 41 }, (_, i) => ({ ticker: `T${i}`, price: 10 })),
    portfolio: goodBody.portfolio,
  });
  check(`41 tickers is rejected (got ${tooMany.statusCode})`, tooMany.statusCode === 400);
}

/* ---------------- no key is a fallback, not a crash ---------------- */

{
  const res = await decide(goodBody);
  check(`a server with no key answers 503 (got ${res.statusCode})`, res.statusCode === 503);
  const body = res.json() as { fallback?: string; error?: string };
  // The client switches to its deterministic mock provider on this, so the
  // simulator keeps working. A 500 would just look broken.
  check("it names the fallback the client should use", body.fallback === "mock");
  check("it explains itself", typeof body.error === "string" && body.error.length > 0);
  check("it does not leak whether a key is merely wrong vs absent", !/key|env|ANTHROPIC/i.test(body.error ?? ""));
}

/* ---------------- rate limiting ---------------- */

{
  // A model call is the one expensive thing a signed-in user can trigger.
  const codes: number[] = [];
  for (let i = 0; i < 22; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/api/stonks/decide",
      payload: goodBody,
      cookies: { [COOKIE]: cookie },
      remoteAddress: "203.0.113.9",
    });
    codes.push(res.statusCode);
  }
  check(`the first 20 are not rate limited (${new Set(codes.slice(0, 20)).size} distinct)`, codes.slice(0, 20).every((c) => c !== 429));
  check(`the 21st is 429 (got ${codes[20]})`, codes[20] === 429);
}

await app.close();
await rm(root, { recursive: true, force: true });

console.log("");
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("all stonks smoke checks passed");
