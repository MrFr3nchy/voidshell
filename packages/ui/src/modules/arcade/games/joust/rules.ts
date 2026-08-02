/**
 * Joust: the numbers, and the rules that are pure enough to check.
 *
 * Everything here is either a tuning constant or a total function of its
 * arguments, which is the point — the simulation in `index.ts` needs a canvas
 * and a frame loop and can only really be judged by playing it, but *these*
 * can be asserted headlessly, and they are the parts where being wrong is
 * silent.
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
 * is then annihilated rather than merely small. `ACC_AIR` contributes 0.6px/s
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
 * Holding a direction in mid-air used to accelerate you smoothly, which meant
 * the stick flew the bird and the flap only supplied height — two independent
 * controls, and far too much authority. In Joust the wings do both: you go
 * where you flap. `ACC_AIR` is a sixth of what it was, so drifting steers you
 * a little and flapping is what actually moves you. Measured: the stick alone
 * reaches 36px/s in two seconds against 126 with the wings.
 */
export const FLAP_DVX = 34;

export const ACC_AIR = 18;
export const ACC_GROUND = 260;
export const MAX_VX_AIR = 126;
export const MAX_VX_GROUND = 84;

/**
 * Steering against your own momentum.
 *
 * Was 2.2 — a boost, which made a reversal snappy and deleted the single most
 * characteristic thing about flying in this game. Below 1 it is *harder* to
 * turn than to keep going, so committing to a direction is a real decision and
 * changing your mind costs you the width of the screen.
 */
export const TURN_BOOST = 0.82;

/*
 * A note on facing, because it was wrong and a Joust player spotted it.
 *
 * There was a `TURN_FACE_AT` here that held the sprite pointing the way it was
 * *travelling* until the velocity crossed zero. That is not what the original
 * does, and it confuses two separate things. The bird turns to face the stick
 * immediately — it is the *momentum* that refuses to follow, not the sprite.
 *
 * Facing left while still sailing rightwards is the iconic Joust silhouette,
 * and it only happens if the sprite flips at once. Delaying it makes the game
 * feel unresponsive rather than heavy, which is a much worse failure: heavy is
 * the goal, unresponsive is a bug. The resistance lives entirely in
 * TURN_BOOST and TURN_FLAP_BRAKE, where it belongs.
 */

/**
 * How much of a flap's horizontal kick survives when it opposes your motion.
 *
 * A wingbeat into your own momentum is a brake, not a thruster: it bleeds
 * speed rather than reversing it, so a full turn costs several beats instead
 * of one. Together with TURN_BOOST this is what stops the stick from being a
 * steering wheel — measured, a full reversal takes 1.68s and gives up 33px of
 * ground, against 1.02s and 8px before.
 */
export const TURN_FLAP_BRAKE = 0.45;

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

/** Almost nothing. You coast until something stops you. */
export const DRAG_AIR = 0.22;

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
 * assert on, but do not read it as a measurement of the shipped game.
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
  /** Multiplier on wingbeat rate. Sets how hard this tier drives. */
  vigour: number;
  /**
   * How long this tier goes between looking at the player, in seconds. It
   * steers at a *snapshot* taken this often, not at where you actually are.
   */
  think: number;
  /** Random offset added to the snapshot, in pixels. */
  scatter: number;
  /**
   * Odds per decision of committing to a direction and refusing to reconsider
   * until the next one.
   */
  commit: number;
  /**
   * How reliably it saves itself from the lava, 0..1. Emphatically not 1 for
   * the low tiers: buzzards flying into the lava on their own is not a bug in
   * the original, it is a third of the entertainment.
   */
  care: number;
}

export const TIERS: Tier[] = [
  { name: "bounder", color: "#d1443c", shade: "#8c241f", score: 500,
    vigour: 0.74, think: 0.5, scatter: 38, commit: 0.3, care: 0.62 },
  { name: "hunter", color: "#b9c3d6", shade: "#6f7a90", score: 750,
    vigour: 0.95, think: 0.36, scatter: 20, commit: 0.18, care: 0.82 },
  { name: "shadow lord", color: "#5f7dff", shade: "#33459c", score: 1500,
    vigour: 1.18, think: 0.24, scatter: 7, commit: 0.07, care: 0.96 },
];

/*
 * A note on where the stupidity is supposed to live.
 *
 * Two opposite mistakes have been made here. Version one had every tier
 * tracking the player's live position and climbing to attack — three competent
 * duellists at three speeds. Version two scattered their aim by up to 90px and
 * cut their drive, which made them *bad at arriving*: the flock averaged half
 * the player's top speed and sat 76px away.
 *
 * A 1982 buzzard converges on you perfectly well; what it does badly is
 * *choose* — it takes fights from below, it wanders when it loses you, and it
 * flies into the lava. So pursuit is direct at every tier, and the
 * incompetence lives in `care`, in the odds of climbing before engaging, and
 * in a snapshot that is stale rather than wildly wrong.
 */

/**
 * Seconds between wingbeats at vigour 1.0, divided by vigour.
 *
 * Enemies beat on a cadence rather than a per-tick probability: it is what a
 * bird does, and it makes the flock's chase speed a number you set instead of
 * one you measure and then argue with.
 */
export const BEAT_PERIOD = 0.22;

/**
 * Speed above which a buzzard would rather use the screen wrap than turn.
 *
 * The playfield is a cylinder, so a target "behind you" is also ahead of you
 * the long way round — and when you are already moving, the long way is often
 * quicker than paying for a reversal. This is the rule that makes the flock
 * read as Joust: they streak across, overshoot, and reappear on the far side
 * still coming. Seam crossings went from 17 to 41 per minute and the flock's
 * mean speed from 56 to 97px/s.
 */
export const WRAP_RATHER_THAN_TURN = 62;

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
 * Measured, and re-measured after the momentum rework. Under the old smooth
 * flight model a mediocre bot cleared a wave in a median 23s; under this one
 * the same policy takes around 30s. The threshold has to track that, or a
 * change to how the bird flies quietly turns a rare pressure mechanic into a
 * permanent third enemy.
 */
export const PTERO_AFTER = 52;

/* ---------------- the arena ---------------- */

export interface Platform {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The arena for a given wave.
 *
 * Six platforms, not nine. The first version invented a symmetrical nine-piece
 * layout that had no island and no overhang, and a Joust player spotted the
 * count immediately. This is the original's shape: a floor broken by two lava
 * pools, a large island in the middle, a shelf on the left, and a pair on the
 * right where the upper one stands slightly proud of the lower.
 *
 * From wave 7 the floor burns back from both ends of each run, so the pools
 * widen and the ground stops being a place to rest. It never disappears
 * entirely — a floorless wave isn't hard, it's over.
 */
export function arena(wave: number): Platform[] {
  const erode = Math.max(0, wave - 6) * 2;
  const base = (x: number, w: number): Platform => {
    const bite = Math.min(erode, Math.max(0, (w - 24) / 2));
    return { x: x + bite, y: 206, w: w - bite * 2, h: 9 };
  };
  return [
    // The floor, in two runs. The gaps leave one pool in the middle and one
    // straddling the wrap seam — two pools, which is what the troll reaches
    // out of. Laying the runs flush to 0 and 320 instead joins the outer gaps
    // through the seam into a single pool, which the first version did by
    // accident and nobody noticed until the pools were counted.
    base(20, 120),
    base(180, 120),
    // The island. The centrepiece of the original screen and the thing this
    // layout was most obviously missing — it is what makes the middle of the
    // arena somewhere to fight over rather than empty air.
    { x: 116, y: 148, w: 88, h: 8 },
    // Left shelf.
    { x: 0, y: 118, w: 62, h: 7 },
    // The right-hand pair: a lower shelf with a second above and slightly
    // proud of it, so crossing the lower one walks you into the upper.
    { x: 246, y: 132, w: 74, h: 7 },
    { x: 232, y: 92, w: 60, h: 7 },
  ];
}

/**
 * Where riders materialise, in spawn order.
 *
 * The player takes the first, so they always appear before anything else and
 * always in the same place; the flock fills the rest. Indexes into `arena()`
 * rather than into free space, because a rider has to land on something the
 * instant it becomes solid.
 */
export const SPAWN_ON = [2, 3, 4, 5, 0, 1];

/**
 * Seconds after the player materialises before the first enemy does.
 *
 * The player has to be on screen and solid first. Previously everything came
 * in together with the flock leading by a fraction, so a wave opened with the
 * board already busy — the original gives you the beat to see where you are.
 */
export const SPAWN_LEAD = 1.4;
/** Seconds between successive enemies arriving. They trickle in, not swarm. */
export const SPAWN_GAP = 0.75;

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
