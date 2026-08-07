/**
 * Getting ground in from outside, and writing it back down again.
 *
 * A generated map is eleven numbers and reconstructs itself. An imported one
 * has no generator to re-run, so the samples themselves have to survive in the
 * document — which makes the encoding a real decision rather than a detail,
 * because these files sync to the server on every save.
 */
import { cityDevelopment, cityHeights, isCityMap } from "./citymap";
import { hydrology } from "./hydrology";
import { colourise, generateHeights } from "./terrain";
import type { Field, ImportedField, MapDoc, TerrainParams } from "./types";

/** Imported grids are capped here. 192² of 16-bit samples is ~98KB of base64. */
export const MAX_IMPORT_SIZE = 192;

/* ------------------------------------------------------------------ */
/* base64                                                              */
/* ------------------------------------------------------------------ */

function toBase64(bytes: Uint8Array): string {
  // Chunked: `String.fromCharCode(...bytes)` on a 74000-element array is a
  // stack overflow, and it is the kind that only shows up on the big maps.
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------ */
/* Packing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Normalised heights to 16-bit little-endian base64.
 *
 * Not 8-bit: a 4000m relief quantised to 256 levels puts 15m risers across a
 * valley floor, and flat ground under raking light is precisely where stepping
 * is visible. The extra 49KB buys terrain that doesn't look terraced.
 */
export function packHeights(h: Float32Array): string {
  const bytes = new Uint8Array(h.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < h.length; i++) {
    const v = Math.round(Math.min(1, Math.max(0, h[i])) * 65535);
    view.setUint16(i * 2, v, true);
  }
  return toBase64(bytes);
}

export function unpackHeights(b64: string, size: number): Float32Array {
  const bytes = fromBase64(b64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(size * size);
  const n = Math.min(out.length, Math.floor(bytes.length / 2));
  for (let i = 0; i < n; i++) out[i] = view.getUint16(i * 2, true) / 65535;
  return out;
}

export function packPaint(rgb: Uint8Array): string {
  return toBase64(rgb);
}

export function unpackPaint(b64: string, size: number): Float32Array {
  const bytes = fromBase64(b64);
  const out = new Float32Array(size * size * 3);
  const n = Math.min(out.length, bytes.length);
  for (let i = 0; i < n; i++) out[i] = bytes[i] / 255;
  return out;
}

/* ------------------------------------------------------------------ */
/* Reading an image                                                    */
/* ------------------------------------------------------------------ */

export interface SampledImage {
  size: number;
  /** Normalised 0..1 heights, row-major. */
  h: Float32Array;
  /** Present when the caller asked to keep the source colours. */
  paint?: Uint8Array;
}

/**
 * Resample an image file into a square heightfield.
 *
 * Luminance rather than the red channel, because plenty of real elevation
 * exports are greyscale-looking-but-not, and reading one channel of those
 * throws away three quarters of the range for no reason anyone would notice
 * until the terrain came out flat.
 */
export async function sampleImage(
  file: Blob,
  size: number,
  keepColour: boolean
): Promise<SampledImage> {
  const n = Math.max(16, Math.min(MAX_IMPORT_SIZE, Math.round(size)));
  const bitmap = await createImageBitmap(file);

  const canvas = document.createElement("canvas");
  canvas.width = n;
  canvas.height = n;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) {
    bitmap.close?.();
    throw new Error("no 2D canvas available to read the image with");
  }
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, n, n);
  bitmap.close?.();

  const data = g.getImageData(0, 0, n, n).data;
  const h = new Float32Array(n * n);
  const paint = keepColour ? new Uint8Array(n * n * 3) : undefined;

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n * n; i++) {
    const r = data[i * 4];
    const gch = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    // Rec.709 luma. Good enough for false-colour reliefs too, where the green
    // channel usually carries most of the elevation signal anyway.
    const y = (0.2126 * r + 0.7152 * gch + 0.0722 * b) / 255;
    h[i] = y;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
    if (paint) {
      paint[i * 3] = r;
      paint[i * 3 + 1] = gch;
      paint[i * 3 + 2] = b;
    }
  }

  // Stretch to the full range: most exported heightmaps use a fraction of it,
  // and a map that never leaves the bottom third of the scale reads as a beach.
  const span = hi - lo || 1;
  for (let i = 0; i < h.length; i++) h[i] = (h[i] - lo) / span;

  // One box pass to take the edge off 8-bit source quantisation. Any more and
  // real ridgelines start to go soft.
  smooth(h, n);

  return { size: n, h, paint };
}

function smooth(h: Float32Array, n: number): void {
  const src = h.slice();
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= n) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= n) continue;
          sum += src[yy * n + xx];
          count++;
        }
      }
      h[y * n + x] = sum / count;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export function importedFrom(sampled: SampledImage): ImportedField {
  return {
    size: sampled.size,
    data: packHeights(sampled.h),
    paint: sampled.paint ? packPaint(sampled.paint) : undefined,
  };
}

/** Expand a document into something the renderers can eat. */
export function fieldFromDoc(doc: MapDoc): Field {
  const params: TerrainParams = doc.imported
    ? { ...doc.params, size: doc.imported.size }
    : doc.params;
  const n = params.size;
  // Three ways ground can arrive: unpacked from an import, rasterised from a
  // real coastline, or invented from the seed. In that order of authority —
  // measured beats surveyed beats imagined.
  const h = doc.imported
    ? unpackHeights(doc.imported.data, n)
    : isCityMap(doc.city)
      ? cityHeights(doc.city, params)
      : generateHeights(params);

  // An imported heightmap gets its water routed too. It arrived as bare
  // elevation with no notion of drainage, and running the same hydrology over
  // it is what puts rivers in the valleys of a real DEM — which is most of the
  // reason anyone imports one.
  const water = hydrology(h, n, params);

  const developed = isCityMap(doc.city) ? cityDevelopment(doc.city, n) : undefined;
  const rgb =
    doc.imported?.paint !== undefined
      ? unpackPaint(doc.imported.paint, n)
      : colourise(h, n, params, water, developed);

  let peak = 0;
  let land = 0;
  for (let i = 0; i < h.length; i++) {
    if (h[i] > peak) peak = h[i];
    if (h[i] >= params.seaLevel) land++;
  }
  return { size: n, h, rgb, peak, landFraction: h.length ? land / h.length : 0, water };
}

/** Roughly what this document will cost on disk, for the size hint in the UI. */
export function docBytes(doc: MapDoc): number {
  try {
    return JSON.stringify(doc).length;
  } catch {
    return 0;
  }
}

/** Parse and sanity-check a file read out of the VFS. Throws with a readable reason. */
export function parseDoc(text: string): MapDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  const doc = raw as Partial<MapDoc>;
  if (!doc || doc.format !== "voidshell.map") throw new Error("not a voidshell map");
  if (!doc.params || typeof doc.params.size !== "number") throw new Error("no terrain parameters");
  return {
    format: "voidshell.map",
    version: 1,
    name: typeof doc.name === "string" && doc.name.trim() ? doc.name : "untitled",
    note: typeof doc.note === "string" ? doc.note : undefined,
    params: withDefaults(doc.params as Partial<TerrainParams>),
    markers: Array.isArray(doc.markers) ? doc.markers : [],
    imported: doc.imported,
    city: doc.city,
  };
}

/**
 * Fill in parameters a map was saved before we had.
 *
 * Maps written by the version of this app that had no water carry no rainfall
 * and no river density, and `undefined` through the droplet loop produces a
 * heightfield of NaN — a blank window and no error anywhere near the cause.
 * Defaulting here rather than at each read site means one place knows the
 * shape of a `TerrainParams`, which is the only way this stays true as the
 * generator grows.
 */
function withDefaults(p: Partial<TerrainParams>): TerrainParams {
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    seed: num(p.seed, 1),
    size: num(p.size, 192),
    extentKm: num(p.extentKm, 240),
    reliefM: num(p.reliefM, 3800),
    seaLevel: num(p.seaLevel, 0.34),
    ridges: num(p.ridges, 0.55),
    continentality: num(p.continentality, 0.6),
    warp: num(p.warp, 0.45),
    erosion: num(p.erosion, 14),
    rainfall: num(p.rainfall, 0.55),
    riverDensity: num(p.riverDensity, 0.5),
    latitude: num(p.latitude, 0.5),
    aridity: num(p.aridity, 0.35),
  };
}
