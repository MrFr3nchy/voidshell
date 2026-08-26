/**
 * Asteroids — a screen with no floor, no walls, and no brakes.
 *
 * Everything here follows from two physics facts the design brief insists on
 * and that are the ones most likely to look like bugs to a reviewer who
 * hasn't played the original: **the ship has no rotational momentum** (the
 * heading turns at a fixed rate the instant you hold a direction, full stop
 * the instant you let go) and **the ship has no friction** (thrust adds
 * velocity and nothing ever subtracts it back out). Coast past a rock
 * sideways with the engine off and you are still moving sideways past the
 * next one. Both are load-bearing, not oversights — see `rules.ts` for the
 * long version.
 *
 * The other thing worth stating up front: a bullet's speed is fixed relative
 * to the *screen*, not added to the ship's own velocity. Flying backwards
 * past a shot you just fired forwards is a real thing that happens here, the
 * same as it was on the original hardware.
 *
 * Saucers get the same treatment `AGENTS.md` gives Joust's buzzards: the
 * incompetence is in what the large one decides to do (fire in a
 * near-random direction) and never in whether it can reach you. The small
 * one aims for real, with an accuracy that improves as the score climbs — see
 * `saucerSpread` in `rules.ts`.
 *
 * The art is original — see `sprites.ts`, which is explicit about it and
 * about why it's strokes instead of blitted pixels.
 */

import type { Game, GameDef, GameHost, Pad } from "../../types";
import { burst as sfxBurst, tone } from "../../../../kernel/audio";
import { palette } from "../../../../kernel/stage";
import { text, textCentered, textRight } from "../shared/pixel";
import {
  asteroid as drawAsteroid,
  bullet as drawBullet,
  burst as drawBurst,
  saucer as drawSaucer,
  ship as drawShip,
} from "./sprites";
import type { AsteroidSize, SaucerKind } from "./rules";
import {
  ASTEROID_RADIUS,
  ASTEROID_SPEED_RANGE,
  BULLET_LIFE,
  BULLET_SPEED,
  CHILDREN_PER_SPLIT,
  childSize,
  GAME_H,
  GAME_W,
  HYPERSPACE_DEATH_CHANCE,
  hyperspaceDestination,
  livesEarned,
  makeAsteroidShape,
  MAX_BULLETS,
  MAX_TICKS,
  RESPAWN_INVULN,
  SAUCER_BULLET_LIFE,
  SAUCER_BULLET_SPEED,
  SAUCER_RADIUS,
  SAUCER_SCORE,
  SAUCER_SPEED,
  saucerKindChance,
  saucerSpawnInterval,
  saucerSpread,
  SCORE_ASTEROID,
  SHIP_MAX_SPEED,
  SHIP_RADIUS,
  STARTING_LIVES,
  THRUST_ACCEL,
  TICK,
  TURN_RATE,
  waveAsteroidCount,
  wrapDelta,
  wrapOffsets,
  wrappedOverlap,
  wrapX,
  wrapY,
} from "./rules";

type Phase = "attract" | "ready" | "play" | "dying" | "clear" | "over";

interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

interface RockEntity {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: AsteroidSize;
  shape: number[];
  rot: number;
  rotSpeed: number;
}

interface SaucerEntity {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: SaucerKind;
  fireCd: number;
  turnCd: number;
  life: number;
}

interface Spark {
  x: number;
  y: number;
  t: number;
  life: number;
  scale: number;
}

export class Asteroids implements Game {
  private readonly host: GameHost;

  private phase: Phase = "attract";
  private timer = 0;
  private t = 0;

  private wave = 1;
  private score = 0;
  private lives = STARTING_LIVES;
  private livesGiven = 0;

  private shipX = GAME_W / 2;
  private shipY = GAME_H / 2;
  private shipVX = 0;
  private shipVY = 0;
  private heading = -Math.PI / 2;
  private shipAlive = true;
  private thrusting = false;
  private invuln = 0;

  private bullets: Bullet[] = [];
  private rocks: RockEntity[] = [];
  private saucer: SaucerEntity | null = null;
  private saucerShots: Bullet[] = [];
  private sparks: Spark[] = [];

  private saucerTimer = 8;

  private acc = 0;
  private fireLatch = false;
  private hyperLatch = false;
  private startLatch = false;
  private seed = 0x5eed1979;
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

  private makeRock(x: number, y: number, size: AsteroidSize): RockEntity {
    const [lo, hi] = ASTEROID_SPEED_RANGE[size];
    const speed = lo + this.rand() * (hi - lo);
    const heading = this.rand() * Math.PI * 2;
    return {
      x,
      y,
      vx: Math.cos(heading) * speed,
      vy: Math.sin(heading) * speed,
      size,
      shape: makeAsteroidShape(() => this.rand()),
      rot: this.rand() * Math.PI * 2,
      rotSpeed: (this.rand() - 0.5) * 1.4,
    };
  }

  /**
   * A fresh field. Rocks spawn at the edges, well clear of the ship's start
   * position — a large asteroid materialising on top of you before you have
   * even moved is not difficulty, it is an unfair start, and the original
   * never does it either.
   */
  private spawnField(): void {
    this.rocks = [];
    const count = waveAsteroidCount(this.wave);
    for (let i = 0; i < count; i++) {
      const edge = Math.floor(this.rand() * 4);
      let x: number;
      let y: number;
      if (edge === 0) {
        x = this.rand() * GAME_W;
        y = 0;
      } else if (edge === 1) {
        x = GAME_W;
        y = this.rand() * GAME_H;
      } else if (edge === 2) {
        x = this.rand() * GAME_W;
        y = GAME_H;
      } else {
        x = 0;
        y = this.rand() * GAME_H;
      }
      this.rocks.push(this.makeRock(x, y, "large"));
    }
  }

  private resetShip(): void {
    this.shipX = GAME_W / 2;
    this.shipY = GAME_H / 2;
    this.shipVX = 0;
    this.shipVY = 0;
    this.heading = -Math.PI / 2;
    this.shipAlive = true;
    this.thrusting = false;
    this.invuln = RESPAWN_INVULN;
  }

  private enterAttract(): void {
    this.phase = "attract";
    this.timer = 0;
    this.wave = 1;
    this.shipAlive = false;
    this.bullets = [];
    this.saucer = null;
    this.saucerShots = [];
    this.sparks = [];
    this.saucerTimer = 8;
    this.spawnField();
  }

  private startGame(): void {
    this.score = 0;
    this.wave = 1;
    this.lives = STARTING_LIVES;
    this.livesGiven = 0;
    this.resetShip();
    this.startWave();
  }

  private startWave(): void {
    this.bullets = [];
    this.saucer = null;
    this.saucerShots = [];
    this.spawnField();
    this.saucerTimer = saucerSpawnInterval(this.score);
    this.phase = "ready";
    this.timer = 1.5;
  }

  /* ------------------------------------------------------------------ */
  /* the clock                                                           */
  /* ------------------------------------------------------------------ */

  update(dt: number, pad: Pad): void {
    if (pad.hit("flap")) this.fireLatch = true;
    if (pad.hit("down")) this.hyperLatch = true;
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

    for (const s of this.sparks) s.t += TICK;
    this.sparks = this.sparks.filter((s) => s.t < s.life);

    if (this.phase === "attract") {
      this.stepRocks();
      if (this.startLatch) {
        this.startLatch = false;
        this.startGame();
      }
      return;
    }

    if (this.phase === "over") {
      if (this.startLatch && this.timer < 6) {
        this.startLatch = false;
        this.startGame();
      } else if (this.timer <= 0) {
        this.enterAttract();
      }
      this.startLatch = false;
      return;
    }

    if (this.phase === "clear") {
      this.stepRocks();
      this.stepSaucer();
      this.stepSaucerShots();
      if (this.timer <= 0) {
        this.wave++;
        this.startWave();
      }
      return;
    }

    if (this.phase === "dying") {
      this.stepRocks();
      this.stepSaucer();
      this.stepSaucerShots();
      if (this.timer <= 0) this.afterDeath();
      return;
    }

    if (this.phase === "ready") {
      if (this.timer <= 0) this.phase = "play";
      return;
    }

    this.startLatch = false;

    this.stepShip(pad);
    this.stepBullets();
    this.stepRocks();
    this.stepSaucerSpawn();
    this.stepSaucer();
    this.stepSaucerShots();
    this.collide();

    if (this.rocks.length === 0) this.finishWave();
  }

  private finishWave(): void {
    this.phase = "clear";
    this.timer = 2.2;
    this.sfx(() => tone({ freq: 440, toFreq: 880, decay: 0.35, wave: "square", gain: 0.08 }));
  }

  /* ------------------------------------------------------------------ */
  /* the ship                                                            */
  /* ------------------------------------------------------------------ */

  private stepShip(pad: Pad): void {
    if (!this.shipAlive) {
      this.fireLatch = false;
      this.hyperLatch = false;
      return;
    }

    // No momentum on the turn: the heading is a direct function of held time,
    // not something the sprite eases toward.
    const dir = (pad.down("right") ? 1 : 0) - (pad.down("left") ? 1 : 0);
    this.heading += dir * TURN_RATE * TICK;

    this.thrusting = pad.down("up");
    if (this.thrusting) {
      // No friction: this is the only place velocity ever changes. Let go
      // and whatever it is right now is what it stays.
      this.shipVX += Math.cos(this.heading) * THRUST_ACCEL * TICK;
      this.shipVY += Math.sin(this.heading) * THRUST_ACCEL * TICK;
      const speed = Math.hypot(this.shipVX, this.shipVY);
      if (speed > SHIP_MAX_SPEED) {
        const k = SHIP_MAX_SPEED / speed;
        this.shipVX *= k;
        this.shipVY *= k;
      }
    }

    this.shipX = wrapX(this.shipX + this.shipVX * TICK);
    this.shipY = wrapY(this.shipY + this.shipVY * TICK);

    if (this.invuln > 0) this.invuln -= TICK;

    if (this.fireLatch) {
      this.fireLatch = false;
      if (this.bullets.length < MAX_BULLETS) {
        this.bullets.push({
          x: this.shipX + Math.cos(this.heading) * SHIP_RADIUS,
          y: this.shipY + Math.sin(this.heading) * SHIP_RADIUS,
          vx: Math.cos(this.heading) * BULLET_SPEED,
          vy: Math.sin(this.heading) * BULLET_SPEED,
          life: BULLET_LIFE,
        });
        this.sfx(() => tone({ freq: 1200, toFreq: 700, decay: 0.06, wave: "square", gain: 0.05 }));
      }
    }

    if (this.hyperLatch) {
      this.hyperLatch = false;
      this.hyperspace();
    }
  }

  private hyperspace(): void {
    const { x, y } = hyperspaceDestination(() => this.rand());
    this.shipX = x;
    this.shipY = y;
    if (this.rand() < HYPERSPACE_DEATH_CHANCE) {
      this.sfx(() => tone({ freq: 500, toFreq: 40, decay: 0.5, wave: "sawtooth", gain: 0.12 }));
      this.dieShip();
      return;
    }
    this.invuln = Math.max(this.invuln, 0.6);
    this.sfx(() => tone({ freq: 300, toFreq: 900, decay: 0.18, wave: "sine", gain: 0.06 }));
  }

  /* ------------------------------------------------------------------ */
  /* everything else that moves                                         */
  /* ------------------------------------------------------------------ */

  private stepBullets(): void {
    for (const b of this.bullets) {
      b.x = wrapX(b.x + b.vx * TICK);
      b.y = wrapY(b.y + b.vy * TICK);
      b.life -= TICK;
    }
    this.bullets = this.bullets.filter((b) => b.life > 0);
  }

  private stepRocks(): void {
    for (const r of this.rocks) {
      r.x = wrapX(r.x + r.vx * TICK);
      r.y = wrapY(r.y + r.vy * TICK);
      r.rot += r.rotSpeed * TICK;
    }
  }

  private stepSaucerSpawn(): void {
    if (this.saucer) return;
    this.saucerTimer -= TICK;
    if (this.saucerTimer > 0) return;
    const kind: SaucerKind = this.rand() < saucerKindChance(this.score) ? "small" : "large";
    const fromLeft = this.rand() < 0.5;
    this.saucer = {
      x: fromLeft ? -SAUCER_RADIUS[kind] : GAME_W + SAUCER_RADIUS[kind],
      y: 20 + this.rand() * (GAME_H - 40),
      vx: (fromLeft ? 1 : -1) * SAUCER_SPEED[kind],
      vy: (this.rand() - 0.5) * 30,
      kind,
      fireCd: 1 + this.rand() * 1.4,
      turnCd: 1 + this.rand() * 2,
      life: 11 + this.rand() * 6,
    };
  }

  private endSaucer(): void {
    this.saucer = null;
    this.saucerTimer = saucerSpawnInterval(this.score);
  }

  /**
   * The large saucer wanders: it holds its horizontal heading (crossing the
   * screen is the whole point of it) and only ever changes its vertical
   * drift, at random, on a cadence rather than by tracking anything. That is
   * the entire incompetence budget for this enemy — it is not blind and it
   * is not slow, it simply never decided to aim at you in the first place.
   */
  private stepSaucer(): void {
    const s = this.saucer;
    if (!s) return;

    s.x = wrapX(s.x + s.vx * TICK);
    s.y = wrapY(s.y + s.vy * TICK);

    s.turnCd -= TICK;
    if (s.turnCd <= 0) {
      s.vy = (this.rand() - 0.5) * 40;
      s.turnCd = 1 + this.rand() * 2;
    }

    s.life -= TICK;
    if (s.life <= 0) {
      this.endSaucer();
      return;
    }

    if (!this.shipAlive) return;
    s.fireCd -= TICK;
    if (s.fireCd <= 0) {
      this.fireSaucer(s);
      s.fireCd = s.kind === "small" ? 0.85 + this.rand() * 0.6 : 1.3 + this.rand() * 1.0;
    }
  }

  private fireSaucer(s: SaucerEntity): void {
    const dx = wrapDelta(s.x, this.shipX, GAME_W);
    const dy = wrapDelta(s.y, this.shipY, GAME_H);
    const aim = Math.atan2(dy, dx);
    const spread = saucerSpread(s.kind, this.score);
    // The large saucer's spread is a full circle, so `aim` doesn't matter to
    // it in practice — it fires roughly anywhere. The small one is a genuine
    // aim with real, shrinking error.
    const angle =
      s.kind === "large" ? this.rand() * Math.PI * 2 : aim + (this.rand() - 0.5) * 2 * spread;
    this.saucerShots.push({
      x: s.x,
      y: s.y,
      vx: Math.cos(angle) * SAUCER_BULLET_SPEED,
      vy: Math.sin(angle) * SAUCER_BULLET_SPEED,
      life: SAUCER_BULLET_LIFE,
    });
    this.sfx(() => tone({ freq: 340, toFreq: 220, decay: 0.12, wave: "sawtooth", gain: 0.05 }));
  }

  private stepSaucerShots(): void {
    for (const b of this.saucerShots) {
      b.x = wrapX(b.x + b.vx * TICK);
      b.y = wrapY(b.y + b.vy * TICK);
      b.life -= TICK;
    }
    this.saucerShots = this.saucerShots.filter((b) => b.life > 0);
  }

  /* ------------------------------------------------------------------ */
  /* contact                                                             */
  /* ------------------------------------------------------------------ */

  private collide(): void {
    // Player bullets against rocks.
    outer: for (let bi = this.bullets.length - 1; bi >= 0; bi--) {
      const b = this.bullets[bi];
      for (let ri = 0; ri < this.rocks.length; ri++) {
        const r = this.rocks[ri];
        if (!wrappedOverlap(b.x, b.y, 0.5, r.x, r.y, ASTEROID_RADIUS[r.size])) continue;
        this.bullets.splice(bi, 1);
        this.hitRock(ri);
        continue outer;
      }
    }

    // Player bullets against the saucer.
    if (this.saucer) {
      for (let bi = this.bullets.length - 1; bi >= 0; bi--) {
        const b = this.bullets[bi];
        const s = this.saucer;
        if (!s || !wrappedOverlap(b.x, b.y, 0.5, s.x, s.y, SAUCER_RADIUS[s.kind])) continue;
        this.bullets.splice(bi, 1);
        this.addScore(SAUCER_SCORE[s.kind]);
        this.sparks.push({ x: s.x, y: s.y, t: 0, life: 0.5, scale: SAUCER_RADIUS[s.kind] });
        this.sfx(() => {
          sfxBurst({ freq: 260, q: 1.4, gain: 0.09, decay: 0.16 });
          tone({ freq: 500, toFreq: 90, decay: 0.2, wave: "square", gain: 0.07 });
        });
        this.endSaucer();
        break;
      }
    }

    if (!this.shipAlive || this.invuln > 0) return;

    // Saucer fire against the ship.
    for (let i = this.saucerShots.length - 1; i >= 0; i--) {
      const b = this.saucerShots[i];
      if (!wrappedOverlap(b.x, b.y, 0.5, this.shipX, this.shipY, SHIP_RADIUS)) continue;
      this.saucerShots.splice(i, 1);
      this.dieShip();
      return;
    }

    // Rocks against the ship. The rock survives a collision — only a shot
    // destroys one — the ship does not.
    for (const r of this.rocks) {
      if (!wrappedOverlap(this.shipX, this.shipY, SHIP_RADIUS, r.x, r.y, ASTEROID_RADIUS[r.size]))
        continue;
      this.dieShip();
      return;
    }

    // The saucer itself, by contact rather than by a shot. No score for a
    // ram — points only come from aiming.
    if (
      this.saucer &&
      wrappedOverlap(this.shipX, this.shipY, SHIP_RADIUS, this.saucer.x, this.saucer.y, SAUCER_RADIUS[this.saucer.kind])
    ) {
      this.sparks.push({ x: this.saucer.x, y: this.saucer.y, t: 0, life: 0.5, scale: SAUCER_RADIUS[this.saucer.kind] });
      this.endSaucer();
      this.dieShip();
    }
  }

  private hitRock(index: number): void {
    const r = this.rocks[index];
    this.addScore(SCORE_ASTEROID[r.size]);
    this.sparks.push({ x: r.x, y: r.y, t: 0, life: 0.4, scale: ASTEROID_RADIUS[r.size] * 0.6 });
    this.sfx(() => sfxBurst({ freq: 180 + ASTEROID_RADIUS[r.size] * 4, q: 1.2, gain: 0.08, decay: 0.12 }));

    const next = childSize(r.size);
    this.rocks.splice(index, 1);
    if (!next) return;
    for (let i = 0; i < CHILDREN_PER_SPLIT; i++) {
      this.rocks.push(this.makeRock(r.x, r.y, next));
    }
  }

  private dieShip(): void {
    this.shipAlive = false;
    this.thrusting = false;
    this.lives--;
    this.sparks.push({ x: this.shipX, y: this.shipY, t: 0, life: 0.8, scale: 10 });
    this.sfx(() => {
      sfxBurst({ freq: 140, q: 0.8, gain: 0.13, decay: 0.5 });
      tone({ freq: 260, toFreq: 40, decay: 0.6, wave: "sawtooth", gain: 0.1 });
    });
    if (this.lives < 0) {
      this.gameOver();
      return;
    }
    this.phase = "dying";
    this.timer = 1.7;
  }

  private afterDeath(): void {
    this.resetShip();
    this.phase = "play";
  }

  private gameOver(): void {
    this.phase = "over";
    this.timer = 7;
    this.shipAlive = false;
    this.host.submit(this.score);
    this.sfx(() => tone({ freq: 180, toFreq: 40, decay: 1.4, wave: "sawtooth", gain: 0.12 }));
  }

  private addScore(points: number): void {
    this.score += points;
    const earned = livesEarned(this.score);
    if (earned > this.livesGiven) {
      this.lives += earned - this.livesGiven;
      this.livesGiven = earned;
      this.sfx(() => tone({ freq: 700, toFreq: 1400, decay: 0.3, wave: "square", gain: 0.09 }));
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
    const sig = `${this.score}|${this.host.hiScore()}|${this.wave}|${this.lives}|${Boolean(this.saucer)}`;
    if (sig === this.lastFacts) return;
    this.lastFacts = sig;
    this.host.facts([
      { label: "score", value: this.score.toLocaleString() },
      { label: "high", value: Math.max(this.score, this.host.hiScore()).toLocaleString() },
      { label: "wave", value: `${this.wave}` },
      { label: "ships", value: `${Math.max(0, this.lives)}` },
      { label: "saucer", value: this.saucer ? this.saucer.kind : "none" },
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* draw                                                                */
  /* ------------------------------------------------------------------ */

  draw(g: CanvasRenderingContext2D): void {
    const c = palette();

    g.fillStyle = "#000000";
    g.fillRect(0, 0, GAME_W, GAME_H);

    for (const r of this.rocks) {
      const radius = ASTEROID_RADIUS[r.size];
      for (const [ox, oy] of wrapOffsets(r.x, r.y, radius)) {
        drawAsteroid(g, r.x + ox, r.y + oy, radius, r.shape, r.rot, "#c9d6ff");
      }
    }

    for (const b of this.bullets) {
      for (const [ox, oy] of wrapOffsets(b.x, b.y, 1)) drawBullet(g, b.x + ox, b.y + oy, "#f4f6ff");
    }
    for (const b of this.saucerShots) {
      for (const [ox, oy] of wrapOffsets(b.x, b.y, 1)) drawBullet(g, b.x + ox, b.y + oy, "#ff5c3c");
    }

    if (this.saucer) {
      const s = this.saucer;
      const color = s.kind === "small" ? "#ff5c3c" : "#9fe8ff";
      for (const [ox, oy] of wrapOffsets(s.x, s.y, SAUCER_RADIUS[s.kind])) {
        drawSaucer(g, s.x + ox, s.y + oy, s.kind, color);
      }
    }

    if (this.shipAlive && (this.invuln <= 0 || Math.floor(this.t * 14) % 2 === 0)) {
      for (const [ox, oy] of wrapOffsets(this.shipX, this.shipY, SHIP_RADIUS)) {
        drawShip(g, this.shipX + ox, this.shipY + oy, this.heading, this.thrusting, "#f4f6ff");
      }
    }

    for (const s of this.sparks) {
      drawBurst(g, s.x, s.y, s.t / s.life, s.scale, "#ffd23c");
    }

    this.drawHud(g, c.text, c.dim);
    this.drawBanners(g, c.text, c.cyan, c.ember);
  }

  private drawHud(g: CanvasRenderingContext2D, ink: string, dim: string): void {
    text(g, "SCORE", 6, 3, dim, 1);
    text(g, `${this.score}`, 6, 11, ink, 1);
    textCentered(g, "HIGH", GAME_W / 2, 3, dim, 1);
    textCentered(g, `${Math.max(this.score, this.host.hiScore())}`, GAME_W / 2, 11, "#ffd23c", 1);
    textRight(g, `WAVE ${this.wave}`, GAME_W - 6, 3, dim, 1);

    for (let i = 0; i < Math.max(0, Math.min(this.lives, 6)); i++) {
      drawShip(g, 10 + i * 12, GAME_H - 10, -Math.PI / 2, false, dim);
    }
  }

  private drawBanners(g: CanvasRenderingContext2D, ink: string, lit: string, warm: string): void {
    const cx = GAME_W / 2;
    if (this.phase === "attract") {
      textCentered(g, "ASTEROIDS", cx, 96, warm, 3);
      textCentered(g, "THE VOID ARCADE", cx, 120, lit, 1);
      if (Math.floor(this.t * 2) % 2 === 0) {
        textCentered(g, "PRESS SPACE TO START", cx, 144, ink, 1);
      }
      textCentered(g, "NO FRICTION, NO BRAKES", cx, 166, "#6d7599", 1);
      textCentered(g, "DOWN FOR HYPERSPACE, IF YOU DARE", cx, 178, "#6d7599", 1);
      return;
    }
    if (this.phase === "ready") {
      textCentered(g, `WAVE ${this.wave}`, cx, 110, lit, 2);
      return;
    }
    if (this.phase === "clear") {
      textCentered(g, "FIELD CLEAR", cx, 110, lit, 1);
      return;
    }
    if (this.phase === "over") {
      textCentered(g, "GAME OVER", cx, 100, warm, 2);
      textCentered(g, `SCORE ${this.score}`, cx, 124, ink, 1);
      textCentered(g, `WAVE ${this.wave}`, cx, 138, "#6d7599", 1);
      if (this.timer < 5 && Math.floor(this.t * 2) % 2 === 0) {
        textCentered(g, "PRESS SPACE", cx, 160, lit, 1);
      }
    }
  }
}

/** The cabinet card. Everything the launcher needs to show and start this. */
export const asteroidsGame: GameDef = {
  id: "asteroids",
  name: "Asteroids",
  year: "1979",
  glyph: "☄",
  blurb: "no friction, no walls, and hyperspace when you've run out of good ideas",
  controls: [
    "← → or A D — rotate (no momentum on the turn)",
    "↑ or W — thrust (no friction — you coast forever)",
    "space — fire, four shots in the air at once",
    "↓ or S — hyperspace, with a real chance it kills you",
  ],
  width: GAME_W,
  height: GAME_H,
  create: (host: GameHost): Game => new Asteroids(host),
};
