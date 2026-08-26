/**
 * What wave function collapse has to be doing for the window to mean anything.
 *
 * Smoke launches loom, renders it and closes it, which proves the wiring and
 * nothing else — and this is a module where "nothing else" is the whole risk.
 * Sixteen hand-drawn tiles look like a circuit board *however* they are laid
 * out: a grid filled by rolling a die per cell renders as a plausible, busy,
 * completely wrong picture, and no screenshot of it will tell you that the
 * solver is switched off. `violations` will, and the last two blocks here are
 * the module in two numbers — the propagator run against itself with the
 * propagation removed, and the entropy heuristic against random order.
 */
import {
  PATTERNS,
  bits,
  compatOf,
  createWeave,
  nextCell,
  pick,
  propagate,
  settled,
  socketOf,
  tileAt,
  unweave,
  violations,
  weaveAll,
  type Pattern,
  type Weave,
} from "../packages/ui/src/modules/loom/index";

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

const tiles = (w: Weave): number[] =>
  Array.from({ length: w.gw * w.gh }, (_, i) => tileAt(w, i));

const woven = (p: Pattern, seed: number, gw = 24, gh = 18): Weave => {
  const rnd = seeded(seed);
  return weaveAll(createWeave(gw, gh, p, rnd), rnd);
};

/**
 * Arrangements of sockets a cell's neighbours can present that no allowed tile
 * satisfies. This is where contradictions come from, and it is a property of
 * the tileset alone — nothing to do with the solver or the order it runs in.
 */
function impossibleCorners(p: Pattern): number {
  const span = p.geometry === "edge" ? 2 : 4;
  let missing = 0;
  for (let n = 0; n < span; n++) {
    for (let e = 0; e < span; e++) {
      for (let s = 0; s < span; s++) {
        for (let w = 0; w < span; w++) {
          let found = false;
          for (let t = 0; t < 16 && !found; t++) {
            found =
              p.weights[t] > 0 &&
              socketOf(p.geometry, t, 0) === n &&
              socketOf(p.geometry, t, 1) === e &&
              socketOf(p.geometry, t, 2) === s &&
              socketOf(p.geometry, t, 3) === w;
          }
          if (!found) missing++;
        }
      }
    }
  }
  return missing;
}

export function loomChecks(check: Check): void {
  /* ---------------- the tiles agree with themselves ---------------- */

  for (const geometry of ["edge", "corner"] as const) {
    const table = compatOf(geometry);
    let symmetric = true;
    for (let dir = 0; dir < 4; dir++) {
      const back = [2, 3, 0, 1][dir];
      for (let a = 0; a < 16; a++) {
        for (let b = 0; b < 16; b++) {
          const ab = (table[dir * 16 + a] & (1 << b)) !== 0;
          const ba = (table[back * 16 + b] & (1 << a)) !== 0;
          if (ab !== ba) symmetric = false;
        }
      }
    }
    // Asymmetry is the bug that hides: the grid still fills, and the seams
    // are only wrong when read from one side.
    check(`loom: ${geometry} tiles fit each other both ways round`, symmetric);
  }

  {
    // Symmetry above only says the table agrees with itself. This says it
    // agrees with the *picture*: two corner tiles that may sit side by side
    // must be painting the same land at the two corners they physically
    // share, which is stated here in corner bits and not in sockets, so a
    // packing order that is self-consistently wrong still fails.
    const bit = (t: number, i: number) => (t >> i) & 1;
    const table = compatOf("corner");
    let shared = true;
    for (let a = 0; a < 16; a++) {
      for (let b = 0; b < 16; b++) {
        // b to the east of a: a's NE meets b's NW, a's SE meets b's SW.
        if (table[1 * 16 + a] & (1 << b)) {
          if (bit(a, 1) !== bit(b, 0) || bit(a, 2) !== bit(b, 3)) shared = false;
        }
        // b above a: a's NW meets b's SW, a's NE meets b's SE.
        if (table[0 * 16 + a] & (1 << b)) {
          if (bit(a, 0) !== bit(b, 3) || bit(a, 1) !== bit(b, 2)) shared = false;
        }
      }
    }
    check("loom: neighbours agree about the corners they share", shared);
  }

  /**
   * A tile nothing can sit next to is a tile the solver will never place, and
   * it fails silently — the preset just quietly loses a shape. Zeroing a
   * weight is how the presets are written, so this is one typo away.
   */
  for (const p of PATTERNS) {
    const table = compatOf(p.geometry);
    let placeable = true;
    for (let t = 0; t < 16; t++) {
      if (p.weights[t] <= 0) continue;
      for (let dir = 0; dir < 4; dir++) {
        let partners = 0;
        for (let u = 0; u < 16; u++) {
          if (p.weights[u] > 0 && table[dir * 16 + t] & (1 << u)) partners++;
        }
        if (partners === 0) placeable = false;
      }
    }
    check(`loom: every tile ${p.name} allows has somewhere to go`, placeable);
  }

  /* ---------------- a finished grid ---------------- */

  for (const p of PATTERNS) {
    const w = woven(p, 20260825);
    check(`loom: ${p.name} finishes`, settled(w) === w.gw * w.gh);
    check(`loom: ${p.name} has no seam that disagrees`, violations(w) === 0);
  }

  {
    // The two presets whose entire character comes from a zero in the weights.
    const rails = woven(PATTERNS[1], 7);
    const deadEnds = tiles(rails).filter((t) => bits(t) === 1).length;
    check("loom: rails leaves no dead end to stop at", deadEnds === 0);

    const maze = woven(PATTERNS[2], 7);
    const blanks = tiles(maze).filter((t) => t === 0).length;
    check("loom: labyrinth leaves no cell empty", blanks === 0);
  }

  {
    const a = tiles(woven(PATTERNS[0], 99));
    const b = tiles(woven(PATTERNS[0], 99));
    const c = tiles(woven(PATTERNS[0], 100));
    check("loom: the same seed weaves the same world", a.join() === b.join());
    check("loom: a different one does not", a.join() !== c.join());
  }

  /* ---------------- tearing a hole in it ---------------- */

  {
    const w = woven(PATTERNS[0], 4242);
    const before = tiles(w);
    unweave(w, 12, 9, 3);
    const holed = tiles(w);
    const hole = holed.filter((t) => t < 0).length;
    check("loom: unpicking a patch actually unpicks it", hole > 8);

    weaveAll(w, seeded(4243));
    const after = tiles(w);
    check("loom: and the hole fills back in", after.every((t) => t >= 0));
    check("loom: joined to what was left around it", violations(w) === 0);

    // The patch is re-solved with no memory of what was there, so it should
    // differ — and everything well outside the hole should not have moved.
    const changedOutside = before.filter((t, i) => holed[i] >= 0 && after[i] !== t).length;
    check("loom: without disturbing the rest of the grid", changedOutside === 0);
  }

  /* ---------------- the propagator, against itself ---------------- */

  /**
   * The control. Same tiles, same weights, same min-entropy order, same
   * renderer — the only thing removed is telling the neighbours. If the tiles
   * were doing the work, this would still come out clean.
   */
  {
    const rnd = seeded(11);
    const w = createWeave(24, 18, PATTERNS[0]);
    for (;;) {
      const i = nextCell(w);
      if (i < 0) break;
      w.wave[i] = 1 << pick(w, i, rnd);
    }
    const blind = violations(w);
    const solved = violations(woven(PATTERNS[0], 11));
    check(
      `loom: with propagation off, ${blind} seams disagree (solved: ${solved})`,
      blind > 200 && solved === 0
    );
  }

  /**
   * And the heuristic, against random order.
   *
   * Both orders produce a legal grid — the propagator sees to that — so the
   * difference is not in the picture. It is in how often the solver painted
   * itself into a corner and had to tear its own work out, and that number is
   * the whole argument for minimum entropy.
   *
   * `rails` is the preset where this can even be asked. Banning dead ends and
   * tees leaves half of all socket arrangements with no legal tile, so a cell
   * *can* run out of options; the other three tilesets have a tile for
   * everything and could be solved by a coin. Which is worth knowing on its
   * own, because it means three of the four presets are not evidence of
   * anything.
   */
  {
    check("loom: circuit has a tile for every arrangement", impossibleCorners(PATTERNS[0]) === 0);
    check("loom: rails leaves half of them impossible", impossibleCorners(PATTERNS[1]) === 8);
  }

  {
    const p = PATTERNS[1];
    let smart = 0;
    for (let s = 0; s < 40; s++) smart += woven(p, s * 7919 + 3).stuck;

    let blind = 0;
    for (let s = 0; s < 40; s++) {
      const rnd = seeded(s * 7919 + 3);
      const w = createWeave(24, 18, p, rnd);
      let guard = 0;
      for (;;) {
        const loose: number[] = [];
        for (let i = 0; i < w.wave.length; i++) {
          const m = w.wave[i];
          if (m && m & (m - 1)) loose.push(i);
        }
        if (!loose.length || guard++ > 20_000) break;
        const i = loose[Math.floor(rnd() * loose.length)];
        w.wave[i] = 1 << pick(w, i, rnd);
        const dead = propagate(w, [i]);
        if (dead >= 0) {
          w.stuck++;
          unweave(w, dead % w.gw, (dead / w.gw) | 0, 3);
        }
      }
      blind += w.stuck;
    }

    check(
      `loom: over 40 grids minimum entropy never ran out of options (${smart}), ` +
        `random order did ${blind} times`,
      smart === 0 && blind > 400
    );
  }
}
