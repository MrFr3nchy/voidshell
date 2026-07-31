/**
 * The art. All of it original, drawn here as data rather than copied from
 * anywhere — a knight on a long-necked bird is a silhouette, not an asset, and
 * this is the void's version of it.
 *
 * Two techniques, chosen per part:
 *
 * - Anything that never changes shape (the body, the rider, an egg) is a
 *   string map, one character per pixel, run-length blitted. Cheap to author,
 *   cheap to read, and trivially recolourable — the three enemy tiers are the
 *   same map with a different ink table, which is exactly how the original
 *   distinguished them and why tier is readable at a glance.
 * - Anything that moves through a range (wings, the pterodactyl, the troll's
 *   hand) is drawn procedurally from the animation phase. Authoring eight flap
 *   frames by hand would be eight times the data and still less smooth.
 *
 * The font is here for the same reason arcade machines had one: `fillText` at
 * a 3x integer scale renders anti-aliased glyphs over hard pixel art and the
 * mismatch is the single most obvious way a retro screen looks wrong.
 */

export type SpriteMap = readonly string[];
export type Ink = Record<string, string | undefined>;

/**
 * Draw a string map at (x, y), one pixel per character, optionally mirrored.
 *
 * Runs of a colour become one `fillRect`, so a 20x16 sprite costs about thirty
 * fills instead of three hundred. That matters: at eight riders, a dozen eggs
 * and a wrap-around double-draw, the naive version is the frame budget.
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

/* ---------------- the rider ---------------- */

/**
 * Knight and mount, facing right. `A`/`a` armour and its shade, `B`/`b` the
 * bird, `L` the lance, `Y` beak and legs, `E` the eye.
 *
 * The lance tip sits on row 0 deliberately: combat compares the *top of the
 * sprite*, so the art and the rule agree by construction and there is no
 * separate lance-height field to drift out of sync with the drawing.
 */
export const RIDER: SpriteMap = [
  "..........LL........",
  ".........LL.........",
  "...AAA..LL..........",
  "..AAAAALL...........",
  "..AaAAA......BEY....",
  "...AAA.......BBY....",
  "..AAAAA.....BBB.....",
  ".BBBBBBBBBBBB.......",
  "BBBBBBBBBBBB........",
  "BbBBBBBBBBB.........",
  ".bbBBBBBBb..........",
  "..bb...bb...........",
  "..Y.....Y...........",
  "..Y.....Y...........",
  ".YYY...YYY..........",
  "....................",
];

/** A rider with no mount — hatched from an egg, or freshly unhorsed. */
export const WALKER: SpriteMap = [
  "..AAA...",
  ".AAAAA..",
  ".AaAAA..",
  "..AAA...",
  ".AAAAA..",
  "AAAAAAA.",
  ".AAAAA..",
  "..A.A...",
  "..A.A...",
  ".AA.AA..",
];

export const EGG: SpriteMap = [
  "..BBB..",
  ".BBBBB.",
  "BBBBBBB",
  "BBBBBBB",
  "BBBBBBB",
  "BBBBBBB",
  "BbbbbbB",
  ".bbbbb.",
  "..bbb..",
];

/**
 * Wings, procedural, rooted at the shoulder.
 *
 * `phase` runs 0 (fully raised) to 1 (fully swept down). Drawn as one quad
 * behind the body so the bird reads as flapping rather than as a sprite
 * swapping frames — and because the same call, with a different ink, is the
 * enemy buzzard and the hatch-carrier too.
 */
export function wings(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  phase: number,
  fill: string,
  flip: boolean,
  span = 13
): void {
  const back = flip ? 1 : -1;
  const rx = flip ? x + 20 - 7 : x + 7;
  const ry = y + 8;
  const lift = -10 + 20 * phase;

  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(rx, ry - 2);
  g.lineTo(rx + span * back, ry + lift);
  g.lineTo(rx + (span - 3) * back, ry + lift * 0.55 + 4);
  g.lineTo(rx + 2 * back, ry + 3);
  g.closePath();
  g.fill();
}

/**
 * The pterodactyl. Entirely procedural: a long beak, a crested head and two
 * wings that beat slowly and hugely, because it has to read as a different
 * *kind* of thing from the birds at a glance and across the whole screen.
 */
export function pterodactyl(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  phase: number,
  flip: boolean,
  body: string,
  wing: string
): void {
  const d = flip ? -1 : 1;
  const cx = x + 12;
  const cy = y + 9;
  const beat = Math.sin(phase * Math.PI * 2) * 9;

  for (const s of [-1, 1]) {
    g.fillStyle = wing;
    g.beginPath();
    g.moveTo(cx, cy - 1);
    g.lineTo(cx - 15 * d * (s > 0 ? 1 : 0.35) - 3 * d, cy + beat * s - 4);
    g.lineTo(cx - 12 * d * (s > 0 ? 1 : 0.35), cy + beat * s + 3);
    g.closePath();
    g.fill();
  }

  g.fillStyle = body;
  g.fillRect(cx - 6, cy - 2, 12, 5);
  g.fillRect(cx + 5, cy - 5, 4, 5);
  // Beak — the only place a lance can reach it.
  g.fillRect(cx + 8, cy - 3, 8 * d > 0 ? 8 : 8, 2);
  g.fillRect(cx + 2, cy - 8, 3, 4);
  g.fillStyle = wing;
  g.fillRect(cx + 6, cy - 4, 1, 1);
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
  ":": "...|.#.|...|.#.|...",
  "!": ".#.|.#.|.#.|...|.#.",
  "'": ".#.|.#.|...|...|...",
  "/": "..#|..#|.#.|#..|#..",
  "+": "...|.#.|###|.#.|...",
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
