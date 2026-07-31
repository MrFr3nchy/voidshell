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

/**
 * The simulation tick.
 *
 * Fixed, and deliberately coarse. Running the physics at the display's refresh
 * rate produces motion that is smooth in a way nothing from 1982 was, and
 * smoothness is most of what made the first version feel wrong: a modern game
 * with Joust's rules rather than Joust. Ticking at 30Hz and drawing the result
 * without interpolating puts the chunk back — sprites step rather than glide.
 *
 * Fixed-step also makes the whole game deterministic in the input sequence,
 * which is why the bot in the harness is worth anything.
 */
export const TICK = 1 / 30;
/** Ticks per frame ceiling. A long frame must never be simulated all at once. */
export const MAX_TICKS = 4;

/**
 * Velocity quantum, in px/s.
 *
 * Games of this era did their arithmetic in fixed point, so velocities lived
 * on a grid and acceleration arrived in visible steps rather than as a smooth
 * ramp. Snapping to a grid reproduces that texture.
 *
 * Applied at the point of *integration*, never to the stored velocity. That
 * distinction is not pedantry: rounding the stored value throws the remainder
 * away every tick, and any acceleration smaller than half a quantum per tick
 * is then annihilated rather than merely small. `ACC_AIR` contributes 1.4px/s
 * per tick against a 6px/s grid, so storing the rounded value silently reduced
 * air steering to *exactly* zero. Real fixed point keeps the residue and steps
 * once it has accumulated, which is what happens here.
 */
export const VQ = 6;

export function quantize(v: number, step: number = VQ): number {
  return Math.round(v / step) * step;
}

export const GRAVITY = 272;
/** Velocity a single flap adds. Per *press* — never a held key. */
export const FLAP_DV = 96;
/** Flapping harder than this doesn't climb faster. Caps mash-to-win. */
export const FLAP_VY_CAP = -132;
export const FLAP_COOLDOWN = 0.14;
export const TERMINAL_VY = 260;

/**
 * Horizontal kick from a flap, in the direction being held.
 *
 * This is the change that matters most. Holding a direction in mid-air used to
 * accelerate you smoothly, which meant the stick flew the bird and the flap
 * only supplied height — two independent controls, and far too much authority.
 * In Joust the wings do both: you go where you flap. `ACC_AIR` is now a
 * fraction of what it was, so drifting steers you a little and flapping is
 * what actually moves you, and the rhythm of the game is the flap rather than
 * the stick.
 */
export const FLAP_DVX = 34;

export const ACC_AIR = 30;
export const ACC_GROUND = 260;
export const MAX_VX_AIR = 126;
export const MAX_VX_GROUND = 84;

/**
 * Steering against your own momentum.
 *
 * Was 2.2 — a boost, which made a reversal snappy and deleted the single most
 * characteristic thing about flying in this game. Below 1 it is *harder* to
 * turn than to keep going, so committing to a direction is a real decision and
 * changing your mind costs you about a second and most of a screen. That cost
 * is the skill ceiling; without it there is no reason to think before you flap.
 */
export const TURN_BOOST = 0.82;

/** Almost nothing. You coast until something stops you. */
export const DRAG_AIR = 0.22;

/**
 * Ground friction, and the skid.
 *
 * Landing fast doesn't grip — it slides, and you keep sliding until you are
 * slow enough for the feet to bite. `DRAG_GROUND` is the bite, `SKID_ABOVE` is
 * the speed under which it applies, and `DRAG_SKID` is the much weaker drag
 * above it. Overshooting your landing and sailing off the far end of a ledge
 * is supposed to be a thing that happens to you.
 */
export const DRAG_GROUND = 4.4;
export const DRAG_SKID = 0.9;
export const SKID_ABOVE = 46;

/** Sprite footprint. Collision uses an inset box; see `HIT_*`. */
export const SPR_W = 20;
export const SPR_H = 16;
export const HIT_DX = 3;
export const HIT_DY = 2;
export const HIT_W = 13;
export const HIT_H = 13;

/* ---------------- combat ---------------- */

/**
 * The grid lance heights are compared on.
 *
 * Heights are snapped to this before being compared, so "higher" is a coarse
 * question rather than an exact one. A finer comparison is *fairer* and feels
 * worse: it turns every near-level clash into a deterministic outcome the
 * player has no way to read, which registers as the game being fussy. On a
 * 5px grid a close pass is visibly close, and the draw that comes out of it
 * looks like the draw it is.
 */
export const LANCE_GRID = 5;
/** Snapped heights within this many grid steps are a draw. */
export const LANCE_TIE = 1;

/** Collisions ricochet hard. Getting shoved across the screen is the point. */
export const BOUNCE_VX = 96;
export const BOUNCE_VY = -58;

export type Joust = "a" | "b" | "draw";

/**
 * Who wins a collision. `aY` and `bY` are lance heights — the top of each
 * sprite — so *smaller is higher* and smaller wins.
 */
export function resolveJoust(aY: number, bY: number): Joust {
  const a = Math.round(aY / LANCE_GRID);
  const b = Math.round(bY / LANCE_GRID);
  if (Math.abs(a - b) <= LANCE_TIE) return "draw";
  return a < b ? "a" : "b";
}

/**
 * How high one flap from a standstill lifts you, in playfield pixels.
 *
 * Pure kinematics: v²/2g. Worth naming because it is the one ratio that
 * decides whether the game feels like Joust — about a body height per flap,
 * so crossing the screen vertically is a deliberate act rather than a keypress.
 *
 * This is the *continuous* answer and the simulation no longer matches it: at
 * 30Hz with quantised velocity the real apex comes out around 11% lower (16.9
 * analytic against 15.0 actual). Keep it as the design ratio and the thing to
 * assert on — it is stable, it is checkable, and it is what you reach for when
 * deciding whether gravity and the flap are still in proportion — but do not
 * read it as a measurement of the shipped game.
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
  /**
   * How long this tier goes between looking at the player, in seconds. It
   * steers at a *snapshot* taken this often, not at where you actually are,
   * so a long interval means chasing a ghost of you from a second ago.
   */
  think: number;
  /**
   * Random offset added to the snapshot, in pixels. Large values are why a
   * bounder crosses the screen for somewhere you have never been.
   */
  scatter: number;
  /**
   * Odds per decision of committing to a direction and refusing to reconsider
   * until the next one. This is what produces the overshoot — sailing past
   * you and having to come all the way back.
   */
  commit: number;
  /**
   * How reliably it saves itself from the lava, 0..1. Emphatically not 1 for
   * the low tiers: buzzards flying into the lava on their own is not a bug in
   * the original, it is a third of the entertainment.
   */
  care: number;
}

/**
 * The ladder, and the competence gap along it.
 *
 * The three tiers used to differ by a single vigour multiplier spanning
 * 0.74–1.14, which made them the same opponent at three speeds — all of them
 * tracking accurately, all of them climbing to attack. The spread now runs
 * across five axes, and the bottom of it is genuinely incompetent: a bounder
 * looks at you about once a second, aims at a point up to 90px from where you
 * were when it looked, usually commits to that and won't reconsider, and only
 * pulls up out of the lava two times in three.
 *
 * Shadow lords are the ones that actually hunt — short think, little scatter,
 * rarely commits blindly, and reliably saves itself. Meeting one should feel
 * different in kind, not just faster.
 */
export const TIERS: Tier[] = [
  { name: "bounder", color: "#d1443c", shade: "#8c241f", score: 500,
    vigour: 0.5, think: 0.95, scatter: 90, commit: 0.62, care: 0.66 },
  { name: "hunter", color: "#b9c3d6", shade: "#6f7a90", score: 750,
    vigour: 0.78, think: 0.6, scatter: 46, commit: 0.36, care: 0.85 },
  { name: "shadow lord", color: "#5f7dff", shade: "#33459c", score: 1500,
    vigour: 1.0, think: 0.34, scatter: 16, commit: 0.14, care: 0.97 },
];

/*
 * A note on `vigour`, because it was wrong once and the mistake is tempting.
 *
 * The first pass at "dumber" also raised these — the top tier went to 1.22 —
 * on the theory that a tier needs *something* going up as it climbs. That
 * produced enemies which were both erratic and quick, which is not
 * characterful but simply chaotic: a bench of 120 full games put a mediocre
 * player at a median of one wave and a death every twenty seconds.
 *
 * Threat is supposed to come from `think` and `scatter` — from a shadow lord
 * actually knowing where you are and going there — and not from raw speed. So
 * vigour now falls below where it started for the low tiers and no longer
 * rises above it for the top one. A shadow lord is frightening because it is
 * paying attention.
 */

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
 * Measured, and re-measured after the momentum rework, which is the only
 * reason this number is 52 and not 45. Under the old smooth flight model a
 * mediocre bot cleared a wave in a median 23s; under this one the same policy
 * takes 33.5s, p75 42s, p90 51s. The threshold has to track that, or a change
 * to how the bird flies quietly turns a rare pressure mechanic into a
 * permanent third enemy.
 *
 * At 52 it fires on roughly one wave in ten — a wave played cleanly never
 * sees one, a wave that drags always will. Re-measure it if the flight model
 * moves again.
 */
export const PTERO_AFTER = 52;

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
