/**
 * The art. All original, authored here.
 *
 * The real cabinet drew to an XY vector monitor: a beam tracing straight
 * strokes, not a grid of coloured pixels. None of Atari's ROM outlines are
 * reproduced anywhere below — every shape here is this file's own drawing of
 * "a ship", "a rock", "a saucer" — but stroked line art is also, unusually
 * among the games on this floor, the *authentic* rendering technique rather
 * than a modern approximation of one. A blitted bitmap would be the thing
 * that looked wrong here.
 *
 * That's also why this file doesn't use `shared/pixel.ts`'s `blit`: there is
 * no sprite grid to run-length encode. The HUD text still goes through the
 * shared bitmap font — even the real cabinet's beam drew hard-edged glyphs —
 * but the ship, the rocks and the saucers are strokes.
 */

import type { AsteroidSize, SaucerKind } from "./rules";

/**
 * The ship: a narrow dart, not a fat triangle. The original's silhouette is
 * almost all length-to-width — that's what makes the heading readable at a
 * glance even though the sprite has no separate "front" detail, only a point.
 */
export function ship(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  heading: number,
  thrusting: boolean,
  color: string
): void {
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const rot = (rx: number, ry: number): [number, number] => [
    x + rx * cos - ry * sin,
    y + rx * sin + ry * cos,
  ];

  const nose = rot(7, 0);
  const left = rot(-6, 4.4);
  const right = rot(-6, -4.4);
  const tailL = rot(-3.4, 1.6);
  const tailR = rot(-3.4, -1.6);

  g.strokeStyle = color;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(nose[0], nose[1]);
  g.lineTo(left[0], left[1]);
  g.lineTo(tailL[0], tailL[1]);
  g.lineTo(tailR[0], tailR[1]);
  g.lineTo(right[0], right[1]);
  g.closePath();
  g.stroke();

  if (!thrusting) return;
  // A short flickering flame out the back, drawn as its own stroke rather
  // than baked into the hull outline so it can vary in length frame to frame
  // without touching the ship's own points.
  const flicker = 3 + Math.random() * 3;
  const flame = rot(-3.4 - flicker, 0);
  g.strokeStyle = "#ff8a3c";
  g.beginPath();
  g.moveTo(tailL[0], tailL[1]);
  g.lineTo(flame[0], flame[1]);
  g.lineTo(tailR[0], tailR[1]);
  g.stroke();
}

/**
 * A rock: a closed, irregular stroked polygon. `shape` is a set of radius
 * multipliers around the circle (see `rules.makeAsteroidShape`) so the same
 * function draws all three sizes and every instance still looks distinct —
 * eleven identical grey circles on screen at once would read as a pattern,
 * not as debris.
 */
export function asteroid(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  shape: readonly number[],
  rotation: number,
  color: string
): void {
  const n = shape.length;
  g.strokeStyle = color;
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = rotation + (i % n) * ((Math.PI * 2) / n);
    const r = radius * shape[i % n];
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.stroke();
}

/**
 * The saucer: two trapezoids sharing a waistline, the classic silhouette
 * without tracing anyone's ROM for it. The small saucer is the same drawing
 * scaled down — the size difference alone is most of what tells them apart at
 * a glance, exactly as intended: the small one is the one you should worry
 * about, and it should read as "the little one" on sight.
 */
export function saucer(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  kind: SaucerKind,
  color: string
): void {
  const s = kind === "large" ? 1 : 0.55;
  g.strokeStyle = color;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x - 10 * s, y);
  g.lineTo(x - 4 * s, y - 4 * s);
  g.lineTo(x + 4 * s, y - 4 * s);
  g.lineTo(x + 10 * s, y);
  g.lineTo(x + 4 * s, y + 4 * s);
  g.lineTo(x - 4 * s, y + 4 * s);
  g.closePath();
  g.moveTo(x - 4 * s, y - 4 * s);
  g.lineTo(x - 2.5 * s, y - 7 * s);
  g.lineTo(x + 2.5 * s, y - 7 * s);
  g.lineTo(x + 4 * s, y - 4 * s);
  g.stroke();
}

export function bullet(g: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  g.fillStyle = color;
  g.fillRect(Math.round(x), Math.round(y), 1, 1);
}

/**
 * A burst of radiating strokes for a kill or a death — the vector-era
 * equivalent of a particle explosion, drawn as `n` lines whose length falls
 * off over `t` (0 at birth, 1 at death) rather than as sprites, since nothing
 * about a vector monitor could composite a bitmap particle anyway.
 */
export function burst(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  t: number,
  scale: number,
  color: string
): void {
  const n = 8;
  const grow = Math.min(1, t * 3.2);
  const fade = 1 - t;
  if (fade <= 0) return;
  g.strokeStyle = color;
  g.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + t * 1.4;
    const inner = grow * scale * (3 + (i % 3));
    const outer = inner + fade * scale * 3.4;
    g.beginPath();
    g.moveTo(x + Math.cos(a) * inner, y + Math.sin(a) * inner);
    g.lineTo(x + Math.cos(a) * outer, y + Math.sin(a) * outer);
    g.stroke();
  }
}

/** Size on screen, for collision-independent draw scaling of small debris bits. */
export const ASTEROID_VERTS: Record<AsteroidSize, number> = {
  large: 11,
  medium: 9,
  small: 7,
};
