import * as THREE from "three";
import type {
  AnchorHandle,
  ArrangeMode,
  BodyKind,
  Compositor,
  CompositorStats,
  GroupInfo,
  Surface,
  SurfacePlacement,
  Vec3,
} from "../kernel/types";
import { nebulaFragment, nebulaVertex } from "../world/nebulaShader";
import { Compass, type CompassItem } from "../ui/compass";

interface PanelEntry {
  id: string;
  title: string;
  el: HTMLElement;
  /** Own world anchor, used when the panel isn't merged onto a body. */
  anchor: THREE.Vector3;
  bodyId: string | null;
  /** World-space offset from a body when merged. */
  offset: THREE.Vector3;
  groupId: string | null;
  /** Pinned panels leave the world and stick to the glass of the screen. */
  pinned: boolean;
  pinX: number;
  pinY: number;
  minimized: boolean;
  width: number;
  height: number;
  /** Per-panel phase so ambient drift doesn't move everything in lockstep. */
  phase: number;
  /** Last computed screen position, reused by tethers and link-dragging. */
  sx: number;
  sy: number;
  onScreen: boolean;
}

/** A piece of DOM pinned to a world position — desktop icons and the like. */
interface AnchorEntry {
  el: HTMLElement;
  anchor: THREE.Vector3;
}

interface BodyEntry {
  id: string;
  kind: BodyKind;
  group: THREE.Group;
  position: THREE.Vector3;
  radius: number;
  elevation: number;
  phase: number;
  speed: number;
  spin: number;
  sx: number;
  sy: number;
  onScreen: boolean;
}

interface GroupEntry {
  id: string;
  name: string;
  members: Set<string>;
  color: string;
}

const PLANET_COLORS = [0x6ec6ff, 0xb98cff, 0x5fd6a8, 0xff9d6e];
const GROUP_COLORS = ["#4fe3d0", "#c05cff", "#ff8a5c", "#7ea8ff", "#5fd6a8"];
const SVG_NS = "http://www.w3.org/2000/svg";

// Depth range a panel can be scrolled through. Chosen to line up with the
// on-screen scale clamp in projectPanels, so every notch of the wheel produces
// a visible size change instead of dead-zoning at the ends.
const MIN_DEPTH = 480;
const MAX_DEPTH = 2200;
const REST_DEPTH = 620;

// Distance fade. Starts past the spawn depth so a freshly summoned panel is
// always fully opaque, and bottoms out before MAX_DEPTH so a pushed-away panel
// stays legible rather than vanishing.
const FADE_START = 700;
const FADE_RANGE = 1400;

/** How close (in screen px) a link-drag must get to count as a hit. */
const BODY_HIT_RADIUS = 110;

/**
 * The spectacle compositor.
 *
 * WebGL draws the world — the nebula skybox, drifting dust, and any celestial
 * bodies. The app panels are NOT drawn in WebGL or CSS3D; they're ordinary,
 * fully-interactive DOM in an overlay, and every frame we project each panel's
 * 3D anchor point through the camera to place it on screen. That keeps clicks
 * reliable (no CSS3D hit-test drift) and makes "merging" a window onto a body
 * trivial: the panel just anchors to the body's position and rides along.
 */
export class ThreeCompositor implements Compositor {
  readonly name = "three-projected";

  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private overlay!: HTMLElement;
  private compass!: Compass;

  private nebula!: THREE.Mesh;
  private particles!: THREE.Points;
  private tetherSvg!: SVGSVGElement;
  private tetherNodes = new Map<string, SVGGElement>();

  private uniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 1.0 },
    uStars: { value: 0.55 },
    uGrain: { value: 0.02 },
    uColorCool: { value: new THREE.Color(0x4fe3d0) },
    uColorWarm: { value: new THREE.Color(0xc05cff) },
    uColorVoid: { value: new THREE.Color(0x05060c) },
  };

  private panels = new Map<string, PanelEntry>();
  private anchors = new Set<AnchorEntry>();
  private bodies = new Map<string, BodyEntry>();
  private groups = new Map<string, GroupEntry>();
  private bodyCounter = 0;
  private groupCounter = 0;
  private activeId: string | null = null;
  private spawnHint: { x: number; y: number } | null = null;

  // Tunables, all reachable from Settings via applyWorldPatch.
  private cfg = {
    sensitivity: 1,
    smoothing: 0.06,
    fov: 68,
    fade: 0.55,
    dust: 1400,
    nebulaSpin: 1,
    orbitSpeed: 1,
    drift: false,
    driftAmount: 1,
    storms: false,
    compass: true,
    tethers: true,
    baseIntensity: 1,
    // Constellations
    linkOpacity: 0.5,
    linkWidth: 1.2,
    linkGlow: 6,
    linkDashed: true,
    linkLabels: true,
    /** Rotate a constellation about the camera rather than translating it. */
    linkOrbit: true,
    linkSpread: 260,
    linkAutoTidy: true,
  };

  // Camera rig: drag-only. The camera never moves on its own — ambient motion
  // lives in the world (nebula, dust, orbiting bodies) instead, so panels stay
  // genuinely fixed in space rather than sliding across the screen.
  private yaw = 0;
  private pitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private raf = 0;
  private fps = 60;

  // Scratch objects reused each frame to avoid per-panel allocation.
  private tmpWorld = new THREE.Vector3();
  private tmpCam = new THREE.Vector3();
  private tmpNdc = new THREE.Vector3();

  async init(mounts: {
    gl: HTMLElement;
    overlay: HTMLElement;
    hud: HTMLElement;
  }): Promise<void> {
    this.overlay = mounts.overlay;
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(this.cfg.fov, w / h, 1, 12000);
    this.camera.position.set(0, 0, 0.01);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    mounts.gl.appendChild(this.renderer.domElement);

    this.nebula = new THREE.Mesh(
      new THREE.SphereGeometry(6000, 48, 48),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        vertexShader: nebulaVertex,
        fragmentShader: nebulaFragment,
        uniforms: this.uniforms,
      })
    );
    this.scene.add(this.nebula);

    this.particles = this.makeParticles(this.cfg.dust);
    this.scene.add(this.particles);

    // Tethers live under the panels so a link line never eats a click.
    this.tetherSvg = document.createElementNS(SVG_NS, "svg");
    this.tetherSvg.setAttribute("class", "vs-tethers");
    this.overlay.appendChild(this.tetherSvg);

    this.compass = new Compass(mounts.hud, (kind, id) => {
      if (kind === "group") this.lookAtGroup(id);
      else this.lookAtSurface(id);
    });

    this.bindInput(this.renderer.domElement);
    window.addEventListener("resize", this.onResize);
  }

  private makeParticles(count: number): THREE.Points {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 300 + Math.random() * 1600;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      pos[i * 3 + 2] = r * Math.cos(ph);
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x9fb2ff,
      size: 2.2,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
    });
    return new THREE.Points(geo, mat);
  }

  /* ------------------------------------------------------------------ */
  /* Surfaces                                                            */
  /* ------------------------------------------------------------------ */

  mountSurface(surface: Surface): () => void {
    const panel = document.createElement("div");
    panel.className = "vs-panel materializing";
    panel.style.width = `${surface.width}px`;
    panel.style.height = `${surface.height}px`;
    panel.dataset.surface = surface.id;

    const bar = document.createElement("div");
    bar.className = "vs-panel-bar";

    const link = document.createElement("button");
    link.className = "vs-panel-link";
    link.title = "drag onto another window to link \u00b7 onto a body to merge";
    link.setAttribute("aria-label", "Link this window");
    link.textContent = "\u2059";

    const title = document.createElement("span");
    title.className = "vs-panel-title";
    title.textContent = surface.title;

    const tools = document.createElement("div");
    tools.className = "vs-panel-tools";
    const pin = mkTool("vs-panel-pin", "\u25c8", "Pin to screen");
    const min = mkTool("vs-panel-min", "\u2013", "Collapse");
    const close = mkTool("vs-panel-close", "\u2715", `Dismiss ${surface.title}`);
    tools.append(pin, min, close);

    bar.append(link, title, tools);

    const body = document.createElement("div");
    body.className = "vs-panel-content";
    body.appendChild(surface.element);

    const grip = document.createElement("div");
    grip.className = "vs-panel-grip";
    grip.title = "drag to resize";

    panel.append(bar, body, grip);
    this.overlay.appendChild(panel);

    // Anchor the new panel where the user asked (drag-from-drawer) or in front
    // of wherever the camera is currently looking, so it appears in view.
    const anchor = new THREE.Vector3();
    if (this.spawnHint) {
      this.anchorFromScreen(anchor, this.spawnHint.x, this.spawnHint.y, REST_DEPTH);
      this.spawnHint = null;
    } else {
      anchor
        .copy(this.forward())
        .multiplyScalar(560)
        .add(
          new THREE.Vector3(
            (Math.random() - 0.5) * 160,
            (Math.random() - 0.5) * 120,
            (Math.random() - 0.5) * 80
          )
        );
    }

    const entry: PanelEntry = {
      id: surface.id,
      title: surface.title,
      el: panel,
      anchor,
      bodyId: null,
      offset: new THREE.Vector3(),
      groupId: null,
      pinned: false,
      pinX: 0,
      pinY: 0,
      minimized: false,
      width: surface.width,
      height: surface.height,
      phase: Math.random() * Math.PI * 2,
      sx: 0,
      sy: 0,
      onScreen: true,
    };
    this.panels.set(surface.id, entry);

    this.bindPanelDrag(surface.id, bar, tools, link);
    this.bindPanelDepth(surface.id, panel);
    this.bindLinkDrag(surface.id, link);
    this.bindResize(surface.id, grip);

    panel.addEventListener("pointerdown", () => this.setActive(surface.id));

    pin.addEventListener("click", () => this.togglePin(surface.id));
    min.addEventListener("click", () => this.toggleMinimize(surface.id));
    close.addEventListener("click", () => closeSurfaceById(surface.id));

    requestAnimationFrame(() => panel.classList.replace("materializing", "active"));
    this.setActive(surface.id);

    return () => {
      const grp = entry.groupId ? this.groups.get(entry.groupId) : null;
      grp?.members.delete(surface.id);
      if (grp && grp.members.size < 2) this.unlinkGroup(grp.id);
      this.panels.delete(surface.id);
      if (this.activeId === surface.id) this.activeId = null;
      panel.classList.remove("active");
      panel.classList.add("dissolving");
      setTimeout(() => panel.remove(), 320);
    };
  }

  /**
   * Pin arbitrary DOM to a world position. Shares the projection pass with
   * panels but skips all the window chrome — this is what desktop icons ride
   * on, so they live in the void exactly like windows do rather than being
   * stuck to the screen in a separate 2D plane.
   */
  mountAnchored(el: HTMLElement, anchor: Vec3): AnchorHandle {
    const entry: AnchorEntry = {
      el,
      anchor: new THREE.Vector3(anchor.x, anchor.y, anchor.z),
    };
    this.overlay.appendChild(el);
    this.anchors.add(entry);
    return {
      setAnchor: (p) => entry.anchor.set(p.x, p.y, p.z),
      getAnchor: () => ({
        x: entry.anchor.x,
        y: entry.anchor.y,
        z: entry.anchor.z,
      }),
      dispose: () => {
        this.anchors.delete(entry);
        el.remove();
      },
    };
  }

  /** A point `dist` units straight ahead of the camera. */
  focalPoint(dist = REST_DEPTH): Vec3 {
    const v = this.forward().multiplyScalar(dist).add(this.camera.position);
    return { x: v.x, y: v.y, z: v.z };
  }

  screenToWorld(x: number, y: number, dist: number): Vec3 {
    const v = new THREE.Vector3();
    this.anchorFromScreen(v, x, y, dist);
    return { x: v.x, y: v.y, z: v.z };
  }

  private setActive(id: string): void {
    if (this.activeId === id) return;
    this.activeId = id;
    for (const [pid, p] of this.panels) p.el.classList.toggle("focused", pid === id);
  }

  private togglePin(id: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    if (p.pinned) {
      p.pinned = false;
      this.anchorFromScreen(p.anchor, p.pinX, p.pinY, REST_DEPTH);
    } else {
      this.freeFromBody(p);
      p.pinned = true;
      p.pinX = p.sx;
      p.pinY = p.sy;
    }
    p.el.classList.toggle("pinned", p.pinned);
  }

  private toggleMinimize(id: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    p.minimized = !p.minimized;
    p.el.classList.toggle("minimized", p.minimized);
    p.el.style.height = p.minimized ? "" : `${p.height}px`;
  }

  /* ------------------------------------------------------------------ */
  /* World tuning                                                        */
  /* ------------------------------------------------------------------ */

  applyWorldPatch(patch: Record<string, unknown>): void {
    const num = (k: string) => (typeof patch[k] === "number" ? (patch[k] as number) : null);
    const bool = (k: string) =>
      typeof patch[k] === "boolean" ? (patch[k] as boolean) : null;

    const intensity = num("intensity");
    if (intensity !== null) {
      this.cfg.baseIntensity = intensity;
      this.uniforms.uIntensity.value = intensity;
    }
    if (typeof patch.cool === "number") this.uniforms.uColorCool.value.setHex(patch.cool);
    if (typeof patch.warm === "number") this.uniforms.uColorWarm.value.setHex(patch.warm);
    if (typeof patch.voidColor === "number")
      this.uniforms.uColorVoid.value.setHex(patch.voidColor);

    const stars = num("stars");
    if (stars !== null) this.uniforms.uStars.value = stars;
    const grain = num("grain");
    if (grain !== null) this.uniforms.uGrain.value = grain;

    const fov = num("fov");
    if (fov !== null) {
      this.cfg.fov = fov;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    const dust = num("dust");
    if (dust !== null && Math.round(dust) !== this.cfg.dust) {
      this.cfg.dust = Math.round(dust);
      this.scene.remove(this.particles);
      this.particles.geometry.dispose();
      this.particles = this.makeParticles(this.cfg.dust);
      this.scene.add(this.particles);
    }

    for (const key of [
      "sensitivity",
      "smoothing",
      "fade",
      "nebulaSpin",
      "orbitSpeed",
      "driftAmount",
      "linkOpacity",
      "linkWidth",
      "linkGlow",
    ] as const) {
      const v = num(key);
      if (v !== null) this.cfg[key] = v;
    }
    for (const key of [
      "drift",
      "storms",
      "compass",
      "tethers",
      "linkDashed",
      "linkLabels",
      "linkOrbit",
      "linkAutoTidy",
    ] as const) {
      const v = bool(key);
      if (v !== null) this.cfg[key] = v;
    }

    // Spread is direct manipulation: moving the slider should visibly breathe
    // every live constellation in or out, not just affect the next one made.
    const spread = num("linkSpread");
    if (spread !== null && spread !== this.cfg.linkSpread) {
      this.cfg.linkSpread = spread;
      for (const id of this.groups.keys()) this.tidyGroup(id);
    }

    this.compass?.setEnabled(this.cfg.compass);
    if (!this.cfg.tethers) this.clearTethers();
  }

  /* ------------------------------------------------------------------ */
  /* Focus & camera                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Bring an already-open panel back to the user instead of cloning the app.
   * The panel is released from any body, pulled to a comfortable reading depth,
   * and then the void itself rotates until the panel is dead ahead — so a
   * re-launch works even when the window is somewhere behind your head.
   */
  focusSurface(id: string): void {
    const p = this.panels.get(id);
    if (!p) return;

    this.freeFromBody(p);
    if (!p.pinned) {
      const dist = p.anchor.distanceTo(this.camera.position);
      if (dist > REST_DEPTH) {
        p.anchor
          .sub(this.camera.position)
          .normalize()
          .multiplyScalar(REST_DEPTH)
          .add(this.camera.position);
      }
      this.lookAtSurface(id);
    }
    this.setActive(id);

    // Restart the highlight even if it's mid-animation from a previous focus.
    p.el.classList.remove("pulse");
    void p.el.offsetWidth;
    p.el.classList.add("pulse");

    // Focus the first editable control in the body — never the titlebar close.
    const focusable = p.el.querySelector<HTMLElement>(
      ".vs-panel-content input, .vs-panel-content textarea, .vs-panel-content select"
    );
    focusable?.focus();
  }

  lookAtSurface(id: string): void {
    const p = this.panels.get(id);
    if (!p || p.pinned) return;
    this.aimAt(this.worldOf(p, this.tmpWorld));
  }

  lookAtGroup(id: string): void {
    const g = this.groups.get(id);
    if (!g) return;
    const centre = this.groupCentre(g);
    if (centre) this.aimAt(centre);
  }

  resetView(): void {
    this.targetYaw = 0;
    this.targetPitch = 0;
  }

  /** Turn the camera so a world point ends up dead ahead, by the short way round. */
  private aimAt(target: THREE.Vector3): void {
    const d = target.clone().sub(this.camera.position);
    if (d.lengthSq() < 1e-6) return;
    d.normalize();
    const pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
    let yaw = Math.atan2(-d.x, -d.z);
    // Unwrap so a target at +179° doesn't spin the whole void the long way.
    while (yaw - this.targetYaw > Math.PI) yaw -= Math.PI * 2;
    while (yaw - this.targetYaw < -Math.PI) yaw += Math.PI * 2;
    this.targetYaw = yaw;
    this.targetPitch = Math.max(-1.2, Math.min(1.2, pitch));
  }

  /* ------------------------------------------------------------------ */
  /* Bodies                                                              */
  /* ------------------------------------------------------------------ */

  spawnBody(kind: BodyKind): string {
    const id = `body-${++this.bodyCounter}`;
    const group = this.makeBody(kind);

    const radius = 950 + Math.random() * 700;
    const elevation = (Math.random() - 0.5) * 700;
    const phase = Math.random() * Math.PI * 2;

    const entry: BodyEntry = {
      id,
      kind,
      group,
      position: new THREE.Vector3(),
      radius,
      elevation,
      phase,
      speed: 0.02 + Math.random() * 0.04,
      spin: 0.12 + Math.random() * 0.25,
      sx: 0,
      sy: 0,
      onScreen: false,
    };
    this.positionBody(entry);
    this.scene.add(group);
    this.bodies.set(id, entry);
    return id;
  }

  destroyBody(id: string): void {
    const b = this.bodies.get(id);
    if (!b) return;
    for (const p of this.panels.values()) if (p.bodyId === id) this.freeFromBody(p);
    this.scene.remove(b.group);
    this.bodies.delete(id);
  }

  private makeBody(kind: BodyKind): THREE.Group {
    const g = new THREE.Group();
    if (kind === "sun") {
      g.add(sphere(72, 0xffd7a0));
      g.add(glowSphere(120, 0xff9d5c, 0.22));
      g.add(glowSphere(190, 0xffb066, 0.1));
    } else if (kind === "moon") {
      g.add(sphere(48, 0xccd0dc));
      g.add(glowSphere(58, 0x9fb2ff, 0.08));
    } else if (kind === "singularity") {
      // A hole in the world: pure black core, violent accretion ring. This is
      // also the wastebasket — drag a window's link handle onto it and it goes.
      g.add(sphere(54, 0x000000));
      g.add(glowSphere(88, 0x7a3cff, 0.3));
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(70, 150, 96),
        new THREE.MeshBasicMaterial({
          color: 0xc05cff,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      ring.rotation.x = Math.PI * 0.5;
      g.add(ring);
    } else {
      const color = PLANET_COLORS[this.bodyCounter % PLANET_COLORS.length];
      g.add(sphere(60, color));
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(84, 120, 60),
        new THREE.MeshBasicMaterial({
          color: 0x9fb2ff,
          transparent: true,
          opacity: 0.45,
          side: THREE.DoubleSide,
        })
      );
      ring.rotation.x = Math.PI * 0.42;
      g.add(ring);
    }
    return g;
  }

  private positionBody(b: BodyEntry): void {
    b.position.set(
      Math.cos(b.phase) * b.radius,
      b.elevation,
      Math.sin(b.phase) * b.radius
    );
    b.group.position.copy(b.position);
  }

  attachSurface(surfaceId: string, bodyId: string | null): void {
    const p = this.panels.get(surfaceId);
    if (!p) return;
    if (bodyId && this.bodies.has(bodyId)) {
      p.bodyId = bodyId;
      p.offset.set(150, 120, 0);
      p.el.classList.add("merged");
    } else {
      p.bodyId = null;
      p.el.classList.remove("merged");
    }
  }

  listBodies(): { id: string; kind: BodyKind }[] {
    return [...this.bodies.values()].map((b) => ({ id: b.id, kind: b.kind }));
  }

  /* ------------------------------------------------------------------ */
  /* Constellations (dashboards)                                         */
  /* ------------------------------------------------------------------ */

  linkSurfaces(ids: string[], name?: string): string {
    const live = ids.filter((id) => this.panels.has(id));
    if (live.length < 2) return "";

    // Absorb any constellation the incoming windows already belonged to, so
    // linking A(+B) to C yields one group of three rather than nested groups.
    const absorbed = new Set<string>();
    for (const id of live) {
      const gid = this.panels.get(id)!.groupId;
      if (gid) absorbed.add(gid);
    }
    const members = new Set(live);
    for (const gid of absorbed) {
      const g = this.groups.get(gid);
      if (!g) continue;
      for (const m of g.members) members.add(m);
      this.groups.delete(gid);
      this.tetherNodes.get(gid)?.remove();
      this.tetherNodes.delete(gid);
    }

    const id = `group-${++this.groupCounter}`;
    const entry: GroupEntry = {
      id,
      name: name?.trim() || `constellation ${this.groupCounter}`,
      members,
      color: GROUP_COLORS[(this.groupCounter - 1) % GROUP_COLORS.length],
    };
    this.groups.set(id, entry);
    for (const m of members) {
      const p = this.panels.get(m);
      if (!p) continue;
      p.groupId = id;
      p.el.classList.add("linked");
      p.el.style.setProperty("--vs-group", entry.color);
    }
    if (this.cfg.linkAutoTidy) this.tidyGroup(id);
    return id;
  }

  unlinkGroup(id: string): void {
    const g = this.groups.get(id);
    if (!g) return;
    for (const m of g.members) {
      const p = this.panels.get(m);
      if (!p) continue;
      p.groupId = null;
      p.el.classList.remove("linked");
      p.el.style.removeProperty("--vs-group");
    }
    this.groups.delete(id);
    this.tetherNodes.get(id)?.remove();
    this.tetherNodes.delete(id);
  }

  listGroups(): GroupInfo[] {
    return [...this.groups.values()].map((g) => ({
      id: g.id,
      name: g.name,
      members: [...g.members],
    }));
  }

  /**
   * Fan a constellation's members evenly around their shared centre, all at
   * the same distance from the camera so they read as one object at one size.
   */
  private tidyGroup(id: string): void {
    const g = this.groups.get(id);
    if (!g) return;
    const members = [...g.members]
      .map((m) => this.panels.get(m))
      .filter((p): p is PanelEntry => Boolean(p) && !p!.pinned);
    if (members.length < 2) return;

    const centre = this.groupCentre(g);
    if (!centre) return;

    const camPos = this.camera.position;
    const dist = centre.distanceTo(camPos);
    const dir = centre.clone().sub(camPos).normalize();
    // Any stable basis perpendicular to the view direction will do.
    const seed = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(dir, seed).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();

    const r = this.cfg.linkSpread;
    members.forEach((p, i) => {
      this.freeFromBody(p);
      const a = (i / members.length) * Math.PI * 2;
      p.anchor
        .copy(centre)
        .addScaledVector(right, Math.cos(a) * r)
        .addScaledVector(up, Math.sin(a) * r)
        .sub(camPos)
        .normalize()
        .multiplyScalar(dist)
        .add(camPos);
    });
  }

  private groupCentre(g: GroupEntry): THREE.Vector3 | null {
    const centre = new THREE.Vector3();
    let n = 0;
    for (const m of g.members) {
      const p = this.panels.get(m);
      if (!p || p.pinned) continue;
      centre.add(this.worldOf(p, new THREE.Vector3()));
      n++;
    }
    return n ? centre.multiplyScalar(1 / n) : null;
  }

  /* ------------------------------------------------------------------ */
  /* Arrangement                                                         */
  /* ------------------------------------------------------------------ */

  arrange(mode: ArrangeMode): void {
    const list = [...this.panels.values()].filter((p) => !p.pinned);
    const n = list.length;
    if (!n) return;

    const euler = new THREE.Euler(this.targetPitch, this.targetYaw, 0, "YXZ");
    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(euler);
    const right = new THREE.Vector3(1, 0, 0).applyEuler(euler);
    const up = new THREE.Vector3(0, 1, 0).applyEuler(euler);

    const cols = Math.min(n, 4);
    const rows = Math.ceil(n / cols);

    list.forEach((p, i) => {
      this.freeFromBody(p);
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = cols === 1 ? 0 : col - (cols - 1) / 2;
      const cy = rows === 1 ? 0 : (rows - 1) / 2 - row;

      if (mode === "arc") {
        const a = this.targetYaw + cx * 0.46;
        const pi = Math.max(-0.9, Math.min(0.9, this.targetPitch + cy * 0.34));
        p.anchor
          .copy(dirFromYawPitch(a, pi))
          .multiplyScalar(760)
          .add(this.camera.position);
      } else if (mode === "ring") {
        const a = this.targetYaw + (i / n) * Math.PI * 2;
        const pi = ((i % 3) - 1) * 0.22;
        p.anchor
          .copy(dirFromYawPitch(a, pi))
          .multiplyScalar(880)
          .add(this.camera.position);
      } else if (mode === "wall") {
        p.anchor
          .copy(this.camera.position)
          .addScaledVector(fwd, 820)
          .addScaledVector(right, cx * 340)
          .addScaledVector(up, cy * 280);
      } else {
        const a = Math.random() * Math.PI * 2;
        const pi = (Math.random() - 0.5) * 1.4;
        p.anchor
          .copy(dirFromYawPitch(a, pi))
          .multiplyScalar(MIN_DEPTH + Math.random() * 900)
          .add(this.camera.position);
      }
    });
  }

  setSpawnHint(x: number, y: number): void {
    this.spawnHint = { x, y };
  }

  placeSurface(id: string, place: SurfacePlacement): void {
    const p = this.panels.get(id);
    if (!p) return;
    p.anchor.set(place.anchor[0], place.anchor[1], place.anchor[2]);
    p.width = place.width;
    p.height = place.height;
    p.el.style.width = `${place.width}px`;
    p.el.style.height = `${place.height}px`;
    if (place.pinned) {
      p.pinned = true;
      p.pinX = place.pinX;
      p.pinY = place.pinY;
      p.el.classList.add("pinned");
    }
  }

  snapshot(): Record<string, SurfacePlacement> {
    const out: Record<string, SurfacePlacement> = {};
    for (const [id, p] of this.panels) {
      out[id] = {
        anchor: [p.anchor.x, p.anchor.y, p.anchor.z],
        width: p.width,
        height: p.height,
        pinned: p.pinned,
        pinX: p.pinX,
        pinY: p.pinY,
      };
    }
    return out;
  }

  stats(): CompositorStats {
    return {
      fps: Math.round(this.fps),
      panels: this.panels.size,
      bodies: this.bodies.size,
      groups: this.groups.size,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Frame loop                                                          */
  /* ------------------------------------------------------------------ */

  start(): void {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, this.clock.getDelta());
      this.uniforms.uTime.value += dt;
      if (dt > 0) this.fps += (1 / dt - this.fps) * 0.08;

      const k = Math.max(0.01, Math.min(0.5, this.cfg.smoothing));
      this.yaw += (this.targetYaw - this.yaw) * k;
      this.pitch += (this.targetPitch - this.pitch) * k;
      this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");

      // The void turns, not the viewer.
      this.nebula.rotation.y += dt * 0.015 * this.cfg.nebulaSpin;
      this.particles.rotation.y += dt * 0.01 * this.cfg.nebulaSpin;

      if (this.cfg.storms) {
        // Slow aurora weather: the sky breathes instead of sitting still.
        const t = this.uniforms.uTime.value;
        const pulse = 0.72 + 0.28 * (Math.sin(t * 0.11) * 0.5 + 0.5);
        this.uniforms.uIntensity.value = this.cfg.baseIntensity * pulse;
      }

      for (const b of this.bodies.values()) {
        b.phase += dt * b.speed * this.cfg.orbitSpeed;
        this.positionBody(b);
        b.group.rotation.y += dt * b.spin * this.cfg.orbitSpeed;
      }

      this.renderer.render(this.scene, this.camera);
      this.projectBodies();
      this.projectPanels();
      this.projectAnchors();
      this.drawTethers();
      this.updateCompass();
    };
    loop();
  }

  /**
   * Desktop icons and other bare anchors. Simpler than panels: no depth
   * control, no fade, and they sit below every window so a dragged file never
   * hides behind an icon.
   */
  private projectAnchors(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const a of this.anchors) {
      this.tmpCam.copy(a.anchor).applyMatrix4(this.camera.matrixWorldInverse);
      if (this.tmpCam.z > -1) {
        a.el.style.display = "none";
        continue;
      }
      a.el.style.display = "";

      this.tmpNdc.copy(a.anchor).project(this.camera);
      const dist = a.anchor.distanceTo(this.camera.position);
      const scale = Math.max(0.45, Math.min(1.35, 700 / dist));
      a.el.style.left = `${((this.tmpNdc.x * 0.5 + 0.5) * w).toFixed(1)}px`;
      a.el.style.top = `${((-this.tmpNdc.y * 0.5 + 0.5) * h).toFixed(1)}px`;
      a.el.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
      a.el.style.zIndex = `${Math.max(0, Math.round(50000 - dist))}`;
    }
  }

  /** Where a panel actually sits right now, body-ride and drift included. */
  private worldOf(p: PanelEntry, out: THREE.Vector3): THREE.Vector3 {
    if (p.bodyId) {
      const b = this.bodies.get(p.bodyId);
      if (b) return out.copy(b.position).add(p.offset);
    }
    out.copy(p.anchor);
    if (this.cfg.drift) {
      const t = this.uniforms.uTime.value;
      const a = 26 * this.cfg.driftAmount;
      out.x += Math.sin(t * 0.21 + p.phase) * a;
      out.y += Math.cos(t * 0.17 + p.phase * 1.7) * a * 0.8;
      out.z += Math.sin(t * 0.13 + p.phase * 0.6) * a * 0.6;
    }
    return out;
  }

  private projectBodies(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const b of this.bodies.values()) {
      this.tmpCam.copy(b.position).applyMatrix4(this.camera.matrixWorldInverse);
      b.onScreen = this.tmpCam.z < -1;
      if (!b.onScreen) continue;
      this.tmpNdc.copy(b.position).project(this.camera);
      b.sx = (this.tmpNdc.x * 0.5 + 0.5) * w;
      b.sy = (-this.tmpNdc.y * 0.5 + 0.5) * h;
    }
  }

  /** Place every panel's DOM at the screen projection of its 3D anchor. */
  private projectPanels(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const camPos = this.camera.position;

    for (const p of this.panels.values()) {
      if (p.pinned) {
        p.sx = p.pinX;
        p.sy = p.pinY;
        p.onScreen = true;
        p.el.style.display = "";
        p.el.style.left = `${p.pinX.toFixed(1)}px`;
        p.el.style.top = `${p.pinY.toFixed(1)}px`;
        p.el.style.transform = "translate(-50%, -50%) scale(1)";
        p.el.style.zIndex = "90000";
        p.el.style.setProperty("--vs-depth-fade", "1");
        continue;
      }

      this.worldOf(p, this.tmpWorld);

      // Behind-camera test in camera space (camera looks down -Z).
      this.tmpCam.copy(this.tmpWorld).applyMatrix4(this.camera.matrixWorldInverse);
      if (this.tmpCam.z > -1) {
        p.onScreen = false;
        p.el.style.display = "none";
        continue;
      }
      p.el.style.display = "";

      this.tmpNdc.copy(this.tmpWorld).project(this.camera);
      const x = (this.tmpNdc.x * 0.5 + 0.5) * w;
      const y = (-this.tmpNdc.y * 0.5 + 0.5) * h;
      const dist = this.tmpWorld.distanceTo(camPos);
      const scale = Math.max(0.35, Math.min(1.6, 760 / dist));

      p.sx = x;
      p.sy = y;
      p.onScreen =
        Math.abs(this.tmpNdc.x) <= 1.08 && Math.abs(this.tmpNdc.y) <= 1.08;

      p.el.style.left = `${x.toFixed(1)}px`;
      p.el.style.top = `${y.toFixed(1)}px`;
      p.el.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;

      // Stack by real depth so a near panel always occludes a far one, and fade
      // distant panels into the void so depth reads as depth, not just size.
      p.el.style.zIndex = `${Math.max(0, Math.round(100000 - dist))}`;
      // Set as a custom property, not inline opacity: the materialize/dissolve
      // class rules are more specific and so still win during those animations.
      const fade =
        1 - Math.min(this.cfg.fade, Math.max(0, (dist - FADE_START) / FADE_RANGE));
      p.el.style.setProperty("--vs-depth-fade", fade.toFixed(3));
    }
  }

  /**
   * Draw the light-threads between linked windows. This is what makes a
   * dashboard legible as one object instead of four coincidental windows.
   */
  private drawTethers(): void {
    if (!this.cfg.tethers) return;
    const seen = new Set<string>();

    for (const g of this.groups.values()) {
      const pts: PanelEntry[] = [];
      for (const m of g.members) {
        const p = this.panels.get(m);
        if (p && p.el.style.display !== "none") pts.push(p);
      }
      if (pts.length < 2) continue;
      seen.add(g.id);

      let node = this.tetherNodes.get(g.id);
      if (!node) {
        node = document.createElementNS(SVG_NS, "g");
        node.setAttribute("class", "vs-tether");
        const line = document.createElementNS(SVG_NS, "polyline");
        line.setAttribute("class", "vs-tether-line");
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("class", "vs-tether-label");
        node.append(line, label);
        this.tetherSvg.appendChild(node);
        this.tetherNodes.set(g.id, node);
      }

      // Star-shape from the centroid: reads as a constellation, not a snake.
      const cx = pts.reduce((s, p) => s + p.sx, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.sy, 0) / pts.length;
      const path = pts
        .map((p) => `${cx.toFixed(0)},${cy.toFixed(0)} ${p.sx.toFixed(0)},${p.sy.toFixed(0)}`)
        .join(" ");

      // Styled inline rather than by attribute: the stylesheet's class rules
      // out-rank presentation attributes, so only inline style can be tuned.
      const line = node.querySelector(".vs-tether-line") as SVGPolylineElement;
      line.setAttribute("points", path);
      line.style.stroke = g.color;
      line.style.strokeWidth = String(this.cfg.linkWidth);
      line.style.strokeOpacity = String(this.cfg.linkOpacity);
      line.style.strokeDasharray = this.cfg.linkDashed ? "3 6" : "none";
      line.style.filter =
        this.cfg.linkGlow > 0 ? `drop-shadow(0 0 ${this.cfg.linkGlow}px ${g.color})` : "none";

      const label = node.querySelector(".vs-tether-label") as SVGTextElement;
      label.style.display = this.cfg.linkLabels ? "" : "none";
      label.setAttribute("x", cx.toFixed(0));
      label.setAttribute("y", (cy - 10).toFixed(0));
      label.setAttribute("fill", g.color);
      if (label.textContent !== g.name) label.textContent = g.name;
    }

    for (const [id, node] of this.tetherNodes) {
      if (seen.has(id)) continue;
      node.remove();
      this.tetherNodes.delete(id);
    }
  }

  private clearTethers(): void {
    for (const node of this.tetherNodes.values()) node.remove();
    this.tetherNodes.clear();
  }

  /**
   * Work out what's off-screen and in which direction, then hand it to the
   * compass. Grouped windows report once, as their constellation.
   */
  private updateCompass(): void {
    if (!this.cfg.compass) return;
    const items: CompassItem[] = [];
    const camPos = this.camera.position;
    const claimed = new Set<string>();

    for (const g of this.groups.values()) {
      for (const m of g.members) claimed.add(m);
      const centre = this.groupCentre(g);
      if (!centre) continue;
      const bearing = this.bearingOf(centre);
      if (!bearing) continue;
      items.push({
        id: g.id,
        kind: "group",
        label: g.name,
        angle: bearing.angle,
        dist: centre.distanceTo(camPos),
        behind: bearing.behind,
      });
    }

    for (const p of this.panels.values()) {
      if (p.pinned || claimed.has(p.id)) continue;
      const world = this.worldOf(p, new THREE.Vector3());
      const bearing = this.bearingOf(world);
      if (!bearing) continue;
      items.push({
        id: p.id,
        kind: "surface",
        label: p.title,
        angle: bearing.angle,
        dist: world.distanceTo(camPos),
        behind: bearing.behind,
      });
    }

    this.compass.sync(items);
  }

  /**
   * Screen-space bearing to a world point, or null when it's comfortably in
   * view. Points behind the camera get their projection flipped — otherwise
   * the arrow would confidently point the wrong way.
   */
  private bearingOf(
    world: THREE.Vector3
  ): { angle: number; behind: boolean } | null {
    this.tmpCam.copy(world).applyMatrix4(this.camera.matrixWorldInverse);
    const behind = this.tmpCam.z > -1;
    this.tmpNdc.copy(world).project(this.camera);
    let x = this.tmpNdc.x;
    let y = this.tmpNdc.y;
    if (behind) {
      x = -x;
      y = -y;
      // A point directly behind projects to ~0,0 and has no honest bearing;
      // bias it downward so the pip still lands somewhere sane.
      if (Math.abs(x) < 0.02 && Math.abs(y) < 0.02) y = -1;
    } else if (Math.abs(x) <= 0.98 && Math.abs(y) <= 0.98) {
      return null;
    }
    return { angle: Math.atan2(y, x), behind };
  }

  /* ------------------------------------------------------------------ */
  /* Interaction                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Title-bar dragging. The panel's screen position is recomputed from its 3D
   * anchor every frame, so a drag can't just set left/top — it has to move the
   * anchor itself. We cast a ray through the cursor and slide the anchor along
   * it, holding the panel's distance from the camera constant so its apparent
   * size doesn't change mid-drag. Linked windows travel with it.
   */
  private bindPanelDrag(
    id: string,
    bar: HTMLElement,
    tools: HTMLElement,
    link: HTMLElement
  ): void {
    let dragging = false;
    let dist = 0;
    let grabX = 0;
    let grabY = 0;
    const start = new THREE.Vector3();
    const others: { p: PanelEntry; base: THREE.Vector3 }[] = [];

    bar.addEventListener("pointerdown", (e) => {
      if (tools.contains(e.target as Node) || link.contains(e.target as Node)) return;
      const p = this.panels.get(id);
      if (!p) return;
      this.setActive(id);

      if (p.pinned) {
        // Pinned panels are flat: drag them like any other floating window.
        dragging = true;
        grabX = e.clientX - p.pinX;
        grabY = e.clientY - p.pinY;
        bar.setPointerCapture(e.pointerId);
        p.el.classList.add("dragging");
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      this.freeFromBody(p);
      dist = p.anchor.distanceTo(this.camera.position);
      grabX = e.clientX - p.sx;
      grabY = e.clientY - p.sy;
      start.copy(p.anchor);

      others.length = 0;
      if (p.groupId) {
        const g = this.groups.get(p.groupId);
        if (g) {
          for (const m of g.members) {
            if (m === id) continue;
            const other = this.panels.get(m);
            if (!other || other.pinned) continue;
            this.freeFromBody(other);
            others.push({ p: other, base: other.anchor.clone() });
          }
        }
      }

      dragging = true;
      bar.setPointerCapture(e.pointerId);
      p.el.classList.add("dragging");
      e.preventDefault();
      e.stopPropagation();
    });

    bar.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const p = this.panels.get(id);
      if (!p) return;
      if (p.pinned) {
        p.pinX = e.clientX - grabX;
        p.pinY = e.clientY - grabY;
        return;
      }
      this.anchorFromScreen(p.anchor, e.clientX - grabX, e.clientY - grabY, dist);
      if (!others.length) return;

      if (this.cfg.linkOrbit) {
        // Panel scale is 760/distance, so translating a constellation rigidly
        // would push one member towards the camera and the other away, and the
        // group would visibly grow at one end. Rotating the whole formation
        // about the camera instead keeps every member's distance -- and so
        // every member's size -- exactly constant while it travels.
        const camPos = this.camera.position;
        const from = start.clone().sub(camPos).normalize();
        const to = p.anchor.clone().sub(camPos).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(from, to);
        for (const o of others) {
          o.p.anchor.copy(o.base).sub(camPos).applyQuaternion(q).add(camPos);
        }
      } else {
        const delta = p.anchor.clone().sub(start);
        for (const o of others) o.p.anchor.copy(o.base).add(delta);
      }
    });

    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      others.length = 0;
      bar.releasePointerCapture(e.pointerId);
      this.panels.get(id)?.el.classList.remove("dragging");
    };
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
  }

  /**
   * The link handle. Drag it out and a live thread follows the cursor: drop on
   * another window to fuse them into a constellation, drop on a celestial body
   * to merge the window onto it, drop on a singularity to let it be eaten.
   */
  private bindLinkDrag(id: string, handle: HTMLElement): void {
    let active = false;
    let temp: SVGPolylineElement | null = null;
    let hover: { kind: "panel" | "body"; id: string } | null = null;

    const clearHover = () => {
      for (const p of this.panels.values()) p.el.classList.remove("link-target");
      hover = null;
    };

    handle.addEventListener("pointerdown", (e) => {
      const p = this.panels.get(id);
      if (!p) return;
      active = true;
      handle.setPointerCapture(e.pointerId);
      temp = document.createElementNS(SVG_NS, "polyline");
      temp.setAttribute("class", "vs-tether-line vs-tether-live");
      this.tetherSvg.appendChild(temp);
      document.body.classList.add("vs-linking");
      e.preventDefault();
      e.stopPropagation();
    });

    handle.addEventListener("pointermove", (e) => {
      if (!active || !temp) return;
      const p = this.panels.get(id);
      if (!p) return;
      temp.setAttribute(
        "points",
        `${p.sx.toFixed(0)},${p.sy.toFixed(0)} ${e.clientX},${e.clientY}`
      );

      clearHover();
      const target = this.hitTest(e.clientX, e.clientY, id);
      if (target) {
        hover = target;
        if (target.kind === "panel")
          this.panels.get(target.id)?.el.classList.add("link-target");
      }
    });

    const end = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      handle.releasePointerCapture(e.pointerId);
      temp?.remove();
      temp = null;
      document.body.classList.remove("vs-linking");

      const target = hover;
      clearHover();
      if (!target) return;

      if (target.kind === "panel") {
        this.linkSurfaces([id, target.id]);
      } else {
        const body = this.bodies.get(target.id);
        if (body?.kind === "singularity") this.consume(id);
        else this.attachSurface(id, target.id);
      }
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  /** What's under this screen point that a link could land on? */
  private hitTest(
    x: number,
    y: number,
    exclude: string
  ): { kind: "panel" | "body"; id: string } | null {
    let best: { kind: "panel" | "body"; id: string; z: number } | null = null;

    for (const p of this.panels.values()) {
      if (p.id === exclude || p.el.style.display === "none") continue;
      const r = p.el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const z = Number(p.el.style.zIndex || 0);
      if (!best || z > best.z) best = { kind: "panel", id: p.id, z };
    }
    if (best) return { kind: best.kind, id: best.id };

    for (const b of this.bodies.values()) {
      if (!b.onScreen) continue;
      const d = Math.hypot(b.sx - x, b.sy - y);
      if (d <= BODY_HIT_RADIUS) return { kind: "body", id: b.id };
    }
    return null;
  }

  /** Spaghettify a window into a singularity, then let the kernel close it. */
  private consume(id: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    p.el.classList.add("consumed");
    setTimeout(() => closeSurfaceById(id), 420);
  }

  /** Corner grip: resize in screen pixels, corrected for the panel's scale. */
  private bindResize(id: string, grip: HTMLElement): void {
    let active = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let scale = 1;

    grip.addEventListener("pointerdown", (e) => {
      const p = this.panels.get(id);
      if (!p) return;
      active = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = p.width;
      startH = p.height;
      const m = /scale\(([\d.]+)\)/.exec(p.el.style.transform);
      scale = m ? Math.max(0.2, Number(m[1])) : 1;
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });

    grip.addEventListener("pointermove", (e) => {
      if (!active) return;
      const p = this.panels.get(id);
      if (!p) return;
      p.width = Math.max(240, Math.round(startW + (e.clientX - startX) / scale));
      p.height = Math.max(140, Math.round(startH + (e.clientY - startY) / scale));
      p.el.style.width = `${p.width}px`;
      if (!p.minimized) p.el.style.height = `${p.height}px`;
    });

    const end = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      grip.releasePointerCapture(e.pointerId);
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  /**
   * Scroll over a panel to push it deeper into the void or pull it closer.
   * Scrollable panel content wins — a terminal's backlog still scrolls normally,
   * and only panels with nothing to scroll take the wheel as a depth change.
   */
  private bindPanelDepth(id: string, panel: HTMLElement): void {
    panel.addEventListener(
      "wheel",
      (e) => {
        const p = this.panels.get(id);
        if (!p || p.pinned) return;

        const content = (e.target as HTMLElement).closest?.(".vs-panel-content");
        if (content && content.scrollHeight > content.clientHeight) return;
        e.preventDefault();

        this.freeFromBody(p);

        // Exponential so each notch feels the same at any depth.
        const dist = p.anchor.distanceTo(this.camera.position);
        const next = Math.max(
          MIN_DEPTH,
          Math.min(MAX_DEPTH, dist * Math.exp(e.deltaY * 0.0012))
        );

        p.anchor
          .sub(this.camera.position)
          .normalize()
          .multiplyScalar(next)
          .add(this.camera.position);
      },
      { passive: false }
    );
  }

  /**
   * Detach a panel from its celestial body, leaving it exactly where it
   * currently sits instead of snapping back to its pre-merge anchor.
   */
  private freeFromBody(p: PanelEntry): void {
    if (!p.bodyId) return;
    const b = this.bodies.get(p.bodyId);
    if (b) p.anchor.copy(b.position).add(p.offset);
    p.bodyId = null;
    p.el.classList.remove("merged");
  }

  /** Screen point -> world anchor at a fixed distance from the camera. */
  private anchorFromScreen(
    out: THREE.Vector3,
    cx: number,
    cy: number,
    dist: number
  ): void {
    this.tmpCam
      .set((cx / window.innerWidth) * 2 - 1, -(cy / window.innerHeight) * 2 + 1, 0.5)
      .unproject(this.camera);

    out
      .copy(this.tmpCam)
      .sub(this.camera.position)
      .normalize()
      .multiplyScalar(dist)
      .add(this.camera.position);
  }

  private forward(): THREE.Vector3 {
    return new THREE.Vector3(0, 0, -1).applyEuler(
      new THREE.Euler(this.pitch, this.yaw, 0, "YXZ")
    );
  }

  private bindInput(el: HTMLElement): void {
    el.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      const s = 0.0022 * this.cfg.sensitivity;
      this.targetYaw -= dx * s;
      this.targetPitch = Math.max(-1.2, Math.min(1.2, this.targetPitch - dy * s));
    });
    const end = () => (this.dragging = false);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  private onResize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    for (const a of this.anchors) a.el.remove();
    this.anchors.clear();
    this.compass?.dispose();
    this.renderer.dispose();
  }
}

/* ---------------------------------------------------------------- */

function closeSurfaceById(id: string): void {
  window.dispatchEvent(
    new CustomEvent("voidshell:close-surface", { detail: { id } })
  );
}

function mkTool(cls: string, glyph: string, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `vs-panel-tool ${cls}`;
  b.textContent = glyph;
  b.title = label;
  b.setAttribute("aria-label", label);
  return b;
}

/** Unit vector for a yaw/pitch pair, matching the camera's YXZ convention. */
function dirFromYawPitch(yaw: number, pitch: number): THREE.Vector3 {
  const cp = Math.cos(pitch);
  return new THREE.Vector3(-cp * Math.sin(yaw), Math.sin(pitch), -cp * Math.cos(yaw));
}

function sphere(r: number, color: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(r, 32, 32),
    new THREE.MeshBasicMaterial({ color })
  );
}

function glowSphere(r: number, color: number, opacity: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(r, 32, 32),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
}
