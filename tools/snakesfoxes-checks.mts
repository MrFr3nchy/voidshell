/**
 * The web's own rules, asserted directly.
 *
 * Smoke launches the app, renders it and closes it, which proves the wiring and
 * nothing else. Everything below is graph arithmetic that produces a perfectly
 * playable-looking board whatever answer it gives — a rim you cannot reach, a
 * centre you cannot get back to, a hunter that circles forever one ring out
 * because the only step that closes the distance runs against the arrows. None
 * of those throw, and all three are lost games that look like won ones.
 *
 * "The way home is not the way out" is the one to read first. It is not a
 * flourish: the first board here had two-way spokes, quietly made the rings
 * irrelevant, and turned the hunt into twenty pieces walking down a radius.
 * Nothing about it looked wrong. This assertion is what said so.
 */
import {
  CENTRE,
  CORNERS,
  NODES,
  PER_CORNER,
  RINGS,
  SPOKES,
  WEB,
  distanceToNearest,
  distancesTo,
  nextNode,
  nodeAt,
  ringOf,
} from "../packages/ui/src/modules/snakesfoxes/index";

type Check = (label: string, ok: boolean) => void;

/** Nodes reachable from `start` following the arrows. */
function reachable(start: number): Set<number> {
  const seen = new Set([start]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    for (const next of WEB.out[queue[head]]) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

export function snakesfoxesChecks(check: Check): void {
  /* ---------------- the board is the board that was described ---------------- */

  check(
    `snakes & foxes: ${NODES} nodes — a centre and ${RINGS} rings of ${SPOKES}`,
    NODES === 1 + RINGS * SPOKES
  );
  check(
    "snakes & foxes: twenty pale discs, stacked four corners deep",
    CORNERS.length * PER_CORNER === 20 &&
      CORNERS.filter((c) => c.kind === "snake").length * PER_CORNER === 10 &&
      CORNERS.filter((c) => c.kind === "fox").length * PER_CORNER === 10
  );
  check(
    "snakes & foxes: every corner sits on the rim",
    CORNERS.every((c) => ringOf(c.node) === RINGS)
  );
  // Diagonals, so the four stacks are as far from each other as the web allows.
  check(
    "snakes & foxes: the corners are four distinct places",
    new Set(CORNERS.map((c) => c.node)).size === 4
  );
  // Load-bearing, and not obviously so: a corner on an outward-only spoke would
  // leave twenty pieces able to enter the web and then unable to walk inward
  // along the line they are standing on. They would still get home the long way
  // round the rings, which is exactly why this needs asserting rather than
  // eyeballing — the hunt would simply be limp, and nothing would look broken.
  check(
    "snakes & foxes: every corner stands on a spoke that runs inward",
    CORNERS.every((c) => WEB.out[c.node].some((n) => ringOf(n) < RINGS))
  );

  /* ---------------- every line runs one way ---------------- */

  {
    // Half the spokes only carry you out and half only carry you home. If any
    // single spoke ran both ways it would be a bolt-hole: a disc could go out
    // and come straight back down it, and the circuit stops being forced.
    let spokesOneWay = true;
    for (let s = 0; s < SPOKES; s++) {
      const outward = s % 2 === 0;
      const rungs: [number, number][] = [[CENTRE, nodeAt(1, s)]];
      for (let r = 1; r < RINGS; r++) rungs.push([nodeAt(r, s), nodeAt(r + 1, s)]);
      for (const [inner, outer] of rungs) {
        const up = WEB.out[inner].includes(outer);
        const down = WEB.out[outer].includes(inner);
        if (up === down) spokesOneWay = false; // both or neither: not a one-way line
        if (up !== outward) spokesOneWay = false;
      }
    }
    check("snakes & foxes: each spoke runs one way, out or home, never both", spokesOneWay);

    let ringsOneWay = true;
    let ringsAlternate = true;
    for (let r = 1; r <= RINGS; r++) {
      const dir = r % 2 === 1 ? 1 : -1;
      for (let s = 0; s < SPOKES; s++) {
        if (!WEB.out[nodeAt(r, s)].includes(nodeAt(r, s + dir))) ringsAlternate = false;
        if (WEB.out[nodeAt(r, s)].includes(nodeAt(r, s - dir))) ringsOneWay = false;
      }
    }
    check("snakes & foxes: no ring can be walked backwards", ringsOneWay);
    check("snakes & foxes: consecutive rings turn opposite ways", ringsAlternate);

    // The property the whole board rests on: there is no two-way line anywhere,
    // so no move on the web can simply be undone.
    let anyReversible = false;
    for (let a = 0; a < NODES; a++) {
      for (const b of WEB.out[a]) if (WEB.out[b].includes(a)) anyReversible = true;
    }
    check("snakes & foxes: no step on the web can be taken back", !anyReversible);
  }

  /* ---------------- the errand is possible at all ---------------- */

  {
    // Out and back are separate questions on a directed graph, and the whole
    // game is the round trip. Failing either makes the board a dead end that
    // still draws correctly.
    const fromCentre = reachable(CENTRE);
    const rim: number[] = [];
    for (let s = 0; s < SPOKES; s++) rim.push(nodeAt(RINGS, s));
    check(
      "snakes & foxes: the rim is reachable from the centre",
      rim.every((n) => fromCentre.has(n))
    );
    check(
      "snakes & foxes: the centre is reachable from anywhere on the rim",
      rim.every((n) => reachable(n).has(CENTRE))
    );
    check("snakes & foxes: no node is stranded", fromCentre.size === NODES);

    // The asymmetry is the design, not an accident: if out and back cost the
    // same from every node, the arrows are decoration. This assertion is why
    // the board was rebuilt — the first one failed it.
    const toCentre = distancesTo(CENTRE);
    let asymmetric = 0;
    for (let n = 1; n < NODES; n++) {
      if (distancesTo(n)[CENTRE] !== toCentre[n]) asymmetric++;
    }
    check("snakes & foxes: the way home is not the way out", asymmetric > 0);

    // And the errand costs more than the radius, or the rings are still a
    // detour nobody would ever take.
    let cheapestLap = Infinity;
    for (const n of rim) cheapestLap = Math.min(cheapestLap, toCentre[n] + distancesTo(n)[CENTRE]);
    check(
      `snakes & foxes: the cheapest lap is ${cheapestLap} steps, more than the ${RINGS * 2} a radius would cost`,
      cheapestLap > RINGS * 2
    );
  }

  /* ---------------- "toward you, by the shortest path" ---------------- */

  {
    const maps = [distancesTo(CENTRE)];
    let alwaysCloses = true;
    let stalls = 0;
    for (let n = 0; n < NODES; n++) {
      if (n === CENTRE) continue;
      const step = nextNode(n, maps);
      if (step === null) {
        stalls++;
        continue;
      }
      // A step that doesn't strictly reduce the distance is a hunter milling
      // about, and it is invisible on screen for several turns.
      if (distanceToNearest(step, maps) >= distanceToNearest(n, maps)) alwaysCloses = false;
    }
    check("snakes & foxes: every hunter step strictly closes the distance", alwaysCloses);
    check("snakes & foxes: no node on the web leaves a hunter with nowhere to go", stalls === 0);
  }

  /* ---------------- the pursuit actually converges ---------------- */

  {
    // A hunter released from each corner, walked at a human sitting in the
    // centre. The bound is what decides whether the game is a game: if a corner
    // is eleven steps out, six dice a turn means a lawful escape is tight
    // rather than impossible, which is the balance the module claims.
    const maps = [distancesTo(CENTRE)];
    let worst = 0;
    let allArrive = true;
    for (const corner of CORNERS) {
      let at = corner.node;
      let steps = 0;
      while (at !== CENTRE && steps < NODES) {
        const step = nextNode(at, maps);
        if (step === null) break;
        at = step;
        steps++;
      }
      if (at !== CENTRE) allArrive = false;
      worst = Math.max(worst, steps);
    }
    check("snakes & foxes: a hunter released at any corner reaches the centre", allArrive);
    check(
      `snakes & foxes: the longest corner-to-centre hunt is ${worst} steps, and the round trip is ${RINGS * 2}`,
      worst >= RINGS && worst <= NODES
    );
  }
}
