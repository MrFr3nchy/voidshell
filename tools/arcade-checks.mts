/**
 * The arcade's rules, asserted headlessly.
 *
 * Split out of `smoke.mts` when the fourth cabinet arrived and the arcade
 * section became the largest thing in that file. Same contract as before: this
 * is imported by the harness and handed its `check`, so a failure here is a
 * failure there and there is still exactly one place that runs.
 *
 * What belongs in here is anything that is a pure function of its arguments —
 * targeting rules, speed tables, wave structure, level geometry, scoring
 * curves. A game is judged by playing it, but the constants underneath it are
 * not: getting a flap-to-gravity ratio or a ghost's speed table wrong leaves
 * something perfectly playable that simply is not the game it claims to be,
 * and nothing about it looks broken. These are the parts where being wrong is
 * silent, so they are checked rather than trusted.
 */

import type { GameDef } from "../packages/ui/src/modules/arcade/types";

export type Check = (label: string, ok: boolean) => void;

export async function arcadeChecks(check: Check, CABINETS: GameDef[]): Promise<void> {
  const joustRules = await import("../packages/ui/src/modules/arcade/games/joust/rules");
  const pacRules = await import("../packages/ui/src/modules/arcade/games/pacman/rules");
  const galagaRules = await import("../packages/ui/src/modules/arcade/games/galaga/rules");
  const missileRules = await import("../packages/ui/src/modules/arcade/games/missile/rules");

  /**
   * Joust's rules, asserted directly.
   *
   * A game is judged by playing it, but the constants underneath it are not:
   * getting the flap-to-gravity ratio wrong leaves something perfectly playable
   * that simply isn't Joust, and nothing about it looks broken. These are the
   * parts where being wrong is silent, so they are checked here rather than
   * trusted.
   */
  check(
    "one flap lifts about a body height",
    joustRules.flapApex() > 12 && joustRules.flapApex() < 17
  );
  check(
    "the higher lance wins and level lances draw",
    joustRules.resolveJoust(100, 120) === "a" &&
      joustRules.resolveJoust(120, 100) === "b" &&
      joustRules.resolveJoust(100, 102) === "draw"
  );
  check(
    "the egg chain climbs and then caps",
    [0, 1, 2, 3, 9].map(joustRules.eggChain).join(",") === "250,500,750,1000,1000"
  );
  check(
    "the playfield is a cylinder",
    joustRules.wrapDelta(10, 310) === -20 &&
      joustRules.wrapDelta(310, 10) === 20 &&
      joustRules.wrapX(-5) === joustRules.GAME_W - 5
  );
  check(
    "egg waves field no enemies",
    joustRules.waveKind(5) === "egg" && joustRules.waveEnemies(5) === 0
  );
  check(
    "the enemy count grows and caps",
    joustRules.waveEnemies(1) === 3 && joustRules.waveEnemies(29) === 8
  );
  check(
    "the base erodes but never vanishes",
    joustRules.arena(40)[0].w >= 24 && joustRules.arena(40)[0].w < joustRules.arena(1)[0].w
  );
  check(
    "every arena platform stays above the lava",
    [1, 7, 20, 40].every((w) => joustRules.arena(w).every((p) => p.y < joustRules.LAVA_Y))
  );

  /**
   * Every cabinet must build and run without a canvas.
   *
   * jsdom has no 2D context, so this constructs each game directly, steps it for
   * two seconds of simulated time with nothing held down, and draws every frame
   * into a Proxy that answers every call with a no-op. It catches the three
   * things that are otherwise only found by a player: a constructor that touches
   * a canvas, a `draw` that throws on a state the attract loop reaches on its
   * own, and any coordinate that has gone non-finite. Cheap, and it scales to
   * however many cabinets end up on the floor.
   */
  {
    const nullPad = { down: () => false, hit: () => false };
    const nullHost = {
      hiScore: () => 0,
      submit: () => false,
      muted: () => true,
      facts: () => {},
    };
    // Every call returns the stub again, so chained construction survives:
    // `createLinearGradient(...).addColorStop(...)` is a real thing games do in
    // a draw path, and a stub that answers calls with `undefined` fails on the
    // gradient rather than on anything the test is about. Found the hard way —
    // Joust builds one every frame.
    const nullCtx: CanvasRenderingContext2D = new Proxy({} as CanvasRenderingContext2D, {
      get: (_t, prop) => (prop === "canvas" ? { width: 1, height: 1 } : () => nullCtx),
      set: () => true,
    });
    for (const c of CABINETS) {
      let ok = true;
      try {
        const game = c.create(nullHost);
        for (let i = 0; i < 120; i++) {
          game.update(1 / 60, nullPad);
          game.draw(nullCtx);
        }
        game.dispose?.();
      } catch {
        ok = false;
      }
      check(`${c.id} builds, ticks and draws with no canvas`, ok);
    }
    check(
      "every cabinet declares a whole-pixel resolution",
      CABINETS.every(
        (c) => Number.isInteger(c.width) && Number.isInteger(c.height) && c.width > 0
      )
    );
    check(
      "cabinet ids are unique",
      new Set(CABINETS.map((c) => c.id)).size === CABINETS.length
    );
  }

  /**
   * Pac-Man's maze, checked rather than eyeballed.
   *
   * The three properties below are all silent when broken and all fatal. A
   * missing pellet is a level that cannot be finished, found by a player three
   * minutes in. A wall that is not mirrored puts one of the four ghosts into a
   * corridor its scatter target cannot reach. And a dead end anywhere outside the
   * house is a trap the original never had, which turns a fair chase into an
   * ambush the player has no way to see coming.
   */
  {
    const { MAZE, COLS, ROWS, PELLET_TOTAL } = pacRules;
    const pellets = MAZE.join("").split("").filter((ch) => ch === "." || ch === "o").length;
    check(`the maze holds ${PELLET_TOTAL} things to eat (found ${pellets})`, pellets === PELLET_TOTAL);
    check(
      "the maze is exactly 28 by 31",
      MAZE.length === ROWS && MAZE.every((r) => r.length === COLS)
    );
    check(
      "the maze is mirror-symmetric",
      MAZE.every((r) => {
        for (let x = 0; x < COLS / 2; x++) {
          if ((r[x] === "#") !== (r[COLS - 1 - x] === "#")) return false;
        }
        return true;
      })
    );

    // Flood fill from Pac-Man's start, through the tunnel.
    const seen = new Set<string>();
    const stack: [number, number][] = [[13, 23]];
    while (stack.length) {
      const [x, y] = stack.pop()!;
      const k = `${x},${y}`;
      if (seen.has(k) || !pacRules.walkable(x, y)) continue;
      seen.add(k);
      for (const [dx, dy] of pacRules.DIRS) {
        const nx = pacRules.wrapCol(x + dx);
        const ny = y + dy;
        if (ny >= 0 && ny < ROWS && pacRules.walkable(nx, ny)) stack.push([nx, ny]);
      }
    }
    let unreachable = 0;
    let deadEnds = 0;
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (!pacRules.walkable(x, y)) continue;
        if ((MAZE[y][x] === "." || MAZE[y][x] === "o") && !seen.has(`${x},${y}`)) unreachable++;
        if (!seen.has(`${x},${y}`)) continue;
        const exits = pacRules.DIRS.filter(([dx, dy]) =>
          pacRules.walkable(pacRules.wrapCol(x + dx), y + dy)
        ).length;
        if (exits <= 1) deadEnds++;
      }
    }
    check("every pellet is reachable", unreachable === 0);
    check("the maze has no dead ends", deadEnds === 0);
    check(
      "the tunnel wraps",
      pacRules.walkable(0, pacRules.TUNNEL_ROW) && pacRules.walkable(COLS - 1, pacRules.TUNNEL_ROW)
    );
    check(
      "the house door is a wall to Pac-Man and not to a ghost",
      !pacRules.walkable(13, 12) && pacRules.ghostWalkable(13, 12)
    );
  }

  /**
   * The four minds. Each of these is the one line that makes that ghost itself.
   */
  check(
    "Blinky aims at the tile you are standing on",
    pacRules.blinkyTarget(14, 20).join() === "14,20"
  );
  check(
    "Pinky aims four ahead",
    pacRules.pinkyTarget(14, 20, pacRules.LEFT).join() === "10,20"
  );
  check(
    // Reproduced deliberately: the whole safe-spot strategy is built on it.
    "Pinky's up-target overflows four tiles to the left, as it did in 1980",
    pacRules.pinkyTarget(14, 20, pacRules.UP).join() === "10,16"
  );
  check(
    "Inky doubles the vector from Blinky through a point ahead of you",
    pacRules.inkyTarget(14, 20, pacRules.LEFT, 10, 20).join() === "14,20" &&
      pacRules.inkyTarget(10, 10, pacRules.RIGHT, 4, 10).join() === "20,10"
  );
  check(
    "Clyde chases up close and bolts for his corner inside eight tiles",
    pacRules.clydeTarget(14, 20, 14, 2).join() === "14,20" &&
      pacRules.clydeTarget(14, 20, 14, 17).join() ===
        pacRules.SCATTER_TARGET.clyde.join()
  );
  check(
    "a ghost breaks a tie upward before leftward",
    // At an open crossroads with the target directly above and to the left in
    // equal measure, up wins. That preference is where the patterns come from.
    pacRules.chooseDir(6, 5, pacRules.RIGHT, 5, 4) === pacRules.UP
  );
  check(
    "the mode schedule opens on scatter and settles into chase",
    pacRules.modeAt(1, 0) === "scatter" &&
      pacRules.modeAt(1, 10) === "chase" &&
      pacRules.modeAt(1, 3000) === "chase"
  );
  check(
    // The one genuinely alarming fact in the speed table, and it holds from the
    // very first board: an angry Blinky is faster than you are on every level in
    // the game. Nothing else ever is. It is why the last thirty pellets are the
    // hard part rather than the victory lap.
    "a cruise-Elroy Blinky outruns Pac-Man at every level",
    [1, 2, 5, 12, 21].every(
      (lv) => pacRules.levelSpec(lv).elroy2Speed > pacRules.levelSpec(lv).pac
    ) &&
      [1, 2, 5, 12].every((lv) => pacRules.levelSpec(lv).ghost < pacRules.levelSpec(lv).pac)
  );
  check(
    // The famous cruelty: he is slowed back to 90% for ever while they stay at
    // 95%, so from here nothing can be outrun and the game is pure memory.
    "at level 21 Pac-Man is permanently slower than the ghosts",
    pacRules.levelSpec(20).pac > pacRules.levelSpec(20).ghost &&
      pacRules.levelSpec(21).pac < pacRules.levelSpec(21).ghost
  );
  check(
    "the energizer stops working at level 17",
    pacRules.levelSpec(16).fright > 0 && pacRules.levelSpec(17).fright === 0
  );
  check(
    "the ghost chain doubles and caps at 1600",
    [0, 1, 2, 3, 9].map(pacRules.ghostScore).join(",") === "200,400,800,1600,1600"
  );
  check(
    "Clyde waits sixty pellets on level one and none from level three",
    pacRules.houseDots(1, "clyde") === 60 && pacRules.houseDots(3, "clyde") === 0
  );

  /* ---------------- galaga ---------------- */

  check(
    "the formation is forty: four bosses, sixteen butterflies, twenty bees",
    (() => {
      const s = galagaRules.slots();
      const n = (k: string) => s.filter((x) => x.kind === k).length;
      return (
        s.length === galagaRules.FORMATION_SIZE &&
        n("boss") === 4 &&
        n("butterfly") === 16 &&
        n("bee") === 20
      );
    })()
  );
  check(
    "every formation slot is on screen",
    galagaRules
      .slots()
      .every((s) => s.x > 0 && s.x < galagaRules.GAME_W && s.y > 0 && s.y < galagaRules.GAME_H / 2)
  );
  check(
    "challenging stages fall on 3, 7, 11, 15",
    [3, 7, 11, 15].every(galagaRules.isChallenge) &&
      ![1, 2, 4, 5, 6, 8].some(galagaRules.isChallenge)
  );
  check(
    "everything is worth more in the air than in the rack",
    (["bee", "butterfly", "boss"] as const).every(
      (k) => galagaRules.killScore(k, true) > galagaRules.killScore(k, false)
    )
  );
  check(
    "a boss with two escorts is the biggest single target in the game",
    galagaRules.killScore("boss", true, 2) === 1600 &&
      galagaRules.killScore("boss", true, 1) === 800 &&
      galagaRules.killScore("boss", true, 0) === 400
  );
  check(
    "an extra ship at 20k, then every 70k",
    [0, 19999, 20000, 89999, 90000, 160000].map(galagaRules.livesEarned).join(",") ===
      "0,0,1,1,2,3"
  );
  check(
    "stage pressure ramps and then caps",
    (() => {
      const a = galagaRules.stageSpec(1);
      const b = galagaRules.stageSpec(21);
      const c = galagaRules.stageSpec(60);
      return (
        b.diveSpeed > a.diveSpeed &&
        b.diveEvery < a.diveEvery &&
        c.diveSpeed === b.diveSpeed &&
        c.fireChance <= 0.55
      );
    })()
  );
  check(
    "no boss goes for your ship on stage one",
    !Number.isFinite(galagaRules.stageSpec(1).beamAfter) &&
      Number.isFinite(galagaRules.stageSpec(4).beamAfter)
  );
  check(
    "the formation sways either side of centre and averages out",
    Math.abs(galagaRules.swayAt(0)) < 0.001 &&
      galagaRules.swayAt(galagaRules.SWAY_PERIOD / 4) > 0 &&
      galagaRules.swayAt((galagaRules.SWAY_PERIOD * 3) / 4) < 0
  );
  check(
    "an entry path starts off screen and a dive ends off the bottom",
    (() => {
      const entry = galagaRules.entryPath(0, false);
      const dive = galagaRules.divePath(100, 60, 120, 1);
      const [ex, ey] = entry[0];
      const [, dy] = dive[dive.length - 1];
      const off = ex < 0 || ex > galagaRules.GAME_W || ey < 0;
      return off && dy > galagaRules.GAME_H;
    })()
  );

  /* ---------------- missile command ---------------- */

  check(
    "the multiplier climbs every second wave and caps at six",
    Array.from({ length: 13 }, (_, i) => missileRules.multiplier(i + 1)).join(",") ===
      "1,1,2,2,3,3,4,4,5,5,6,6,6"
  );
  check(
    "a blast grows to full, holds, and returns to nothing",
    missileRules.blastRadius(0) === 0 &&
      missileRules.blastRadius(missileRules.BLAST_GROW) === missileRules.BLAST_R &&
      missileRules.blastRadius(missileRules.BLAST_GROW + missileRules.BLAST_HOLD) ===
        missileRules.BLAST_R &&
      missileRules.blastRadius(missileRules.BLAST_LIFE) === 0
  );
  check(
    "smart bombs arrive at wave seven and not before",
    missileRules.waveSpec(6).smart === 0 && missileRules.waveSpec(7).smart > 0
  );
  check(
    "waves get busier and faster, then stop getting worse",
    (() => {
      const a = missileRules.waveSpec(1);
      const b = missileRules.waveSpec(40);
      const c = missileRules.waveSpec(80);
      return b.missiles > a.missiles && b.speed > a.speed && c.speed === b.speed;
    })()
  );
  check(
    // This is the game's whole thesis stated as an inequality: one surviving
    // city is worth twenty intercepted missiles' worth of leftover stock.
    "a saved city is worth twenty times a leftover missile",
    missileRules.SCORE_SAVED_CITY === missileRules.SCORE_UNUSED_MISSILE * 20 &&
      missileRules.waveBonus(0, 6, 11) > missileRules.waveBonus(30, 0, 11)
  );
  check(
    "the nearest battery with stock answers, and none does when all are empty",
    missileRules.pickBattery(300, [10, 0, 10]) === 2 &&
      missileRules.pickBattery(300, [10, 0, 0]) === 0 &&
      missileRules.pickBattery(160, [0, 0, 0]) === -1
  );
  check(
    "every city and battery stands on the ground, inside the screen",
    [...missileRules.CITY_X, ...missileRules.BATTERY_X].every(
      (x) => x > 0 && x < missileRules.GAME_W
    ) &&
      missileRules.CITY_Y < missileRules.GROUND_Y + 1 &&
      missileRules.BATTERY_Y < missileRules.GROUND_Y
  );
  check(
    "six cities and three batteries",
    missileRules.CITY_X.length === 6 && missileRules.BATTERY_X.length === 3
  );
}
