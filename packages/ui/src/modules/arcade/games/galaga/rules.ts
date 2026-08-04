/**
 * Galaga: the formation, the flight paths, and what everything is worth.
 *
 * The thing that separates this from the shooter it is descended from is that
 * **the enemies are somewhere when they are not attacking**. A formation of
 * forty sits at the top of the screen breathing gently, and the danger comes
 * from small groups peeling out of it and coming back. That structure is what
 * gives the game its rhythm — pressure, lull, pressure — and it is also what
 * makes it readable: you always know where the rest of them are.
 *
 * The other thing is the capture. A boss can steal your ship, and you can
 * shoot it back and fly both at once for double the firepower and double the
 * target. Deliberately trading a life for a chance at that is the whole
 * risk/reward core of the game, and a version without it is just a nicely
 * choreographed shooter.
 */

export const GAME_W = 224;
export const GAME_H = 272;

/**
 * 60Hz, like Pac-Man and unlike Joust.
 *
 * Everything here moves along a path at a speed in pixels per second, and the
 * arcs only read as arcs if they are sampled finely enough. At 30Hz a diving
 * enemy at 130px/s steps four pixels at a time through the tightest part of
 * its loop, which turns the curve into a visible polygon — the opposite of the
 * texture the coarse tick buys in Joust.
 */
export const TICK = 1 / 60;
export const MAX_TICKS = 6;

/* ---------------- the formation ---------------- */

export type Kind = "bee" | "butterfly" | "boss";

export interface Slot {
  col: number;
  row: number;
  kind: Kind;
  x: number;
  y: number;
}

export const FORM_COLS = 10;
export const FORM_DX = 16;
export const FORM_DY = 16;
export const FORM_X0 = GAME_W / 2 - ((FORM_COLS - 1) * FORM_DX) / 2;
export const FORM_Y0 = 44;

/**
 * Forty enemies in five rows, and the shape of those rows is the difficulty
 * curve of a single stage.
 *
 * Four bosses across the top middle, sixteen butterflies under them, twenty
 * bees at the bottom. Bees are nearest and worth least; the bosses are furthest
 * away, take two hits, and are the only ones that can take your ship. So the
 * formation is sorted by value with the cheap targets in front, which is why
 * clearing a stage from the bottom up feels natural and why going after a boss
 * early is a decision rather than a default.
 */
export function slots(): Slot[] {
  const out: Slot[] = [];
  const add = (col: number, row: number, kind: Kind) => {
    out.push({
      col,
      row,
      kind,
      x: FORM_X0 + col * FORM_DX,
      y: FORM_Y0 + row * FORM_DY,
    });
  };
  for (let c = 3; c <= 6; c++) add(c, 0, "boss");
  for (const r of [1, 2]) for (let c = 1; c <= 8; c++) add(c, r, "butterfly");
  for (const r of [3, 4]) for (let c = 0; c <= 9; c++) add(c, r, "bee");
  return out;
}

export const FORMATION_SIZE = 40;

/**
 * The formation sways rather than sitting still.
 *
 * Eight pixels either way on a slow cycle. It is almost subliminal and it does
 * two jobs: it stops forty static sprites from reading as scenery, and it
 * means a shot lined up on a distant column has to be led slightly, so picking
 * off the back rows is a skill rather than a formality.
 */
export const SWAY_AMPLITUDE = 8;
export const SWAY_PERIOD = 4.6;

export function swayAt(t: number): number {
  return Math.sin((t / SWAY_PERIOD) * Math.PI * 2) * SWAY_AMPLITUDE;
}

/* ---------------- flight paths ---------------- */

export type Point = readonly [number, number];

/**
 * Where a flight of enemies comes in from, as a list of waypoints.
 *
 * Enemies do not teleport into formation and they do not fly straight lines.
 * They come in off the edge of the screen, loop once, and rise into their
 * slots — and the loop is the point. Steering toward a waypoint with a capped
 * turn rate turns a handful of points into a banked curve for free, which is
 * both far less data than sampling a spline and far easier to retune: moving
 * one point moves one part of the arc.
 *
 * Three shapes, mirrored, which is what the original cycles through.
 */
export function entryPath(shape: number, mirror: boolean): Point[] {
  const m = (x: number): number => (mirror ? GAME_W - x : x);
  switch (((shape % 3) + 3) % 3) {
    case 0:
      // In low from the side, up the middle, over the top of its own loop.
      return [
        [m(-24), 150],
        [m(60), 176],
        [m(118), 150],
        [m(126), 100],
        [m(90), 74],
        [m(60), 104],
      ];
    case 1:
      // Down from above the corner, a tight loop at waist height.
      return [
        [m(40), -24],
        [m(56), 60],
        [m(104), 116],
        [m(150), 92],
        [m(132), 48],
        [m(96), 66],
      ];
    default:
      // Straight down the far edge, then a long sweep back across.
      return [
        [m(206), -24],
        [m(200), 96],
        [m(160), 168],
        [m(96), 186],
        [m(48), 140],
        [m(80), 96],
      ];
  }
}

/**
 * A dive: down past the player and off the bottom of the screen.
 *
 * The last waypoint is below the playfield on purpose. An attacker that pulls
 * up and turns round in view is easy to track and easy to shoot; one that
 * commits, leaves, and comes back in from the top is the thing that makes a
 * Galaga screen feel like it is circulating rather than oscillating.
 *
 * The swerve is a fraction of the way toward the player rather than a lock on
 * them. A perfectly aimed dive is unavoidable and reads as unfair; a dive that
 * commits to where you *were* is dodgeable and reads as aggressive, which is
 * the difference between a hard game and a cheap one.
 */
export function divePath(x: number, y: number, playerX: number, side: number): Point[] {
  const swerve = x + (playerX - x) * 0.7;
  return [
    [x + side * 34, y + 26],
    [x + side * 46, y + 76],
    [swerve + side * 20, 168],
    [swerve, 232],
    [swerve - side * 30, GAME_H + 30],
  ];
}

/** Coming back for another go, from above the top edge. */
export function reentryX(seed: number): number {
  return 20 + ((seed * 53) % 185);
}

/* ---------------- speeds and pressure ---------------- */

export const PLAYER_SPEED = 96;
export const BULLET_SPEED = 320;
/** Galaga lets you have two shots in the air. Dual fighters get four. */
export const MAX_SHOTS = 2;
export const MAX_SHOTS_DUAL = 4;

export const ENTRY_SPEED = 128;
/** Radians per second a flying enemy can turn. The banking, in one number. */
export const TURN_RATE = 7.4;
/** How near a waypoint counts as reached. */
export const WAYPOINT_R = 12;

/**
 * How hard a stage pushes, given its number.
 *
 * Everything ramps and everything caps. Uncapped ramps produce a stage
 * somewhere in the twenties where the screen is solid with bullets and the
 * game stops being a game; the original's late stages are relentless but
 * always survivable, and the cap is what makes that true.
 */
export function stageSpec(stage: number): {
  diveEvery: number;
  divers: number;
  diveSpeed: number;
  bulletSpeed: number;
  fireChance: number;
  beamAfter: number;
} {
  const k = Math.min(stage - 1, 20);
  return {
    diveEvery: Math.max(0.75, 2.4 - k * 0.08),
    divers: Math.min(3, 1 + Math.floor(k / 5)),
    diveSpeed: Math.min(190, 118 + k * 3.6),
    bulletSpeed: Math.min(150, 86 + k * 3.2),
    fireChance: Math.min(0.55, 0.16 + k * 0.02),
    // Seconds into a stage before a boss will try for your ship. Never on the
    // first stage: being captured before you know capture exists reads as the
    // game breaking rather than as the game's best idea.
    beamAfter: stage <= 1 ? Infinity : Math.max(7, 20 - k * 0.6),
  };
}

/**
 * Challenging stages: stage 3, then every fourth.
 *
 * Forty enemies fly through in formation-less patterns, none of them fire, and
 * hitting all forty pays a flat ten thousand. It is a breather and a
 * marksmanship test at once, and it is the reason a Galaga score is not simply
 * a function of how long you survived.
 */
export function isChallenge(stage: number): boolean {
  return stage === 3 || (stage > 3 && (stage - 3) % 4 === 0);
}

export const PERFECT_BONUS = 10000;

/* ---------------- scoring ---------------- */

/**
 * What a kill is worth. Everything is worth more in the air than in the rack.
 *
 * That single rule is the game's entire risk structure: the safe play is to
 * chip at the formation and the profitable play is to wait for them to come to
 * you. A boss diving with two escorts is worth more than ten times a bee, and
 * hitting it at exactly the right moment is the highest-value act in the game.
 */
export function killScore(kind: Kind, diving: boolean, escorts = 0): number {
  if (kind === "bee") return diving ? 100 : 50;
  if (kind === "butterfly") return diving ? 160 : 80;
  if (!diving) return 150;
  return escorts >= 2 ? 1600 : escorts === 1 ? 800 : 400;
}

/** A boss takes two. The first hit only changes its colour. */
export const BOSS_HITS = 2;

export const EXTRA_LIFE_FIRST = 20000;
export const EXTRA_LIFE_EVERY = 70000;

/** How many extra lives `score` has earned: one at 20k, then every 70k. */
export function livesEarned(score: number): number {
  if (score < EXTRA_LIFE_FIRST) return 0;
  return 1 + Math.floor((score - EXTRA_LIFE_FIRST) / EXTRA_LIFE_EVERY);
}

/* ---------------- the tractor beam ---------------- */

/** How long the beam is open. Long enough to walk out of, if you notice. */
export const BEAM_OPEN = 0.9;
export const BEAM_HOLD = 1.9;
export const BEAM_CLOSE = 0.7;
/** Half-width of the beam where it reaches the player's row. */
export const BEAM_HALF_W = 26;
/** How far down a boss comes to cast it. */
export const BEAM_Y = 108;

export const PLAYER_Y = GAME_H - 26;
export const PLAYER_W = 13;
export const PLAYER_H = 12;
/** Docking offset for a rescued second fighter. */
export const DUAL_OFFSET = 14;
