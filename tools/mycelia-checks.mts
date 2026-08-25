/**
 * What a slime mould has to be doing for the window to mean anything.
 *
 * Smoke launches mycelia, renders it and closes it, which proves the wiring.
 * It cannot see the only claim the module actually makes: that agents with no
 * plan, no memory and three nostrils converge on a *network* — and a swarm
 * that never converges renders as a perfectly attractive cloud of noise. The
 * app looks identical whether the physics works or not, which is exactly the
 * case that needs an assertion rather than a screenshot.
 *
 * `concentration` is the measurement that makes it checkable: the share of the
 * scent sitting in the brightest tenth of the field. Spread evenly it is 0.1.
 * Concentrated into roads it is several times that, and the last block below
 * is the whole module in one number.
 */
import {
  SPECIES,
  carveMaze,
  concentration,
  connects,
  createField,
  createSwarm,
  diffuseDecay,
  feed,
  paintWall,
  sampleAt,
  scatter,
  steer,
  stepSwarm,
} from "../packages/ui/src/modules/mycelia/index";

type Check = (label: string, ok: boolean) => void;

/** A seeded generator, so a failure here is a failure and not a Tuesday. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const total = (xs: Float32Array) => {
  let sum = 0;
  for (const x of xs) sum += x;
  return sum;
};

export function myceliaChecks(check: Check): void {
  /* ---------------- the turn rule ---------------- */

  {
    const never = () => {
      throw new Error("steer consulted chance on a decided sensor reading");
    };
    check("mycelia: a strong nose walks straight on", steer(0.1, 0.9, 0.2, never) === 0);
    check("mycelia: it turns towards the better side", steer(0.9, 0.5, 0.2, never) === -1);
    check("mycelia: and towards the other one", steer(0.2, 0.5, 0.9, never) === 1);
    // Flanked by two better options, an agent that "picks the best" would
    // oscillate between them forever. Jones' rule breaks the tie by coin, and
    // that coin is the only randomness in the simulation once it is running.
    check("mycelia: flanked, it picks a side by coin", steer(0.9, 0.1, 0.9, () => 0.2) === -1);
    check("mycelia: and the coin has two faces", steer(0.9, 0.1, 0.9, () => 0.8) === 1);
    check("mycelia: a flat field leaves the heading alone", steer(0, 0, 0, never) === 0);
  }

  /* ---------------- the field is a torus ---------------- */

  {
    const f = createField(32, 32);
    f.trail[5 * 32 + 31] = 1;
    check("mycelia: sampling wraps past the right edge", sampleAt(f, -1, 5) === 1);
    check("mycelia: and past the bottom", sampleAt(f, 31, 37) === f.trail[5 * 32 + 31]);

    const g = createField(32, 32);
    g.trail[0] = 1;
    diffuseDecay(g, 1, 1);
    check(
      "mycelia: the blur wraps too, so a road can cross the edge",
      g.trail[31] > 0.01 && g.trail[31 * 32] > 0.01
    );
    check("mycelia: and it stays symmetric", Math.abs(g.trail[31] - g.trail[1]) < 1e-6);
  }

  /* ---------------- what a step costs and leaves ---------------- */

  {
    const f = createField(64, 64);
    const s = createSwarm(200, 64, 64, seeded(7));
    stepSwarm(f, s, SPECIES[0], seeded(11));
    const laid = total(f.trail);
    // 200 agents at 0.22 each, minus whatever landed on a cell twice.
    check("mycelia: every agent leaves scent behind it", laid > 200 * 0.22 * 0.9 && laid <= 200 * 0.22 + 1e-6);

    let inside = true;
    for (let i = 0; i < s.n; i++) {
      if (s.x[i] < 0 || s.x[i] >= 64 || s.y[i] < 0 || s.y[i] >= 64) inside = false;
    }
    check("mycelia: nobody walks off the edge", inside);
  }

  {
    const f = createField(48, 48);
    f.trail.fill(0.5);
    const before = total(f.trail);
    diffuseDecay(f, 0.4, 0.9);
    const after = total(f.trail);
    check("mycelia: scent fades by exactly the decay", Math.abs(after - before * 0.9) < 1e-3);

    let flat = true;
    let negative = false;
    for (const v of f.trail) {
      if (Math.abs(v - 0.45) > 1e-5) flat = false;
      if (v < 0) negative = true;
    }
    check("mycelia: blurring a flat field changes nothing but its level", flat);
    check("mycelia: and nothing ever goes negative", !negative);
  }

  /* ---------------- the measurement itself ---------------- */

  {
    const flat = createField(50, 50);
    flat.trail.fill(0.3);
    const c = concentration(flat);
    check(`mycelia: an even field measures 0.1, and measured ${c.toFixed(3)}`, Math.abs(c - 0.1) < 0.02);

    const spike = createField(50, 50);
    spike.trail[1275] = 1;
    check("mycelia: one bright cell measures 1", concentration(spike) > 0.999);
    check("mycelia: an empty field measures 0", concentration(createField(10, 10)) === 0);
  }

  /* ---------------- food is an attractor, not decoration ---------------- */

  {
    const f = createField(40, 40);
    feed(f, 20, 20, 3);
    check("mycelia: food is strongest at its centre", f.trail[20 * 40 + 20] > f.trail[20 * 40 + 22]);
    check("mycelia: and has an edge", f.trail[20 * 40 + 26] === 0);
    feed(f, 20, 20, 3, 0.2);
    check("mycelia: refeeding never dims a trail that is already brighter", f.trail[20 * 40 + 20] > 0.9);
  }

  /* ---------------- immigration ---------------- */

  {
    const f = createField(40, 30);
    const s = createSwarm(500, 40, 30, seeded(9));
    const was = Array.from(s.x);
    scatter(s, f, 25, seeded(2));
    let moved = 0;
    let inside = true;
    for (let i = 0; i < s.n; i++) {
      if (s.x[i] !== was[i]) moved++;
      if (s.x[i] < 0 || s.x[i] >= 40 || s.y[i] < 0 || s.y[i] >= 30) inside = false;
    }
    // At most 25, because the same agent can be drawn twice. Never more.
    check(`mycelia: a scatter moves at most the agents it was asked for (${moved})`, moved > 0 && moved <= 25);
    check("mycelia: and drops all of them inside the field", inside);
    check("mycelia: it never indexes past the end of the swarm", !Number.isNaN(s.x[499]));
  }

  {
    // A maze is mostly wall, and an immigrant dropped inside one is a particle
    // that can never move again: every direction it could step into is solid.
    const f = createField(60, 60);
    f.wall.fill(1);
    for (let y = 20; y < 26; y++) for (let x = 20; x < 26; x++) f.wall[y * 60 + x] = 0;
    const s = createSwarm(200, 60, 60, seeded(4));
    // Start them all on the one patch of open ground, so anything found in a
    // wall afterwards was put there by the scatter and not born there.
    for (let i = 0; i < s.n; i++) {
      s.x[i] = 22.5;
      s.y[i] = 22.5;
    }
    scatter(s, f, 200, seeded(6));
    let walled = 0;
    for (let i = 0; i < s.n; i++) if (f.wall[(s.y[i] | 0) * 60 + (s.x[i] | 0)]) walled++;
    check("mycelia: a scatter never drops an agent inside a wall", walled === 0);
  }

  /* ---------------- walls ---------------- */

  {
    const f = createField(40, 40);
    for (let y = 0; y < 40; y++) f.wall[y * 40 + 20] = 1;
    f.trail.fill(0.5);

    check("mycelia: a wall reads as repellent, not merely empty", sampleAt(f, 20, 5) === -1);
    check("mycelia: and open ground still reads its scent", sampleAt(f, 5, 5) === 0.5);

    diffuseDecay(f, 0.4, 0.95);
    let held = 0;
    for (let y = 0; y < 40; y++) if (f.trail[y * 40 + 20] !== 0) held++;
    check("mycelia: walls hold no scent at all", held === 0);

    feed(f, 20, 20, 2);
    check("mycelia: and food cannot be laid inside one", f.trail[20 * 40 + 20] === 0);
    check("mycelia: though it reaches the open ground beside it", f.trail[20 * 40 + 18] > 0);
  }

  {
    // An agent walked straight at a wall. It must not end up inside, and it
    // must not keep the heading that put it there — the same three lines run
    // 24,000 times a frame, so "stuck against a wall" is a whole dead swarm.
    const f = createField(40, 40);
    for (let y = 0; y < 40; y++) f.wall[y * 40 + 21] = 1;
    const s = createSwarm(1, 40, 40, seeded(1));
    // Representable in a Float32Array, so "did not move" can be an equality.
    s.x[0] = 20.25;
    s.y[0] = 10;
    s.a[0] = 0; // due east, into the wall
    const sp = { ...SPECIES[0], wander: 0, speed: 1 };
    stepSwarm(f, s, sp, seeded(3));
    check("mycelia: an agent cannot walk into a wall", s.x[0] === 20.25 && s.y[0] === 10);
    check("mycelia: and it does not keep the heading that took it there", s.a[0] !== 0);
    check("mycelia: it leaves no scent in the wall either", f.trail[10 * 40 + 21] === 0);
  }

  {
    const f = createField(30, 30);
    paintWall(f, 15, 15, 3, true);
    check("mycelia: the brush paints a disc", f.wall[15 * 30 + 15] === 1 && f.wall[15 * 30 + 17] === 1);
    check("mycelia: with an edge", f.wall[15 * 30 + 19] === 0);
    f.trail[15 * 30 + 15] = 0.9;
    paintWall(f, 15, 15, 3, true);
    check("mycelia: painting over scent erases it", f.trail[15 * 30 + 15] === 0);
    paintWall(f, 15, 15, 3, false);
    check("mycelia: and the eraser opens it back up", f.wall[15 * 30 + 15] === 0);
  }

  /* ---------------- the maze ---------------- */

  {
    const f = createField(200, 150);
    const m = carveMaze(f, 12, seeded(21));

    check(`mycelia: the maze has rooms (${m.rooms})`, m.rooms >= 4);
    check(
      "mycelia: its two ends are open ground",
      f.wall[(m.start.y | 0) * 200 + (m.start.x | 0)] === 0 &&
        f.wall[(m.end.y | 0) * 200 + (m.end.x | 0)] === 0
    );
    check(
      "mycelia: and its border is solid, so nothing escapes onto the torus",
      f.wall[0] === 1 && f.wall[199] === 1 && f.wall[149 * 200] === 1 && f.wall[149 * 200 + 199] === 1
    );

    // Every open cell reachable from the start, and *exactly* the right number
    // of them. A depth-first carve that revisits a room punches a second way
    // round and the maze silently stops being a maze — it still looks like one,
    // and every dead end in it becomes a loop. The count is the test: rooms
    // laid out in a tree have exactly rooms-1 doorways between them, so any
    // extra doorway shows up here as extra open ground.
    const start = (m.start.y | 0) * 200 + (m.start.x | 0);
    const seen = new Uint8Array(200 * 150);
    const queue = [start];
    seen[start] = 1;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      const x = i % 200;
      const y = (i / 200) | 0;
      const around = [
        x > 0 ? i - 1 : -1,
        x < 199 ? i + 1 : -1,
        y > 0 ? i - 200 : -1,
        y < 149 ? i + 200 : -1,
      ];
      for (const j of around) {
        if (j < 0 || seen[j] || f.wall[j]) continue;
        seen[j] = 1;
        queue.push(j);
      }
    }
    let open = 0;
    for (let i = 0; i < f.wall.length; i++) if (!f.wall[i]) open++;
    check(`mycelia: every open cell is reachable from the start (${queue.length}/${open})`, queue.length === open);

    const room = 12;
    const expected = m.rooms * room * room + (m.rooms - 1) * room * 2;
    check(
      `mycelia: and there are exactly rooms-1 doorways, so there are no loops (${open} cells, expected ${expected})`,
      open === expected
    );
  }

  {
    // The flood fill that answers "is there a road from one end to the other".
    const f = createField(120, 90);
    const m = carveMaze(f, 10, seeded(5));
    for (let i = 0; i < f.trail.length; i++) f.trail[i] = f.wall[i] ? 0 : 1;
    check(
      "mycelia: a maze full of mould joins its two ends",
      connects(f, m.start.x, m.start.y, m.end.x, m.end.y, 0.5)
    );
    check(
      "mycelia: a faint road is not a road",
      !connects(f, m.start.x, m.start.y, m.end.x, m.end.y, 1.5)
    );

    // Bricking up the room the start sits in must cut it off, whatever else is
    // lit — this is the assertion that would fail if `connects` ignored walls
    // and simply followed bright cells across them.
    for (let y = (m.start.y | 0) - 8; y <= (m.start.y | 0) + 8; y++) {
      for (let x = (m.start.x | 0) - 8; x <= (m.start.x | 0) + 8; x++) {
        if (x < 0 || y < 0 || x >= 120 || y >= 90) continue;
        const ring = Math.max(Math.abs(x - (m.start.x | 0)), Math.abs(y - (m.start.y | 0)));
        if (ring === 8) {
          f.wall[y * 120 + x] = 1;
          f.trail[y * 120 + x] = 0;
        }
      }
    }
    check(
      "mycelia: and walling the start in cuts it off",
      !connects(f, m.start.x, m.start.y, m.end.x, m.end.y, 0.5)
    );
  }

  /* ---------------- the whole claim, in one number ---------------- */

  {
    // Sixty seconds of the real thing at a quarter of the size. Two swarms,
    // identical in every way except that one has its nostrils switched off:
    // the sensing swarm must build roads, and the blind one must not. Asserting
    // only the first would pass on a bug that concentrated the field by some
    // other route — a decay that eats everything but the birth ring would score
    // beautifully and be nothing at all like a slime mould.
    const sp = SPECIES[0];
    const blind = { ...sp, reach: 0, sensor: 0 };
    const run = (species: typeof sp) => {
      const f = createField(96, 96);
      const s = createSwarm(1000, 96, 96, seeded(3));
      const rand = seeded(5);
      for (let i = 0; i < 600; i++) {
        stepSwarm(f, s, species, rand);
        diffuseDecay(f, species.diffuse, species.decay);
        scatter(s, f, 3, rand);
      }
      return concentration(f);
    };

    const seeing = run(sp);
    const nose = run(blind);
    check(
      `mycelia: 1,000 agents that can smell build a network — top tenth holds ${(seeing * 100) | 0}% of the scent`,
      seeing > 0.35
    );
    check(
      `mycelia: the same 1,000 with no sense of smell do not (${(nose * 100) | 0}%)`,
      nose < seeing * 0.8
    );
  }
}
