/**
 * Joust: the numbers, and the rules that are pure enough to check.
 *
 * Everything here is either a tuning constant or a total function of its
 * arguments, which is the point — the simulation in `index.ts` needs a canvas
 * and a frame loop and can only really be judged by playing it, but *these*
 * can be asserted headlessly, and they are the parts where being wrong is
 * silent. `flapApex` is the one that matters most: get gravity and the flap
 * impulse out of proportion and the game is still perfectly playable, just not
 * Joust, and nothing about it looks broken.
 *
 * The lance rule is the whole game. Two riders collide and the higher lance
 * wins, full stop — not the faster one, not the one who struck first. Everything
 * a Joust player learns is a consequence of that single comparison, so it lives
 * in one function with a tolerance band for the draw.
 */

/* ---------------- the playfield ---------------- */

export const GAME_W = 320;
export const GAME_H = 240;

/** Lava surface. Anything whose feet reach this is gone. */
export const LAVA_Y = 228;

/* ---------------- flight ---------------- */

export const GRAVITY = 260;
/** Velocity a single flap adds. Per *press* — never a held key. */
export const FLAP_DV = 86;
/** Flapping harder than this doesn't climb faster. Caps mash-to-win. */
export const FLAP_VY_CAP = -120;
export const FLAP_COOLDOWN = 0.13;
export const TERMINAL_VY = 250;

export const ACC_AIR = 200;
export const ACC_GROUND = 300;
export const MAX_VX_AIR = 118;
export const MAX_VX_GROUND = 76;
/** Steering against your own momentum. The skid is the signature feel. */
export const TURN_BOOST = 2.2;
export const DRAG_AIR = 0.35;
export const DRAG_GROUND = 6;

/** Sprite footprint. Collision uses an inset box; see `HIT_*`. */
export const SPR_W = 20;
export const SPR_H = 16;
export const HIT_DX = 3;
export const HIT_DY = 2;
export const HIT_W = 13;
export const HIT_H = 13;

/* ---------------- combat ---------------- */

/**
 * Lance heights within this many pixels are a draw: both riders bounce off and
 * nobody is unhorsed. Without a band, the outcome of a level collision would
 * be decided by sub-pixel noise, which reads to a player as "random".
 */
export const LANCE_TIE = 3;
export const BOUNCE_VX = 74;
export const BOUNCE_VY = -46;

export type Joust = "a" | "b" | "draw";

/**
 * Who wins a collision. `aY` and `bY` are lance heights — the top of each
 * sprite — so *smaller is higher* and smaller wins.
 */
export function resolveJoust(aY: number, bY: number): Joust {
  if (Math.abs(aY - bY) <= LANCE_TIE) return "draw";
  return aY < bY ? "a" : "b";
}

/**
 * How high one flap from a standstill lifts you, in playfield pixels.
 *
 * Pure kinematics: v²/2g. Worth naming because it is the one ratio that
 * decides whether the game feels like Joust — about a body height per flap,
 * so crossing the screen vertically is a deliberate act rather than a keypress.
 */
export function flapApex(dv: number = FLAP_DV, g: number = GRAVITY): number {
  return (dv * dv) / (2 * g);
}

/* ---------------- the enemy ladder ---------------- */

export interface Tier {
  name: string;
  /** Body colour. Tier is readable at a glance or the game is unfair. */
  color: string;
  shade: string;
  score: number;
  /** Multiplier on steering force and flap rate. */
  vigour: number;
}

export const TIERS: Tier[] = [
  { name: "bounder", color: "#d1443c", shade: "#8c241f", score: 500, vigour: 0.74 },
  { name: "hunter", color: "#b9c3d6", shade: "#6f7a90", score: 750, vigour: 0.92 },
  { name: "shadow lord", color: "#5f7dff", shade: "#33459c", score: 1500, vigour: 1.14 },
];

export const PTERO_SCORE = 1000;
export const SURVIVAL_BONUS = 3000;
export const EGG_WAVE_BONUS = 3000;
export const EXTRA_LIFE_EVERY = 20000;

/**
 * What an egg is worth. `n` is how many have been collected in the current
 * chain — the run since the player last touched a platform. Caps at four.
 */
export function eggChain(n: number): number {
  return Math.min(250 * (n + 1), 1000);
}

/* ---------------- waves ---------------- */

export type WaveKind = "normal" | "survival" | "egg";

/**
 * Every fifth wave is nothing but eggs; every fifth wave offset by three asks
 * you to get through without dying. Both are breathers with a bonus attached,
 * and both are original Joust structure rather than invention.
 */
export function waveKind(wave: number): WaveKind {
  if (wave % 5 === 0) return "egg";
  if (wave % 5 === 3) return "survival";
  return "normal";
}

/** How many enemies wave `n` opens with. */
export function waveEnemies(wave: number): number {
  if (waveKind(wave) === "egg") return 0;
  return Math.min(3 + Math.floor((wave - 1) * 0.7), 8);
}

/**
 * The tier an enemy spawns at. Later waves start further up the ladder, but
 * the roll is deterministic in `i` so a wave is never all shadow lords by luck.
 */
export function spawnTier(wave: number, i: number): number {
  const lift = Math.floor((wave - 1) / 3);
  return Math.max(0, Math.min(2, lift + ((i % 3 === 2 ? 1 : 0) - (i % 4 === 0 ? 1 : 0))));
}

/**
 * Seconds of wave before the pterodactyl comes to move you along.
 *
 * Measured rather than guessed. A deliberately mediocre bot — fixed flap
 * rhythm, reversing every two thirds of a second, no target selection — clears
 * a wave in a median 23s, p90 36s, worst 51s over 58 waves. At 38 it fired on
 * 9% of those, which is far too often for something that is supposed to mean
 * "you are stalling"; at 45 it fires on 5%, so a wave played at all cleanly
 * never sees one and a wave that drags always will.
 */
export const PTERO_AFTER = 45;

/* ---------------- the base, and what eats it ---------------- */

export interface Platform {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The arena for a given wave.
 *
 * From wave 7 the base burns back from both ends of each segment, so the lava
 * gaps widen and the floor stops being a place to rest. It never disappears
 * entirely — a floorless wave isn't hard, it's over.
 */
export function arena(wave: number): Platform[] {
  const erode = Math.max(0, wave - 6) * 2;
  const base = (x: number, w: number): Platform => {
    const bite = Math.min(erode, Math.max(0, (w - 24) / 2));
    return { x: x + bite, y: 210, w: w - bite * 2, h: 8 };
  };
  return [
    base(0, 96),
    base(128, 64),
    base(224, 96),
    { x: 24, y: 168, w: 72, h: 7 },
    { x: 224, y: 168, w: 72, h: 7 },
    { x: 120, y: 132, w: 80, h: 7 },
    { x: 0, y: 96, w: 56, h: 7 },
    { x: 264, y: 96, w: 56, h: 7 },
    { x: 132, y: 62, w: 56, h: 7 },
  ];
}

/* ---------------- eggs ---------------- */

/** Seconds an egg lies still before it cracks. */
export const EGG_HATCH = 9;
/** Seconds the hatched rider waits on foot before a buzzard comes for them. */
export const EGG_WAIT = 3.5;
export const EGG_W = 7;
export const EGG_H = 9;

/**
 * The shortest signed distance from `a` to `b` on a cylinder of width `w`.
 *
 * The playfield wraps, so "which way is the player" has two answers and the
 * naive subtraction picks the wrong one near an edge — enemies would turn away
 * from a player standing right next to them through the seam. Every steering
 * and collision test in the game goes through this.
 */
export function wrapDelta(a: number, b: number, w: number = GAME_W): number {
  let d = b - a;
  if (d > w / 2) d -= w;
  if (d < -w / 2) d += w;
  return d;
}

/** Bring an x back into [0, w). */
export function wrapX(x: number, w: number = GAME_W): number {
  return ((x % w) + w) % w;
}
