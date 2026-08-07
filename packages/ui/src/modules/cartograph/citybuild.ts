/**
 * Putting the buildings up.
 *
 * Two decisions shape this whole file.
 *
 * The first is instancing. A city at this scale is tens of thousands of
 * boxes, and tens of thousands of `Mesh` objects is tens of thousands of draw
 * calls — which is not slow so much as *impossible*, several seconds a frame
 * before the GPU has drawn anything. One `InstancedMesh` per district kind is
 * a handful of draw calls for the entire city.
 *
 * The second is that the windows are drawn by `onBeforeCompile` on a standard
 * material rather than by a `ShaderMaterial` of our own. A custom shader would
 * be less fiddly to write and would silently opt every building out of the
 * shadow and lighting system — buildings would neither receive the terrain's
 * shadows nor each other's, which in a dense downtown is most of what makes
 * the massing readable. Injecting into `MeshStandardMaterial` keeps all of
 * that and costs about thirty lines of string splicing.
 */
import * as THREE from "three";
import { inRing, ringBounds, ringCentroid } from "./citymap";
import { rng } from "./noise";
import type { CityDoc, District, Landmark, QualityTier } from "./types";

export interface CityBuildInput {
  city: CityDoc;
  /** World units across the map. */
  world: number;
  /** Kilometres across the map, so metres can be turned into map fractions. */
  extentKm: number;
  /** Ground height in world units at normalised coordinates. */
  groundAt: (u: number, v: number) => number;
  /** Is this point above the waterline? Buildings do not go in the harbour. */
  dryAt: (u: number, v: number) => boolean;
  /** World units per metre, after vertical exaggeration. */
  unitsPerMetre: number;
  tier: QualityTier;
}

export interface CityBuild {
  group: THREE.Group;
  count: number;
  /** Anchors for the landmark labels, in world space. */
  labels: { name: string; position: THREE.Vector3 }[];
  setNight(night: number): void;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* Material                                                            */
/* ------------------------------------------------------------------ */

const PALETTE: Record<District["kind"], number[]> = {
  downtown: [0xa8aeb9, 0x9aa4b2, 0xb4bac2, 0x8b95a4, 0xc0c4c9],
  midrise: [0x93867a, 0x8a7f74, 0x9c9086, 0x7d7268, 0xa8998a],
  lowrise: [0x8a7f76, 0x7b6f66, 0x94897e, 0x6d635c, 0x9c9084],
  industrial: [0x6f7268, 0x7d8074, 0x63665e],
  park: [0x3c5a34],
};

/**
 * A standard material that grows a window grid.
 *
 * The pattern is computed from the fragment's position on the face in *world*
 * metres, which is the only way floors line up across buildings of different
 * heights. Deriving it from UVs instead would stretch the storeys to fit
 * whatever box they were on, and a forty-storey tower and a four-storey walkup
 * would have windows the same size on screen.
 */
function createBuildingMaterial(unitsPerMetre: number): {
  material: THREE.MeshStandardMaterial;
  setNight(n: number): void;
  dispose(): void;
} {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.72,
    metalness: 0.08,
  });

  const uNight = { value: 0 };
  // Three and a half metres a storey, and a four-metre bay. Both in world
  // units, so the grid is a real size rather than a texture frequency.
  const uFloor = { value: 3.5 * unitsPerMetre };
  const uBay = { value: 4.2 * unitsPerMetre };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight;
    shader.uniforms.uFloorHeight = uFloor;
    shader.uniforms.uBayWidth = uBay;

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
         attribute vec3 aScale;
         attribute float aSeed;
         varying vec3 vLocal;
         varying vec3 vScaleV;
         varying float vSeedV;
         varying vec3 vObjNormal;`
      )
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
         vObjNormal = objectNormal;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
         vLocal = position;
         vScaleV = aScale;
         vSeedV = aSeed;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
         uniform float uNight;
         uniform float uFloorHeight;
         uniform float uBayWidth;
         varying vec3 vLocal;
         varying vec3 vScaleV;
         varying float vSeedV;
         varying vec3 vObjNormal;

         float winHash(vec2 p) {
           return fract(sin(dot(p, vec2(41.3, 289.1))) * 21374.531);
         }

         /*
          * How much of the window grid this fragment can honestly show.
          *
          * The pattern is procedural, so it has no mipmaps and nothing is
          * filtering it. Once a whole bay-by-storey cell is smaller than a
          * pixel, sampling it point-wise is undersampling by definition, and
          * the result is not "fine detail" but moire — which across a borough
          * of low-rise blocks read as a blue-green plaid laid over Queens, and
          * crawled whenever the camera moved. fwidth() says how much of the
          * pattern one pixel spans, so the grid can simply dissolve into the
          * facade's flat colour exactly when it stops being resolvable.
          */
         float winSharpness(vec2 cell) {
           vec2 w = fwidth(cell);
           return clamp(1.0 - max(w.x, w.y) * 1.6, 0.0, 1.0);
         }`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         {
           // The unit box is 1 wide and 1 deep, with y running 0..1, so the
           // roof is the only face whose object normal has any Y in it.
           float roof = step(0.5, abs(vObjNormal.y));

           // Distance along whichever wall this is, in world units.
           float along = mix(vLocal.z * vScaleV.z, vLocal.x * vScaleV.x, step(0.5, abs(vObjNormal.z)));
           float up = vLocal.y * vScaleV.y;

           vec2 cell = vec2(along / uBayWidth, up / uFloorHeight);
           vec2 f = fract(cell);
           // The mullion. Windows stop short of the top of each storey, which
           // is what gives a facade its horizontal banding.
           float pane = step(0.16, f.x) * step(f.x, 0.84) * step(0.30, f.y) * step(f.y, 0.88);
           // No windows at street level or on the roof.
           pane *= (1.0 - roof) * step(uFloorHeight * 0.9, up);
           pane *= winSharpness(cell);

           // Glass is darker and bluer than the spandrel around it.
           vec3 glass = diffuseColor.rgb * 0.42 + vec3(0.03, 0.05, 0.08);
           diffuseColor.rgb = mix(diffuseColor.rgb, glass, pane);

           // Roofs are grubbier than walls. Every one of these is visible from
           // above for most of the time this map is looked at, so a city of
           // clean rooftops reads as a render rather than a place.
           diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.62 + vec3(0.02), roof * 0.75);
         }`
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
         {
           float roof = step(0.5, abs(vObjNormal.y));
           float along = mix(vLocal.z * vScaleV.z, vLocal.x * vScaleV.x, step(0.5, abs(vObjNormal.z)));
           float up = vLocal.y * vScaleV.y;
           vec2 cell = vec2(along / uBayWidth, up / uFloorHeight);
           vec2 f = fract(cell);
           float pane = step(0.16, f.x) * step(f.x, 0.84) * step(0.30, f.y) * step(f.y, 0.88);
           pane *= (1.0 - roof) * step(uFloorHeight * 0.9, up);
           // Lit windows fade with the same term, or a city seen from orbit
           // glows as one solid sheet of light.
           pane *= winSharpness(cell);

           // Which windows are lit is fixed per building per cell, so they do
           // not crawl as the camera moves — and only some of them are, because
           // a tower with every window lit reads as a lightbox.
           float lit = winHash(floor(cell) + vSeedV * 37.0);
           lit = step(0.62, lit);
           vec3 warm = vec3(1.0, 0.86, 0.62);
           totalEmissiveRadiance += warm * pane * lit * uNight * 1.35;
         }`
      );
  };

  return {
    material,
    setNight(n) {
      uNight.value = Math.max(0, Math.min(1, n));
    },
    dispose() {
      material.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Massing                                                             */
/* ------------------------------------------------------------------ */

interface Box {
  u: number;
  v: number;
  /** World units. */
  width: number;
  depth: number;
  heightM: number;
  angle: number;
  colour: number;
}

/**
 * Walk a district's street grid and decide what stands on each block.
 *
 * The grid is generated in the district's own rotated frame and then turned
 * back into map coordinates, rather than generating in map coordinates and
 * rotating the buildings. The difference matters: the second way gives rotated
 * buildings on an unrotated grid, which is a field of diamonds rather than a
 * street plan.
 */
function massDistrict(
  d: District,
  input: CityBuildInput,
  r: () => number,
  out: Box[]
): void {
  if (d.density <= 0 || d.baseHeightM <= 0) return;

  const { world } = input;
  const bounds = ringBounds(d.ring);
  const [cu, cv] = ringCentroid(d.ring);

  // Normalised map units per metre.
  const unitPerM = 1 / (input.extentKm * 1000);

  const shortU = d.blockM * unitPerM;
  const longU = d.blockM * d.blockAspect * unitPerM;
  if (shortU <= 0 || longU <= 0) return;

  const cos = Math.cos(d.gridAngle);
  const sin = Math.sin(d.gridAngle);

  // The district's own radius, for the height falloff. Half the diagonal of
  // its bounding box is close enough and costs nothing.
  const radius = Math.hypot(bounds.u1 - bounds.u0, bounds.v1 - bounds.v0) * 0.5 || 1;

  // Work in the rotated frame, over a box big enough to cover the district
  // whatever angle it is at.
  const span = Math.hypot(bounds.u1 - bounds.u0, bounds.v1 - bounds.v0);
  const steps = Math.ceil(span / Math.min(shortU, longU)) + 2;

  const palette = PALETTE[d.kind] ?? PALETTE.lowrise;
  // Downtown blocks hold several towers; a suburb reads fine as one mass per
  // block, and subdividing it would multiply the instance count by four for
  // detail nobody can resolve from the air.
  const split = d.kind === "downtown" ? 2 : d.kind === "midrise" ? 2 : 1;

  for (let j = -steps; j <= steps; j++) {
    for (let i = -steps; i <= steps; i++) {
      for (let sy = 0; sy < split; sy++) {
        for (let sx = 0; sx < split; sx++) {
          const localX = (i + (sx + 0.5) / split) * longU;
          const localY = (j + (sy + 0.5) / split) * shortU;

          const u = cu + localX * cos - localY * sin;
          const v = cv + localX * sin + localY * cos;

          if (u < bounds.u0 || u > bounds.u1 || v < bounds.v0 || v > bounds.v1) continue;
          if (!inRing(d.ring, u, v)) continue;
          if (r() > d.density) continue;
          if (!input.dryAt(u, v)) continue;

          // Height falls off from the middle of the district. Without it a
          // downtown is a plateau of identical towers with a hard edge, which
          // is the single most obvious tell of a generated city.
          const dist = Math.hypot(u - cu, v - cv) / radius;
          const fall = 1 - d.falloff * Math.min(1, dist) ** 1.4;
          // A wide spread, skewed low. Most buildings anywhere are short.
          const roll = r();
          const variation = 0.35 + roll * roll * 1.5;
          const heightM = Math.max(6, d.baseHeightM * fall * variation);

          const fillShort = (0.62 + r() * 0.22) / split;
          const fillLong = (0.62 + r() * 0.22) / split;

          out.push({
            u,
            v,
            width: longU * fillLong * world,
            depth: shortU * fillShort * world,
            heightM,
            angle: -d.gridAngle,
            colour: palette[Math.floor(r() * palette.length) % palette.length],
          });
        }
      }
    }
  }
}

/**
 * A landmark, as a stack of setbacks.
 *
 * One box would be honest about the footprint and wrong about everything else.
 * The towers people recognise here are recognisable *because* of their
 * profile — the Empire State and the Chrysler are a series of shrinking
 * blocks, and drawn as single slabs they read as anonymous office stock. The
 * `taper` on each landmark is how much of the base survives to the top, which
 * is enough to tell a 1930s ziggurat from a modern glass shaft.
 */
function massLandmark(
  l: Landmark,
  input: CityBuildInput,
  r: () => number,
  out: Box[]
): void {
  const unitPerM = 1 / (input.extentKm * 1000);
  const taper = l.taper ?? 0.8;
  // A sharply tapered tower needs more stages to read as a taper rather than
  // as a mistake; a shaft needs two and looks wrong with five.
  const stages = taper > 0.9 ? 2 : taper > 0.6 ? 3 : 4;

  for (let s = 0; s < stages; s++) {
    const t0 = s / stages;
    const t1 = (s + 1) / stages;
    // Each stage rises from the ground so the stack is solid rather than a
    // set of floating slabs — cheaper than trimming, and invisible.
    const top = l.heightM * t1;
    const scale = 1 - (1 - taper) * t0;
    const side = l.footprintM * scale * unitPerM * input.world;

    out.push({
      u: l.u,
      v: l.v,
      width: side,
      depth: side,
      heightM: top,
      angle: r() * 0.06,
      colour: 0xb3b0a6,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * A unit box with its base at y=0, so scaling y scales the height directly.
 *
 * The white `color` attribute is not decorative and removing it turns every
 * building black. `vertexColors: true` makes three define `USE_COLOR`, which
 * declares `attribute vec3 color` and — crucially — is also the only define
 * that makes the *fragment* shader apply `vColor` at all. With the define on
 * and the attribute absent, WebGL supplies (0,0,0) for it, `vColor` is zeroed
 * before `instanceColor` is multiplied in, and the whole city renders as
 * silhouettes. Supplying white makes the chain `1 * white * instanceColor`.
 */
function unitBox(): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const count = geo.attributes.position.count;
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 3).fill(1), 3));
  return geo;
}

export function buildCity(input: CityBuildInput): CityBuild {
  const { city, tier } = input;
  const r = rng(city.seed);

  const boxes: Box[] = [];
  for (const d of city.districts) massDistrict(d, input, r, boxes);
  for (const l of city.landmarks) massLandmark(l, input, r, boxes);

  // Thin deterministically rather than truncating. Cutting the tail would
  // delete whichever district happened to be built last — the whole of Queens
  // vanishing at the low quality setting.
  let kept = boxes;
  if (boxes.length > tier.buildings) {
    const keep = tier.buildings / boxes.length;
    const thin = rng(city.seed ^ 0x51ed270b);
    // Landmarks are never thinned; they are the point.
    const landmarkCount = city.landmarks.reduce(
      (n, l) => n + ((l.taper ?? 0.8) > 0.9 ? 2 : (l.taper ?? 0.8) > 0.6 ? 3 : 4),
      0
    );
    const fillers = boxes.slice(0, boxes.length - landmarkCount).filter(() => thin() < keep);
    kept = fillers.concat(boxes.slice(boxes.length - landmarkCount));
  }

  const group = new THREE.Group();
  const geometry = unitBox();
  const { material, setNight, dispose: disposeMaterial } = createBuildingMaterial(
    input.unitsPerMetre
  );

  const mesh = new THREE.InstancedMesh(geometry, material, kept.length);
  mesh.castShadow = tier.shadows;
  mesh.receiveShadow = tier.shadows;
  // The city is static; telling three so skips a per-frame matrix upload of
  // everything on the island.
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

  const scales = new Float32Array(kept.length * 3);
  const seeds = new Float32Array(kept.length);
  const colour = new THREE.Color();
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const half = input.world / 2;

  for (let i = 0; i < kept.length; i++) {
    const b = kept[i];
    const height = b.heightM * input.unitsPerMetre;

    pos.set(-half + b.u * input.world, input.groundAt(b.u, b.v), -half + b.v * input.world);
    // Sink the base slightly. Ground sampled at the centre of a footprint
    // leaves the downhill corners of a building hanging in the air on any
    // slope, and a city of levitating boxes is worse than one that is bedded
    // a few metres into the hill.
    pos.y -= height * 0.02 + input.unitsPerMetre * 2;

    quat.setFromAxisAngle(up, b.angle);
    scale.set(b.width, height, b.depth);
    matrix.compose(pos, quat, scale);
    mesh.setMatrixAt(i, matrix);

    scales[i * 3] = b.width;
    scales[i * 3 + 1] = height;
    scales[i * 3 + 2] = b.depth;
    seeds[i] = (i * 0.6180339887) % 1;

    colour.setHex(b.colour).convertSRGBToLinear();
    mesh.setColorAt(i, colour);
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  geometry.setAttribute("aScale", new THREE.InstancedBufferAttribute(scales, 3));
  geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
  geometry.computeBoundingSphere();
  group.add(mesh);

  const labels = city.landmarks.map((l) => ({
    name: l.name,
    position: new THREE.Vector3(
      -half + l.u * input.world,
      input.groundAt(l.u, l.v) + l.heightM * input.unitsPerMetre,
      -half + l.v * input.world
    ),
  }));

  return {
    group,
    count: kept.length,
    labels,
    setNight,
    dispose() {
      geometry.dispose();
      disposeMaterial();
      mesh.dispose();
      group.clear();
    },
  };
}
