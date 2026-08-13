/**
 * Perft for Pawnageddon's move generator.
 *
 * Chess is the one part of this game with a published right answer, so it gets
 * checked against one. Each position below is a standard perft position and
 * each count is the accepted node count for it; a generator that agrees with
 * all of them at these depths has castling, en passant, promotion, pins and
 * discovered check right, because that is what these positions exist to catch.
 *
 *   npx esbuild tools/pawnageddon-perft.mts --bundle --platform=node \
 *     --format=esm --packages=external --outfile=pg-perft.mjs --log-level=error \
 *     && node pg-perft.mjs
 *
 * Pass `--deep` for the slow tier (initial depth 5, ~4.9M nodes). CI runs the
 * default tier; the deep one is for when the generator is actually touched.
 */

import { fromFen, initialPosition, perft, type Position } from "../packages/ui/src/modules/pawnageddon/position";

interface Case {
  name: string;
  pos: Position;
  /** Node counts by depth, starting at depth 1. */
  expect: number[];
  deep?: number[];
}

const CASES: Case[] = [
  {
    name: "initial position",
    pos: initialPosition(),
    expect: [20, 400, 8902, 197281],
    deep: [4865609],
  },
  {
    // Castling, en passant and pins that the opening position never reaches.
    name: "kiwipete",
    pos: fromFen("r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -"),
    expect: [48, 2039, 97862],
  },
  {
    // A sparse endgame that leans hard on en passant and rook geometry.
    name: "position 3",
    pos: fromFen("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - -"),
    expect: [14, 191, 2812, 43238],
  },
  {
    // Promotions, including under-promotion. This is the position whose depth-3
    // count exposed the en-passant simulation bug described in moves.ts: the
    // original generator returned 9466 here, one legal knight move short.
    name: "position 4 (promotions)",
    pos: fromFen("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq -"),
    expect: [6, 264, 9467],
  },
  {
    name: "position 5",
    pos: fromFen("rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ -"),
    expect: [44, 1486, 62379],
  },
];

const deep = process.argv.includes("--deep");
const failures: string[] = [];

for (const c of CASES) {
  const depths = deep && c.deep ? [...c.expect, ...c.deep] : c.expect;
  for (let d = 1; d <= depths.length; d++) {
    const started = Date.now();
    const got = perft(c.pos, d);
    const want = depths[d - 1];
    const ok = got === want;
    const ms = Date.now() - started;
    const label = `${c.name} — depth ${d}`;
    console.log(
      ok
        ? `  ok    ${label}: ${got.toLocaleString()} nodes (${ms}ms)`
        : ` FAIL  ${label}: got ${got.toLocaleString()}, want ${want.toLocaleString()}`
    );
    if (!ok) failures.push(label);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} perft check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nall perft checks passed");
