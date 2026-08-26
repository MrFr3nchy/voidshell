/**
 * Render a weave without a browser.
 *
 *   npx esbuild tools/loom-preview.mts --bundle --platform=node --format=esm \
 *     --outfile=preview.mjs && node preview.mjs docs/media && rm preview.mjs
 *
 * The pictures in the README are these, not screenshots, and the distinction
 * is the point: `drawWeave` is a pure function of a wave and a palette, so the
 * thing in the panel and the thing in the README are the same code reached by
 * two different canvases. This one is about ninety lines of SVG emitter
 * implementing the six calls the module actually makes — paths, arcs, rects
 * and two fill styles — which is cheaper than a headless browser and, more
 * usefully, breaks loudly if the module ever starts drawing some other way.
 */
import { writeFileSync } from "node:fs";
import {
  PATTERNS,
  createWeave,
  drawWeave,
  step,
  weaveAll,
  type Pattern,
} from "../packages/ui/src/modules/loom/index";

const INK = { cyan: "#4fe3d0", magenta: "#c05cff", ember: "#ff8a5c" };
const VOID = "#080a14";

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

function tint(color: string, alpha: number): string {
  const n = parseInt(color.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha.toFixed(3)})`;
}

const num = (v: number) => (Math.round(v * 100) / 100).toString();

/** Just enough CanvasRenderingContext2D to satisfy `drawWeave`. */
class SvgContext {
  out: string[] = [];
  private path: string[] = [];
  private cur = false;
  private stack: Record<string, unknown>[] = [];
  lineWidth = 1;
  lineCap = "butt";
  lineJoin = "miter";
  strokeStyle = "#000";
  fillStyle = "#000";

  save(): void {
    const { lineWidth, lineCap, lineJoin, strokeStyle, fillStyle } = this;
    this.stack.push({ lineWidth, lineCap, lineJoin, strokeStyle, fillStyle });
  }
  restore(): void {
    Object.assign(this, this.stack.pop() ?? {});
  }
  beginPath(): void {
    this.path = [];
    this.cur = false;
  }
  moveTo(x: number, y: number): void {
    this.path.push(`M${num(x)} ${num(y)}`);
    this.cur = true;
  }
  lineTo(x: number, y: number): void {
    if (!this.cur) return this.moveTo(x, y);
    this.path.push(`L${num(x)} ${num(y)}`);
  }
  closePath(): void {
    this.path.push("Z");
    this.cur = false;
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number): void {
    const TWO = Math.PI * 2;
    let delta = a1 - a0;
    while (delta < 0) delta += TWO;
    const sx = cx + r * Math.cos(a0);
    const sy = cy + r * Math.sin(a0);
    if (this.cur) this.lineTo(sx, sy);
    else this.moveTo(sx, sy);
    // SVG cannot express a full turn in one arc — its endpoints would coincide
    // and it would draw nothing. Two halves.
    if (delta >= TWO - 1e-9) {
      this.path.push(`A${num(r)} ${num(r)} 0 1 1 ${num(cx - r * Math.cos(a0))} ${num(cy - r * Math.sin(a0))}`);
      this.path.push(`A${num(r)} ${num(r)} 0 1 1 ${num(sx)} ${num(sy)}`);
      return;
    }
    const ex = cx + r * Math.cos(a0 + delta);
    const ey = cy + r * Math.sin(a0 + delta);
    this.path.push(`A${num(r)} ${num(r)} 0 ${delta > Math.PI ? 1 : 0} 1 ${num(ex)} ${num(ey)}`);
  }
  fill(): void {
    if (this.path.length) {
      this.out.push(`<path d="${this.path.join("")}" fill="${this.fillStyle}"/>`);
    }
  }
  stroke(): void {
    if (!this.path.length) return;
    this.out.push(
      `<path d="${this.path.join("")}" fill="none" stroke="${this.strokeStyle}" ` +
        `stroke-width="${num(this.lineWidth)}" stroke-linecap="${this.lineCap}" ` +
        `stroke-linejoin="${this.lineJoin}"/>`
    );
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.out.push(
      `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" fill="${this.fillStyle}"/>`
    );
  }
  clearRect(): void {}
  fillText(): void {}
}

/** One panel: a weave, optionally caught partway through. */
function panel(p: Pattern, seed: number, gw: number, gh: number, cell: number, steps?: number) {
  const rnd = seeded(seed);
  const weave = createWeave(gw, gh, p, rnd);
  if (steps === undefined) weaveAll(weave, rnd);
  else for (let n = 0; n < steps; n++) if (!step(weave, rnd)) break;
  // The flash marks a tile that has just landed and fades over a fifth of a
  // second. A still has no time in it, so every tile would be caught at full
  // brightness and the picture would say nothing.
  weave.fresh.fill(0);
  const g = new SvgContext();
  drawWeave(g as never, weave, { x: 0, y: 0, cell }, INK, tint);
  return g.out.join("");
}

function label(text: string, x: number, y: number): string {
  return (
    `<text x="${x}" y="${y}" fill="#8a93b8" font-size="13" ` +
    `font-family="ui-monospace, monospace">${text}</text>`
  );
}

const dir = process.argv[2] ?? ".";
const CELL = 22;
const GW = 20;
const GH = 15;
const PAD = 22;
const W = GW * CELL;
const H = GH * CELL;

/* Four patterns, finished, side by side. */
{
  const cols = 2;
  const width = cols * W + (cols + 1) * PAD;
  const rows = Math.ceil(PATTERNS.length / cols);
  const height = rows * (H + 26) + (rows + 1) * PAD;
  const body = PATTERNS.map((p, i) => {
    const x = PAD + (i % cols) * (W + PAD);
    const y = PAD + Math.floor(i / cols) * (H + 26 + PAD);
    return (
      `<g transform="translate(${x} ${y})">${panel(p, 20260825 + i * 31, GW, GH, CELL)}` +
      `${label(`${p.name} — ${p.note}`, 0, H + 18)}</g>`
    );
  }).join("");
  writeFileSync(
    `${dir}/loom.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${VOID}"/>` +
      `${body}</svg>`
  );
}

/* One grid caught mid-weave: the frontier is the algorithm, visible. */
{
  const shots = [90, 170, 260];
  const width = shots.length * W + (shots.length + 1) * PAD;
  const height = H + 26 + PAD * 2;
  const body = shots
    .map((n, i) => {
      const x = PAD + i * (W + PAD);
      return (
        `<g transform="translate(${x} ${PAD})">${panel(PATTERNS[0], 4242, GW, GH, CELL, n)}` +
        `${label(`${n} tiles observed`, 0, H + 18)}</g>`
      );
    })
    .join("");
  writeFileSync(
    `${dir}/loom-frontier.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${VOID}"/>` +
      `${body}</svg>`
  );
}

console.log(`wrote ${dir}/loom.svg and ${dir}/loom-frontier.svg`);
