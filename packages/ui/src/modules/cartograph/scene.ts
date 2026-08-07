/**
 * The sky view: a real camera, over real ground.
 *
 * This is the one place in the module that touches WebGL, and it is written to
 * be *optional*. `createSkyView` returns null rather than throwing when a
 * context cannot be had, because the headless harness launches every app in
 * jsdom — which has no canvas backend — and an app that cannot open its window
 * on a machine without a GPU is an app that fails the smoke test for a reason
 * that has nothing to do with whether it works.
 *
 * It also means a second WebGL context, alongside the compositor's. Browsers
 * cap those at around sixteen and start killing the oldest, so `dispose` here
 * forces the context loss rather than trusting the garbage collector to get
 * round to it — closing and reopening this window a dozen times must not take
 * the void down with it.
 *
 * ## Why the canvas is not sized to its own CSS box
 *
 * Worth reading before touching `resize`. voidshell's compositor projects each
 * floating panel from a point in 3D space and writes the result as a CSS
 * `scale()` between 0.35 and 1.6 — see `projectPanels` in ThreeCompositor. A
 * canvas sized to `clientWidth` therefore renders at layout size and is then
 * *stretched* to whatever the panel's depth happens to imply. At the far end
 * of that range you are looking at a 62%-resolution image upscaled, which is
 * most of what "the maps are blurry" meant. So the drawing buffer is sized by
 * the element's real on-screen scale, read back from its bounding rect.
 */
import * as THREE from "three";
import { bakeTerrain } from "./bake";
import type { BakedTerrain } from "./bake";
import { buildCity } from "./citybuild";
import type { CityBuild } from "./citybuild";
import { isCityMap } from "./citymap";
import { buildWaterGeometry, createWaterMaterial } from "./water";
import type { WaterMaterialHandle } from "./water";
import { QUALITY } from "./types";
import type { CityDoc, Field, Marker, Quality, TerrainParams } from "./types";

/** Map width in world units. Everything else is derived from this. */
const WORLD = 1000;

/** Relief maps have always lied about vertical scale; 3800m over 240km is flat. */
export const DEFAULT_EXAGGERATION = 8;

/**
 * A city gets far less.
 *
 * The terrain default exists because natural relief is genuinely invisible at
 * map scale. Buildings are not: a 541m tower on a 45km map is already a
 * legible object, and multiplying it by eight gives a Manhattan of four-
 * kilometre spikes. Same slider, different sensible starting point.
 */
export const CITY_EXAGGERATION = 2;

export type Projection = "sky" | "atlas";
export type CameraMode = "orbit" | "fly";

export interface SkyViewOptions {
  quality?: Quality;
  shadows?: boolean;
  /** Fired when the user double-clicks the ground, in normalised map coords. */
  onPickGround?: (u: number, v: number) => void;
  /** Fired when a marker pin is clicked. */
  onPickMarker?: (id: string) => void;
  /** Progress, for the window to show while a bake is running. */
  onStatus?: (text: string | null) => void;
}

export interface SkyViewStats {
  buildings: number;
  triangles: number;
  /** Drawing buffer width, so the UI can show what it is really rendering. */
  bufferWidth: number;
}

export interface SkyView {
  canvas: HTMLCanvasElement;
  labelLayer: HTMLElement;
  setMap(field: Field, params: TerrainParams, city?: CityDoc): void;
  setMarkers(markers: Marker[]): void;
  setSun(t01: number): void;
  setExaggeration(x: number): void;
  setWireframe(on: boolean): void;
  setProjection(p: Projection): void;
  setLabelsVisible(on: boolean): void;
  setQuality(q: Quality): void;
  setCameraMode(m: CameraMode): void;
  cameraMode(): CameraMode;
  /**
   * Move the canvas to a different container.
   *
   * Pure view mode takes the map out of its window and puts it on the glass,
   * and moving a live WebGL canvas between parents is legal — the context
   * belongs to the element, not to where it hangs. What is *not* safe is
   * leaving `host` pointing at the old box, because every frame's resize would
   * then size the buffer to a container the canvas no longer lives in.
   */
  reparent(next: HTMLElement): void;
  flyTo(u: number, v: number): void;
  resetView(): void;
  stats(): SkyViewStats;
  dispose(): void;
}

const MARKER_COLOUR: Record<string, number> = {
  hold: 0xffd27f,
  town: 0xffe9c4,
  port: 0x7fd8ff,
  ruin: 0xc79bff,
  peak: 0xffffff,
  camp: 0x9fe6a0,
};

/* ------------------------------------------------------------------ */
/* Sky                                                                 */
/* ------------------------------------------------------------------ */

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    // Translation is dropped from the view matrix, so the dome is nailed to
    // the camera and can never be flown out of.
    vec4 pos = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
    // z = w puts every fragment at the far plane, so the sky loses the depth
    // test to literally everything and needs no ordering of its own.
    gl_Position = pos.xyww;
  }
`;

const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uGround;
  uniform vec3 uSunDir;
  uniform vec3 uSunColour;

  void main() {
    vec3 dir = normalize(vDir);
    // A flat lerp on height gives a visible band; the power curve keeps the
    // gradient tight near the horizon where the atmosphere actually is.
    float up = dir.y;
    float t = pow(clamp(up, 0.0, 1.0), 0.42);
    vec3 sky = mix(uHorizon, uZenith, t);
    // Below the horizon fades to a dark ground haze rather than to nothing —
    // flying under the terrain should not reveal a hard hemisphere edge.
    sky = mix(sky, uGround, smoothstep(0.0, -0.18, up));

    // The sun itself, plus the glow around it.
    float cosA = dot(dir, normalize(uSunDir));
    sky += uSunColour * pow(max(cosA, 0.0), 900.0) * 12.0;
    sky += uSunColour * pow(max(cosA, 0.0), 8.0) * 0.28;

    gl_FragColor = vec4(sky, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

/**
 * Build the view, or return null if this machine cannot draw it.
 *
 * The caller is expected to handle null by saying so — see index.ts, which
 * falls back to the flat atlas rather than showing an empty panel.
 */
export function createSkyView(initialHost: HTMLElement, opts: SkyViewOptions = {}): SkyView | null {
  let host = initialHost;
  const canvas = document.createElement("canvas");
  canvas.className = "cg-canvas";
  // Focusable, because fly mode is driven from the keyboard and a canvas that
  // cannot take focus cannot receive a keydown.
  canvas.tabIndex = 0;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }

  let quality: Quality = opts.quality ?? "balanced";
  let tier = QUALITY[quality];
  const maxAniso = renderer.capabilities.getMaxAnisotropy?.() ?? 1;

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = tier.shadows && opts.shadows !== false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const labelLayer = document.createElement("div");
  labelLayer.className = "cg-labels";
  host.append(canvas, labelLayer);

  const scene = new THREE.Scene();

  /* ---------------- sky ---------------- */

  const skyUniforms = {
    uHorizon: { value: new THREE.Color(0x9fc0e8) },
    uZenith: { value: new THREE.Color(0x2f68b5) },
    uGround: { value: new THREE.Color(0x0d1420) },
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
    uSunColour: { value: new THREE.Color(0xfff2dc) },
  };
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const skyGeo = new THREE.SphereGeometry(1, 32, 16);
  const skyDome = new THREE.Mesh(skyGeo, skyMat);
  skyDome.frustumCulled = false;
  skyDome.renderOrder = -1000;
  scene.add(skyDome);

  const fog = new THREE.FogExp2(0x9fc0e8, 0.00028);
  scene.fog = fog;

  /* ---------------- lights ---------------- */

  const sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
  sun.castShadow = tier.shadows && opts.shadows !== false;
  sun.shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
  const sc = sun.shadow.camera;
  sc.left = -WORLD * 0.75;
  sc.right = WORLD * 0.75;
  sc.top = WORLD * 0.75;
  sc.bottom = -WORLD * 0.75;
  sc.near = 1;
  sc.far = WORLD * 4;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.8;
  scene.add(sun);
  scene.add(sun.target);

  const sky = new THREE.HemisphereLight(0x9dc4ff, 0x2a2620, 0.85);
  scene.add(sky);

  /* ---------------- the ground ---------------- */

  let terrain: THREE.Mesh | null = null;
  let terrainGeo: THREE.BufferGeometry | null = null;
  let baked: BakedTerrain | null = null;

  const terrainMat = new THREE.MeshStandardMaterial({
    roughness: 0.94,
    metalness: 0.0,
  });

  let waterMesh: THREE.Mesh | null = null;
  let waterGeo: THREE.BufferGeometry | null = null;
  const water: WaterMaterialHandle = createWaterMaterial(WORLD);

  let city: CityBuild | null = null;

  const pins = new THREE.Group();
  scene.add(pins);

  /* ---------------- cameras ---------------- */

  const persp = new THREE.PerspectiveCamera(52, 1, 0.5, WORLD * 8);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, WORLD * 8);
  let projection: Projection = "sky";
  let mode: CameraMode = "orbit";

  const target = new THREE.Vector3(0, 0, 0);
  const cam = { theta: -0.6, phi: 0.95, radius: WORLD * 1.25 };
  const want = { ...cam };
  const wantTarget = new THREE.Vector3(0, 0, 0);

  // Fly mode state. Position and Euler angles, integrated directly.
  const flyPos = new THREE.Vector3(0, WORLD * 0.25, WORLD * 0.6);
  const flyLook = { yaw: 0, pitch: -0.3 };
  const flyVel = new THREE.Vector3();
  const keys = new Set<string>();

  let exaggeration = DEFAULT_EXAGGERATION;
  let heightScale = 0;
  let params: TerrainParams | null = null;
  let field: Field | null = null;
  let cityDoc: CityDoc | undefined;
  let markers: Marker[] = [];
  let labelsOn = true;
  const labelEls = new Map<string, HTMLElement>();

  /* ---------------- terrain construction ---------------- */

  /** Vertical world units for the full relief, after exaggeration. */
  function worldHeight(p: TerrainParams): number {
    const km = p.reliefM / 1000;
    return (km / Math.max(1, p.extentKm)) * WORLD * exaggeration;
  }

  /** Bilinear ground height in world units, from the baked mesh field. */
  function groundAt(u: number, v: number): number {
    if (!baked) return 0;
    const n = baked.mesh;
    const x = Math.min(n - 1, Math.max(0, u * (n - 1)));
    const y = Math.min(n - 1, Math.max(0, v * (n - 1)));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(n - 1, x0 + 1);
    const y1 = Math.min(n - 1, y0 + 1);
    const tx = x - x0;
    const ty = y - y0;
    const a = baked.heights[y0 * n + x0];
    const b = baked.heights[y0 * n + x1];
    const c = baked.heights[y1 * n + x0];
    const d = baked.heights[y1 * n + x1];
    return ((a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty) * heightScale;
  }

  function dryAt(u: number, v: number): boolean {
    if (!baked || !params) return true;
    const n = baked.mesh;
    const x = Math.round(Math.min(1, Math.max(0, u)) * (n - 1));
    const y = Math.round(Math.min(1, Math.max(0, v)) * (n - 1));
    return baked.water[y * n + x] < 0;
  }

  function setMap(f: Field, p: TerrainParams, c?: CityDoc): void {
    field = f;
    params = p;
    cityDoc = c;
    rebuild();
    resetView();
  }

  /**
   * Bake and build everything that depends on resolution.
   *
   * Called on open and on every quality change, which is why it is one
   * function rather than inline in `setMap` — a quality switch has to rebuild
   * the mesh, the textures, the water and the city, and doing that from three
   * places is how they drift out of step.
   */
  function rebuild(): void {
    if (!field || !params) return;
    opts.onStatus?.("building terrain…");

    disposeTerrain();

    heightScale = worldHeight(params);
    baked = bakeTerrain(field, field.water, params, tier, maxAniso);

    /* ground mesh */
    const n = baked.mesh;
    const geo = new THREE.PlaneGeometry(WORLD, WORLD, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        pos.setY(i, baked.heights[i] * heightScale);
        // Set UVs explicitly rather than trusting the plane's own after a
        // rotation — a flipped V here mirrors the entire paint job against the
        // geometry, which is subtle enough to ship and obvious once seen.
        uv.setXY(i, x / (n - 1), 1 - y / (n - 1));
      }
    }
    pos.needsUpdate = true;
    uv.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    terrainMat.map = baked.colour;
    terrainMat.normalMap = baked.normal;
    terrainMat.normalScale.set(1.1, 1.1);
    terrainMat.aoMap = baked.surface;
    terrainMat.roughnessMap = baked.surface;
    terrainMat.needsUpdate = true;

    // aoMap reads the second UV set. Same coordinates, so the channel is
    // simply aliased rather than duplicated.
    geo.setAttribute("uv1", geo.attributes.uv);

    terrainGeo = geo;
    terrain = new THREE.Mesh(geo, terrainMat);
    terrain.castShadow = tier.shadows;
    terrain.receiveShadow = tier.shadows;
    scene.add(terrain);

    /* water */
    waterGeo = buildWaterGeometry({
      surface: baked.water,
      ground: baked.heights,
      rivers: baked.rivers,
      n,
      world: WORLD,
      heightScale,
    });
    if (waterGeo) {
      waterMesh = new THREE.Mesh(waterGeo, water.material);
      waterMesh.renderOrder = 10;
      scene.add(waterMesh);
    }

    /* city */
    if (isCityMap(cityDoc)) {
      opts.onStatus?.("raising the city…");
      city = buildCity({
        city: cityDoc,
        world: WORLD,
        extentKm: params.extentKm,
        groundAt,
        dryAt,
        unitsPerMetre: heightScale / params.reliefM,
        tier,
      });
      scene.add(city.group);
    }

    opts.onStatus?.(null);
    setSun(sunT);
    setMarkers(markers);
  }

  function disposeTerrain(): void {
    if (terrain) scene.remove(terrain);
    terrainGeo?.dispose();
    terrain = null;
    terrainGeo = null;

    if (waterMesh) scene.remove(waterMesh);
    waterGeo?.dispose();
    waterMesh = null;
    waterGeo = null;

    if (city) {
      scene.remove(city.group);
      city.dispose();
      city = null;
    }

    baked?.dispose();
    baked = null;
  }

  /* ---------------- markers ---------------- */

  const pinGeo = new THREE.ConeGeometry(WORLD * 0.005, WORLD * 0.02, 5);
  const pinMats = new Map<string, THREE.MeshBasicMaterial>();

  function pinMaterial(kind: string): THREE.MeshBasicMaterial {
    let m = pinMats.get(kind);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color: MARKER_COLOUR[kind] ?? 0xffffff });
      pinMats.set(kind, m);
    }
    return m;
  }

  function setMarkers(list: Marker[]): void {
    markers = list;
    pins.clear();
    for (const el of labelEls.values()) el.remove();
    labelEls.clear();

    for (const m of list) {
      const mesh = new THREE.Mesh(pinGeo, pinMaterial(m.kind));
      mesh.rotation.x = Math.PI;
      mesh.position.copy(markerWorld(m));
      mesh.position.y += WORLD * 0.012;
      mesh.userData.markerId = m.id;
      pins.add(mesh);

      const label = document.createElement("div");
      label.className = `cg-label is-${m.kind}`;
      label.textContent = m.name;
      label.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        opts.onPickMarker?.(m.id);
      });
      labelLayer.appendChild(label);
      labelEls.set(m.id, label);
    }
  }

  function markerWorld(m: Marker): THREE.Vector3 {
    const x = (m.u - 0.5) * WORLD;
    const z = (m.v - 0.5) * WORLD;
    return new THREE.Vector3(x, groundAt(m.u, m.v), z);
  }

  /* ---------------- sun ---------------- */

  let sunT = 0.34;
  /** 0 by day, 1 at night. Drives the window lights and the sky. */
  let night = 0;

  function setSun(t01: number): void {
    sunT = Math.min(1, Math.max(0, t01));
    const elevation = Math.sin(sunT * Math.PI) * 1.28 - 0.06;
    const azimuth = -Math.PI * 0.35 + sunT * Math.PI * 1.35;
    const r = WORLD * 2;
    const y = Math.sin(elevation) * r;
    const flat = Math.cos(elevation) * r;
    sun.position.set(Math.cos(azimuth) * flat, Math.max(y, WORLD * 0.02), Math.sin(azimuth) * flat);
    sun.target.position.set(0, 0, 0);

    const day = Math.max(0, Math.sin(sunT * Math.PI));
    night = Math.pow(1 - day, 1.6);

    sun.intensity = 0.35 + day * 2.7;
    sun.color.setHSL(0.09 - day * 0.05, 0.6 - day * 0.4, 0.52 + day * 0.28);
    sky.intensity = 0.22 + day * 0.75;
    sky.color.setHSL(0.58, 0.45, 0.28 + day * 0.42);

    // Horizon warms and darkens toward the ends of the arc; the zenith goes
    // from near-black to deep blue. Sampling the same day term keeps the fog,
    // the water and the sky consistent, which is the whole reason they are
    // computed here rather than in three places.
    const horizon = new THREE.Color().setHSL(0.09 + day * 0.5, 0.55 - day * 0.15, 0.12 + day * 0.62);
    const zenith = new THREE.Color().setHSL(0.62, 0.62, 0.03 + day * 0.42);
    skyUniforms.uHorizon.value.copy(horizon);
    skyUniforms.uZenith.value.copy(zenith);
    skyUniforms.uGround.value.setHSL(0.6, 0.3, 0.02 + day * 0.08);
    skyUniforms.uSunDir.value.copy(sun.position).normalize();
    skyUniforms.uSunColour.value.copy(sun.color);

    fog.color.copy(horizon);
    water.setSun(sun.position.clone().normalize(), sun.color);
    water.setSky(horizon);
    city?.setNight(night);
  }

  /* ---------------- controls ---------------- */

  let dragging: "orbit" | "pan" | "look" | null = null;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (e: PointerEvent) => {
    canvas.focus();
    if (mode === "fly") dragging = "look";
    else dragging = e.button === 2 || e.shiftKey ? "pan" : "orbit";
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (dragging === "look") {
      flyLook.yaw -= dx * 0.004;
      // Just short of straight up and down. At exactly ±π/2 the forward
      // vector degenerates and the heading becomes undefined.
      flyLook.pitch = Math.min(1.55, Math.max(-1.55, flyLook.pitch - dy * 0.004));
    } else if (dragging === "orbit") {
      want.theta -= dx * 0.005;
      want.phi = Math.min(Math.PI * 0.495, Math.max(0.06, want.phi - dy * 0.005));
    } else {
      const scale = want.radius * 0.0016;
      const sin = Math.sin(want.theta);
      const cos = Math.cos(want.theta);
      wantTarget.x -= (dx * cos - dy * sin) * scale;
      wantTarget.z -= (dx * sin + dy * cos) * scale;
      clampTarget();
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    dragging = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };

  const onWheel = (e: WheelEvent) => {
    // Ctrl/⌘ + wheel belongs to the shell — it moves the whole panel in depth.
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    if (mode === "fly") {
      // In fly mode the wheel is a throttle rather than a zoom.
      flySpeed = Math.min(WORLD * 0.9, Math.max(WORLD * 0.01, flySpeed * Math.exp(-e.deltaY * 0.0012)));
      return;
    }
    const k = Math.exp(e.deltaY * 0.0012);
    want.radius = Math.min(WORLD * 3, Math.max(WORLD * 0.02, want.radius * k));
  };

  const onContext = (e: Event) => e.preventDefault();

  /**
   * Keys, and why they are swallowed.
   *
   * The shell binds space to the launcher ring and several letters to system
   * verbs. Flying with WASD inside a window that is also listening for those
   * would summon the launcher every time you rose. So fly mode stops the event
   * dead — but only in fly mode, and only for keys it actually uses, because
   * silently eating every keystroke in a focused panel is its own bug.
   */
  const FLY_KEYS = new Set([
    "w", "a", "s", "d", "q", "e", "r", "f",
    "arrowup", "arrowdown", "arrowleft", "arrowright", " ", "shift",
  ]);

  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (mode !== "fly" || !FLY_KEYS.has(key)) return;
    keys.add(key);
    e.preventDefault();
    e.stopPropagation();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase();
    keys.delete(key);
    if (mode === "fly" && FLY_KEYS.has(key)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onBlur = () => keys.clear();

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const onDoubleClick = (e: MouseEvent) => {
    if (!terrain) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, activeCamera());

    const onPin = raycaster.intersectObjects(pins.children, false)[0];
    if (onPin) {
      const id = onPin.object.userData.markerId;
      if (typeof id === "string") {
        opts.onPickMarker?.(id);
        return;
      }
    }
    const hit = raycaster.intersectObject(terrain, false)[0];
    if (!hit) return;
    opts.onPickGround?.(
      Math.min(1, Math.max(0, hit.point.x / WORLD + 0.5)),
      Math.min(1, Math.max(0, hit.point.z / WORLD + 0.5))
    );
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContext);
  canvas.addEventListener("dblclick", onDoubleClick);
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("blur", onBlur);

  let flySpeed = WORLD * 0.12;

  function resetView(): void {
    wantTarget.set(0, 0, 0);
    want.theta = -0.6;
    want.phi = 0.95;
    want.radius = WORLD * 1.25;
    target.copy(wantTarget);
    cam.theta = want.theta;
    cam.phi = want.phi;
    cam.radius = want.radius;

    flyPos.set(0, heightScale * 0.6 + WORLD * 0.18, WORLD * 0.55);
    flyLook.yaw = 0;
    flyLook.pitch = -0.42;
    flyVel.set(0, 0, 0);
    flySpeed = WORLD * 0.12;
  }

  function clampTarget(): void {
    const lim = WORLD * 0.6;
    wantTarget.x = Math.min(lim, Math.max(-lim, wantTarget.x));
    wantTarget.z = Math.min(lim, Math.max(-lim, wantTarget.z));
  }

  function activeCamera(): THREE.Camera {
    if (mode === "fly") return persp;
    return projection === "atlas" ? ortho : persp;
  }

  /* ---------------- the loop ---------------- */

  let frame = 0;
  let width = 1;
  let height = 1;
  let bufferScale = 0;
  const clock = new THREE.Clock();
  const projected = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);

  /**
   * Size the drawing buffer to real device pixels, through the compositor's
   * CSS scale. See the note at the top of this file.
   */
  function resize(): void {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);

    const rect = canvas.getBoundingClientRect();
    const cssWidth = canvas.clientWidth || w;
    const onScreenScale = cssWidth > 0 && rect.width > 0 ? rect.width / cssWidth : 1;
    // Capped: a panel pulled right up to the camera would otherwise ask for a
    // buffer several times the screen, which costs far more than it shows.
    const ratio = Math.min(3, (window.devicePixelRatio || 1) * onScreenScale);

    // Only re-allocate when the scale has actually moved. The panel's depth
    // changes continuously as the void drifts, and resizing the framebuffer
    // every frame is a stall on every driver.
    const scaleChanged = Math.abs(ratio - bufferScale) / (bufferScale || 1) > 0.02;
    if (w === width && h === height && !scaleChanged) return;

    width = w;
    height = h;
    bufferScale = ratio;
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    persp.aspect = w / h;
    persp.updateProjectionMatrix();
    updateOrtho();
  }

  function updateOrtho(): void {
    const aspect = width / height;
    const half = want.radius * 0.62;
    ortho.left = -half * aspect;
    ortho.right = half * aspect;
    ortho.top = half;
    ortho.bottom = -half;
    ortho.updateProjectionMatrix();
  }

  /** Integrate the fly camera. Acceleration and drag, not teleporting. */
  function stepFly(dt: number): void {
    forward.set(
      Math.sin(flyLook.yaw) * Math.cos(flyLook.pitch),
      Math.sin(flyLook.pitch),
      Math.cos(flyLook.yaw) * Math.cos(flyLook.pitch)
    );
    right.crossVectors(forward, worldUp).normalize();

    const accel = new THREE.Vector3();
    if (keys.has("w") || keys.has("arrowup")) accel.add(forward);
    if (keys.has("s") || keys.has("arrowdown")) accel.sub(forward);
    if (keys.has("d") || keys.has("arrowright")) accel.add(right);
    if (keys.has("a") || keys.has("arrowleft")) accel.sub(right);
    if (keys.has("e") || keys.has(" ")) accel.add(worldUp);
    if (keys.has("q")) accel.sub(worldUp);

    const boost = keys.has("shift") ? 3.4 : 1;
    if (accel.lengthSq() > 0) {
      accel.normalize().multiplyScalar(flySpeed * boost);
    }

    // Exponential approach rather than a hard set, so starting and stopping
    // have weight. Frame-rate independent, which matters because this runs at
    // whatever rate a window sharing a GPU with the compositor manages.
    const k = 1 - Math.pow(0.0009, dt);
    flyVel.lerp(accel, k);
    flyPos.addScaledVector(flyVel, dt);

    // Stay above the ground, and inside the world. Flying under the terrain is
    // not forbidden so much as pointless — there is nothing under there and
    // the sky dome's ground colour is all you would see.
    const lim = WORLD * 1.4;
    flyPos.x = Math.min(lim, Math.max(-lim, flyPos.x));
    flyPos.z = Math.min(lim, Math.max(-lim, flyPos.z));
    const u = flyPos.x / WORLD + 0.5;
    const v = flyPos.z / WORLD + 0.5;
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
      const floor = groundAt(u, v) + WORLD * 0.004;
      if (flyPos.y < floor) {
        flyPos.y = floor;
        if (flyVel.y < 0) flyVel.y = 0;
      }
    }
    flyPos.y = Math.min(WORLD * 2.2, flyPos.y);

    persp.position.copy(flyPos);
    persp.lookAt(flyPos.x + forward.x, flyPos.y + forward.y, flyPos.z + forward.z);
  }

  function tick(): void {
    frame = requestAnimationFrame(tick);
    resize();
    const dt = Math.min(0.1, clock.getDelta());

    if (mode === "fly") {
      stepFly(dt);
    } else {
      const k = 1 - Math.pow(0.0015, dt);
      cam.theta += (want.theta - cam.theta) * k;
      cam.phi += (want.phi - cam.phi) * k;
      cam.radius += (want.radius - cam.radius) * k;
      target.lerp(wantTarget, k);

      const sinPhi = Math.sin(cam.phi);
      persp.position.set(
        target.x + cam.radius * sinPhi * Math.sin(cam.theta),
        target.y + cam.radius * Math.cos(cam.phi),
        target.z + cam.radius * sinPhi * Math.cos(cam.theta)
      );
      persp.lookAt(target);

      ortho.position.set(target.x, WORLD * 2.5, target.z);
      ortho.up.set(Math.sin(cam.theta), 0, Math.cos(cam.theta));
      ortho.lookAt(target.x, 0, target.z);
      updateOrtho();
    }

    // Keep the shadow frustum around the camera rather than the origin, or a
    // map flown across at low altitude loses its shadows the moment the far
    // side of the island leaves the fixed box.
    const focus = mode === "fly" ? flyPos : target;
    sun.target.position.set(focus.x, 0, focus.z);
    sun.position.set(
      focus.x + skyUniforms.uSunDir.value.x * WORLD * 2,
      skyUniforms.uSunDir.value.y * WORLD * 2,
      focus.z + skyUniforms.uSunDir.value.z * WORLD * 2
    );

    water.tick(clock.elapsedTime);
    renderer.render(scene, activeCamera());
    if (labelsOn) placeLabels();
  }

  function placeLabels(): void {
    const camera = activeCamera();
    for (const m of markers) {
      const el = labelEls.get(m.id);
      if (!el) continue;
      projected.copy(markerWorld(m));
      projected.y += WORLD * 0.024;
      projected.project(camera);

      const behind = projected.z > 1 || projected.z < -1;
      const off =
        projected.x < -1.1 || projected.x > 1.1 || projected.y < -1.1 || projected.y > 1.1;
      if (behind || off) {
        el.style.opacity = "0";
        continue;
      }
      el.style.opacity = "1";
      el.style.transform = `translate(-50%, -100%) translate(${
        (projected.x * 0.5 + 0.5) * width
      }px, ${(-projected.y * 0.5 + 0.5) * height}px)`;
    }
  }

  frame = requestAnimationFrame(tick);
  setSun(sunT);

  /* ---------------- the handle ---------------- */

  return {
    canvas,
    labelLayer,
    setMap,
    setMarkers,
    setSun,

    setExaggeration(x: number) {
      exaggeration = Math.max(0.25, x);
      if (!params || !field) return;
      // A full rebuild rather than rescaling the vertices in place. The old
      // version scaled the position attribute, which is cheap and leaves the
      // water mesh, the building bases and the baked occlusion all describing
      // the previous terrain.
      rebuild();
    },

    setWireframe(on: boolean) {
      terrainMat.wireframe = on;
      terrainMat.needsUpdate = true;
    },

    setProjection(p: Projection) {
      projection = p;
      updateOrtho();
    },

    setLabelsVisible(on: boolean) {
      labelsOn = on;
      labelLayer.style.display = on ? "" : "none";
    },

    setQuality(q: Quality) {
      if (q === quality) return;
      quality = q;
      tier = QUALITY[q];
      renderer.shadowMap.enabled = tier.shadows && opts.shadows !== false;
      sun.castShadow = tier.shadows && opts.shadows !== false;
      sun.shadow.mapSize.set(tier.shadowMap, tier.shadowMap);
      // The shadow map is allocated lazily and will not resize itself.
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
      rebuild();
    },

    setCameraMode(m: CameraMode) {
      if (m === mode) return;
      // Hand the new camera the old one's viewpoint, so switching is a change
      // of controls rather than a jump cut to somewhere else on the map.
      if (m === "fly") {
        flyPos.copy(persp.position);
        const dir = new THREE.Vector3();
        persp.getWorldDirection(dir);
        flyLook.yaw = Math.atan2(dir.x, dir.z);
        flyLook.pitch = Math.asin(Math.min(1, Math.max(-1, dir.y)));
        flyVel.set(0, 0, 0);
        canvas.focus();
      } else {
        const dir = new THREE.Vector3();
        persp.getWorldDirection(dir);
        // Aim the orbit target at whatever the fly camera was looking at, one
        // radius ahead — otherwise leaving fly mode swings you back to the
        // middle of the map for no reason the user asked for.
        wantTarget.copy(flyPos).addScaledVector(dir, want.radius);
        wantTarget.y = 0;
        clampTarget();
        target.copy(wantTarget);
        want.theta = Math.atan2(-dir.x, -dir.z);
        want.phi = Math.min(Math.PI * 0.495, Math.max(0.06, Math.acos(-dir.y)));
        cam.theta = want.theta;
        cam.phi = want.phi;
      }
      mode = m;
      keys.clear();
    },

    cameraMode: () => mode,

    reparent(next: HTMLElement) {
      host = next;
      next.append(canvas, labelLayer);
      // Force the next frame to re-measure from scratch. Without this the
      // cached width/height match the old container and `resize` early-outs,
      // leaving the buffer at the window's size on a full-screen widget.
      width = 0;
      height = 0;
      bufferScale = 0;
    },

    flyTo(u: number, v: number) {
      const y = groundAt(u, v);
      if (mode === "fly") {
        flyPos.set((u - 0.5) * WORLD, y + WORLD * 0.08, (v - 0.5) * WORLD + WORLD * 0.12);
        flyLook.yaw = Math.PI;
        flyLook.pitch = -0.3;
        return;
      }
      wantTarget.set((u - 0.5) * WORLD, y, (v - 0.5) * WORLD);
      clampTarget();
      want.radius = Math.min(want.radius, WORLD * 0.22);
      want.phi = Math.min(want.phi, 1.05);
    },

    resetView,

    stats: () => ({
      buildings: city?.count ?? 0,
      triangles: renderer.info.render.triangles,
      bufferWidth: renderer.domElement.width,
    }),

    dispose() {
      cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContext);
      canvas.removeEventListener("dblclick", onDoubleClick);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("blur", onBlur);

      disposeTerrain();
      terrainMat.dispose();
      water.dispose();
      skyGeo.dispose();
      skyMat.dispose();
      pinGeo.dispose();
      for (const m of pinMats.values()) m.dispose();
      pinMats.clear();
      for (const el of labelEls.values()) el.remove();
      labelEls.clear();
      labelLayer.remove();

      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
