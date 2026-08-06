/**
 * Galaga — forty of them, and they take turns.
 *
 * The formation is the game. Enemies fly in along curved paths, sit in a
 * breathing rack at the top of the screen, peel off in small groups to attack,
 * and return. That means the pressure is always legible: at any moment you can
 * see how many are left and how many are currently trying to kill you, and
 * those are different numbers. A shooter where every enemy attacks at once has
 * one decision in it; this one has a decision every few seconds.
 *
 * On top of that sits the capture, which is the best idea in the game and the
 * reason it is remembered. A boss can drag your ship away with a tractor beam.
 * You lose it. But shoot that boss later, while it is diving with your ship in
 * tow, and you get the ship back *docked alongside the one you are flying* —
 * twice the guns and twice the width to get hit in. Choosing to be captured on
 * purpose, with a spare life in hand, is a real strategy and the game is much
 * smaller without it.
 *
 * Things that took a correction:
 *
 * - **Dives commit.** An attacker that turns round in view is trivially
 *   dodged. They fly a path that leaves the bottom of the screen and come back
 *   in from the top, which is what makes the screen feel like it circulates.
 * - **Dives aim at where you were, not where you are.** A live-tracking dive
 *   is unavoidable and reads as the game cheating. The swerve is computed once,
 *   at launch.
 * - **The turn rate is the art.** Steering toward waypoints with a capped
 *   angular velocity is what makes the arcs bank. Raising the cap makes them
 *   snap between headings and the whole thing stops looking hand-drawn.
 *
 * The art is original — see `sprites.ts`, which is explicit about it.
 */

import type { Game, GameDef, GameHost, Pad } from "../../types";
import { burst, tone } from "../../../../kernel/audio";
import { palette } from "../../../../kernel/stage";
import { text, textCentered, textRight } from "../shared/pixel";
import { boom, enemy as drawEnemy, fighter, stars, ENEMY_H, ENEMY_W } from "./sprites";
import type { Kind, Point, Slot } from "./rules";
import {
  BEAM_CLOSE,
  BEAM_HALF_W,
  BEAM_HOLD,
  BEAM_OPEN,
  BEAM_Y,
  BOSS_HITS,
  BULLET_SPEED,
  divePath,
  DUAL_OFFSET,
  ENTRY_SPEED,
  entryPath,
  FORMATION_SIZE,
  GAME_H,
  GAME_W,
  isChallenge,
  killScore,
  livesEarned,
  MAX_SHOTS,
  MAX_SHOTS_DUAL,
  MAX_TICKS,
  PERFECT_BONUS,
  PLAYER_H,
  PLAYER_SPEED,
  PLAYER_W,
  PLAYER_Y,
  reentryX,
  slots,
  stageSpec,
  swayAt,
  TICK,
  TURN_RATE,
  WAYPOINT_R,
} from "./rules";

type Phase = "attract" | "ready" | "play" | "dying" | "clear" | "over";
type EnemyState = "entering" | "formed" | "diving" | "returning" | "beaming" | "flyby";

interface Enemy {
  kind: Kind;
  slot: Slot | null;
  x: number;
  y: number;
  heading: number;
  speed: number;
  state: EnemyState;
  path: Point[];
  leg: number;
  hits: number;
  fireCd: number;
  /** How many friends were diving alongside it when it launched. */
  escorts: number;
  beamT: number;
  /** True once this boss has taken the player's ship. */
  carries: boolean;
  side: number;
}

interface Shot {
  x: number;
  y: number;
}

interface Bomb {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Blast {
  x: number;
  y: number;
  t: number;
  life: number;
  scale: number;
}

interface Pop {
  x: number;
  y: number;
  value: number;
  t: number;
}

/** A ship being flown back down to you after you shot the boss holding it. */
interface Rescue {
  x: number;
  y: number;
}

const HIT_PAD = 2;

export class Galaga implements Game {
  private readonly host: GameHost;

  private phase: Phase = "attract";
  private timer = 0;
  private t = 0;
  private stageT = 0;

  private stage = 1;
  private score = 0;
  private lives = 3;
  private livesGiven = 0;

  private enemies: Enemy[] = [];
  private shots: Shot[] = [];
  private bombs: Bomb[] = [];
  private blasts: Blast[] = [];
  private pops: Pop[] = [];
  private rescue: Rescue | null = null;

  private playerX = GAME_W / 2;
  private alive = true;
  private dual = false;
  private respawn = 0;
  private invuln = 0;

  private spawnQueue: Enemy[] = [];
  private spawnGap = 0;
  private diveCd = 0;
  private beamDone = false;

  /** Challenging stages are scored on marksmanship, so both are counted. */
  private shotsFired = 0;
  private shotsHit = 0;
  private challengeHits = 0;

  private acc = 0;
  private fireLatch = false;
  private startLatch = false;
  private seed = 0x9e3779b9;
  private lastFacts = "";

  constructor(host: GameHost) {
    this.host = host;
    this.enterAttract();
  }

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  private makeEnemy(kind: Kind, slot: Slot | null, path: Point[], speed: number): Enemy {
    const [px, py] = path[0];
    return {
      kind,
      slot,
      x: px,
      y: py,
      heading: Math.PI / 2,
      speed,
      state: "entering",
      path,
      leg: 1,
      hits: 0,
      fireCd: 0.5 + this.rand(),
      escorts: 0,
      beamT: 0,
      carries: false,
      side: this.rand() < 0.5 ? -1 : 1,
    };
  }

  /**
   * Queue a stage's worth of arrivals.
   *
   * Five flights of eight, alternating shapes and sides, spaced out so the
   * screen fills over about ten seconds. The original will let you shoot them
   * on the way in, and so does this: an enemy killed during entry never
   * reaches its slot, which is what makes opening a stage aggressively a real
   * option rather than a way to die early.
   */
  private queueStage(): void {
    this.spawnQueue = [];
    this.spawnGap = 0.6;
    const grid = slots();
    const challenge = isChallenge(this.stage);
    const spec = stageSpec(this.stage);

    for (let flight = 0; flight < 5; flight++) {
      const mirror = flight % 2 === 1;
      const path = entryPath(flight, mirror);
      for (let i = 0; i < 8; i++) {
        const idx = flight * 8 + i;
        const slot = grid[idx];
        if (challenge) {
          // No formation and no shooting: they fly the entry arc and keep
          // going out the far side. Forty targets, one pass each.
          const out: Point[] = [
            ...path,
            [mirror ? -30 : GAME_W + 30, 40 + ((idx * 17) % 90)],
          ];
          this.spawnQueue.push(
            this.makeEnemy(grid[idx].kind, null, out, ENTRY_SPEED * 1.15)
          );
        } else {
          this.spawnQueue.push(
            this.makeEnemy(slot.kind, slot, path, ENTRY_SPEED + spec.diveSpeed * 0.1)
          );
        }
      }
    }
  }

  private enterAttract(): void {
    this.phase = "attract";
    this.timer = 0;
    this.stage = 1;
    this.enemies = [];
    this.shots = [];
    this.bombs = [];
    this.blasts = [];
    this.pops = [];
    this.rescue = null;
    this.alive = false;
    this.dual = false;
    this.queueStage();
  }

  private startGame(): void {
    this.score = 0;
    this.lives = 3;
    this.livesGiven = 0;
    this.stage = 1;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.dual = false;
    this.startStage();
  }

  private startStage(): void {
    this.enemies = [];
    this.shots = [];
    this.bombs = [];
    this.blasts = [];
    this.pops = [];
    this.rescue = null;
    this.playerX = GAME_W / 2;
    this.alive = true;
    this.respawn = 0;
    this.invuln = 1.2;
    this.diveCd = 3.2;
    this.beamDone = false;
    this.stageT = 0;
    this.challengeHits = 0;
    this.queueStage();
    this.phase = "ready";
    this.timer = 1.9;
  }

  /* ------------------------------------------------------------------ */
  /* the clock                                                           */
  /* ------------------------------------------------------------------ */

  update(dt: number, pad: Pad): void {
    if (pad.hit("flap")) this.fireLatch = true;
    if (pad.hit("start")) this.startLatch = true;

    this.acc += dt;
    let ticks = 0;
    while (this.acc >= TICK && ticks < MAX_TICKS) {
      this.acc -= TICK;
      ticks++;
      this.tick(pad);
    }
    if (ticks >= MAX_TICKS) this.acc = 0;

    this.publishFacts();
  }

  private tick(pad: Pad): void {
    this.t += TICK;
    this.timer = Math.max(0, this.timer - TICK);

    for (const b of this.blasts) b.t += TICK;
    this.blasts = this.blasts.filter((b) => b.t < b.life);
    for (const p of this.pops) p.t -= TICK;
    this.pops = this.pops.filter((p) => p.t > 0);

    if (this.phase === "attract") {
      this.stepSpawns();
      this.stepEnemies();
      if (this.enemies.length >= FORMATION_SIZE && this.spawnQueue.length === 0) {
        // Loop the fly-in for ever rather than settling on a still frame.
        this.enemies = [];
        this.queueStage();
      }
      if (this.startLatch) {
        this.startLatch = false;
        this.startGame();
      }
      return;
    }

    if (this.phase === "over") {
      if (this.startLatch) {
        this.startLatch = false;
        this.startGame();
      } else if (this.timer <= 0) {
        this.enterAttract();
      }
      this.startLatch = false;
      return;
    }

    if (this.phase === "clear") {
      if (this.timer <= 0) {
        this.stage++;
        this.startStage();
      }
      return;
    }

    if (this.phase === "dying") {
      this.stepEnemies();
      this.stepBombs();
      if (this.timer <= 0) this.afterDeath();
      return;
    }

    if (this.phase === "ready") {
      if (this.timer <= 0) this.phase = "play";
      return;
    }

    this.startLatch = false;
    this.stageT += TICK;

    if (this.respawn > 0) {
      this.respawn -= TICK;
      if (this.respawn <= 0) {
        this.alive = true;
        this.playerX = GAME_W / 2;
        this.invuln = 1.4;
      }
    }
    if (this.invuln > 0) this.invuln -= TICK;

    this.stepPlayer(pad);
    this.stepSpawns();
    this.stepEnemies();
    this.stepDives();
    this.stepShots();
    this.stepBombs();
    this.stepRescue();
    this.collide();

    if (
      this.enemies.length === 0 &&
      this.spawnQueue.length === 0 &&
      this.blasts.length === 0
    ) {
      this.finishStage();
    }
  }

  private finishStage(): void {
    this.phase = "clear";
    this.timer = 2.6;
    if (isChallenge(this.stage) && this.challengeHits >= FORMATION_SIZE) {
      this.add(PERFECT_BONUS);
      this.pops.push({ x: GAME_W / 2, y: 150, value: PERFECT_BONUS, t: 2.6 });
      this.sfx(() => tone({ freq: 660, toFreq: 1980, decay: 0.7, wave: "square", gain: 0.1 }));
    } else {
      this.sfx(() => tone({ freq: 440, toFreq: 880, decay: 0.4, wave: "square", gain: 0.08 }));
    }
  }

  /* ------------------------------------------------------------------ */
  /* the player                                                          */
  /* ------------------------------------------------------------------ */

  private stepPlayer(pad: Pad): void {
    if (!this.alive) {
      this.fireLatch = false;
      return;
    }
    const dir = (pad.down("right") ? 1 : 0) - (pad.down("left") ? 1 : 0);
    this.playerX += dir * PLAYER_SPEED * TICK;
    const half = this.dual ? PLAYER_W / 2 + DUAL_OFFSET : PLAYER_W / 2;
    this.playerX = Math.max(half + 2, Math.min(GAME_W - half - 2, this.playerX));

    if (this.fireLatch) {
      this.fireLatch = false;
      const cap = this.dual ? MAX_SHOTS_DUAL : MAX_SHOTS;
      // The two-shot limit is not a performance concession, it is the
      // difficulty. Being unable to spam means every shot is aimed, and a
      // missed shot at a diving boss is a real cost.
      if (this.shots.length < cap) {
        this.shots.push({ x: this.playerX, y: PLAYER_Y - 6 });
        this.shotsFired++;
        if (this.dual) {
          this.shots.push({ x: this.playerX + DUAL_OFFSET, y: PLAYER_Y - 6 });
          this.shotsFired++;
        }
        this.sfx(() =>
          tone({ freq: 900, toFreq: 300, decay: 0.07, wave: "square", gain: 0.05 })
        );
      }
    }
  }

  private stepShots(): void {
    for (const s of this.shots) s.y -= BULLET_SPEED * TICK;
    this.shots = this.shots.filter((s) => s.y > -6);
  }

  private stepBombs(): void {
    for (const b of this.bombs) {
      b.x += b.vx * TICK;
      b.y += b.vy * TICK;
    }
    this.bombs = this.bombs.filter(
      (b) => b.y < GAME_H + 6 && b.x > -8 && b.x < GAME_W + 8
    );
  }

  private stepRescue(): void {
    const r = this.rescue;
    if (!r) return;
    r.y += 74 * TICK;
    r.x += (this.playerX + DUAL_OFFSET - r.x) * Math.min(1, 3 * TICK);
    if (r.y >= PLAYER_Y) {
      this.rescue = null;
      if (this.alive) {
        this.dual = true;
        this.sfx(() =>
          tone({ freq: 300, toFreq: 1200, decay: 0.45, wave: "square", gain: 0.11 })
        );
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* the flock                                                           */
  /* ------------------------------------------------------------------ */

  private stepSpawns(): void {
    if (this.spawnQueue.length === 0) return;
    this.spawnGap -= TICK;
    if (this.spawnGap > 0) return;
    const next = this.spawnQueue.shift();
    if (next) this.enemies.push(next);
    // Tight within a flight, a beat between flights. That cadence is what
    // makes the fly-in read as five groups rather than as forty singles.
    this.spawnGap = this.spawnQueue.length % 8 === 0 ? 0.95 : 0.16;
  }

  private formX(e: Enemy): number {
    return e.slot ? e.slot.x + swayAt(this.t) : e.x;
  }

  /**
   * Steer toward the next waypoint, banking rather than snapping.
   *
   * The heading turns at a capped rate and the body always moves along the
   * heading, so a waypoint placed sideways produces an arc whose tightness
   * falls out of the speed and the cap. That is the entire reason these flight
   * paths look drawn rather than computed, and it is six lines.
   */
  private fly(e: Enemy, target: Point, speed: number): boolean {
    const dx = target[0] - e.x;
    const dy = target[1] - e.y;
    const want = Math.atan2(dy, dx);
    let delta = want - e.heading;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const max = TURN_RATE * TICK;
    e.heading += Math.max(-max, Math.min(max, delta));
    e.x += Math.cos(e.heading) * speed * TICK;
    e.y += Math.sin(e.heading) * speed * TICK;
    return dx * dx + dy * dy < WAYPOINT_R * WAYPOINT_R;
  }

  private stepEnemies(): void {
    const spec = stageSpec(this.stage);
    const challenge = isChallenge(this.stage);

    for (const e of this.enemies) {
      switch (e.state) {
        case "entering":
        case "flyby": {
          const target = e.path[e.leg];
          if (!target) {
            if (e.slot) {
              e.state = "formed";
              e.heading = -Math.PI / 2;
            } else {
              e.y = GAME_H + 999; // swept away below
            }
            break;
          }
          if (this.fly(e, target, e.speed)) e.leg++;
          if (e.leg >= e.path.length && e.slot) {
            // Last leg is the slot itself; ease the final few pixels so it
            // docks rather than skidding past on its turning circle.
            e.state = "formed";
            e.heading = -Math.PI / 2;
          }
          break;
        }

        case "formed": {
          e.x = this.formX(e);
          e.y = e.slot ? e.slot.y : e.y;
          e.heading = -Math.PI / 2;
          break;
        }

        case "diving": {
          const target = e.path[e.leg];
          if (!target) {
            // Off the bottom: come back in from the top and rejoin.
            e.y = -18;
            e.x = reentryX(Math.floor(this.rand() * 1000));
            e.heading = Math.PI / 2;
            e.state = "returning";
            e.leg = 0;
            break;
          }
          if (this.fly(e, target, spec.diveSpeed)) e.leg++;

          if (!challenge) {
            e.fireCd -= TICK;
            if (e.fireCd <= 0 && e.y < PLAYER_Y - 30 && this.alive) {
              e.fireCd = 0.55 + this.rand() * 0.9;
              if (this.rand() < spec.fireChance) this.dropBomb(e, spec.bulletSpeed);
            }
          }
          break;
        }

        case "returning": {
          if (!e.slot) {
            e.state = "flyby";
            break;
          }
          const done = this.fly(e, [this.formX(e), e.slot.y], spec.diveSpeed * 0.85);
          if (done) {
            e.state = "formed";
            e.heading = -Math.PI / 2;
          }
          break;
        }

        case "beaming": {
          this.stepBeam(e);
          break;
        }
      }
    }

    this.enemies = this.enemies.filter((e) => e.y < GAME_H + 40);
  }

  private dropBomb(e: Enemy, speed: number): void {
    const dx = this.playerX - e.x;
    const dy = PLAYER_Y - e.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    this.bombs.push({
      x: e.x,
      y: e.y + 6,
      vx: (dx / len) * speed,
      vy: (dy / len) * speed,
    });
  }

  /**
   * Choose who attacks next.
   *
   * A cadence, not a per-tick probability — the same lesson `AGENTS.md`
   * records from Joust's wingbeats. `diveEvery` is a number that can be read
   * off the stage table and believed, rather than one that has to be measured
   * and then argued with.
   */
  private stepDives(): void {
    const spec = stageSpec(this.stage);
    const challenge = isChallenge(this.stage);
    if (challenge) return;

    // The beam takes priority: a boss that is going to try for your ship does
    // it instead of an ordinary dive, not as well as one.
    if (
      !this.beamDone &&
      this.alive &&
      !this.dual &&
      this.lives > 0 &&
      this.stageT > spec.beamAfter
    ) {
      const boss = this.enemies.find((e) => e.kind === "boss" && e.state === "formed");
      if (boss) {
        this.beamDone = true;
        boss.state = "beaming";
        boss.beamT = 0;
        this.sfx(() =>
          tone({ freq: 120, toFreq: 460, decay: 0.8, wave: "sawtooth", gain: 0.08 })
        );
        return;
      }
    }

    this.diveCd -= TICK;
    if (this.diveCd > 0) return;
    this.diveCd = spec.diveEvery;

    const ready = this.enemies.filter((e) => e.state === "formed");
    if (ready.length === 0) return;
    const n = Math.min(spec.divers, ready.length);
    const picked: Enemy[] = [];
    for (let i = 0; i < n; i++) {
      const pick = ready[Math.floor(this.rand() * ready.length)];
      if (!picked.includes(pick)) picked.push(pick);
    }
    for (const e of picked) {
      e.state = "diving";
      e.escorts = picked.length - 1;
      e.side = this.rand() < 0.5 ? -1 : 1;
      e.path = divePath(e.x, e.y, this.playerX, e.side);
      e.leg = 0;
      e.fireCd = 0.35 + this.rand() * 0.5;
    }
  }

  /**
   * The tractor beam, in three acts: open, hold, close.
   *
   * The hold is the only window in which the ship can actually be taken, and
   * it is nearly two seconds long. That is deliberate and it is the difference
   * between a mechanic and a mugging: the beam is loud, slow, and visible from
   * the moment it starts, so being captured is always something the player let
   * happen. Which is what makes letting it happen on purpose interesting.
   */
  private stepBeam(e: Enemy): void {
    e.beamT += TICK;
    const total = BEAM_OPEN + BEAM_HOLD + BEAM_CLOSE;

    if (e.beamT < BEAM_OPEN * 0.5) {
      // Drop into position first.
      e.y += (BEAM_Y - e.y) * Math.min(1, 4 * TICK);
      e.x += (this.playerX - e.x) * Math.min(1, 1.1 * TICK);
      return;
    }

    if (e.beamT > BEAM_OPEN && e.beamT < BEAM_OPEN + BEAM_HOLD) {
      if (this.alive && this.invuln <= 0 && Math.abs(this.playerX - e.x) < BEAM_HALF_W) {
        this.capture(e);
      }
    }

    if (e.beamT >= total) {
      e.state = "returning";
      e.leg = 0;
    }
  }

  private capture(boss: Enemy): void {
    boss.carries = true;
    this.alive = false;
    this.lives--;
    this.blasts.push({ x: this.playerX, y: PLAYER_Y, t: 0, life: 0.6, scale: 1.2 });
    this.sfx(() =>
      tone({ freq: 200, toFreq: 1400, decay: 0.7, wave: "sine", gain: 0.11 })
    );
    if (this.lives < 0) {
      this.gameOver();
      return;
    }
    this.respawn = 1.8;
  }

  /* ------------------------------------------------------------------ */
  /* contact                                                             */
  /* ------------------------------------------------------------------ */

  private collide(): void {
    // Shots against the flock.
    for (let si = this.shots.length - 1; si >= 0; si--) {
      const s = this.shots[si];
      let hit = -1;
      for (let ei = 0; ei < this.enemies.length; ei++) {
        const e = this.enemies[ei];
        if (
          s.x >= e.x - ENEMY_W / 2 - HIT_PAD &&
          s.x <= e.x + ENEMY_W / 2 + HIT_PAD &&
          s.y >= e.y - ENEMY_H / 2 - HIT_PAD &&
          s.y <= e.y + ENEMY_H / 2 + HIT_PAD
        ) {
          hit = ei;
          break;
        }
      }
      if (hit < 0) continue;
      this.shots.splice(si, 1);
      this.hitEnemy(hit);
    }

    if (!this.alive || this.invuln > 0) return;

    const halfW = this.dual ? PLAYER_W / 2 + DUAL_OFFSET : PLAYER_W / 2;
    const left = this.playerX - PLAYER_W / 2;
    const right = this.playerX + halfW;

    for (const b of this.bombs) {
      if (
        b.x > left - 1 &&
        b.x < right + 1 &&
        b.y > PLAYER_Y - PLAYER_H / 2 &&
        b.y < PLAYER_Y + PLAYER_H / 2
      ) {
        this.die();
        return;
      }
    }

    for (const e of this.enemies) {
      if (e.state === "formed") continue;
      if (
        e.x + ENEMY_W / 2 > left &&
        e.x - ENEMY_W / 2 < right &&
        e.y + ENEMY_H / 2 > PLAYER_Y - PLAYER_H / 2 &&
        e.y - ENEMY_H / 2 < PLAYER_Y + PLAYER_H / 2
      ) {
        this.die();
        return;
      }
    }
  }

  private hitEnemy(index: number): void {
    const e = this.enemies[index];
    this.shotsHit++;

    if (e.kind === "boss" && e.hits < BOSS_HITS - 1) {
      e.hits++;
      this.sfx(() => burst({ freq: 520, q: 2, gain: 0.07, decay: 0.06 }));
      return;
    }

    const diving = e.state !== "formed";
    const value = isChallenge(this.stage)
      ? killScore(e.kind, false)
      : killScore(e.kind, diving, e.escorts);
    this.add(value);
    if (isChallenge(this.stage)) this.challengeHits++;

    // Shooting a boss that has your ship gives it back — but only if it was
    // in the air. A captured ship sitting in the rack is out of reach, which
    // is why you have to wait for it to come at you.
    if (e.carries && diving && !this.dual && !this.rescue) {
      this.rescue = { x: e.x, y: e.y };
    }

    this.blasts.push({ x: e.x, y: e.y, t: 0, life: 0.42, scale: e.kind === "boss" ? 1.3 : 1 });
    this.pops.push({ x: e.x, y: e.y, value, t: 0.8 });
    this.enemies.splice(index, 1);
    this.sfx(() => {
      burst({ freq: 260, q: 1.1, gain: 0.09, decay: 0.14 });
      tone({ freq: 420, toFreq: 90, decay: 0.16, wave: "square", gain: 0.06 });
    });
  }

  private die(): void {
    this.alive = false;
    this.dual = false;
    this.lives--;
    this.blasts.push({ x: this.playerX, y: PLAYER_Y, t: 0, life: 0.75, scale: 1.6 });
    this.sfx(() => {
      burst({ freq: 150, q: 0.8, gain: 0.12, decay: 0.5 });
      tone({ freq: 300, toFreq: 50, decay: 0.6, wave: "sawtooth", gain: 0.1 });
    });
    if (this.lives < 0) {
      this.gameOver();
      return;
    }
    this.phase = "dying";
    this.timer = 1.5;
  }

  private afterDeath(): void {
    this.phase = "play";
    this.alive = true;
    this.playerX = GAME_W / 2;
    this.invuln = 1.6;
    this.bombs = [];
  }

  private gameOver(): void {
    this.phase = "over";
    this.timer = 7;
    this.alive = false;
    this.host.submit(this.score);
  }

  private add(points: number): void {
    this.score += points;
    const earned = livesEarned(this.score);
    if (earned > this.livesGiven) {
      this.lives += earned - this.livesGiven;
      this.livesGiven = earned;
      this.sfx(() =>
        tone({ freq: 880, toFreq: 1760, decay: 0.3, wave: "square", gain: 0.09 })
      );
    }
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
    const sig = `${this.score}|${this.host.hiScore()}|${this.stage}|${this.lives}|${this.dual}`;
    if (sig === this.lastFacts) return;
    this.lastFacts = sig;
    const ratio =
      this.shotsFired > 0 ? Math.round((this.shotsHit / this.shotsFired) * 100) : 0;
    this.host.facts([
      { label: "score", value: this.score.toLocaleString() },
      { label: "high", value: Math.max(this.score, this.host.hiScore()).toLocaleString() },
      { label: "stage", value: `${this.stage}${isChallenge(this.stage) ? " \u2605" : ""}` },
      { label: "ships", value: `${Math.max(0, this.lives)}${this.dual ? " (dual)" : ""}` },
      { label: "hit rate", value: `${ratio}%` },
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* draw                                                                */
  /* ------------------------------------------------------------------ */

  draw(g: CanvasRenderingContext2D): void {
    const c = palette();

    g.fillStyle = "#000000";
    g.fillRect(0, 0, GAME_W, GAME_H);
    stars(g, this.t, GAME_W, GAME_H, 120);

    this.drawBeams(g);

    const wing = Math.floor(this.t * 5) % 2;
    for (const e of this.enemies) {
      const x = Math.round(e.x) - ENEMY_W / 2;
      const y = Math.round(e.y) - ENEMY_H / 2;
      drawEnemy(g, e.kind, Math.round(x), Math.round(y), wing, e.hits > 0);
      if (e.carries) {
        // The stolen ship rides underneath, dimmed. It has to be visible from
        // across the screen or the player never learns it can be won back.
        fighter(g, Math.round(x), Math.round(y) + ENEMY_H + 1, true);
      }
    }

    for (const s of this.shots) {
      g.fillStyle = "#e8ecff";
      g.fillRect(Math.round(s.x), Math.round(s.y), 1, 5);
    }
    for (const b of this.bombs) {
      g.fillStyle = "#ffd23c";
      g.fillRect(Math.round(b.x) - 1, Math.round(b.y) - 1, 2, 3);
    }

    if (this.rescue) {
      fighter(g, Math.round(this.rescue.x) - PLAYER_W / 2, Math.round(this.rescue.y) - 6);
    }

    if (this.alive && (this.invuln <= 0 || Math.floor(this.t * 12) % 2 === 0)) {
      fighter(g, Math.round(this.playerX) - Math.floor(PLAYER_W / 2), PLAYER_Y - 6);
      if (this.dual) {
        fighter(
          g,
          Math.round(this.playerX) - Math.floor(PLAYER_W / 2) + DUAL_OFFSET,
          PLAYER_Y - 6
        );
      }
    }

    for (const b of this.blasts) {
      boom(g, b.x, b.y, b.t / b.life, b.scale, "#ffd23c", "#ff5c3c");
    }
    for (const p of this.pops) {
      textCentered(g, `${p.value}`, p.x, p.y - 4, "#9fe8ff", 1);
    }

    this.drawHud(g, c.text, c.dim);
    this.drawBanners(g, c.text, c.cyan, c.ember);
  }

  /**
   * The beam: a widening cone of stacked bars.
   *
   * Drawn as horizontal slices rather than as a filled polygon so the edges
   * stay on the pixel grid, and animated by how many slices are lit rather
   * than by opacity — a fading gradient is the one thing on this screen the
   * original hardware could not have produced.
   */
  private drawBeams(g: CanvasRenderingContext2D): void {
    for (const e of this.enemies) {
      if (e.state !== "beaming") continue;
      const open = Math.min(1, Math.max(0, (e.beamT - BEAM_OPEN * 0.5) / (BEAM_OPEN * 0.5)));
      const closing = Math.max(0, (e.beamT - BEAM_OPEN - BEAM_HOLD) / BEAM_CLOSE);
      const reach = Math.max(0, open - closing);
      if (reach <= 0) continue;
      const bottom = e.y + (PLAYER_Y - e.y) * reach;
      const bands = ["#3fd86a", "#9fe8ff", "#c05cff"];
      for (let y = e.y + 6; y < bottom; y += 3) {
        const k = (y - e.y) / Math.max(1, PLAYER_Y - e.y);
        const half = 4 + (BEAM_HALF_W - 4) * k;
        const band = Math.floor((y * 0.34 + this.t * 14) % 3);
        g.fillStyle = bands[band];
        g.fillRect(Math.round(e.x - half), Math.round(y), Math.round(half * 2), 1);
      }
    }
  }

  private drawHud(g: CanvasRenderingContext2D, ink: string, dim: string): void {
    text(g, "1UP", 6, 2, dim, 1);
    text(g, `${this.score}`, 6, 10, ink, 1);
    textCentered(g, "HIGH SCORE", GAME_W / 2, 2, dim, 1);
    textCentered(
      g,
      `${Math.max(this.score, this.host.hiScore())}`,
      GAME_W / 2,
      10,
      "#ffd23c",
      1
    );
    textRight(g, `STAGE ${this.stage}`, GAME_W - 6, 2, dim, 1);

    for (let i = 0; i < Math.max(0, Math.min(this.lives, 5)); i++) {
      fighter(g, 4 + i * 15, GAME_H - 13);
    }
  }

  private drawBanners(
    g: CanvasRenderingContext2D,
    ink: string,
    lit: string,
    warm: string
  ): void {
    const cx = GAME_W / 2;
    if (this.phase === "attract") {
      textCentered(g, "GALAGA", cx, 150, warm, 3);
      textCentered(g, "THE VOID ARCADE", cx, 174, lit, 1);
      if (Math.floor(this.t * 2) % 2 === 0) {
        textCentered(g, "PRESS SPACE TO START", cx, 198, ink, 1);
      }
      textCentered(g, "LET THEM TAKE YOUR SHIP", cx, 218, "#6d7599", 1);
      textCentered(g, "THEN SHOOT IT BACK", cx, 230, "#6d7599", 1);
      return;
    }
    if (this.phase === "ready") {
      if (isChallenge(this.stage)) {
        textCentered(g, "CHALLENGING STAGE", cx, 140, lit, 1);
        textCentered(g, "HIT ALL 40", cx, 156, warm, 1);
      } else {
        textCentered(g, `STAGE ${this.stage}`, cx, 148, lit, 2);
      }
      return;
    }
    if (this.phase === "clear" && isChallenge(this.stage)) {
      textCentered(g, `HITS  ${this.challengeHits}  /  40`, cx, 148, lit, 1);
      if (this.challengeHits >= FORMATION_SIZE) {
        textCentered(g, "PERFECT", cx, 166, warm, 2);
      }
      return;
    }
    if (this.phase === "over") {
      const ratio =
        this.shotsFired > 0 ? Math.round((this.shotsHit / this.shotsFired) * 100) : 0;
      textCentered(g, "GAME OVER", cx, 132, warm, 2);
      textCentered(g, `SCORE ${this.score}`, cx, 156, ink, 1);
      // The original prints your hit/miss ratio on the way out, which quietly
      // reframes the whole game as a marksmanship test rather than a survival
      // one. Worth keeping for that alone.
      textCentered(g, `SHOTS FIRED ${this.shotsFired}`, cx, 172, "#6d7599", 1);
      textCentered(g, `HIT MISS RATIO ${ratio}%`, cx, 184, lit, 1);
    }
  }
}

/** The cabinet card. Everything the launcher needs to show and start this. */
export const galagaGame: GameDef = {
  id: "galaga",
  name: "Galaga",
  year: "1981",
  glyph: "\u2726",
  blurb: "forty of them, taking turns, and one that wants your ship",
  controls: [
    "\u2190 \u2192 or A D \u2014 fly",
    "space \u2014 fire (two in the air, four when doubled)",
    "shoot the boss that stole your ship to fly both at once",
  ],
  width: GAME_W,
  height: GAME_H,
  create: (host: GameHost): Game => new Galaga(host),
};
