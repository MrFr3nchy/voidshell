/**
 * Turning a small field into a large surface.
 *
 * The old sky view drew the heightfield exactly as generated — a 192² grid,
 * one vertex colour per sample, straight onto a 192² mesh. Two things follow
 * from that and both of them are the reason the maps looked soft:
 *
 *   - a 1000-unit map across 192 quads puts each colour sample five world
 *     units from the next, and Gouraud interpolation smears it across all
 *     five. There was no texture in the module at all. Every edge in the
 *     paint — a snowline, a shore, a riverbank — was five units of gradient.
 *   - normals came from the same 192 samples, so the lighting had nothing
 *     finer than a 5-unit facet to work with. Mountains lit like low-poly
 *     mountains because that is exactly what they were.
 *
 * The fix is not to generate at 2048². Erosion and flood-fill at that size are
 * seconds of work and the *geography* gains nothing — a river is in the same
 * valley whether you sampled the valley 192 or 2048 times. So: keep the field
 * small and authoritative, and synthesise the detail between its samples.
 *
 * Which is what this file is. Catmull-Rom for the base, fractal detail on top
 * scaled by local slope, and three textures baked out of the result — colour,
 * a high-frequency normal residual, and AO packed with roughness.
 */
import * as THREE from "three";
import type { WaterField } from "./hydrology";
import type { Field, QualityTier, TerrainParams } from "./types";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export interface BakedTerrain {
  /** Vertices per side of the mesh this was baked for. */
  mesh: number;
  /** Detailed normalised heights at mesh resolution, row-major. */
  heights: Float32Array;
  /** Water surface height at mesh resolution; -1 where dry. */
  water: Float32Array;
  /** 0..1 river strength at mesh resolution — drives flow and foam. */
  rivers: Float32Array;
  colour: THREE.DataTexture;
  /** Tangent-space normals for the detail the mesh is too coarse to hold. */
  normal: THREE.DataTexture;
  /** r = ambient occlusion, g = roughness. One texture, two maps. */
  surface: THREE.DataTexture;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* Sampling                                                            */
/* ------------------------------------------------------------------ */

const catmull = (a: number, b: number, c: number, d: number, t: number): number => {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
  );
};

/**
 * Bicubic sample of a square field at normalised coordinates.
 *
 * Bilinear was the first version and it is visibly wrong when you magnify a
 * field eight times: the interpolant is only C0, so every original sample
 * shows up as a crease in the shading. On smooth ground under raking light
 * that reads as a faint quilt across the whole map, at exactly the spacing of
 * the source grid. Catmull-Rom is C1 and the quilt goes away.
 */
function bicubic(src: Float32Array, n: number, u: number, v: number, stride = 1, off = 0): number {
  const x = clamp(u, 0, 1) * (n - 1);
  const y = clamp(v, 0, 1) * (n - 1);
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;

  const at = (px: number, py: number) =>
    src[(clamp(py, 0, n - 1) * n + clamp(px, 0, n - 1)) * stride + off];

  const rows: number[] = [];
  for (let j = -1; j <= 2; j++) {
    rows.push(
      catmull(at(xi - 1, yi + j), at(xi, yi + j), at(xi + 1, yi + j), at(xi + 2, yi + j), fx)
    );
  }
  return catmull(rows[0], rows[1], rows[2], rows[3], fy);
}

/**
 * Separable Catmull-Rom upsample of an n² field to T².
 *
 * The direct form — evaluate the 2D kernel per output texel — is sixteen taps
 * each, and at 2048² that was most of a twenty-two second bake. Doing the rows
 * first and the columns second is the same filter for eight taps, with the
 * intermediate small enough to stay in cache. It is the difference between
 * this module opening a map in a second and opening it in half a minute.
 */
function upsample(src: Float32Array, n: number, T: number, stride = 1, off = 0): Float32Array {
  const rows = new Float32Array(n * T);
  const at = (px: number, py: number) =>
    src[(clamp(py, 0, n - 1) * n + clamp(px, 0, n - 1)) * stride + off];

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < T; x++) {
      const fxPos = (x / (T - 1)) * (n - 1);
      const xi = Math.floor(fxPos);
      const fx = fxPos - xi;
      rows[y * T + x] = catmull(at(xi - 1, y), at(xi, y), at(xi + 1, y), at(xi + 2, y), fx);
    }
  }

  const out = new Float32Array(T * T);
  for (let y = 0; y < T; y++) {
    const fyPos = (y / (T - 1)) * (n - 1);
    const yi = Math.floor(fyPos);
    const fy = fyPos - yi;
    const r0 = clamp(yi - 1, 0, n - 1) * T;
    const r1 = clamp(yi, 0, n - 1) * T;
    const r2 = clamp(yi + 1, 0, n - 1) * T;
    const r3 = clamp(yi + 2, 0, n - 1) * T;
    for (let x = 0; x < T; x++) {
      out[y * T + x] = catmull(rows[r0 + x], rows[r1 + x], rows[r2 + x], rows[r3 + x], fy);
    }
  }
  return out;
}

/** Gradient magnitude of a field, in units of "height per cell". */
function slopeField(h: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const l = h[y * n + Math.max(0, x - 1)];
      const r = h[y * n + Math.min(n - 1, x + 1)];
      const u = h[Math.max(0, y - 1) * n + x];
      const d = h[Math.min(n - 1, y + 1) * n + x];
      out[y * n + x] = Math.hypot(r - l, d - u) * 0.5;
    }
  }
  return out;
}

/** Bilinear. Correct for masks, where overshoot would be a bug rather than smoothing. */
function bilinear(src: Float32Array, n: number, u: number, v: number): number {
  const x = clamp(u, 0, 1) * (n - 1);
  const y = clamp(v, 0, 1) * (n - 1);
  const xi = Math.min(n - 2, Math.floor(x));
  const yi = Math.min(n - 2, Math.floor(y));
  const fx = x - xi;
  const fy = y - yi;
  const i = yi * n + xi;
  return (
    (src[i] * (1 - fx) + src[i + 1] * fx) * (1 - fy) +
    (src[i + n] * (1 - fx) + src[i + n + 1] * fx) * fy
  );
}

/**
 * Water surface, sampled without dragging the shoreline down.
 *
 * `-1` means dry, and it is a sentinel rather than a height — interpolating
 * toward it pulls the water surface below the riverbed for the whole width of
 * one source cell, which renders as a channel that drains itself every few
 * hundred metres. So the dry samples are replaced by the nearest wet one
 * before the blend, and the wetness is tracked separately.
 */
function sampleWater(src: Float32Array, n: number, u: number, v: number): { y: number; wet: number } {
  const x = clamp(u, 0, 1) * (n - 1);
  const y = clamp(v, 0, 1) * (n - 1);
  const xi = Math.min(n - 2, Math.floor(x));
  const yi = Math.min(n - 2, Math.floor(y));
  const fx = x - xi;
  const fy = y - yi;
  const i = yi * n + xi;

  const s = [src[i], src[i + 1], src[i + n], src[i + n + 1]];
  const w = [s[0] >= 0 ? 1 : 0, s[1] >= 0 ? 1 : 0, s[2] >= 0 ? 1 : 0, s[3] >= 0 ? 1 : 0];
  const anyWet = w[0] || w[1] || w[2] || w[3];
  if (!anyWet) return { y: -1, wet: 0 };

  let sum = 0;
  let count = 0;
  for (let k = 0; k < 4; k++) {
    if (w[k]) {
      sum += s[k];
      count++;
    }
  }
  const mean = sum / count;
  for (let k = 0; k < 4; k++) if (!w[k]) s[k] = mean;

  const height =
    (s[0] * (1 - fx) + s[1] * fx) * (1 - fy) + (s[2] * (1 - fx) + s[3] * fx) * fy;
  const wetness =
    (w[0] * (1 - fx) + w[1] * fx) * (1 - fy) + (w[2] * (1 - fx) + w[3] * fx) * fy;

  return { y: height, wet: wetness };
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */

/**
 * Hash-based value noise. Deliberately not the Noise2D class next door.
 *
 * That one is the map's *geography* and its stability is a promise — a saved
 * seed has to rebuild the same continent forever. This is surface texture at
 * four million texels, it never touches the document, and it is called often
 * enough that the permutation table's two dependent array lookups per sample
 * are the profile. Different job, different tool.
 */
function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  // Quintic fade — the cubic one leaves visible second-derivative banding
  // where two octaves happen to line up, which on rock reads as scratches.
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

function detailFbm(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(fx, fy) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2.02;
    fy *= 2.02;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Periods of surface detail across the width of the map.
 *
 * A property of the *ground*, not of how finely we happened to sample it. The
 * first version tied this to the field size, which meant a map generated at
 * 256² got scree twice as fine as the same terrain generated at 128² — the
 * detail setting silently changed what the rock was made of.
 */
const DETAIL_FREQ = 110;

/**
 * How many octaves this texture size can actually hold.
 *
 * Worth being strict about. Each octave doubles the frequency, and an octave
 * whose period lands under about three texels cannot be represented — it
 * aliases, and because this is a normal map the aliasing arrives as *moving
 * glitter* across the hillsides as the camera turns, which is far worse than
 * the missing detail. The first draft asked for five octaves off a base of
 * `n * 1.6`, putting the finest band near five thousand periods against a
 * texture that could resolve seven hundred.
 */
function detailOctaves(textureSize: number): number {
  const limit = Math.log2(textureSize / (DETAIL_FREQ * 3));
  return Math.max(1, Math.min(4, Math.floor(limit)));
}

/* ------------------------------------------------------------------ */
/* The bake                                                            */
/* ------------------------------------------------------------------ */

/**
 * Detailed heights at mesh resolution.
 *
 * The added noise is scaled by local slope, which is the one decision here
 * that matters. Applied uniformly it puts the same roughness on a lake bed, a
 * flood plain and a cliff face — and flat ground is precisely where the eye
 * measures whether a surface is flat, so uniform detail reads as the whole map
 * being covered in a fine rash. Real relief is smooth where it is flat and
 * broken where it is steep, so the amplitude follows the gradient.
 */
function detailedHeights(
  field: Field,
  slopeUp: Float32Array,
  mesh: number,
  p: TerrainParams
): Float32Array {
  const n = field.size;
  const out = upsample(field.h, n, mesh);
  // In normalised height units. Heavily eroded terrain has had its sharp
  // features removed on purpose, so it gets less of them put back.
  const amplitude = 0.055 * (1 - p.erosion / 120);
  const octaves = detailOctaves(mesh);
  // Normalises the slope field, which is in height-per-source-cell, into 0..1.
  const slopeNorm = (n - 1) / 6;

  for (let y = 0; y < mesh; y++) {
    const v = (y / (mesh - 1)) * DETAIL_FREQ;
    for (let x = 0; x < mesh; x++) {
      const i = y * mesh + x;
      const slope = Math.min(1, slopeUp[i] * slopeNorm);
      out[i] += (detailFbm((x / (mesh - 1)) * DETAIL_FREQ, v, octaves) - 0.5) * amplitude * slope;
    }
  }
  return out;
}

/**
 * Cheap horizon-scan ambient occlusion.
 *
 * Eight directions, a handful of steps each, at a quarter of the texture
 * resolution and then smoothed up. Not a physically meaningful occlusion
 * factor, but it puts the valleys in shade and leaves the ridges bright, and
 * that single cue does more for reading relief than the directional light
 * does — a range lit from one side is ambiguous about which way is up until
 * something darkens the creases.
 */
function occlusion(h: Float32Array, n: number, reliefScale: number): Float32Array {
  const ao = new Float32Array(n * n);
  const dirs = 8;
  const steps = 6;
  const stride = Math.max(2, Math.round(n / 96));

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const base = h[i];
      let open = 0;

      for (let d = 0; d < dirs; d++) {
        const a = (d / dirs) * Math.PI * 2;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        let maxSlope = 0;
        for (let s = 1; s <= steps; s++) {
          const dist = s * stride;
          const sx = Math.round(x + dx * dist);
          const sy = Math.round(y + dy * dist);
          if (sx < 0 || sx >= n || sy < 0 || sy >= n) break;
          const rise = (h[sy * n + sx] - base) * reliefScale;
          const slope = rise / (dist / n);
          if (slope > maxSlope) maxSlope = slope;
        }
        // atan of the horizon angle, mapped so an unobstructed direction
        // contributes 1 and a wall directly overhead contributes 0.
        open += 1 - Math.atan(maxSlope) / (Math.PI / 2);
      }

      ao[i] = open / dirs;
    }
  }
  return ao;
}

function makeTexture(
  data: Uint8ClampedArray<ArrayBuffer>,
  size: number,
  srgb: boolean,
  aniso: number
): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Bake everything the sky view needs from one field.
 *
 * Synchronous and not cheap — a few hundred milliseconds at the high tier.
 * The caller is expected to have said something to the user first; see
 * index.ts, which puts the window into a loading state before calling.
 */
export function bakeTerrain(
  field: Field,
  water: WaterField,
  p: TerrainParams,
  tier: QualityTier,
  maxAniso: number
): BakedTerrain {
  const mesh = tier.mesh;
  const T = tier.texture;
  const n = field.size;

  const slopeN = slopeField(field.h, n);
  const heights = detailedHeights(field, upsample(slopeN, n, mesh), mesh, p);

  /* ---------------- water at mesh resolution ---------------- */

  const waterOut = new Float32Array(mesh * mesh).fill(-1);
  const rivers = new Float32Array(mesh * mesh);
  for (let y = 0; y < mesh; y++) {
    const v = y / (mesh - 1);
    for (let x = 0; x < mesh; x++) {
      const u = x / (mesh - 1);
      const i = y * mesh + x;
      const s = sampleWater(water.surface, n, u, v);
      // Half a source cell of wetness is the shoreline. Below it the cell is
      // land, which keeps the coast a line rather than a metre of fringe.
      if (s.wet > 0.5) waterOut[i] = s.y;
      rivers[i] = Math.min(1, bilinear(water.river, n, u, v) * 220);
    }
  }

  /* ---------------- occlusion, at a workable size ---------------- */

  const aoSize = Math.min(256, mesh);
  const aoField = new Float32Array(aoSize * aoSize);
  for (let y = 0; y < aoSize; y++) {
    for (let x = 0; x < aoSize; x++) {
      aoField[y * aoSize + x] = bicubic(heights, mesh, x / (aoSize - 1), y / (aoSize - 1));
    }
  }
  // Relief as a fraction of map width, so the horizon angles are real angles.
  const reliefScale = p.reliefM / 1000 / Math.max(1, p.extentKm);
  const ao = occlusion(aoField, aoSize, reliefScale * 40);

  /* ---------------- the three textures ---------------- */

  const colourData = new Uint8ClampedArray(new ArrayBuffer(T * T * 4));
  const normalData = new Uint8ClampedArray(new ArrayBuffer(T * T * 4));
  const surfaceData = new Uint8ClampedArray(new ArrayBuffer(T * T * 4));

  // Everything that comes from the field is upsampled once, up front. The
  // per-texel loop below then reads flat arrays and evaluates exactly one fBm,
  // which is what makes this a second rather than half a minute.
  const rUp = upsample(field.rgb, n, T, 3, 0);
  const gUp = upsample(field.rgb, n, T, 3, 1);
  const bUp = upsample(field.rgb, n, T, 3, 2);
  const slopeUpT = upsample(slopeN, n, T);
  const aoUp = upsample(ao, aoSize, T);

  const octaves = detailOctaves(T);
  const detailAmp = 0.055 * (1 - p.erosion / 120);
  const slopeNorm = (n - 1) / 6;

  /*
   * Pass one: the height residual — the detail the mesh is too coarse to
   * hold, which is exactly what the normal map should carry and nothing else.
   * Building normals from the full height would double-count everything the
   * geometry already expresses, and every slope would light as twice as steep
   * as it is.
   *
   * Materialising it as a field rather than a function is the other half of
   * the speedup: the four samples a normal needs become four array reads that
   * the neighbouring texels have already paid for, instead of four fresh fBm
   * walks each.
   */
  const residual = new Float32Array(T * T);
  for (let y = 0; y < T; y++) {
    const v = (y / (T - 1)) * DETAIL_FREQ;
    for (let x = 0; x < T; x++) {
      const i = y * T + x;
      const slope = Math.min(1, slopeUpT[i] * slopeNorm);
      residual[i] = (detailFbm((x / (T - 1)) * DETAIL_FREQ, v, octaves) - 0.5) * detailAmp * slope;
    }
  }

  // Converts a normalised height difference across one texel into a gradient.
  const normalScale = (p.reliefM / 1000 / Math.max(1, p.extentKm)) * (T - 1);

  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const i = y * T + x;
      const o = i * 4;

      /* colour */
      const r = rUp[i];
      const g = gUp[i];
      const b = bUp[i];
      // Fine tonal break-up, ±6%, taken from the residual we already have —
      // enough to stop a hillside reading as flat paint, small enough that it
      // never becomes a texture in its own right.
      const speckle = 1 + (residual[i] / (detailAmp || 1)) * 0.12;
      colourData[o] = clamp(r * speckle, 0, 1) * 255;
      colourData[o + 1] = clamp(g * speckle, 0, 1) * 255;
      colourData[o + 2] = clamp(b * speckle, 0, 1) * 255;
      colourData[o + 3] = 255;

      /* normal, from the residual only */
      const xl = x > 0 ? residual[i - 1] : residual[i];
      const xr = x < T - 1 ? residual[i + 1] : residual[i];
      const yd = y > 0 ? residual[i - T] : residual[i];
      const yu = y < T - 1 ? residual[i + T] : residual[i];
      const nx = (xl - xr) * normalScale;
      const nz = (yd - yu) * normalScale;
      const len = Math.hypot(nx, nz, 1);
      normalData[o] = ((nx / len) * 0.5 + 0.5) * 255;
      normalData[o + 1] = ((nz / len) * 0.5 + 0.5) * 255;
      normalData[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      normalData[o + 3] = 255;

      /* ao + roughness */
      // Rock is rougher than vegetation and much rougher than wet ground.
      // Luminance is a decent proxy: snow and sand are bright and fairly
      // smooth, forest is dark and matte.
      const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
      surfaceData[o] = clamp(aoUp[i], 0, 1) * 255;
      surfaceData[o + 1] = clamp(0.96 - luma * 0.22, 0.55, 0.99) * 255;
      surfaceData[o + 2] = 0;
      surfaceData[o + 3] = 255;
    }
  }

  const aniso = Math.min(tier.aniso, maxAniso || 1);
  const colour = makeTexture(colourData, T, true, aniso);
  const normal = makeTexture(normalData, T, false, aniso);
  const surface = makeTexture(surfaceData, T, false, aniso);

  return {
    mesh,
    heights,
    water: waterOut,
    rivers,
    colour,
    normal,
    surface,
    dispose() {
      colour.dispose();
      normal.dispose();
      surface.dispose();
    },
  };
}
