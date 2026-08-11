/**
 * Ground for a place that already exists.
 *
 * The noise generator is very good at inventing a province and completely
 * incapable of producing Manhattan, for the same reason it cannot produce your
 * handwriting: a real coastline is not a sample from any distribution, it is a
 * fact. So a city map's terrain comes from polygons instead — rings of dry
 * land, a handful of named hills, and a coastal falloff between them.
 *
 * Everything here is deliberately free of `three`, because it runs in the
 * checks and in the headless harness, neither of which has a GPU. The
 * buildings — which do need one — live in citybuild.ts.
 */
import { Noise2D } from "./noise";
import type { CityDoc, Ring, TerrainParams } from "./types";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------------------ */
/* Rings                                                               */
/* ------------------------------------------------------------------ */

/**
 * Crossing-number point-in-polygon.
 *
 * The half-open comparison on v is what makes this robust at vertices: a point
 * exactly level with a vertex must be counted by one of the two edges meeting
 * there and not both, or every horizontal line through a vertex reports the
 * wrong parity — which on a coastline shows up as single-pixel spits of sea
 * running inland from each ring point.
 */
export function inRing(ring: Ring, u: number, v: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > v !== yj > v && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function inAnyRing(rings: Ring[], u: number, v: number): boolean {
  for (const ring of rings) if (inRing(ring, u, v)) return true;
  return false;
}

/** Shortest distance from a point to a ring's boundary, in normalised units. */
export function distanceToRing(ring: Ring, u: number, v: number): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const dx = xj - xi;
    const dy = yj - yi;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? clamp(((u - xi) * dx + (v - yi) * dy) / len2, 0, 1) : 0;
    const d = Math.hypot(u - (xi + t * dx), v - (yi + t * dy));
    if (d < best) best = d;
  }
  return best;
}

export function distanceToCoast(rings: Ring[], u: number, v: number): number {
  let best = Infinity;
  for (const ring of rings) {
    const d = distanceToRing(ring, u, v);
    if (d < best) best = d;
  }
  return best;
}

export function ringBounds(ring: Ring): { u0: number; v0: number; u1: number; v1: number } {
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (const [u, v] of ring) {
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  return { u0, v0, u1, v1 };
}

export function ringCentroid(ring: Ring): [number, number] {
  let u = 0;
  let v = 0;
  for (const [x, y] of ring) {
    u += x;
    v += y;
  }
  return [u / ring.length, v / ring.length];
}

/* ------------------------------------------------------------------ */
/* Terrain                                                             */
/* ------------------------------------------------------------------ */

/**
 * Rasterise a city's land into a heightfield.
 *
 * The shape of the result matters more than it looks. Sea level sits at
 * `p.seaLevel`, land rises above it, and the transition is a smooth ramp over
 * a fixed *distance* from the coast rather than a step at the ring boundary.
 * A step would be geometrically faithful and would render as a wall of cliff
 * around every island, because a heightfield has no way to express a vertical
 * face — it would simply be one cell of enormous gradient, lit as a black
 * outline. The ramp is what makes a shoreline read as a shoreline.
 *
 * Estuaries get depth from distance too. Without it the Hudson is a flat pan
 * at exactly sea level minus epsilon, and flat water at a uniform depth is the
 * one thing that makes a river look painted on.
 */
export function cityHeights(city: CityDoc, p: TerrainParams): Float32Array {
  const n = p.size;
  const h = new Float32Array(n * n);
  const grain = new Noise2D(city.seed ^ 0x3c6ef372);

  // Metres per normalised unit, so hill heights can be given in metres.
  const mPerUnit = p.extentKm * 1000;
  const toNorm = (metres: number) => metres / p.reliefM;

  // The coastal ramp, in normalised map units. About 250m of shoreline at any
  // map extent — wide enough to shade, narrow enough to stay a coast.
  const rampU = 250 / mPerUnit;
  // Water deepens over roughly a kilometre from the shore.
  const shelfU = 1000 / mPerUnit;

  const sea = p.seaLevel;
  // A base elevation for dry land.
  //
  // Higher than it first looks like it needs to be, and the reason is the
  // colouriser. Its beach band catches ground within about 2.8% of the way
  // from the waterline to the peak — which on a map whose relief is 700m is
  // everything under roughly 13m. At the original 6m the whole of New York
  // came out painted as sand: Brooklyn, Queens and Newark rendered as one pale
  // beach with a city drawn on it. Twelve metres of shore rising to thirty
  // clears the band, is closer to the real ground anyway, and still leaves a
  // genuine beach in the coastal ramp where there should be one.
  const shoreHeight = sea + toNorm(12);

  for (let y = 0; y < n; y++) {
    const v = y / (n - 1);
    for (let x = 0; x < n; x++) {
      const u = x / (n - 1);
      const i = y * n + x;

      const land = inAnyRing(city.land, u, v);
      const coast = distanceToCoast(city.land, u, v);

      if (!land) {
        // Depth ramps away from the shore and stops at a shelf. Deeper than
        // the real harbour, which is dredged to about 15m — but the vertical
        // exaggeration this is viewed under would render a true 15m harbour
        // as a puddle.
        const t = Math.min(1, coast / shelfU);
        h[i] = sea - toNorm(9 + t * 42);
        continue;
      }

      // Inland from the ramp, this saturates at 1 and the hills below take over.
      const rise = Math.min(1, coast / rampU);
      let e = shoreHeight + toNorm(rise * 18);

      for (const hill of city.hills) {
        const d = Math.hypot(u - hill.u, v - hill.v) / hill.radius;
        if (d >= 1) continue;
        // Smootherstep — a cosine dome has a visible crease at its foot where
        // the second derivative jumps, and a city map is mostly flat ground
        // with a few domes on it, so that crease is the only thing to look at.
        const t = 1 - d;
        e += toNorm(hill.heightM) * t * t * t * (t * (t * 6 - 15) + 10);
      }

      // A little roughness so the flats are not glass. Kept well under a
      // storey — this is ground, and the buildings go on top of it.
      e += toNorm(grain.fbm(u * 90, v * 90, 3) * 4);

      h[i] = e;
    }
  }

  return h;
}

/**
 * How built-up each cell is, 0..1.
 *
 * The colouriser paints from height, slope, latitude and aridity, which
 * between them describe a *landscape*. Run New York through it and you get a
 * temperate coastal province: forest over Queens, grassland over Newark,
 * meadow where midtown is. Every one of those answers is right for the model
 * and wrong for the place.
 *
 * So the districts contribute a mask, and the ground under them goes toward
 * asphalt. Parks are districts at zero density and stay green, which is how
 * Central Park reads as a green rectangle in a grey island rather than as the
 * one part of Manhattan the generator forgot.
 */
export function cityDevelopment(city: CityDoc, size: number): Float32Array {
  const out = new Float32Array(size * size);

  for (const d of city.districts) {
    if (d.kind === "park") continue;
    const b = ringBounds(d.ring);
    // Only the rows and columns the district can possibly touch. Testing every
    // ring against every cell is sixteen point-in-polygon tests per sample at
    // 256², which is slower than the entire rest of the field build.
    const x0 = Math.max(0, Math.floor(b.u0 * (size - 1)));
    const x1 = Math.min(size - 1, Math.ceil(b.u1 * (size - 1)));
    const y0 = Math.max(0, Math.floor(b.v0 * (size - 1)));
    const y1 = Math.min(size - 1, Math.ceil(b.v1 * (size - 1)));

    for (let y = y0; y <= y1; y++) {
      const v = y / (size - 1);
      for (let x = x0; x <= x1; x++) {
        const u = x / (size - 1);
        if (!inRing(d.ring, u, v)) continue;
        const i = y * size + x;
        // Denser districts pave more of themselves. Taken as a maximum rather
        // than a sum so overlapping districts do not compound into tarmac.
        const paved = Math.min(1, d.density * 0.9);
        if (paved > out[i]) out[i] = paved;
      }
    }
  }

  return out;
}

/**
 * Does this document describe a place that was built rather than generated?
 *
 * One predicate, used by everything that has to branch on it, so the answer
 * cannot drift between the field builder, the atlas and the sky view.
 */
export function isCityMap(city: CityDoc | undefined): city is CityDoc {
  return !!city && Array.isArray(city.land) && city.land.length > 0;
}
