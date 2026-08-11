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

import type { WaterField } from "./hydrology";

/** Everything the generator needs. Thirteen numbers is the whole terrain. */
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
  /**
   * 0..1 — how hard it rains. Drives droplet erosion, which is what carves the
   * branching valley network the rivers then run down. At 0 the map keeps its
   * raw noise shape and has no drainage to speak of.
   */
  rainfall: number;
  /**
   * 0..1 — how much drainage has to gather before it counts as a river.
   * Low gives a few trunk rivers, high gives a fine dendritic web.
   */
  riverDensity: number;
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
  /** Present on maps that have something built on them. */
  city?: CityDoc;
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
  /**
   * Rivers, lakes and the sea, as one surface.
   *
   * Not optional, and deliberately so: every renderer needs it, and making it
   * optional would mean four places each deciding what to do without it. A map
   * with no water still gets a `WaterField` — one whose surface is all dry.
   */
  water: WaterField;
}

/* ------------------------------------------------------------------ */
/* Cities                                                              */
/* ------------------------------------------------------------------ */

/**
 * A built-up area sitting on the terrain.
 *
 * Stored as intent rather than geometry — districts, a street grid and a
 * handful of named towers — for exactly the reason `TerrainParams` stores
 * thirteen numbers instead of a heightfield. A hundred thousand buildings is
 * eight megabytes of coordinates and about two kilobytes of *decisions*, and
 * only the decisions are worth keeping in a file that syncs on every save.
 */
export interface CityDoc {
  name: string;
  /**
   * Closed rings of dry land. Everything outside every ring is water.
   *
   * This is the map's coastline, and on a city map it *is* the terrain — no
   * amount of tuning the noise generator will produce Manhattan. Rings may run
   * off the edge of the map; they are clipped by rasterisation rather than by
   * being trimmed here, so the data can stay honest about where New Jersey
   * goes.
   */
  land: Ring[];
  /** High ground, because a real place has some. */
  hills: Hill[];
  /** Districts, each a closed ring in normalised map coordinates. */
  districts: District[];
  /** Towers worth siting by hand, because the skyline is recognisable. */
  landmarks: Landmark[];
  /** Seed for everything not named above: filler blocks, street jitter, lights. */
  seed: number;
}

/** A closed ring in normalised map coordinates. First point is not repeated. */
export type Ring = [number, number][];

export interface Hill {
  name?: string;
  u: number;
  v: number;
  /** Radius in normalised map units. */
  radius: number;
  heightM: number;
}

export interface District {
  name: string;
  /** Closed ring, normalised map coordinates. */
  ring: Ring;
  /** Metres — the typical roofline before the falloff below is applied. */
  baseHeightM: number;
  /**
   * 0..1 — how sharply height decays with distance from the district centre.
   * This is what gives a downtown a peak rather than a plateau.
   */
  falloff: number;
  /** Metres between street centrelines on the short axis. Manhattan's is ~80. */
  blockM: number;
  /**
   * Long axis over short axis. Manhattan's blocks are about 3.4:1, and that
   * ratio is most of why its grid is recognisable from the air — square blocks
   * read as Phoenix, not as New York.
   */
  blockAspect: number;
  /** Bearing of the street grid in radians. Manhattan's is famously not north. */
  gridAngle: number;
  /** 0..1 — fraction of blocks actually built on. Parks are districts at 0. */
  density: number;
  kind: "downtown" | "midrise" | "lowrise" | "park" | "industrial";
}

export interface Landmark {
  name: string;
  u: number;
  v: number;
  /** Metres to the architectural top. */
  heightM: number;
  /** Metres, square footprint. */
  footprintM: number;
  /** Tapered towers read completely differently to boxes at this scale. */
  taper?: number;
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
  rainfall: 0.55,
  riverDensity: 0.5,
  latitude: 0.5,
  aridity: 0.35,
};

/**
 * Render quality. One knob, because the four things it scales have to move
 * together — a 1024² mesh under a 512² shadow map spends its whole budget on
 * geometry nobody can see lit properly.
 */
export type Quality = "low" | "balanced" | "high";

export interface QualityTier {
  /** Mesh vertices per side. The heightfield is resampled up or down to this. */
  mesh: number;
  /** Colour and normal texture size. */
  texture: number;
  shadowMap: number;
  shadows: boolean;
  /** Cap on instanced buildings before the filler starts thinning out. */
  buildings: number;
  /** Anisotropic filtering, clamped to what the GPU actually offers. */
  aniso: number;
}

export const QUALITY: Record<Quality, QualityTier> = {
  low: { mesh: 256, texture: 1024, shadowMap: 1024, shadows: false, buildings: 6000, aniso: 4 },
  balanced: { mesh: 512, texture: 2048, shadowMap: 2048, shadows: true, buildings: 24000, aniso: 8 },
  high: { mesh: 768, texture: 4096, shadowMap: 4096, shadows: true, buildings: 60000, aniso: 16 },
};

/** Where maps live. A directory rather than a store key, so `ls` finds them. */
export const MAPS_DIR = "/home/void/maps";
export const MAP_EXT = "vmap";
