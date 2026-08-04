/**
 * The bits every cabinet needs: a run-length sprite blitter and a bitmap font.
 *
 * These began life inside `joust/sprites.ts` and were lifted out when the
 * second cabinet arrived, because the alternative was four copies of the same
 * forty glyph strings drifting apart. Nothing game-specific lives here — a
 * game's own art stays in its own folder, which is what keeps a cabinet one
 * directory you can delete.
 *
 * The font exists for the reason arcade machines had one: `fillText` at a 3x
 * integer scale renders anti-aliased glyphs over hard pixel art, and that
 * mismatch is the single most obvious way a retro screen looks wrong.
 */

export type SpriteMap = readonly string[];
export type Ink = Record<string, string | undefined>;

/**
 * Draw a string map at (x, y), one pixel per character, optionally mirrored.
 *
 * Runs of a colour become one `fillRect`, so a 20x16 sprite costs about thirty
 * fills instead of three hundred. That matters: at forty formation enemies,
 * a screenful of pellets and a wrap-around double-draw, the naive version is
 * the frame budget.
 */
export function blit(
  g: CanvasRenderingContext2D,
  map: SpriteMap,
  x: number,
  y: number,
  ink: Ink,
  flip = false
): void {
  const w = map[0].length;
  for (let ry = 0; ry < map.length; ry++) {
    const row = map[ry];
    let runCh = "";
    let run = 0;
    for (let rx = 0; rx <= w; rx++) {
      const ch = rx < w ? row[rx] : "";
      if (ch === runCh) {
        run++;
        continue;
      }
      const paint = ink[runCh];
      if (runCh && paint) {
        // Unflipped, the run covers columns [rx-run, rx). Mirrored, column c
        // lands at w-1-c, so the same run starts at w-rx.
        g.fillStyle = paint;
        g.fillRect(flip ? x + w - rx : x + rx - run, y + ry, run, 1);
      }
      runCh = ch;
      run = 1;
    }
  }
}

/**
 * Draw a string map rotated a whole number of quarter turns.
 *
 * Galaga's diving enemies bank and Missile Command's crosshair does not, so
 * this is only used where a sprite genuinely faces a direction the artwork
 * doesn't. Whole turns only: a rotated bitmap at any other angle has to be
 * resampled, and resampled pixel art is the thing this whole module exists to
 * avoid.
 */
export function blitTurned(
  g: CanvasRenderingContext2D,
  map: SpriteMap,
  x: number,
  y: number,
  ink: Ink,
  turns: number
): void {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) {
    blit(g, map, x, y, ink);
    return;
  }
  const h = map.length;
  const w = map[0].length;
  for (let ry = 0; ry < h; ry++) {
    for (let rx = 0; rx < w; rx++) {
      const paint = ink[map[ry][rx]];
      if (!paint) continue;
      let px = rx;
      let py = ry;
      if (t === 1) {
        px = h - 1 - ry;
        py = rx;
      } else if (t === 2) {
        px = w - 1 - rx;
        py = h - 1 - ry;
      } else {
        px = ry;
        py = w - 1 - rx;
      }
      g.fillStyle = paint;
      g.fillRect(x + px, y + py, 1, 1);
    }
  }
}

/* ---------------- the arcade font ---------------- */

const GLYPHS: Record<string, string> = {
  A: ".#.|#.#|###|#.#|#.#",
  B: "##.|#.#|##.|#.#|##.",
  C: ".##|#..|#..|#..|.##",
  D: "##.|#.#|#.#|#.#|##.",
  E: "###|#..|##.|#..|###",
  F: "###|#..|##.|#..|#..",
  G: ".##|#..|#.#|#.#|.##",
  H: "#.#|#.#|###|#.#|#.#",
  I: "###|.#.|.#.|.#.|###",
  J: "..#|..#|..#|#.#|.#.",
  K: "#.#|#.#|##.|#.#|#.#",
  L: "#..|#..|#..|#..|###",
  M: "#.#|###|###|#.#|#.#",
  N: "#.#|###|###|#.#|#.#",
  O: ".#.|#.#|#.#|#.#|.#.",
  P: "##.|#.#|##.|#..|#..",
  Q: ".#.|#.#|#.#|##.|.##",
  R: "##.|#.#|##.|#.#|#.#",
  S: ".##|#..|.#.|..#|##.",
  T: "###|.#.|.#.|.#.|.#.",
  U: "#.#|#.#|#.#|#.#|###",
  V: "#.#|#.#|#.#|#.#|.#.",
  W: "#.#|#.#|###|###|#.#",
  X: "#.#|#.#|.#.|#.#|#.#",
  Y: "#.#|#.#|.#.|.#.|.#.",
  Z: "###|..#|.#.|#..|###",
  "0": "###|#.#|#.#|#.#|###",
  "1": ".#.|##.|.#.|.#.|###",
  "2": "##.|..#|.#.|#..|###",
  "3": "##.|..#|.#.|..#|##.",
  "4": "#.#|#.#|###|..#|..#",
  "5": "###|#..|##.|..#|##.",
  "6": ".##|#..|##.|#.#|.#.",
  "7": "###|..#|.#.|.#.|.#.",
  "8": ".#.|#.#|.#.|#.#|.#.",
  "9": ".#.|#.#|.##|..#|##.",
  "-": "...|...|###|...|...",
  ".": "...|...|...|...|.#.",
  ",": "...|...|...|.#.|#..",
  ":": "...|.#.|...|.#.|...",
  "!": ".#.|.#.|.#.|...|.#.",
  "?": "##.|..#|.#.|...|.#.",
  "'": ".#.|.#.|...|...|...",
  "/": "..#|..#|.#.|#..|#..",
  "+": "...|.#.|###|.#.|...",
  "=": "...|###|...|###|...",
  "*": "#.#|.#.|###|.#.|#.#",
  "%": "#.#|..#|.#.|#..|#.#",
  "(": "..#|.#.|.#.|.#.|..#",
  ")": "#..|.#.|.#.|.#.|#..",
  "<": "..#|.#.|#..|.#.|..#",
  ">": "#..|.#.|..#|.#.|#..",
  "#": "#.#|###|#.#|###|#.#",
  "\u00d7": "...|#.#|.#.|#.#|...",
};

/** Advance per character: three columns and a gap. */
export const CHAR_W = 4;
export const CHAR_H = 5;

/** Width in pixels of `text` rendered at scale 1. */
export function textWidth(text: string, scale = 1): number {
  return Math.max(0, text.length * CHAR_W - 1) * scale;
}

/**
 * Draw uppercase text as hard pixels. Anything the font doesn't know is drawn
 * as a blank, which is the right failure: a missing glyph should cost a space,
 * not throw in the middle of a frame.
 */
export function text(
  g: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  color: string,
  scale = 1
): void {
  g.fillStyle = color;
  let px = x;
  for (const raw of s.toUpperCase()) {
    const glyph = GLYPHS[raw];
    if (glyph) {
      const rows = glyph.split("|");
      for (let ry = 0; ry < rows.length; ry++) {
        const row = rows[ry];
        for (let rx = 0; rx < row.length; rx++) {
          if (row[rx] === "#") {
            g.fillRect(px + rx * scale, y + ry * scale, scale, scale);
          }
        }
      }
    }
    px += CHAR_W * scale;
  }
}

/** Centre `s` on `cx`. */
export function textCentered(
  g: CanvasRenderingContext2D,
  s: string,
  cx: number,
  y: number,
  color: string,
  scale = 1
): void {
  text(g, s, Math.round(cx - textWidth(s, scale) / 2), y, color, scale);
}

/** Right-align `s` so it ends at `rx`. Score readouts grow leftwards. */
export function textRight(
  g: CanvasRenderingContext2D,
  s: string,
  rx: number,
  y: number,
  color: string,
  scale = 1
): void {
  text(g, s, Math.round(rx - textWidth(s, scale)), y, color, scale);
}
