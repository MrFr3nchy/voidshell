import type { KernelContext, VoidModule } from "../../kernel/types";

/**
 * Physarum polycephalum — a slime mould — is one cell with no brain, no
 * neurons and no plan, and it reliably finds the shortest path through a maze.
 * Lay food out in the shape of Tokyo and it grows a rail network within a day
 * that an engineer would recognise. Nobody is in charge of that. It falls out
 * of three numbers per particle.
 *
 * Each agent does exactly this, every step: sniff ahead-left, ahead and
 * ahead-right; turn towards whichever smelled strongest; walk forward; leave a
 * smell behind. The trail blurs and fades. That is the entire program — the
 * "road" is a standing wave in a field of decaying scent, and it is why a
 * broken link heals itself and an abandoned one disappears.
 *
 * Named for the shape, not the taxonomy: a slime mould is not a fungus and
 * grows no mycelium. It just draws one.
 */

export interface Species {
  name: string;
  note: string;
  /** Degrees off-heading to the left and right sensors. */
  sensor: number;
  /** Degrees turned per step towards the winning sensor. */
  turn: number;
  /** How far ahead the sensors reach, in cells. */
  reach: number;
  /** Cells travelled per step. */
  speed: number;
  /** Scent laid per step. */
  deposit: number;
  /** How much of a cell's scent spreads to its neighbours, 0–1. */
  diffuse: number;
  /** Survives per step, so 0.9 means a tenth is gone. */
  decay: number;
  /**
   * Degrees of random wobble added to every heading, every step.
   *
   * Not decoration. Without it a network is a trap: once a road is bright
   * enough that all three sensors read it, no agent can ever leave, and every
   * preset ends its life as one thick arc with an empty field around it —
   * beautiful for a minute and dead for the rest of the afternoon. A few
   * degrees of noise means roads are constantly re-proposed and abandoned,
   * which is also what the real thing does.
   */
  wander: number;
}

/**
 * Five sets of the same seven numbers, and nothing else differs — no
 * per-species code, no special cases, no second renderer. Which is the thing
 * worth seeing: the sensor angle alone is most of the difference between a
 * road network and a fingerprint.
 */
export const SPECIES: Species[] = [
  { name: "veins",     note: "roads, and the roads win",  sensor: 22, turn: 26, reach: 9,  speed: 1.0, deposit: 0.22, diffuse: 0.32, decay: 0.955, wander: 6 },
  { name: "lace",      note: "thin walls, wide rooms",    sensor: 45, turn: 15, reach: 9,  speed: 1.0, deposit: 0.10, diffuse: 0.32, decay: 0.90,  wander: 6 },
  { name: "foam",      note: "small cells, packed tight", sensor: 62, turn: 18, reach: 6,  speed: 1.0, deposit: 0.24, diffuse: 0.30, decay: 0.96,  wander: 4 },
  { name: "labyrinth", note: "it builds walls, not roads", sensor: 90, turn: 45, reach: 3,  speed: 0.7, deposit: 0.20, diffuse: 0.32, decay: 0.95,  wander: 6 },
  { name: "dunes",     note: "long, lazy arcs",           sensor: 10, turn: 15, reach: 14, speed: 1.0, deposit: 0.20, diffuse: 0.32, decay: 0.95,  wander: 6 },
];

/** The scent field: one float per cell, on a torus, plus a scratch row buffer. */
export interface Field {
  gw: number;
  gh: number;
  trail: Float32Array;
  tmp: Float32Array;
  /** 1 where the mould cannot go. Holds no scent, and is never entered. */
  wall: Uint8Array;
}

/** The swarm, as parallel arrays. One object per agent would allocate 20,000. */
export interface Swarm {
  n: number;
  x: Float32Array;
  y: Float32Array;
  a: Float32Array;
}

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;

export function createField(gw: number, gh: number): Field {
  const size = Math.max(1, gw * gh);
  return {
    gw,
    gh,
    trail: new Float32Array(size),
    tmp: new Float32Array(size),
    wall: new Uint8Array(size),
  };
}

/**
 * Agents start on a ring facing inwards. A uniform scatter works too, but it
 * spends the first few seconds looking like static; from a ring you watch the
 * thing collapse into a network, which is the part worth seeing.
 */
export function createSwarm(n: number, gw: number, gh: number, rand = Math.random): Swarm {
  const s: Swarm = { n, x: new Float32Array(n), y: new Float32Array(n), a: new Float32Array(n) };
  const cx = gw / 2;
  const cy = gh / 2;
  const r = Math.min(gw, gh) * 0.42;
  for (let i = 0; i < n; i++) {
    const t = rand() * TAU;
    const d = r * Math.sqrt(rand());
    s.x[i] = cx + Math.cos(t) * d;
    s.y[i] = cy + Math.sin(t) * d;
    s.a[i] = Math.atan2(cy - s.y[i], cx - s.x[i]) + (rand() - 0.5) * 0.8;
  }
  return s;
}

/**
 * Pick up `count` agents and drop them somewhere else, facing anywhere.
 *
 * A few per thousand per step, and it is the difference between an app worth
 * leaving open and a screenshot. A network with no immigration coarsens: every
 * road absorbs its neighbours until one thick arc is left and the field around
 * it is empty, because an agent inside a bright road can no longer smell
 * anything else. The re-dropped few are the only ones who can still find a
 * road that does not exist yet, which is why the fine exploratory hairs
 * between the veins never stop being redrawn.
 */
export function scatter(s: Swarm, f: Field, count: number, rand = Math.random): void {
  for (let i = 0; i < count; i++) {
    const a = Math.min(s.n - 1, (rand() * s.n) | 0);
    // Eight tries at open ground, then leave the agent where it was. A maze
    // can be mostly wall, and an immigrant dropped inside one is a particle
    // that will never move again.
    for (let attempt = 0; attempt < 8; attempt++) {
      const x = rand() * f.gw;
      const y = rand() * f.gh;
      if (f.wall[(y | 0) * f.gw + (x | 0)]) continue;
      s.x[a] = x;
      s.y[a] = y;
      s.a[a] = rand() * TAU;
      break;
    }
  }
}

/**
 * Scent at a point, wrapped. Nearest cell: a bilinear read costs four times as
 * much and the agents cannot tell the difference.
 *
 * A wall reads as -1 rather than 0, which is what makes walls *repellent*
 * instead of merely empty. Read as 0 they would be indistinguishable from
 * open ground nobody has visited yet, and agents would walk into them all day
 * and bounce — the corridors would fill, but the mould would look drunk.
 */
export function sampleAt(f: Field, x: number, y: number): number {
  const gx = ((Math.round(x) % f.gw) + f.gw) % f.gw;
  const gy = ((Math.round(y) % f.gh) + f.gh) % f.gh;
  const i = gy * f.gw + gx;
  return f.wall[i] ? -1 : f.trail[i];
}

/**
 * Jones' rule, 2010. Which way to turn given what the three sensors smelled.
 * Returns -1, 0 or +1 — turn left, hold, turn right — except that a nose
 * flanked by two better options picks a side at random rather than freezing.
 */
export function steer(left: number, ahead: number, right: number, rand = Math.random): -1 | 0 | 1 {
  if (ahead > left && ahead > right) return 0;
  if (ahead < left && ahead < right) return rand() < 0.5 ? -1 : 1;
  if (left > right) return -1;
  if (right > left) return 1;
  return 0;
}

/** One sniff-turn-walk-deposit for every agent. */
export function stepSwarm(f: Field, s: Swarm, sp: Species, rand = Math.random): void {
  const sensor = sp.sensor * RAD;
  const turn = sp.turn * RAD;
  for (let i = 0; i < s.n; i++) {
    const x = s.x[i];
    const y = s.y[i];
    let a = s.a[i];

    const ahead = sampleAt(f, x + Math.cos(a) * sp.reach, y + Math.sin(a) * sp.reach);
    const al = a - sensor;
    const ar = a + sensor;
    const left = sampleAt(f, x + Math.cos(al) * sp.reach, y + Math.sin(al) * sp.reach);
    const right = sampleAt(f, x + Math.cos(ar) * sp.reach, y + Math.sin(ar) * sp.reach);

    a += steer(left, ahead, right, rand) * turn;
    if (sp.wander > 0) a += (rand() - 0.5) * sp.wander * RAD;

    let nx = x + Math.cos(a) * sp.speed;
    let ny = y + Math.sin(a) * sp.speed;
    nx = ((nx % f.gw) + f.gw) % f.gw;
    ny = ((ny % f.gh) + f.gh) % f.gh;

    // Into a wall: stay put, face somewhere else entirely, lay nothing. A
    // reflection would be tidier and is wrong — agents would run along the
    // inside of a corridor forever and the scent would trace the walls
    // instead of the route between them.
    if (f.wall[(ny | 0) * f.gw + (nx | 0)]) {
      s.a[i] = rand() * TAU;
      continue;
    }

    s.x[i] = nx;
    s.y[i] = ny;
    s.a[i] = a;

    const cell = ((ny | 0) % f.gh) * f.gw + ((nx | 0) % f.gw);
    const v = f.trail[cell] + sp.deposit;
    f.trail[cell] = v > 1 ? 1 : v;
  }
}

/**
 * Blur, then fade. Separable — a horizontal pass into `tmp`, a vertical pass
 * back — which is nine reads per cell done as six, and the field is the whole
 * frame budget at this resolution.
 */
export function diffuseDecay(f: Field, diffuse: number, decay: number): void {
  const { gw, gh, trail, tmp } = f;
  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    for (let x = 0; x < gw; x++) {
      const l = trail[row + (x === 0 ? gw - 1 : x - 1)];
      const r = trail[row + (x === gw - 1 ? 0 : x + 1)];
      tmp[row + x] = 0.25 * l + 0.5 * trail[row + x] + 0.25 * r;
    }
  }
  for (let y = 0; y < gh; y++) {
    const row = y * gw;
    const up = (y === 0 ? gh - 1 : y - 1) * gw;
    const dn = (y === gh - 1 ? 0 : y + 1) * gw;
    for (let x = 0; x < gw; x++) {
      if (f.wall[row + x]) {
        trail[row + x] = 0;
        continue;
      }
      const b = 0.25 * tmp[up + x] + 0.5 * tmp[row + x] + 0.25 * tmp[dn + x];
      const cur = trail[row + x];
      trail[row + x] = (cur + (b - cur) * diffuse) * decay;
    }
  }
}

/** A blob of scent that never fades — food, or a fingertip. */
export function feed(f: Field, x: number, y: number, radius: number, strength = 1): void {
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      const gx = ((((x | 0) + dx) % f.gw) + f.gw) % f.gw;
      const gy = ((((y | 0) + dy) % f.gh) + f.gh) % f.gh;
      const i = gy * f.gw + gx;
      if (f.wall[i]) continue;
      const v = strength * (1 - d / (radius + 1));
      if (f.trail[i] < v) f.trail[i] = v;
    }
  }
}

/** Fill a rectangle of the wall mask. Clipped, never wrapped. */
function fill(f: Field, x0: number, y0: number, x1: number, y1: number, v: number): void {
  for (let y = Math.max(0, y0); y <= Math.min(f.gh - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(f.gw - 1, x1); x++) {
      f.wall[y * f.gw + x] = v;
      if (v) f.trail[y * f.gw + x] = 0;
    }
  }
}

export interface Maze {
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Rooms, not field cells. */
  rooms: number;
}

/**
 * A perfect maze, by depth-first backtracking, straight into the wall mask.
 *
 * This is the 2000 Nakagaki experiment and the reason anybody has heard of
 * this organism: food at two ends of a maze, mould everywhere, and within a
 * day everything that isn't the shortest path between the two has been
 * withdrawn. Nothing here knows what a shortest path is. The mould finds it
 * because a shorter route is a shorter round trip for the scent, so it stays
 * brighter, so it recruits, so the longer branch starves.
 *
 * "Perfect" means exactly one route between any two rooms, which is what makes
 * the result legible: what you are watching go dark are the dead ends losing.
 */
export function carveMaze(f: Field, room = 14, rand = Math.random): Maze {
  const t = 2;
  const step = room + t;
  const mw = Math.max(2, Math.floor((f.gw - t) / step));
  const mh = Math.max(2, Math.floor((f.gh - t) / step));
  const ox = Math.max(0, ((f.gw - (mw * step + t)) / 2) | 0);
  const oy = Math.max(0, ((f.gh - (mh * step + t)) / 2) | 0);

  f.wall.fill(1);
  f.trail.fill(0);

  const x0 = (cx: number) => ox + t + cx * step;
  const y0 = (cy: number) => oy + t + cy * step;
  const openRoom = (cx: number, cy: number) =>
    fill(f, x0(cx), y0(cy), x0(cx) + room - 1, y0(cy) + room - 1, 0);

  const seen = new Uint8Array(mw * mh);
  const stack: number[] = [0];
  seen[0] = 1;
  openRoom(0, 0);

  while (stack.length) {
    const here = stack[stack.length - 1];
    const cx = here % mw;
    const cy = (here / mw) | 0;

    const open: number[] = [];
    if (cx > 0 && !seen[here - 1]) open.push(0);
    if (cx < mw - 1 && !seen[here + 1]) open.push(1);
    if (cy > 0 && !seen[here - mw]) open.push(2);
    if (cy < mh - 1 && !seen[here + mw]) open.push(3);
    if (!open.length) {
      stack.pop();
      continue;
    }

    const dir = open[Math.min(open.length - 1, (rand() * open.length) | 0)];
    const nx = cx + (dir === 0 ? -1 : dir === 1 ? 1 : 0);
    const ny = cy + (dir === 2 ? -1 : dir === 3 ? 1 : 0);
    openRoom(nx, ny);
    // The doorway is the wall strip between the two rooms, and nothing else:
    // widen it and adjacent corridors merge into open ground.
    if (dir === 0) fill(f, x0(nx) + room, y0(cy), x0(cx) - 1, y0(cy) + room - 1, 0);
    if (dir === 1) fill(f, x0(cx) + room, y0(cy), x0(nx) - 1, y0(cy) + room - 1, 0);
    if (dir === 2) fill(f, x0(cx), y0(ny) + room, x0(cx) + room - 1, y0(cy) - 1, 0);
    if (dir === 3) fill(f, x0(cx), y0(cy) + room, x0(cx) + room - 1, y0(ny) - 1, 0);

    const next = ny * mw + nx;
    seen[next] = 1;
    stack.push(next);
  }

  const centre = (cx: number, cy: number) => ({
    x: x0(cx) + room / 2,
    y: y0(cy) + room / 2,
  });
  return { start: centre(0, 0), end: centre(mw - 1, mh - 1), rooms: mw * mh };
}

/** Paint or erase a disc of wall. The brush, and how a maze gets a shortcut. */
export function paintWall(f: Field, x: number, y: number, radius: number, solid: boolean): void {
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (Math.hypot(dx, dy) > radius) continue;
      const gx = ((((x | 0) + dx) % f.gw) + f.gw) % f.gw;
      const gy = ((((y | 0) + dy) % f.gh) + f.gh) % f.gh;
      const i = gy * f.gw + gx;
      f.wall[i] = solid ? 1 : 0;
      if (solid) f.trail[i] = 0;
    }
  }
}

/**
 * Is there an unbroken road of at least `threshold` scent from a to b?
 *
 * A flood fill over lit cells, which is the only honest way to ask "has it
 * solved the maze yet" — the picture cannot be trusted, because a corridor
 * with a bright end and a bright start and a dark middle looks connected at a
 * glance and is not.
 */
export function connects(
  f: Field,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  threshold: number
): boolean {
  const { gw, gh, trail, wall } = f;
  const at = (x: number, y: number) => ((y | 0) % gh) * gw + ((x | 0) % gw);
  const from = at(ax, ay);
  const to = at(bx, by);
  if (trail[from] < threshold || trail[to] < threshold) return false;
  if (from === to) return true;

  const seen = new Uint8Array(gw * gh);
  const queue = new Int32Array(gw * gh);
  let head = 0;
  let tail = 0;
  queue[tail++] = from;
  seen[from] = 1;

  // Eight-connected, and it has to be: a road two cells wide that runs at 40°
  // is a staircase of diagonal neighbours, and a four-connected fill walks up
  // to it and stops. Every maze here reported itself unsolved for that reason
  // alone while the picture plainly showed a road from one end to the other.
  while (head < tail) {
    const i = queue[head++];
    const x = i % gw;
    const y = (i / gw) | 0;
    for (let d = 0; d < 8; d++) {
      const dx = d === 0 || d === 3 || d === 5 ? -1 : d === 1 || d === 6 ? 0 : 1;
      const dy = d < 3 ? -1 : d < 5 ? 0 : 1;
      const nx = (x + dx + gw) % gw;
      const ny = (y + dy + gh) % gh;
      const j = ny * gw + nx;
      if (seen[j] || wall[j] || trail[j] < threshold) continue;
      if (j === to) return true;
      seen[j] = 1;
      queue[tail++] = j;
    }
  }
  return false;
}

/**
 * Share of the scent sitting in the brightest tenth of the field.
 *
 * The one number that says whether a network exists. Spread the same total
 * evenly and it is 0.1; concentrate it into roads and it climbs. Nothing in
 * the app needs this — the checks do, because "it looks like a slime mould"
 * is not an assertion.
 */
export function concentration(f: Field): number {
  const n = f.trail.length;
  let total = 0;
  for (let i = 0; i < n; i++) total += f.trail[i];
  if (total <= 0) return 0;

  // A 64-bucket histogram, walked from the top, instead of sorting 100k floats.
  const buckets = new Float64Array(64);
  let max = 0;
  for (let i = 0; i < n; i++) if (f.trail[i] > max) max = f.trail[i];
  if (max <= 0) return 0;
  for (let i = 0; i < n; i++) {
    const b = Math.min(63, (f.trail[i] / max) * 63.999) | 0;
    buckets[b] += f.trail[i];
  }
  const counts = new Float64Array(64);
  for (let i = 0; i < n; i++) counts[Math.min(63, (f.trail[i] / max) * 63.999) | 0]++;

  const want = n * 0.1;
  let taken = 0;
  let mass = 0;
  for (let b = 63; b >= 0; b--) {
    if (taken + counts[b] <= want) {
      taken += counts[b];
      mass += buckets[b];
      continue;
    }
    const room = want - taken;
    if (counts[b] > 0) mass += buckets[b] * (room / counts[b]);
    break;
  }
  return mass / total;
}

/* ------------------------------------------------------------------ the app */

/** Target cells per agent. Fewer agents than this and the field never sets. */
const PER_AGENT = 8;
/** Beyond this many cells the blur, not the swarm, is what costs. */
const MAX_CELLS = 120_000;
/** Fraction of the swarm re-dropped somewhere new each step. See `scatter`. */
const RESPAWN = 0.003;
const MAX_FOOD = 40;
/** Scent a cell needs before it counts as road rather than rumour. */
const SOLVE_LEVEL = 0.12;
/** Brush radius in cells, for painting walls. */
const BRUSH = 3;
const FOOD_RADIUS = 2.4;
const SPECIES_KEY = "mycelia.species";

/** A 256-entry ramp from nothing, through the theme, to a hot core. */
function buildRamp(cyan: [number, number, number], magenta: [number, number, number], ember: [number, number, number]): Uint8ClampedArray {
  const ramp = new Uint8ClampedArray(256 * 4);
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r: number;
    let g: number;
    let b: number;
    if (t < 0.45) {
      const k = t / 0.45;
      [r, g, b] = [mix(cyan[0] * 0.35, cyan[0], k), mix(cyan[1] * 0.35, cyan[1], k), mix(cyan[2] * 0.35, cyan[2], k)];
    } else if (t < 0.8) {
      const k = (t - 0.45) / 0.35;
      [r, g, b] = [mix(cyan[0], magenta[0], k), mix(cyan[1], magenta[1], k), mix(cyan[2], magenta[2], k)];
    } else {
      const k = (t - 0.8) / 0.2;
      [r, g, b] = [mix(magenta[0], ember[0], k), mix(magenta[1], ember[1], k), mix(magenta[2], ember[2], k)];
    }
    const p = i * 4;
    ramp[p] = r;
    ramp[p + 1] = g;
    ramp[p + 2] = b;
    // Faint scent stays transparent so the void shows through the web.
    ramp[p + 3] = Math.min(235, t * 460);
  }
  return ramp;
}

export const mycelia: VoidModule = {
  manifest: {
    id: "mycelia",
    name: "Mycelia",
    kind: "app",
    glyph: "⁂",
    blurb: "a brainless cell finds the road",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "mycelia.open",
      label: "mycelia",
      hint: "grow a slime mould",
      glyph: "⁂",
      run: (c) => c.launch("mycelia"),
    });
  },

  launch(ctx: KernelContext) {
    const { mount: mountStage, palette, rgbOf, toolbar, toolButton, withAlpha } = ctx.stage;

    ctx.openSurface({
      title: "mycelia",
      width: 460,
      height: 380,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);
        const bar = toolbar(root);

        let field = createField(1, 1);
        let swarm = createSwarm(1, 1, 1);
        let food: { x: number; y: number }[] = [];

        let off: HTMLCanvasElement | null = null;
        let offG: CanvasRenderingContext2D | null = null;
        let image: ImageData | null = null;

        let ramp = buildRamp([79, 227, 208], [192, 92, 255], [255, 138, 92]);
        let rampKey = "";

        const stored = ctx.state.get<number>(SPECIES_KEY, 0);
        let speciesIndex = Number.isInteger(stored) && stored >= 0 && stored < SPECIES.length ? stored : 0;
        let sp = SPECIES[speciesIndex];
        let running = true;
        let sub = 1;

        let maze: Maze | null = null;
        let joined = false;
        let lit = 0;
        let tick = 0;
        /** What dragging does. Shift swaps food and wall while it is held. */
        let brush: "food" | "wall" | "erase" = "food";

        const reseed = () => {
          field.trail.fill(0);
          swarm = createSwarm(swarm.n, field.gw, field.gh);
          if (maze) scatter(swarm, field, swarm.n);
        };

        const reshape = (w: number, h: number) => {
          // Two CSS pixels a cell, coarsening rather than melting when the
          // panel is pulled out to fill a wall.
          const cell = Math.max(2, Math.min(4, Math.ceil(Math.sqrt((w * h) / MAX_CELLS))));
          const gw = Math.max(16, Math.floor(w / cell));
          const gh = Math.max(16, Math.floor(h / cell));
          if (gw === field.gw && gh === field.gh) return;

          // Food is held in grid coordinates, so a resize has to carry it
          // across or the network stays wired to fruit that isn't there.
          const fx = field.gw > 1 ? food.map((f) => ({ x: (f.x / field.gw) * gw, y: (f.y / field.gh) * gh })) : [];

          // The wall mask belongs to a grid that no longer exists. Rescaling a
          // maze is not a resize, it is a different maze, and one whose
          // corridors are no longer the width the mould was tuned for.
          field = createField(gw, gh);
          maze = null;
          food = fx;
          const n = Math.max(800, Math.min(24_000, Math.round((gw * gh) / PER_AGENT)));
          swarm = createSwarm(n, gw, gh);

          off = document.createElement("canvas");
          off.width = gw;
          off.height = gh;
          offG = off.getContext("2d");
          image = offG ? offG.createImageData(gw, gh) : null;
        };

        const dropFood = (gx: number, gy: number, quiet = false) => {
          if (food.length >= MAX_FOOD) food.shift();
          food.push({ x: gx, y: gy });
          if (!quiet && ctx.audio.enabled()) {
            ctx.audio.burst({ freq: 320 + Math.random() * 90, q: 3, gain: 0.06, decay: 0.12 });
          }
        };

        const stop = mountStage(stageHost, {
          className: "mycelia-canvas",
          layout: (st) => reshape(st.w, st.h),
          frame: (st) => {
            const { g, w, h } = st;
            if (!image || !offG || !off) return;

            if (running) {
              const moved = Math.max(1, Math.round(swarm.n * RESPAWN));
              for (let s = 0; s < sub; s++) {
                for (const f of food) feed(field, f.x, f.y, FOOD_RADIUS);
                stepSwarm(field, swarm, sp);
                diffuseDecay(field, sp.diffuse, sp.decay);
                scatter(swarm, field, moved);
              }
            }

            // Connectivity is a flood fill over the whole field, so it runs
            // three times a second rather than sixty. Nothing on screen moves
            // fast enough for the difference to be visible.
            if (running && maze && ++tick % 20 === 0) {
              const { start, end } = maze;
              joined = connects(field, start.x, start.y, end.x, end.y, SOLVE_LEVEL);
              let open = 0;
              let bright = 0;
              for (let i = 0; i < field.trail.length; i++) {
                if (field.wall[i]) continue;
                open++;
                if (field.trail[i] >= SOLVE_LEVEL) bright++;
              }
              lit = open ? bright / open : 0;
            }

            const c = palette();
            const key = `${c.cyan}|${c.magenta}|${c.ember}`;
            if (key !== rampKey) {
              ramp = buildRamp(rgbOf(c.cyan), rgbOf(c.magenta), rgbOf(c.ember));
              rampKey = key;
            }
            const [wr, wg, wb] = rgbOf(c.dim);

            const data = image.data;
            const trail = field.trail;
            const wall = field.wall;
            for (let i = 0; i < trail.length; i++) {
              const p = i * 4;
              if (wall[i]) {
                data[p] = wr;
                data[p + 1] = wg;
                data[p + 2] = wb;
                data[p + 3] = 42;
                continue;
              }
              const v = trail[i];
              if (v < 0.004) {
                data[p + 3] = 0;
                continue;
              }
              const q = (v > 1 ? 255 : (v * 255) | 0) * 4;
              data[p] = ramp[q];
              data[p + 1] = ramp[q + 1];
              data[p + 2] = ramp[q + 2];
              data[p + 3] = ramp[q + 3];
            }

            offG.putImageData(image, 0, 0);
            g.clearRect(0, 0, w, h);
            g.imageSmoothingEnabled = true;
            g.drawImage(off, 0, 0, w, h);

            const sx = w / field.gw;
            const sy = h / field.gh;
            g.lineWidth = 1;
            g.strokeStyle = withAlpha(c.ember, 0.7);
            for (const f of food) {
              g.beginPath();
              g.arc(f.x * sx, f.y * sy, FOOD_RADIUS * sx + 2.5, 0, TAU);
              g.stroke();
            }

            g.fillStyle = withAlpha(c.dim, 0.75);
            g.font = "9px ui-monospace, monospace";
            const status = maze
              ? `maze  —  ${maze.rooms} rooms, one route  —  ${(lit * 100) | 0}% flooded, ends ${joined ? "joined" : "apart"}`
              : `${sp.name}  —  ${sp.note}  —  ${swarm.n.toLocaleString()} agents, ${food.length} food`;
            g.fillText(status, 6, h - 6);
          },
        });

        /* ---------------- feeding it ---------------- */

        const canvas = stageHost.querySelector("canvas");
        let feeding = false;
        let lastX = -99;
        let lastY = -99;

        const at = (clientX: number, clientY: number) => {
          if (!canvas) return null;
          const rect = canvas.getBoundingClientRect();
          if (!rect.width || !rect.height) return null;
          return {
            x: ((clientX - rect.left) / rect.width) * field.gw,
            y: ((clientY - rect.top) / rect.height) * field.gh,
          };
        };

        /** Food, wall or eraser — with shift swapping the first two. */
        const brushFor = (e: PointerEvent) =>
          e.shiftKey ? (brush === "wall" ? "food" : "wall") : brush;

        const paintAt = (e: PointerEvent) => {
          const p = at(e.clientX, e.clientY);
          if (!p) return;
          const kind = brushFor(e);

          // Walls paint continuously, because a brush that skipped would draw
          // a dotted line the mould walks straight through. Food does not:
          // sampled per pointer event a single flick would drop forty
          // overlapping blobs and evict everything placed before them.
          if (kind === "wall" || kind === "erase") {
            paintWall(field, p.x, p.y, BRUSH, kind === "wall");
            if (kind === "erase") food = food.filter((f) => Math.hypot(f.x - p.x, f.y - p.y) > BRUSH);
            return;
          }
          if (Math.hypot(p.x - lastX, p.y - lastY) < 7) return;
          lastX = p.x;
          lastY = p.y;
          dropFood(p.x, p.y);
        };

        const onDown = (e: PointerEvent) => {
          feeding = true;
          lastX = -99;
          lastY = -99;
          paintAt(e);
          canvas?.setPointerCapture(e.pointerId);
          e.preventDefault();
        };
        const onMove = (e: PointerEvent) => {
          if (feeding) paintAt(e);
        };
        const onUp = () => {
          feeding = false;
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

        const speciesBtn = toolButton(bar, sp.name, (b) => {
          speciesIndex = (speciesIndex + 1) % SPECIES.length;
          sp = SPECIES[speciesIndex];
          ctx.state.set(SPECIES_KEY, speciesIndex);
          b.textContent = sp.name;
          ctx.notify(`mycelia: ${sp.name} — ${sp.note}`, "info");
        });
        speciesBtn.textContent = sp.name;

        // The Tokyo experiment, in one button: oat flakes laid out as the towns
        // around Tokyo, and the mould grew the rail network in on its own.
        toolButton(bar, "scatter", () => {
          const cx = field.gw / 2;
          const cy = field.gh / 2;
          const r = Math.min(field.gw, field.gh) * 0.34;
          for (let i = 0; i < 8; i++) {
            const t = (i / 8) * TAU + Math.random() * 0.3;
            const d = r * (0.55 + Math.random() * 0.45);
            dropFood(cx + Math.cos(t) * d, cy + Math.sin(t) * d, i > 0);
          }
        });

        toolButton(bar, "starve", () => {
          food = [];
        });

        // Nakagaki 2000, in one button — with the result the 2000 paper got
        // stated where it belongs, in the readout rather than the button.
        // Food goes at both ends and the mould floods the corridors, but this
        // model does not then retract to the shortest path: pruning here
        // fragments the network instead of thinning it, so the two ends come
        // apart and rejoin as it goes. The famous retraction is a property of
        // the flow model (Tero 2010), where tubes carry a current and
        // conductivity feeds back; agents laying scent do not have a current
        // to reason about. So the panel reports whether the ends are joined
        // right now, which is true, instead of announcing a solve, which
        // would not be.
        toolButton(bar, "maze", () => {
          // Corridors have to be a few times the width of a road or the mould
          // cannot lie down inside one; 14 cells is the narrowest that still
          // fills rather than clogs at the panel's default size.
          const room = field.gw > 260 ? 18 : 14;
          maze = carveMaze(field, room);
          food = [];
          dropFood(maze.start.x, maze.start.y, true);
          dropFood(maze.end.x, maze.end.y, true);
          scatter(swarm, field, swarm.n);
          joined = false;
          lit = 0;
          ctx.notify(`mycelia: ${maze.rooms} rooms, one route through`, "info");
        });

        toolButton(bar, "brush: food", (b) => {
          brush = brush === "food" ? "wall" : brush === "wall" ? "erase" : "food";
          b.textContent = `brush: ${brush}`;
          b.classList.toggle("on", brush !== "food");
        });

        toolButton(bar, "1×", (b) => {
          sub = sub === 1 ? 2 : sub === 2 ? 4 : 1;
          b.textContent = `${sub}×`;
        });

        toolButton(bar, "restart", () => {
          food = [];
          maze = null;
          field.wall.fill(0);
          joined = false;
          reseed();
        });

        return () => {
          stop();
          canvas?.removeEventListener("pointerdown", onDown);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
      },
    });
  },
};
