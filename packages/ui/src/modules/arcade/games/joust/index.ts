/**
 * Joust — a knight on a flying bird, and the one rule that makes it a game.
 *
 * When two riders touch, the higher lance wins. That is the entire combat
 * system, and every skill the game asks for is downstream of it: you climb to
 * take a fight, you dive to escape one, and you learn that flapping is
 * momentum rather than movement. Nothing here is a special case for the player.
 *
 * The parts that are easy to get subtly wrong, and how they're handled:
 *
 * - **Flap is per press.** A held key would make it a jetpack and delete the
 *   game. `Pad.hit` exists for exactly this.
 * - **The wings do the steering.** Holding a direction in the air is a nudge;
 *   the flap is what actually moves you sideways.
 * - **Momentum is the difficulty, but the sprite is not.** Air drag is almost
 *   nothing and turning against your own velocity is harder than holding a
 *   line, so a full reversal costs 1.68s and a third of a screen — yet the
 *   bird turns to face the stick *at once*. Facing left while still sailing
 *   right is the silhouette this game is made of.
 * - **The screen is a cylinder, and the flock uses it.** A fast buzzard whose
 *   target has ended up behind it takes the seam rather than braking.
 * - **Eggs are the economy.** Killing something doesn't remove it, it drops an
 *   egg; ignore the egg and it hatches into an enemy *one tier stronger*.
 * - **The stone is solid on all four sides.** It was not: the resolver tested
 *   the two vertical crossings and left the sides open, so a rider arriving at
 *   ledge height went straight through. See `resolve`.
 *
 * The art is original — see `sprites.ts`, which is explicit about what is and
 * isn't reproduced. `rules.ts` holds the numbers and the reasoning for each.
 */

import type { Game, GameDef, GameHost, Pad } from "../../types";
import { burst, tone } from "../../../../kernel/audio";
import { palette, withAlpha } from "../../../../kernel/stage";
import {
  blit,
  pterodactyl,
  riderInk,
  text,
  textCentered,
  wings,
  EGG,
  HAND,
  PAD,
  RIDER,
  WALKER,
} from "./sprites";
import type { Platform } from "./rules";
import {
  ACC_AIR,
  ACC_GROUND,
  arena,
  BEAT_PERIOD,
  BONK_VY,
  BOUNCE_VX,
  BOUNCE_VY,
  BUMP_CD,
  CEIL_VY,
  DRAG_AIR,
  DRAG_GROUND,
  DRAG_SKID,
  eggChain,
  EGG_H,
  EGG_HATCH,
  EGG_W,
  EGG_WAIT,
  EGG_WAVE_BONUS,
  EXTRA_LIFE_EVERY,
  FLAP_COOLDOWN,
  FLAP_DV,
  FLAP_DVX,
  FLAP_VY_CAP,
  GAME_H,
  GAME_W,
  GRAVITY,
  HIT_DX,
  HIT_H,
  HIT_W,
  LAVA_Y,
  LIVES_START,
  LOW_OVER_LAVA,
  MAX_TICKS,
  MAX_VX_AIR,
  MAX_VX_GROUND,
  PTERO_AFTER,
  PTERO_SCORE,
  quantize,
  resolveJoust,
  SKID_ABOVE,
  SPAWN_GAP,
  SPAWN_LEAD,
  SPAWN_ON,
  SPR_H,
  SPR_W,
  spawnTier,
  SURVIVAL_BONUS,
  TERMINAL_VY,
  TICK,
  TIERS,
  TURN_BOOST,
  TURN_FLAP_BRAKE,
  waveEnemies,
  waveKind,
  WRAP_RATHER_THAN_TURN,
  wrapDelta,
  wrapX,
} from "./rules";

/** Legs stop one row above the sprite box; feet collide, the bounding box doesn't. */
const FOOT = SPR_H - 1;

/**
 * The lava troll: how long a grab lasts, and what it costs to break.
 *
 * `TROLL_DRAG` is px/s dragged toward the lava while held, and it is the real
 * clock — the hold rarely runs out because the lava arrives first. It has to
 * be slow enough that five flaps is a fight you can win from a normal grab
 * height and fast enough that being caught just above the surface is fatal.
 */
const TROLL_HOLD = 2.4;
const TROLL_FLAPS = 5;
const TROLL_DRAG = 24;

/**
 * How hard a *buzzard* fights the hand.
 *
 * The arm used to reach for the player and nobody else, which made it scenery
 * with one victim rather than a hazard in the arena — and it is flatly not how
 * the original behaves. Leading a rider low over the lava until the troll
 * takes them is a known way to clear the last enemy on a wave, and the
 * strategy literature is rude about Hunters specifically for how readily they
 * get caught.
 *
 * An enemy cannot press a button, so its struggle is a rate. The roll is made
 * once, at the moment of the grab, off the tier's `care`: either it is going
 * to get out and thrashes fast enough to manage it, or it is not and thrashes
 * anyway. Rolling per tick instead would make every grab a coin-flip that the
 * player watches for two seconds, and would make no tier better at it than
 * another.
 */
const TROLL_ESCAPE_OF_CARE = 0.75;
/** Flaps per second when it is going to get out, scaled by the tier's vigour. */
const TROLL_STRUGGLE_FAST = TROLL_FLAPS / (TROLL_HOLD * 0.55);
/** And when it is not. Deliberately short of what the hold requires. */
const TROLL_STRUGGLE_SLOW = TROLL_FLAPS / (TROLL_HOLD * 2.4);

/** A yellow knight on a cream ostrich, with a red plume. */
const PLAYER_INK = riderInk("#f0e0a8", "#b8a25c", "#f2d24b", "#a8842a", "#d1443c", "#ff9b2f");

interface Rider {
  player: boolean;
  tier: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: 1 | -1;
  flapCd: number;
  wing: number;
  grounded: boolean;
  /** Seconds until this rider next looks at the world. */
  think: number;
  /** Where it last believed the player to be. Stale, and deliberately wrong. */
  seenX: number;
  seenY: number;
  /** The heading chosen at the last decision. */
  dir: -1 | 0 | 1;
  /** Committed to `dir` until the next decision, overshoot and all. */
  commit: boolean;
  /** Rolled at each decision: whether it will pull out of the lava this time. */
  careful: boolean;
  /** Seconds until the next wingbeat. Buzzards beat rhythmically, not randomly. */
  beat: number;
  /** Seconds left materialising. Not solid, not dangerous, cannot be hit. */
  spawn: number;
  /** Seconds of deafness to further collisions after a bump. See `BUMP_CD`. */
  bump: number;
}

type EggState = "fall" | "rest" | "wait" | "carried";

interface Egg {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tier: number;
  state: EggState;
  t: number;
  walk: 1 | -1;
  buzz: { x: number; y: number } | null;
}

interface Ptero {
  x: number;
  y: number;
  vx: number;
  vy: number;
  wing: number;
}

interface Troll {
  x: number;
  y: number;
  t: number;
  grabbed: boolean;
  /**
   * Progress out of the grip, in flaps. Integral for the player, who supplies
   * them one press at a time; fractional for a buzzard, which accrues them at
   * `rate` and may well not get there.
   */
  flaps: number;
  rate: number;
  /** Whoever is in the hand. The player has no special claim on it. */
  target: Rider | null;
}

interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
}

type Phase = "attract" | "intro" | "play" | "dying" | "clear" | "over";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class Joust implements Game {
  private readonly host: GameHost;

  private phase: Phase = "attract";
  private timer = 0;
  private wave = 1;
  private score = 0;
  private lives = LIVES_START;
  private nextLife = EXTRA_LIFE_EVERY;
  private chain = 0;
  private waveClean = true;
  private waveEggs = 0;
  private waveTime = 0;
  private banner = "";
  private subBanner = "";

  private plats: Platform[] = arena(1);
  private player: Rider = this.makeRider(true, 0, 160, 120);
  private enemies: Rider[] = [];
  private eggs: Egg[] = [];
  private ptero: Ptero | null = null;
  private troll: Troll | null = null;
  /** Grace after a troll lets go, so escaping isn't immediately undone. */
  private trollCd = 0;
  /** Distance walked since the last footfall, in px. Paces the step sound. */
  private stride = 0;
  private bits: Bit[] = [];

  /** Leftover real time not yet consumed by a fixed tick. */
  private acc = 0;
  /**
   * Presses seen since the last tick.
   *
   * At 30Hz against a 60Hz display roughly half of all frames run no tick at
   * all, and the cabinet clears its edge set after every frame — so reading a
   * press straight into a tick would silently drop half of them, and the game
   * would feel like it was ignoring the button.
   */
  private flapLatch = false;
  private startLatch = false;

  private lastFacts = "";
  private t = 0;

  constructor(host: GameHost) {
    this.host = host;
    this.enterAttract();
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  private makeRider(player: boolean, tier: number, x: number, y: number): Rider {
    return {
      player,
      tier,
      x,
      y,
      vx: 0,
      vy: 0,
      face: 1,
      flapCd: 0,
      wing: 0,
      grounded: false,
      think: 0,
      seenX: x,
      seenY: y,
      dir: 1,
      commit: false,
      careful: true,
      beat: 0,
      spawn: player ? 0 : 0.9,
      bump: 0,
    };
  }

  private enterAttract(): void {
    this.phase = "attract";
    this.timer = 0;
    this.plats = arena(1);
    this.enemies = [];
    this.eggs = [];
    this.ptero = null;
    this.troll = null;
    this.bits = [];
    // A few birds drifting through the title, because an arcade cabinet that
    // sits on a still frame looks broken rather than idle.
    for (let i = 0; i < 3; i++) {
      // Kept in the open sky above the top ledge. Attract birds have no
      // collision — they are scenery — so anywhere else and they visibly sail
      // through stone on the title screen, which rather undercuts the thing
      // the platforms are for. `seenY` is free in attract mode and holds the
      // line each one bobs about.
      const r = this.makeRider(false, i % 3, 60 + i * 135, 56 + i * 30);
      r.spawn = 0;
      r.seenY = r.y;
      r.vx = i % 2 === 0 ? 54 : -54;
      this.enemies.push(r);
    }
  }

  private startGame(): void {
    this.score = 0;
    this.lives = LIVES_START;
    this.wave = 1;
    this.nextLife = EXTRA_LIFE_EVERY;
    this.enemies = [];
    this.eggs = [];
    this.bits = [];
    this.startWave();
  }

  private startWave(): void {
    this.plats = arena(this.wave);
    this.enemies = [];
    this.eggs = [];
    this.ptero = null;
    this.troll = null;
    this.chain = 0;
    this.waveClean = true;
    this.waveTime = 0;
    this.phase = "intro";
    this.timer = 2;

    const kind = waveKind(this.wave);
    this.banner = `WAVE ${this.wave}`;
    this.subBanner =
      kind === "egg" ? "EGG WAVE" : kind === "survival" ? "SURVIVAL WAVE" : "";

    // The player is placed first, and the flock is held back behind it. A wave
    // used to open with everything arriving together and the enemies slightly
    // in the lead, which gave you no beat to see where you were.
    this.placePlayer();

    const n = waveEnemies(this.wave);
    for (let i = 0; i < n; i++) {
      // Skip pad 0: that one is the player's, and the flock must never
      // materialise on top of someone who has only just become solid.
      const p = this.plats[SPAWN_ON[1 + (i % (SPAWN_ON.length - 1))]];
      // Centred on the pad, and standing on it. Both were wrong: the rider was
      // offset 14px to alternate sides of the marker, so it visibly arrived
      // *beside* the thing drawn to say where it would arrive, and it was
      // placed at `p.y - SPR_H` when the ground resolution puts a standing
      // rider at `p.y - FOOT`, so its first tick was a one-pixel drop. Six
      // pads and at most eight enemies means two pads get used twice, four and
      // a half seconds apart, which is long enough that nobody is still there.
      const r = this.makeRider(
        false,
        spawnTier(this.wave, i),
        wrapX(p.x + p.w / 2 - SPR_W / 2),
        p.y - FOOT
      );
      r.spawn = SPAWN_LEAD + i * SPAWN_GAP;
      this.enemies.push(r);
    }

    if (kind === "egg") {
      // Nothing to fight — a shower of eggs, and a bonus for taking all of them.
      for (let i = 0; i < 10; i++) {
        this.eggs.push({
          x: wrapX(27 + i * 45),
          y: -27 - i * 22,
          vx: (i % 2 ? 1 : -1) * 16,
          vy: 10,
          tier: 0,
          state: "fall",
          t: 0,
          walk: 1,
          buzz: null,
        });
      }
    }
    this.waveEggs = this.eggs.length;

    this.sfx(() => {
      tone({ freq: 220, toFreq: 440, decay: 0.14, wave: "square", gain: 0.07 });
      window.setTimeout(() => tone({ freq: 330, toFreq: 660, decay: 0.16, wave: "square", gain: 0.07 }), 130);
    });
  }

  /**
   * Put the player on their pad, solid, with no grace period.
   *
   * The 1.8s of invulnerability that used to be granted here is gone. It read
   * as the game not having started yet — a flashing bird that enemies decline
   * to look at is not a player, and every wave opened with two seconds of
   * nothing.
   *
   * Taking it away needs the pad to be *clear*, though, or a mid-wave respawn
   * is a life lost to something the player could not have acted on. So the pad
   * is emptied instead: whatever is loitering on it is thrown off with real
   * velocity, which costs the flock a moment and costs the player nothing, and
   * unlike immunity it is a thing the player can see happen.
   */
  private placePlayer(): void {
    const pad = this.plats[SPAWN_ON[0]];
    const x = wrapX(pad.x + pad.w / 2 - SPR_W / 2);
    const y = pad.y - FOOT;
    this.clearPad(x, y);
    this.player = this.makeRider(true, 0, x, y);
    this.player.grounded = true;
  }

  /** Shove anything sitting where the player is about to be. */
  private clearPad(x: number, y: number): void {
    for (const e of this.enemies) {
      const dx = wrapDelta(x, e.x);
      if (Math.abs(dx) > 56 || Math.abs(e.y - y) > 44) continue;
      const away = (Math.sign(dx) || 1) as 1 | -1;
      e.x = wrapX(x + away * 82);
      e.y = Math.min(e.y, y - 6);
      e.vx = away * MAX_VX_AIR * 0.7;
      e.vy = -50;
      e.face = away;
      e.dir = away;
      e.commit = true;
      e.grounded = false;
      this.burstBits(e.x + SPR_W / 2, e.y + SPR_H / 2, "#8a7550", 6);
    }
  }

  /* ------------------------------------------------------------------ */
  /* update                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Take in real time, hand out fixed ticks.
   *
   * The simulation never sees a variable delta. Everything downstream of here
   * advances by exactly TICK or not at all, which is what makes the motion
   * chunky rather than smooth and the whole game reproducible from an input
   * sequence.
   */
  update(dt: number, pad: Pad): void {
    if (pad.hit("flap")) this.flapLatch = true;
    if (pad.hit("start")) this.startLatch = true;

    this.acc += dt;
    let ticks = 0;
    while (this.acc >= TICK && ticks < MAX_TICKS) {
      this.acc -= TICK;
      ticks++;
      this.tick(pad);
    }
    // A long stall (a dragged panel, a background tab) leaves a backlog that
    // is not worth catching up on — simulating it would teleport everything.
    if (ticks >= MAX_TICKS) this.acc = 0;

    this.publishFacts();
  }

  /** One fixed step. `dt` below is always TICK; the alias keeps it readable. */
  private tick(pad: Pad): void {
    const dt = TICK;
    this.t += dt;

    const flap = this.flapLatch;
    const start = this.startLatch;
    this.flapLatch = false;
    this.startLatch = false;
    const want = (pad.down("right") ? 1 : 0) - (pad.down("left") ? 1 : 0);

    this.bits = this.bits.filter((b) => {
      b.life -= dt;
      b.vy += GRAVITY * 0.5 * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      return b.life > 0;
    });

    switch (this.phase) {
      case "attract":
        this.timer += dt;
        for (const e of this.enemies) this.drift(e, dt);
        if (start || flap) this.startGame();
        break;

      case "intro":
        this.timer -= dt;
        // Deliberately *not* stepping the flock. Their `spawn` clocks start at
        // SPAWN_LEAD, and running them through the two-second banner spent the
        // whole lead before the player could move — the first buzzard was
        // already solid on the first playable tick, and the second a fraction
        // behind it. The eggs still fall, because an egg wave wants the
        // shower already coming down as the banner clears.
        this.stepEggs(dt);
        if (this.timer <= 0) this.phase = "play";
        break;

      case "play":
        this.waveTime += dt;
        this.stepPlayer(dt, want, flap);
        this.stepEnemies(dt);
        this.stepEggs(dt);
        this.stepPtero(dt);
        this.stepTroll(dt, flap);
        this.collide();
        this.checkWaveEnd();
        break;

      case "dying":
        this.timer -= dt;
        this.stepEnemies(dt);
        this.stepEggs(dt);
        if (this.timer <= 0) {
          if (this.lives <= 0) {
            this.phase = "over";
            this.timer = 3.4;
            if (this.host.submit(this.score)) this.banner = "NEW RECORD";
            else this.banner = "GAME OVER";
          } else {
            this.placePlayer();
            this.phase = "play";
          }
        }
        break;

      case "clear":
        this.timer -= dt;
        if (this.timer <= 0) {
          this.wave++;
          this.startWave();
        }
        break;

      case "over":
        this.timer -= dt;
        if (this.timer <= 0) this.enterAttract();
        break;
    }
  }

  /** Attract-mode birds: no brain, just enough motion to look alive. */
  private drift(r: Rider, dt: number): void {
    r.x = wrapX(r.x + r.vx * dt);
    r.face = r.vx > 0 ? 1 : -1;
    // Set from the sine rather than accumulated into y. The old form added a
    // sine to the position every tick, which is a random walk and not a bob:
    // a cabinet left on the title screen watched its birds wander off the
    // bottom of the world over a couple of minutes.
    r.y = r.seenY + Math.sin(this.timer * 1.6 + r.x * 0.03) * 7;
    r.wing = (Math.sin(this.timer * 6 + r.x * 0.1) + 1) / 2;
  }

  private stepPlayer(dt: number, want: number, flap: boolean): void {
    const p = this.player;
    p.bump = Math.max(0, p.bump - dt);

    // In the hand: `stepTroll` owns the body, and the flap press with it. It
    // used to be handled here and only here, which is precisely why the arm
    // could never take anything but the player.
    if (this.troll?.grabbed && this.troll.target === p) return;

    const grounded = p.grounded;
    this.move(p, dt, want, flap);

    // A wingbeat in two parts: the airy snap of the feathers and the low
    // thump of the downstroke landing. One band alone reads as a click.
    if (flap && !grounded) {
      this.sfx(() => {
        burst({ freq: 520, q: 0.9, gain: 0.05, decay: 0.075 });
        burst({ freq: 130, q: 2.2, gain: 0.075, decay: 0.11 });
      });
    }

    // Footfalls, paced by distance rather than by a timer, so the clop
    // matches the stride instead of drifting against it.
    if (p.grounded && Math.abs(p.vx) > 16) {
      this.stride += Math.abs(p.vx) * dt;
      if (this.stride > 19) {
        this.stride = 0;
        this.sfx(() => burst({ freq: 190, q: 3.2, gain: 0.06, decay: 0.045 }));
      }
    } else {
      this.stride = 0;
    }

    // Touching down banks the egg chain. That's what makes a chain a decision:
    // staying airborne is worth four times as much and four times as risky.
    if (p.grounded) this.chain = 0;

    if (p.y + FOOT >= LAVA_Y) {
      this.sfx(() => burst({ freq: 120, q: 0.8, gain: 0.16, decay: 0.4 }));
      this.killPlayer();
    }
  }

  /**
   * The flock, and how little it knows.
   *
   * A buzzard does not track you. It *looks* at you every `t.think` seconds,
   * writes down a point up to `t.scatter` pixels from where you were at that
   * instant, and then flies at that stale point until it looks again.
   *
   * Pursuit itself is direct, at every tier. An earlier pass scattered their
   * aim by up to 90px and cut their drive, which made them bad at *arriving*.
   * A buzzard converges on you perfectly well; what it does badly is choose.
   */
  private stepEnemies(dt: number): void {
    for (const e of this.enemies) {
      e.bump = Math.max(0, e.bump - dt);
      if (e.spawn > 0) {
        e.spawn -= dt;
        continue;
      }
      // Being held is not flying. `stepTroll` moves this one.
      if (this.troll?.grabbed && this.troll.target === e) continue;
      const t = TIERS[e.tier];

      e.think -= dt;
      if (e.think <= 0) {
        e.think = t.think * (0.6 + Math.random() * 0.8);
        const chasing = this.phase === "play";

        if (chasing) {
          e.seenX = wrapX(this.player.x + (Math.random() - 0.5) * 2 * t.scatter);
          // Where the incompetence lives. Only the top tier reliably remembers
          // to get *above* you first; a bounder mostly comes straight at your
          // altitude and loses the comparison it never thought to win.
          const climbs = Math.random() < 0.18 + e.tier * 0.36;
          e.seenY = this.player.y - (climbs ? 21 + e.tier * 12 : 0);
        } else {
          e.seenX = wrapX(Math.random() * GAME_W);
          e.seenY = 165 + Math.random() * 75;
        }

        const d = wrapDelta(e.x, e.seenX);
        e.dir = (Math.abs(d) < 12 ? 0 : Math.sign(d)) as -1 | 0 | 1;
        e.commit = Math.random() < t.commit;
        // Rolled per decision, not per tick: a bounder that rolls careless
        // stays careless for the best part of a second, which over open lava
        // is more than long enough to be fatal.
        e.careful = Math.random() < t.care;
      }

      const dx = wrapDelta(e.x, e.seenX);
      let want = e.commit ? e.dir : ((Math.abs(dx) < 12 ? 0 : Math.sign(dx)) as -1 | 0 | 1);

      // Take the seam rather than the brake. A buzzard already travelling fast
      // whose target has ended up behind it keeps going and comes around the
      // wrap — what the original does, and the fix for a thrashing bug where
      // an enemy would close to 15px, re-snapshot behind itself, reverse into
      // its own momentum, and sail away forever.
      if (want !== 0 && want * e.vx < 0 && Math.abs(e.vx) > WRAP_RATHER_THAN_TURN) {
        want = Math.sign(e.vx) as -1 | 0 | 1;
      }

      const doomed = e.y > LAVA_Y - LOW_OVER_LAVA && !e.grounded;
      const wantsHeight = (doomed && e.careful) || e.y > e.seenY + 12;
      // Horizontal thrust is nearly all flap, so a buzzard that only flaps for
      // *height* barely moves sideways. That was a real bug: the flock
      // averaged half the player's speed and could not close.
      const wantsDrive = want !== 0 && want * e.vx < MAX_VX_AIR * 0.74;

      e.beat -= dt;
      const flap = e.beat <= 0 && (wantsHeight || wantsDrive);
      if (flap) e.beat = BEAT_PERIOD / t.vigour;
      else if (e.beat <= 0) e.beat = 0.2;   // idle glide, wings mostly still

      this.move(e, dt, want, flap);

      if (e.y + FOOT >= LAVA_Y) {
        this.burstBits(e.x + SPR_W / 2, LAVA_Y - 4, "#ff7a2f", 10);
        e.spawn = 1.2;
        e.y = 60;
        e.x = wrapX(e.x + 90);
        e.vy = 0;
      }
    }
  }

  /**
   * Shared integration. The player and every enemy fly by exactly this.
   *
   * The wings do the steering. Holding a direction in the air applies only
   * `ACC_AIR`, barely a nudge; the real horizontal authority is `FLAP_DVX`,
   * delivered per flap in whichever direction is held. You cannot simply
   * *decide* to be somewhere else, you have to beat your way there.
   */
  private move(r: Rider, dt: number, want: number, flap: boolean): void {
    if (want !== 0) {
      const acc = r.grounded ? ACC_GROUND : ACC_AIR;
      // Turning against your own momentum is *harder* than holding a line.
      const against = want * r.vx < 0;
      r.vx += want * acc * (against ? TURN_BOOST : 1) * dt;
      // The sprite turns at once; the momentum does not. Facing left while
      // still sailing rightwards is the iconic Joust silhouette, and it only
      // happens if the flip is immediate. Delaying it reads as unresponsive
      // rather than heavy — the resistance belongs in the physics above, not
      // in the picture.
      r.face = want > 0 ? 1 : -1;
    } else if (r.grounded) {
      // Land fast and you slide; the feet only bite once you're slow.
      const grip = Math.abs(r.vx) > SKID_ABOVE ? DRAG_SKID : DRAG_GROUND;
      r.vx -= r.vx * grip * dt;
      if (Math.abs(r.vx) < 7) r.vx = 0;
    } else {
      r.vx -= r.vx * DRAG_AIR * dt;
    }

    r.flapCd = Math.max(0, r.flapCd - dt);
    if (flap && r.flapCd <= 0) {
      r.vy = Math.max(FLAP_VY_CAP, r.vy - FLAP_DV);
      // The same beat that lifts you also throws you along — but a flap into
      // your own momentum is a brake, not a thruster.
      if (want !== 0) {
        const against = want * r.vx < 0;
        r.vx += want * FLAP_DVX * (against ? TURN_FLAP_BRAKE : 1);
      }
      r.flapCd = FLAP_COOLDOWN;
      r.wing = 1;
      r.grounded = false;
    }
    r.wing = Math.max(0, r.wing - dt * 3.4);

    const cap = r.grounded ? MAX_VX_GROUND : MAX_VX_AIR;
    r.vx = clamp(r.vx, -cap, cap);
    r.vy = Math.min(TERMINAL_VY, r.vy + GRAVITY * dt);

    // Quantised here, at the integration, and not in the stored velocity —
    // see VQ. Speed arrives in visible steps while the fractional part keeps
    // accumulating underneath, exactly as fixed point would.
    const py = r.y;
    r.x = wrapX(r.x + quantize(r.vx) * dt);
    r.y += quantize(r.vy) * dt;

    // The playfield has a ceiling. Without one, a player mashing flap simply
    // leaves the top of the screen and keeps going: invisible, unreachable,
    // and unbeatable, because nothing can get a lance above them.
    if (r.y < 0) {
      r.y = 0;
      if (r.vy < 0) r.vy = CEIL_VY;
    }

    r.grounded = false;
    for (const p of this.plats) this.resolve(r, p, py);
  }

  /**
   * One rider against one platform, and the bug that lived here.
   *
   * The old resolution tested exactly two things: feet crossing the top
   * surface downwards, and head crossing the underside upwards. Both are
   * correct and both are swept, so neither could tunnel — and between them
   * they left the *sides* of the stone completely open. A rider arriving at a
   * ledge at ledge height, which is to say at the height you arrive at one
   * when you are flying rather than landing, satisfied neither test, and so
   * passed through the platform as if it were not there. That is the "hit them
   * just right and you go straight through" report, and it is not a tunnelling
   * problem at all: the case was simply never written.
   *
   * So: the two swept crossings first, because a sweep cannot be stepped over
   * at any speed and getting them wrong puts a bird inside the floor. Then, if
   * the boxes still overlap after that, the rider came in from the side and
   * gets pushed back out of it with its momentum killed.
   *
   * `py` is the y at the start of the step. It stays the start-of-step value
   * across the whole platform loop even as `r.y` is corrected, which is what
   * makes resolving several platforms in one tick behave.
   */
  private resolve(r: Rider, p: Platform, py: number): void {
    if (!this.overX(r.x + HIT_DX, HIT_W, p)) return;

    // Landing. Swept: the feet were at or above the top surface and are now at
    // or below it, whatever distance was covered in between.
    if (r.vy >= 0 && py + FOOT <= p.y + 1 && r.y + FOOT >= p.y) {
      r.y = p.y - FOOT;
      r.vy = 0;
      r.grounded = true;
      return;
    }

    // Head against the underside, swept the same way.
    if (r.vy <= 0 && py >= p.y + p.h - 1 && r.y <= p.y + p.h) {
      r.y = p.y + p.h;
      r.vy = BONK_VY;
      return;
    }

    // Still inside it: came through the side. Push out the nearer way — via
    // `wrapDelta`, because a platform flush to the seam has a near side that
    // is off the other edge of the screen.
    if (r.y + FOOT <= p.y || r.y >= p.y + p.h) return;
    const d = wrapDelta(p.x + p.w / 2, r.x + HIT_DX + HIT_W / 2);
    if (d >= 0) {
      r.x = wrapX(p.x + p.w - HIT_DX);
      if (r.vx < 0) r.vx = 0;
    } else {
      r.x = wrapX(p.x - HIT_DX - HIT_W);
      if (r.vx > 0) r.vx = 0;
    }
  }

  /** Horizontal overlap against a platform, honouring the wrap. */
  private overX(x: number, w: number, p: Platform): boolean {
    for (const off of [-GAME_W, 0, GAME_W]) {
      if (x + off + w > p.x && x + off < p.x + p.w) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* eggs                                                                */
  /* ------------------------------------------------------------------ */

  private stepEggs(dt: number): void {
    const keep: Egg[] = [];
    for (const e of this.eggs) {
      let alive = true;
      e.t += dt;

      if (e.state === "fall") {
        e.vy = Math.min(TERMINAL_VY, e.vy + GRAVITY * dt);
        const py = e.y;
        e.x = wrapX(e.x + e.vx * dt);
        e.y += e.vy * dt;
        for (const p of this.plats) {
          if (!this.overX(e.x, EGG_W, p)) continue;
          if (e.vy > 0 && py + EGG_H <= p.y + 1 && e.y + EGG_H >= p.y) {
            e.y = p.y - EGG_H;
            if (e.vy > 95) {
              e.vy *= -0.42;
              e.vx *= 0.6;
              this.sfx(() => burst({ freq: 900, q: 4, gain: 0.05, decay: 0.04 }));
            } else {
              e.vy = 0;
              e.vx = 0;
              e.state = "rest";
              e.t = 0;
            }
          }
        }
        if (e.y + EGG_H >= LAVA_Y) {
          this.burstBits(e.x, LAVA_Y - 4, "#ff9b2f", 8);
          alive = false;
        }
      } else if (e.state === "rest") {
        if (e.t >= EGG_HATCH) {
          e.state = "wait";
          e.t = 0;
          e.walk = Math.random() < 0.5 ? 1 : -1;
          this.burstBits(e.x + EGG_W / 2, e.y, "#e8e2c8", 7);
          this.sfx(() => burst({ freq: 1400, q: 6, gain: 0.07, decay: 0.07 }));
        }
      } else if (e.state === "wait") {
        // A hatched rider pacing the ledge, waiting for a lift.
        const nx = wrapX(e.x + e.walk * 20 * dt);
        const onLedge = this.plats.some(
          (p) => this.overX(nx, EGG_W, p) && Math.abs(p.y - (e.y + EGG_H)) < 3
        );
        if (onLedge) e.x = nx;
        else e.walk = e.walk === 1 ? -1 : 1;
        if (e.t >= EGG_WAIT) {
          e.state = "carried";
          e.buzz = { x: wrapX(e.x + (Math.random() < 0.5 ? -120 : 120)), y: -24 };
        }
      } else if (e.state === "carried" && e.buzz) {
        const b = e.buzz;
        const dx = wrapDelta(b.x, e.x);
        const dy = e.y - 4 - b.y;
        const d = Math.hypot(dx, dy) || 1;
        b.x = wrapX(b.x + (dx / d) * 175 * dt);
        b.y += (dy / d) * 175 * dt;
        if (d < 8) {
          // Collected by the flock and put back in the fight, one tier up.
          const r = this.makeRider(false, Math.min(2, e.tier + 1), e.x - 6, e.y - 8);
          r.spawn = 0.35;
          r.vy = -81;
          this.enemies.push(r);
          this.sfx(() => tone({ freq: 520, toFreq: 180, decay: 0.2, wave: "sawtooth", gain: 0.07 }));
          alive = false;
        }
      }

      // Collection. Everything up to the moment the buzzard arrives is fair game.
      if (alive && this.phase === "play" && e.state !== "carried") {
        if (
          Math.abs(wrapDelta(e.x, this.player.x + HIT_DX)) < HIT_W &&
          Math.abs(e.y - this.player.y - 4) < HIT_H
        ) {
          const value = eggChain(this.chain);
          this.chain++;
          this.add(value);
          this.floatText(e.x, e.y, value);
          this.burstBits(e.x + EGG_W / 2, e.y + EGG_H / 2, "#ffe89a", 9);
          this.sfx(() =>
            tone({ freq: 660 + this.chain * 110, toFreq: 1320, decay: 0.1, wave: "square", gain: 0.08 })
          );
          alive = false;
        }
      }

      if (alive) keep.push(e);
    }
    this.eggs = keep;
  }

  /* ------------------------------------------------------------------ */
  /* the pterodactyl and the troll                                       */
  /* ------------------------------------------------------------------ */

  private stepPtero(dt: number): void {
    if (!this.ptero) {
      if (this.waveTime > PTERO_AFTER) {
        this.ptero = { x: this.player.x > GAME_W / 2 ? -24 : GAME_W + 24, y: 60, vx: 0, vy: 0, wing: 0 };
        this.sfx(() => tone({ freq: 900, toFreq: 200, decay: 0.5, wave: "sawtooth", gain: 0.1 }));
      }
      return;
    }
    const p = this.ptero;
    p.wing = (p.wing + dt * 3.2) % 1;
    const dx = wrapDelta(p.x, this.player.x);
    const dy = this.player.y - p.y;
    p.vx += Math.sign(dx) * 95 * dt;
    p.vy += Math.sign(dy) * 78 * dt;
    p.vx = clamp(p.vx, -130, 130);
    p.vy = clamp(p.vy, -95, 95);
    p.x = wrapX(p.x + p.vx * dt);
    p.y = clamp(p.y + p.vy * dt, 8, LAVA_Y - 36);
  }

  /**
   * The lava troll, who does not care whose leg it is.
   *
   * The arm used to reach for the player and for nothing else, so a mechanic
   * that is part of the arena behaved like a scripted event aimed at one
   * actor. It is also wrong about the original, where leading the last buzzard
   * low over the lava until the hand takes it is a known way to end a wave,
   * and where the middle tier in particular is notorious for blundering into
   * it. Prey is now simply "whoever is lowest over open lava", and the player
   * has no special claim on that either way.
   *
   * The struggle differs because the *input* differs, not because the rules
   * do. The player presses a button five times. A buzzard cannot press
   * anything, so it accrues the same five at a rate rolled once at the grab —
   * see TROLL_STRUGGLE_FAST. Either reaches TROLL_FLAPS and is thrown clear,
   * or the lava arrives first.
   */
  private stepTroll(dt: number, flap: boolean): void {
    this.trollCd = Math.max(0, this.trollCd - dt);

    const t = this.troll;
    if (t) {
      const r = t.target;
      t.t += dt;
      if (!r || (!r.player && !this.enemies.includes(r))) {
        this.troll = null;
        this.trollCd = 1.6;
        return;
      }

      if (!t.grabbed) {
        t.y = Math.max(LAVA_Y - 38, t.y - 95 * dt);
        const near =
          Math.abs(wrapDelta(t.x, r.x + SPR_W / 2)) < 16 &&
          Math.abs(r.y + FOOT - t.y) < 22;
        if (near && r.spawn <= 0) {
          t.grabbed = true;
          t.t = 0;
          if (!r.player) {
            const tier = TIERS[r.tier];
            const escapes = Math.random() < tier.care * TROLL_ESCAPE_OF_CARE;
            t.rate = escapes ? TROLL_STRUGGLE_FAST * tier.vigour : TROLL_STRUGGLE_SLOW;
          }
          this.sfx(() => burst({ freq: 150, q: 1, gain: 0.14, decay: 0.22 }));
        } else if (t.t > 1.1) {
          this.troll = null;
          this.trollCd = 1.6;
        }
        return;
      }

      // Thrashing. For the player this is deliberately *not* gated by
      // `flapCd`: breaking a grip is thrashing rather than flying, and
      // metering it at the flight cadence makes the struggle unwinnable
      // instead of desperate. One per tick is limit enough.
      if (r.player) {
        if (flap) {
          t.flaps++;
          this.sfx(() => burst({ freq: 620, q: 2, gain: 0.09, decay: 0.05 }));
        }
      } else {
        t.flaps += t.rate * dt;
      }

      if (t.flaps >= TROLL_FLAPS) {
        r.vy = -203;
        r.y -= 8;
        r.grounded = false;
        this.troll = null;
        this.trollCd = 1.6;
        this.sfx(() =>
          tone({ freq: 300, toFreq: 700, decay: 0.18, wave: "square", gain: 0.09 })
        );
        return;
      }

      r.x = wrapX(t.x - SPR_W / 2);
      r.y += TROLL_DRAG * dt;
      r.vx = 0;
      r.vy = 0;
      if (r.y + FOOT >= LAVA_Y || t.t > TROLL_HOLD) {
        this.troll = null;
        if (r.player) {
          this.sfx(() => burst({ freq: 120, q: 0.8, gain: 0.16, decay: 0.4 }));
          this.killPlayer();
        } else {
          this.eaten(r);
        }
      }
      return;
    }

    if (this.phase !== "play" || this.trollCd > 0) return;
    const prey = this.lowestOverLava();
    if (!prey) return;
    if (Math.random() > dt * 1.1) return;
    this.troll = {
      x: wrapX(prey.x + SPR_W / 2),
      y: LAVA_Y + 4,
      t: 0,
      grabbed: false,
      flaps: 0,
      rate: 0,
      target: prey,
    };
  }

  /**
   * Whoever is flying lowest over open lava, or nobody.
   *
   * "Open" is the whole point: a rider over a floor run is over stone, and the
   * arm has nothing to come out of. That used to be decided by comparing a
   * platform's y against the literal 206, which was true right up until the
   * floor moved; platforms now say whether they are floor.
   */
  private lowestOverLava(): Rider | null {
    let best: Rider | null = null;
    const consider = (r: Rider): void => {
      if (r.spawn > 0) return;
      const feet = r.y + FOOT;
      if (feet < LAVA_Y - LOW_OVER_LAVA || feet > LAVA_Y) return;
      if (this.plats.some((p) => p.floor && this.overX(r.x + HIT_DX, HIT_W, p))) return;
      if (!best || r.y > best.y) best = r;
    };
    consider(this.player);
    for (const e of this.enemies) consider(e);
    return best;
  }

  /** Dragged under. No egg and no points — the troll got it, the player didn't. */
  private eaten(e: Rider): void {
    const i = this.enemies.indexOf(e);
    if (i >= 0) this.enemies.splice(i, 1);
    this.burstBits(e.x + SPR_W / 2, LAVA_Y - 4, "#ff7a2f", 16);
    this.sfx(() => burst({ freq: 110, q: 0.9, gain: 0.14, decay: 0.34 }));
  }

  /* ------------------------------------------------------------------ */
  /* collisions and outcomes                                             */
  /* ------------------------------------------------------------------ */

  private collide(): void {
    const p = this.player;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.spawn > 0) continue;

      // enemy vs enemy: they bump, they don't kill each other. Softer than a
      // clash with the player, but through the same separation, so two
      // buzzards cannot grind against each other for a second and a half.
      for (let j = i - 1; j >= 0; j--) {
        const o = this.enemies[j];
        if (o.spawn > 0 || e.bump > 0 || o.bump > 0 || !this.touching(e, o)) continue;
        this.bounce(e, o, BOUNCE_VX * 0.55, BOUNCE_VY * 0.5);
      }

      if (p.bump > 0 || e.bump > 0 || !this.touching(e, p)) continue;

      const out = resolveJoust(p.y, e.y);
      if (out === "draw") {
        this.bounce(p, e, BOUNCE_VX, BOUNCE_VY);
        this.sfx(() => burst({ freq: 480, q: 2.5, gain: 0.1, decay: 0.08 }));
      } else if (out === "a") {
        this.unhorse(e, i);
      } else {
        this.killPlayer();
        return;
      }
    }

    if (this.ptero) {
      const t = this.ptero;
      const dx = wrapDelta(t.x + 12, p.x + SPR_W / 2);
      if (Math.abs(dx) < 16 && Math.abs(t.y + 7 - (p.y + 4)) < 12) {
        // The beak, and only the beak, and only to a lance carried level and
        // driven into it.
        const level = Math.abs(p.y + 2 - (t.y + 6)) <= 4;
        const closing = Math.abs(p.vx) > 34 && Math.sign(p.vx) === -Math.sign(dx || 1);
        if (level && closing) {
          this.add(PTERO_SCORE);
          this.floatText(t.x, t.y, PTERO_SCORE);
          this.burstBits(t.x + 12, t.y + 8, "#c9d4ff", 18);
          this.sfx(() => tone({ freq: 1200, toFreq: 120, decay: 0.4, wave: "square", gain: 0.12 }));
          this.ptero = null;
        } else {
          this.killPlayer();
        }
      }
    }
  }

  /**
   * Two riders come off a level clash.
   *
   * Three things happen here and only one of them used to. Setting velocities
   * is not separating: the boxes were still overlapping on the next tick, the
   * same collision resolved again, and a single pass produced three or four
   * stacked bounces. That compounding is what read as the collision physics
   * being wrong — the rule was right, it was just being applied four times to
   * one event. So they are pushed apart to exactly clear, and `BUMP_CD` keeps
   * them deaf to each other while they separate.
   *
   * They also turn around, which the original does and this did not, and they
   * stop being grounded, or a clash on a ledge has its lift eaten by the floor
   * check on the very next tick.
   *
   * The vertical kick is a floor rather than an assignment: a rider already
   * climbing faster than the bounce keeps its own climb instead of being
   * slowed down by being hit, which would be a strange thing for a collision
   * to do.
   */
  private bounce(a: Rider, b: Rider, vx: number, vy: number): void {
    const away = Math.sign(wrapDelta(b.x, a.x)) || 1;
    const gap = Math.max(0, (HIT_W + 2 - Math.abs(wrapDelta(a.x, b.x))) / 2);
    a.x = wrapX(a.x + away * gap);
    b.x = wrapX(b.x - away * gap);
    a.vx = away * vx;
    b.vx = -away * vx;
    a.vy = Math.min(a.vy, vy);
    b.vy = Math.min(b.vy, vy);
    a.face = away > 0 ? 1 : -1;
    b.face = away > 0 ? -1 : 1;
    a.grounded = false;
    b.grounded = false;
    a.bump = BUMP_CD;
    b.bump = BUMP_CD;
  }

  private touching(a: Rider, b: Rider): boolean {
    return (
      Math.abs(wrapDelta(a.x, b.x)) < HIT_W && Math.abs(a.y - b.y) < HIT_H
    );
  }

  /** An enemy loses its mount: it becomes points, and an egg that will bite back. */
  private unhorse(e: Rider, index: number): void {
    const t = TIERS[e.tier];
    this.add(t.score);
    this.floatText(e.x, e.y, t.score);
    this.burstBits(e.x + SPR_W / 2, e.y + SPR_H / 2, t.color, 14);
    this.eggs.push({
      x: e.x + 6,
      y: e.y + 4,
      vx: e.vx * 0.5,
      vy: -54,
      tier: e.tier,
      state: "fall",
      t: 0,
      walk: 1,
      buzz: null,
    });
    this.enemies.splice(index, 1);
    this.sfx(() => {
      burst({ freq: 220, q: 1.2, gain: 0.13, decay: 0.16 });
      tone({ freq: 880, toFreq: 220, decay: 0.18, wave: "square", gain: 0.07 });
    });
  }

  private killPlayer(): void {
    if (this.phase !== "play") return;
    this.phase = "dying";
    this.timer = 1.5;
    this.lives--;
    this.chain = 0;
    this.waveClean = false;
    this.troll = null;
    this.burstBits(this.player.x + SPR_W / 2, this.player.y + SPR_H / 2, "#ffe89a", 22);
    this.sfx(() => tone({ freq: 440, toFreq: 60, decay: 0.6, wave: "sawtooth", gain: 0.13 }));
  }

  private checkWaveEnd(): void {
    if (this.enemies.length || this.eggs.length) return;
    let bonus = 0;
    const kind = waveKind(this.wave);
    if (kind === "survival" && this.waveClean) bonus = SURVIVAL_BONUS;
    if (kind === "egg" && this.waveEggs > 0 && this.waveClean) bonus = EGG_WAVE_BONUS;
    if (bonus) this.add(bonus);
    this.banner = "WAVE CLEARED";
    this.subBanner = bonus ? `BONUS ${bonus}` : "";
    this.phase = "clear";
    this.timer = 1.9;
    this.sfx(() => tone({ freq: 523, toFreq: 1046, decay: 0.3, wave: "square", gain: 0.09 }));
  }

  private add(points: number): void {
    this.score += points;
    if (this.score >= this.nextLife) {
      this.nextLife += EXTRA_LIFE_EVERY;
      this.lives++;
      this.sfx(() => tone({ freq: 660, toFreq: 1320, decay: 0.35, wave: "square", gain: 0.1 }));
    }
  }

  /* ------------------------------------------------------------------ */
  /* effects                                                             */
  /* ------------------------------------------------------------------ */

  private burstBits(x: number, y: number, color: string, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 27 + Math.random() * 95;
      this.bits.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 27,
        life: 0.4 + Math.random() * 0.4,
        max: 0.8,
        color,
      });
    }
  }

  /** Scores drift up from where they were earned. Cheap, and it reads instantly. */
  private floatText(x: number, y: number, value: number): void {
    this.bits.push({ x, y, vx: 0, vy: -35, life: 0.9, max: -value, color: "#ffe89a" });
  }

  private sfx(play: () => void): void {
    if (this.host.muted()) return;
    try {
      play();
    } catch {
      /* audio is a nicety and must never take a frame down */
    }
  }

  private publishFacts(): void {
    const sig = `${this.score}|${this.host.hiScore()}|${this.wave}|${this.lives}`;
    if (sig === this.lastFacts) return;
    this.lastFacts = sig;
    this.host.facts([
      { label: "score", value: this.score.toLocaleString() },
      { label: "high", value: Math.max(this.score, this.host.hiScore()).toLocaleString() },
      { label: "wave", value: `${this.wave}` },
      { label: "lives", value: `${Math.max(0, this.lives)}` },
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* draw                                                                */
  /* ------------------------------------------------------------------ */

  draw(g: CanvasRenderingContext2D): void {
    const c = palette();

    // Black, not a nebula. The original's sky is empty, and a moving
    // background behind hard sprites is exactly what a 1982 board could not
    // do. The theme still shows on the platform edges, as rim light.
    g.fillStyle = "#000000";
    g.fillRect(0, 0, GAME_W, GAME_H);

    this.drawLava(g);
    for (const p of this.plats) this.drawPlatform(g, p, c.cyan, c.magenta);

    // Spawn pads, brightest where the player will appear. Marking them is not
    // decoration: knowing where the next buzzard is coming from is half of
    // deciding where to be.
    for (let i = 0; i < SPAWN_ON.length; i++) {
      const p = this.plats[SPAWN_ON[i]];
      const px = Math.round(p.x + p.w / 2 - 6);
      blit(g, PAD, px, p.y - 3, {
        S: withAlpha(i === 0 ? "#f2d24b" : c.cyan, 0.75),
        s: withAlpha(i === 0 ? "#a8842a" : c.cyan, 0.3),
      });
    }

    for (const e of this.eggs) this.drawEgg(g, e);
    for (const e of this.enemies) this.drawRider(g, e, TIERS[e.tier]);
    if (this.phase !== "attract" && this.phase !== "dying" && this.phase !== "over") {
      this.drawRider(g, this.player, null);
    }
    if (this.ptero) {
      const t = this.ptero;
      this.wrapDraw(t.x, 26, (px) =>
        pterodactyl(g, px, t.y, t.wing, t.vx < 0, "#8f7fd6", "#4b3f86")
      );
    }
    if (this.troll) this.drawTroll(g);

    for (const b of this.bits) {
      if (b.max < 0) {
        text(g, `${-b.max}`, Math.round(b.x) - 6, Math.round(b.y), withAlpha(b.color, Math.min(1, b.life)), 1);
      } else {
        g.fillStyle = withAlpha(b.color, Math.min(1, b.life / b.max));
        g.fillRect(b.x | 0, b.y | 0, 2, 2);
      }
    }

    this.drawHud(g, c.text, c.dim, c.cyan);
    this.drawBanners(g, c.cyan, c.ember, c.text);
  }

  private wrapDraw(x: number, w: number, fn: (px: number) => void): void {
    fn(x);
    if (x + w > GAME_W) fn(x - GAME_W);
    if (x < 0) fn(x + GAME_W);
  }

  private drawLava(g: CanvasRenderingContext2D): void {
    const h = GAME_H - LAVA_Y;
    const grad = g.createLinearGradient(0, LAVA_Y, 0, GAME_H);
    grad.addColorStop(0, "#ff8a2f");
    grad.addColorStop(1, "#7a1a06");
    g.fillStyle = grad;
    g.fillRect(0, LAVA_Y, GAME_W, h);

    // A jagged lip rather than a smooth wave. Two summed sines quantised to
    // whole pixels gives a crust that churns without looking like a gradient —
    // curves are the giveaway on a screen made of squares.
    for (let x = 0; x < GAME_W; x += 2) {
      const crest = Math.sin(x * 0.11 + this.t * 2.2) + Math.sin(x * 0.05 - this.t * 1.3);
      const top = LAVA_Y - 1 + Math.round(crest * 1.6);
      g.fillStyle = "#ffd08a";
      g.fillRect(x, top, 2, 1);
      g.fillStyle = "#ff8a2f";
      g.fillRect(x, top + 1, 2, LAVA_Y - top);
    }
  }

  private drawPlatform(
    g: CanvasRenderingContext2D,
    p: Platform,
    lit: string,
    edge: string
  ): void {
    // Stone, not a slab. The speckle and the lighter top course read as rock;
    // the dither is a deterministic hash of the pixel position so it never
    // crawls between frames.
    g.fillStyle = "#6b5a3e";
    g.fillRect(p.x, p.y, p.w, p.h);
    g.fillStyle = "#8a7550";
    g.fillRect(p.x, p.y + 1, p.w, 2);
    g.fillStyle = "#3d3222";
    g.fillRect(p.x, p.y + p.h - 2, p.w, 2);
    g.fillStyle = "#4f4230";
    for (let sx = 0; sx < p.w; sx++) {
      const h = ((p.x + sx) * 73856093) ^ (p.y * 19349663);
      if ((h >>> 3) % 5 === 0) g.fillRect(p.x + sx, p.y + 3 + ((h >>> 7) % Math.max(1, p.h - 4)), 1, 1);
    }
    // The lit top edge is the one part that takes the void's theme, so the
    // cabinet sits inside Aurora instead of ignoring it.
    g.fillStyle = withAlpha(lit, 0.85);
    g.fillRect(p.x, p.y, p.w, 1);
    g.fillStyle = withAlpha(edge, 0.5);
    g.fillRect(p.x, p.y + 1, 1, p.h - 1);
    g.fillRect(p.x + p.w - 1, p.y + 1, 1, p.h - 1);
  }

  private drawRider(g: CanvasRenderingContext2D, r: Rider, tier: (typeof TIERS)[number] | null): void {
    // Materialising: a shimmer that is deliberately not a solid sprite, so it
    // never reads as something you can hit.
    if (r.spawn > 0) {
      const a = 0.25 + 0.5 * Math.abs(Math.sin(r.spawn * 18));
      g.fillStyle = withAlpha(tier ? tier.color : "#ffe89a", a);
      g.fillRect(r.x + 2, r.y + Math.sin(r.spawn * 12) * 3, SPR_W - 4, 2);
      g.fillRect(r.x + SPR_W / 2 - 1, r.y - 2, 2, SPR_H);
      return;
    }

    const ink = tier ? riderInk(tier.color, tier.shade, "#cfd6e8", "#7b8399", tier.shade) : PLAYER_INK;
    const flip = r.face < 0;
    const phase = 1 - Math.min(1, r.wing);

    this.wrapDraw(r.x, SPR_W, (px) => {
      wings(g, px, r.y, phase, ink.b ?? "#888", flip);
      blit(g, RIDER, px, r.y, ink, flip);
    });
  }

  private drawEgg(g: CanvasRenderingContext2D, e: Egg): void {
    if (e.state === "wait") {
      // Hatched: a rider on foot, which is the warning that it's about to
      // become a problem one tier bigger than the one you just solved.
      this.wrapDraw(e.x, 8, (px) =>
        blit(g, WALKER, px, e.y - 1,
          { P: "#d1443c", H: "#cfd6e8", K: "#cfd6e8", k: "#7b8399", G: "#e0a33a" }, e.walk < 0)
      );
    } else {
      const wobble =
        e.state === "rest" && e.t > EGG_HATCH - 2 ? Math.sin(e.t * 26) * 1 : 0;
      this.wrapDraw(e.x, EGG_W, (px) =>
        blit(g, EGG, px + wobble, e.y, { B: "#e8e2c8", b: "#a89f7c", h: "#fffaf0" })
      );
    }
    if (e.buzz) {
      const b = e.buzz;
      g.fillStyle = "#2a2340";
      g.fillRect(b.x - 5, b.y, 10, 3);
      const beat = Math.sin(this.t * 16) * 4;
      g.beginPath();
      g.moveTo(b.x, b.y);
      g.lineTo(b.x - 11, b.y + beat);
      g.lineTo(b.x - 3, b.y + 3);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(b.x, b.y);
      g.lineTo(b.x + 11, b.y - beat);
      g.lineTo(b.x + 3, b.y + 3);
      g.closePath();
      g.fill();
    }
  }

  private drawTroll(g: CanvasRenderingContext2D): void {
    const t = this.troll;
    if (!t) return;
    // The arm below the wrist, then the hand itself. Drawn as a sprite rather
    // than as blocks so the fingers actually read as fingers.
    g.fillStyle = "#8c2f14";
    g.fillRect(t.x - 2, t.y + 10, 4, GAME_H - t.y);
    blit(g, HAND, t.x - 6, t.y - 4, { F: "#ff8a2f", f: "#c4552f" });
    // Only the player is being told to press anything.
    if (t.grabbed && t.target?.player) {
      const left = Math.max(0, Math.ceil(TROLL_FLAPS - t.flaps));
      textCentered(g, `FLAP ${left}`, t.x, t.y - 22, "#ffd08a", 1);
    }
  }

  private drawHud(g: CanvasRenderingContext2D, ink: string, dim: string, lit: string): void {
    text(g, "1UP", 6, 5, dim, 1);
    text(g, `${this.score}`, 6, 12, ink, 1);
    const hi = Math.max(this.score, this.host.hiScore());
    text(g, "HIGH", GAME_W / 2 - 8, 5, dim, 1);
    textCentered(g, `${hi}`, GAME_W / 2, 12, lit, 1);
    text(g, `WAVE ${this.wave}`, GAME_W - 40, 5, dim, 1);

    for (let i = 0; i < Math.max(0, Math.min(this.lives, 7)); i++) {
      const x = GAME_W - 8 - i * 7;
      g.fillStyle = "#ffe89a";
      g.fillRect(x, 13, 4, 3);
      g.fillRect(x + 3, 11, 2, 2);
    }
  }

  private drawBanners(g: CanvasRenderingContext2D, lit: string, warm: string, ink: string): void {
    const cx = GAME_W / 2;
    if (this.phase === "attract") {
      textCentered(g, "JOUST", cx, 99, warm, 4);
      textCentered(g, "THE VOID ARCADE", cx, 138, lit, 1);
      const blink = Math.floor(this.timer * 2) % 2 === 0;
      if (blink) textCentered(g, "PRESS SPACE TO FLAP", cx, 192, ink, 1);
      textCentered(g, "ARROWS STEER  SPACE FLAPS", cx, 225, "#6d7599", 1);
      textCentered(g, "THE HIGHER LANCE WINS", cx, 243, "#6d7599", 1);
      textCentered(g, `HIGH SCORE ${this.host.hiScore()}`, cx, 279, lit, 1);
      return;
    }
    if (this.phase === "intro") {
      textCentered(g, this.banner, cx, 144, ink, 3);
      if (this.subBanner) textCentered(g, this.subBanner, cx, 183, warm, 1);
      return;
    }
    if (this.phase === "clear") {
      textCentered(g, this.banner, cx, 144, lit, 2);
      if (this.subBanner) textCentered(g, this.subBanner, cx, 177, warm, 2);
      return;
    }
    if (this.phase === "over") {
      textCentered(g, this.banner, cx, 144, warm, 3);
      textCentered(g, `SCORE ${this.score}`, cx, 186, ink, 1);
    }
  }
}

/** The cabinet card. Everything the launcher needs to show and start this. */
export const joustGame: GameDef = {
  id: "joust",
  name: "Joust",
  year: "1982",
  glyph: "\u2694",
  blurb: "flap for height, ride the momentum, and never take a fight from below",
  controls: [
    "\u2190 \u2192 or A D \u2014 steer",
    "space / \u2191 \u2014 flap (one press, one beat)",
    "collect eggs before they hatch \u2014 they come back stronger",
  ],
  width: GAME_W,
  height: GAME_H,
  create: (host: GameHost): Game => new Joust(host),
};
