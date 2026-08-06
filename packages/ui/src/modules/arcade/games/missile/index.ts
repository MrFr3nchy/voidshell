/**
 * Missile Command — the one you cannot win.
 *
 * There is no last wave. The trajectories get faster and there get to be more
 * of them until all six cities are gone, and then the screen says THE END and
 * means it. Everything below follows from that, and two consequences are worth
 * stating because they are what make the game more than a shooter:
 *
 * **You are not scored on kills, you are scored on what survives.** A warhead
 * shot down is twenty-five points; a city carried through a late wave is six
 * hundred. So the correct play is frequently to let something through on
 * purpose, and deciding *which* thing is the entire game. A version that paid
 * mostly for interceptions would be a much easier game to play well and a
 * completely different one.
 *
 * **An interceptor is not a bullet.** It is a delivery vehicle for a sphere
 * that takes nearly half a second to open and then hangs in the sky for a
 * second more. Every skill here is about putting a hole in the air well before
 * anything needs to be in it, and the payoff is the chain: one well-placed
 * blast catching a MIRV at the moment it splits is worth more than the six
 * shots it would otherwise take.
 *
 * The one honest concession to the cabinet is documented at `pickBattery` in
 * `rules.ts`: the original has a trackball and three buttons, this has four
 * arrows and one, so the nearest battery with stock answers the call.
 *
 * The art is original — see `sprites.ts`, which is explicit about it.
 */

import type { Game, GameDef, GameHost, Pad } from "../../types";
import { burst, tone } from "../../../../kernel/audio";
import { palette } from "../../../../kernel/stage";
import { text, textCentered, textRight } from "../shared/pixel";
import { battery, blast as drawBlast, city as drawCity, crosshair, plane } from "./sprites";
import {
  AMMO_PER_BATTERY,
  BATTERY_X,
  BATTERY_Y,
  BLAST_LIFE,
  blastRadius,
  BONUS_CITY_EVERY,
  CITY_H,
  CITY_W,
  CITY_X,
  CITY_Y,
  CURSOR_SPEED,
  GAME_H,
  GAME_W,
  GROUND_Y,
  inBlast,
  INTERCEPT_SPEED,
  MAX_TICKS,
  multiplier,
  pickBattery,
  PLANE_SPEED,
  SCORE_MISSILE,
  SCORE_PLANE,
  SCORE_SMART,
  SKY_Y,
  SMART_AVOID,
  SMART_SPEED,
  SPLIT_BAND,
  SPLIT_MAX,
  SPLIT_MIN,
  TICK,
  waveBonus,
  waveSpec,
} from "./rules";

type Phase = "attract" | "ready" | "play" | "tally" | "over";

interface Warhead {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Where it entered, so the whole trajectory can be drawn as one line. */
  ox: number;
  oy: number;
  /** Altitude at which it becomes several. Infinity means it never does. */
  splitAt: number;
  smart: boolean;
}

interface Interceptor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ox: number;
  oy: number;
  tx: number;
  ty: number;
}

interface Blast {
  x: number;
  y: number;
  t: number;
}

interface Flyer {
  x: number;
  y: number;
  dir: number;
  cd: number;
  satellite: boolean;
}

interface Pop {
  x: number;
  y: number;
  value: number;
  t: number;
}

export class MissileCommand implements Game {
  private readonly host: GameHost;

  private phase: Phase = "attract";
  private timer = 0;
  private t = 0;

  private wave = 1;
  private score = 0;
  private nextCity = BONUS_CITY_EVERY;

  private cities: boolean[] = [true, true, true, true, true, true];
  private ammo: number[] = [
    AMMO_PER_BATTERY,
    AMMO_PER_BATTERY,
    AMMO_PER_BATTERY,
  ];
  private batteryLive: boolean[] = [true, true, true];

  private warheads: Warhead[] = [];
  private shots: Interceptor[] = [];
  private blasts: Blast[] = [];
  private flyers: Flyer[] = [];
  private pops: Pop[] = [];

  private cursorX = GAME_W / 2;
  private cursorY = 120;

  /** How many are still to enter this wave, and when the next one does. */
  private toSpawn = 0;
  private spawnCd = 0;
  private killed = 0;

  private acc = 0;
  private fireLatch = false;
  private startLatch = false;
  private seed = 0x6d2b79f5;
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

  private enterAttract(): void {
    this.phase = "attract";
    this.timer = 0;
    this.wave = 1;
    this.cities = [true, true, true, true, true, true];
    this.batteryLive = [true, true, true];
    this.ammo = [AMMO_PER_BATTERY, AMMO_PER_BATTERY, AMMO_PER_BATTERY];
    this.warheads = [];
    this.shots = [];
    this.blasts = [];
    this.flyers = [];
    this.pops = [];
    this.toSpawn = 0;
    this.spawnCd = 0.4;
  }

  private startGame(): void {
    this.score = 0;
    this.wave = 1;
    this.nextCity = BONUS_CITY_EVERY;
    this.cities = [true, true, true, true, true, true];
    this.startWave();
  }

  private startWave(): void {
    const spec = waveSpec(this.wave);
    // Batteries are always restocked. Cities are never rebuilt except by the
    // bonus, which is the asymmetry the whole game turns on: ammunition is
    // renewable and the thing you are defending is not.
    this.ammo = [AMMO_PER_BATTERY, AMMO_PER_BATTERY, AMMO_PER_BATTERY];
    this.batteryLive = [true, true, true];
    this.warheads = [];
    this.shots = [];
    this.blasts = [];
    this.flyers = [];
    this.pops = [];
    this.toSpawn = spec.missiles;
    this.spawnCd = 1.2;
    this.killed = 0;
    this.cursorX = GAME_W / 2;
    this.cursorY = 120;
    this.phase = "ready";
    this.timer = 1.8;
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

    for (const p of this.pops) p.t -= TICK;
    this.pops = this.pops.filter((p) => p.t > 0);

    if (this.phase === "attract") {
      this.stepAttract();
      if (this.startLatch) {
        this.startLatch = false;
        this.startGame();
      }
      return;
    }

    if (this.phase === "over") {
      if (this.startLatch && this.timer < 4) {
        this.startLatch = false;
        this.startGame();
      } else if (this.timer <= 0) {
        this.enterAttract();
      }
      this.startLatch = false;
      this.stepBlasts();
      return;
    }

    if (this.phase === "tally") {
      this.stepBlasts();
      if (this.timer <= 0) {
        if (this.cities.some(Boolean)) {
          this.wave++;
          this.startWave();
        } else {
          this.endIt();
        }
      }
      return;
    }

    if (this.phase === "ready") {
      this.moveCursor(pad);
      if (this.timer <= 0) this.phase = "play";
      return;
    }

    this.startLatch = false;

    this.moveCursor(pad);
    this.fire();
    this.stepSpawns();
    this.stepFlyers();
    this.stepWarheads();
    this.stepShots();
    this.stepBlasts();
    this.resolve();

    if (
      this.toSpawn === 0 &&
      this.warheads.length === 0 &&
      this.flyers.length === 0 &&
      this.shots.length === 0 &&
      this.blasts.length === 0
    ) {
      this.finishWave();
    }
  }

  /** The attract loop: an unattended screen taking hits, which is the pitch. */
  private stepAttract(): void {
    this.spawnCd -= TICK;
    if (this.spawnCd <= 0) {
      this.spawnCd = 0.5 + this.rand();
      this.launch(waveSpec(4));
    }
    this.stepWarheads();
    this.stepBlasts();
    for (let i = this.warheads.length - 1; i >= 0; i--) {
      if (this.warheads[i].y >= GROUND_Y) {
        this.blasts.push({ x: this.warheads[i].x, y: GROUND_Y - 2, t: 0 });
        this.warheads.splice(i, 1);
      }
    }
    if (this.warheads.length > 24) this.warheads.length = 24;
  }

  private moveCursor(pad: Pad): void {
    const dx = (pad.down("right") ? 1 : 0) - (pad.down("left") ? 1 : 0);
    const dy = (pad.down("down") ? 1 : 0) - (pad.down("up") ? 1 : 0);
    if (dx !== 0 && dy !== 0) {
      // Normalise the diagonal, or holding two arrows is 41% faster than one
      // and the reticle visibly lurches whenever it crosses a corner.
      const k = Math.SQRT1_2;
      this.cursorX += dx * CURSOR_SPEED * k * TICK;
      this.cursorY += dy * CURSOR_SPEED * k * TICK;
    } else {
      this.cursorX += dx * CURSOR_SPEED * TICK;
      this.cursorY += dy * CURSOR_SPEED * TICK;
    }
    this.cursorX = Math.max(6, Math.min(GAME_W - 6, this.cursorX));
    this.cursorY = Math.max(SKY_Y, Math.min(GROUND_Y - 12, this.cursorY));
  }

  private fire(): void {
    if (!this.fireLatch) return;
    this.fireLatch = false;
    const b = pickBattery(this.cursorX, this.ammo);
    if (b < 0 || !this.batteryLive[b]) {
      this.sfx(() => burst({ freq: 180, q: 4, gain: 0.05, decay: 0.05 }));
      return;
    }
    this.ammo[b]--;
    const ox = BATTERY_X[b];
    const oy = BATTERY_Y - 4;
    const dx = this.cursorX - ox;
    const dy = this.cursorY - oy;
    const len = Math.max(1, Math.hypot(dx, dy));
    this.shots.push({
      x: ox,
      y: oy,
      ox,
      oy,
      vx: (dx / len) * INTERCEPT_SPEED,
      vy: (dy / len) * INTERCEPT_SPEED,
      tx: this.cursorX,
      ty: this.cursorY,
    });
    this.sfx(() =>
      tone({ freq: 220, toFreq: 780, decay: 0.16, wave: "sawtooth", gain: 0.06 })
    );
  }

  /* ------------------------------------------------------------------ */
  /* the attack                                                          */
  /* ------------------------------------------------------------------ */

  /** Somewhere still worth hitting. Cities first, batteries when they run out. */
  private pickTarget(): [number, number] {
    const live: [number, number][] = [];
    for (let i = 0; i < CITY_X.length; i++) {
      if (this.cities[i]) live.push([CITY_X[i], CITY_Y]);
    }
    for (let i = 0; i < BATTERY_X.length; i++) {
      if (this.batteryLive[i]) live.push([BATTERY_X[i], BATTERY_Y]);
    }
    if (live.length === 0) return [GAME_W / 2, GROUND_Y];
    return live[Math.floor(this.rand() * live.length)];
  }

  private launch(spec: ReturnType<typeof waveSpec>): void {
    const ox = 10 + this.rand() * (GAME_W - 20);
    const [tx, ty] = this.pickTarget();
    const dx = tx - ox;
    const dy = ty - SKY_Y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const split =
      this.rand() < spec.splitChance
        ? SPLIT_BAND[0] + this.rand() * (SPLIT_BAND[1] - SPLIT_BAND[0])
        : Infinity;
    this.warheads.push({
      x: ox,
      y: SKY_Y,
      ox,
      oy: SKY_Y,
      vx: (dx / len) * spec.speed,
      vy: (dy / len) * spec.speed,
      splitAt: split,
      smart: false,
    });
  }

  private stepSpawns(): void {
    const spec = waveSpec(this.wave);
    if (this.toSpawn <= 0) return;
    this.spawnCd -= TICK;
    if (this.spawnCd > 0) return;
    // They arrive in small volleys rather than evenly. An even trickle is
    // trivially handled one at a time; the volleys are what force the player
    // to choose which half of the map to cover.
    const volley = 1 + Math.floor(this.rand() * 3);
    for (let i = 0; i < volley && this.toSpawn > 0; i++) {
      this.toSpawn--;
      if (spec.smart > 0 && this.killed > 0 && this.rand() < 0.16) {
        this.launchSmart();
      } else {
        this.launch(spec);
      }
    }
    this.spawnCd = 1.5 + this.rand() * 1.6;

    if (spec.planes > 0 && this.flyers.length < spec.planes && this.rand() < 0.35) {
      const dir = this.rand() < 0.5 ? 1 : -1;
      this.flyers.push({
        x: dir > 0 ? -12 : GAME_W + 12,
        y: 26 + this.rand() * 26,
        dir,
        cd: 1 + this.rand(),
        satellite: this.rand() < 0.45,
      });
    }
  }

  private launchSmart(): void {
    const ox = 20 + this.rand() * (GAME_W - 40);
    const [tx, ty] = this.pickTarget();
    const dx = tx - ox;
    const dy = ty - SKY_Y;
    const len = Math.max(1, Math.hypot(dx, dy));
    this.warheads.push({
      x: ox,
      y: SKY_Y,
      ox,
      oy: SKY_Y,
      vx: (dx / len) * SMART_SPEED,
      vy: (dy / len) * SMART_SPEED,
      splitAt: Infinity,
      smart: true,
    });
  }

  private stepFlyers(): void {
    for (const f of this.flyers) {
      f.x += f.dir * PLANE_SPEED * (f.satellite ? 1.25 : 1) * TICK;
      f.cd -= TICK;
      if (f.cd <= 0) {
        f.cd = 1.4 + this.rand() * 1.4;
        const [tx, ty] = this.pickTarget();
        const dx = tx - f.x;
        const dy = ty - f.y;
        const len = Math.max(1, Math.hypot(dx, dy));
        const spec = waveSpec(this.wave);
        this.warheads.push({
          x: f.x,
          y: f.y,
          ox: f.x,
          oy: f.y,
          vx: (dx / len) * spec.speed,
          vy: (dy / len) * spec.speed,
          splitAt: Infinity,
          smart: false,
        });
      }
    }
    this.flyers = this.flyers.filter((f) => f.x > -20 && f.x < GAME_W + 20);
  }

  private stepWarheads(): void {
    const fresh: Warhead[] = [];
    for (const w of this.warheads) {
      if (w.smart) {
        // Steer around anything already burning. A smart bomb that ignored
        // blasts would simply be a slow warhead; the swerve is the entire
        // reason wave seven feels like a different game.
        let ax = 0;
        let ay = 0;
        for (const b of this.blasts) {
          const r = blastRadius(b.t) + SMART_AVOID;
          const dx = w.x - b.x;
          const dy = w.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < r * r && d2 > 0.01) {
            const d = Math.sqrt(d2);
            ax += (dx / d) * (1 - d / r);
            ay += (dy / d) * (1 - d / r);
          }
        }
        if (ax !== 0 || ay !== 0) {
          const len = Math.max(0.001, Math.hypot(ax, ay));
          w.vx += (ax / len) * 130 * TICK;
          w.vy += (ay / len) * 130 * TICK;
          const s = Math.max(0.001, Math.hypot(w.vx, w.vy));
          w.vx = (w.vx / s) * SMART_SPEED;
          w.vy = (w.vy / s) * SMART_SPEED;
        } else {
          // Nothing in the way: resume the run in.
          const [tx, ty] = [w.x, GROUND_Y];
          const dx = tx - w.x;
          const dy = ty - w.y;
          const len = Math.max(1, Math.hypot(dx, dy));
          w.vx += ((dx / len) * SMART_SPEED - w.vx) * Math.min(1, 1.6 * TICK);
          w.vy += ((dy / len) * SMART_SPEED - w.vy) * Math.min(1, 1.6 * TICK);
        }
      }

      w.x += w.vx * TICK;
      w.y += w.vy * TICK;

      if (w.y >= w.splitAt && Number.isFinite(w.splitAt)) {
        w.splitAt = Infinity;
        const n = SPLIT_MIN + Math.floor(this.rand() * (SPLIT_MAX - SPLIT_MIN + 1));
        const speed = Math.hypot(w.vx, w.vy);
        for (let i = 0; i < n; i++) {
          const [tx, ty] = this.pickTarget();
          const dx = tx - w.x;
          const dy = Math.max(8, ty - w.y);
          const len = Math.max(1, Math.hypot(dx, dy));
          fresh.push({
            x: w.x,
            y: w.y,
            ox: w.x,
            oy: w.y,
            vx: (dx / len) * speed,
            vy: (dy / len) * speed,
            splitAt: Infinity,
            smart: false,
          });
        }
        this.sfx(() => burst({ freq: 900, q: 5, gain: 0.05, decay: 0.06 }));
      }
    }
    for (const f of fresh) this.warheads.push(f);
  }

  private stepShots(): void {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      const before = Math.hypot(s.tx - s.x, s.ty - s.y);
      s.x += s.vx * TICK;
      s.y += s.vy * TICK;
      const after = Math.hypot(s.tx - s.x, s.ty - s.y);
      // Arrived when it stops getting closer, not when it is "near enough" —
      // a distance threshold overshoots at high speed and the blast opens past
      // the point the player aimed at, which is maddening and hard to name.
      if (after <= 3 || after > before) {
        this.blasts.push({ x: s.tx, y: s.ty, t: 0 });
        this.shots.splice(i, 1);
        this.sfx(() => burst({ freq: 340, q: 1.2, gain: 0.08, decay: 0.18 }));
      }
    }
  }

  private stepBlasts(): void {
    for (const b of this.blasts) b.t += TICK;
    this.blasts = this.blasts.filter((b) => b.t < BLAST_LIFE);
  }

  /* ------------------------------------------------------------------ */
  /* contact                                                             */
  /* ------------------------------------------------------------------ */

  private resolve(): void {
    const mult = multiplier(this.wave);

    // Blasts against everything in the air. A kill leaves its own blast, which
    // is what makes chains possible and what makes one good shot at a MIRV
    // worth six bad ones.
    for (const b of this.blasts) {
      const r = blastRadius(b.t);
      if (r <= 0) continue;

      for (let i = this.warheads.length - 1; i >= 0; i--) {
        const w = this.warheads[i];
        if (!inBlast(w.x, w.y, b.x, b.y, r)) continue;
        const value = (w.smart ? SCORE_SMART : SCORE_MISSILE) * mult;
        this.add(value);
        this.killed++;
        this.pops.push({ x: w.x, y: w.y, value, t: 0.7 });
        this.blasts.push({ x: w.x, y: w.y, t: 0 });
        this.warheads.splice(i, 1);
      }

      for (let i = this.flyers.length - 1; i >= 0; i--) {
        const f = this.flyers[i];
        if (!inBlast(f.x, f.y, b.x, b.y, r)) continue;
        const value = SCORE_PLANE * mult;
        this.add(value);
        this.pops.push({ x: f.x, y: f.y, value, t: 0.7 });
        this.blasts.push({ x: f.x, y: f.y, t: 0 });
        this.flyers.splice(i, 1);
      }
    }

    // Warheads reaching the ground.
    for (let i = this.warheads.length - 1; i >= 0; i--) {
      const w = this.warheads[i];
      if (w.y < GROUND_Y) continue;
      this.warheads.splice(i, 1);
      this.blasts.push({ x: w.x, y: GROUND_Y - 2, t: 0 });
      this.groundHit(w.x);
    }
  }

  private groundHit(x: number): void {
    let lost = false;
    for (let i = 0; i < CITY_X.length; i++) {
      if (!this.cities[i]) continue;
      if (Math.abs(CITY_X[i] - x) < CITY_W / 2 + 6) {
        this.cities[i] = false;
        lost = true;
      }
    }
    for (let i = 0; i < BATTERY_X.length; i++) {
      if (!this.batteryLive[i]) continue;
      if (Math.abs(BATTERY_X[i] - x) < 12) {
        this.batteryLive[i] = false;
        this.ammo[i] = 0;
        lost = true;
      }
    }
    this.sfx(() => {
      burst({ freq: lost ? 110 : 200, q: 0.8, gain: 0.12, decay: lost ? 0.6 : 0.25 });
      if (lost) tone({ freq: 220, toFreq: 40, decay: 0.7, wave: "sawtooth", gain: 0.1 });
    });
  }

  private finishWave(): void {
    const left = this.ammo.reduce((a, b) => a + b, 0);
    const saved = this.cities.filter(Boolean).length;
    const bonus = waveBonus(left, saved, this.wave);
    this.add(bonus);
    this.pops.push({ x: GAME_W / 2, y: 96, value: bonus, t: 3 });
    this.phase = "tally";
    this.timer = 3;
    this.sfx(() =>
      tone({ freq: 520, toFreq: 1040, decay: 0.4, wave: "square", gain: 0.08 })
    );
  }

  private endIt(): void {
    this.phase = "over";
    this.timer = 8;
    this.host.submit(this.score);
    this.sfx(() =>
      tone({ freq: 160, toFreq: 40, decay: 1.6, wave: "sawtooth", gain: 0.12 })
    );
  }

  private add(points: number): void {
    this.score += points;
    while (this.score >= this.nextCity) {
      this.nextCity += BONUS_CITY_EVERY;
      const dead = this.cities.indexOf(false);
      if (dead >= 0) {
        this.cities[dead] = true;
        this.sfx(() =>
          tone({ freq: 660, toFreq: 1320, decay: 0.35, wave: "square", gain: 0.09 })
        );
      }
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
    const cities = this.cities.filter(Boolean).length;
    const ammo = this.ammo.reduce((a, b) => a + b, 0);
    const sig = `${this.score}|${this.host.hiScore()}|${this.wave}|${cities}|${ammo}`;
    if (sig === this.lastFacts) return;
    this.lastFacts = sig;
    this.host.facts([
      { label: "score", value: this.score.toLocaleString() },
      { label: "high", value: Math.max(this.score, this.host.hiScore()).toLocaleString() },
      { label: "wave", value: `${this.wave}` },
      { label: "cities", value: `${cities} / 6` },
      { label: "missiles", value: `${ammo}` },
      { label: "bonus", value: `\u00d7${multiplier(this.wave)}` },
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* draw                                                                */
  /* ------------------------------------------------------------------ */

  draw(g: CanvasRenderingContext2D): void {
    const c = palette();

    g.fillStyle = "#05060f";
    g.fillRect(0, 0, GAME_W, GAME_H);

    // The ground. Drawn as a solid band rather than a line so the cities and
    // batteries sit *on* something.
    g.fillStyle = "#2a1f3c";
    g.fillRect(0, GROUND_Y, GAME_W, GAME_H - GROUND_Y);
    g.fillStyle = "#4a3a66";
    g.fillRect(0, GROUND_Y, GAME_W, 1);

    for (let i = 0; i < CITY_X.length; i++) {
      drawCity(g, CITY_X[i] - CITY_W / 2, CITY_Y - CITY_H + 4, this.cities[i]);
    }
    for (let i = 0; i < BATTERY_X.length; i++) {
      battery(g, BATTERY_X[i], BATTERY_Y, this.ammo[i], this.batteryLive[i]);
    }

    // Trajectories. Every warhead draws its whole path from where it entered,
    // which is the game's most important readout: you are not reading the dot,
    // you are reading the line to work out where it is going.
    for (const w of this.warheads) {
      g.strokeStyle = w.smart ? "#c05cff" : "#ff4a5c";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(w.ox) + 0.5, Math.round(w.oy) + 0.5);
      g.lineTo(Math.round(w.x) + 0.5, Math.round(w.y) + 0.5);
      g.stroke();
      g.fillStyle = "#ffe14a";
      g.fillRect(Math.round(w.x) - 1, Math.round(w.y) - 1, 2, 2);
    }

    for (const s of this.shots) {
      g.strokeStyle = "#4fd6e8";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(s.ox) + 0.5, Math.round(s.oy) + 0.5);
      g.lineTo(Math.round(s.x) + 0.5, Math.round(s.y) + 0.5);
      g.stroke();
      g.fillStyle = "#f4f6ff";
      g.fillRect(Math.round(s.x) - 1, Math.round(s.y) - 1, 2, 2);
      // The target cross stays lit while the shot is in the air, so the player
      // can see what is already committed and does not double-spend on it.
      g.fillStyle = "#2f6a78";
      g.fillRect(Math.round(s.tx) - 2, Math.round(s.ty), 5, 1);
      g.fillRect(Math.round(s.tx), Math.round(s.ty) - 2, 1, 5);
    }

    for (const f of this.flyers) plane(g, f.x, f.y, f.dir, f.satellite);
    for (const b of this.blasts) drawBlast(g, b.x, b.y, blastRadius(b.t), b.t);

    for (const p of this.pops) {
      textCentered(g, `${p.value}`, p.x, p.y - 4, "#9fe8ff", 1);
    }

    if (this.phase === "play" || this.phase === "ready") {
      const b = pickBattery(this.cursorX, this.ammo);
      crosshair(g, this.cursorX, this.cursorY, b < 0 ? "#ff4a5c" : "#4fd6e8");
    }

    this.drawHud(g, c.text, c.dim);
    this.drawBanners(g, c.text, c.cyan, c.ember);
  }

  private drawHud(g: CanvasRenderingContext2D, ink: string, dim: string): void {
    text(g, "SCORE", 6, 3, dim, 1);
    text(g, `${this.score}`, 6, 11, ink, 1);
    textCentered(g, `WAVE ${this.wave}`, GAME_W / 2, 3, dim, 1);
    textCentered(g, `\u00d7${multiplier(this.wave)}`, GAME_W / 2, 11, "#ffe14a", 1);
    textRight(g, "HIGH", GAME_W - 6, 3, dim, 1);
    textRight(
      g,
      `${Math.max(this.score, this.host.hiScore())}`,
      GAME_W - 6,
      11,
      "#ffe14a",
      1
    );
  }

  private drawBanners(
    g: CanvasRenderingContext2D,
    ink: string,
    lit: string,
    warm: string
  ): void {
    const cx = GAME_W / 2;
    if (this.phase === "attract") {
      textCentered(g, "MISSILE COMMAND", cx, 62, warm, 3);
      textCentered(g, "THE VOID ARCADE", cx, 88, lit, 1);
      if (Math.floor(this.t * 2) % 2 === 0) {
        textCentered(g, "PRESS SPACE TO START", cx, 116, ink, 1);
      }
      textCentered(g, "ARROWS AIM   SPACE FIRES", cx, 140, "#6d7599", 1);
      textCentered(g, "THE NEAREST BATTERY ANSWERS", cx, 152, "#6d7599", 1);
      textCentered(g, "YOU ARE NOT MEANT TO WIN", cx, 172, lit, 1);
      return;
    }
    if (this.phase === "ready") {
      textCentered(g, `WAVE ${this.wave}`, cx, 92, lit, 2);
      textCentered(g, `BONUS \u00d7${multiplier(this.wave)}`, cx, 116, warm, 1);
      return;
    }
    if (this.phase === "tally") {
      const saved = this.cities.filter(Boolean).length;
      textCentered(g, "WAVE COMPLETE", cx, 76, lit, 1);
      textCentered(g, `CITIES SAVED  ${saved}`, cx, 112, ink, 1);
      return;
    }
    if (this.phase === "over") {
      // The original ends on two enormous slow words and no score, and the
      // silence afterwards is the whole point. The score goes underneath, in
      // small type, where it belongs.
      const grow = Math.min(4, 1 + (8 - this.timer) * 1.2);
      textCentered(g, "THE END", cx, 92, warm, Math.max(1, Math.round(grow)));
      if (this.timer < 5) {
        textCentered(g, `SCORE ${this.score}`, cx, 140, ink, 1);
        textCentered(g, `WAVES SURVIVED ${this.wave - 1}`, cx, 154, "#6d7599", 1);
      }
      if (this.timer < 4 && Math.floor(this.t * 2) % 2 === 0) {
        textCentered(g, "PRESS SPACE", cx, 176, lit, 1);
      }
    }
  }
}

/** The cabinet card. Everything the launcher needs to show and start this. */
export const missileGame: GameDef = {
  id: "missile",
  name: "Missile Command",
  year: "1980",
  glyph: "\u2622",
  blurb: "six cities, thirty missiles, and no wave where it stops",
  controls: [
    "\u2190 \u2191 \u2193 \u2192 or WASD \u2014 aim",
    "space \u2014 fire from the nearest battery with stock",
    "cities are worth far more than kills \u2014 choose what to lose",
  ],
  width: GAME_W,
  height: GAME_H,
  create: (host: GameHost): Game => new MissileCommand(host),
};
