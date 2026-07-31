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
 * - **Momentum is the difficulty.** Air drag is almost nothing, so you steer a
 *   heavy thing rather than drive a light one. Turning against your own
 *   velocity gets a boost so a reversal is a *skid*, not a stop.
 * - **The screen is a cylinder.** Every steering decision, collision test and
 *   draw goes through `wrapDelta`/`wrapX`, or enemies turn away from a player
 *   standing next to them through the seam.
 * - **Eggs are the economy.** Killing something doesn't remove it, it drops an
 *   egg; ignore the egg and it hatches into an enemy *one tier stronger*. A
 *   wave you refuse to clean up gets worse, which is why the game has pacing
 *   without a timer.
 *
 * The art is original — see `sprites.ts`. The mechanics are the 1982 design,
 * which is the part worth recreating.
 */

import type { Game, GameDef, GameHost, Pad } from "../../types";
import { burst, tone } from "../../../../ui/blip";
import { palette, withAlpha } from "../../../../ui/canvasStage";
import { blit, pterodactyl, text, textCentered, wings, EGG, RIDER, WALKER } from "./sprites";
import type { Platform } from "./rules";
import {
  ACC_AIR,
  ACC_GROUND,
  arena,
  DRAG_AIR,
  DRAG_GROUND,
  eggChain,
  EGG_H,
  EGG_HATCH,
  EGG_W,
  EGG_WAIT,
  EGG_WAVE_BONUS,
  EXTRA_LIFE_EVERY,
  FLAP_COOLDOWN,
  FLAP_DV,
  FLAP_VY_CAP,
  GAME_H,
  GAME_W,
  GRAVITY,
  HIT_DX,
  HIT_H,
  HIT_W,
  LAVA_Y,
  MAX_VX_AIR,
  MAX_VX_GROUND,
  PTERO_AFTER,
  PTERO_SCORE,
  resolveJoust,
  SPR_H,
  SPR_W,
  spawnTier,
  SURVIVAL_BONUS,
  TERMINAL_VY,
  TIERS,
  TURN_BOOST,
  waveEnemies,
  waveKind,
  wrapDelta,
  wrapX,
} from "./rules";

/** Legs stop one row above the sprite box; feet collide, the bounding box doesn't. */
const FOOT = SPR_H - 1;

/** The lava troll: how long a grab lasts, and what it costs to break. */
const TROLL_HOLD = 2.4;
const TROLL_FLAPS = 5;

const PLAYER_INK = { A: "#f2d24b", a: "#a8842a", B: "#ffe89a", b: "#c9a642", L: "#ffffff", Y: "#ff9b2f", E: "#241a05" };

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
  think: number;
  wander: number;
  /** Seconds left materialising. Not solid, not dangerous, cannot be hit. */
  spawn: number;
  invuln: number;
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
  flaps: number;
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
  private lives = 3;
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
  private bits: Bit[] = [];

  /** Fixed background, generated once so it doesn't shimmer between frames. */
  private readonly stars: { x: number; y: number; a: number }[] = [];
  private lastFacts = "";
  private t = 0;

  constructor(host: GameHost) {
    this.host = host;
    let seed = 20250731;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 70; i++) {
      this.stars.push({ x: rnd() * GAME_W, y: rnd() * (LAVA_Y - 10), a: 0.12 + rnd() * 0.4 });
    }
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
      wander: 0,
      spawn: player ? 0 : 0.9,
      invuln: 0,
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
      const r = this.makeRider(false, i % 3, 40 + i * 90, 150 - i * 26);
      r.spawn = 0;
      r.vx = i % 2 === 0 ? 40 : -40;
      this.enemies.push(r);
    }
  }

  private startGame(): void {
    this.score = 0;
    this.lives = 3;
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

    const n = waveEnemies(this.wave);
    for (let i = 0; i < n; i++) {
      const p = this.plats[3 + (i % 6)];
      const r = this.makeRider(
        false,
        spawnTier(this.wave, i),
        wrapX(p.x + p.w / 2 - SPR_W / 2 + (i % 2 ? 14 : -14)),
        p.y - SPR_H
      );
      r.spawn = 0.7 + i * 0.22;
      this.enemies.push(r);
    }

    if (kind === "egg") {
      // Nothing to fight — a shower of eggs, and a bonus for taking all of them.
      for (let i = 0; i < 10; i++) {
        this.eggs.push({
          x: wrapX(18 + i * 30),
          y: -20 - i * 16,
          vx: (i % 2 ? 1 : -1) * 12,
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

    this.placePlayer();
    this.sfx(() => {
      tone({ freq: 220, toFreq: 440, decay: 0.14, wave: "square", gain: 0.07 });
      window.setTimeout(() => tone({ freq: 330, toFreq: 660, decay: 0.16, wave: "square", gain: 0.07 }), 130);
    });
  }

  private placePlayer(): void {
    const pad = this.plats[5];
    this.player = this.makeRider(true, 0, pad.x + pad.w / 2 - SPR_W / 2, pad.y - SPR_H);
    this.player.invuln = 1.8;
    this.player.grounded = true;
  }

  /* ------------------------------------------------------------------ */
  /* update                                                              */
  /* ------------------------------------------------------------------ */

  update(dt: number, pad: Pad): void {
    this.t += dt;
    const flap = pad.hit("flap");
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
        if (pad.hit("start") || flap) this.startGame();
        break;

      case "intro":
        this.timer -= dt;
        this.stepEnemies(dt);
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

    this.publishFacts();
  }

  /** Attract-mode birds: no brain, just enough motion to look alive. */
  private drift(r: Rider, dt: number): void {
    r.x = wrapX(r.x + r.vx * dt);
    r.face = r.vx > 0 ? 1 : -1;
    r.y += Math.sin(this.timer * 1.6 + r.x * 0.03) * 8 * dt;
    r.wing = (Math.sin(this.timer * 6 + r.x * 0.1) + 1) / 2;
  }

  private stepPlayer(dt: number, want: number, flap: boolean): void {
    const p = this.player;
    p.invuln = Math.max(0, p.invuln - dt);

    // Held by the troll: the only input that matters is flapping loose.
    if (this.troll?.grabbed) {
      if (flap) {
        this.troll.flaps++;
        this.sfx(() => burst({ freq: 620, q: 2, gain: 0.09, decay: 0.05 }));
        if (this.troll.flaps >= TROLL_FLAPS) {
          p.vy = -150;
          p.y -= 6;
          this.troll = null;
          this.trollCd = 1.6;
          this.sfx(() => tone({ freq: 300, toFreq: 700, decay: 0.18, wave: "square", gain: 0.09 }));
          return;
        }
      }
      p.x = this.troll.x - SPR_W / 2;
      p.y += 26 * dt;
      p.vx = 0;
      p.vy = 0;
      if (p.y + FOOT >= LAVA_Y) this.killPlayer();
      return;
    }

    const grounded = p.grounded;
    this.move(p, dt, want, flap);
    if (flap && !grounded) this.sfx(() => burst({ freq: 300, q: 1.4, gain: 0.05, decay: 0.06 }));

    // Touching down banks the egg chain. That's what makes a chain a decision:
    // staying airborne is worth four times as much and four times as risky.
    if (p.grounded) this.chain = 0;

    if (p.y + FOOT >= LAVA_Y) {
      this.sfx(() => burst({ freq: 120, q: 0.8, gain: 0.16, decay: 0.4 }));
      this.killPlayer();
    }
  }

  private stepEnemies(dt: number): void {
    for (const e of this.enemies) {
      if (e.spawn > 0) {
        e.spawn -= dt;
        continue;
      }
      const t = TIERS[e.tier];
      e.think -= dt;
      if (e.think <= 0) {
        e.think = 0.28 + Math.random() * 0.5;
        e.wander = (Math.random() - 0.5) * (e.tier === 0 ? 140 : 46);
      }

      const chasing = this.phase === "play" && this.player.invuln <= 0;
      const targetX = chasing ? this.player.x + e.wander : e.x + e.wander * 3;
      const dx = wrapDelta(e.x, targetX);
      const want = Math.abs(dx) < 6 ? 0 : Math.sign(dx);

      // Sit above the player and let gravity supply the attack.
      const targetY = chasing ? this.player.y - (8 + e.tier * 7) : 140;
      const lowOverLava = e.y > 182 && !e.grounded;
      const wantsHeight = lowOverLava || e.y > targetY + 4;
      const flap = wantsHeight && e.flapCd <= 0 && Math.random() < (dt * t.vigour) / 0.34;

      this.move(e, dt, want, flap);

      if (e.y + FOOT >= LAVA_Y) {
        this.burstBits(e.x + SPR_W / 2, LAVA_Y - 4, "#ff7a2f", 10);
        e.spawn = 1.2;
        e.y = 40;
        e.x = wrapX(e.x + 60);
        e.vy = 0;
      }
    }
  }

  /** Shared integration. The player and every enemy fly by exactly this. */
  private move(r: Rider, dt: number, want: number, flap: boolean): void {
    const acc = r.grounded ? ACC_GROUND : ACC_AIR;
    if (want !== 0) {
      const against = want * r.vx < 0;
      r.vx += want * acc * (against ? TURN_BOOST : 1) * dt;
      r.face = want > 0 ? 1 : -1;
    } else if (r.grounded) {
      r.vx -= r.vx * DRAG_GROUND * dt;
      if (Math.abs(r.vx) < 4) r.vx = 0;
    } else {
      r.vx -= r.vx * DRAG_AIR * dt;
    }
    const cap = r.grounded ? MAX_VX_GROUND : MAX_VX_AIR;
    r.vx = clamp(r.vx, -cap, cap);

    r.flapCd = Math.max(0, r.flapCd - dt);
    if (flap && r.flapCd <= 0) {
      r.vy = Math.max(FLAP_VY_CAP, r.vy - FLAP_DV);
      r.flapCd = FLAP_COOLDOWN;
      r.wing = 1;
      r.grounded = false;
    }
    r.wing = Math.max(0, r.wing - dt * 3.4);

    r.vy = Math.min(TERMINAL_VY, r.vy + GRAVITY * dt);

    const py = r.y;
    r.x = wrapX(r.x + r.vx * dt);
    r.y += r.vy * dt;

    // The playfield has a ceiling. Without one, a player mashing flap simply
    // leaves the top of the screen and keeps going: invisible, unreachable,
    // and unbeatable, because nothing can get a lance above them. Found by the
    // bot in the verification harness rather than by playing, which is the
    // whole reason that harness runs four simulated minutes.
    if (r.y < 0) {
      r.y = 0;
      if (r.vy < 0) r.vy = 30;
    }

    r.grounded = false;

    for (const p of this.plats) {
      if (!this.overX(r.x + HIT_DX, HIT_W, p)) continue;
      if (r.vy >= 0 && py + FOOT <= p.y + 1 && r.y + FOOT >= p.y) {
        r.y = p.y - FOOT;
        r.vy = 0;
        r.grounded = true;
      } else if (r.vy < 0 && py >= p.y + p.h - 1 && r.y <= p.y + p.h) {
        r.y = p.y + p.h;
        r.vy = 40;
      }
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
            if (e.vy > 70) {
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
        const nx = wrapX(e.x + e.walk * 15 * dt);
        const onLedge = this.plats.some(
          (p) => this.overX(nx, EGG_W, p) && Math.abs(p.y - (e.y + EGG_H)) < 3
        );
        if (onLedge) e.x = nx;
        else e.walk = e.walk === 1 ? -1 : 1;
        if (e.t >= EGG_WAIT) {
          e.state = "carried";
          e.buzz = { x: wrapX(e.x + (Math.random() < 0.5 ? -80 : 80)), y: -18 };
        }
      } else if (e.state === "carried" && e.buzz) {
        const b = e.buzz;
        const dx = wrapDelta(b.x, e.x);
        const dy = e.y - 4 - b.y;
        const d = Math.hypot(dx, dy) || 1;
        b.x = wrapX(b.x + (dx / d) * 130 * dt);
        b.y += (dy / d) * 130 * dt;
        if (d < 6) {
          // Collected by the flock and put back in the fight, one tier up.
          const r = this.makeRider(false, Math.min(2, e.tier + 1), e.x - 6, e.y - 8);
          r.spawn = 0.35;
          r.vy = -60;
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
        this.ptero = { x: this.player.x > GAME_W / 2 ? -24 : GAME_W + 24, y: 40, vx: 0, vy: 0, wing: 0 };
        this.sfx(() => tone({ freq: 900, toFreq: 200, decay: 0.5, wave: "sawtooth", gain: 0.1 }));
      }
      return;
    }
    const p = this.ptero;
    p.wing = (p.wing + dt * 3.2) % 1;
    const dx = wrapDelta(p.x, this.player.x);
    const dy = this.player.y - p.y;
    p.vx += Math.sign(dx) * 70 * dt;
    p.vy += Math.sign(dy) * 58 * dt;
    p.vx = clamp(p.vx, -96, 96);
    p.vy = clamp(p.vy, -70, 70);
    p.x = wrapX(p.x + p.vx * dt);
    p.y = clamp(p.y + p.vy * dt, 8, LAVA_Y - 24);
  }

  private stepTroll(dt: number, flap: boolean): void {
    void flap;
    this.trollCd = Math.max(0, this.trollCd - dt);

    if (this.troll) {
      const t = this.troll;
      t.t += dt;
      if (!t.grabbed) {
        t.y = Math.max(LAVA_Y - 26, t.y - 70 * dt);
        const near =
          Math.abs(wrapDelta(t.x, this.player.x + SPR_W / 2)) < 12 &&
          Math.abs(this.player.y + FOOT - t.y) < 16;
        if (near && this.player.invuln <= 0) {
          t.grabbed = true;
          t.t = 0;
          this.sfx(() => burst({ freq: 150, q: 1, gain: 0.14, decay: 0.22 }));
        } else if (t.t > 1.1) {
          this.troll = null;
          this.trollCd = 1.6;
        }
      } else if (t.t > TROLL_HOLD) {
        this.killPlayer();
        this.troll = null;
      }
      return;
    }

    // Only reaches for a player who is flying low over open lava — and not
    // one who has just fought their way out of the last grab. Five flaps
    // earned that escape; being seized again on the next frame takes it back.
    if (this.phase !== "play" || this.player.invuln > 0 || this.trollCd > 0) return;
    const feet = this.player.y + FOOT;
    if (feet < 176 || feet > LAVA_Y) return;
    const overFloor = this.plats.some((p) => p.y === 210 && this.overX(this.player.x + HIT_DX, HIT_W, p));
    if (overFloor) return;
    if (Math.random() > dt * 1.1) return;
    this.troll = { x: this.player.x + SPR_W / 2, y: LAVA_Y + 4, t: 0, grabbed: false, flaps: 0 };
  }

  /* ------------------------------------------------------------------ */
  /* collisions and outcomes                                             */
  /* ------------------------------------------------------------------ */

  private collide(): void {
    const p = this.player;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.spawn > 0) continue;

      // enemy vs enemy: they bump, they don't kill each other.
      for (let j = i - 1; j >= 0; j--) {
        const o = this.enemies[j];
        if (o.spawn > 0 || !this.touching(e, o)) continue;
        const push = Math.sign(wrapDelta(o.x, e.x)) || 1;
        e.vx = push * 50;
        o.vx = -push * 50;
      }

      if (p.invuln > 0 || !this.touching(e, p)) continue;

      const out = resolveJoust(p.y, e.y);
      if (out === "draw") {
        const push = Math.sign(wrapDelta(e.x, p.x)) || 1;
        p.vx = push * 74;
        e.vx = -push * 74;
        p.vy = -46;
        e.vy = -46;
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
      if (Math.abs(dx) < 16 && Math.abs(t.y + 7 - (p.y + 4)) < 12 && p.invuln <= 0) {
        // The beak, and only the beak, and only to a lance carried level and
        // driven into it. Fleeing fast used to count as "closing" here, which
        // made the pterodactyl killable by running away from it.
        const level = Math.abs(p.y + 2 - (t.y + 6)) <= 4;
        const closing = Math.abs(p.vx) > 25 && Math.sign(p.vx) === -Math.sign(dx || 1);
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
      vy: -40,
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
      const s = 20 + Math.random() * 70;
      this.bits.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 20,
        life: 0.4 + Math.random() * 0.4,
        max: 0.8,
        color,
      });
    }
  }

  /** Scores drift up from where they were earned. Cheap, and it reads instantly. */
  private floatText(x: number, y: number, value: number): void {
    this.bits.push({
      x,
      y,
      vx: 0,
      vy: -26,
      life: 0.9,
      max: -value,
      color: "#ffe89a",
    });
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

    g.fillStyle = "#080a16";
    g.fillRect(0, 0, GAME_W, GAME_H);
    for (const s of this.stars) {
      g.fillStyle = withAlpha(c.cyan, s.a * (0.6 + 0.4 * Math.sin(this.t * 1.4 + s.x)));
      g.fillRect(s.x | 0, s.y | 0, 1, 1);
    }

    this.drawLava(g);
    for (const p of this.plats) this.drawPlatform(g, p, c.cyan, c.magenta);

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
    g.fillStyle = "#ffd08a";
    for (let x = 0; x < GAME_W; x += 2) {
      const crest = Math.sin(x * 0.11 + this.t * 2.2) + Math.sin(x * 0.05 - this.t * 1.3);
      g.fillRect(x, LAVA_Y - 1 + Math.round(crest * 0.8), 2, 1);
    }
  }

  private drawPlatform(
    g: CanvasRenderingContext2D,
    p: Platform,
    lit: string,
    edge: string
  ): void {
    g.fillStyle = "#242a44";
    g.fillRect(p.x, p.y, p.w, p.h);
    g.fillStyle = "#161a2e";
    g.fillRect(p.x, p.y + p.h - 2, p.w, 2);
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
    if (r.player && r.invuln > 0 && Math.floor(r.invuln * 12) % 2 === 0) return;

    const ink = tier
      ? { A: "#cfd6e8", a: "#7b8399", B: tier.color, b: tier.shade, L: "#e8ecff", Y: "#e0a33a", E: "#101425" }
      : PLAYER_INK;
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
        blit(g, WALKER, px, e.y - 1, { A: "#cfd6e8", a: "#7b8399" }, e.walk < 0)
      );
    } else {
      const wobble =
        e.state === "rest" && e.t > EGG_HATCH - 2 ? Math.sin(e.t * 26) * 1 : 0;
      this.wrapDraw(e.x, EGG_W, (px) =>
        blit(g, EGG, px + wobble, e.y, { B: "#e8e2c8", b: "#a89f7c" })
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
    g.fillStyle = "#c4552f";
    g.fillRect(t.x - 5, t.y, 10, GAME_H - t.y);
    g.fillStyle = "#e8794a";
    for (let i = -2; i <= 2; i++) {
      if (i === 0) continue;
      g.fillRect(t.x + i * 3 - 1, t.y - 6 + Math.abs(i), 2, 8);
    }
    if (t.grabbed) {
      const left = TROLL_FLAPS - t.flaps;
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
      textCentered(g, "JOUST", cx, 66, warm, 4);
      textCentered(g, "THE VOID ARCADE", cx, 92, lit, 1);
      const blink = Math.floor(this.timer * 2) % 2 === 0;
      if (blink) textCentered(g, "PRESS SPACE TO FLAP", cx, 128, ink, 1);
      textCentered(g, "ARROWS STEER  SPACE FLAPS", cx, 150, "#6d7599", 1);
      textCentered(g, "THE HIGHER LANCE WINS", cx, 162, "#6d7599", 1);
      textCentered(g, `HIGH SCORE ${this.host.hiScore()}`, cx, 186, lit, 1);
      return;
    }
    if (this.phase === "intro") {
      textCentered(g, this.banner, cx, 96, ink, 3);
      if (this.subBanner) textCentered(g, this.subBanner, cx, 122, warm, 1);
      return;
    }
    if (this.phase === "clear") {
      textCentered(g, this.banner, cx, 96, lit, 2);
      if (this.subBanner) textCentered(g, this.subBanner, cx, 118, warm, 2);
      return;
    }
    if (this.phase === "over") {
      textCentered(g, this.banner, cx, 96, warm, 3);
      textCentered(g, `SCORE ${this.score}`, cx, 124, ink, 1);
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
