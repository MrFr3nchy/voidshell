/**
 * Asteroids: the geometry of a screen with no floor and no walls.
 *
 * Every other cabinet on this floor has an arena with an edge that means
 * something — a lava pool, a maze wall, a ground line. This one doesn't. The
 * playfield is a torus: leave through the right edge and you re-enter on the
 * left, leave through the top and you re-enter on the bottom, and that is true
 * of the ship, every bullet, every rock and every saucer with no exception.
 * `wrapX`, `wrapY` and `wrapDelta` below are the one place that fact lives;
 * everything else — steering, collision, drawing — goes through them, per the
 * arcade's own rule about wrapped screens.
 *
 * Two physics decisions are worth stating up front because they are the ones
 * most likely to look like bugs to someone who hasn't played the original:
 *
 * **The ship has no rotational momentum.** Left and right turn the facing at
 * a fixed rate, instantly, full stop. This is the opposite of Joust's lesson
 * about separating sprite from momentum — there the sprite snaps and the body
 * doesn't, here *neither* the heading nor the turn has any inertia. Real
 * Asteroids never gave you a reason to want one; the ship is a gun platform,
 * not a body.
 *
 * **The ship has no friction.** Thrust adds velocity in the direction you're
 * facing and nothing ever removes it. Let go of thrust while sliding sideways
 * past a rock and you keep sliding sideways past it, forever, until you thrust
 * again to change that. This is not an oversight — it is the entire skill of
 * flying the ship, and a version with drag added back in is a different, easier
 * game wearing this one's sprites.
 */

/* ---------------- the screen ---------------- */

export const GAME_W = 320;
export const GAME_H = 240;

/**
 * 60Hz, in the family with Pac-Man, Galaga and Missile Command rather than
 * Joust. Nothing here has the kind of period texture a coarse clock puts back
 * in — the ship turns at a rate in radians per second and everything else
 * moves in a straight line at a speed in pixels per second, so the
 * quantisation is coming from nowhere but the clock, and a coarse one would
 * only turn arcs into polygons and long coasts into a stutter.
 */
export const TICK = 1 / 60;
export const MAX_TICKS = 6;

/** Bring a coordinate back into [0, size). The torus, one axis at a time. */
export function wrapX(x: number, w: number = GAME_W): number {
  return ((x % w) + w) % w;
}

export function wrapY(y: number, h: number = GAME_H): number {
  return ((y % h) + h) % h;
}

/**
 * The shortest signed distance from `a` to `b` on a ring of size `size`.
 *
 * Used for both axes: pass `GAME_W` for x and `GAME_H` for y. Without this,
 * two rocks standing right next to each other across the seam measure as
 * being the width of the screen apart, which breaks collision at the one
 * place on the field a player can't see it coming.
 */
export function wrapDelta(a: number, b: number, size: number): number {
  let d = b - a;
  if (d > size / 2) d -= size;
  if (d < -size / 2) d += size;
  return d;
}

/** Do two circles overlap, measured the short way around the torus? */
export function wrappedOverlap(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
  w: number = GAME_W,
  h: number = GAME_H
): boolean {
  const dx = wrapDelta(ax, bx, w);
  const dy = wrapDelta(ay, by, h);
  const r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Which screen-space copies of a circle at `(x, y)` with radius `r` need to be
 * drawn so it never appears to vanish through an edge it's only touching.
 * Always includes the real position; adds one more per edge the circle
 * overlaps and a corner copy if it overlaps two at once.
 */
export function wrapOffsets(
  x: number,
  y: number,
  r: number,
  w: number = GAME_W,
  h: number = GAME_H
): readonly (readonly [number, number])[] {
  const xs = [0];
  if (x - r < 0) xs.push(w);
  if (x + r > w) xs.push(-w);
  const ys = [0];
  if (y - r < 0) ys.push(h);
  if (y + r > h) ys.push(-h);
  const out: [number, number][] = [];
  for (const ox of xs) for (const oy of ys) out.push([ox, oy]);
  return out;
}

/* ---------------- the ship ---------------- */

export const SHIP_RADIUS = 5;
/** Radians per second. No momentum: the heading is exactly this times held time. */
export const TURN_RATE = 5.3;
export const THRUST_ACCEL = 165;
/**
 * A safety clamp, not a game mechanic. The original has no speed limit at
 * all — thrust in one direction long enough and you are eventually moving
 * faster than anything else on the screen, and experienced players use
 * exactly that to cross the field fast. This exists only so a stuck key
 * during an idle tab can't drive the ship's velocity to something
 * non-finite; it's set high enough that ordinary play never brushes it.
 */
export const SHIP_MAX_SPEED = 260;
export const RESPAWN_INVULN = 2.2;

/* ---------------- bullets ---------------- */

/**
 * Fixed speed, independent of the ship's own velocity — the original fires a
 * shot at a constant speed relative to the *screen*, not relative to the
 * ship. Flying backwards past your own bullet is a real thing that happens.
 */
export const BULLET_SPEED = 280;
export const BULLET_LIFE = 0.9;
/**
 * Four on screen at once, matching the original's real limit. It is not a
 * performance concession: running out of shots while a field is still full
 * is a constraint players have to fly around, and a version with unlimited
 * ammunition is a much easier and much less interesting game.
 */
export const MAX_BULLETS = 4;

/* ---------------- asteroids ---------------- */

export type AsteroidSize = "large" | "medium" | "small";

export const ASTEROID_RADIUS: Record<AsteroidSize, number> = {
  large: 24,
  medium: 13,
  small: 6,
};

/** Pixels per second. Faster the smaller they get, as in the original. */
export const ASTEROID_SPEED_RANGE: Record<AsteroidSize, readonly [number, number]> = {
  large: [14, 28],
  medium: [26, 52],
  small: [46, 86],
};

export const CHILDREN_PER_SPLIT = 2;

/** What a hit becomes. `null` means it's simply gone. */
export function childSize(size: AsteroidSize): AsteroidSize | null {
  if (size === "large") return "medium";
  if (size === "medium") return "small";
  return null;
}

/**
 * Small and worth finding is worth more than large and hard to miss — the
 * same principle Galaga states for its formation and Missile Command states
 * for its warheads: the harder target pays more.
 */
export const SCORE_ASTEROID: Record<AsteroidSize, number> = {
  large: 20,
  medium: 50,
  small: 100,
};

/**
 * How many asteroids a wave opens with. Four on the first field, climbing by
 * one a wave, capped at eleven — the original's own ramp, so a late field is
 * genuinely dense but never a screen you can't parse.
 */
export function waveAsteroidCount(wave: number): number {
  return Math.min(11, 3 + Math.max(1, wave));
}

/**
 * A stable jagged outline: `vertices` radius multipliers around the circle,
 * each between 0.7 and 1.15 of the nominal radius. Generated once per rock
 * from an injected `rand` so it's reproducible for a given seed, then stored
 * on the asteroid and reused every frame — regenerating it per draw would
 * make the outline shimmer.
 */
export function makeAsteroidShape(rand: () => number, vertices = 10): number[] {
  const out: number[] = [];
  for (let i = 0; i < vertices; i++) out.push(0.7 + rand() * 0.45);
  return out;
}

/* ---------------- saucers ---------------- */

export type SaucerKind = "large" | "small";

export const SAUCER_RADIUS: Record<SaucerKind, number> = { large: 11, small: 6 };
export const SAUCER_SPEED: Record<SaucerKind, number> = { large: 55, small: 85 };
/** Small and dangerous is worth far more than large and mostly harmless. */
export const SAUCER_SCORE: Record<SaucerKind, number> = { large: 200, small: 1000 };
export const SAUCER_BULLET_SPEED = 200;
export const SAUCER_BULLET_LIFE = 1.6;

/**
 * How long between saucers, given the score so far. Escalates with score
 * exactly like the original's threat curve: an early game with no saucers to
 * speak of, a late one that barely lets up.
 */
export function saucerSpawnInterval(score: number): number {
  return Math.max(6, 20 - score / 2000);
}

/**
 * The odds a spawning saucer is the small, accurate, dangerous kind rather
 * than the large, wandering one. Climbs with score and caps well short of
 * certainty — the large kind never stops showing up entirely.
 */
export function saucerKindChance(score: number): number {
  return Math.min(0.75, 0.15 + score / 20000);
}

/**
 * How far a saucer's shot can stray from a dead-on aim, in radians. This is
 * the whole difference between the two kinds, stated as one number instead
 * of as two separate code paths: the large saucer's spread is a full circle
 * (it is not aiming at you at all — see the design note on `AGENTS.md` about
 * putting the incompetence in the choosing, not in whether it can reach you),
 * and the small saucer's spread starts noticeably off and tightens as the
 * score climbs, exactly matching the original's escalating accuracy.
 */
export function saucerSpread(kind: SaucerKind, score: number): number {
  if (kind === "large") return Math.PI;
  return Math.max(0.05, 0.5 - score / 60000);
}

/* ---------------- lives & score ---------------- */

export const STARTING_LIVES = 3;
/** An extra ship at ten thousand, then every ten thousand after. */
export const EXTRA_LIFE_SCORE = 10000;

export function livesEarned(score: number): number {
  return Math.floor(score / EXTRA_LIFE_SCORE);
}

/* ---------------- hyperspace ---------------- */

/**
 * The panic button, and the original's actual bargain: teleport anywhere on
 * screen at random, with a real chance the ship doesn't come back. About one
 * reentry in six ends badly — high enough that mashing it on reflex is a real
 * gamble, low enough that a considered emergency use is usually worth it.
 */
export const HYPERSPACE_DEATH_CHANCE = 1 / 6;

export function hyperspaceDestination(rand: () => number): { x: number; y: number } {
  return { x: rand() * GAME_W, y: rand() * GAME_H };
}
