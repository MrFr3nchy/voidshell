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
 */
import * as THREE from "three";
import type { Field, Marker, TerrainParams } from "./types";

/** Map width in world units. Everything else is derived from this. */
const WORLD = 1000;

/** Relief maps have always lied about vertical scale; 3800m over 240km is flat. */
export const DEFAULT_EXAGGERATION = 8;

export type Projection = "sky" | "atlas";

export interface SkyViewOptions {
  shadows?: boolean;
  /** Fired when the user double-clicks the ground, in normalised map coords. */
  onPickGround?: (u: number, v: number) => void;
  /** Fired when a marker pin is clicked. */
  onPickMarker?: (id: string) => void;
}

export interface SkyView {
  canvas: HTMLCanvasElement;
  labelLayer: HTMLElement;
  setTerrain(field: Field, params: TerrainParams): void;
  setMarkers(markers: Marker[]): void;
  setSun(t01: number): void;
  setExaggeration(x: number): void;
  setWireframe(on: boolean): void;
  setProjection(p: Projection): void;
  setLabelsVisible(on: boolean): void;
  flyTo(u: number, v: number): void;
  resetView(): void;
  dispose(): void;
}

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

const MARKER_COLOUR: Record<string, number> = {
  hold: 0xffd27f,
  town: 0xffe9c4,
  port: 0x7fd8ff,
  ruin: 0xc79bff,
  peak: 0xffffff,
  camp: 0x9fe6a0,
};

/**
 * Build the view, or return null if this machine cannot draw it.
 *
 * The caller is expected to handle null by saying so — see index.ts, which
 * falls back to the flat atlas rather than showing an empty panel.
 */
export function createSkyView(host: HTMLElement, opts: SkyViewOptions = {}): SkyView | null {
  const canvas = document.createElement("canvas");
  canvas.className = "cg-canvas";

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

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = opts.shadows !== false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const labelLayer = document.createElement("div");
  labelLayer.className = "cg-labels";
  host.append(canvas, labelLayer);

  const scene = new THREE.Scene();
  const skyColour = new THREE.Color(0x0a1220);
  scene.background = skyColour;
  scene.fog = new THREE.FogExp2(skyColour.getHex(), 0.00035);

  /* ---------------- lights ---------------- */

  const sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
  sun.castShadow = opts.shadows !== false;
  sun.shadow.mapSize.set(2048, 2048);
  // A tight ortho frustum around the map. Left at the default it covers a
  // handful of world units and the whole continent renders unshadowed.
  const sc = sun.shadow.camera;
  sc.left = -WORLD * 0.75;
  sc.right = WORLD * 0.75;
  sc.top = WORLD * 0.75;
  sc.bottom = -WORLD * 0.75;
  sc.near = 1;
  sc.far = WORLD * 4;
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 1.5;
  scene.add(sun);
  scene.add(sun.target);

  const sky = new THREE.HemisphereLight(0x9dc4ff, 0x2a2620, 0.85);
  scene.add(sky);

  /* ---------------- the ground ---------------- */

  let terrain: THREE.Mesh | null = null;
  let terrainGeo: THREE.PlaneGeometry | null = null;
  const terrainMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.02,
    flatShading: false,
  });

  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1d4c66,
    transparent: true,
    opacity: 0.78,
    roughness: 0.14,
    metalness: 0.35,
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(WORLD * 2.4, WORLD * 2.4), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.receiveShadow = false;
  water.visible = false;
  scene.add(water);

  const pins = new THREE.Group();
  scene.add(pins);

  /* ---------------- cameras ---------------- */

  const persp = new THREE.PerspectiveCamera(48, 1, 1, WORLD * 8);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, WORLD * 8);
  let projection: Projection = "sky";

  const target = new THREE.Vector3(0, 0, 0);
  // Spherical, damped. theta is the compass bearing, phi the angle down from
  // straight up — clamped short of the horizon so the camera cannot end up
  // underground looking at the back of the terrain.
  const cam = { theta: -0.6, phi: 0.95, radius: WORLD * 1.25 };
  const want = { ...cam };
  const wantTarget = new THREE.Vector3(0, 0, 0);

  let exaggeration = DEFAULT_EXAGGERATION;
  let heightScale = 0;
  let seaY = 0;
  let params: TerrainParams | null = null;
  let markers: Marker[] = [];
  let labelsOn = true;
  const labelEls = new Map<string, HTMLElement>();

  /* ---------------- terrain construction ---------------- */

  function setTerrain(field: Field, p: TerrainParams): void {
    params = p;
    disposeTerrain();

    const n = field.size;
    const geo = new THREE.PlaneGeometry(WORLD, WORLD, n - 1, n - 1);
    // Bakes the rotation into the positions, so vertex i of the attribute is
    // still row-major from the north-west corner and maps 1:1 onto the field.
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colours = new Float32Array(n * n * 3);
    heightScale = worldHeight(p);

    for (let i = 0; i < n * n; i++) {
      pos.setY(i, field.h[i] * heightScale);
      colours[i * 3] = srgbToLinear(field.rgb[i * 3]);
      colours[i * 3 + 1] = srgbToLinear(field.rgb[i * 3 + 1]);
      colours[i * 3 + 2] = srgbToLinear(field.rgb[i * 3 + 2]);
    }
    pos.needsUpdate = true;
    geo.setAttribute("color", new THREE.BufferAttribute(colours, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    terrainGeo = geo;
    terrain = new THREE.Mesh(geo, terrainMat);
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    scene.add(terrain);

    seaY = p.seaLevel * heightScale;
    water.position.y = seaY;
    water.visible = field.landFraction < 0.999;

    resetView();
  }

  /** Vertical world units for the full relief, after exaggeration. */
  function worldHeight(p: TerrainParams): number {
    const km = p.reliefM / 1000;
    return (km / Math.max(1, p.extentKm)) * WORLD * exaggeration;
  }

  function disposeTerrain(): void {
    if (terrain) scene.remove(terrain);
    terrainGeo?.dispose();
    terrain = null;
    terrainGeo = null;
  }

  /* ---------------- markers ---------------- */

  const pinGeo = new THREE.ConeGeometry(WORLD * 0.006, WORLD * 0.022, 5);
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
      // Cone points up by default; flipping it puts the tip on the ground,
      // which is the difference between a pin and a traffic cone.
      mesh.rotation.x = Math.PI;
      mesh.position.copy(markerWorld(m));
      mesh.position.y += WORLD * 0.013;
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

  /** Where a marker sits in the world, riding the terrain it was placed on. */
  function markerWorld(m: Marker): THREE.Vector3 {
    const x = (m.u - 0.5) * WORLD;
    const z = (m.v - 0.5) * WORLD;
    return new THREE.Vector3(x, sampleHeight(m.u, m.v), z);
  }

  /** Bilinear height lookup, straight off the mesh attribute. */
  function sampleHeight(u: number, v: number): number {
    if (!terrainGeo) return 0;
    const pos = terrainGeo.attributes.position as THREE.BufferAttribute;
    const n = Math.round(Math.sqrt(pos.count));
    const fx = Math.min(n - 1, Math.max(0, u * (n - 1)));
    const fy = Math.min(n - 1, Math.max(0, v * (n - 1)));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(n - 1, x0 + 1);
    const y1 = Math.min(n - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const a = pos.getY(y0 * n + x0);
    const b = pos.getY(y0 * n + x1);
    const c = pos.getY(y1 * n + x0);
    const d = pos.getY(y1 * n + x1);
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  /* ---------------- sun ---------------- */

  let sunT = 0.34;

  function setSun(t01: number): void {
    sunT = Math.min(1, Math.max(0, t01));
    // A full arc from dawn through noon to dusk, held just above the horizon
    // at the ends so the terrain never goes fully black.
    const elevation = Math.sin(sunT * Math.PI) * 1.28 - 0.06;
    const azimuth = -Math.PI * 0.35 + sunT * Math.PI * 1.35;
    const r = WORLD * 2;
    const y = Math.sin(elevation) * r;
    const flat = Math.cos(elevation) * r;
    sun.position.set(Math.cos(azimuth) * flat, Math.max(y, WORLD * 0.08), Math.sin(azimuth) * flat);
    sun.target.position.set(0, 0, 0);

    // Warm and dim at the ends, white and bright at noon. The sky and the fog
    // follow it, because a midday-blue horizon under a sunset is uncanny.
    const day = Math.max(0, Math.sin(sunT * Math.PI));
    sun.intensity = 0.55 + day * 2.5;
    sun.color.setHSL(0.09 - day * 0.05, 0.55 - day * 0.35, 0.55 + day * 0.25);
    sky.intensity = 0.35 + day * 0.7;

    skyColour.setHSL(0.60 - day * 0.02, 0.52 - day * 0.16, 0.06 + day * 0.34);
    scene.background = skyColour;
    if (scene.fog instanceof THREE.FogExp2) scene.fog.color.copy(skyColour);
    waterMat.color.setHSL(0.55, 0.5, 0.1 + day * 0.16);
  }

  /* ---------------- controls ---------------- */

  let dragging: "orbit" | "pan" | null = null;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (e: PointerEvent) => {
    dragging = e.button === 2 || e.shiftKey ? "pan" : "orbit";
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

    if (dragging === "orbit") {
      want.theta -= dx * 0.005;
      want.phi = Math.min(Math.PI * 0.495, Math.max(0.06, want.phi - dy * 0.005));
    } else {
      // Pan across the ground plane rather than the screen plane, so dragging
      // at a shallow angle doesn't fly the target off into the sky.
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
    const k = Math.exp(e.deltaY * 0.0012);
    want.radius = Math.min(WORLD * 3, Math.max(WORLD * 0.06, want.radius * k));
  };

  const onContext = (e: Event) => e.preventDefault();

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

  function resetView(): void {
    wantTarget.set(0, 0, 0);
    want.theta = -0.6;
    want.phi = 0.95;
    want.radius = WORLD * 1.25;
  }

  function clampTarget(): void {
    const lim = WORLD * 0.6;
    wantTarget.x = Math.min(lim, Math.max(-lim, wantTarget.x));
    wantTarget.z = Math.min(lim, Math.max(-lim, wantTarget.z));
  }

  function activeCamera(): THREE.Camera {
    return projection === "atlas" ? ortho : persp;
  }

  /* ---------------- the loop ---------------- */

  let frame = 0;
  let width = 1;
  let height = 1;
  const clock = new THREE.Clock();
  const projected = new THREE.Vector3();

  function resize(): void {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    if (w === width && h === height) return;
    width = w;
    height = h;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
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

  function tick(): void {
    frame = requestAnimationFrame(tick);
    resize();
    const dt = Math.min(0.1, clock.getDelta());
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

    // A slow swell rather than a shader: the water is a flat plane and this is
    // the cheapest thing that stops it reading as a sheet of glass.
    water.position.y = seaY + Math.sin(clock.elapsedTime * 0.6) * WORLD * 0.0006;

    renderer.render(scene, activeCamera());
    if (labelsOn) placeLabels();
  }

  function placeLabels(): void {
    const camera = activeCamera();
    for (const m of markers) {
      const el = labelEls.get(m.id);
      if (!el) continue;
      projected.copy(markerWorld(m));
      projected.y += WORLD * 0.026;
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
    setTerrain,
    setMarkers,
    setSun,
    setExaggeration(x: number) {
      exaggeration = Math.max(1, x);
      if (!params || !terrainGeo) return;
      const previous = heightScale || 1;
      heightScale = worldHeight(params);
      const scale = heightScale / previous;
      const pos = terrainGeo.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) * scale);
      pos.needsUpdate = true;
      terrainGeo.computeVertexNormals();
      seaY = params.seaLevel * heightScale;
      water.position.y = seaY;
      setMarkers(markers);
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
    flyTo(u: number, v: number) {
      wantTarget.set((u - 0.5) * WORLD, sampleHeight(u, v), (v - 0.5) * WORLD);
      clampTarget();
      want.radius = Math.min(want.radius, WORLD * 0.28);
      want.phi = Math.min(want.phi, 1.05);
    },
    resetView,
    dispose() {
      cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContext);
      canvas.removeEventListener("dblclick", onDoubleClick);

      disposeTerrain();
      water.geometry.dispose();
      waterMat.dispose();
      terrainMat.dispose();
      pinGeo.dispose();
      for (const m of pinMats.values()) m.dispose();
      pinMats.clear();
      for (const el of labelEls.values()) el.remove();
      labelEls.clear();
      labelLayer.remove();

      renderer.dispose();
      // Explicit: the GC is not in a hurry, and the browser's context budget is
      // shared with the compositor that is drawing everything else.
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
