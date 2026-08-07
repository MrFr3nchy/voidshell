/**
 * Seeded noise, from first principles.
 *
 * Deliberately not a library: the whole contract of a `.vmap` is that eleven
 * numbers reproduce the same continent forever, and that promise is only as
 * good as the noise underneath it. A dependency that changes its gradient
 * table in a minor release silently rewrites every map anyone ever saved.
 */

/** mulberry32 — small, fast, and stable across engines, which is the point. */
export function rng(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Classic 2D gradient noise over a seeded permutation table.
 *
 * Returns roughly -1..1. The table is 512 long so the wrap at 255 needs no
 * modulo in the hot loop, which is where all the time goes at 192².
 */
export class Noise2D {
  private readonly perm = new Uint8Array(512);

  constructor(seed: number) {
    const r = rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher–Yates, seeded.
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** Gradient dot product for one of eight unit-ish directions. */
  private grad(hash: number, x: number, y: number): number {
    switch (hash & 7) {
      case 0: return x + y;
      case 1: return x - y;
      case 2: return -x + y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  }

  at(x: number, y: number): number {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const p = this.perm;

    const aa = p[p[xi] + yi];
    const ab = p[p[xi] + yi + 1];
    const ba = p[p[xi + 1] + yi];
    const bb = p[p[xi + 1] + yi + 1];

    const x1 = lerp(this.grad(aa, xf, yf), this.grad(ba, xf - 1, yf), u);
    const x2 = lerp(this.grad(ab, xf, yf - 1), this.grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v) * 0.7;
  }

  /** Fractional Brownian motion. Rolling hills, valleys, plains. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let fx = x;
    let fy = y;
    for (let i = 0; i < octaves; i++) {
      sum += this.at(fx, fy) * amp;
      norm += amp;
      amp *= gain;
      fx *= lacunarity;
      fy *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * Ridged multifractal — `1 - |noise|`, squared, weighted by the octave above.
   *
   * This is the one that makes mountains look like mountains rather than like
   * dunes: the absolute value creates creases, and the per-octave weighting
   * keeps detail on the ridgelines instead of scattering it into the valleys.
   * Returns 0..1.
   */
  ridged(x: number, y: number, octaves: number, lacunarity = 2.07, gain = 0.5): number {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let weight = 1;
    let fx = x;
    let fy = y;
    for (let i = 0; i < octaves; i++) {
      let n = 1 - Math.abs(this.at(fx, fy));
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 2));
      sum += n * amp;
      norm += amp;
      amp *= gain;
      fx *= lacunarity;
      fy *= lacunarity;
    }
    return norm > 0 ? Math.min(1, sum / norm) : 0;
  }
}
