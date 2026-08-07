/**
 * What a map *is*, on disk and in memory.
 *
 * The split that matters here is between `MapDoc` — the thing written to
 * ~/maps/<name>.vmap, which a human can read and edit — and `Field`, the
 * expanded heightfield the renderer actually eats. A procedural map stores
 * eleven numbers and reconstructs the field on open; an imported one has no
 * generator to re-run, so it carries its samples along. Same document type
 * either way, which is what lets the library, the atlas and the sky view all
 * take a `MapDoc` and not care where the ground came from.
 */

/** Everything the generator needs. Eleven numbers is the whole terrain. */
export interface TerrainParams {
  seed: number;
  /** Grid resolution per side. Vertices, not cells: 192 means 191 quads. */
  size: number;
  /** How wide the map is in kilometres. Only the scale bar and the camera care. */
  extentKm: number;
  /** Metres from the sea floor to the highest ridge. */
  reliefM: number;
  /** 0..1 — where the waterline sits in the height range. */
  seaLevel: number;
  /** 0..1 — how much relief comes from ridged noise rather than rolling fBm. */
  ridges: number;
  /** 0..1 — how hard the landmass is pulled in from the edges. 0 is a plateau. */
  continentality: number;
  /** 0..1 — domain warp. Higher gives sinuous coasts and folded ranges. */
  warp: number;
  /** Thermal erosion passes. Cuts talus slopes and fills valley floors. */
  erosion: number;
  /** 0..1 — 0 is equatorial, 1 is arctic. Drives the snowline and the palette. */
  latitude: number;
  /** 0..1 — dryness. Pushes forest toward steppe toward desert. */
  aridity: number;
}

export type MarkerKind = "hold" | "town" | "port" | "ruin" | "peak" | "camp";

export interface Marker {
  id: string;
  name: string;
  /** Normalised grid coordinates, 0..1 from the north-west corner. */
  u: number;
  v: number;
  kind: MarkerKind;
}

/**
 * Samples that cannot be regenerated, because they came from an image.
 *
 * 16-bit rather than 8: a 4000m relief quantised to 256 levels puts 15m steps
 * across a shallow valley floor, and terrain is exactly the subject where flat
 * ground makes the banding obvious.
 */
export interface ImportedField {
  size: number;
  /** base64 of a little-endian Uint16Array, length size*size, row-major. */
  data: string;
  /** base64 of a Uint8Array of size*size*3 — optional paint lifted from a colour image. */
  paint?: string;
}

export interface MapDoc {
  format: "voidshell.map";
  version: 1;
  name: string;
  /** One line shown under the name in the library. */
  note?: string;
  params: TerrainParams;
  markers: Marker[];
  imported?: ImportedField;
}

/** An expanded heightfield: what the mesh builder and the atlas both read. */
export interface Field {
  size: number;
  /** Normalised 0..1 heights, row-major. */
  h: Float32Array;
  /** Per-vertex linear RGB, three floats per vertex, matching `h`. */
  rgb: Float32Array;
  /** The highest normalised sample, so the camera can frame the thing. */
  peak: number;
  /** Fraction of samples above the waterline. Shown in the library. */
  landFraction: number;
}

export const DEFAULT_PARAMS: TerrainParams = {
  seed: 1,
  size: 192,
  extentKm: 240,
  reliefM: 3800,
  seaLevel: 0.34,
  ridges: 0.55,
  continentality: 0.6,
  warp: 0.45,
  erosion: 14,
  latitude: 0.5,
  aridity: 0.35,
};

/** Where maps live. A directory rather than a store key, so `ls` finds them. */
export const MAPS_DIR = "/home/void/maps";
export const MAP_EXT = "vmap";
