/**
 * Pac-Man: the maze, the tables, and the four minds.
 *
 * Almost everything that makes this game what it is turns out to be a pure
 * function of tile coordinates and a level number, which is unusually lucky —
 * it means the part that actually needs judging by playing it is quite small,
 * and the part where being wrong is silent is nearly all checkable here.
 *
 * The single most important thing in this file is that **the ghosts are not
 * random and they are not the same as each other**. Four fixed target rules,
 * one shared "step toward your target" routine, and an alternation between
 * chasing and going home. That is the whole AI, and it is the reason the game
 * has thirty years of strategy in it rather than thirty seconds. Any attempt
 * to make them "smarter" — flood fill, real pathfinding, shared knowledge —
 * produces four identical hunters and deletes the game. Do not.
 *
 * Two famous bugs in the original are reproduced deliberately, and are marked
 * where they occur. They are not mistakes to be tidied up: the whole of the
 * "safe spot" strategy is a consequence of the first one, and Inky's
 * unpredictability is a consequence of both.
 */

/* ---------------- the grid ---------------- */

export const TILE = 8;
export const COLS = 28;
export const ROWS = 31;

/** Rows of readout above the maze. Keeps the whole thing at 224x272. */
export const TOP = 24;
export const GAME_W = COLS * TILE;
export const GAME_H = TOP + ROWS * TILE;

/**
 * The maze.
 *
 * Authored here rather than traced off a screenshot — the original's tile art
 * is a copyrighted visual work — but authored to the same specification, which
 * is what the ghost AI actually depends on: 28x31, mirror-symmetric, a sealed
 * house in the middle with a single door on its top edge, a wrap tunnel on the
 * house's own row, four energizers in the four corner regions, and exactly
 * 244 things to eat.
 *
 * Verified rather than eyeballed, because every one of these is silent when
 * wrong: 244 pellets, perfect left-right wall symmetry, every pellet reachable
 * from Pac-Man's start by flood fill, and no dead ends anywhere outside the
 * house. A single dead end would be a corner a ghost could trap you in that
 * the original never had; a single unreachable pellet would be a level that
 * cannot be finished, discovered by a player three minutes in.
 *
 * `#` wall, `.` pellet, `o` energizer, `-` house door, space open.
 */
export const MAZE: readonly string[] = [
  "############################",
  "#............##............#",
  "#.####.#####.##.#####.####.#",
  "#o####.#####.##.#####.####o#",
  "#.####.#####.##.#####.####.#",
  "#..........................#",
  "#.####.##.########.##.####.#",
  "#.####.##.########.##.####.#",
  "#......##....##....##......#",
  "######.##### ## #####.######",
  "######.##### ## #####.######",
  "######.##          ##.######",
  "######.## ###--### ##.######",
  "######.## #      # ##.######",
  "      .   #      #   .      ",
  "######.## #      # ##.######",
  "######.## ######## ##.######",
  "######.##          ##.######",
  "######.## ######## ##.######",
  "######.## ######## ##.######",
  "#............##............#",
  "#.####.#####.##.#####.####.#",
  "#.####.#####.##.#####.####.#",
  "#o..##.......  .......##..o#",
  "###.##.##.########.##.##.###",
  "###.##.##.########.##.##.###",
  "#......##....##....##......#",
  "#.##########.##.##########.#",
  "#.##########.##.##########.#",
  "#..........................#",
  "############################",
];

export const PELLET_TOTAL = 244;

/** Bring a column back into the maze. The tunnel row is a cylinder. */
export function wrapCol(cx: number): number {
  return ((cx % COLS) + COLS) % COLS;
}

export function tileAt(cx: number, cy: number): string {
  if (cy < 0 || cy >= ROWS) return "#";
  return MAZE[cy][wrapCol(cx)];
}

/** Can Pac-Man stand here? The house door is a wall to him and to no one else. */
export function walkable(cx: number, cy: number): boolean {
  const t = tileAt(cx, cy);
  return t !== "#" && t !== "-";
}

/** Ghosts may pass the door, and may stand inside the house. */
export function ghostWalkable(cx: number, cy: number): boolean {
  return tileAt(cx, cy) !== "#";
}

/** The tunnel: the row that runs off both edges. Ghosts crawl through it. */
export function inTunnel(cx: number, cy: number): boolean {
  return cy === TUNNEL_ROW && (cx < 6 || cx > COLS - 7);
}

export const TUNNEL_ROW = 14;

/* ---------------- geometry the simulation needs ---------------- */

/** Centre of a tile, in playfield pixels (maze-local; add TOP for the screen). */
export function tileCentreX(cx: number): number {
  return cx * TILE + TILE / 2;
}
export function tileCentreY(cy: number): number {
  return cy * TILE + TILE / 2;
}

/** Where Pac-Man materialises: astride the seam between two blank tiles. */
export const PAC_START_X = 14 * TILE;
export const PAC_START_Y = tileCentreY(23);

/** The house. Ghosts bob inside it and leave through the top edge. */
export const HOUSE_X = 14 * TILE;
export const HOUSE_Y = tileCentreY(14);
export const HOUSE_EXIT_Y = tileCentreY(11);
export const HOUSE_LEFT_X = tileCentreX(12);
export const HOUSE_RIGHT_X = tileCentreX(15);

/** Where a fruit appears — the corridor under the house, as in the original. */
export const FRUIT_X = 14 * TILE;
export const FRUIT_Y = tileCentreY(17);

/**
 * Tiles on which a ghost may not choose to turn upward.
 *
 * Four of them, at the two junctions above the house and the two below it.
 * They exist so that the corridors either side of the house can only be
 * entered from above, which is what makes those junctions safe to loop around
 * — a large part of the game's learnable geography comes from this rule, and
 * removing it makes the ghosts *stronger* while making the game worse.
 *
 * It constrains the choice only. A ghost already travelling upward through one
 * of these keeps going, and a frightened or eaten ghost ignores the rule.
 */
export const NO_UP: readonly (readonly [number, number])[] = [
  [12, 11],
  [15, 11],
  [12, 23],
  [15, 23],
];

export function noUpTile(cx: number, cy: number): boolean {
  return NO_UP.some(([x, y]) => x === cx && y === cy);
}

/* ---------------- direction ---------------- */

/**
 * Up, left, down, right — in that order, and the order is load-bearing.
 *
 * When two directions are exactly equally good a ghost takes the first one in
 * this list. That tiebreak is the difference between the original's ghosts and
 * a set of ghosts that merely resemble them: the patterns players memorise are
 * mostly consequences of ties resolving up-before-left rather than of the
 * distance comparison itself.
 */
export const DIRS: readonly (readonly [number, number])[] = [
  [0, -1],
  [-1, 0],
  [0, 1],
  [1, 0],
];

export const UP = 0;
export const LEFT = 1;
export const DOWN = 2;
export const RIGHT = 3;

export function opposite(dir: number): number {
  return (dir + 2) % 4;
}

/* ---------------- the speed table ---------------- */

/**
 * Full speed, in pixels per second.
 *
 * The original's speeds are all percentages of one number, and that number is
 * a hair under 76 px/s — which is why Pac-Man on level one, at 80%, covers
 * almost exactly one pixel per frame on a 60Hz machine. Every other figure in
 * this file is a fraction of it, so getting it right sets the pace of the
 * whole game and getting it wrong leaves something that plays fine and simply
 * isn't Pac-Man.
 */
export const FULL_SPEED = 75.7576;

/**
 * The tick, and why it is not Joust's.
 *
 * Joust runs at 30Hz on purpose: Williams' motion has a chunk to it that a
 * 60Hz simulation smooths away. Pac-Man is the opposite case. Its speeds are
 * *defined* as fractions of a pixel per 60Hz frame, and the visible
 * quantisation comes from those fractions rather than from a coarse clock.
 * Halving the rate here would not add period texture, it would round every
 * speed in the table to something else and put the ghosts on the wrong side of
 * Pac-Man's.
 */
export const TICK = 1 / 60;
export const MAX_TICKS = 6;

export interface LevelSpec {
  /** Fractions of FULL_SPEED. */
  pac: number;
  pacFright: number;
  ghost: number;
  ghostFright: number;
  ghostTunnel: number;
  /** Pellets *remaining* at which Blinky speeds up, and by how much. */
  elroy1: number;
  elroy1Speed: number;
  elroy2: number;
  elroy2Speed: number;
  /** Seconds the energizer lasts. Zero from level 17 on, mostly. */
  fright: number;
  /** How many times they flash white before it ends. */
  flashes: number;
}

/**
 * Per level, straight out of the original's tables.
 *
 * The shape of this is the difficulty curve and it is not smooth: the ghosts
 * overtake Pac-Man at level 5 and never give the lead back, the energizer is
 * worth six seconds on level 1 and *nothing at all* from level 17, and level
 * 10 hands back five seconds for one board as a breather before it gets worse
 * again. A smoothly interpolated curve is easier to write, plays worse, and is
 * the first thing a player who knows the game will notice.
 */
const LEVELS: LevelSpec[] = [
  // 1
  { pac: 0.8, pacFright: 0.9, ghost: 0.75, ghostFright: 0.5, ghostTunnel: 0.4,
    elroy1: 20, elroy1Speed: 0.8, elroy2: 10, elroy2Speed: 0.85, fright: 6, flashes: 5 },
  // 2
  { pac: 0.9, pacFright: 0.95, ghost: 0.85, ghostFright: 0.55, ghostTunnel: 0.45,
    elroy1: 30, elroy1Speed: 0.85, elroy2: 15, elroy2Speed: 0.95, fright: 5, flashes: 5 },
  // 3
  { pac: 0.9, pacFright: 0.95, ghost: 0.85, ghostFright: 0.55, ghostTunnel: 0.45,
    elroy1: 40, elroy1Speed: 0.85, elroy2: 20, elroy2Speed: 0.95, fright: 4, flashes: 5 },
  // 4
  { pac: 0.9, pacFright: 0.95, ghost: 0.85, ghostFright: 0.55, ghostTunnel: 0.45,
    elroy1: 40, elroy1Speed: 0.85, elroy2: 20, elroy2Speed: 0.95, fright: 3, flashes: 5 },
  // 5
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 40, elroy1Speed: 0.95, elroy2: 20, elroy2Speed: 1.05, fright: 2, flashes: 5 },
  // 6
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 50, elroy1Speed: 0.95, elroy2: 25, elroy2Speed: 1.05, fright: 5, flashes: 5 },
  // 7
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 50, elroy1Speed: 0.95, elroy2: 25, elroy2Speed: 1.05, fright: 2, flashes: 5 },
  // 8
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 50, elroy1Speed: 0.95, elroy2: 25, elroy2Speed: 1.05, fright: 2, flashes: 5 },
  // 9
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 60, elroy1Speed: 0.95, elroy2: 30, elroy2Speed: 1.05, fright: 1, flashes: 3 },
  // 10
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 60, elroy1Speed: 0.95, elroy2: 30, elroy2Speed: 1.05, fright: 5, flashes: 5 },
  // 11
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 60, elroy1Speed: 0.95, elroy2: 30, elroy2Speed: 1.05, fright: 2, flashes: 5 },
  // 12
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 80, elroy1Speed: 0.95, elroy2: 40, elroy2Speed: 1.05, fright: 1, flashes: 3 },
  // 13
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 80, elroy1Speed: 0.95, elroy2: 40, elroy2Speed: 1.05, fright: 1, flashes: 3 },
  // 14
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 80, elroy1Speed: 0.95, elroy2: 40, elroy2Speed: 1.05, fright: 3, flashes: 5 },
  // 15
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 100, elroy1Speed: 0.95, elroy2: 50, elroy2Speed: 1.05, fright: 1, flashes: 3 },
  // 16
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 100, elroy1Speed: 0.95, elroy2: 50, elroy2Speed: 1.05, fright: 1, flashes: 3 },
  // 17 — the energizers stop working. From here it is a memory test.
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 100, elroy1Speed: 0.95, elroy2: 50, elroy2Speed: 1.05, fright: 0, flashes: 0 },
  // 18
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 100, elroy1Speed: 0.95, elroy2: 50, elroy2Speed: 1.05, fright: 1, flashes: 3 },
  // 19
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 120, elroy1Speed: 0.95, elroy2: 60, elroy2Speed: 1.05, fright: 0, flashes: 0 },
  // 20
  { pac: 1, pacFright: 1, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 120, elroy1Speed: 0.95, elroy2: 60, elroy2Speed: 1.05, fright: 0, flashes: 0 },
  // 21 and up. Pac-Man is slowed back to 90% and stays there for ever, which
  // is the moment the game stops being winnable and starts being an endurance
  // record. Faithfully cruel.
  { pac: 0.9, pacFright: 0.9, ghost: 0.95, ghostFright: 0.6, ghostTunnel: 0.5,
    elroy1: 120, elroy1Speed: 0.95, elroy2: 60, elroy2Speed: 1.05, fright: 0, flashes: 0 },
];

export function levelSpec(level: number): LevelSpec {
  return LEVELS[Math.min(Math.max(1, level), LEVELS.length) - 1];
}

/* ---------------- scatter and chase ---------------- */

export type Mode = "scatter" | "chase";

/**
 * The alternation, in seconds, per level band.
 *
 * Seven phases and then chase for ever. The two oddities are real and are kept
 * on purpose: from level 2 the fifth scatter is followed by a chase of *over
 * seventeen minutes*, and the scatter after it lasts a single frame — the
 * original's designers stored these as counter values and the last two entries
 * are effectively "never" and "instantly". The visible consequence is that
 * late boards give you one brief scatter and then never let up again, which is
 * exactly how the game feels and is not something anyone would invent.
 */
const SCHEDULES: readonly (readonly number[])[] = [
  [7, 20, 7, 20, 5, 20, 5],
  [7, 20, 7, 20, 5, 1033, 1 / 60],
  [5, 20, 5, 20, 5, 1037, 1 / 60],
];

export function schedule(level: number): readonly number[] {
  if (level <= 1) return SCHEDULES[0];
  if (level <= 4) return SCHEDULES[1];
  return SCHEDULES[2];
}

/**
 * Which mode a level is in after `elapsed` seconds of *un-frightened* play.
 *
 * Frightened time does not advance this clock in the original, so the caller
 * is responsible for not accumulating it — which is why this takes an elapsed
 * time rather than reading one.
 */
export function modeAt(level: number, elapsed: number): Mode {
  const table = schedule(level);
  let t = elapsed;
  for (let i = 0; i < table.length; i++) {
    if (t < table[i]) return i % 2 === 0 ? "scatter" : "chase";
    t -= table[i];
  }
  return "chase";
}

/** Seconds until the next mode flip, or Infinity once it settles into chase. */
export function nextFlipIn(level: number, elapsed: number): number {
  const table = schedule(level);
  let t = elapsed;
  for (let i = 0; i < table.length; i++) {
    if (t < table[i]) return table[i] - t;
    t -= table[i];
  }
  return Infinity;
}

/* ---------------- the four minds ---------------- */

export type GhostName = "blinky" | "pinky" | "inky" | "clyde";

export const GHOSTS: readonly GhostName[] = ["blinky", "pinky", "inky", "clyde"];

export const GHOST_COLOR: Record<GhostName, string> = {
  blinky: "#ff3c26",
  pinky: "#ffb2df",
  inky: "#3ce8f0",
  clyde: "#ffa63c",
};

/**
 * Where each one goes when it is not hunting.
 *
 * Deliberately outside the maze. A ghost cannot reach a corner it cannot stand
 * in, so it circles the block nearest to it instead — which is why scatter
 * looks like patrolling rather than like parking, without a line of code
 * anywhere that says "patrol".
 */
export const SCATTER_TARGET: Record<GhostName, readonly [number, number]> = {
  blinky: [COLS - 3, -3],
  pinky: [2, -3],
  inky: [COLS - 1, ROWS + 2],
  clyde: [0, ROWS + 2],
};

/**
 * Pac-Man's tile offset by `n` in the direction he faces.
 *
 * The `up` case is the original's famous overflow: the target is shifted four
 * tiles up *and four tiles left*, because the routine added the offset to both
 * coordinates of a lookup table whose "up" entry was signed wrong. It is left
 * in because the entire safe-spot strategy is built on it — stand in the right
 * place facing up and Pinky will never take the shot — and because a version
 * without it is measurably harder in a way players describe as "these aren't
 * the real ghosts".
 */
export function ahead(
  pacX: number,
  pacY: number,
  pacDir: number,
  n: number
): [number, number] {
  const [dx, dy] = DIRS[pacDir];
  const tx = pacX + dx * n + (pacDir === UP ? -n : 0);
  const ty = pacY + dy * n;
  return [tx, ty];
}

/** Blinky goes straight at you. No cleverness, and none needed. */
export function blinkyTarget(pacX: number, pacY: number): [number, number] {
  return [pacX, pacY];
}

/** Pinky aims four ahead — she is trying to cut you off, not catch you. */
export function pinkyTarget(
  pacX: number,
  pacY: number,
  pacDir: number
): [number, number] {
  return ahead(pacX, pacY, pacDir, 4);
}

/**
 * Inky takes the vector from Blinky to a point two ahead of you, and doubles
 * it.
 *
 * The consequence is that he is only dangerous when Blinky is *also* near you,
 * and that he swings wildly when Blinky is far away — sometimes at you,
 * sometimes at the opposite wall. He is the only ghost whose behaviour depends
 * on another ghost, which is why he reads as erratic without being random.
 */
export function inkyTarget(
  pacX: number,
  pacY: number,
  pacDir: number,
  blinkyX: number,
  blinkyY: number
): [number, number] {
  const [px, py] = ahead(pacX, pacY, pacDir, 2);
  return [px * 2 - blinkyX, py * 2 - blinkyY];
}

/**
 * Clyde chases until he gets within eight tiles, then bolts for his corner.
 *
 * So he shuffles up, loses his nerve, wanders off, and comes back. It reads as
 * cowardice, and the reason it works as characterisation is that the rule is
 * about *him*, not about the player: nothing he does is a reaction to anything
 * you chose.
 */
export function clydeTarget(
  pacX: number,
  pacY: number,
  clydeX: number,
  clydeY: number
): [number, number] {
  const dx = clydeX - pacX;
  const dy = clydeY - pacY;
  if (dx * dx + dy * dy > 64) return [pacX, pacY];
  return [SCATTER_TARGET.clyde[0], SCATTER_TARGET.clyde[1]];
}

/**
 * The one movement rule all four share.
 *
 * At a junction, look at every direction except a reversal, discard the ones
 * that are walls, and take whichever leaves you closest to your target as the
 * crow flies. Straight-line distance, not path distance — a ghost will happily
 * commit to a corridor that leads away from you, and finding out that it has
 * is a large part of what makes them beatable.
 *
 * Returns the current direction if there is genuinely nowhere else to go,
 * which only happens inside the house.
 */
export function chooseDir(
  cx: number,
  cy: number,
  dir: number,
  targetX: number,
  targetY: number,
  opts: { canReverse?: boolean; obeyNoUp?: boolean } = {}
): number {
  const back = opposite(dir);
  let best = -1;
  let bestDist = Infinity;
  // DIRS is iterated in order, and `<` rather than `<=` keeps the first
  // candidate on a tie. That is the up-left-down-right preference.
  for (let d = 0; d < 4; d++) {
    if (d === back && !opts.canReverse) continue;
    if (d === UP && opts.obeyNoUp && noUpTile(cx, cy)) continue;
    const [dx, dy] = DIRS[d];
    const nx = wrapCol(cx + dx);
    const ny = cy + dy;
    if (!ghostWalkable(nx, ny)) continue;
    const ex = nx - targetX;
    const ey = ny - targetY;
    const dist = ex * ex + ey * ey;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best === -1 ? dir : best;
}

/* ---------------- the house ---------------- */

/**
 * How many pellets must be eaten before each ghost leaves, per level.
 *
 * Only Blinky is ever out immediately. On level one Clyde waits for sixty
 * pellets, which is most of a board — it is why the first level feels like a
 * tutorial without ever saying so, and why level three, where everyone leaves
 * at once, is the difficulty cliff.
 */
export function houseDots(level: number, ghost: GhostName): number {
  if (ghost === "blinky") return 0;
  if (level === 1) return ghost === "pinky" ? 0 : ghost === "inky" ? 30 : 60;
  if (level === 2) return ghost === "clyde" ? 50 : 0;
  return 0;
}

/**
 * After a death the per-ghost counters are abandoned for one global counter
 * with these thresholds, so that dying does not reset the board's pressure.
 */
export function globalHouseDots(ghost: GhostName): number {
  return ghost === "pinky" ? 7 : ghost === "inky" ? 17 : ghost === "clyde" ? 32 : 0;
}

/** Seconds of nobody eating anything before the house gives up and lets one out. */
export function houseTimeout(level: number): number {
  return level < 5 ? 4 : 3;
}

/* ---------------- scoring ---------------- */

export const PELLET_SCORE = 10;
export const ENERGIZER_SCORE = 50;
export const EXTRA_LIFE_AT = 10000;

/** 200, 400, 800, 1600 — doubling per ghost within one energizer. */
export function ghostScore(chain: number): number {
  return 200 * Math.pow(2, Math.min(Math.max(chain, 0), 3));
}

export interface Fruit {
  name: string;
  score: number;
  /** Body and detail colours for the drawing. */
  color: string;
  accent: string;
}

const FRUITS: Fruit[] = [
  { name: "cherry", score: 100, color: "#e0342a", accent: "#3fbf5a" },
  { name: "strawberry", score: 300, color: "#e83c4a", accent: "#3fbf5a" },
  { name: "orange", score: 500, color: "#ff9a2a", accent: "#3fbf5a" },
  { name: "apple", score: 700, color: "#d8202a", accent: "#8a5a2a" },
  { name: "melon", score: 1000, color: "#7fe04a", accent: "#2f8a3a" },
  { name: "galaxian", score: 2000, color: "#ffd23c", accent: "#3ce8f0" },
  { name: "bell", score: 3000, color: "#ffd23c", accent: "#e8ecff" },
  { name: "key", score: 5000, color: "#9fd6ff", accent: "#ffd23c" },
];

/** Levels 1..8 each get their own prize; from 13 on it is keys for ever. */
export function fruitFor(level: number): Fruit {
  if (level <= 2) return FRUITS[level - 1];
  if (level <= 4) return FRUITS[2];
  if (level <= 6) return FRUITS[3];
  if (level <= 8) return FRUITS[4];
  if (level <= 10) return FRUITS[5];
  if (level <= 12) return FRUITS[6];
  return FRUITS[7];
}

/** Pellets eaten at which a prize appears. Twice a board, both times. */
export const FRUIT_AT: readonly number[] = [70, 170];
export const FRUIT_LIFETIME = 9.5;

/**
 * Frames Pac-Man loses for eating.
 *
 * He stops dead for one frame on a pellet and three on an energizer. It is a
 * tiny effect that does a large amount of work: it is the reason a ghost can
 * run you down along a full corridor even at a lower nominal speed, and the
 * reason clearing the last pellets of a board is tense rather than a formality.
 */
export const EAT_STALL = 1;
export const ENERGIZER_STALL = 3;
