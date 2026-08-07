/**
 * Drawing the water.
 *
 * The old sky view had one water plane, the size of the map, at sea level,
 * with a sine wave bobbing it up and down. That is a defensible way to draw an
 * ocean and it cannot draw anything else: a lake sits above sea level, so it
 * would have been a second plane; a river is neither flat nor level, so it
 * would have been nothing at all.
 *
 * So the water here is a *mesh*, built from the same surface field the
 * hydrology produced. Sea, lakes and rivers are all the same geometry —
 * whichever quads happen to be wet, at whatever height the water stands there.
 * A river is simply a long thin part of it that happens to run downhill, and
 * nothing in this file needs to know that.
 *
 * Only wet quads are emitted. A full-map grid with the dry parts pushed below
 * the terrain would be simpler and would also mean the ocean's triangles are
 * spread across the mountains, where they z-fight with the ground and eat
 * overdraw for water nobody can see.
 */
import * as THREE from "three";

export interface WaterMeshInput {
  /** Water surface per cell in normalised height, -1 where dry. */
  surface: Float32Array;
  /** Terrain height per cell, normalised. */
  ground: Float32Array;
  /** 0..1 river strength per cell. */
  rivers: Float32Array;
  /** Cells per side. */
  n: number;
  /** World units across the map. */
  world: number;
  /** Multiplier from normalised height to world units. */
  heightScale: number;
}

/**
 * Build geometry for every wet quad.
 *
 * Depth and flow ride along as vertex attributes rather than being recomputed
 * in the shader, because both need the *terrain* underneath and the water mesh
 * has no access to it once it is on the GPU.
 */
export function buildWaterGeometry(input: WaterMeshInput): THREE.BufferGeometry | null {
  const { surface, ground, rivers, n, world, heightScale } = input;

  const positions: number[] = [];
  const depths: number[] = [];
  const flows: number[] = [];
  const flowDirs: number[] = [];

  const half = world / 2;
  const step = world / (n - 1);

  const wetAt = (i: number) => surface[i] >= 0;

  /** Water surface in world Y, falling back to the bed where a corner is dry. */
  const surfaceY = (i: number) => (surface[i] >= 0 ? surface[i] : ground[i]) * heightScale;

  /**
   * Downhill direction of the water surface, for scrolling the ripples.
   *
   * A lake's surface is level, so this comes out near zero and the shader
   * falls back to an undirected chop — which is what a lake looks like. A
   * river's surface tilts along its channel, so this points downstream for
   * free. No separate river-direction field, and no special case.
   */
  const flowDirAt = (x: number, y: number): [number, number] => {
    const i = y * n + x;
    const l = surfaceY(y * n + Math.max(0, x - 1));
    const r = surfaceY(y * n + Math.min(n - 1, x + 1));
    const u = surfaceY(Math.max(0, y - 1) * n + x);
    const d = surfaceY(Math.min(n - 1, y + 1) * n + x);
    const dx = l - r;
    const dz = u - d;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return [0, 0];
    void i;
    return [dx / len, dz / len];
  };

  const push = (x: number, y: number) => {
    const i = y * n + x;
    const wy = surfaceY(i);
    positions.push(-half + x * step, wy, -half + y * step);
    // Depth in world units, clamped: past a few hundred units of water the
    // tint has already saturated and the extra range only costs precision.
    depths.push(Math.max(0, wy - ground[i] * heightScale));
    flows.push(rivers[i]);
    const [fx, fz] = flowDirAt(x, y);
    flowDirs.push(fx, fz);
  };

  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const a = y * n + x;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Any wet corner makes the quad wet. Requiring all four would retreat
      // the shoreline by a cell and leave a dry rim around every lake.
      if (!wetAt(a) && !wetAt(b) && !wetAt(c) && !wetAt(d)) continue;

      push(x, y);
      push(x + 1, y);
      push(x, y + 1);

      push(x + 1, y);
      push(x + 1, y + 1);
      push(x, y + 1);
    }
  }

  if (!positions.length) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("aDepth", new THREE.Float32BufferAttribute(depths, 1));
  geo.setAttribute("aFlow", new THREE.Float32BufferAttribute(flows, 1));
  geo.setAttribute("aFlowDir", new THREE.Float32BufferAttribute(flowDirs, 2));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------ */
/* The material                                                        */
/* ------------------------------------------------------------------ */

const VERT = /* glsl */ `
  attribute float aDepth;
  attribute float aFlow;
  attribute vec2 aFlowDir;

  varying float vDepth;
  varying float vFlow;
  varying vec2 vFlowDir;
  varying vec3 vWorld;
  varying vec3 vView;

  void main() {
    vDepth = aDepth;
    vFlow = aFlow;
    vFlowDir = aFlowDir;

    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vView = cameraPosition - world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/**
 * The water shader.
 *
 * Deliberately not `MeshPhysicalMaterial` with transmission. That would give
 * physically-founded refraction and it costs a full-resolution copy of the
 * framebuffer per frame — inside a *second* WebGL context that is already
 * sharing a GPU with the compositor drawing the entire desktop. Everything
 * below is one pass with no render targets: depth tint, a Fresnel term, a
 * specular lobe and two layers of scrolling ripple.
 */
const FRAG = /* glsl */ `
  precision highp float;

  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColour;
  uniform vec3 uSkyColour;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform float uRippleScale;

  varying float vDepth;
  varying float vFlow;
  varying vec2 vFlowDir;
  varying vec3 vWorld;
  varying vec3 vView;

  // Value noise. Cheap, and at ripple scale nobody can tell it from gradient.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  /** Ripple normal, built from the slope of two noise layers moving apart. */
  vec3 ripple(vec2 p, vec2 drift, float scale) {
    float e = 0.06;
    vec2 a = p * scale + drift;
    vec2 b = p * scale * 1.93 - drift * 0.71;
    float h  = noise(a) + noise(b) * 0.5;
    float hx = noise(a + vec2(e, 0.0)) + noise(b + vec2(e, 0.0)) * 0.5;
    float hy = noise(a + vec2(0.0, e)) + noise(b + vec2(0.0, e)) * 0.5;
    return normalize(vec3(h - hx, e * 5.0, h - hy));
  }

  void main() {
    vec3 view = normalize(vView);

    // A river's ripples travel downstream; a lake's have nowhere to go, so
    // they get a slow undirected drift instead. vFlowDir is near zero on level
    // water, which makes this one expression rather than a branch.
    vec2 drift = vFlowDir * uTime * (0.35 + vFlow * 1.4) + vec2(uTime * 0.03, uTime * 0.017);
    vec3 n = ripple(vWorld.xz, drift, uRippleScale);
    // Chop is calmer in the shallows, where the bed damps it.
    float calm = smoothstep(0.0, 12.0, vDepth);
    n = normalize(mix(vec3(0.0, 1.0, 0.0), n, 0.25 + calm * 0.55 + vFlow * 0.3));

    // Depth tint. Shallow water is the colour of what is under it, deep water
    // is the colour of water, and the ramp between them is most of what makes
    // a shoreline read as a shoreline.
    float t = 1.0 - exp(-vDepth * 0.055);
    vec3 body = mix(uShallow, uDeep, t);

    // Fresnel: water is nearly a mirror at grazing angles and nearly clear
    // looking straight down. Schlick, with water's 0.02 normal reflectance.
    float f = 0.02 + 0.98 * pow(1.0 - max(dot(view, n), 0.0), 5.0);

    // Sun glitter.
    vec3 halfway = normalize(uSunDir + view);
    float spec = pow(max(dot(n, halfway), 0.0), 220.0);

    // Foam where the water is shallow enough to be breaking, and along fast
    // river cells. Without it every shoreline is a hard colour boundary.
    float shore = 1.0 - smoothstep(0.0, 5.5, vDepth);
    float churn = noise(vWorld.xz * 0.35 + drift * 2.0);
    float foam = clamp(shore * 0.75 + vFlow * churn * 0.5, 0.0, 1.0);
    foam *= smoothstep(0.35, 0.75, churn * 0.5 + 0.5);

    vec3 colour = mix(body, uSkyColour, f * 0.72);
    colour += uSunColour * spec * 1.6;
    colour = mix(colour, vec3(0.92, 0.95, 0.97), foam * 0.55);

    // Shallow water has to show the bed through it, or a river reads as a
    // strip of blue plastic laid in the valley.
    float alpha = mix(0.42, 0.94, t);
    alpha = max(alpha, foam * 0.8);

    gl_FragColor = vec4(colour, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export interface WaterMaterialHandle {
  material: THREE.ShaderMaterial;
  setSun(dir: THREE.Vector3, colour: THREE.Color): void;
  setSky(colour: THREE.Color): void;
  tick(elapsed: number): void;
  dispose(): void;
}

export function createWaterMaterial(world: number): WaterMaterialHandle {
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
      uSunColour: { value: new THREE.Color(0xfff2dc) },
      uSkyColour: { value: new THREE.Color(0x9dc4ff) },
      uShallow: { value: new THREE.Color(0x2e6f78) },
      uDeep: { value: new THREE.Color(0x071c2e) },
      // Ripples sized against the map, so a 60km valley and an 800km ocean
      // get chop of the same physical size rather than the same pixel size.
      uRippleScale: { value: 900 / world },
    },
  });

  return {
    material,
    setSun(dir, colour) {
      material.uniforms.uSunDir.value.copy(dir).normalize();
      material.uniforms.uSunColour.value.copy(colour);
    },
    setSky(colour) {
      material.uniforms.uSkyColour.value.copy(colour);
      // Deep water takes its cast from the sky; at dusk a midday-blue lake is
      // the single most obvious thing wrong with a scene.
      material.uniforms.uDeep.value.copy(colour).multiplyScalar(0.18).addScalar(0.02);
    },
    tick(elapsed) {
      material.uniforms.uTime.value = elapsed;
    },
    dispose() {
      material.dispose();
    },
  };
}
