/**
 * From eleven numbers to a continent.
 *
 * The order below is not arbitrary. Warp before sampling, or the coastline is
 * a circle with noise on it. Erode before colouring, or the snowline sits on
 * ridges the erosion is about to cut away. Normalise last, so the sea level
 * slider means the same thing on every map regardless of what the noise
 * happened to peak at.
 */
import { Noise2D, rng } from "./noise";
import type { Field, Marker, MarkerKind, TerrainParams } from "./types";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Hermite ramp. Every transition below uses this rather than a hard `if`. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ */
/* Elevation                                                           */
/* ------------------------------------------------------------------ */

/**
 * Raw normalised heights for a set of parameters.
 *
 * Exported separately from `buildField` because the forge redraws this on
 * every slider drag and only needs the numbers, while the sky view needs the
 * colours too and can afford to pay for them once.
 */
export function generateHeights(p: TerrainParams): Float32Array {
  const n = p.size;
  const shape = new Noise2D(p.seed);
  const warp = new Noise2D(p.seed ^ 0x5bf03635);
  const h = new Float32Array(n * n);

  // Roughly ten noise periods across the map at the default extent, scaled so
  // a 400km province isn't the same terrain stretched — a bigger map gets more
  // ranges rather than larger ones.
  const freq = 3.2 * Math.sqrt(p.extentKm / 240);

  for (let y = 0; y < n; y++) {
    const v = y / (n - 1);
    for (let x = 0; x < n; x++) {
      const u = x / (n - 1);

      // Domain warp. Two independent fBm fields displace the sample point,
      // which is what turns concentric noise into folded coastlines.
      const wx = warp.fbm(u * 2.1 + 11.3, v * 2.1 + 3.7, 4);
      const wy = warp.fbm(u * 2.1 - 5.1, v * 2.1 + 9.2, 4);
      const sx = u + wx * p.warp * 0.38;
      const sy = v + wy * p.warp * 0.38;

      const rolling = shape.fbm(sx * freq, sy * freq, 6) * 0.5 + 0.5;
      const ridge = shape.ridged(sx * freq * 0.82 + 31.7, sy * freq * 0.82 - 17.4, 6);
      let e = lerp(rolling, ridge, p.ridges);

      // Slightly convex: flattens lowlands into plains and keeps the peaks
      // pointed, which is what real relief histograms look like.
      e = Math.pow(e, 1.18);

      // Continent mask: distance to the nearest edge, not to the centre.
      //
      // A radial falloff was the obvious first try and it is wrong on a
      // rectangle — the corners drown while the middle of each edge stays a
      // long way above water, so every map ran land straight off the side. The
      // per-axis distance reaches zero on all four borders, which is what
      // "this province has a coast" actually requires. The wobble keeps the
      // shoreline from being a rounded rectangle.
      const edge = Math.min(u, 1 - u, v, 1 - v) * 2;
      const wobble = warp.fbm(u * 3.4 - 21.0, v * 3.4 + 7.5, 3) * 0.22;
      const mask = smoothstep(0.02, 0.46, edge + wobble);
      e = lerp(e, e * mask - (1 - mask) * 0.45, p.continentality);

      h[y * n + x] = e;
    }
  }

  if (p.erosion > 0) thermalErode(h, n, Math.round(p.erosion));
  normalise(h);
  return h;
}

/**
 * Thermal erosion: material above the talus angle slumps to its lowest neighbour.
 *
 * Cheap, stable, and the single biggest visual win per millisecond spent —
 * without it the ridges are noise-sharp everywhere and the valley floors are
 * as bumpy as the peaks. Scan direction alternates because a fixed one biases
 * the slumping south-east, which shows up as a diagonal grain across the plains.
 */
function thermalErode(h: Float32Array, n: number, passes: number): void {
  // Tuned by looking at the output, not by taste. At 1.6/n the erosion drove
  // essentially every cell to exactly the talus grade, which flattens the
  // slope histogram to a spike and renders as faceted mesas — technically
  // eroded, visually a low-poly quarry. Higher, it only cuts the genuinely
  // sharp features the noise leaves behind and the hillsides keep their range.
  const talus = 3.6 / n;
  for (let pass = 0; pass < passes; pass++) {
    const forward = (pass & 1) === 0;
    for (let i = 0; i < n * n; i++) {
      const idx = forward ? i : n * n - 1 - i;
      const x = idx % n;
      const y = (idx / n) | 0;

      let lowest = -1;
      let drop = 0;
      // Von Neumann neighbourhood: diagonals at this talus produce a visible
      // eight-pointed star around isolated peaks.
      if (x > 0 && h[idx] - h[idx - 1] > drop) { drop = h[idx] - h[idx - 1]; lowest = idx - 1; }
      if (x < n - 1 && h[idx] - h[idx + 1] > drop) { drop = h[idx] - h[idx + 1]; lowest = idx + 1; }
      if (y > 0 && h[idx] - h[idx - n] > drop) { drop = h[idx] - h[idx - n]; lowest = idx - n; }
      if (y < n - 1 && h[idx] - h[idx + n] > drop) { drop = h[idx] - h[idx + n]; lowest = idx + n; }

      if (lowest >= 0 && drop > talus) {
        const move = (drop - talus) * 0.5;
        h[idx] -= move;
        h[lowest] += move;
      }
    }
  }
}

/** Remap to 0..1 so the sea level slider means the same thing on every map. */
function normalise(h: Float32Array): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < h.length; i++) {
    if (h[i] < lo) lo = h[i];
    if (h[i] > hi) hi = h[i];
  }
  const span = hi - lo || 1;
  for (let i = 0; i < h.length; i++) h[i] = (h[i] - lo) / span;
}

/* ------------------------------------------------------------------ */
/* Colour                                                              */
/* ------------------------------------------------------------------ */

type RGB = [number, number, number];

// sRGB, 0..1. Stored in sRGB rather than linear because the atlas draws these
// straight into an ImageData; the sky view is the one that converts, and it
// has a THREE.Color to do it properly.
const C = {
  abyss: [0.024, 0.055, 0.114] as RGB,
  shelf: [0.086, 0.243, 0.333] as RGB,
  shallow: [0.196, 0.435, 0.478] as RGB,
  sand: [0.800, 0.729, 0.565] as RGB,
  desert: [0.784, 0.678, 0.463] as RGB,
  steppe: [0.545, 0.514, 0.322] as RGB,
  grass: [0.298, 0.427, 0.243] as RGB,
  forest: [0.145, 0.271, 0.180] as RGB,
  tundra: [0.427, 0.435, 0.376] as RGB,
  rock: [0.365, 0.353, 0.361] as RGB,
  scree: [0.267, 0.259, 0.278] as RGB,
  snow: [0.937, 0.953, 0.976] as RGB,
};

function mix(a: RGB, b: RGB, t: number, out: RGB): RGB {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/**
 * Steepness for the whole field, normalised against the field's own terrain.
 *
 * The first version scaled the raw gradient by grid resolution and called that
 * 0..1. It is wrong in a way that only a picture shows: at 260km across and
 * 192 samples, one cell is 1.35km, so a *physically* dramatic mountainside is
 * a 3% grade and an absolute threshold either calls everything a cliff or
 * nothing. That build classified the entire province as bare rock and the
 * snowline never fired once, on a map whose whole premise was arctic.
 *
 * Normalising against the map's own 85th-percentile slope fixes it and is
 * scale-free by construction: "steep" means steep *for this terrain*, so a
 * 60km valley and an 800km continent both get a sensible rock line, and
 * changing the detail setting doesn't repaint the world.
 */
function computeSlopes(h: Float32Array, n: number): Float32Array {
  const raw = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const l = h[y * n + Math.max(0, x - 1)];
      const r = h[y * n + Math.min(n - 1, x + 1)];
      const u = h[Math.max(0, y - 1) * n + x];
      const d = h[Math.min(n - 1, y + 1) * n + x];
      raw[y * n + x] = Math.hypot(r - l, d - u);
    }
  }

  // Reference from a strided sample rather than a full sort: 4096 values put
  // the percentile within a rounding error of the true one for a fraction of
  // the cost, and this runs on every slider drag in the forge.
  const stride = Math.max(1, Math.floor(raw.length / 4096));
  const sample: number[] = [];
  for (let i = 0; i < raw.length; i += stride) sample.push(raw[i]);
  sample.sort((a, b) => a - b);
  const ref = sample[Math.floor(sample.length * 0.85)] || 1e-6;

  for (let i = 0; i < raw.length; i++) raw[i] = raw[i] / ref;
  return raw;
}

/** Paint the field. Height and slope decide the rock; latitude and aridity the rest. */
export function colourise(h: Float32Array, n: number, p: TerrainParams): Float32Array {
  const rgb = new Float32Array(n * n * 3);
  const slopes = computeSlopes(h, n);
  const grain = new Noise2D(p.seed ^ 0x1f83d9ab);
  const out: RGB = [0, 0, 0];
  const veg: RGB = [0, 0, 0];

  const sea = p.seaLevel;
  // Arctic still means "snow on the high half", not "snow on everything" — at
  // the old slope of 0.64 a latitude of 0.8 iced 77% of the land and the whole
  // province rendered white.
  const snowStart = clamp(0.97 - p.latitude * 0.56 + p.aridity * 0.08, 0.18, 1.2);
  const rockStart = clamp(0.54 - p.latitude * 0.14, 0.22, 0.85);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const hv = h[i];

      if (hv < sea) {
        // Depth shading. Two stops rather than one, because a single ramp from
        // abyss to shore makes every sea look like a swimming pool.
        const depth = sea > 0 ? (sea - hv) / sea : 0;
        if (depth > 0.35) mix(C.shelf, C.abyss, smoothstep(0.35, 1, depth), out);
        else mix(C.shallow, C.shelf, smoothstep(0, 0.35, depth), out);
        rgb[i * 3] = out[0];
        rgb[i * 3 + 1] = out[1];
        rgb[i * 3 + 2] = out[2];
        continue;
      }

      const e = sea < 1 ? (hv - sea) / (1 - sea) : 0;
      const slope = slopes[i];
      // Per-vertex variation, so nothing reads as a contour band.
      const jitter = grain.fbm(x * 0.09, y * 0.09, 3) * 0.5;

      // Moisture: wetter at sea level, drier high up and in arid climates.
      const moisture = clamp(1 - p.aridity * 1.25 - e * 0.42 + jitter * 0.34, 0, 1);

      // Vegetation band first — everything above is painted over it.
      if (p.latitude > 0.62) {
        mix(C.tundra, C.forest, smoothstep(0.25, 0.85, moisture) * (1 - p.latitude), veg);
      } else if (moisture < 0.28) {
        mix(C.desert, C.steppe, smoothstep(0.05, 0.28, moisture), veg);
      } else {
        mix(C.steppe, C.grass, smoothstep(0.28, 0.5, moisture), veg);
        mix(veg, C.forest, smoothstep(0.52, 0.86, moisture), veg);
      }
      out[0] = veg[0];
      out[1] = veg[1];
      out[2] = veg[2];

      // Beach, but only where the land actually meets the water gently — a
      // sea cliff with a sand stripe painted along its foot looks wrong.
      const beach = smoothstep(0.028, 0.004, e) * smoothstep(1.1, 0.35, slope);
      if (beach > 0) mix(out, C.sand, beach, out);

      // Rock, by steepness or by altitude, whichever arrives first.
      const bySlope = smoothstep(0.95, 1.7, slope);
      const byHeight = smoothstep(rockStart, rockStart + 0.22, e + jitter * 0.08);
      const stone = Math.max(bySlope, byHeight);
      if (stone > 0) mix(out, e > 0.7 ? C.scree : C.rock, stone, out);

      // Snow last, and it does not stick to cliffs — that single term is most
      // of what makes a high range read as rock-and-snow rather than icing.
      const cover =
        smoothstep(snowStart, snowStart + 0.14, e + jitter * 0.06) *
        smoothstep(2.1, 1.2, slope);
      if (cover > 0) mix(out, C.snow, cover, out);

      rgb[i * 3] = out[0];
      rgb[i * 3 + 1] = out[1];
      rgb[i * 3 + 2] = out[2];
    }
  }
  return rgb;
}

/** Heights plus colours plus the two summary numbers the UI shows. */
export function buildField(h: Float32Array, n: number, p: TerrainParams): Field {
  let peak = 0;
  let land = 0;
  for (let i = 0; i < h.length; i++) {
    if (h[i] > peak) peak = h[i];
    if (h[i] >= p.seaLevel) land++;
  }
  return {
    size: n,
    h,
    rgb: colourise(h, n, p),
    peak,
    landFraction: h.length ? land / h.length : 0,
  };
}

/** The ordinary path: parameters in, finished field out. */
export function fieldFromParams(p: TerrainParams): Field {
  return buildField(generateHeights(p), p.size, p);
}

/* ------------------------------------------------------------------ */
/* Places                                                              */
/* ------------------------------------------------------------------ */

const ONSET = ["br", "dr", "fr", "gr", "hr", "kr", "sk", "sn", "st", "th", "v", "h", "k", "m", "r", "s", "t", "b", "g", "j", "f", "n", "l"];
const NUCLEUS = ["a", "e", "i", "o", "u", "au", "ei", "y", "aa", "ou", "ae"];
const CODA = ["rd", "lm", "ng", "nn", "rr", "ft", "lk", "sk", "rn", "th", "m", "n", "r", "l", "k", "s", "d"];

const SUFFIX: Record<MarkerKind, string[]> = {
  hold: ["holm", "hold", "gard", "stad", "heim", "borg"],
  town: ["thorpe", "by", "dale", "ford", "mere", "stead"],
  port: ["vik", "haven", "hamn", "wharf", "strand"],
  ruin: ["barrow", "cairn", "hollow", "wick", "keep"],
  peak: ["fell", "tind", "horn", "spire", "crown"],
  camp: ["camp", "rest", "watch", "hearth"],
};

/** A pronounceable, deterministic place name. */
export function placeName(r: () => number, kind: MarkerKind): string {
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length) % a.length];
  let stem = pick(ONSET) + pick(NUCLEUS);
  if (r() < 0.55) stem += pick(CODA);
  const name = stem + pick(SUFFIX[kind]);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Put settlements where settlements go.
 *
 * Scored rather than sampled at random: ports want to be on the coast, holds
 * want flat ground with a view, ruins want to be somewhere inconvenient. A
 * minimum separation stops the whole province clustering on the one good
 * valley the scorer happens to like most.
 */
export function siteMarkers(field: Field, p: TerrainParams, count = 9): Marker[] {
  const { h, size: n } = field;
  const slopes = computeSlopes(h, n);
  const r = rng(p.seed ^ 0x2545f491);
  const out: Marker[] = [];
  const minSep = 0.11;

  const far = (u: number, v: number) =>
    out.every((m) => Math.hypot(m.u - u, m.v - v) > minSep);

  /** The highest point gets a name whatever else happens. */
  let peakIdx = 0;
  for (let i = 1; i < h.length; i++) if (h[i] > h[peakIdx]) peakIdx = i;
  out.push({
    id: "m0",
    name: placeName(r, "peak"),
    u: (peakIdx % n) / (n - 1),
    v: Math.floor(peakIdx / n) / (n - 1),
    kind: "peak",
  });

  // Candidates, scored per kind. Sampling a few hundred beats scanning the
  // whole grid: the scorer is soft enough that the very best cell and the
  // hundredth-best are indistinguishable on the map.
  const order: MarkerKind[] = ["hold", "port", "town", "hold", "ruin", "town", "camp", "port"];
  for (const kind of order) {
    if (out.length >= count) break;
    let best: { u: number; v: number; score: number } | null = null;

    // A margin, because a port sited one cell from the border is a port whose
    // label is drawn half off the map and whose harbour is off the edge of the
    // world. Six percent is enough to look deliberate.
    const inset = Math.max(1, Math.floor(n * 0.06));
    const span = n - inset * 2;

    // Nine hundred rather than a few dozen: the coastline is a thin band and
    // the port scorer only pays out on it, so a thrifty sample budget quietly
    // leaves every map portless — which reads as a bug in the namer.
    for (let attempt = 0; attempt < 900; attempt++) {
      const x = inset + Math.floor(r() * span);
      const y = inset + Math.floor(r() * span);
      const u = x / (n - 1);
      const v = y / (n - 1);
      const hv = h[y * n + x];
      if (hv < p.seaLevel) continue;
      if (!far(u, v)) continue;

      const e = (hv - p.seaLevel) / (1 - p.seaLevel || 1);
      // Halved into 0..1-ish, because the scorers below read as "how flat is
      // this" and a normalised slope tops out well above one.
      const slope = Math.min(1, slopes[y * n + x] * 0.5);
      // Distance to water, cheaply: does any cell in a small ring dip under?
      let coastal = false;
      for (let d = 2; d <= 10 && !coastal; d += 2) {
        coastal =
          h[y * n + Math.max(0, x - d)] < p.seaLevel ||
          h[y * n + Math.min(n - 1, x + d)] < p.seaLevel ||
          h[Math.max(0, y - d) * n + x] < p.seaLevel ||
          h[Math.min(n - 1, y + d) * n + x] < p.seaLevel;
      }

      let score = 0;
      switch (kind) {
        case "port":
          score = (coastal ? 1 : 0) * (1 - slope) * smoothstep(0.14, 0.0, e);
          break;
        case "hold":
          score = (1 - slope * 1.4) * smoothstep(0.03, 0.2, e) * smoothstep(0.7, 0.35, e);
          break;
        case "town":
          score = (1 - slope * 1.2) * smoothstep(0.02, 0.16, e) + (coastal ? 0.15 : 0);
          break;
        case "ruin":
          score = slope * 0.6 + e * 0.7;
          break;
        case "camp":
          score = (1 - slope) * e * 0.9;
          break;
        case "peak":
          score = e;
          break;
      }
      score += r() * 0.05;
      if (!best || score > best.score) best = { u, v, score };
    }

    if (best && best.score > 0.02) {
      out.push({ id: `m${out.length}`, name: placeName(r, kind), u: best.u, v: best.v, kind });
    }
  }
  return out;
}
