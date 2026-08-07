/**
 * Water: where it goes, and what it does to the ground on the way.
 *
 * The module shipped without any of this. Terrain came out of noise, thermal
 * erosion knocked the sharp edges off, and "water" was one flat plane at sea
 * level — which meant a lake above the waterline was not merely absent but
 * *unrepresentable*, and a river was not a thing the format could describe at
 * all. Everything below exists to fix that, in the order water actually works:
 *
 *   1. rain on it        — droplet erosion, which carves the valley network
 *   2. fill the holes    — priority flood, which is where lakes come from
 *   3. route the flow    — D8 accumulation, which is where rivers come from
 *   4. cut the channels  — rivers sit *in* the ground, not painted on it
 *
 * The order is the whole thing. Accumulate before eroding and the rivers run
 * down noise gradients instead of valleys, which reads as drainage sprayed
 * across a hillside at random. Fill before routing or half the map drains into
 * a pit and stops. Cut the channels last, because carving changes the heights
 * the earlier steps were computed from.
 */
import { rng } from "./noise";
import type { TerrainParams } from "./types";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export interface Lake {
  id: number;
  /** Normalised height of the water surface. */
  level: number;
  /** Cells covered. Used to throw out puddles, and shown in the UI. */
  area: number;
  /** Centroid in normalised map coordinates, so it can be labelled. */
  u: number;
  v: number;
}

export interface WaterField {
  size: number;
  /**
   * Water surface height per cell, or -1 where the cell is dry.
   *
   * One array for sea, lakes and rivers together, because every consumer —
   * the mesh builder, the atlas, the colouriser — asks the same question of
   * it ("is this wet, and if so at what height") and none of them care which
   * kind of water answered.
   */
  surface: Float32Array;
  /** Lake id per cell; -1 for dry land, river-only cells and the open sea. */
  lakeOf: Int32Array;
  /** Upstream drainage area, in cells. Raw — `river` is the useful form. */
  accum: Float32Array;
  /** River half-width in normalised map units. 0 where there is no river. */
  river: Float32Array;
  lakes: Lake[];
  /** Fraction of the map under water of any kind. Shown in the library. */
  wetFraction: number;
}

/* ------------------------------------------------------------------ */
/* A heap, because priority flood needs one                            */
/* ------------------------------------------------------------------ */

/**
 * Min-heap over (priority, cell), in two flat typed arrays.
 *
 * An array of `{p, i}` objects is the obvious version and it allocates one
 * object per push — several hundred thousand of them for a 256² fill, all
 * garbage, all during a slider drag. The pair-of-arrays form is uglier and
 * costs nothing.
 */
class MinHeap {
  private pri: Float32Array;
  private idx: Int32Array;
  private n = 0;

  constructor(capacity: number) {
    this.pri = new Float32Array(capacity);
    this.idx = new Int32Array(capacity);
  }

  get size(): number {
    return this.n;
  }

  push(priority: number, cell: number): void {
    if (this.n === this.pri.length) this.grow();
    let i = this.n++;
    this.pri[i] = priority;
    this.idx[i] = cell;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.pri[parent] <= this.pri[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  /** Pops the lowest cell; read `poppedPriority` for its height. */
  pop(): number {
    const top = this.idx[0];
    this.poppedPriority = this.pri[0];
    const last = --this.n;
    this.pri[0] = this.pri[last];
    this.idx[0] = this.idx[last];

    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let small = i;
      if (l < this.n && this.pri[l] < this.pri[small]) small = l;
      if (r < this.n && this.pri[r] < this.pri[small]) small = r;
      if (small === i) break;
      this.swap(small, i);
      i = small;
    }
    return top;
  }

  poppedPriority = 0;

  private swap(a: number, b: number): void {
    const p = this.pri[a];
    this.pri[a] = this.pri[b];
    this.pri[b] = p;
    const c = this.idx[a];
    this.idx[a] = this.idx[b];
    this.idx[b] = c;
  }

  private grow(): void {
    const pri = new Float32Array(this.pri.length * 2);
    pri.set(this.pri);
    this.pri = pri;
    const idx = new Int32Array(this.idx.length * 2);
    idx.set(this.idx);
    this.idx = idx;
  }
}

/* ------------------------------------------------------------------ */
/* 1. Rain                                                             */
/* ------------------------------------------------------------------ */

/**
 * Droplet erosion. This is the step that makes terrain look surveyed.
 *
 * Thermal erosion — the one that was already here — answers "what happens to
 * ground that is too steep to stand up". It produces plausible talus and
 * nothing else, which is why the old maps read as noise with the corners
 * sanded off: no amount of slumping will ever produce a *branching* valley,
 * because slumping is local and drainage networks are not.
 *
 * So: drop water on it and follow each drop downhill, carrying sediment. A
 * drop moving fast through steep ground picks material up; one slowing into a
 * basin puts it back down. Valleys deepen because water concentrates in them,
 * and they *branch* because the drop that carved this valley came from
 * somewhere slightly different to the one before. The dendritic pattern isn't
 * modelled anywhere below — it falls out.
 *
 * Erosion is spread over a small brush rather than applied to one cell. A
 * single-cell version cuts one-pixel slots that alias horribly at every mesh
 * resolution, and are visible as a fine dark hatching from the air.
 */
export function dropletErode(h: Float32Array, n: number, p: TerrainParams): void {
  if (p.rainfall <= 0) return;

  const r = rng(p.seed ^ 0x7f4a7c15);

  // Scaled with area so a 256² map is not eroded four times less thoroughly
  // than a 128² one — the droplet count is a *density*, not a budget.
  const drops = Math.round(n * n * 1.4 * p.rainfall);
  const maxSteps = 56;

  const inertia = 0.055;
  const capacityFactor = 3.4;
  const minSlope = 0.0009;
  const depositRate = 0.28;
  const erodeRate = 0.34 * p.rainfall;
  const evaporation = 0.017;
  const gravity = 6;

  // Brush weights, precomputed once. Radius 2 is the smallest that stops the
  // one-pixel-slot artefact without visibly blurring ridgelines.
  const radius = 2;
  const bdx: number[] = [];
  const bdy: number[] = [];
  const bw: number[] = [];
  let brushSum = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      const w = 1 - d / radius;
      bdx.push(dx);
      bdy.push(dy);
      bw.push(w);
      brushSum += w;
    }
  }
  for (let i = 0; i < bw.length; i++) bw[i] /= brushSum;

  for (let drop = 0; drop < drops; drop++) {
    let x = r() * (n - 1);
    let y = r() * (n - 1);
    let dirX = 0;
    let dirY = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;

    for (let step = 0; step < maxSteps; step++) {
      const xi = Math.min(n - 2, Math.max(0, Math.floor(x)));
      const yi = Math.min(n - 2, Math.max(0, Math.floor(y)));
      const fx = x - xi;
      const fy = y - yi;
      const i00 = yi * n + xi;
      const nw = h[i00];
      const ne = h[i00 + 1];
      const sw = h[i00 + n];
      const se = h[i00 + n + 1];

      // Bilinear height and its analytic gradient. Sampling neighbours instead
      // would quantise the drop's direction to eight compass points, and eight
      // compass points is exactly how you get drainage that runs in visible
      // diagonal stripes across the plains.
      const height =
        nw * (1 - fx) * (1 - fy) + ne * fx * (1 - fy) + sw * (1 - fx) * fy + se * fx * fy;
      const gx = (ne - nw) * (1 - fy) + (se - sw) * fy;
      const gy = (sw - nw) * (1 - fx) + (se - ne) * fx;

      // Inertia blends the old heading with the new gradient, so a drop with
      // momentum crosses a shallow saddle instead of stopping dead in it.
      dirX = dirX * inertia - gx * (1 - inertia);
      dirY = dirY * inertia - gy * (1 - inertia);
      const len = Math.hypot(dirX, dirY);
      if (len < 1e-7) break;
      dirX /= len;
      dirY /= len;

      const nx = x + dirX;
      const ny = y + dirY;
      if (nx < 1 || nx >= n - 2 || ny < 1 || ny >= n - 2) break;

      const nxi = Math.floor(nx);
      const nyi = Math.floor(ny);
      const nfx = nx - nxi;
      const nfy = ny - nyi;
      const j00 = nyi * n + nxi;
      const newHeight =
        h[j00] * (1 - nfx) * (1 - nfy) +
        h[j00 + 1] * nfx * (1 - nfy) +
        h[j00 + n] * (1 - nfx) * nfy +
        h[j00 + n + 1] * nfx * nfy;
      const delta = newHeight - height;

      // Capacity is proportional to how fast and how steeply the drop is
      // moving, and to how much water is left in it. `minSlope` keeps a drop
      // crossing genuinely flat ground from having zero capacity and dumping
      // its whole load in one cell, which shows up as a pimple on a plain.
      const capacity = Math.max(-delta, minSlope) * speed * water * capacityFactor;

      if (sediment > capacity || delta > 0) {
        // Uphill: settle into the pit rather than climb out of it.
        //
        // The textbook version deposits `min(delta, sediment)` — exactly
        // enough to level the drop with the cell it came from, so the next
        // drop rolls straight through. That is the correct way to guarantee
        // every drop reaches the sea, and it is also why the first build of
        // this had no lakes: over a hundred thousand drops it methodically
        // erases every closed basin on the map. Depositing a fraction leaves
        // the basins shallower but intact, which is what the flood below then
        // finds and fills.
        const drop2 =
          delta > 0 ? Math.min(delta, sediment) * 0.5 : (sediment - capacity) * depositRate;
        sediment -= drop2;
        // Deposit bilinearly, for the same reason the height is read that way.
        h[i00] += drop2 * (1 - fx) * (1 - fy);
        h[i00 + 1] += drop2 * fx * (1 - fy);
        h[i00 + n] += drop2 * (1 - fx) * fy;
        h[i00 + n + 1] += drop2 * fx * fy;
      } else {
        const take = Math.min((capacity - sediment) * erodeRate, -delta);
        for (let b = 0; b < bw.length; b++) {
          const bx = xi + bdx[b];
          const by = yi + bdy[b];
          if (bx < 0 || bx >= n || by < 0 || by >= n) continue;
          const cell = by * n + bx;
          const amount = take * bw[b];
          h[cell] -= amount;
          sediment += amount;
        }
      }

      speed = Math.sqrt(Math.max(0, speed * speed + -delta * gravity));
      water *= 1 - evaporation;
      if (water < 0.012) break;

      x = nx;
      y = ny;
    }
  }
}

/** Stretch back to 0..1, so sea level keeps meaning the same thing. */
function renormalise(h: Float32Array): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < h.length; i++) {
    if (h[i] < lo) lo = h[i];
    if (h[i] > hi) hi = h[i];
  }
  const span = hi - lo || 1;
  for (let i = 0; i < h.length; i++) h[i] = (h[i] - lo) / span;
}

/* ------------------------------------------------------------------ */
/* 2. Lakes                                                            */
/* ------------------------------------------------------------------ */

interface Flooded {
  /** Height each cell's water would stand at. Above `h` means submerged. */
  filled: Float32Array;
  /**
   * The same fill, but with every cell nudged strictly above its predecessor.
   *
   * Routing needs this and lake levels must not use it. A filled basin is
   * dead flat by construction, and D8 on dead flat ground has no downhill
   * neighbour to pick — flow arrives at the lake and stops, so every river
   * upstream of any lake vanishes. The epsilon makes an imperceptible ramp
   * toward the outlet, which is enough for the router and far too small to
   * see. Using it for the lake surface instead would tilt every lake.
   */
  routed: Float32Array;
}

/**
 * Priority flood. Water rises from the edges of the map and fills every hole.
 *
 * The standard algorithm, and worth stating why it is the right one: the
 * naive approach is to look for local minima and raise them, which fails on
 * any basin bigger than one cell, then fails differently when you extend it to
 * regions because a basin's outlet may itself be inside another basin. Flooding
 * inward from the border handles nesting for free — a cell's water level is
 * simply the highest ground it had to climb over to get here, which is exactly
 * what the heap is computing.
 */
function fillDepressions(h: Float32Array, n: number): Flooded {
  const size = n * n;
  const filled = new Float32Array(size);
  const routed = new Float32Array(size);
  const seen = new Uint8Array(size);
  const heap = new MinHeap(Math.max(64, n * 4));

  // Seed with the border: water can always leave the map.
  for (let x = 0; x < n; x++) {
    for (const cell of [x, (n - 1) * n + x]) {
      if (seen[cell]) continue;
      seen[cell] = 1;
      filled[cell] = h[cell];
      routed[cell] = h[cell];
      heap.push(h[cell], cell);
    }
  }
  for (let y = 1; y < n - 1; y++) {
    for (const cell of [y * n, y * n + n - 1]) {
      if (seen[cell]) continue;
      seen[cell] = 1;
      filled[cell] = h[cell];
      routed[cell] = h[cell];
      heap.push(h[cell], cell);
    }
  }

  // Small enough to be invisible in a 16-bit height encoding, large enough
  // that a 256²-cell flat never accumulates its way back to a true tie.
  const epsilon = 1e-7;

  while (heap.size > 0) {
    const cell = heap.pop();
    const level = filled[cell];
    const routeLevel = routed[cell];
    const x = cell % n;
    const y = (cell / n) | 0;

    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
      const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
      if (nx < 0 || nx >= n || ny < 0 || ny >= n) continue;
      const nb = ny * n + nx;
      if (seen[nb]) continue;
      seen[nb] = 1;
      filled[nb] = Math.max(h[nb], level);
      routed[nb] = Math.max(h[nb], routeLevel + epsilon);
      heap.push(filled[nb], nb);
    }
  }

  return { filled, routed };
}

/* ------------------------------------------------------------------ */
/* 3. Rivers                                                           */
/* ------------------------------------------------------------------ */

/**
 * D8 flow accumulation: how much land drains through each cell.
 *
 * Every cell starts with its own square of rainfall and hands the total to its
 * steepest downhill neighbour. Processing in descending height order means a
 * cell's own total is final before it is ever read, so one pass is enough —
 * no iteration to convergence, no visited set.
 *
 * The sort is the expensive line here. It is also the reason this is a single
 * pass rather than the repeated-relaxation version, which at 256² is slower by
 * more than the sort costs.
 */
function accumulate(routed: Float32Array, n: number): { accum: Float32Array; down: Int32Array } {
  const size = n * n;
  const accum = new Float32Array(size).fill(1);
  const down = new Int32Array(size).fill(-1);

  const order = new Int32Array(size);
  for (let i = 0; i < size; i++) order[i] = i;
  // Descending: water flows from the top of the sort to the bottom.
  const sorted = Array.from(order).sort((a, b) => routed[b] - routed[a]);

  for (const cell of sorted) {
    const x = cell % n;
    const y = (cell / n) | 0;
    let best = -1;
    let bestDrop = 0;

    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= n) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= n) continue;
        const nb = ny * n + nx;
        // Per unit distance, or the router prefers diagonals purely because
        // they are longer, and every river on the map develops a 45° bias.
        const drop = (routed[cell] - routed[nb]) / (dx && dy ? 1.41421356 : 1);
        if (drop > bestDrop) {
          bestDrop = drop;
          best = nb;
        }
      }
    }

    down[cell] = best;
    if (best >= 0) accum[best] += accum[cell];
  }

  return { accum, down };
}

/* ------------------------------------------------------------------ */
/* The whole thing                                                     */
/* ------------------------------------------------------------------ */

/**
 * Erode, flood, route, carve. Mutates `h` — the ground really does change.
 *
 * Returns the water that resulted. The caller keeps both: the colouriser needs
 * to know a cell is a riverbed to paint it, the mesh builder needs the water
 * surface to build a second mesh at, and the atlas needs the river widths to
 * stroke them at.
 */
export function hydrology(h: Float32Array, n: number, p: TerrainParams): WaterField {
  dropletErode(h, n, p);

  // Erosion moves material about, so the field no longer spans exactly 0..1 —
  // deposition can push a valley floor above the old peak and scouring can cut
  // below the old floor. Re-stretching it matters for more than tidiness: sea
  // level is a *fraction* of the height range, so a field that runs to 1.06
  // quietly means every map's waterline sits a few percent lower than the
  // slider says.
  //
  // Only when erosion actually ran. A city map's heights are absolute — they
  // encode real metres against a known relief — and stretching those to fill
  // the range would put Manhattan's street grid at four hundred metres.
  if (p.rainfall > 0) renormalise(h);

  const { filled, routed } = fillDepressions(h, n);
  const { accum } = accumulate(routed, n);

  const size = n * n;
  const surface = new Float32Array(size).fill(-1);
  const lakeOf = new Int32Array(size).fill(-1);
  const river = new Float32Array(size);

  /* ---------------- the sea ---------------- */

  for (let i = 0; i < size; i++) {
    if (h[i] < p.seaLevel) surface[i] = p.seaLevel;
  }

  /* ---------------- lakes ---------------- */

  // A cell is lake if the flood stood water on it and that water is above the
  // sea. The margin keeps numerical dust from painting a film of lake across
  // every flat plain on the map.
  const lakeFloor = 0.0016;
  const wet = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (filled[i] > h[i] + lakeFloor && filled[i] > p.seaLevel) wet[i] = 1;
  }

  const lakes: Lake[] = [];
  const stack: number[] = [];
  for (let start = 0; start < size; start++) {
    if (!wet[start] || lakeOf[start] >= 0) continue;

    const id = lakes.length;
    const level = filled[start];
    let area = 0;
    let su = 0;
    let sv = 0;

    stack.length = 0;
    stack.push(start);
    lakeOf[start] = id;

    while (stack.length) {
      const cell = stack.pop() as number;
      const x = cell % n;
      const y = (cell / n) | 0;
      area++;
      su += x;
      sv += y;
      surface[cell] = level;

      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
        const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < 0 || nx >= n || ny < 0 || ny >= n) continue;
        const nb = ny * n + nx;
        if (!wet[nb] || lakeOf[nb] >= 0) continue;
        // Same water body only if it is the same water level. Two basins that
        // touch at a rim are two lakes, and merging them would tilt one.
        if (Math.abs(filled[nb] - level) > 1e-5) continue;
        lakeOf[nb] = id;
        stack.push(nb);
      }
    }

    // Below this it is a puddle: too small to read as water from the air, and
    // large enough in aggregate to speckle every valley floor. A fraction of
    // the map rather than a cell count, so the same basin survives the cut at
    // every resolution.
    const minArea = Math.max(4, Math.round(size * 0.00012));
    if (area < minArea) {
      // Roll it back rather than leaving a labelled non-lake behind.
      for (let i = 0; i < size; i++) {
        if (lakeOf[i] === id) {
          lakeOf[i] = -1;
          if (h[i] >= p.seaLevel) surface[i] = -1;
        }
      }
      continue;
    }

    lakes.push({ id, level, area, u: su / area / (n - 1), v: sv / area / (n - 1) });
  }

  /* ---------------- rivers ---------------- */

  // Width goes as the square root of drainage area — Hack's law, roughly, and
  // more to the point it is the only mapping that keeps a trunk river visibly
  // wider than its tributaries without the headwaters disappearing entirely.
  //
  // Both constants are in *map* units, not cells. The first version divided
  // the width by `n`, which meant the same river on the same map was three
  // times wider at 96² than at 256² — detail is a rendering choice and it must
  // not change the geography. A trunk river here comes out around 0.4% of the
  // map's width: on a 240km province, a kilometre across.
  const threshold = size * (0.0022 / Math.max(0.15, p.riverDensity));
  const widthScale = 0.0016 * p.riverDensity;

  // Zero means *none*, not "a few".
  //
  // The `Math.max` floor above exists so a low density still gives trunk
  // rivers rather than dividing by nothing, and it also meant the setting
  // could never actually be turned off. That is fine on invented terrain and
  // wrong on a real coastline: New York's ground is smooth by construction, so
  // flow accumulation happily found drainage lines in the surface grain and
  // drew creeks across Queens, Newark and Staten Island — places that have
  // none, in a map whose entire claim is that its geography is real.
  if (p.riverDensity <= 0) {
    let wetOnly = 0;
    for (let i = 0; i < size; i++) if (surface[i] >= 0) wetOnly++;
    return {
      size: n,
      surface,
      lakeOf,
      accum,
      river,
      lakes,
      wetFraction: size ? wetOnly / size : 0,
    };
  }

  for (let i = 0; i < size; i++) {
    if (accum[i] < threshold) continue;
    // A river through a lake is the lake; through the sea it is nothing.
    if (surface[i] >= 0) continue;
    river[i] = Math.min(0.02, widthScale * Math.sqrt(accum[i] / threshold));
  }

  /* ---------------- channels ---------------- */

  // Rivers have to sit *in* the ground. Painting a blue line on an unmodified
  // hillside gives water running along a slope, which every eye catches
  // instantly even when it cannot say why. The cut is proportional to width so
  // a trunk river gets a real valley and a headwater gets a crease.
  //
  // Carving after routing is deliberate: doing it before would change the very
  // heights the flow was computed from, and the channels would wander off the
  // network they were cut for.
  const carved = h.slice();
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (river[i] <= 0) continue;
      const depth = river[i] * 14;
      const reach = Math.max(1, Math.round(river[i] * n * 1.6));
      for (let dy = -reach; dy <= reach; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= n) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= n) continue;
          const d = Math.hypot(dx, dy) / (reach + 0.5);
          if (d > 1) continue;
          const cell = ny * n + nx;
          // A rounded trough rather than a square trench.
          const cut = depth * (1 - d * d);
          if (carved[cell] > h[i] - cut) carved[cell] = Math.max(0, h[i] - cut);
        }
      }
    }
  }
  h.set(carved);

  // The water surface of a river is its bed plus a skim, so it renders as a
  // filled channel rather than a ribbon floating over one.
  for (let i = 0; i < size; i++) {
    if (river[i] > 0 && surface[i] < 0) surface[i] = h[i] + river[i] * 3.5;
  }

  let wetCells = 0;
  for (let i = 0; i < size; i++) if (surface[i] >= 0) wetCells++;

  return {
    size: n,
    surface,
    lakeOf,
    accum,
    river,
    lakes,
    wetFraction: size ? wetCells / size : 0,
  };
}

/** Rivers and lakes only — what the atlas strokes and the colouriser tints. */
export function isFreshWater(water: WaterField, i: number, seaLevel: number): boolean {
  return water.surface[i] >= 0 && water.surface[i] > seaLevel;
}

/** Bilinear water surface lookup, for placing things on it. */
export function sampleSurface(water: WaterField, u: number, v: number): number {
  const n = water.size;
  const x = clamp(u * (n - 1), 0, n - 1);
  const y = clamp(v * (n - 1), 0, n - 1);
  const xi = Math.min(n - 2, Math.floor(x));
  const yi = Math.min(n - 2, Math.floor(y));
  const fx = x - xi;
  const fy = y - yi;
  const i = yi * n + xi;
  const a = water.surface[i];
  const b = water.surface[i + 1];
  const c = water.surface[i + n];
  const d = water.surface[i + n + 1];
  // -1 means dry; averaging it in would drag the shoreline down below the bed.
  const va = a < 0 ? 0 : a;
  const vb = b < 0 ? va : b;
  const vc = c < 0 ? va : c;
  const vd = d < 0 ? va : d;
  return (va + (vb - va) * fx) * (1 - fy) + (vc + (vd - vc) * fx) * fy;
}
