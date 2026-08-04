/**
 * The art. All original, authored here.
 *
 * Namco's sprite ROMs are a copyrighted visual work and none of them are
 * reproduced. What is reproduced is the read: a white arrowhead with red
 * wings, a blue-and-yellow bug, a red-and-cream moth, and a green-crested
 * thing that is obviously the boss of the other two. Drawn from scratch on the
 * same 16px grid the original worked on.
 *
 * The rule from `AGENTS.md` that mattered most here is silhouette over detail.
 * At thirteen pixels across, a butterfly and a bee differ by about nine pixels
 * and the player has to tell them apart *while both are diving*. So the
 * difference is put in the outline — the butterfly's wings sweep back past its
 * body, the bee's are stubby and level — rather than in the shading, which at
 * this size is invisible in motion.
 */

import { blit } from "../shared/pixel";
import type { Ink, SpriteMap } from "../shared/pixel";

/**
 * The player's fighter: an arrowhead, because it has to read as *pointing* at
 * the formation from across a screen full of noise.
 */
export const FIGHTER: SpriteMap = [
  "......W......",
  "......W......",
  ".....WWW.....",
  ".....WWW.....",
  "....WWWWW....",
  "R...WWWWW...R",
  "RR.WWWWWWW.RR",
  "RRWWWWWWWWWRR",
  "RRWWWWWWWWWRR",
  "RRWWWWWWWWWRR",
  "RR.WW.W.WW.RR",
  ".R..W.....W..",
];

const FIGHTER_INK: Ink = { W: "#e8ecff", R: "#e83c3c" };
const FIGHTER_GHOST: Ink = { W: "#5a6288", R: "#6a3040" };

export function fighter(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  dim = false
): void {
  blit(g, FIGHTER, x, y, dim ? FIGHTER_GHOST : FIGHTER_INK);
}

/**
 * The bee — the cheap one, and the one there are twenty of.
 *
 * Stubby level wings and a fat body. Blue with a yellow core, so that a
 * screenful of them still reads as a texture rather than as forty separate
 * things demanding attention.
 */
const BEE: SpriteMap = [
  "..B.......B..",
  "..BB.....BB..",
  "...BB...BB...",
  "..YYBBBBBYY..",
  ".YYYYBBBYYYY.",
  "YYYBBBBBBBYYY",
  ".BBBYYYYYBBB.",
  "..BB.YYY.BB..",
  "...B..Y..B...",
];

/**
 * The butterfly. Wings swept back past the body, which is the whole tell.
 */
const BUTTERFLY: SpriteMap = [
  "R...........R",
  "RR....C....RR",
  "RRR..CCC..RRR",
  ".RRRCCCCCRRR.",
  "..RRCCCCCRR..",
  ".RRRCCCCCRRR.",
  "RRR.CC.CC.RRR",
  "RR...C.C...RR",
  "R....C.C....R",
];

/**
 * The boss. Bigger, crested, and green until you hit it once.
 *
 * The colour change on the first hit is not decoration — it is the only way to
 * know a boss is one shot from dying, and that information is what makes going
 * after one during a dive a calculated act instead of a gamble.
 */
const BOSS: SpriteMap = [
  "....G.G.G....",
  "...GGGGGGG...",
  "..GGCCCCCGG..",
  ".GGCCCCCCCGG.",
  "GGCCCGGGCCCGG",
  "GGCCGGGGGCCGG",
  ".GGCCGGGCCGG.",
  "..GG.GGG.GG..",
  "...G..G..G...",
];

export const ENEMY_W = 13;
export const ENEMY_H = 9;

const BEE_INK: Ink = { B: "#3f7bff", Y: "#ffd23c" };
const BUTTERFLY_INK: Ink = { R: "#e83c3c", C: "#f4e8c8" };
const BOSS_INK_FULL: Ink = { G: "#3fd86a", C: "#3f6bff" };
const BOSS_INK_HURT: Ink = { G: "#c05cff", C: "#ffd23c" };

/**
 * Draw an enemy. `wing` alternates the two outermost columns so the whole
 * formation flutters — one frame of animation across forty sprites, which is
 * what stops the rack looking painted on.
 */
export function enemy(
  g: CanvasRenderingContext2D,
  kind: "bee" | "butterfly" | "boss",
  x: number,
  y: number,
  wing: number,
  hurt: boolean
): void {
  const map = kind === "bee" ? BEE : kind === "butterfly" ? BUTTERFLY : BOSS;
  const ink =
    kind === "bee"
      ? BEE_INK
      : kind === "butterfly"
        ? BUTTERFLY_INK
        : hurt
          ? BOSS_INK_HURT
          : BOSS_INK_FULL;
  blit(g, map, x, y + (wing === 0 ? 0 : 1), ink);
  if (wing === 1) {
    // A one-pixel wing lift, drawn rather than authored as a second bitmap.
    const tint = kind === "bee" ? "#3f7bff" : kind === "butterfly" ? "#e83c3c" : "#3fd86a";
    g.fillStyle = tint;
    g.fillRect(x, y + 1, 1, 2);
    g.fillRect(x + ENEMY_W - 1, y + 1, 1, 2);
  }
}

/**
 * The explosion: expanding rings of hard pixels, drawn from a phase.
 *
 * Four hand-authored frames is what the original had and what this would
 * otherwise be; a phase is smaller, scales to any size, and lets the player
 * explosion be the same call at twice the radius, which is exactly the
 * relationship the two have on screen.
 */
export function boom(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  phase: number,
  scale: number,
  hot: string,
  cool: string
): void {
  const r = phase * 12 * scale;
  const spokes = 8;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + phase * 1.4;
    const d = r * (i % 2 === 0 ? 1 : 0.62);
    const px = Math.round(cx + Math.cos(a) * d);
    const py = Math.round(cy + Math.sin(a) * d);
    const s = Math.max(1, Math.round(3 * scale * (1 - phase)));
    g.fillStyle = phase < 0.5 ? hot : cool;
    g.fillRect(px - (s >> 1), py - (s >> 1), s, s);
  }
  if (phase < 0.45) {
    const s = Math.max(1, Math.round(5 * scale * (1 - phase * 2)));
    g.fillStyle = hot;
    g.fillRect(Math.round(cx) - (s >> 1), Math.round(cy) - (s >> 1), s, s);
  }
}

/**
 * The starfield.
 *
 * `AGENTS.md` says black backgrounds, and it is right, with this exception:
 * Galaga's stars are not a background drawn behind the sprites in software,
 * they are a dedicated circuit on the board that generates them as the beam
 * scans. It is the one moving background the hardware genuinely could do, it
 * is the first thing on screen before an attract mode even starts, and leaving
 * it out would be a more visible error than putting it in.
 *
 * Generated from an index rather than stored, so a hundred and twenty stars
 * cost no memory and are identical every run.
 */
export function stars(
  g: CanvasRenderingContext2D,
  t: number,
  w: number,
  h: number,
  count: number
): void {
  for (let i = 0; i < count; i++) {
    // Three layers at different rates, which is the parallax.
    const layer = i % 3;
    const speed = 14 + layer * 13;
    const x = (i * 71) % w;
    const y = ((i * 149) % h) + ((t * speed) % h);
    const py = Math.floor(y % h);
    // Twinkle: each star has its own period, so they never pulse in unison.
    const on = Math.sin(t * (1.6 + (i % 7) * 0.42) + i) > -0.35;
    if (!on) continue;
    g.fillStyle = ["#6f78a8", "#9fb0e8", "#e8ecff"][layer];
    g.fillRect(x, py, 1, 1);
  }
}
