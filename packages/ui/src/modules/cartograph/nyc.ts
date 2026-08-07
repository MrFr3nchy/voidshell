/**
 * New York, as far as a few kilobytes can carry it.
 *
 * What this is: a hand-authored reconstruction. The coastlines below were
 * written from knowledge of the place, not traced from a survey, and the
 * street grids and filler blocks are generated. Landmark towers are sited at
 * their real coordinates with their real architectural heights, because the
 * skyline is the part you would actually recognise and getting the Empire
 * State forty storeys wrong would be worse than leaving it out.
 *
 * What this is not: data. It is accurate to a few hundred metres on the
 * shoreline and considerably worse in the details — Newark Bay and the
 * Hackensack are missing, Rockaway is one smooth barrier rather than the
 * jointed thing it is, and every block between the named towers is invented.
 * Anyone wanting the real geometry should import a DEM; the app has a button
 * for it, and that is the honest way in.
 *
 * Coordinates are written as longitude and latitude and converted once, at the
 * bottom. Storing the normalised values directly would be marginally faster to
 * load and completely unmaintainable — nobody can check `[0.4307, 0.6152]`
 * against a map, and everybody can check `-74.0170, 40.7033` against Battery
 * Park.
 */
import type { CityDoc, District, Landmark, MapDoc, Ring } from "./types";

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

/** Midtown Manhattan. The map is centred here. */
const CENTRE_LON = -73.98;
const CENTRE_LAT = 40.75;

/** How wide the map is, in kilometres. Wide enough to hold Staten Island. */
export const NYC_EXTENT_KM = 45;

// At this latitude. A degree of longitude is shorter than a degree of latitude
// by cos(lat), and ignoring that squashes the whole city east-west by a
// quarter — Manhattan comes out looking like a fat sausage rather than a
// sliver, which is the one thing about its shape everybody knows.
const KM_PER_DEG_LAT = 111.32;
const KM_PER_DEG_LON = 111.32 * Math.cos((CENTRE_LAT * Math.PI) / 180);

const LON_SPAN = NYC_EXTENT_KM / KM_PER_DEG_LON;
const LAT_SPAN = NYC_EXTENT_KM / KM_PER_DEG_LAT;

/** Longitude and latitude to normalised map coordinates. v grows southward. */
export function project(lon: number, lat: number): [number, number] {
  return [0.5 + (lon - CENTRE_LON) / LON_SPAN, 0.5 - (lat - CENTRE_LAT) / LAT_SPAN];
}

const ring = (pts: [number, number][]): Ring => pts.map(([lon, lat]) => project(lon, lat));

/* ------------------------------------------------------------------ */
/* Coastlines                                                          */
/* ------------------------------------------------------------------ */

/**
 * Manhattan. Battery at the south tip, Inwood at the north, the Hudson down
 * the west side and the East and Harlem rivers down the east.
 */
const MANHATTAN = ring([
  [-74.017, 40.7033],
  [-74.0155, 40.711],
  [-74.0125, 40.725],
  [-74.01, 40.74],
  [-74.009, 40.755],
  [-74.006, 40.77],
  [-73.9995, 40.783],
  [-73.986, 40.798],
  [-73.972, 40.812],
  [-73.96, 40.83],
  [-73.948, 40.848],
  [-73.934, 40.865],
  [-73.927, 40.872],
  [-73.92, 40.87],
  [-73.923, 40.86],
  [-73.931, 40.84],
  [-73.934, 40.82],
  [-73.934, 40.803],
  [-73.94, 40.792],
  [-73.947, 40.78],
  [-73.955, 40.769],
  [-73.962, 40.757],
  [-73.966, 40.745],
  [-73.97, 40.734],
  [-73.972, 40.725],
  [-73.974, 40.713],
  [-73.978, 40.708],
  [-73.998, 40.704],
  [-74.009, 40.702],
]);

/**
 * Long Island — Brooklyn and Queens, running off the east and south edges.
 *
 * The ring extends well past the map on purpose. Clipping it to the frame
 * would put a coastline where there is only the end of the data, and the
 * rasteriser is perfectly happy to be handed geography it cannot show.
 */
const LONG_ISLAND = ring([
  [-74.045, 40.635],
  [-74.025, 40.648],
  [-74.01, 40.66],
  [-74.0, 40.68],
  [-73.995, 40.7],
  [-73.988, 40.708],
  [-73.976, 40.72],
  [-73.964, 40.73],
  [-73.958, 40.74],
  [-73.954, 40.75],
  [-73.945, 40.76],
  [-73.935, 40.772],
  [-73.92, 40.782],
  [-73.9, 40.79],
  [-73.85, 40.795],
  [-73.78, 40.792],
  [-73.6, 40.78],
  // The south shore. Rockaway and Long Beach sit around 40.58–40.60, and the
  // first draft ran this line down to 40.53 — which is south of the map's
  // bottom edge, so the Atlantic never appeared at all and Queens ran off the
  // frame into open ocean.
  [-73.6, 40.62],
  [-73.75, 40.6],
  [-73.85, 40.585],
  [-73.93, 40.577],
  [-73.98, 40.572],
  [-74.01, 40.59],
  [-74.045, 40.635],
]);

/** Staten Island, with Todt Hill down the middle of it. */
const STATEN_ISLAND = ring([
  [-74.055, 40.58],
  [-74.07, 40.605],
  [-74.1, 40.642],
  [-74.15, 40.648],
  [-74.19, 40.64],
  [-74.21, 40.61],
  [-74.205, 40.575],
  [-74.18, 40.545],
  [-74.14, 40.525],
  [-74.1, 40.535],
  [-74.07, 40.555],
]);

/**
 * New Jersey. The Hudson's west bank, then straight off the western edge.
 *
 * Newark Bay and the Hackensack meadowlands are not here. They are a real
 * feature of the place and reproducing them well needs more shoreline than
 * the rest of this file put together, so they are simply absent rather than
 * badly approximated.
 */
const NEW_JERSEY = ring([
  // Up the Hudson's west bank to the top of the frame. The first version ran
  // a single diagonal from the north-west corner to Fort Lee, which sliced
  // Bergen County off and opened a ten-kilometre lagoon along the north edge
  // where the river should be a kilometre wide.
  [-73.905, 41.01],
  [-73.925, 40.96],
  [-73.945, 40.92],
  [-73.955, 40.895],
  [-73.968, 40.852],
  [-73.98, 40.83],
  [-73.995, 40.808],
  [-74.009, 40.79],
  [-74.018, 40.775],
  [-74.024, 40.76],
  [-74.027, 40.745],
  [-74.029, 40.73],
  [-74.032, 40.715],
  [-74.038, 40.702],
  [-74.048, 40.69],
  [-74.062, 40.67],
  [-74.075, 40.645],
  [-74.1, 40.63],
  [-74.16, 40.66],
  [-74.32, 40.66],
  [-74.32, 41.01],
]);

/**
 * The Bronx and Westchester — everything east of the Hudson and north of the
 * Harlem River, running off the top and east edges of the frame.
 */
const BRONX = ring([
  [-73.895, 41.01],
  [-73.6, 41.01],
  [-73.6, 40.91],
  [-73.68, 40.89],
  [-73.75, 40.85],
  [-73.79, 40.82],
  [-73.83, 40.805],
  [-73.87, 40.8],
  [-73.9, 40.82],
  [-73.925, 40.84],
  [-73.933, 40.86],
  [-73.92, 40.872],
  [-73.905, 40.9],
  [-73.9, 40.95],
]);

/**
 * Liberty Island.
 *
 * Drawn about twice its real size, and that is a deliberate lie. The island is
 * some 200m across; at 45km over a 256-cell grid one cell is 176m, so at true
 * scale it lands on a single sample and the 250m coastal ramp then drowns it.
 * Below the resolution of the field, the choice is between an island that is
 * slightly too big and no island at all — and the statue has to stand on
 * something.
 */
const LIBERTY = ring([
  [-74.0466, 40.6908],
  [-74.0424, 40.6908],
  [-74.0424, 40.6876],
  [-74.0466, 40.6876],
]);

/** Governors Island, which is small and sits exactly where you look first. */
const GOVERNORS = ring([
  [-74.019, 40.6935],
  [-74.0135, 40.6935],
  [-74.0125, 40.688],
  [-74.0185, 40.6865],
]);

/* ------------------------------------------------------------------ */
/* High ground                                                         */
/* ------------------------------------------------------------------ */

const hill = (lon: number, lat: number, radiusKm: number, heightM: number, name?: string) => {
  const [u, v] = project(lon, lat);
  return { name, u, v, radius: radiusKm / NYC_EXTENT_KM, heightM };
};

/**
 * Real high ground, at real heights.
 *
 * New York is not flat, and the parts that are not flat are the parts that
 * decided where everything went — Manhattan's towers stand where the schist
 * comes close enough to the surface to found them on, which is why Midtown and
 * the Financial District are tall and the soft ground between them is not.
 */
const HILLS = [
  hill(-74.1, 40.58, 3.4, 125, "Todt Hill"),
  hill(-73.93, 40.87, 2.2, 80, "Fort Washington"),
  hill(-73.912, 40.882, 2.6, 85, "Riverdale"),
  hill(-73.96, 40.815, 1.6, 45, "Morningside Heights"),
  hill(-73.87, 40.86, 3.0, 65, "Bronx Park ridge"),
  hill(-73.99, 40.688, 2.0, 40, "Brooklyn Heights"),
  hill(-73.96, 40.66, 2.6, 55, "Prospect Park ridge"),
  hill(-74.02, 40.745, 1.8, 60, "Palisades"),
  hill(-74.03, 40.79, 2.4, 75, "Palisades north"),
];

/* ------------------------------------------------------------------ */
/* Districts                                                           */
/* ------------------------------------------------------------------ */

/** The Commissioners' grid runs about 29° east of north. */
const MANHATTAN_GRID = (29 * Math.PI) / 180;

const district = (
  name: string,
  kind: District["kind"],
  pts: [number, number][],
  opts: Partial<District> = {}
): District => ({
  name,
  kind,
  ring: ring(pts),
  baseHeightM: 40,
  falloff: 0.5,
  blockM: 80,
  blockAspect: 3.4,
  gridAngle: MANHATTAN_GRID,
  density: 0.8,
  ...opts,
});

const DISTRICTS: District[] = [
  district(
    "Midtown",
    "downtown",
    [
      [-74.005, 40.744],
      [-73.986, 40.735],
      [-73.962, 40.752],
      [-73.958, 40.772],
      [-73.982, 40.784],
      [-74.002, 40.762],
    ],
    { baseHeightM: 165, falloff: 0.55, density: 0.93 }
  ),
  district(
    "Financial District",
    "downtown",
    [
      [-74.017, 40.703],
      [-74.0, 40.705],
      [-73.975, 40.712],
      [-73.978, 40.722],
      [-74.011, 40.719],
    ],
    { baseHeightM: 145, falloff: 0.6, density: 0.9, blockAspect: 1.4, gridAngle: 0.28 }
  ),
  district(
    "Central Park",
    "park",
    [
      [-73.9812, 40.7681],
      [-73.9581, 40.7644],
      [-73.9494, 40.7968],
      [-73.958, 40.8005],
    ],
    { density: 0, baseHeightM: 0 }
  ),
  district(
    "Upper West Side",
    "midrise",
    [
      [-73.99, 40.771],
      [-73.9755, 40.7755],
      [-73.9585, 40.8015],
      [-73.9735, 40.807],
    ],
    { baseHeightM: 58, falloff: 0.25, density: 0.88 }
  ),
  district(
    "Upper East Side",
    "midrise",
    [
      [-73.9585, 40.764],
      [-73.9435, 40.769],
      [-73.9345, 40.792],
      [-73.9495, 40.7975],
    ],
    { baseHeightM: 62, falloff: 0.25, density: 0.88 }
  ),
  district(
    "Lower Manhattan",
    "midrise",
    [
      [-74.012, 40.72],
      [-73.976, 40.723],
      [-73.972, 40.736],
      [-74.011, 40.74],
    ],
    { baseHeightM: 52, falloff: 0.2, density: 0.9, blockAspect: 1.6, gridAngle: 0.36 }
  ),
  district(
    "Harlem",
    "midrise",
    [
      [-73.9585, 40.8015],
      [-73.9345, 40.7975],
      [-73.9315, 40.826],
      [-73.9555, 40.832],
    ],
    { baseHeightM: 40, falloff: 0.15, density: 0.85 }
  ),
  district(
    "Downtown Brooklyn",
    "downtown",
    [
      [-73.998, 40.688],
      [-73.978, 40.688],
      [-73.975, 40.702],
      [-73.994, 40.702],
    ],
    { baseHeightM: 110, falloff: 0.55, density: 0.85, gridAngle: 0.62, blockAspect: 1.8 }
  ),
  district(
    "Long Island City",
    "midrise",
    [
      [-73.958, 40.742],
      [-73.936, 40.744],
      [-73.937, 40.759],
      [-73.955, 40.757],
    ],
    { baseHeightM: 95, falloff: 0.45, density: 0.75, gridAngle: 0.5, blockAspect: 1.5 }
  ),
  district(
    "Jersey City",
    "midrise",
    [
      [-74.048, 40.708],
      [-74.03, 40.712],
      [-74.032, 40.732],
      [-74.052, 40.73],
    ],
    { baseHeightM: 90, falloff: 0.5, density: 0.72, gridAngle: 0.22, blockAspect: 1.6 }
  ),
  district(
    "Brooklyn",
    "lowrise",
    [
      [-74.02, 40.63],
      [-73.93, 40.6],
      [-73.86, 40.66],
      [-73.94, 40.73],
      [-73.995, 40.7],
    ],
    { baseHeightM: 18, falloff: 0.08, density: 0.82, blockM: 90, blockAspect: 2.2, gridAngle: 0.62 }
  ),
  district(
    "Queens",
    "lowrise",
    [
      [-73.94, 40.73],
      [-73.86, 40.66],
      [-73.74, 40.7],
      [-73.76, 40.78],
      [-73.9, 40.785],
    ],
    { baseHeightM: 16, falloff: 0.06, density: 0.74, blockM: 95, blockAspect: 2.0, gridAngle: 0.28 }
  ),
  district(
    "The Bronx",
    "lowrise",
    [
      [-73.93, 40.815],
      [-73.85, 40.82],
      [-73.83, 40.89],
      [-73.92, 40.885],
    ],
    { baseHeightM: 24, falloff: 0.1, density: 0.72, blockM: 90, blockAspect: 2.0, gridAngle: 0.1 }
  ),
  district(
    "Staten Island",
    "lowrise",
    [
      [-74.07, 40.6],
      [-74.1, 40.63],
      [-74.18, 40.62],
      [-74.19, 40.56],
      [-74.11, 40.54],
    ],
    { baseHeightM: 12, falloff: 0.05, density: 0.5, blockM: 110, blockAspect: 1.6, gridAngle: 0.9 }
  ),
  district(
    "Newark",
    "midrise",
    // Not a rectangle. Four corners is enough to describe where a city is and
    // renders as a stamped block of towers with straight sides, which is the
    // one shape no city has ever had.
    [
      [-74.203, 40.715],
      [-74.176, 40.708],
      [-74.148, 40.722],
      [-74.142, 40.748],
      [-74.163, 40.767],
      [-74.196, 40.758],
    ],
    { baseHeightM: 55, falloff: 0.35, density: 0.7, gridAngle: 0.4, blockAspect: 1.5 }
  ),
  district(
    "Prospect Park",
    "park",
    [
      [-73.973, 40.653],
      [-73.962, 40.652],
      [-73.965, 40.667],
      [-73.977, 40.664],
    ],
    { density: 0, baseHeightM: 0 }
  ),
];

/* ------------------------------------------------------------------ */
/* Towers                                                              */
/* ------------------------------------------------------------------ */

const tower = (
  name: string,
  lon: number,
  lat: number,
  heightM: number,
  footprintM: number,
  taper?: number
): Landmark => {
  const [u, v] = project(lon, lat);
  return { name, u, v, heightM, footprintM, taper };
};

/**
 * Heights are to the architectural top — spire included, antenna not — which
 * is the convention that puts One World Trade at 541m rather than 417m, and
 * the one under which the numbers below are the ones people recognise.
 */
const LANDMARKS: Landmark[] = [
  tower("One World Trade Center", -74.0134, 40.7127, 541, 62, 0.62),
  tower("Central Park Tower", -73.981, 40.7663, 472, 44, 0.9),
  tower("111 West 57th", -73.9773, 40.7645, 435, 22, 0.85),
  tower("One Vanderbilt", -73.9784, 40.7529, 427, 52, 0.55),
  tower("432 Park Avenue", -73.9719, 40.7616, 426, 28, 0.98),
  tower("Empire State Building", -73.9857, 40.7484, 443, 78, 0.34),
  tower("Bank of America Tower", -73.9843, 40.7555, 366, 56, 0.5),
  tower("30 Hudson Yards", -74.0018, 40.7538, 387, 54, 0.72),
  tower("Chrysler Building", -73.9755, 40.7516, 319, 46, 0.38),
  tower("3 World Trade Center", -74.0119, 40.7113, 329, 48, 0.7),
  tower("The Brooklyn Tower", -73.983, 40.6905, 325, 34, 0.68),
  tower("MetLife Building", -73.9761, 40.7543, 246, 70, 0.86),
  tower("30 Rockefeller Plaza", -73.979, 40.759, 259, 64, 0.55),
  tower("Woolworth Building", -74.0083, 40.7124, 241, 42, 0.4),
  tower("Flatiron Building", -73.9897, 40.7411, 87, 34, 0.72),
  tower("Statue of Liberty", -74.0445, 40.6892, 93, 20, 0.3),
];

/* ------------------------------------------------------------------ */
/* The document                                                        */
/* ------------------------------------------------------------------ */

export const NYC_CITY: CityDoc = {
  name: "New York",
  land: [MANHATTAN, LONG_ISLAND, STATEN_ISLAND, NEW_JERSEY, BRONX, GOVERNORS, LIBERTY],
  hills: HILLS,
  districts: DISTRICTS,
  landmarks: LANDMARKS,
  seed: 1898,
};

/**
 * The map document.
 *
 * `rainfall` is zero and it has to be. Droplet erosion is the right model for
 * a mountain range over ten thousand years and completely wrong for a
 * coastline that is a fact — a hundred thousand drops would happily cut a
 * gorge across Central Park and silt up the Narrows. The hydrology pass still
 * runs, because the harbour and the rivers need to be flooded and routed like
 * any other water; it simply has nothing to erode.
 */
export const NYC_DOC: MapDoc = {
  format: "voidshell.map",
  version: 1,
  name: "New York",
  note: "hand-authored from real coordinates · the skyline is to scale",
  params: {
    seed: 1898,
    size: 256,
    extentKm: NYC_EXTENT_KM,
    // The tallest thing in frame is a 541m building on ground under 130m. The
    // relief number is what metres are measured against, so it has to cover
    // the towers as well as the ground.
    reliefM: 700,
    seaLevel: 0.32,
    ridges: 0,
    continentality: 0,
    warp: 0,
    erosion: 0,
    rainfall: 0,
    // No procedural drainage at all. The Hudson, the East River and the
    // harbour are already here — they are cut into the coastline rings and
    // flooded by the same pass that fills any sea. What this switches off is
    // the *invented* network, which on ground this smooth found creeks in the
    // surface grain and drew them across Queens and Staten Island.
    riverDensity: 0,
    latitude: 0.44,
    aridity: 0.3,
  },
  markers: [
    { id: "m0", name: "Midtown", ...uv(-73.9819, 40.7587), kind: "hold" },
    { id: "m1", name: "Battery Park", ...uv(-74.0142, 40.7055), kind: "port" },
    { id: "m2", name: "Central Park", ...uv(-73.9654, 40.7829), kind: "camp" },
    { id: "m3", name: "Brooklyn Bridge", ...uv(-73.9969, 40.7061), kind: "town" },
    { id: "m4", name: "Coney Island", ...uv(-73.9776, 40.5755), kind: "port" },
    { id: "m5", name: "Todt Hill", ...uv(-74.1, 40.58), kind: "peak" },
    { id: "m6", name: "The Bronx", ...uv(-73.8801, 40.8448), kind: "town" },
    { id: "m7", name: "Jersey City", ...uv(-74.0431, 40.7178), kind: "town" },
  ],
  city: NYC_CITY,
};

function uv(lon: number, lat: number): { u: number; v: number } {
  const [u, v] = project(lon, lat);
  return { u, v };
}
