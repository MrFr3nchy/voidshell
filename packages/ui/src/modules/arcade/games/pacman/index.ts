/**
 * Pac-Man — a maze, 244 things to eat, and four monsters that are not the same
 * as each other.
 *
 * The whole game is downstream of one design decision: the ghosts are
 * deterministic. Nothing here rolls dice to decide where a monster goes, so
 * every death is explicable and every board is learnable, which is why people
 * were still finding new patterns in this a decade after it shipped. The
 * targeting rules and the tables live in `rules.ts` with the reasoning
 * attached; this file is the part that needs a canvas.
 *
 * The things that were easy to get subtly wrong, and what they cost:
 *
 * - **Direction preference at a tie is up, left, down, right.** Ghosts choose
 *   by straight-line distance and a great many of those comparisons come out
 *   exactly equal. The tiebreak is where the memorisable patterns come from;
 *   scrambling it leaves four ghosts that behave plausibly and produce no
 *   patterns at all.
 * - **Ghosts reverse on a mode change and at no other time.** That reversal is
 *   the player's only warning that scatter is over, and the reason a corner
 *   that was safe two seconds ago is not.
 * - **Frightened is a state of the ghost, not of the game.** A ghost released
 *   from the house during an energizer is not frightened, and a player who
 *   assumes otherwise walks into it.
 * - **Eating costs frames.** One frame per pellet, three per energizer. It is
 *   the whole reason a 75%-speed ghost can run down an 80%-speed Pac-Man.
 * - **Blinky stops scattering once he is angry.** Above the Elroy threshold he
 *   chases through what should be a rest phase, and the board's last thirty
 *   pellets stop being safe.
 *
 * The art is original — see `sprites.ts`, which is explicit about what is and
 * is not reproduced.
 */

import type { Game, GameDef, GameHost, Pad } from "../../types";
import { burst, tone } from "../../../../kernel/audio";
import { palette } from "../../../../kernel/stage";
import { text, textCentered, textRight } from "../shared/pixel";
import {
  fruit as drawFruit,
  ghost as drawGhost,
  ghostScared,
  pac as drawPac,
} from "./sprites";
import type { GhostName, Mode } from "./rules";
import {
  blinkyTarget,
  chooseDir,
  clydeTarget,
  COLS,
  DIRS,
  DOWN,
  ENERGIZER_SCORE,
  ENERGIZER_STALL,
  EAT_STALL,
  EXTRA_LIFE_AT,
  FRUIT_AT,
  FRUIT_LIFETIME,
  FRUIT_X,
  FRUIT_Y,
  FULL_SPEED,
  fruitFor,
  GAME_H,
  GAME_W,
  ghostScore,
  ghostWalkable,
  GHOST_COLOR,
  GHOSTS,
  globalHouseDots,
  HOUSE_EXIT_Y,
  HOUSE_LEFT_X,
  HOUSE_RIGHT_X,
  HOUSE_X,
  HOUSE_Y,
  houseDots,
  houseTimeout,
  inkyTarget,
  inTunnel,
  LEFT,
  levelSpec,
  MAX_TICKS,
  MAZE,
  modeAt,
  noUpTile,
  opposite,
  PAC_START_X,
  PAC_START_Y,
  PELLET_SCORE,
  PELLET_TOTAL,
  pinkyTarget,
  RIGHT,
  ROWS,
  SCATTER_TARGET,
  TICK,
  TILE,
  TOP,
  UP,
  walkable,
  wrapCol,
} from "./rules";

type Phase = "attract" | "ready" | "play" | "dying" | "clear" | "over";

/** Where a ghost is in its relationship with the house. */
type Home = "in" | "leaving" | "out" | "returning" | "entering";

interface Ghost {
  name: GhostName;
  /** Centre of the sprite, in maze-local pixels. */
  x: number;
  y: number;
  dir: number;
  home: Home;
  /** Which way it is drifting while parked inside the house. */
  bob: number;
  /** Personal pellet counter, used until the first death. */
  dots: number;
  fright: boolean;
  /** Eaten: the sheet is gone and a pair of eyes is going home. */
  eaten: boolean;
}

interface Pop {
  x: number;
  y: number;
  value: number;
  t: number;
}

const EPS = 1e-6;
/** Eyes go home much faster than anything walks. */
const EYE_SPEED = FULL_SPEED * 2.2;
/** How long the board holds still to show you what a ghost was worth. */
const EAT_FREEZE = 0.55;

const MAZE_BLUE = "#2438d8";
const MAZE_EDGE = "#4a63ff";
const PAC_YELLOW = "#ffe14a";
const DOOR_PINK = "#ffb2df";

export class PacMan implements Game {
  private readonly host: GameHost;

  private phase: Phase = "attract";
  private timer = 0;
  private t = 0;

  private level = 1;
  private score = 0;
  private lives = 3;
  private nextLife = EXTRA_LIFE_AT;

  /** One flag per maze tile. Cheaper and clearer than mutating the level. */
  private eaten: boolean[] = [];
  private remaining = PELLET_TOTAL;
  private dotsEaten = 0;

  private pacX = PAC_START_X;
  private pacY = PAC_START_Y;
  private pacDir = LEFT;
  private pacWant = LEFT;
  /** Frames owed for eating. Pac-Man stands still while paying them. */
  private stall = 0;
  private mouth = 0;

  private ghosts: Ghost[] = [];

  private mode: Mode = "scatter";
  private modeElapsed = 0;
  private frightTimer = 0;
  private frightChain = 0;

  /**
   * Null until the first death, then a shared counter with different
   * thresholds. The original switches over so that dying cannot be used to
   * reset the pressure the house is under.
   */
  private globalDots: number | null = null;
  private houseIdle = 0;

  private fruitTimer = 0;
  private fruitsShown = 0;

  private pops: Pop[] = [];
  private freeze = 0;
  private wakaFlip = false;

  private acc = 0;
  private startLatch = false;
  private seed = 0x2545f491;
  private lastFacts = "";

  constructor(host: GameHost) {
    this.host = host;
    this.enterAttract();
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /** Deterministic noise. Frightened ghosts wander; the sim stays replayable. */
  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }

  private freshBoard(): void {
    this.eaten = new Array(COLS * ROWS).fill(false);
    this.remaining = PELLET_TOTAL;
    this.dotsEaten = 0;
    this.fruitTimer = 0;
    this.fruitsShown = 0;
  }

  private makeGhost(name: GhostName): Ghost {
    const slot =
      name === "inky" ? HOUSE_LEFT_X : name === "clyde" ? HOUSE_RIGHT_X : HOUSE_X;
    return {
      name,
      x: slot,
      y: name === "blinky" ? HOUSE_EXIT_Y : HOUSE_Y,
      // Blinky starts outside and heading left, which is why he is on top of
      // you before you have finished reading "READY!".
      dir: name === "blinky" ? LEFT : UP,
      home: name === "blinky" ? "out" : "in",
      bob: name === "pinky" ? -1 : 1,
      dots: 0,
      fright: false,
      eaten: false,
    };
  }

  private placeAll(): void {
    this.pacX = PAC_START_X;
    this.pacY = PAC_START_Y;
    this.pacDir = LEFT;
    this.pacWant = LEFT;
    this.stall = 0;
    this.ghosts = GHOSTS.map((n) => this.makeGhost(n));
    this.mode = "scatter";
    this.modeElapsed = 0;
    this.frightTimer = 0;
    this.frightChain = 0;
    this.houseIdle = 0;
    this.freeze = 0;
    this.pops = [];
  }

  private enterAttract(): void {
    this.phase = "attract";
    this.timer = 0;
    this.level = 1;
    this.freshBoard();
    this.placeAll();
    // Let all four out, so the title screen shows the maze being patrolled
    // rather than sitting still. An idle cabinet should look alive.
    for (const g of this.ghosts) {
      g.home = "out";
      g.y = HOUSE_EXIT_Y;
    }
  }

  private startGame(): void {
    this.score = 0;
    this.lives = 3;
    this.level = 1;
    this.nextLife = EXTRA_LIFE_AT;
    this.globalDots = null;
    this.freshBoard();
    this.placeAll();
    this.phase = "ready";
    this.timer = 2.2;
  }

  private nextLevel(): void {
    this.level++;
    this.freshBoard();
    this.placeAll();
    this.phase = "ready";
    this.timer = 1.6;
  }

  /* ------------------------------------------------------------------ */
  /* the clock                                                           */
  /* ------------------------------------------------------------------ */

  update(dt: number, pad: Pad): void {
    if (pad.hit("start")) this.startLatch = true;
    this.readStick(pad);

    this.acc += dt;
    let ticks = 0;
    while (this.acc >= TICK && ticks < MAX_TICKS) {
      this.acc -= TICK;
      ticks++;
      this.tick();
    }
    // A long stall — a dragged panel, a background tab — leaves a backlog that
    // is not worth catching up on. Simulating it would teleport everything.
    if (ticks >= MAX_TICKS) this.acc = 0;

    this.publishFacts();
  }

  /**
   * Turn the stick into one desired direction.
   *
   * Edges are latched rather than sampled, because the cabinet clears its edge
   * set once per *frame* and the simulation ticks on its own clock — on a
   * 120Hz panel, reading `hit` inside the tick would drop half the presses.
   * The fallback to any still-held key is what makes rolling from one arrow to
   * the next feel continuous instead of dropping the input on release.
   */
  private readStick(pad: Pad): void {
    const keys = ["up", "left", "down", "right"] as const;
    for (let d = 0; d < 4; d++) {
      if (pad.hit(keys[d])) this.pacWant = d;
    }
    if (!pad.down(keys[this.pacWant])) {
      for (let d = 0; d < 4; d++) {
        if (pad.down(keys[d])) {
          this.pacWant = d;
          break;
        }
      }
    }
  }

  private tick(): void {
    this.t += TICK;
    this.timer = Math.max(0, this.timer - TICK);

    for (const p of this.pops) p.t -= TICK;
    this.pops = this.pops.filter((p) => p.t > 0);

    switch (this.phase) {
      case "attract":
        this.stepGhosts(true);
        if (this.startLatch) {
          this.startLatch = false;
          this.startGame();
        }
        return;
      case "ready":
        if (this.timer <= 0) this.phase = "play";
        return;
      case "dying":
        if (this.timer <= 0) this.afterDeath();
        return;
      case "clear":
        if (this.timer <= 0) this.nextLevel();
        return;
      case "over":
        if (this.startLatch) {
          this.startLatch = false;
          this.startGame();
        } else if (this.timer <= 0) {
          this.enterAttract();
        }
        return;
      case "play":
        break;
    }

    this.startLatch = false;

    if (this.freeze > 0) {
      this.freeze -= TICK;
      return;
    }

    this.stepMode();
    this.stepPac();
    this.stepGhosts(false);
    this.collide();

    if (this.fruitTimer > 0) this.fruitTimer -= TICK;

    if (this.remaining <= 0) {
      this.phase = "clear";
      this.timer = 2.4;
      this.sfx(() => tone({ freq: 660, toFreq: 1320, decay: 0.5, wave: "square", gain: 0.09 }));
    }
  }

  /* ------------------------------------------------------------------ */
  /* scatter, chase and the energizer                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Advance the mode clock and flip when the table says to.
   *
   * Frightened time does not advance it — the schedule is suspended for the
   * duration of an energizer and resumes where it left off, which is why
   * eating an energizer late in a scatter phase does not cost you the phase.
   */
  private stepMode(): void {
    if (this.frightTimer > 0) {
      this.frightTimer -= TICK;
      if (this.frightTimer <= 0) {
        this.frightTimer = 0;
        this.frightChain = 0;
        for (const g of this.ghosts) g.fright = false;
      }
      return;
    }

    const before = this.mode;
    this.modeElapsed += TICK;
    this.mode = modeAt(this.level, this.modeElapsed);
    if (this.mode !== before) {
      // The reversal is instant and mid-corridor, exactly as the original
      // does it. It is the only signal the player gets that the rules just
      // changed under them.
      for (const g of this.ghosts) {
        if (g.home === "out" && !g.eaten) g.dir = opposite(g.dir);
      }
    }
  }

  private energize(): void {
    const s = levelSpec(this.level);
    if (s.fright <= 0) {
      // From level 17 the energizer is worth fifty points and nothing else.
      // The ghosts do not even turn around.
      return;
    }
    this.frightTimer = s.fright;
    this.frightChain = 0;
    for (const g of this.ghosts) {
      if (g.eaten) continue;
      g.fright = true;
      if (g.home === "out") g.dir = opposite(g.dir);
    }
  }

  /* ------------------------------------------------------------------ */
  /* movement                                                            */
  /* ------------------------------------------------------------------ */

  private passable(cx: number, cy: number, ghost: boolean): boolean {
    return ghost ? ghostWalkable(cx, cy) : walkable(cx, cy);
  }

  /**
   * Move something along the grid, stopping at walls and making its turning
   * decisions at tile centres.
   *
   * Written as a loop over centre crossings rather than as a position update
   * plus a proximity test, because the proximity version has a failure that
   * only shows up at high speed and looks like a physics bug: an entity moving
   * more than the snap tolerance in one step slides past the junction it meant
   * to turn at. Landing exactly on each centre in turn makes that impossible
   * regardless of speed, which matters here — eyes go home at more than twice
   * walking pace.
   */
  private advance(
    e: { x: number; y: number; dir: number },
    dist: number,
    ghost: boolean,
    decide: (cx: number, cy: number) => void
  ): void {
    let left = dist;
    let guard = 0;
    while (left > EPS && guard++ < 64) {
      const cx = wrapCol(Math.floor(e.x / TILE));
      const cy = Math.floor(e.y / TILE);
      const ccx = cx * TILE + TILE / 2;
      const ccy = cy * TILE + TILE / 2;

      // Decisions and wall tests both happen here, on the centre, and nowhere
      // else. Testing the wall at the point of *departure* rather than at the
      // point of arrival is what makes it impossible to enter one: an entity
      // resting against a wall re-runs this every tick, so it turns the
      // instant a turn becomes legal and steps forward on no other condition.
      if (Math.abs(e.x - ccx) < EPS && Math.abs(e.y - ccy) < EPS) {
        decide(cx, cy);
        const [ndx, ndy] = DIRS[e.dir];
        if (!this.passable(wrapCol(cx + ndx), cy + ndy, ghost)) break;
      }

      const [dx, dy] = DIRS[e.dir];
      let toNext = dx !== 0 ? (ccx - e.x) * dx : (ccy - e.y) * dy;
      let tcx = cx;
      let tcy = cy;
      if (toNext <= EPS) {
        // Level with, or already past, this tile's centre — so the next
        // decision point is the centre of the tile ahead. That tile was
        // cleared as passable on the way out of the last one.
        toNext += TILE;
        tcx = wrapCol(cx + dx);
        tcy = cy + dy;
      }
      if (toNext > left) {
        e.x += dx * left;
        e.y += dy * left;
        break;
      }
      e.x += dx * toNext;
      e.y += dy * toNext;
      left -= toNext;
      // Land exactly, so no rounding error accumulates over a whole board.
      e.x = tcx * TILE + TILE / 2;
      e.y = tcy * TILE + TILE / 2;
    }
    if (e.x < 0) e.x += GAME_W;
    if (e.x >= GAME_W) e.x -= GAME_W;
  }

  private pacSpeed(): number {
    const s = levelSpec(this.level);
    return FULL_SPEED * (this.frightTimer > 0 ? s.pacFright : s.pac);
  }

  private stepPac(): void {
    if (this.stall > 0) {
      this.stall--;
      return;
    }

    // A reversal never needs a junction: the tile behind you is one you just
    // came from, so it is always open. Everything else waits for a centre.
    if (this.pacWant === opposite(this.pacDir)) this.pacDir = this.pacWant;

    const before = { x: this.pacX, y: this.pacY };
    const self = { x: this.pacX, y: this.pacY, dir: this.pacDir };
    this.advance(self, this.pacSpeed() * TICK, false, (cx, cy) => {
      if (self.dir === this.pacWant) return;
      const [dx, dy] = DIRS[this.pacWant];
      if (walkable(wrapCol(cx + dx), cy + dy)) self.dir = this.pacWant;
    });
    this.pacX = self.x;
    this.pacY = self.y;
    this.pacDir = self.dir;

    // The mouth only animates while he is actually moving. A Pac-Man chomping
    // away while pressed into a wall is one of those small wrongnesses nobody
    // names and everybody notices.
    if (Math.abs(self.x - before.x) > EPS || Math.abs(self.y - before.y) > EPS) {
      this.mouth += TICK * 9;
    }

    this.eatHere();
  }

  private eatHere(): void {
    const cx = wrapCol(Math.floor(this.pacX / TILE));
    const cy = Math.floor(this.pacY / TILE);
    if (cy < 0 || cy >= ROWS) return;
    const i = cy * COLS + cx;
    if (this.eaten[i]) return;
    const t = MAZE[cy][cx];
    if (t !== "." && t !== "o") return;

    this.eaten[i] = true;
    this.remaining--;
    this.dotsEaten++;
    this.houseIdle = 0;
    this.countDot();

    if (t === "o") {
      this.stall = ENERGIZER_STALL;
      this.add(ENERGIZER_SCORE);
      this.energize();
      this.sfx(() => tone({ freq: 180, toFreq: 70, decay: 0.28, wave: "square", gain: 0.1 }));
    } else {
      this.stall = EAT_STALL;
      this.add(PELLET_SCORE);
      this.wakaFlip = !this.wakaFlip;
      this.sfx(() =>
        tone({
          freq: this.wakaFlip ? 320 : 240,
          toFreq: this.wakaFlip ? 240 : 320,
          decay: 0.05,
          wave: "square",
          gain: 0.05,
        })
      );
    }

    if (FRUIT_AT.includes(this.dotsEaten) && this.fruitsShown < FRUIT_AT.length) {
      this.fruitsShown++;
      this.fruitTimer = FRUIT_LIFETIME;
    }
  }

  /**
   * Credit a pellet to whoever is waiting to leave.
   *
   * Only one counter advances per pellet — the front of the queue — which is
   * why the ghosts leave in order rather than in a clump, and why level one's
   * Clyde is still sitting in the house when you are half done.
   */
  private countDot(): void {
    if (this.globalDots !== null) {
      this.globalDots++;
      return;
    }
    for (const name of GHOSTS) {
      const g = this.ghosts.find((x) => x.name === name);
      if (g && g.home === "in") {
        g.dots++;
        return;
      }
    }
  }

  private releaseCheck(): void {
    this.houseIdle += TICK;
    const timeout = this.houseIdle >= houseTimeout(this.level);
    for (const name of GHOSTS) {
      const g = this.ghosts.find((x) => x.name === name);
      if (!g || g.home !== "in") continue;
      const limit =
        this.globalDots !== null ? globalHouseDots(name) : houseDots(this.level, name);
      const count = this.globalDots !== null ? this.globalDots : g.dots;
      if (count >= limit || timeout) {
        g.home = "leaving";
        if (timeout) this.houseIdle = 0;
      }
      // One at a time, in order: whoever is at the front of the queue blocks
      // everyone behind them even if their own counter is already satisfied.
      return;
    }
  }

  private ghostSpeed(g: Ghost): number {
    const s = levelSpec(this.level);
    if (g.eaten) return EYE_SPEED;
    const cx = wrapCol(Math.floor(g.x / TILE));
    const cy = Math.floor(g.y / TILE);
    if (inTunnel(cx, cy)) return FULL_SPEED * s.ghostTunnel;
    if (g.fright) return FULL_SPEED * s.ghostFright;
    if (g.name === "blinky") {
      if (this.remaining <= s.elroy2) return FULL_SPEED * s.elroy2Speed;
      if (this.remaining <= s.elroy1) return FULL_SPEED * s.elroy1Speed;
    }
    return FULL_SPEED * s.ghost;
  }

  private pacTile(): [number, number] {
    return [wrapCol(Math.floor(this.pacX / TILE)), Math.floor(this.pacY / TILE)];
  }

  private targetFor(g: Ghost): [number, number] {
    if (g.eaten) return [14, 11];
    const [px, py] = this.pacTile();

    // Blinky above his Elroy threshold ignores scatter entirely. It is the
    // reason the back end of a board tightens up rather than giving you the
    // rest the schedule says you should get.
    const angry =
      g.name === "blinky" && this.remaining <= levelSpec(this.level).elroy1;
    if (this.mode === "scatter" && !angry) {
      const s = SCATTER_TARGET[g.name];
      return [s[0], s[1]];
    }

    switch (g.name) {
      case "blinky":
        return blinkyTarget(px, py);
      case "pinky":
        return pinkyTarget(px, py, this.pacDir);
      case "inky": {
        const b = this.ghosts.find((x) => x.name === "blinky");
        const bx = b ? wrapCol(Math.floor(b.x / TILE)) : px;
        const by = b ? Math.floor(b.y / TILE) : py;
        return inkyTarget(px, py, this.pacDir, bx, by);
      }
      default:
        return clydeTarget(
          px,
          py,
          wrapCol(Math.floor(g.x / TILE)),
          Math.floor(g.y / TILE)
        );
    }
  }

  private stepGhosts(attract: boolean): void {
    if (!attract) this.releaseCheck();

    for (const g of this.ghosts) {
      if (g.home === "in") {
        // Parked: bob between the top and bottom of the house so the queue
        // reads as waiting rather than as four sprites sitting on each other.
        g.y += g.bob * 14 * TICK;
        if (g.y < HOUSE_Y - 4) {
          g.y = HOUSE_Y - 4;
          g.bob = 1;
        } else if (g.y > HOUSE_Y + 4) {
          g.y = HOUSE_Y + 4;
          g.bob = -1;
        }
        g.dir = g.bob < 0 ? UP : DOWN;
        continue;
      }

      if (g.home === "leaving") {
        // Slide to the door, then rise through it. Scripted rather than
        // pathfound, because the house is the one place the tile rules do not
        // apply — the door is solid to everything except this.
        const speed = FULL_SPEED * 0.5 * TICK;
        if (Math.abs(g.x - HOUSE_X) > speed) {
          g.x += Math.sign(HOUSE_X - g.x) * speed;
          g.dir = HOUSE_X > g.x ? RIGHT : LEFT;
        } else {
          g.x = HOUSE_X;
          g.y -= speed;
          g.dir = UP;
          if (g.y <= HOUSE_EXIT_Y) {
            g.y = HOUSE_EXIT_Y;
            g.home = "out";
            g.dir = LEFT;
          }
        }
        continue;
      }

      if (g.home === "entering") {
        const speed = FULL_SPEED * 0.8 * TICK;
        const slot =
          g.name === "inky" ? HOUSE_LEFT_X : g.name === "clyde" ? HOUSE_RIGHT_X : HOUSE_X;
        if (g.y < HOUSE_Y) {
          g.y = Math.min(HOUSE_Y, g.y + speed);
          g.dir = DOWN;
        } else if (Math.abs(g.x - slot) > speed) {
          g.x += Math.sign(slot - g.x) * speed;
        } else {
          g.x = slot;
          g.eaten = false;
          g.fright = false;
          // Straight back into the queue. A revived ghost that had to wait for
          // a pellet counter would leave the board empty after a big chain.
          g.home = "leaving";
        }
        continue;
      }

      if (g.home === "returning") {
        // The eyes navigate the maze normally until they are over the door.
        this.advance(g, this.ghostSpeed(g) * TICK, true, (cx, cy) => {
          this.ghostDecide(g, cx, cy);
        });
        if (Math.abs(g.x - HOUSE_X) < 2 && Math.abs(g.y - HOUSE_EXIT_Y) < 2) {
          g.x = HOUSE_X;
          g.y = HOUSE_EXIT_Y;
          g.home = "entering";
        }
        continue;
      }

      this.advance(g, this.ghostSpeed(g) * TICK, true, (cx, cy) => {
        this.ghostDecide(g, cx, cy);
      });
    }
  }

  private ghostDecide(g: Ghost, cx: number, cy: number): void {
    if (g.fright && !g.eaten) {
      // Frightened ghosts do not aim. They take a legal turn at random, which
      // is why a cornered player can still be caught by bad luck and why the
      // chase never quite becomes a formality.
      const opts: number[] = [];
      for (let d = 0; d < 4; d++) {
        if (d === opposite(g.dir)) continue;
        if (d === UP && noUpTile(cx, cy)) continue;
        const [dx, dy] = DIRS[d];
        if (ghostWalkable(wrapCol(cx + dx), cy + dy)) opts.push(d);
      }
      if (opts.length > 0) g.dir = opts[Math.floor(this.rand() * opts.length)];
      return;
    }
    const [tx, ty] = this.targetFor(g);
    g.dir = chooseDir(cx, cy, g.dir, tx, ty, { obeyNoUp: !g.eaten });
  }

  /* ------------------------------------------------------------------ */
  /* contact                                                             */
  /* ------------------------------------------------------------------ */

  private collide(): void {
    // The prize, if one is out.
    if (this.fruitTimer > 0) {
      const dx = this.pacX - FRUIT_X;
      const dy = this.pacY - FRUIT_Y;
      if (dx * dx + dy * dy < 64) {
        const f = fruitFor(this.level);
        this.fruitTimer = 0;
        this.add(f.score);
        this.pops.push({ x: FRUIT_X, y: FRUIT_Y, value: f.score, t: 1.2 });
        this.sfx(() => tone({ freq: 520, toFreq: 900, decay: 0.2, wave: "triangle", gain: 0.09 }));
      }
    }

    for (const g of this.ghosts) {
      if (g.eaten || g.home === "in" || g.home === "entering") continue;
      const dx = this.pacX - g.x;
      const dy = this.pacY - g.y;
      if (dx * dx + dy * dy > 49) continue;

      if (g.fright) {
        const value = ghostScore(this.frightChain);
        this.frightChain++;
        this.add(value);
        g.eaten = true;
        g.fright = false;
        g.home = "returning";
        this.pops.push({ x: g.x, y: g.y, value, t: EAT_FREEZE + 0.35 });
        this.freeze = EAT_FREEZE;
        this.sfx(() => tone({ freq: 140, toFreq: 900, decay: 0.32, wave: "square", gain: 0.1 }));
        return;
      }

      this.die();
      return;
    }
  }

  private die(): void {
    this.phase = "dying";
    this.timer = 1.9;
    this.frightTimer = 0;
    for (const g of this.ghosts) g.fright = false;
    this.sfx(() => {
      tone({ freq: 520, toFreq: 60, decay: 0.9, wave: "sawtooth", gain: 0.11 });
      burst({ freq: 220, q: 1.2, gain: 0.08, decay: 0.4 });
    });
  }

  private afterDeath(): void {
    this.lives--;
    // From the first death the house switches to one shared counter. Dying
    // must not hand the player a quieter board than they had.
    this.globalDots = 0;
    if (this.lives < 0) {
      this.phase = "over";
      this.timer = 6;
      this.host.submit(this.score);
      return;
    }
    this.placeAll();
    this.phase = "ready";
    this.timer = 1.8;
  }

  private add(points: number): void {
    this.score += points;
    if (this.score >= this.nextLife) {
      this.nextLife += EXTRA_LIFE_AT;
      this.lives++;
      this.sfx(() => tone({ freq: 880, toFreq: 1760, decay: 0.3, wave: "square", gain: 0.09 }));
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
    const sig = `${this.score}|${this.host.hiScore()}|${this.level}|${this.lives}|${this.remaining}`;
    if (sig === this.lastFacts) return;
    this.lastFacts = sig;
    this.host.facts([
      { label: "score", value: this.score.toLocaleString() },
      { label: "high", value: Math.max(this.score, this.host.hiScore()).toLocaleString() },
      { label: "level", value: `${this.level}` },
      { label: "lives", value: `${Math.max(0, this.lives)}` },
      { label: "left", value: `${Math.max(0, this.remaining)}` },
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* draw                                                                */
  /* ------------------------------------------------------------------ */

  draw(g: CanvasRenderingContext2D): void {
    const c = palette();

    g.fillStyle = "#000000";
    g.fillRect(0, 0, GAME_W, GAME_H);

    this.drawHud(g, c.text, c.dim);

    g.save();
    g.translate(0, TOP);
    // The maze flashes white as the board clears. It is the only celebration
    // the original ever gives you and it is worth keeping.
    const flash = this.phase === "clear" && Math.floor(this.timer * 6) % 2 === 0;
    this.drawMaze(g, flash);
    if (this.phase !== "clear") {
      this.drawPellets(g);
      if (this.fruitTimer > 0) {
        const f = fruitFor(this.level);
        drawFruit(g, FRUIT_X, FRUIT_Y, f.color, f.accent);
      }
      this.drawGhosts(g);
    }
    if (this.phase !== "attract" && this.phase !== "over" && this.phase !== "clear") {
      this.drawPac(g);
    }
    for (const p of this.pops) {
      textCentered(g, `${p.value}`, p.x, p.y - 3, "#9fe8ff", 1);
    }
    g.restore();

    this.drawBanners(g, c.text, c.cyan, c.ember);
  }

  private drawHud(g: CanvasRenderingContext2D, ink: string, dim: string): void {
    text(g, "1UP", 8, 2, dim, 1);
    text(g, `${this.score}`, 8, 10, ink, 1);
    textCentered(g, "HIGH SCORE", GAME_W / 2, 2, dim, 1);
    textCentered(
      g,
      `${Math.max(this.score, this.host.hiScore())}`,
      GAME_W / 2,
      10,
      "#ffe14a",
      1
    );
    textRight(g, `LEVEL ${this.level}`, GAME_W - 8, 2, dim, 1);

    for (let i = 0; i < Math.max(0, Math.min(this.lives, 5)); i++) {
      drawPac(g, GAME_W - 12 - i * 12, 15, 4, LEFT, 0.75, PAC_YELLOW);
    }
  }

  /**
   * The walls, drawn as outlines derived from the tile data.
   *
   * Every wall tile draws a hairline on each edge it shares with something
   * that is not a wall. That single rule produces the original's look for
   * free: a two-tile-thick divider comes out as the familiar double line down
   * both sides of a corridor, and an isolated block comes out as a rectangle.
   * Authoring the outlines by hand instead would be several hundred segments
   * that have to be re-derived every time a tile moves.
   */
  private drawMaze(g: CanvasRenderingContext2D, flash: boolean): void {
    const wall = flash ? "#ffffff" : MAZE_BLUE;
    const edge = flash ? "#ffffff" : MAZE_EDGE;
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        const t = MAZE[cy][cx];
        if (t === "-") {
          g.fillStyle = DOOR_PINK;
          g.fillRect(cx * TILE, cy * TILE + 3, TILE, 2);
          continue;
        }
        if (t !== "#") continue;
        const x = cx * TILE;
        const y = cy * TILE;
        g.fillStyle = wall;
        const solid = (nx: number, ny: number) =>
          ny < 0 || ny >= ROWS ? true : MAZE[ny][wrapCol(nx)] === "#";
        g.fillStyle = edge;
        if (!solid(cx, cy - 1)) g.fillRect(x, y, TILE, 1);
        if (!solid(cx, cy + 1)) g.fillRect(x, y + TILE - 1, TILE, 1);
        if (!solid(cx - 1, cy)) g.fillRect(x, y, 1, TILE);
        if (!solid(cx + 1, cy)) g.fillRect(x + TILE - 1, y, 1, TILE);
      }
    }
  }

  private drawPellets(g: CanvasRenderingContext2D): void {
    // Energizers blink at about 5Hz. It is the only moving thing on an
    // otherwise static board and it is what draws the eye to the corners.
    const showBig = Math.floor(this.t * 5) % 2 === 0;
    for (let cy = 0; cy < ROWS; cy++) {
      for (let cx = 0; cx < COLS; cx++) {
        if (this.eaten[cy * COLS + cx]) continue;
        const t = MAZE[cy][cx];
        if (t === ".") {
          g.fillStyle = "#f0d8b0";
          g.fillRect(cx * TILE + 3, cy * TILE + 3, 2, 2);
        } else if (t === "o" && showBig) {
          g.fillStyle = "#f0d8b0";
          g.fillRect(cx * TILE + 2, cy * TILE + 1, 4, 6);
          g.fillRect(cx * TILE + 1, cy * TILE + 2, 6, 4);
        }
      }
    }
  }

  private drawPac(g: CanvasRenderingContext2D): void {
    if (this.phase === "dying") {
      // Opening all the way round and vanishing. Drawn from the timer rather
      // than as frames, so it stays smooth however long the pause is.
      const k = 1 - this.timer / 1.9;
      if (k > 0.92) return;
      drawPac(g, this.pacX, this.pacY, 6, this.pacDir, Math.min(1, k * 3.2), PAC_YELLOW);
      return;
    }
    const open =
      this.phase === "ready" ? 0.35 : 0.5 + 0.5 * Math.sin(this.mouth * Math.PI);
    drawPac(g, this.pacX, this.pacY, 6, this.pacDir, Math.abs(open), PAC_YELLOW);
  }

  private drawGhosts(g: CanvasRenderingContext2D): void {
    if (this.phase === "dying") return;
    const frame = Math.floor(this.t * 6) % 2;
    const s = levelSpec(this.level);
    for (const gh of this.ghosts) {
      const x = Math.round(gh.x) - 7;
      const y = Math.round(gh.y) - 7;
      if (gh.eaten) {
        drawGhost(g, x, y, gh.dir, frame, "#000000", true);
        continue;
      }
      if (gh.fright) {
        // Flashing means the energizer is nearly out. The count is on the
        // level table because the original varies it, and it is the only
        // warning the player gets.
        const flashes = Math.max(1, s.flashes);
        const white =
          this.frightTimer < flashes * 0.4 &&
          Math.floor(this.frightTimer * 5) % 2 === 0;
        ghostScared(g, x, y, frame, white);
        continue;
      }
      drawGhost(g, x, y, gh.dir, frame, GHOST_COLOR[gh.name]);
    }
  }

  private drawBanners(
    g: CanvasRenderingContext2D,
    ink: string,
    lit: string,
    warm: string
  ): void {
    const cx = GAME_W / 2;
    const midY = TOP + 23 * TILE - 4;

    if (this.phase === "attract") {
      textCentered(g, "PAC-MAN", cx, TOP + 84, warm, 3);
      textCentered(g, "THE VOID ARCADE", cx, TOP + 108, lit, 1);
      if (Math.floor(this.t * 2) % 2 === 0) {
        textCentered(g, "PRESS SPACE TO START", cx, TOP + 132, ink, 1);
      }
      textCentered(g, "ARROWS OR WASD TO TURN", cx, TOP + 152, "#6d7599", 1);
      textCentered(g, "THEY DO NOT ROLL DICE", cx, TOP + 164, "#6d7599", 1);
      textCentered(g, `HIGH SCORE ${this.host.hiScore()}`, cx, TOP + 186, lit, 1);
      return;
    }
    if (this.phase === "ready") {
      textCentered(g, "READY!", cx, midY, "#ffe14a", 1);
      return;
    }
    if (this.phase === "clear") {
      textCentered(g, `LEVEL ${this.level} CLEARED`, cx, midY, lit, 1);
      return;
    }
    if (this.phase === "over") {
      textCentered(g, "GAME OVER", cx, midY - 8, warm, 2);
      textCentered(g, `SCORE ${this.score}`, cx, midY + 12, ink, 1);
    }
  }
}

/** The cabinet card. Everything the launcher needs to show and start this. */
export const pacmanGame: GameDef = {
  id: "pacman",
  name: "Pac-Man",
  year: "1980",
  glyph: "\u25D5",
  blurb: "four monsters, four different minds, and not one of them is random",
  controls: [
    "\u2190 \u2191 \u2193 \u2192 or WASD \u2014 turn",
    "space \u2014 start",
    "energizers make them edible \u2014 briefly, and less each level",
  ],
  width: GAME_W,
  height: GAME_H,
  create: (host: GameHost): Game => new PacMan(host),
};
