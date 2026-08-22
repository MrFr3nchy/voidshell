import type { KernelContext, Stage, VoidModule } from "../../kernel/types";

/**
 * Snakes and Foxes — the children's game from Robert Jordan's *The Wheel of
 * Time*, played on a web of lines against twenty pieces that only ever come
 * toward you.
 *
 * What the books actually specify is short, and all of it is here: a board
 * "with a web of lines on it, some of which allowed movement in only one
 * direction"; ten pale discs inked with a wavy line for the snakes and ten
 * with a triangle for the foxes, stacked at the corners; two black discs for
 * the humans, starting in the circle at the centre; six dice whose faces carry
 * triangles and wavy lines, deciding how many fox and snake steps a turn buys;
 * hunters that must close "by the shortest path"; and a human aim of reaching
 * the rim and coming home untouched.
 *
 * The web's exact geometry is never drawn in the text, so the one here is a
 * reading rather than a transcription: six rings on eight spokes, and every
 * line on it one-way. Half the spokes only carry you outward and half only
 * carry you home; the rings alternate direction and are the only way to change
 * spoke. That is what makes the board a *trap* rather than a grid — the step
 * you took to get here is never the step that takes you back.
 *
 * The rest is not a liberty at all, because it is the point of the game:
 *
 *   > "You can't win," Mat said. "It's a game for children. You can't win
 *   > unless you cheat."
 *
 * So the four ways named in the opening rhyme — courage to strengthen, fire to
 * blind, music to dazzle, iron to bind — are implemented as *rule-breaks*, one
 * use each, and the ending you get says which kind of escape it was. Coming
 * home lawfully is possible and vanishingly rare. Coming home at all usually
 * means you broke something, which is the lesson the Aelfinn and Eelfinn were
 * always going to teach the hard way.
 */

/* ------------------------------------------------------------------ board */

export const RINGS = 6;
export const SPOKES = 8;
export const NODES = 1 + RINGS * SPOKES;

/** Ring 0 is the centre circle; ring RINGS is the rim you have to touch. */
export const CENTRE = 0;

/** Node index for a polar coordinate. Spoke wraps, so callers can add ±1. */
export function nodeAt(ring: number, spoke: number): number {
  if (ring === 0) return CENTRE;
  return 1 + (ring - 1) * SPOKES + (((spoke % SPOKES) + SPOKES) % SPOKES);
}

export function ringOf(node: number): number {
  return node === CENTRE ? 0 : Math.floor((node - 1) / SPOKES) + 1;
}

/**
 * The web, as a directed graph. Every line on it runs one way only.
 *
 * The first version of this board had two-way spokes and one-way rings, which
 * *read* as a web and played as a star: the shortest path between the centre
 * and the rim was always straight up a radius, in both directions, so the ring
 * arrows never once decided anything and the hunt was a straight line. The
 * checks caught it — "the way home is not the way out" is a real assertion
 * because it was, at first, false.
 *
 * So the spokes are one-way too, and they alternate by parity: **even spokes
 * carry you outward, odd spokes carry you home.** Rings alternate the other
 * axis — odd rings run clockwise, even rings widdershins — and are the only
 * way to change spoke, which makes them the only way to change direction.
 *
 * The consequence is the whole game. You cannot retreat back down the line you
 * came out on. Once a disc leaves the centre it is committed to a circuit, and
 * "get to the rim and back" stops being twelve steps up and down a radius and
 * becomes a thirteen-step one-way lap of a web that is closing behind you.
 */
function buildWeb(): { out: number[][]; inn: number[][] } {
  const out: number[][] = Array.from({ length: NODES }, () => []);
  const link = (a: number, b: number) => {
    if (!out[a].includes(b)) out[a].push(b);
  };

  for (let s = 0; s < SPOKES; s++) {
    const outward = s % 2 === 0;
    if (outward) link(CENTRE, nodeAt(1, s));
    else link(nodeAt(1, s), CENTRE);
    for (let r = 1; r < RINGS; r++) {
      if (outward) link(nodeAt(r, s), nodeAt(r + 1, s));
      else link(nodeAt(r + 1, s), nodeAt(r, s));
    }
  }

  for (let r = 1; r <= RINGS; r++) {
    const dir = r % 2 === 1 ? 1 : -1;
    for (let s = 0; s < SPOKES; s++) link(nodeAt(r, s), nodeAt(r, s + dir));
  }

  const inn: number[][] = Array.from({ length: NODES }, () => []);
  for (let a = 0; a < NODES; a++) for (const b of out[a]) inn[b].push(a);
  return { out, inn };
}

export const WEB = buildWeb();

/**
 * Steps from every node to `target`, following the arrows.
 *
 * Walked backwards from the target over the reversed edges, which is the only
 * way to get "how far is *this* hunter from you" for twenty hunters in one
 * pass. On a one-way board the distance is not symmetric, so a hunter four
 * steps away from you may be nine steps away in the direction it can move —
 * and it is the second number that decides where it goes.
 */
export function distancesTo(target: number): Int16Array {
  const dist = new Int16Array(NODES).fill(-1);
  dist[target] = 0;
  const queue = [target];
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head];
    for (const u of WEB.inn[v]) {
      if (dist[u] !== -1) continue;
      dist[u] = dist[v] + 1;
      queue.push(u);
    }
  }
  return dist;
}

/** The four corners where the pale discs are stacked, as [node, kind]. */
export const CORNERS: { node: number; kind: Kind }[] = [
  { node: nodeAt(RINGS, 1), kind: "snake" },
  { node: nodeAt(RINGS, 3), kind: "fox" },
  { node: nodeAt(RINGS, 5), kind: "snake" },
  { node: nodeAt(RINGS, 7), kind: "fox" },
];

export const PER_CORNER = 5;

/* ------------------------------------------------------------------ state */

export type Kind = "snake" | "fox";
type Phase = "ritual" | "player" | "hunt" | "over";
type Boon = "courage" | "fire" | "music" | "iron";

interface Human {
  node: number;
  /** "out" is still looking for the rim; "back" has touched it. */
  leg: "out" | "back";
  alive: boolean;
  home: boolean;
  movesLeft: number;
  /** Courage: this disc survives being touched, once. */
  warded: boolean;
}

interface Hunter {
  kind: Kind;
  node: number;
  /** Still in the corner stack. Coming off it costs a step. */
  stacked: boolean;
  /** Turns remaining bound by iron. */
  frozen: number;
}

const RHYME = [
  "Courage to strengthen,",
  "fire to blind,",
  "music to dazzle,",
  "iron to bind.",
];

const BOONS: { id: Boon; label: string; note: string }[] = [
  { id: "courage", label: "courage", note: "every disc still in play survives one touch" },
  { id: "fire", label: "fire", note: "they back away from you for two turns" },
  { id: "music", label: "music", note: "they stand still for two turns" },
  { id: "iron", label: "iron", note: "everything already on the web is pinned for three" },
];

/**
 * The neighbour that takes this hunter closest to a human, or `null` if none of
 * them does.
 *
 * This is the whole of "they must move toward you by the shortest path", and it
 * is the one rule worth having outside the closure: on a board where the rings
 * are one-way, the step that *looks* like closing frequently isn't, and a
 * pursuit that quietly stops converging still renders as a perfectly ordinary
 * game. `snakesfoxes-checks.mts` asserts it against every node on the web.
 */
export function nextNode(from: number, maps: Int16Array[]): number | null {
  const here = distanceToNearest(from, maps);
  let best: number | null = null;
  let bestD = Infinity;
  for (const m of WEB.out[from]) {
    const d = distanceToNearest(m, maps);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return bestD < here ? best : null;
}

/** Steps to whichever human is nearest along the arrows; Infinity if none is. */
export function distanceToNearest(node: number, maps: Int16Array[]): number {
  let best = Infinity;
  for (const map of maps) {
    const d = map[node];
    if (d >= 0 && d < best) best = d;
  }
  return best;
}

/**
 * Steps a disc gets per turn.
 *
 * Two, not one, and the number is load-bearing: the cheapest lap of the one-way
 * web is thirteen steps, and six dice a turn move six hunters one step each. At
 * one step a turn the game is not hard, it is arithmetic — the hunt is on top of
 * you before a disc has seen the rim, and nothing the player does changes it.
 * At three it is over the other way: you outrun the web and the rim stops
 * meaning anything.
 */
const MOVES = 2;

/** Seconds between hunter steps, so the hunt can be watched rather than read. */
const STEP_DELAY = 0.14;

/** When the sign has finished drawing itself and the board opens. */
const RITUAL_END = 3.2;

export const snakesFoxes: VoidModule = {
  manifest: {
    id: "snakesfoxes",
    name: "Snakes & Foxes",
    kind: "app",
    glyph: "\u2735",
    blurb: "the game you cannot win without cheating",
    version: "0.1.0",
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "snakesfoxes.open",
      label: "snakes & foxes",
      hint: "courage, fire, music, iron",
      glyph: "\u2735",
      run: (c) => c.launch("snakesfoxes"),
    });
  },

  launch(ctx: KernelContext) {
    const { mount: mountStage, palette, toolbar, toolButton, withAlpha } = ctx.stage;

    ctx.openSurface({
      title: "snakes & foxes",
      width: 460,
      height: 560,
      render: (root) => {
        root.innerHTML = "";
        root.classList.add("stage-root");

        const stageHost = document.createElement("div");
        stageHost.className = "stage-host";
        root.appendChild(stageHost);
        const bar = toolbar(root);

        /* ---------------------------------------------------- game state */

        let phase: Phase = "ritual";
        let turn = 1;
        let humans: Human[] = [];
        let hunters: Hunter[] = [];
        let selected: number | null = null;
        let dice: Kind[] = [];
        let spent: Record<Boon, boolean> = {
          courage: false,
          fire: false,
          music: false,
          iron: false,
        };
        let broke = false;
        /** Music was played this turn: the dice get rolled and then ignored. */
        let dazzleTurns = 0;
        let blindTurns = 0;
        let outcome = "";
        let flash = "";
        let flashFor = 0;

        /** Kinds still owed a step this hunt, in the order they'll be paid. */
        let queue: Kind[] = [];
        /** Pieces that have already taken their one step this hunt. */
        let moved = new Set<Hunter>();
        let stepClock = 0;
        let ritualT = 0;

        const sound = (fn: () => void) => {
          if (ctx.audio.enabled()) fn();
        };

        const say = (text: string, seconds = 2.6) => {
          flash = text;
          flashFor = seconds;
        };

        const reset = () => {
          phase = "ritual";
          ritualT = 0;
          turn = 1;
          humans = [
            { node: CENTRE, leg: "out", alive: true, home: false, movesLeft: MOVES, warded: false },
            { node: CENTRE, leg: "out", alive: true, home: false, movesLeft: MOVES, warded: false },
          ];
          hunters = [];
          for (const corner of CORNERS) {
            for (let i = 0; i < PER_CORNER; i++) {
              hunters.push({ kind: corner.kind, node: corner.node, stacked: true, frozen: 0 });
            }
          }
          selected = null;
          dice = [];
          spent = { courage: false, fire: false, music: false, iron: false };
          broke = false;
          dazzleTurns = 0;
          blindTurns = 0;
          outcome = "";
          flash = "";
          flashFor = 0;
          queue = [];
          syncButtons();
        };

        /* -------------------------------------------------------- the run */

        const living = () => humans.filter((h) => h.alive && !h.home);

        /** Distance maps to every human still on the board, rebuilt per step. */
        const scentMaps = () => living().map((h) => distancesTo(h.node));

        const takeHumansOn = (node: number) => {
          for (const h of humans) {
            if (!h.alive || h.home || h.node !== node) continue;
            if (h.warded) {
              // Courage spends itself here rather than at the moment it was
              // called for, which is the only reading of "strengthen" that
              // does anything a player can feel.
              h.warded = false;
              sound(() => ctx.audio.tone({ freq: 520, toFreq: 260, gain: 0.22, decay: 0.4 }));
              say("touched \u2014 and it held");
              continue;
            }
            h.alive = false;
            if (selected !== null && humans[selected] === h) selected = null;
            sound(() => ctx.audio.burst({ freq: 140, q: 1.4, gain: 0.5, decay: 0.35 }));
            say("a disc is taken");
            ctx.log("snakes & foxes: a human disc was taken");
          }
        };

        /**
         * One piece of `kind` takes one step.
         *
         * Two readings of the dice were tried and only one of them is a game.
         *
         * The text says "the number of triangle faces shown equals fox pieces
         * *moved*" — so a die buys one piece one step, not one piece six steps.
         * Spending all six on whoever was nearest let a single hunter cross the
         * entire web between two of the player's turns, and the simulation in
         * `$CLAUDE_JOB_DIR` bore it out: games ended on turn two, every time,
         * and no amount of play changed it.
         *
         * Nor does the text say *which* pieces move, and choosing the six
         * nearest every turn is a reading that makes twenty optimal pursuers
         * out of a children's game — encirclement becomes arithmetic and the
         * player's decisions stop mattering. Pieces already on the web are
         * preferred over pieces still in a corner stack, and chance picks from
         * there.
         *
         * That preference sets the pace of the hunt without anything having to
         * schedule it: a corner only gives up a piece when the dice ask for more
         * of that colour than are loose and unmoved, so the web fills as the
         * game lengthens rather than all at once. Measured over four hundred
         * games, about eight of the twenty are in play by turn four and around
         * twelve by turn eight.
         *
         * Lawful escape sits near one game in seventy; with the four boons it is
         * roughly one in twenty-five.
         */
        const stepOne = (kind: Kind, moved: Set<Hunter>) => {
          const maps = scentMaps();
          if (!maps.length) return;

          const eligible = hunters.filter(
            (h) => h.kind === kind && h.frozen === 0 && !moved.has(h)
          );
          if (!eligible.length) return;

          const onWeb = eligible.filter((h) => !h.stacked);
          const pool = onWeb.length ? onWeb : eligible;
          const mover = pool[Math.floor(Math.random() * pool.length)];
          moved.add(mover);

          if (mover.stacked) {
            mover.stacked = false;
            sound(() => ctx.audio.burst({ freq: 320, q: 3, gain: 0.16, decay: 0.09 }));
            takeHumansOn(mover.node);
            return;
          }

          const moves = WEB.out[mover.node];
          if (!moves.length) return;

          // Fire in their eyes. A blinded hunter that merely wandered was worth
          // almost nothing — it drifts back toward you by accident about as
          // often as not — so it backs away from what it cannot see instead.
          let next: number;
          if (blindTurns > 0) {
            next = moves[0];
            let farthest = -Infinity;
            for (const m of moves) {
              const d = distanceToNearest(m, maps);
              if (d !== Infinity && d > farthest) {
                farthest = d;
                next = m;
              }
            }
          } else {
            next = nextNode(mover.node, maps) ?? moves[0];
          }

          mover.node = next;
          sound(() => ctx.audio.burst({ freq: kind === "fox" ? 520 : 260, q: 4, gain: 0.1, decay: 0.06 }));
          takeHumansOn(next);
        };

        const finish = () => {
          const home = humans.filter((h) => h.home).length;
          const lost = humans.filter((h) => !h.alive).length;
          if (home === 2) {
            outcome = broke
              ? "Both home \u2014 but you broke the rules to do it.\nWhich is the only way anyone ever has."
              : "Both home, and you never once cheated.\nNobody will believe you.";
            sound(() => ctx.audio.tone({ freq: 420, toFreq: 840, gain: 0.2, decay: 0.5 }));
          } else if (lost === 2) {
            outcome = "Both discs taken. The web keeps them.\nIt is only a children's game.";
            sound(() => ctx.audio.tone({ freq: 220, toFreq: 90, gain: 0.22, decay: 0.7 }));
          } else {
            outcome = "You came back alone.\nHalf of what went out is still in the web.";
            sound(() => ctx.audio.tone({ freq: 300, toFreq: 180, gain: 0.2, decay: 0.6 }));
          }
          phase = "over";
          const played = (ctx.state.get<number>("snakesfoxes.played", 0) || 0) + 1;
          ctx.state.set("snakesfoxes.played", played);
          if (home === 2) {
            const key = broke ? "snakesfoxes.escapes" : "snakesfoxes.lawful";
            ctx.state.set(key, (ctx.state.get<number>(key, 0) || 0) + 1);
          }
          syncButtons();
        };

        const settled = () => humans.every((h) => h.home || !h.alive);

        const beginTurn = () => {
          turn++;
          if (blindTurns > 0) blindTurns--;
          for (const h of hunters) if (h.frozen > 0) h.frozen--;
          for (const h of humans) h.movesLeft = h.alive && !h.home ? MOVES : 0;
          selected = null;
          phase = "player";
          syncButtons();
        };

        const roll = () => {
          if (phase !== "player") return;
          dice = Array.from({ length: 6 }, () => (Math.random() < 0.5 ? "fox" : "snake"));
          sound(() => ctx.audio.burst({ freq: 900, q: 1.1, gain: 0.3, decay: 0.16 }));

          if (musicHeld()) return;

          // Triangles say how many foxes move, waves how many snakes — one step
          // each. Interleaved rather than run in blocks, because the board reads
          // better when both colours are closing at once.
          const foxes = dice.filter((d) => d === "fox").length;
          const snakes = dice.length - foxes;
          queue = [];
          for (let i = 0; i < Math.max(foxes, snakes); i++) {
            if (i < foxes) queue.push("fox");
            if (i < snakes) queue.push("snake");
          }
          moved = new Set();
          stepClock = 0;
          phase = "hunt";
          syncButtons();
        };

        const musicHeld = () => {
          if (dazzleTurns <= 0) return false;
          dazzleTurns--;
          say("they stand there listening");
          queue = [];
          beginTurn();
          return true;
        };

        const advanceHunt = (dt: number) => {
          stepClock += dt;
          while (stepClock >= STEP_DELAY && queue.length) {
            stepClock -= STEP_DELAY;
            const kind = queue.shift();
            if (kind) stepOne(kind, moved);
            if (settled()) {
              queue = [];
              finish();
              return;
            }
          }
          if (!queue.length) beginTurn();
        };

        /* ------------------------------------------------------ the human */

        const moveHuman = (index: number, to: number) => {
          const h = humans[index];
          if (!h.alive || h.home || h.movesLeft <= 0) return;
          if (!WEB.out[h.node].includes(to)) return;

          h.node = to;
          h.movesLeft--;
          sound(() => ctx.audio.burst({ freq: 700, q: 6, gain: 0.12, decay: 0.05 }));

          if (h.leg === "out" && ringOf(to) === RINGS) {
            h.leg = "back";
            say("the rim \u2014 now get home");
            sound(() => ctx.audio.tone({ freq: 560, toFreq: 700, gain: 0.14, decay: 0.2 }));
          } else if (h.leg === "back" && to === CENTRE) {
            h.home = true;
            h.movesLeft = 0;
            selected = null;
            say("one disc is home");
            sound(() => ctx.audio.tone({ freq: 640, toFreq: 900, gain: 0.16, decay: 0.3 }));
          }

          // Walking onto a hunter is a legal move and a fatal one. The web does
          // not care that you moved first.
          //
          // A piece still in its corner stack is not one of them: it has not
          // entered play, so a disc may stand on a full corner unharmed — and is
          // taken the instant a die releases a piece onto that node. Both halves
          // of that are the same rule, "stacked is not on the board", and it is
          // the reading that makes the four corners approachable at all rather
          // than four of the eight rim nodes being instant death.
          if (!h.home && hunters.some((x) => !x.stacked && x.node === to)) takeHumansOn(to);

          if (settled()) finish();
          else if (humans.every((x) => x.movesLeft <= 0)) selected = null;
          syncButtons();
        };

        /* ------------------------------------------------- breaking rules */

        const useBoon = (id: Boon) => {
          if (phase !== "player" || spent[id]) return;

          // Iron binds what is on the web, so on turn one it binds nothing.
          // Burning a one-shot boon for no effect is bad enough; it also used to
          // set `broke`, which quietly turned a lawful victory into a cheated
          // one in exchange for absolutely nothing. Refused, with the reason.
          if (id === "iron" && !hunters.some((h) => !h.stacked)) {
            ctx.notify(
              "Iron binds what is already on the web, and every piece is still " +
                "stacked in a corner. Roll first \u2014 it will be worth more once " +
                "they are moving.",
              "warn"
            );
            return;
          }

          spent[id] = true;
          broke = true;
          sound(() => ctx.audio.tone({ freq: 300, toFreq: 620, gain: 0.18, decay: 0.35 }));

          if (id === "courage") {
            for (const h of humans) if (h.alive && !h.home) h.warded = true;
            say("courage to strengthen \u2014 the next touch will not take you");
          } else if (id === "fire") {
            blindTurns = 2;
            say("fire to blind");
          } else if (id === "music") {
            dazzleTurns = 2;
            say("music to dazzle \u2014 two turns of standing still");
          } else {
            // Everything already off its corner, for three turns. Binding only
            // what was near you spent the boon on two pieces and changed
            // nothing; the rhyme calls these the ways to *win*, not to stall.
            let bound = 0;
            for (const h of hunters) {
              if (h.stacked) continue;
              h.frozen = 3;
              bound++;
            }
            // Guaranteed non-zero: the guard above refuses the use otherwise.
            say(`iron to bind \u2014 ${bound} held where they stand`);
          }
          ctx.log(`snakes & foxes: broke the rules with ${id}`);
          syncButtons();
        };

        /* ---------------------------------------------------------- layout */

        const pos: { x: number; y: number }[] = Array.from({ length: NODES }, () => ({ x: 0, y: 0 }));
        let unit = 1;

        const relayout = (st: Stage) => {
          const cx = st.w / 2;
          const cy = st.h / 2 + 8;
          const radius = Math.max(40, Math.min(st.w, st.h - 40) * 0.42);
          unit = radius / RINGS;
          pos[CENTRE] = { x: cx, y: cy };
          for (let r = 1; r <= RINGS; r++) {
            for (let s = 0; s < SPOKES; s++) {
              const a = (s / SPOKES) * Math.PI * 2 - Math.PI / 2;
              pos[nodeAt(r, s)] = {
                x: cx + Math.cos(a) * unit * r,
                y: cy + Math.sin(a) * unit * r,
              };
            }
          }
        };

        const nodeNear = (x: number, y: number): number | null => {
          let best: number | null = null;
          let bestD = Math.max(14, unit * 0.45) ** 2;
          for (let n = 0; n < NODES; n++) {
            const dx = pos[n].x - x;
            const dy = pos[n].y - y;
            const d = dx * dx + dy * dy;
            if (d < bestD) {
              bestD = d;
              best = n;
            }
          }
          return best;
        };

        /* --------------------------------------------------------- drawing */

        /**
         * The sign: a triangle with a wavy line drawn through it. Traced rather
         * than stamped, because in the books it is a thing you *draw* before
         * you are allowed to start.
         */
        const drawSign = (
          g: CanvasRenderingContext2D,
          cx: number,
          cy: number,
          size: number,
          progress: number,
          stroke: string,
          width: number
        ) => {
          const p = Math.max(0, Math.min(1, progress));
          const tri = Math.min(1, p / 0.6);
          const wave = Math.max(0, (p - 0.6) / 0.4);

          const apex = { x: cx, y: cy - size * 0.62 };
          const left = { x: cx - size * 0.58, y: cy + size * 0.44 };
          const right = { x: cx + size * 0.58, y: cy + size * 0.44 };
          const path = [apex, right, left, apex];

          g.strokeStyle = stroke;
          g.lineWidth = width;
          g.lineJoin = "round";
          g.lineCap = "round";

          g.beginPath();
          g.moveTo(apex.x, apex.y);
          const legs = tri * 3;
          for (let i = 0; i < 3; i++) {
            const t = Math.max(0, Math.min(1, legs - i));
            if (t <= 0) break;
            g.lineTo(
              path[i].x + (path[i + 1].x - path[i].x) * t,
              path[i].y + (path[i + 1].y - path[i].y) * t
            );
          }
          g.stroke();

          if (wave <= 0) return;
          g.beginPath();
          const x0 = cx - size * 0.74;
          const span = size * 1.48;
          const steps = 48;
          for (let i = 0; i <= steps * wave; i++) {
            const t = i / steps;
            const x = x0 + span * t;
            const y = cy + size * 0.16 + Math.sin(t * Math.PI * 6) * size * 0.15;
            if (i === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.stroke();
        };

        const drawArrow = (
          g: CanvasRenderingContext2D,
          from: { x: number; y: number },
          to: { x: number; y: number },
          colour: string
        ) => {
          const mx = (from.x + to.x) / 2;
          const my = (from.y + to.y) / 2;
          const a = Math.atan2(to.y - from.y, to.x - from.x);
          const s = Math.max(3.5, unit * 0.14);
          g.beginPath();
          g.moveTo(mx + Math.cos(a) * s, my + Math.sin(a) * s);
          g.lineTo(mx + Math.cos(a + 2.5) * s, my + Math.sin(a + 2.5) * s);
          g.lineTo(mx + Math.cos(a - 2.5) * s, my + Math.sin(a - 2.5) * s);
          g.closePath();
          g.fillStyle = colour;
          g.fill();
        };

        const drawSnake = (g: CanvasRenderingContext2D, x: number, y: number, r: number) => {
          g.beginPath();
          for (let i = 0; i <= 12; i++) {
            const t = i / 12;
            const px = x - r * 0.62 + r * 1.24 * t;
            const py = y + Math.sin(t * Math.PI * 2) * r * 0.34;
            if (i === 0) g.moveTo(px, py);
            else g.lineTo(px, py);
          }
          g.stroke();
        };

        const drawFox = (g: CanvasRenderingContext2D, x: number, y: number, r: number) => {
          g.beginPath();
          g.moveTo(x, y - r * 0.55);
          g.lineTo(x + r * 0.55, y + r * 0.42);
          g.lineTo(x - r * 0.55, y + r * 0.42);
          g.closePath();
          g.stroke();
        };

        const draw = (st: Stage, dt: number) => {
          const { g, w, h } = st;
          const c = palette();
          g.clearRect(0, 0, w, h);

          if (flashFor > 0) flashFor -= dt;

          const centre = pos[CENTRE];
          const radius = unit * RINGS;

          // The sign sits under the web the whole game, faint. During the
          // ritual it is the only thing on screen and it is being drawn.
          drawSign(
            g,
            centre.x,
            centre.y,
            radius * 0.95,
            phase === "ritual" ? Math.min(1, ritualT / 2.2) : 1,
            withAlpha(c.magenta, phase === "ritual" ? 0.85 : 0.16),
            phase === "ritual" ? 2 : 1.5
          );

          if (phase !== "ritual") {
            /* ---- the web ---- */
            // No edge is reversible, so every line is drawn exactly once and
            // every line gets an arrowhead. An earlier version carried a
            // two-way case and a de-duplicating set; both were dead the moment
            // the spokes became one-way, and a dead branch in a draw loop reads
            // like the board still has lines that go both ways.
            //
            // Spokes are tinted by which way they carry you and rings are left
            // neutral, because "which of these takes me home" is the question
            // the player asks on every single turn, and counting arrowheads to
            // answer it is a worse game than seeing it.
            g.lineWidth = 1;
            for (let a = 0; a < NODES; a++) {
              const ra = ringOf(a);
              for (const b of WEB.out[a]) {
                const radial = ra !== ringOf(b);
                const outward = ringOf(b) > ra;
                g.strokeStyle = radial
                  ? withAlpha(outward ? c.ember : c.cyan, 0.3)
                  : withAlpha(c.dim, 0.3);
                g.beginPath();
                g.moveTo(pos[a].x, pos[a].y);
                g.lineTo(pos[b].x, pos[b].y);
                g.stroke();
                drawArrow(
                  g,
                  pos[a],
                  pos[b],
                  radial
                    ? withAlpha(outward ? c.ember : c.cyan, 0.45)
                    : withAlpha(c.dim, 0.45)
                );
              }
            }

            /* ---- the two places that matter ---- */
            // Both ends of the errand, marked. Without this the rim is just
            // the outermost row of dots and the player has no idea how far
            // out "out" is until they get there.
            g.strokeStyle = withAlpha(c.cyan, 0.3);
            g.lineWidth = 1.5;
            g.beginPath();
            g.arc(centre.x, centre.y, unit * 0.42, 0, Math.PI * 2);
            g.stroke();

            g.save();
            g.strokeStyle = withAlpha(c.cyan, 0.22);
            g.lineWidth = 1;
            g.setLineDash([3, 6]);
            g.beginPath();
            g.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
            g.stroke();
            g.restore();

            /* ---- nodes ---- */
            for (let n = 0; n < NODES; n++) {
              g.beginPath();
              g.arc(pos[n].x, pos[n].y, 2, 0, Math.PI * 2);
              g.fillStyle = withAlpha(c.dim, 0.5);
              g.fill();
            }

            /* ---- legal destinations for the selected disc ---- */
            if (selected !== null && phase === "player") {
              const from = humans[selected];
              if (from.alive && !from.home && from.movesLeft > 0) {
                for (const m of WEB.out[from.node]) {
                  g.beginPath();
                  g.arc(pos[m].x, pos[m].y, Math.max(7, unit * 0.24), 0, Math.PI * 2);
                  g.strokeStyle = withAlpha(c.cyan, 0.75);
                  g.lineWidth = 1.4;
                  g.stroke();
                }
              }
            }

            /* ---- hunters ---- */
            const byNode = new Map<string, Hunter[]>();
            for (const hu of hunters) {
              const key = `${hu.node}:${hu.kind}:${hu.stacked ? "s" : "b"}`;
              const list = byNode.get(key);
              if (list) list.push(hu);
              else byNode.set(key, [hu]);
            }
            const disc = Math.max(6, unit * 0.3);
            for (const list of byNode.values()) {
              const hu = list[0];
              const p = pos[hu.node];
              const bound = list.some((x) => x.frozen > 0);
              const tint = hu.kind === "fox" ? c.ember : c.magenta;
              // A corner that has released some of its pile holds two groups on
              // one node — the pieces still stacked and the ones now on the web.
              // Sitting the stack just outside the node was not enough clearance:
              // the discs overlapped and the two counts collided into one
              // unreadable smear. It goes well clear of the rim instead.
              const ang = Math.atan2(p.y - centre.y, p.x - centre.x);
              const off = hu.stacked ? disc * 2.1 : 0;
              const x = p.x + Math.cos(ang) * off;
              const y = p.y + Math.sin(ang) * off;

              // A corner pile is drawn as a pile — up to three discs stepped
              // back along its own radius. The books stack them at the corners
              // and a single disc with a number beside it reads as one piece
              // with a label, not as five pieces waiting.
              const layers = hu.stacked ? Math.min(3, list.length) : 1;
              for (let k = layers - 1; k >= 0; k--) {
                const lift = k * disc * 0.42;
                const lx = x + Math.cos(ang) * lift;
                const ly = y + Math.sin(ang) * lift;
                g.beginPath();
                g.arc(lx, ly, disc, 0, Math.PI * 2);
                g.fillStyle = withAlpha(tint, hu.stacked ? 0.14 : 0.3);
                g.fill();
                g.strokeStyle = withAlpha(bound ? c.cyan : tint, k === 0 ? (bound ? 1 : 0.85) : 0.4);
                g.lineWidth = bound ? 2 : 1.2;
                g.stroke();
              }

              // Only the disc on top is inked; the ones behind it are edges.
              g.strokeStyle = withAlpha(tint, 0.95);
              g.lineWidth = 1.2;
              if (hu.kind === "snake") drawSnake(g, x, y, disc);
              else drawFox(g, x, y, disc);

              if (list.length > 1) {
                // A stack labels itself further out along its own radius; a
                // group on the web labels itself below. Two groups on one node
                // then never write over each other.
                const tx = hu.stacked
                  ? x + Math.cos(ang) * disc * 2.6
                  : x;
                const ty = hu.stacked
                  ? y + Math.sin(ang) * disc * 2.6
                  : y + disc * 1.9;
                g.fillStyle = withAlpha(c.text, 0.85);
                g.font = "9px ui-monospace, monospace";
                g.textAlign = "center";
                g.textBaseline = "middle";
                g.fillText(String(list.length), tx, ty);
                g.textAlign = "left";
                g.textBaseline = "alphabetic";
              }
            }

            /* ---- the two black discs ---- */
            humans.forEach((hu, i) => {
              if (!hu.alive || hu.home) return;
              const p = pos[hu.node];
              // Two discs on one node would sit exactly on top of each other.
              const twin = humans.some((o, j) => j !== i && o.alive && !o.home && o.node === hu.node);
              const nudge = twin ? (i === 0 ? -disc * 0.7 : disc * 0.7) : 0;
              const x = p.x + nudge;
              const y = p.y;

              // A soft halo, because two small black discs on a dark web are
              // genuinely hard to find once a dozen hunters are on the board.
              const halo = g.createRadialGradient(x, y, disc * 0.6, x, y, disc * 2.4);
              halo.addColorStop(0, withAlpha(hu.warded ? c.ember : c.cyan, 0.3));
              halo.addColorStop(1, withAlpha(hu.warded ? c.ember : c.cyan, 0));
              g.fillStyle = halo;
              g.beginPath();
              g.arc(x, y, disc * 2.4, 0, Math.PI * 2);
              g.fill();

              g.beginPath();
              g.arc(x, y, disc * 1.05, 0, Math.PI * 2);
              g.fillStyle = "rgba(4, 6, 14, 0.94)";
              g.fill();
              g.strokeStyle = selected === i ? c.cyan : withAlpha(c.text, 0.8);
              g.lineWidth = selected === i ? 2.2 : 1.4;
              g.stroke();

              // Courage, while it is still holding.
              if (hu.warded) {
                g.beginPath();
                g.arc(x, y, disc * 1.45, 0, Math.PI * 2);
                g.strokeStyle = withAlpha(c.ember, 0.8);
                g.lineWidth = 1.2;
                g.stroke();
              }

              // A disc that has touched the rim is turned for home, and that is
              // the single most important thing about it.
              if (hu.leg === "back") {
                g.beginPath();
                g.arc(x, y, disc * 0.42, 0, Math.PI * 2);
                g.fillStyle = withAlpha(c.cyan, 0.95);
                g.fill();
              }

              // Steps this disc has left, as pips. Without them there is no way
              // to know whether you have already spent your turn.
              if (phase === "player" && hu.movesLeft > 0) {
                for (let k = 0; k < hu.movesLeft; k++) {
                  const px = x + (k - (hu.movesLeft - 1) / 2) * 5;
                  g.beginPath();
                  g.arc(px, y + disc * 1.75, 1.6, 0, Math.PI * 2);
                  g.fillStyle = withAlpha(c.cyan, 0.85);
                  g.fill();
                }
              }
            });
          }

          /* ---- readout ---- */
          g.font = "10px ui-monospace, monospace";
          g.textBaseline = "top";

          if (phase === "ritual") {
            g.textAlign = "center";
            for (let i = 0; i < RHYME.length; i++) {
              const shown = ritualT > 0.35 + i * 0.45;
              if (!shown) continue;
              g.fillStyle = withAlpha(c.text, 0.9);
              g.font = i === RHYME.length - 1 ? "12px ui-monospace, monospace" : "11px ui-monospace, monospace";
              g.fillText(RHYME[i], w / 2, 16 + i * 16);
            }
            if (ritualT > 2.4) {
              g.fillStyle = withAlpha(c.dim, 0.8);
              g.font = "10px ui-monospace, monospace";
              g.fillText("the sign is drawn \u2014 the game opens", w / 2, h - 22);
            }
            g.textAlign = "left";
          } else {
            const alive = humans.filter((x) => x.alive && !x.home).length;
            const rim = humans.filter((x) => x.leg === "back" && x.alive).length;
            g.fillStyle = withAlpha(c.dim, 0.9);
            g.fillText(`turn ${turn}`, 8, 8);
            g.fillText(`discs ${alive} \u00b7 turned ${rim} \u00b7 home ${humans.filter((x) => x.home).length}`, 8, 22);

            const banners: string[] = [];
            if (humans.some((x) => x.alive && !x.home && x.warded)) banners.push("warded");
            if (blindTurns > 0) banners.push(`blinded ${blindTurns}`);
            if (dazzleTurns > 0) banners.push(`music ${dazzleTurns}`);
            if (banners.length) {
              g.fillStyle = withAlpha(c.cyan, 0.9);
              g.textAlign = "right";
              g.fillText(banners.join("  "), w - 8, 8);
              g.textAlign = "left";
            }

            // The dice, along the bottom: triangles bought fox steps, waves
            // bought snake steps.
            if (dice.length) {
              const box = 15;
              const gap = 4;
              const total = dice.length * box + (dice.length - 1) * gap;
              let x = (w - total) / 2;
              const y = h - box - 6;
              for (const d of dice) {
                const tint = d === "fox" ? c.ember : c.magenta;
                g.strokeStyle = withAlpha(tint, 0.7);
                g.lineWidth = 1;
                g.strokeRect(x, y, box, box);
                g.strokeStyle = withAlpha(tint, 1);
                if (d === "fox") drawFox(g, x + box / 2, y + box / 2, box * 0.44);
                else drawSnake(g, x + box / 2, y + box / 2, box * 0.44);
                x += box + gap;
              }
            }

            // The spokes are tinted by which way they carry you, so the board
            // needs to say which tint is which. Two short strokes cost less
            // room than a sentence and are read faster.
            {
              const ly = h - 12;
              const keys: [string, string][] = [
                [c.ember, "out"],
                [c.cyan, "home"],
              ];
              let lx = 8;
              g.font = "9px ui-monospace, monospace";
              g.textBaseline = "middle";
              for (const [colour, label] of keys) {
                g.strokeStyle = withAlpha(colour, 0.75);
                g.lineWidth = 1.5;
                g.beginPath();
                g.moveTo(lx, ly);
                g.lineTo(lx + 10, ly);
                g.stroke();
                g.fillStyle = withAlpha(c.dim, 0.85);
                g.fillText(label, lx + 14, ly);
                lx += 18 + g.measureText(label).width + 12;
              }
              g.textBaseline = "top";
            }

            if (flashFor > 0 && flash) {
              g.fillStyle = withAlpha(c.text, Math.min(1, flashFor));
              g.textAlign = "center";
              g.font = "11px ui-monospace, monospace";
              g.fillText(flash, w / 2, h - 42);
              g.textAlign = "left";
            }
          }

          if (phase === "over") {
            g.fillStyle = "rgba(4, 6, 14, 0.72)";
            g.fillRect(0, 0, w, h);
            g.textAlign = "center";
            g.font = "12px ui-monospace, monospace";
            const lines = outcome.split("\n");
            lines.forEach((l, i) => {
              g.fillStyle = withAlpha(i === 0 ? c.text : c.dim, 0.95);
              g.fillText(l, w / 2, h / 2 - 10 + i * 18);
            });
            g.font = "10px ui-monospace, monospace";
            g.fillStyle = withAlpha(c.dim, 0.75);
            g.fillText("click anywhere to draw the sign again", w / 2, h / 2 + 44);
            g.textAlign = "left";
          }

          g.textBaseline = "alphabetic";
        };

        /* --------------------------------------------------------- chrome */

        const boonButtons = new Map<Boon, HTMLButtonElement>();
        let rollBtn: HTMLButtonElement | null = null;

        const syncButtons = () => {
          if (rollBtn) {
            rollBtn.disabled = phase !== "player";
            rollBtn.textContent = phase === "hunt" ? "the hunt" : "roll";
            rollBtn.classList.toggle("on", phase === "player");
          }
          for (const [id, btn] of boonButtons) {
            btn.disabled = spent[id] || phase !== "player";
            btn.classList.toggle("on", !spent[id] && phase === "player");
            // Struck through once used. Dimming says "not now"; only this says
            // "never again", and with four one-shot boons that is the thing the
            // player actually needs to see.
            btn.classList.toggle("spent", spent[id]);
          }
        };

        const stop = mountStage(stageHost, {
          className: "web-canvas",
          layout: relayout,
          frame: (st, dt) => {
            if (phase === "ritual") {
              ritualT += dt;
              if (ritualT > RITUAL_END) {
                phase = "player";
                say("get to the rim and back \u2014 do not be touched", 3.4);
                syncButtons();
              }
            } else if (phase === "hunt") {
              advanceHunt(dt);
            }
            draw(st, dt);
          },
        });

        const onClick = (e: MouseEvent) => {
          // Clicking through the ritual skips the rest of the tracing.
          if (phase === "ritual") {
            ritualT = RITUAL_END + 0.1;
            return;
          }
          // The overlay is the whole canvas, so anywhere on it starts again.
          if (phase === "over") {
            reset();
            return;
          }
          if (phase !== "player") return;

          // `offsetX`, and it has to be `offsetX`. The obvious-looking
          // alternative — `clientX - canvas.getBoundingClientRect().left` — is
          // wrong here and silently so: the compositor floats every panel in 3D,
          // and `getBoundingClientRect` reports the axis-aligned box of the
          // *transformed* element, so every click lands on the wrong node the
          // moment a window is anything but square to the camera. `offsetX` is
          // already in the element's own coordinates, which is what `pos` uses.
          //
          // The listener is on the canvas rather than on the host div so that
          // "the element" is always the canvas; the host has a 1px border that
          // would otherwise be the event target near the edges.
          const node = nodeNear(e.offsetX, e.offsetY);
          if (node === null) return;

          // A disc on the node you clicked takes the click; anything else is
          // read as a move for whatever is already selected.
          const candidates = humans
            .map((hu, i) => ({ hu, i }))
            .filter((x) => x.hu.alive && !x.hu.home && x.hu.node === node && x.hu.movesLeft > 0);

          if (candidates.length) {
            const at = candidates.findIndex((x) => x.i === selected);
            selected = candidates[(at + 1) % candidates.length].i;
            return;
          }
          if (selected !== null) moveHuman(selected, node);
        };

        // mountStage appends the canvas synchronously, so it is here already.
        const webCanvas = stageHost.querySelector("canvas");
        webCanvas?.addEventListener("click", onClick);

        toolButton(bar, "new game", () => reset());
        rollBtn = toolButton(bar, "roll", () => roll());
        for (const boon of BOONS) {
          boonButtons.set(
            boon.id,
            toolButton(bar, boon.label, () => useBoon(boon.id))
          );
        }
        toolButton(bar, "rules", () => {
          ctx.notify(
            `Both black discs must touch the rim and come back to the centre ` +
              `untouched, ${MOVES} steps a turn. Every line on the web runs one ` +
              `way: half the spokes only carry you out, half only carry you home, ` +
              `and the rings \u2014 which alternate direction \u2014 are the only way to ` +
              `change spoke. Six dice say how many pieces hunt you: triangles for ` +
              `foxes, waves for snakes, one step each, always by the shortest ` +
              `path. Each of the four works once, and using any of them is ` +
              `cheating, which is the only way the game has ever been won. ` +
              BOONS.map((b) => `${b.label.toUpperCase()}: ${b.note}`).join(" \u00b7 ") + ".",
            { kind: "info", sticky: true }
          );
        });

        reset();
        syncButtons();

        return () => {
          webCanvas?.removeEventListener("click", onClick);
          stop();
        };
      },
    });
  },
};
