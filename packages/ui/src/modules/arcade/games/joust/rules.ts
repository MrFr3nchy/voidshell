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

/*
 * The playfield, and why it grew.
 *
 * It was 320x240, which is close to the original's 292x240 and was chosen for
 * exactly that reason. Faithful, and wrong here: the cabinet integer-scales
 * this onto a panel, and at the sizes the void's surfaces actually open at the
 * picture came out at a scale factor high enough that the bird filled a
 * meaningful fraction of the screen. Joust needs *room* — the whole game is
 * committing to a direction and then living with it, and that reads as
 * clumsiness rather than as weight when the far wall is two seconds away.
 *
 * So the playfield is 1.5x in both axes, at the same sprite size. The bird is
 * unchanged and the world around it is half again as big, which is precisely
 * "zoomed out" and not "made smaller". Everything downstream is rescaled with
 * it — see the note on SCALE.
 */
export const GAME_W = 480;
export const GAME_H = 360;

/** Lava surface. Anything whose feet reach this is gone. */
export const LAVA_Y = 342;

/**
 * How the rescale was done, so the next change to it is arithmetic rather
 * than taste.
 *
 * Lengths went up by 1.5. Velocities did *not* go up by 1.5 — that would have
 * reproduced the old game exactly, at a larger size, and left the arena
 * feeling no roomier than before. They went up by 1.35, so the screen takes
 * about 11% longer to cross than it used to and the extra space is real.
 *
 * Accelerations follow from those two: for a length scale L and a velocity
 * scale V, time scales as L/V and acceleration as V^2/L, which is 1.215 here.
 * Drag coefficients are per-second and scale as V/L, which is 0.9. Durations
 * scale as L/V, 1.11.
 *
 * Anything measured in *sprite* pixels — hit boxes, the lance grid, the egg —
 * is deliberately left alone. Those are properties of the art, not of the
 * arena, and scaling them would have undone the entire point.
 *
 * The horizontal constants have since moved off this scaling on purpose; see
 * the note on MAX_VX_AIR. The scale is how the arena was sized, not a claim
 * that every number still sits on it.
 */
export const LENGTH_SCALE = 1.5;
export const SPEED_SCALE = 1.35;

/**
 * Lives at the start of a game.
 *
 * Three is the arcade default and the arcade default exists to sell coins.
 * There are no coins here, and the first thirty seconds of Joust are where the
 * momentum model is learned, so a player who spends their whole first game
 * discovering that the stick is not a steering wheel never gets to play the
 * game they just learned to play.
 */
export const LIVES_START = 5;

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
export const VQ = 8;

export function quantize(v: number, step: number = VQ): number {
  return Math.round(v / step) * step;
}

export const GRAVITY = 330;
/** Velocity a single flap adds. Per *press* — never a held key. */
export const FLAP_DV = 130;
/** Flapping harder than this doesn't climb faster. Caps mash-to-win. */
export const FLAP_VY_CAP = -178;
export const FLAP_COOLDOWN = 0.15;
export const TERMINAL_VY = 351;

/**
 * Horizontal kick from a flap, in the direction being held.
 *
 * Holding a direction in mid-air used to accelerate you smoothly, which meant
 * the stick flew the bird and the flap only supplied height — two independent
 * controls, and far too much authority. In Joust the wings do both: you go
 * where you flap.
 *
 * Cut again, from 46, as part of making top speed something you *build*. At 46
 * against the old cap, four flaps put you at ninety percent of maximum and
 * there was nothing left to work towards.
 */
export const FLAP_DVX = 34;

export const ACC_AIR = 12;
export const ACC_GROUND = 200;

/**
 * Top speed in the air, and the single number that decides whether this game
 * has momentum in it.
 *
 * Deliberately *off* the 1.35 velocity scale — it is nearly double what the
 * old 126 became. The cap is not a limit you bump into, it is the headroom you
 * accelerate through, and a low one means top speed is simply the speed you
 * travel at. Measured against the old numbers: four flaps and 0.63s to reach
 * ninety percent of maximum, which is not a build-up, it is a switch. It is
 * now seven flaps and 1.23s, and holding it means continuing to flap, which
 * costs altitude control.
 *
 * The ground cap stays far below it. Running is not flying, and the gap is
 * what makes taking off worth doing.
 */
export const MAX_VX_AIR = 250;
export const MAX_VX_GROUND = 120;

/**
 * Steering against your own momentum.
 *
 * Was 2.2 — a boost, which made a reversal snappy and deleted the single most
 * characteristic thing about flying in this game. Below 1 it is *harder* to
 * turn than to keep going, so committing to a direction is a real decision and
 * changing your mind costs you the width of the screen.
 *
 * Tightened from 0.82 along with the brake below, then loosened back off 0.42
 * after measuring: at 0.42 a full reversal took 7 seconds and 781px, which is
 * more than one and a half screens and reads as the controls being broken
 * rather than as the bird being heavy. Heavy is the goal; unresponsive is a
 * bug, and the gap between them is narrow enough to need a number rather than
 * an opinion. At 0.7 it is 4.0s and 388px — real work, still under one screen.
 */
export const TURN_BOOST = 0.7;

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
 * steering wheel.
 */
export const TURN_FLAP_BRAKE = 0.4;

/**
 * Ground friction, and the skid.
 *
 * Landing fast doesn't grip — it slides, and you keep sliding until you are
 * slow enough for the feet to bite. `DRAG_GROUND` is the bite, `SKID_ABOVE` is
 * the speed under which it applies, and `DRAG_SKID` is the much weaker drag
 * above it. Overshooting your landing and sailing off the far end of a ledge
 * is supposed to be a thing that happens to you.
 *
 * The skid drag is less than half what it was and the threshold is higher, so
 * arriving fast means genuinely sliding rather than settling. Touching down
 * was the cheapest way in the game to shed momentum you had spent seconds
 * building, which made the floor a brake pedal.
 */
export const DRAG_GROUND = 3.4;
export const DRAG_SKID = 0.35;
export const SKID_ABOVE = 78;

/**
 * Almost nothing. You coast until something stops you.
 *
 * Was 0.22, which sounds small and is not: measured, a rider let go of at top
 * speed kept 45% of it four seconds later. Half your momentum evaporating
 * while you do nothing is the opposite of the thing this game is about, and it
 * is most of why the flight read as "sensible" rather than as Joust. At 0.035
 * the same rider still has 87%.
 */
export const DRAG_AIR = 0.035;

/**
 * Downward shove after clouting your head on the underside of a ledge, and
 * after running into the ceiling.
 *
 * Both were bare numbers sitting in the integrator, which is how they got
 * missed when everything else was rescaled — a hard-coded 40 in a world that
 * has grown by half is a different rule than it was.
 */
export const BONK_VY = 54;
export const CEIL_VY = 40;

/**
 * How far above the lava counts as flying low enough for the troll.
 *
 * Feet within this band, over open lava rather than over floor, and the arm
 * comes up. Was expressed as a bare y of 176 against a 228 lava line; stated
 * as a distance it survives the playfield changing size.
 */
export const LOW_OVER_LAVA = 78;

/**
 * Seconds a rider is deaf to further collisions after being bumped.
 *
 * Without it a level clash re-triggers on the very next tick, because setting
 * two velocities does not move two overlapping boxes apart. The riders were
 * bouncing three and four times off a single pass, which is the thing that
 * read as "the physics are wrong when you hit an enemy" — the rule was fine,
 * it was just being applied four times.
 */
export const BUMP_CD = 0.22;

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
 *
 * Not rescaled with the playfield, deliberately. This compares the tops of two
 * 16px sprites, and the sprites did not grow.
 */
export const LANCE_GRID = 5;
/** Snapped heights within this many grid steps are a draw. */
export const LANCE_TIE = 1;

/**
 * What a wall does to you.
 *
 * The fraction of your speed that comes back at you when you fly into the side
 * of a ledge. Zeroing it instead — which is what the first pass at side
 * collision did — makes a platform a free brake: you arrive at full speed, you
 * stop dead, and you leave in any direction you like at no cost, which is a
 * better way to shed momentum than anything the flight model offers. Bouncing
 * means hitting the stone throws you back out and you have to rebuild.
 */
export const WALL_BOUNCE = 0.35;

/**
 * The shove you get off an enemy you have just unseated.
 *
 * A won joust is still a collision. The original knocks you back off whoever
 * you took the mount from; passing cleanly through the space where they were
 * is the one moment in the game where two bodies touch and nothing happens.
 * Deliberately much softer than a draw — it should nudge your aim off, not
 * cost you the screen.
 */
export const UNHORSE_KICK = 55;
export const UNHORSE_LIFT = -40;

/** Collisions ricochet hard. Getting shoved across the screen is the point. */
export const BOUNCE_VX = 150;
export const BOUNCE_VY = -78;

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
 * 30Hz with quantised velocity the real apex comes out around a tenth lower.
 * Keep it as the design ratio and the thing to assert on, but do not read it
 * as a measurement of the shipped game.
 *
 * The number moved with the playfield — 16.9px against a 240-tall screen, 25.6
 * against a 360-tall one — and it is the *ratio* that was held fixed at just
 * over 7% of the screen height, not the pixels. Assert on the ratio; a bare
 * pixel bound silently becomes a different design the moment the arena
 * resizes, which is exactly how this check nearly shipped meaningless.
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
   *
   * It is also what decides how hard this tier fights the troll's hand, which
   * is the same trait doing the same job — the strategy literature is rude
   * about hunters specifically for how readily they get caught.
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
 * still coming.
 *
 * Raised with the air cap. It is a fraction of top speed, not an absolute, and
 * leaving it at 84 against a 250 cap would have meant a buzzard taking the
 * seam at a third of maximum — which is to say, almost always, turning never.
 */
export const WRAP_RATHER_THAN_TURN = 120;

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
  /**
   * Part of the bottom floor.
   *
   * The troll only reaches out of a gap in the *floor*, and that used to be
   * decided by comparing `p.y === 206` against a literal. A flag says what was
   * meant, and does not quietly stop being true when the floor moves.
   */
  floor?: boolean;
}

/**
 * The arena for a given wave.
 *
 * Laid out against the original screen rather than invented, and repositioned
 * from the previous pass, which had the right *count* but put the pieces in
 * the wrong places — a floor, a central island and a left shelf, with nothing
 * high on the left and nothing to fight over between the island and the top of
 * the screen. The classic screen reads, bottom to top:
 *
 * - a floor in two runs, leaving one lava pool in the middle and one across
 *   the wrap seam. Two pools, which is what the troll reaches out of, and it
 *   is worth being explicit that laying the runs flush to 0 and GAME_W instead
 *   joins the outer gaps *through* the seam into a single pool;
 * - the left ledge, hugging the left edge;
 * - the middle ledge, centred and standing over the floor. The centrepiece of
 *   the original screen, and the thing every strategy for the game is written
 *   around;
 * - the right-hand pair, a lower shelf running out to the seam with a second
 *   above and set inboard of it, so there is a slot between them you can fly
 *   through and a lip you skip along coming in from the right. That slot is an
 *   accident in the original that was left in because players liked it;
 * - a top-left ledge, which the previous layout simply did not have. Without
 *   something high on the left, the whole upper half of the screen is a place
 *   you pass through rather than a place you can hold.
 *
 * Waves 1 and 2 close the pools over. The original bridges the lava for the
 * first two screens so that a new player learns to fly before learning to die,
 * and it costs nothing to reproduce: the floor runs simply widen to meet.
 *
 * From wave 7 the floor burns back from both ends of each run, so the pools
 * widen and the ground stops being a place to rest. It never disappears
 * entirely — a floorless wave isn't hard, it's over.
 */
export function arena(wave: number): Platform[] {
  const bridged = wave <= 2;
  const erode = Math.max(0, wave - 6) * 3;
  const base = (x: number, w: number): Platform => {
    const bite = Math.min(erode, Math.max(0, (w - 36) / 2));
    return { x: x + bite, y: 306, w: w - bite * 2, h: 12, floor: true };
  };
  return [
    bridged ? base(0, 240) : base(28, 176),
    bridged ? base(240, 240) : base(276, 176),
    // The middle ledge, dead centre. Also the player's pad — see SPAWN_ON.
    { x: 180, y: 238, w: 120, h: 10 },
    // Left ledge, flush to the edge so it continues through the seam. It sat
    // at 262, which put it three quarters of the way down the screen — barely
    // above the floor, with the whole left half of the arena empty above it.
    // Raised to sit roughly level with the lower right shelf, so the mid band
    // spans both sides and the space underneath is somewhere you fly.
    { x: 0, y: 216, w: 110, h: 10 },
    // The right-hand pair, and the slot between them.
    { x: 360, y: 210, w: 120, h: 10 },
    { x: 336, y: 160, w: 96, h: 10 },
    // Top left.
    { x: 52, y: 140, w: 112, h: 10 },
  ];
}

/**
 * Where riders materialise, in spawn order.
 *
 * The player takes the first entry, so they always appear before anything else
 * and always in the same place; the flock fills the rest in turn. Indexes into
 * `arena()` rather than into free space, because a rider has to land on
 * something the instant it becomes solid.
 *
 * The player's pad is the middle ledge rather than a floor run, and that is a
 * decision rather than an accident: the floor *erodes* from wave 7, so a pad
 * on it is in a different place on wave 10 than it was on wave 1, and "the
 * designated spawn point" then means nothing. The middle ledge never moves.
 *
 * The order after that alternates side and height, so the flock does not
 * arrive as a column down one edge of the screen.
 */
export const SPAWN_ON = [2, 4, 3, 6, 0, 5, 1];

/**
 * Seconds after the player materialises before the first enemy does.
 *
 * The player has to be on screen and solid first. Previously everything came
 * in together with the flock leading by a fraction, so a wave opened with the
 * board already busy — the original gives you the beat to see where you are.
 */
export const SPAWN_LEAD = 1.6;
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
