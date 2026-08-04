/**
 * The art. All original, authored here.
 *
 * Atari's artwork is a copyrighted visual work and none of it is reproduced.
 * What is reproduced is the read — a low skyline, a squat battery with its
 * remaining stock stacked visibly on top of it, and a sky full of thin
 * trajectory lines ending in fat unstable balls of light.
 *
 * One decision worth naming: the ammunition is *drawn*, not printed. The
 * original stacks the remaining missiles above each battery as a little
 * pyramid, and that is the single most important readout in the game — a
 * player glances at the shape, not at a number, and decides which end of the
 * map they can still defend. A digit would be more precise and much worse.
 */

import { blit } from "../shared/pixel";
import type { Ink, SpriteMap } from "../shared/pixel";
import { AMMO_PER_BATTERY } from "./rules";

/**
 * A city: 22 by 10, drawn as a skyline rather than a block.
 *
 * The silhouette is doing all the work. At this size the only thing that
 * separates a city from a wall is the ragged top edge, and the ragged top edge
 * is also what makes a destroyed one — the same footprint, flattened to
 * rubble — read as a loss rather than as a missing sprite.
 */
const CITY: SpriteMap = [
  "..........C...........",
  ".....C....C......C....",
  ".CC..C.CC.C..CC..C.C..",
  ".CC..C.CC.C..CC..C.C..",
  ".CCCCC.CC.CCCCCC.CCC..",
  "CCCCCCCCCCCCCCCCCCCCCC",
  "CCwCCwCCCCwCCwCCCCwCCC",
  "CCCCCCCCCCCCCCCCCCCCCC",
  "CwCCCwCCCwCCCwCCCwCCCC",
  "CCCCCCCCCCCCCCCCCCCCCC",
];

/** What is left when one is hit. Same footprint, no skyline. */
const RUBBLE: SpriteMap = [
  "......................",
  "......................",
  "......................",
  "......................",
  "......................",
  "..r....r.....r....r...",
  ".rrr..rrr...rrr..rrr..",
  "rrrrrrrr.rrrrrr.rrrrrr",
  "rrrrrrrrrrrrrrrrrrrrrr",
  "rrrrrrrrrrrrrrrrrrrrrr",
];

const CITY_INK: Ink = { C: "#4fd6e8", w: "#ffe14a" };
const RUBBLE_INK: Ink = { r: "#5a4038" };

export function city(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  alive: boolean
): void {
  blit(g, alive ? CITY : RUBBLE, x, y, alive ? CITY_INK : RUBBLE_INK);
}

/**
 * A battery, and its stock.
 *
 * The pyramid is generated from the count rather than authored per state,
 * which is the difference between one function and eleven bitmaps — and it
 * means the shape degrades continuously as the wave goes on, which is exactly
 * the information the player is reading.
 */
export function battery(
  g: CanvasRenderingContext2D,
  cx: number,
  y: number,
  ammo: number,
  live: boolean
): void {
  g.fillStyle = live ? "#4fd6e8" : "#5a4038";
  g.fillRect(cx - 7, y + 2, 15, 4);
  g.fillRect(cx - 4, y - 1, 9, 3);
  if (!live) return;

  // Four rows of stock, widest at the bottom: 4, 3, 2, 1.
  const rows = [4, 3, 2, 1];
  let left = Math.min(ammo, AMMO_PER_BATTERY);
  let ry = y - 3;
  for (const width of rows) {
    const n = Math.min(left, width);
    for (let i = 0; i < n; i++) {
      const x = cx - (width - 1) * 1.5 + i * 3;
      g.fillStyle = "#ffe14a";
      g.fillRect(Math.round(x) - 1, ry, 2, 2);
    }
    left -= n;
    ry -= 3;
    if (left <= 0) break;
  }
}

/**
 * A blast: a hard-edged disc that cycles through colours.
 *
 * Rasterised per pixel rather than drawn with `arc()` for the reason the whole
 * arcade folder rasterises things — an anti-aliased edge next to hard pixel
 * art is the most visible way a retro screen goes wrong. The colour cycling is
 * not decoration either: it is the only cue that distinguishes a blast that is
 * still growing from one that is about to disappear, and the player is timing
 * against exactly that.
 */
export function blast(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  phase: number
): void {
  if (r < 0.5) return;
  const ring = ["#ffe14a", "#ff8a3c", "#ff4a5c", "#f4f6ff", "#4fd6e8"];
  const r2 = r * r;
  const ri = Math.floor(phase * 14) % ring.length;
  g.fillStyle = ring[ri];
  for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
    const span = Math.floor(Math.sqrt(Math.max(0, r2 - dy * dy)));
    if (span <= 0) continue;
    g.fillRect(Math.round(cx - span), Math.round(cy + dy), span * 2, 1);
  }
  // A hotter core, offset in the cycle, so the ball churns instead of pulsing.
  const inner = r * 0.55;
  if (inner < 1) return;
  g.fillStyle = ring[(ri + 2) % ring.length];
  for (let dy = -Math.ceil(inner); dy <= Math.ceil(inner); dy++) {
    const span = Math.floor(Math.sqrt(Math.max(0, inner * inner - dy * dy)));
    if (span <= 0) continue;
    g.fillRect(Math.round(cx - span), Math.round(cy + dy), span * 2, 1);
  }
}

/** The aiming reticle. Deliberately open in the middle: it must not hide a target. */
export function crosshair(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string
): void {
  const cx = Math.round(x);
  const cy = Math.round(y);
  g.fillStyle = color;
  for (const d of [-5, -4, 4, 5]) {
    g.fillRect(cx + d, cy, 1, 1);
    g.fillRect(cx, cy + d, 1, 1);
  }
  g.fillRect(cx - 1, cy - 1, 1, 1);
  g.fillRect(cx + 1, cy - 1, 1, 1);
  g.fillRect(cx - 1, cy + 1, 1, 1);
  g.fillRect(cx + 1, cy + 1, 1, 1);
}

/** The aircraft that cross the top of the screen dropping more of them. */
export function plane(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  facing: number,
  satellite: boolean
): void {
  const cx = Math.round(x);
  const cy = Math.round(y);
  if (satellite) {
    g.fillStyle = "#c05cff";
    g.fillRect(cx - 3, cy - 2, 6, 5);
    g.fillStyle = "#9fe8ff";
    g.fillRect(cx - 9, cy - 1, 5, 3);
    g.fillRect(cx + 4, cy - 1, 5, 3);
    return;
  }
  g.fillStyle = "#ff8a3c";
  g.fillRect(cx - 6, cy - 1, 12, 3);
  g.fillRect(cx + facing * 6, cy, 3, 1);
  g.fillStyle = "#ffe14a";
  g.fillRect(cx - 2, cy - 3, 4, 2);
  g.fillRect(cx - 5, cy + 2, 10, 1);
}
