/**
 * Cartograph's own rules, asserted directly.
 *
 * The smoke harness already launches the app, renders it and closes it, which
 * proves the wiring. It cannot see any of what is below, because all of it is
 * arithmetic that produces a perfectly valid-looking window whatever answer it
 * gives: a continent that runs off the edge of the map, a snowline that never
 * fires, a marker sited in the sea. Every one of those shipped at least once
 * during this module's first afternoon and none of them threw.
 *
 * Kept out of smoke.mts for the same reason the arcade's constants are: there
 * are enough of them that inlining would make that file mostly about maps.
 */
import { fieldFromParams, siteMarkers } from "../packages/ui/src/modules/cartograph/terrain";
import {
  packHeights,
  parseDoc,
  unpackHeights,
} from "../packages/ui/src/modules/cartograph/heightmap";
import { EXAMPLE_DOCS } from "../packages/ui/src/modules/cartograph/examples";
import { DEFAULT_PARAMS } from "../packages/ui/src/modules/cartograph/types";
import type { Field, TerrainParams } from "../packages/ui/src/modules/cartograph/types";

type Check = (label: string, ok: boolean) => void;

/** Is the sample at these normalised coordinates above the waterline? */
function dryAt(field: Field, p: TerrainParams, u: number, v: number): boolean {
  const n = field.size;
  const x = Math.round(u * (n - 1));
  const y = Math.round(v * (n - 1));
  return field.h[y * n + x] >= p.seaLevel;
}

export function cartographChecks(check: Check): void {
  const base = fieldFromParams(DEFAULT_PARAMS);

  /* ---------------- the generator is a function, not a mood ---------------- */

  {
    const again = fieldFromParams(DEFAULT_PARAMS);
    let identical = base.h.length === again.h.length;
    for (let i = 0; identical && i < base.h.length; i++) identical = base.h[i] === again.h[i];
    // The whole premise of storing eleven numbers instead of 98KB of samples.
    check("cartograph: one seed, one continent, forever", identical);

    const other = fieldFromParams({ ...DEFAULT_PARAMS, seed: DEFAULT_PARAMS.seed + 1 });
    let differs = false;
    for (let i = 0; i < base.h.length && !differs; i++) differs = base.h[i] !== other.h[i];
    check("cartograph: a different seed is a different place", differs);
  }

  /* ---------------- elevation ---------------- */

  {
    let inRange = true;
    for (let i = 0; i < base.h.length; i++) {
      if (base.h[i] < 0 || base.h[i] > 1) inRange = false;
    }
    check("cartograph: heights normalise into 0..1", inRange);
    // Both ends, or the sea level slider means something different per map.
    check("cartograph: normalisation reaches the top", base.peak > 0.999);
    check(
      "cartograph: the default province has both land and sea",
      base.landFraction > 0.2 && base.landFraction < 0.95
    );
  }

  {
    // The continent mask used to be radial, which does not fit a rectangle:
    // corners drowned while the middle of each edge stayed well above water,
    // so land ran straight off all four sides and no coastline existed to put
    // a port on. Nothing threw; the maps were simply crops of something else.
    const n = base.size;
    let wet = true;
    for (let i = 0; i < n && wet; i++) {
      wet =
        base.h[i] < DEFAULT_PARAMS.seaLevel &&
        base.h[(n - 1) * n + i] < DEFAULT_PARAMS.seaLevel &&
        base.h[i * n] < DEFAULT_PARAMS.seaLevel &&
        base.h[i * n + n - 1] < DEFAULT_PARAMS.seaLevel;
    }
    check("cartograph: the border of the map is water", wet);
  }

  {
    // Slope is normalised against the field's own 85th percentile rather than
    // against grid resolution. With the old absolute scale, one cell at 260km
    // across is 1.35km, a dramatic mountainside is a 3% grade, and the entire
    // province classified as bare rock with the snowline never firing once.
    // Asserted through the palette because that is where it was visible.
    const arctic = fieldFromParams({ ...DEFAULT_PARAMS, latitude: 0.85, seed: 4242 });
    let snowy = 0;
    let land = 0;
    for (let i = 0; i < arctic.h.length; i++) {
      if (arctic.h[i] < DEFAULT_PARAMS.seaLevel) continue;
      land++;
      // Snow is the only entry in the palette that is bright and neutral.
      const r = arctic.rgb[i * 3];
      const g = arctic.rgb[i * 3 + 1];
      const b = arctic.rgb[i * 3 + 2];
      if (r > 0.8 && g > 0.8 && b > 0.8) snowy++;
    }
    const cover = land ? snowy / land : 0;
    check("cartograph: an arctic map has snow on it", cover > 0.04);
    check("cartograph: but not only snow", cover < 0.75);
  }

  {
    const tropical = fieldFromParams({ ...DEFAULT_PARAMS, latitude: 0.05, aridity: 0.1 });
    let white = 0;
    for (let i = 0; i < tropical.h.length; i++) {
      if (tropical.rgb[i * 3] > 0.8 && tropical.rgb[i * 3 + 2] > 0.8) white++;
    }
    check("cartograph: a tropical map has no snowfields", white / tropical.h.length < 0.01);
  }

  /* ---------------- places ---------------- */

  {
    const markers = siteMarkers(base, DEFAULT_PARAMS, 9);
    check("cartograph: markers get sited", markers.length >= 6);
    check(
      "cartograph: every marker is on dry land",
      markers.every((m) => dryAt(base, DEFAULT_PARAMS, m.u, m.v))
    );
    // A port one cell from the border has its label drawn half off the map and
    // its harbour off the edge of the world.
    check(
      "cartograph: no marker sits on the border",
      markers.every((m) => m.u > 0.03 && m.u < 0.97 && m.v > 0.03 && m.v < 0.97)
    );
    check(
      "cartograph: marker ids are unique",
      new Set(markers.map((m) => m.id)).size === markers.length
    );
    check(
      "cartograph: a coastal province gets at least one port",
      markers.some((m) => m.kind === "port")
    );
    check("cartograph: every marker is named", markers.every((m) => m.name.trim().length > 1));
  }

  /* ---------------- documents ---------------- */

  {
    const src = new Float32Array([0, 0.25, 0.5, 0.75, 1]);
    const round = unpackHeights(packHeights(src), 3);
    let worst = 0;
    for (let i = 0; i < src.length; i++) worst = Math.max(worst, Math.abs(src[i] - round[i]));
    // 16-bit, so a part in 65535. At 8-bit this would be 2e-3 and a 4000m
    // relief would step in 15m risers across every valley floor.
    check("cartograph: packed heights round-trip to 16-bit precision", worst < 2e-5);
  }

  {
    check(
      "cartograph: a corrupt map is rejected, not half-loaded",
      (() => {
        try {
          parseDoc('{"format":"something-else"}');
          return false;
        } catch {
          return true;
        }
      })()
    );
    check(
      "cartograph: so is one with no parameters",
      (() => {
        try {
          parseDoc('{"format":"voidshell.map","version":1,"name":"x"}');
          return false;
        } catch {
          return true;
        }
      })()
    );
  }

  /* ---------------- the stock maps ---------------- */

  // Their marker coordinates are baked, so they are only correct for the noise
  // that was in the tree when the generator last ran. Change the generator and
  // this is what tells you the holds are now in the sea.
  for (const doc of EXAMPLE_DOCS) {
    const field = fieldFromParams(doc.params);
    check(`cartograph: ${doc.name} parses`, parseDoc(JSON.stringify(doc)).name === doc.name);
    check(
      `cartograph: ${doc.name} — every baked marker is still on land`,
      doc.markers.length > 0 && doc.markers.every((m) => dryAt(field, doc.params, m.u, m.v))
    );
  }

  check(
    "cartograph: the archipelago is mostly water",
    fieldFromParams(EXAMPLE_DOCS[1].params).landFraction < 0.3
  );
  check(
    "cartograph: the northern province is mostly land",
    fieldFromParams(EXAMPLE_DOCS[0].params).landFraction > 0.4
  );
}
