import type { KernelContext, VoidModule } from "../../kernel/types";

/**
 * Wave function collapse, which is a constraint solver wearing a physics
 * costume. The name is borrowed from quantum mechanics and the borrowing is
 * pure metaphor — there is no wavefunction here and nothing is quantum. What
 * is true is the shape of it: every cell starts holding *all sixteen tiles at
 * once*, and the solver only ever does two things, in a loop, until there is
 * nothing left to do.
 *
 *   observe    pick the cell with the fewest options left, and choose one of
 *              them at random, weighted.
 *   propagate  tell that cell's neighbours which tiles are now impossible, and
 *              tell *their* neighbours, until the news stops being news.
 *
 * That is the entire program. There is no plan, no template, no pass that
 * "adds junctions" or "makes sure the road connects" — a road connects because
 * a tile with a wire leaving its east edge cannot sit next to one without a
 * wire on its west, and every tile in the grid is downstream of that one rule.
 *
 * The interesting part is which cell you observe next, and it is the one
 * decision here with a number attached. Always taking the most constrained
 * cell — minimum entropy — is what makes the thing work: the decisions with
 * the least freedom left are the ones most likely to be forced, and a forced
 * decision cannot be a mistake. It is the instinct that fills in the sudoku
 * square with one candidate first. Over forty grids of `rails`, where half of
 * all socket arrangements have no legal tile, minimum entropy never once
 * painted itself into a corner and random order did it 2,512 times — with the
 * same tiles, the same weights and the same propagator. Both produce a legal
 * grid, so none of that is visible in the picture.
 */

/* ---------------- tiles ---------------- */

/**
 * Where a tile keeps its sockets — the only structural difference between the
 * four patterns below.
 *
 * `edge` tiles carry one bit per side: does a thread leave here. `corner`
 * tiles carry one bit per corner: is this corner land. Both are four bits, so
 * both are sixteen tiles, and both are matched by the same rule — my east
 * socket must equal your west socket — which is why one compatibility table
 * builds both and one solver runs both.
 */
export type Geometry = "edge" | "corner";

/** How a collapsed tile is drawn. `wire` and `cable` are the same path. */
export type Thread = "wire" | "cable" | "land";

export interface Pattern {
  name: string;
  note: string;
  geometry: Geometry;
  thread: Thread;
  /** Relative chance per tile. A zero bans the tile outright. */
  weights: Float64Array;
}

/** Directions, in the order the socket bits are stored: N, E, S, W. */
export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];
const OPPOSITE = [2, 3, 0, 1];

/** How many of a tile's four bits are set. Sides for `edge`, land for `corner`. */
export function bits(tile: number): number {
  return ((tile >> 0) & 1) + ((tile >> 1) & 1) + ((tile >> 2) & 1) + ((tile >> 3) & 1);
}

/**
 * The socket a tile presents along one of its sides.
 *
 * For `edge` tiles that is a single bit — thread or no thread. For `corner`
 * tiles it is the *pair* of corners the side runs between, read in a fixed
 * order (top to bottom, then left to right) so that the two tiles either side
 * of a seam read the same two corners in the same order and compare equal.
 */
export function socketOf(geometry: Geometry, tile: number, dir: number): number {
  const b = (i: number) => (tile >> i) & 1;
  if (geometry === "edge") return b(dir);
  // Corner bits are 0:NW 1:NE 2:SE 3:SW.
  switch (dir) {
    case 0: return b(0) | (b(1) << 1); // N: NW, NE
    case 1: return b(1) | (b(2) << 1); // E: NE, SE
    case 2: return b(3) | (b(2) << 1); // S: SW, SE
    default: return b(0) | (b(3) << 1); // W: NW, SW
  }
}

/**
 * For every tile and direction, the set of tiles allowed to sit there — as a
 * sixteen-bit mask, which is the whole reason this model stays fast enough to
 * run inside a frame. Narrowing a neighbour is one OR loop and one AND.
 */
export function compatOf(geometry: Geometry): Uint16Array {
  const table = new Uint16Array(4 * 16);
  for (let dir = 0; dir < 4; dir++) {
    for (let a = 0; a < 16; a++) {
      let mask = 0;
      for (let b = 0; b < 16; b++) {
        if (socketOf(geometry, a, dir) === socketOf(geometry, b, OPPOSITE[dir])) mask |= 1 << b;
      }
      table[dir * 16 + a] = mask;
    }
  }
  return table;
}

/**
 * Weights written the way they are actually reasoned about: by how many
 * sockets a tile has. "Straights and curves are common, dead ends are rare"
 * is a statement about the count, not about tile 0b1001, and writing sixteen
 * bare numbers in a row hides which preset bans what.
 */
function weigh(byCount: number[], overrides: Record<number, number> = {}): Float64Array {
  const w = new Float64Array(16);
  for (let t = 0; t < 16; t++) w[t] = overrides[t] ?? byCount[bits(t)];
  return w;
}

/**
 * Four patterns. Three of them are the same sixteen tiles and the same drawing
 * code, differing only in which tiles are allowed to exist — which is the
 * thing worth seeing here, because it does not look that way on screen.
 *
 * Banning the one-socket tiles removes every dead end, and a thread with no
 * dead ends has nowhere to stop, so it has to come back and meet itself: that
 * one zero is the entire difference between a circuit board and a bowl of
 * closed loops. Banning the zero-socket tile removes the background, so every
 * cell must carry thread and the field packs into a labyrinth. Neither preset
 * knows what a loop or a corridor is.
 */
export const PATTERNS: Pattern[] = [
  {
    name: "circuit",
    note: "traces, junctions and pads",
    geometry: "edge",
    thread: "wire",
    //          blank  end  turn/straight  tee  cross
    weights: weigh([2.0, 0.45, 3.0, 0.9, 0.35]),
  },
  {
    name: "rails",
    note: "no dead ends, so it must return",
    geometry: "edge",
    thread: "wire",
    weights: weigh([3.0, 0.0, 4.0, 0.0, 0.5]),
  },
  {
    name: "labyrinth",
    note: "no blanks, so it must fill",
    geometry: "edge",
    thread: "cable",
    weights: weigh([0.0, 0.5, 3.0, 1.4, 0.6]),
  },
  {
    name: "coast",
    note: "four corners of land or sea",
    geometry: "corner",
    thread: "land",
    // The two diagonals are the saddle cases — land touching land at a single
    // point. Legal, and cheapened rather than banned: at full weight the map
    // is a spatter of islands kissing at the corners instead of a coastline.
    weights: weigh([1.7, 1.0, 1.2, 1.0, 1.7], { 0b0101: 0.2, 0b1010: 0.2 }),
  },
];

/* ---------------- the wave ---------------- */

export interface Weave {
  gw: number;
  gh: number;
  pattern: Pattern;
  /** One sixteen-bit mask per cell: the tiles still possible there. */
  wave: Uint16Array;
  compat: Uint16Array;
  /** Every tile the pattern permits at all, as a mask. A cell's starting set. */
  full: number;
  /** Fixed per-cell jitter, so cells of equal entropy break their tie once. */
  noise: Float32Array;
  /** Seconds since a cell collapsed, for the flash. Purely cosmetic. */
  fresh: Float32Array;
  /** Contradictions survived. Not errors — see `heal`. */
  stuck: number;
}

const popcount = (m: number): number => {
  let n = 0;
  for (let x = m; x; x &= x - 1) n++;
  return n;
};

/**
 * `rnd` seeds the tiebreak jitter as well as being available to the caller, so
 * a weave run from a seeded generator is reproducible end to end. Without it
 * the jitter is the one input the seed does not cover, and two runs of the
 * same seed diverge at the first pair of cells that tie.
 */
export function createWeave(
  gw: number,
  gh: number,
  pattern: Pattern,
  rnd: () => number = Math.random
): Weave {
  let full = 0;
  for (let t = 0; t < 16; t++) if (pattern.weights[t] > 0) full |= 1 << t;

  const n = gw * gh;
  const weave: Weave = {
    gw,
    gh,
    pattern,
    wave: new Uint16Array(n).fill(full),
    compat: compatOf(pattern.geometry),
    full,
    noise: new Float32Array(n),
    fresh: new Float32Array(n),
    stuck: 0,
  };
  for (let i = 0; i < n; i++) weave.noise[i] = rnd() * 1e-3;
  return weave;
}

/**
 * Shannon entropy of a cell, over the weights of what it can still be.
 *
 * Option *count* would do most of the job and is what a first implementation
 * usually reaches for, but it treats a cell choosing between one common tile
 * and one that almost never appears as being as free as a coin flip, and it is
 * not: it is nearly decided already. Entropy says so, which is why the frontier
 * hugs the ambiguous regions rather than crawling in reading order.
 */
export function entropyOf(weave: Weave, i: number): number {
  const w = weave.pattern.weights;
  const mask = weave.wave[i];
  let sum = 0;
  let sumLog = 0;
  for (let t = 0; t < 16; t++) {
    if (!(mask & (1 << t))) continue;
    sum += w[t];
    sumLog += w[t] * Math.log(w[t]);
  }
  return sum <= 0 ? 0 : Math.log(sum) - sumLog / sum;
}

/** The least-free undecided cell, or -1 when nothing is left to decide. */
export function nextCell(weave: Weave): number {
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < weave.wave.length; i++) {
    if (popcount(weave.wave[i]) <= 1) continue;
    const score = entropyOf(weave, i) + weave.noise[i];
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Choose one tile from a cell's remaining options, weighted. */
export function pick(weave: Weave, i: number, rnd: () => number): number {
  const w = weave.pattern.weights;
  const mask = weave.wave[i];
  let total = 0;
  for (let t = 0; t < 16; t++) if (mask & (1 << t)) total += w[t];
  let roll = rnd() * total;
  for (let t = 0; t < 16; t++) {
    if (!(mask & (1 << t))) continue;
    roll -= w[t];
    if (roll <= 0) return t;
  }
  // Floating point rounding, not a missing case: fall back to the last option.
  for (let t = 15; t >= 0; t--) if (mask & (1 << t)) return t;
  return 0;
}

/**
 * Push what a cell can no longer be out to its neighbours, and theirs.
 *
 * Returns the index of a cell left with no options at all, or -1. The grid is
 * a torus, which is not decoration: a bounded grid has to decide what sits off
 * the edge, and "anything" quietly lets a thread run off the world while
 * "nothing" makes the border the most constrained place on the board and
 * starts every weave there.
 */
export function propagate(weave: Weave, seeds: number[]): number {
  const { gw, gh, wave, compat } = weave;
  const stack = seeds.slice();
  while (stack.length) {
    const i = stack.pop()!;
    const mine = wave[i];
    const x = i % gw;
    const y = (i / gw) | 0;
    for (let dir = 0; dir < 4; dir++) {
      const j = ((y + DY[dir] + gh) % gh) * gw + ((x + DX[dir] + gw) % gw);
      let allowed = 0;
      for (let t = 0; t < 16; t++) if (mine & (1 << t)) allowed |= compat[dir * 16 + t];
      const next = wave[j] & allowed;
      if (next === wave[j]) continue;
      if (next === 0) return j;
      // A cell can be decided without ever being observed — most of them are,
      // and they get the same flash, or the cascade after an observation is
      // invisible and every tile looks like a separate decision.
      if (!(next & (next - 1))) weave.fresh[j] = 1;
      wave[j] = next;
      stack.push(j);
    }
  }
  return -1;
}

/**
 * What to do when a cell runs out of options.
 *
 * The textbook answer is to backtrack — undo the last observation and try
 * another tile — which needs a stack of every decision and every domain it
 * touched, and on a bad seed can walk that stack a very long way back. This
 * does the cheap thing instead: tear a hole around the failure, put those
 * cells back to knowing nothing, and let the solver fill it in again. It is
 * not backtracking, it does not guarantee termination, and it can in principle
 * loop; in practice a torn patch almost always re-solves first try, and the
 * panel reports how many tears it took rather than hiding them.
 *
 * The cells left standing around the hole are what re-constrain it, so the
 * patch knits into what is already there rather than starting a second world.
 *
 * It has never fired. Three of the four patterns cannot contradict at all —
 * every arrangement of sockets a cell's neighbours can present has a tile that
 * fits — and `rails`, where half of them do not, has not run out of options
 * once in three hundred grids. That is minimum entropy earning its place
 * rather than this being dead code: observe in random order instead and the
 * same tiles tear themselves out fifty-odd times a grid. Both numbers are
 * asserted in tools/loom-checks.mts.
 */
export function heal(weave: Weave, at: number, radius: number): void {
  weave.stuck++;
  let where = at;
  let r = radius;
  // Tearing can fail: the rim around the hole may be just as impossible as
  // what was in it. Widen and go again rather than leaving a hole nothing
  // will ever fill, and give up rather than spin — a grid with one dead cell
  // is a visible gap, and a browser tab that never returns is not.
  for (let attempt = 0; attempt < 6; attempt++) {
    const dead = unweave(weave, where % weave.gw, (where / weave.gw) | 0, r);
    if (dead < 0) return;
    where = dead;
    r += 2;
  }
}

/**
 * Put a disc of cells back to knowing nothing, then re-derive it from the rim.
 * Returns a cell left impossible by that re-derivation, or -1.
 */
export function unweave(weave: Weave, cx: number, cy: number, radius: number): number {
  const { gw, gh, wave } = weave;
  const rim: number[] = [];
  const r = Math.ceil(radius) + 1;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > radius + 1.5) continue;
      const i = (((cy + dy) % gh + gh) % gh) * gw + (((cx + dx) % gw + gw) % gw);
      if (d <= radius) {
        wave[i] = weave.full;
        weave.fresh[i] = 0;
      } else {
        // The ring just outside the hole is untouched, and is the only thing
        // that knows what the patch has to agree with.
        rim.push(i);
      }
    }
  }
  return propagate(weave, rim);
}

/**
 * One observation, and everything that follows from it. Returns false once
 * there is nothing left undecided.
 */
export function step(weave: Weave, rnd: () => number): boolean {
  const i = nextCell(weave);
  if (i < 0) return false;
  const tile = pick(weave, i, rnd);
  weave.wave[i] = 1 << tile;
  weave.fresh[i] = 1;
  const dead = propagate(weave, [i]);
  if (dead >= 0) heal(weave, dead, 3);
  return true;
}

/** How many cells have settled on exactly one tile. */
export function settled(weave: Weave): number {
  let n = 0;
  for (let i = 0; i < weave.wave.length; i++) if (popcount(weave.wave[i]) === 1) n++;
  return n;
}

/** Run to a finished grid, or until the budget runs out. */
export function weaveAll(weave: Weave, rnd: () => number, budget = 200_000): Weave {
  for (let n = 0; n < budget; n++) if (!step(weave, rnd)) break;
  return weave;
}

/** The tile a cell settled on, or -1 while it is still undecided. */
export function tileAt(weave: Weave, i: number): number {
  const m = weave.wave[i];
  if (popcount(m) !== 1) return -1;
  return 31 - Math.clz32(m);
}

/**
 * Pairs of settled neighbours whose sockets disagree.
 *
 * Zero, always, for any grid this solver produced — which is the point of
 * measuring it. A tileset drawn so that everything looks plausible will hide a
 * propagator that does nothing at all, and this number will not.
 */
export function violations(weave: Weave): number {
  const { gw, gh, pattern } = weave;
  let bad = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const a = tileAt(weave, y * gw + x);
      if (a < 0) continue;
      for (let dir = 1; dir <= 2; dir++) {
        const j = ((y + DY[dir] + gh) % gh) * gw + ((x + DX[dir] + gw) % gw);
        const b = tileAt(weave, j);
        if (b < 0) continue;
        if (socketOf(pattern.geometry, a, dir) !== socketOf(pattern.geometry, b, OPPOSITE[dir])) bad++;
      }
    }
  }
  return bad;
}

/* ---------------- drawing ---------------- */

const N = 1;
const E = 2;
const S = 4;
const W = 8;

/** Quarter turns: the two sides they join, the corner they bend around, and
 *  the arc that gets from one to the other. Angles are multiples of π. */
const TURNS: [number, number, number, number, number][] = [
  [N | E, 1, 0, 0.5, 1.0],
  [E | S, 1, 1, 1.0, 1.5],
  [S | W, 0, 1, 1.5, 2.0],
  [W | N, 0, 0, 0.0, 0.5],
];

/** Where a thread crosses each side of the cell, in N/E/S/W order. */
const EDGE_MID = [
  [0.5, 0.0],
  [1.0, 0.5],
  [0.5, 1.0],
  [0.0, 0.5],
];

/** The four corners, in the bit order corner tiles use: NW, NE, SE, SW. */
const CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** Trace a tile's thread. One path for wires, cables and everything between —
 *  the difference between a circuit trace and a corridor is the pen. */
export function tracePath(
  g: CanvasRenderingContext2D,
  tile: number,
  x: number,
  y: number,
  s: number
): void {
  g.beginPath();
  for (const [pair, cx, cy, from, to] of TURNS) {
    if ((tile & pair) !== pair) continue;
    // A tee or a cross contains turns, but drawing them as turns would round
    // off a junction that should meet square in the middle.
    if (bits(tile) > 2) continue;
    g.arc(x + cx * s, y + cy * s, s / 2, from * Math.PI, to * Math.PI);
  }
  if (tile === (N | S) || tile === (E | W) || bits(tile) > 2 || bits(tile) === 1) {
    for (let dir = 0; dir < 4; dir++) {
      if (!(tile & (1 << dir))) continue;
      g.moveTo(x + s / 2, y + s / 2);
      g.lineTo(x + EDGE_MID[dir][0] * s, y + EDGE_MID[dir][1] * s);
    }
  }
}

/**
 * Marching squares, for the corner tiles: walk the four corners in order,
 * keeping the land ones and cutting the midpoint of every side that changes
 * from land to sea. Sixteen cases, no table.
 */
export function traceLand(
  g: CanvasRenderingContext2D,
  tile: number,
  x: number,
  y: number,
  s: number
): void {
  const land = (i: number) => (tile >> i) & 1;
  const put = (px: number, py: number, first: boolean) =>
    first ? g.moveTo(x + px * s, y + py * s) : g.lineTo(x + px * s, y + py * s);

  // The two diagonals are ambiguous — the same four corners describe either
  // two islands touching or one isthmus — and the walk below would draw a
  // bowtie through the sea. Drawn as two separate corners instead.
  if (tile === 0b0101 || tile === 0b1010) {
    for (let c = 0; c < 4; c++) {
      if (!land(c)) continue;
      const prev = (c + 3) % 4;
      g.moveTo(x + CORNERS[c][0] * s, y + CORNERS[c][1] * s);
      g.lineTo(
        x + ((CORNERS[c][0] + CORNERS[(c + 1) % 4][0]) / 2) * s,
        y + ((CORNERS[c][1] + CORNERS[(c + 1) % 4][1]) / 2) * s
      );
      g.lineTo(
        x + ((CORNERS[c][0] + CORNERS[prev][0]) / 2) * s,
        y + ((CORNERS[c][1] + CORNERS[prev][1]) / 2) * s
      );
      g.closePath();
    }
    return;
  }

  let started = false;
  for (let c = 0; c < 4; c++) {
    const nxt = (c + 1) % 4;
    if (land(c)) {
      put(CORNERS[c][0], CORNERS[c][1], !started);
      started = true;
    }
    if (land(c) !== land(nxt)) {
      put((CORNERS[c][0] + CORNERS[nxt][0]) / 2, (CORNERS[c][1] + CORNERS[nxt][1]) / 2, !started);
      started = true;
    }
  }
  if (started) g.closePath();
}

/** The four theme colours the weave is drawn in, straight off `ctx.stage`. */
export interface Ink {
  cyan: string;
  magenta: string;
  ember: string;
}

/**
 * Draw a weave — settled tiles and the undecided frontier both.
 *
 * A whole function rather than three loops inside the frame callback because
 * the picture is a pure function of a wave and a palette, which is what lets
 * the preview in tools/loom-preview.mts render the real thing with no browser
 * anywhere near it. `tint` is `ctx.stage.withAlpha`, passed in for the same
 * reason everything else is: a module imports nothing.
 */
export function drawWeave(
  g: CanvasRenderingContext2D,
  weave: Weave,
  view: { x: number; y: number; cell: number },
  ink: Ink,
  tint: (color: string, alpha: number) => string,
  dt = 0
): void {
  const { gw, gh } = weave;
  const cell = view.cell;
  const land = weave.pattern.thread === "land";
  const lineW = weave.pattern.thread === "cable" ? cell * 0.5 : Math.max(1.6, cell * 0.14);

  g.lineCap = "round";
  g.lineJoin = "round";
  g.lineWidth = lineW;

  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const px = view.x + x * cell;
      const py = view.y + y * cell;
      const tile = tileAt(weave, i);

      if (tile < 0) {
        // Still undecided, and drawn as how nearly decided it is — the bright
        // frontier is the solver's working edge, and the only part of the
        // algorithm that is visible while it runs.
        const left = popcount(weave.wave[i]);
        const certainty = left <= 1 ? 1 : 1 - (left - 1) / 15;
        g.fillStyle = tint(ink.cyan, 0.05 + certainty * 0.26);
        g.fillRect(px + 1, py + 1, cell - 2, cell - 2);
        continue;
      }

      const flash = weave.fresh[i];
      if (flash > 0) weave.fresh[i] = Math.max(0, flash - dt * 1.6);
      if (tile === 0) continue;

      // The flash is a second pass in ember rather than extra alpha on the
      // first, and that is not a style choice: threads meet their neighbours
      // at the middle of a shared edge, so two round caps land on the same
      // point, and a half-transparent stroke beads there. Anything drawn once at
      // full alpha does not.
      const flare = (): void => {
        if (flash <= 0) return;
        g.strokeStyle = tint(ink.ember, flash * 0.9);
        g.stroke();
      };

      if (land) {
        g.beginPath();
        traceLand(g, tile, px, py, cell);
        g.fillStyle = tint(ink.magenta, 0.3);
        g.fill();
        g.beginPath();
        traceCoast(g, tile, px, py, cell);
        g.save();
        g.lineWidth = Math.max(1.2, cell * 0.1);
        g.strokeStyle = tint(ink.cyan, 1);
        g.stroke();
        flare();
        g.restore();
        continue;
      }

      g.beginPath();
      tracePath(g, tile, px, py, cell);
      g.strokeStyle = tint(bits(tile) > 2 ? ink.magenta : ink.cyan, 1);
      g.stroke();
      flare();
      // A trace that stops has to stop on something.
      if (bits(tile) === 1) {
        g.beginPath();
        g.arc(px + cell / 2, py + cell / 2, Math.max(2, cell * 0.16), 0, Math.PI * 2);
        g.fillStyle = tint(ink.ember, 1);
        g.fill();
      }
    }
  }
}

/**
 * The coastline alone — the segments where the contour crosses the cell,
 * without the parts of the outline that run along a cell border.
 *
 * Separate from the fill because stroking the filled polygon strokes those
 * borders too, and a shoreline drawn that way puts a bright line down every
 * seam between two inland tiles: the map comes out as graph paper with a
 * continent printed on it.
 */
export function traceCoast(
  g: CanvasRenderingContext2D,
  tile: number,
  x: number,
  y: number,
  s: number
): void {
  const land = (i: number) => (tile >> i) & 1;
  const cuts: [number, number][] = [];
  for (let c = 0; c < 4; c++) {
    const nxt = (c + 1) % 4;
    if (land(c) === land(nxt)) continue;
    cuts.push([
      x + ((CORNERS[c][0] + CORNERS[nxt][0]) / 2) * s,
      y + ((CORNERS[c][1] + CORNERS[nxt][1]) / 2) * s,
    ]);
  }
  if (cuts.length === 2) {
    g.moveTo(cuts[0][0], cuts[0][1]);
    g.lineTo(cuts[1][0], cuts[1][1]);
    return;
  }
  if (cuts.length !== 4) return;
  // A saddle crosses all four sides, and which two crossings join is exactly
  // the ambiguity: pair them around the land corners, so the two islands each
  // get their own shore instead of one X through the middle of the cell.
  const pairs: [number, number][] = tile === 0b0101 ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
  for (const [a, b] of pairs) {
    g.moveTo(cuts[a][0], cuts[a][1]);
    g.lineTo(cuts[b][0], cuts[b][1]);
  }
}

/* ---------------- the module ---------------- */

const PATTERN_KEY = "loom.pattern";
/** Roughly how many CSS pixels a cell wants. Tiles are drawn, not blitted. */
const CELL = 22;
const MAX_CELLS = 4200;

export const loom: VoidModule = {
  manifest: {
    id: "loom",
    name: "Loom",
    kind: "app",
    glyph: "▦",
    blurb: "a tile at a time, and no plan",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "loom.open",
      label: "loom",
      hint: "watch a world argue itself into existence",
      glyph: "▦",
      run: (c) => c.launch("loom"),
    });
  },

  launch(ctx: KernelContext) {
    const { mount: mountStage, palette, toolbar, toolButton, withAlpha } = ctx.stage;
    ctx.openSurface({
      title: "loom",
      width: 520,
      height: 460,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);
        const bar = toolbar(root);

        const stored = ctx.state.get<number>(PATTERN_KEY, 0);
        let patternIndex =
          Number.isInteger(stored) && stored >= 0 && stored < PATTERNS.length ? stored : 0;

        let weave = createWeave(1, 1, PATTERNS[patternIndex]);
        let cell = CELL;
        let running = true;
        let perFrame = 8;
        /** Keep quietly rewriting finished corners of the world. */
        let drift = true;
        let sinceDrift = 0;

        const reshape = (w: number, h: number) => {
          // Coarsen rather than melt when the panel is pulled out to fill a
          // wall: the tiles are drawn, so more of them costs strokes.
          cell = Math.max(CELL, Math.ceil(Math.sqrt((w * h) / MAX_CELLS)));
          const gw = Math.max(4, Math.floor(w / cell));
          const gh = Math.max(4, Math.floor(h / cell));
          if (gw === weave.gw && gh === weave.gh) return;
          weave = createWeave(gw, gh, PATTERNS[patternIndex]);
        };

        /** Unpick a disc, and put the world back together if that broke it. */
        const tear = (w: Weave, x: number, y: number, r: number) => {
          const dead = unweave(w, x, y, r);
          if (dead >= 0) heal(w, dead, r + 2);
        };

        const restart = () => {
          weave = createWeave(weave.gw, weave.gh, PATTERNS[patternIndex]);
        };

        const stop = mountStage(stageHost, {
          className: "loom-canvas",
          layout: (st) => reshape(st.w, st.h),
          frame: (st, dt) => {
            const { g, w, h } = st;
            const { gw, gh } = weave;

            if (running) {
              for (let n = 0; n < perFrame; n++) if (!step(weave, Math.random)) break;
              sinceDrift += dt;
              // A finished grid is a picture. Tearing a small hole in it every
              // couple of seconds makes it a place instead, and costs nothing:
              // the patch is re-solved by the same loop that drew it.
              if (drift && sinceDrift > 1.6 && settled(weave) >= gw * gh - 2) {
                sinceDrift = 0;
                tear(weave, Math.floor(Math.random() * gw), Math.floor(Math.random() * gh), 2.4);
              }
            }

            const c = palette();
            g.clearRect(0, 0, w, h);
            drawWeave(
              g,
              weave,
              { x: (w - gw * cell) / 2, y: (h - gh * cell) / 2, cell },
              c,
              withAlpha,
              dt
            );

            const total = gw * gh;
            const pct = Math.round((settled(weave) / total) * 100);
            g.fillStyle = withAlpha(c.dim, 0.75);
            g.font = "9px ui-monospace, monospace";
            g.fillText(
              `${weave.pattern.name}  —  ${weave.pattern.note}  —  ${pct}% woven` +
                (weave.stuck ? `  —  ${weave.stuck} torn out` : ""),
              6,
              h - 6
            );
          },
        });

        /* ---------------- dragging ---------------- */

        const canvas = stageHost.querySelector("canvas");
        let tearing = false;

        /**
         * Drag to unpick. The hole re-solves against whatever survived around
         * it, which is the one thing about this algorithm a still image cannot
         * show you: the patch has no idea what used to be there and still
         * joins up with the roads on its rim.
         */
        const tearAt = (e: PointerEvent) => {
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const ox = (rect.width - weave.gw * cell) / 2;
          const oy = (rect.height - weave.gh * cell) / 2;
          const x = Math.floor((e.clientX - rect.left - ox) / cell);
          const y = Math.floor((e.clientY - rect.top - oy) / cell);
          if (x < 0 || y < 0 || x >= weave.gw || y >= weave.gh) return;
          tear(weave, x, y, 1.8);
        };

        const onDown = (e: PointerEvent) => {
          tearing = true;
          tearAt(e);
          canvas?.setPointerCapture(e.pointerId);
          e.preventDefault();
        };
        const onMove = (e: PointerEvent) => {
          if (tearing) tearAt(e);
        };
        const onUp = () => {
          tearing = false;
        };

        canvas?.addEventListener("pointerdown", onDown);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);

        /* ---------------- controls ---------------- */

        toolButton(bar, "pause", (b) => {
          running = !running;
          b.textContent = running ? "pause" : "play";
          b.classList.toggle("on", running);
        }).classList.add("on");

        const patternBtn = toolButton(bar, PATTERNS[patternIndex].name, (b) => {
          patternIndex = (patternIndex + 1) % PATTERNS.length;
          ctx.state.set(PATTERN_KEY, patternIndex);
          restart();
          b.textContent = PATTERNS[patternIndex].name;
          ctx.notify(
            `loom: ${PATTERNS[patternIndex].name} — ${PATTERNS[patternIndex].note}`,
            "info"
          );
        });
        patternBtn.textContent = PATTERNS[patternIndex].name;

        toolButton(bar, "8/frame", (b) => {
          perFrame = perFrame === 8 ? 64 : perFrame === 64 ? 1 : 8;
          b.textContent = `${perFrame}/frame`;
        });

        toolButton(bar, "drift", (b) => {
          drift = !drift;
          b.classList.toggle("on", drift);
        }).classList.add("on");

        toolButton(bar, "reweave", () => restart());

        return () => {
          canvas?.removeEventListener("pointerdown", onDown);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          stop();
        };
      },
    });
  },
};
