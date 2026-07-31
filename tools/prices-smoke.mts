/**
 * Signal computation, checked against bars with known answers.
 *
 * The fetching is a third party's problem and can only be tested against a
 * live market; the arithmetic that turns bars into signals is ours, runs on
 * every decision, and is exactly the kind of thing that silently goes wrong by
 * an off-by-one in a window. Run:
 *
 *   npx esbuild tools/prices-smoke.mts --bundle --platform=node \
 *     --format=esm --outfile=prices-smoke.mjs --log-level=error
 *   node prices-smoke.mjs
 */

import { toSignal, mockProvider, type Bar } from "../packages/api/src/prices.js";

let bad = 0;
const near = (a: number | undefined, b: number, eps = 1e-9) =>
  a !== undefined && Math.abs(a - b) < eps;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
}

// A 40-bar ramp with exactly known closes: close[i] = 100 + i.
const ramp: Bar[] = Array.from({ length: 40 }, (_, i) => ({
  date: `2026-01-${String(i + 1).padStart(2, "0")}`,
  close: 100 + i,
  volume: 1_000_000,
}));
const s = toSignal("RAMP", ramp)!;

check("price is the last close", s.price === 139, `got ${s.price}`);
check("1d change = 1/138", near(s.change1d!, 1 / 138), `got ${s.change1d}`);
check("5d change = 5/134", near(s.change5d!, 5 / 134), `got ${s.change5d}`);
check("30d change = 30/109", near(s.change30d!, 30 / 109), `got ${s.change30d}`);
check("flat volume gives ratio 1", near(s.volumeRatio!, 1), `got ${s.volumeRatio}`);

// Too little history: the long-window fields must be absent, not zero.
const short = ramp.slice(-4);
const t = toSignal("SHORT", short)!;
check("short history keeps 1d", t.change1d !== undefined);
check("short history omits 5d", t.change5d === undefined);
check("short history omits 30d", t.change30d === undefined);
check("omitted fields are absent, not null", !("change30d" in t));

// A volume spike on the final bar, against a flat 1M baseline.
const spike = ramp.map((b, i) => (i === ramp.length - 1 ? { ...b, volume: 3_000_000 } : b));
const u = toSignal("SPIKE", spike)!;
check("3x spike reads as 3x", near(u.volumeRatio!, 3), `got ${u.volumeRatio}`);

// The baseline must exclude the latest bar, or a spike dilutes its own measure.
check("spike excluded from its own baseline", u.volumeRatio! > 2.9);

check("empty bars yield no signal", toSignal("NONE", []) === null);
check("non-positive price yields no signal",
  toSignal("ZERO", [{ date: "2026-01-01", close: 0, volume: 1 }]) === null);

// The mock provider has to be stable across calls or portfolios drift.
const a = await mockProvider.fetchBars("AAPL");
const b = await mockProvider.fetchBars("AAPL");
check("mock is deterministic", JSON.stringify(a) === JSON.stringify(b));
check("mock differs by ticker",
  JSON.stringify(a) !== JSON.stringify(await mockProvider.fetchBars("MSFT")));
check("mock prices are all positive", a.every((x) => x.close > 0));
check("mock yields a complete signal", toSignal("AAPL", a)?.change30d !== undefined);

console.log(bad ? `\n${bad} check(s) failed` : "\nall price checks passed");
process.exit(bad ? 1 : 0);
