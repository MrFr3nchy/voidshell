/**
 * Missile Command: the geometry, the waves, and the arithmetic of losing.
 *
 * This is the only game on the floor you cannot win. There is no final wave;
 * the trajectories get faster and more numerous until six cities are gone and
 * the screen says THE END. Every design decision below follows from that, and
 * the most important one is that **the scoring rewards saving things, not
 * killing things**. A missile shot down is worth twenty-five points; a city
 * that survives a wave is worth a hundred, multiplied. So the optimal play is
 * not to intercept everything, it is to decide what to let through — which is
 * a considerably more uncomfortable game and the reason this one is remembered
 * as more than a shooter.
 *
 * The other structural thing: an interceptor does not kill anything. It makes
 * an *expanding sphere* that kills things, and the sphere outlives the shot by
 * a long way. Every skill in this game is about where to put a hole in the sky
 * a second and a half before anything needs to be there.
 */

export const GAME_W = 320;
export const GAME_H = 240;

/** Ground line. Everything below it is the thing you are defending. */
export const GROUND_Y = 222;
/** Where trajectories enter the screen. */
export const SKY_Y = 12;

/**
 * 60Hz. Everything here is a straight line at a constant speed, so the tick
 * rate buys no texture — it only decides how finely a fast trajectory is
 * sampled, and a warhead crossing the screen in two seconds needs the finer
 * sampling to read as a line rather than as a dotted one.
 */
export const TICK = 1 / 60;
export const MAX_TICKS = 6;

/* ---------------- what you are defending ---------------- */

/**
 * Three batteries and six cities, in the original's arrangement: a battery at
 * each end, one in the middle, and the cities in two clusters of three between
 * them.
 *
 * The asymmetry that matters is that the middle battery covers both clusters
 * and the outer two each cover one. Spending the middle battery early is the
 * most common way to lose, and the layout is the only thing that teaches it.
 */
export const BATTERY_X: readonly number[] = [24, 160, 296];
export const BATTERY_Y = GROUND_Y - 6;

export const CITY_X: readonly number[] = [56, 88, 120, 200, 232, 264];
export const CITY_Y = GROUND_Y - 4;
export const CITY_W = 22;
export const CITY_H = 10;

/** Missiles per battery, per wave. Thirty shots to cover everything. */
export const AMMO_PER_BATTERY = 10;

/* ---------------- the interceptor ---------------- */

export const INTERCEPT_SPEED = 210;
/** How fast the crosshair crosses the sky under keyboard control. */
export const CURSOR_SPEED = 150;

/**
 * The blast: grows, holds, shrinks. About a second and a half all told.
 *
 * The hold is what makes chains possible — a sphere that grew and vanished
 * would only ever catch what was already inside it, and stacking one intercept
 * to catch the four warheads a MIRV is about to become is the highest-value
 * play in the game.
 */
export const BLAST_GROW = 0.42;
export const BLAST_HOLD = 0.5;
export const BLAST_FADE = 0.55;
export const BLAST_R = 22;

export function blastRadius(t: number): number {
  if (t < BLAST_GROW) return BLAST_R * (t / BLAST_GROW);
  if (t < BLAST_GROW + BLAST_HOLD) return BLAST_R;
  const k = (t - BLAST_GROW - BLAST_HOLD) / BLAST_FADE;
  return Math.max(0, BLAST_R * (1 - k));
}

export const BLAST_LIFE = BLAST_GROW + BLAST_HOLD + BLAST_FADE;

/* ---------------- the waves ---------------- */

export interface WaveSpec {
  /** Warheads entering from the top over the course of the wave. */
  missiles: number;
  /** Descent speed, px/s. */
  speed: number;
  /** Chance per warhead of splitting into a MIRV on the way down. */
  splitChance: number;
  /** Aircraft crossing the screen and launching more. */
  planes: number;
  /** Bombs that steer around your blasts. The wave everything changes. */
  smart: number;
}

/**
 * The curve.
 *
 * Everything ramps and everything caps, but the caps are high enough that late
 * waves are genuinely unsurvivable — that is the design, not a failure of
 * tuning. What must *not* happen is a wave that is unsurvivable for a reason
 * the player cannot see, so the ramps are all in things that are visible on
 * screen: more of them, faster, and eventually ones that dodge.
 *
 * Smart bombs arrive at wave 7 in the original and they change the game
 * completely: everything before them can be handled by putting a blast in the
 * right place early, and they are the first thing that requires you to put one
 * in the *wrong* place and then correct.
 */
export function waveSpec(wave: number): WaveSpec {
  const k = wave - 1;
  return {
    missiles: Math.min(22, 8 + Math.floor(k * 1.35)),
    speed: Math.min(74, 20 + k * 3.6),
    splitChance: wave < 3 ? 0 : Math.min(0.4, 0.08 + (wave - 3) * 0.035),
    planes: wave < 5 ? 0 : Math.min(3, 1 + Math.floor((wave - 5) / 4)),
    smart: wave < 7 ? 0 : Math.min(4, 1 + Math.floor((wave - 7) / 3)),
  };
}

/** How many pieces a MIRV becomes, and how high up it happens. */
export const SPLIT_MIN = 2;
export const SPLIT_MAX = 3;
export const SPLIT_BAND: readonly [number, number] = [60, 130];

export const SMART_SPEED = 40;
/** How far a smart bomb looks ahead when deciding to swerve. */
export const SMART_AVOID = 34;
export const PLANE_SPEED = 46;

/* ---------------- scoring ---------------- */

/**
 * The multiplier, by wave: 1, 1, 2, 2, 3, 3, ... capping at 6.
 *
 * This is why a Missile Command score is not a measure of how long you lasted.
 * A city carried into wave eleven is worth six hundred points every wave it
 * survives, so the whole game is a bet on how much you can protect *now* to be
 * paid later — and losing your last two cities on wave nine costs you far more
 * than the two cities.
 */
export function multiplier(wave: number): number {
  return Math.min(6, Math.floor((wave + 1) / 2));
}

export const SCORE_MISSILE = 25;
export const SCORE_PLANE = 100;
export const SCORE_SMART = 125;
export const SCORE_UNUSED_MISSILE = 5;
export const SCORE_SAVED_CITY = 100;

/** What a survived wave pays: leftovers and, mostly, the cities. */
export function waveBonus(missilesLeft: number, cities: number, wave: number): number {
  const m = multiplier(wave);
  return (missilesLeft * SCORE_UNUSED_MISSILE + cities * SCORE_SAVED_CITY) * m;
}

/**
 * A city back every ten thousand points.
 *
 * The only mercy in the game, and it is on a treadmill: the score needed for
 * the next one is flat while the rate at which you lose cities is not.
 */
export const BONUS_CITY_EVERY = 10000;

/* ---------------- helpers ---------------- */

/** Is a point inside a blast? Squared, because this runs against everything. */
export function inBlast(
  px: number,
  py: number,
  bx: number,
  by: number,
  r: number
): boolean {
  const dx = px - bx;
  const dy = py - by;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Which battery should answer a click at `x`.
 *
 * The original has a button per battery and a trackball; a cabinet with four
 * arrows and one fire button cannot express that, so the nearest battery with
 * ammo left answers. This is a real concession and it is worth naming: it
 * costs the player the ability to deliberately spend the middle battery's
 * stock, which is a genuine tactic. What it preserves — and what actually
 * matters minute to minute — is that ammunition is local, so emptying one end
 * of the map leaves that end undefended for the rest of the wave.
 */
export function pickBattery(x: number, ammo: readonly number[]): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < BATTERY_X.length; i++) {
    if (ammo[i] <= 0) continue;
    const d = Math.abs(BATTERY_X[i] - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
