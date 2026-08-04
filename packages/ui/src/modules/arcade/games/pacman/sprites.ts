/**
 * The art. All original, authored here.
 *
 * To be explicit, as `joust/sprites.ts` is: Namco's tile and sprite ROMs are a
 * copyrighted visual work and none of them are reproduced. What is reproduced
 * is the *read* — a disc with a wedge bitten out of it, four sheeted things
 * with human eyes, a scattering of dots — drawn from scratch on the same 8px
 * grid the original had to work on.
 *
 * Two of these are rasterised rather than authored as bitmaps, for the reason
 * `AGENTS.md` gives: anything that animates through a range is cheaper and
 * smoother drawn from the phase. Pac-Man's mouth is a continuously opening
 * wedge and the maze walls are edge-detected off the level data, so both are
 * computed. The ghosts have a fixed silhouette and are string maps.
 */

import { blit } from "../shared/pixel";
import type { Ink, SpriteMap } from "../shared/pixel";

/**
 * Pac-Man, rasterised.
 *
 * A filled disc minus an angular wedge, tested per pixel and drawn as hard
 * squares — which is the point. `arc()` plus `fill()` would be one line and
 * would put a soft anti-aliased edge on the one sprite the player looks at
 * most, next to a maze made of exact pixels. The mismatch is instantly
 * visible and is the thing that makes emulator-adjacent art look wrong.
 *
 * `open` runs 0 (mouth shut, a full circle) to 1 (mouth at its widest). The
 * original opens to a little over a quarter turn; wider than that and the
 * silhouette stops reading as a head.
 */
export function pac(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  dir: number,
  open: number,
  color: string
): void {
  // DIRS order is up, left, down, right; canvas angles grow clockwise from
  // east, so this is the same list expressed as headings.
  const heading = [-Math.PI / 2, Math.PI, Math.PI / 2, 0][dir] ?? 0;
  const half = (open * Math.PI) / 3.2;
  const r2 = radius * radius;
  g.fillStyle = color;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      if (half > 0.02) {
        // Angle to this pixel relative to the way he is facing, folded into
        // [-pi, pi] so the comparison works across the seam at due west.
        let a = Math.atan2(dy, dx) - heading;
        while (a > Math.PI) a -= Math.PI * 2;
        while (a < -Math.PI) a += Math.PI * 2;
        if (Math.abs(a) < half) continue;
      }
      g.fillRect(Math.round(cx + dx), Math.round(cy + dy), 1, 1);
    }
  }
}

/**
 * A ghost, 14 wide and 14 tall, in two skirt frames.
 *
 * The skirt is the whole animation and the whole character: the body never
 * changes, the hem just alternates between two phases so the thing looks like
 * it is *hovering* rather than sliding. Two frames is all the original used
 * and all this needs.
 *
 * `B` is the body. Eyes are drawn on top rather than baked in, because they
 * track the direction of travel and are the only part that survives when the
 * ghost is eaten.
 */
const GHOST_TOP: SpriteMap = [
  "....BBBBBB....",
  "..BBBBBBBBBB..",
  ".BBBBBBBBBBBB.",
  ".BBBBBBBBBBBB.",
  "BBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBB",
  "BBBBBBBBBBBBBB",
];

const SKIRT_A: SpriteMap = [
  "BBBBBBBBBBBBBB",
  "BB..BB..BB..BB",
];

const SKIRT_B: SpriteMap = [
  "BBB..BBBB..BBB",
  "BB....BB....BB",
];

export const GHOST_W = 14;
export const GHOST_H = 14;

/** Pupil offsets, indexed the same way as `DIRS`: up, left, down, right. */
const PUPIL: readonly (readonly [number, number])[] = [
  [0, -1],
  [-1, 0],
  [0, 1],
  [1, 0],
];

/**
 * Draw a ghost with its body colour and its eyes looking where it is going.
 *
 * `eyesOnly` is the eaten state: the sheet is gone and a pair of eyes hurries
 * back to the house on its own. It is the same call because it has to be the
 * same *shape* — a player tracking a returning ghost is tracking those eyes.
 */
export function ghost(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  dir: number,
  frame: number,
  body: string,
  eyesOnly = false
): void {
  if (!eyesOnly) {
    const ink: Ink = { B: body };
    blit(g, GHOST_TOP, x, y, ink);
    blit(g, frame === 0 ? SKIRT_A : SKIRT_B, x, y + 12, ink);
  }
  const [px, py] = PUPIL[dir] ?? PUPIL[3];
  for (const ex of [3, 8]) {
    g.fillStyle = "#f4f6ff";
    g.fillRect(x + ex, y + 4, 3, 4);
    g.fillStyle = "#2030c8";
    g.fillRect(x + ex + 1 + px, y + 5 + py, 2, 2);
  }
}

/**
 * The frightened ghost: blue sheet, blank staring eyes, a flat zigzag mouth.
 *
 * White in the last seconds is not decoration — it is the only warning the
 * player gets that the energizer is running out, and the number of flashes is
 * on the level table because the original varies it.
 */
export function ghostScared(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  frame: number,
  white: boolean
): void {
  const body = white ? "#f4f6ff" : "#2030c8";
  const face = white ? "#e0342a" : "#ffb2df";
  const ink: Ink = { B: body };
  blit(g, GHOST_TOP, x, y, ink);
  blit(g, frame === 0 ? SKIRT_A : SKIRT_B, x, y + 12, ink);
  g.fillStyle = face;
  g.fillRect(x + 4, y + 5, 2, 2);
  g.fillRect(x + 8, y + 5, 2, 2);
  for (let i = 0; i < 5; i++) {
    g.fillRect(x + 2 + i * 2, y + (i % 2 === 0 ? 10 : 9), 2, 1);
    g.fillRect(x + 2 + i * 2, y + (i % 2 === 0 ? 9 : 10), 1, 1);
  }
}

/**
 * A prize, drawn from two colours.
 *
 * Deliberately not eight hand-authored bitmaps: at 12 pixels the difference
 * between an apple and a melon is the colour and a stem, and eight maps that
 * differ in four pixels each would be data pretending to be art.
 */
export function fruit(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: string,
  accent: string
): void {
  g.fillStyle = color;
  g.fillRect(cx - 4, cy - 2, 8, 6);
  g.fillRect(cx - 3, cy - 4, 6, 2);
  g.fillRect(cx - 5, cy - 1, 1, 4);
  g.fillRect(cx + 4, cy - 1, 1, 4);
  g.fillStyle = accent;
  g.fillRect(cx - 1, cy - 7, 2, 3);
  g.fillRect(cx + 1, cy - 8, 3, 1);
}
