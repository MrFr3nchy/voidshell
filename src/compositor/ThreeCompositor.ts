import * as THREE from "three";
import type { BodyKind, Compositor, Surface, SurfaceGroup } from "../kernel/types";
import { nebulaFragment, nebulaVertex } from "../world/nebulaShader";

interface PanelEntry {
  el: HTMLElement;
  title: string;
  moduleId: string;
  /** Own world anchor, used when the panel isn't merged onto a body. */
  anchor: THREE.Vector3;
  bodyId: string | null;
  /** World-space offset from a body when merged. */
  offset: THREE.Vector3;
  /** Dashboard membership, or null when the panel flies solo. */
  groupId: string | null;
  /** Pinned panels ride the camera instead of sitting still in the world. */
  pinned: boolean;
  /** Camera-space position captured when the panel was pinned. */
  pinOffset: THREE.Vector3;
}

interface GroupEntry {
  id: string;
  name: string;
  members: Set<string>;
  hue: number;
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
}

const PLANET_COLORS = [0x6ec6ff, 0xb98cff, 0x5fd6a8, 0xff9d6e];
// Depth range a panel can be scrolled through. Chosen to line up with the
// on-screen scale clamp in projectPanels, so every notch of the wheel produces
// a visible size change instead of dead-zoning at the ends.
const MIN_DEPTH = 480;
const MAX_DEPTH = 2200;
/** Where a freshly summoned or recalled panel sits. */
const HOME_DEPTH = 560;

// Distance fade. Starts past the spawn depth so a freshly summoned panel is
// always fully opaque, and bottoms out before MAX_DEPTH so a pushed-away panel
// stays legible rather than vanishing.
const FADE_START = 700;
const FADE_RANGE = 1400;

/** World units the drag grid snaps to when snapping is switched on. */
const SNAP = 40;

/**
 * The spectacle compositor.
 *
 * WebGL draws the world — the nebula skybox, drifting dust, and any celestial
 * bodies. The app panels are NOT drawn in WebGL or CSS3D; they're ordinary,
 * fully-interactive DOM in an overlay, and every frame we project each panel's
 * 3D anchor point through the camera to place it on screen. That keeps clicks
 * reliable (no CSS3D hit-test drift) and makes both "merging" a window onto a
 * body and welding windows into a dashboard trivial: it's all just anchors.
 */
export class ThreeCompositor implements Compositor {
  readonly name = "three-projected";

  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();
  private overlay!: HTMLElement;
  /** Layer holding off-screen waypoint markers and the link rubber-band. */
  private waypointLayer!: HTMLElement;
  private linkLine!: SVGLineElement;
  private linkSvg!: SVGSVGElement;

  private nebula!: THREE.Mesh;
  private particles!: THREE.Points;
  private uniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 1.0 },
    uColorCool: { value: new THREE.Color(0x4fe3d0) },
    uColorWarm: { value: new THREE.Color(0xc05cff) },
    uColorVoid: { value: new THREE.Color(0x05060c) },
  };

  private panels = new Map<string, PanelEntry>();
  private groups = new Map<string, GroupEntry>();
  private bodies = new Map<string, BodyEntry>();
  private bodyCounter = 0;
  private groupCounter = 0;

  /** Waypoint marker pool, keyed by the surface or group it points at. */
  private markers = new Map<string, HTMLElement>();

  /** Runtime-tunable shell options, driven from Settings via applyWorldPatch. */
  private opts = {
    compass: true,
    fade: true,
    drift: 0.015,
    snap: false,
    reduceMotion: false,
  };

  /** Set while dragging a link handle, so pointerup knows what to weld. */
  private linkSource: string | null = null;

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

  // Scratch objects reused each frame to avoid per-panel allocation.
  private tmpWorld = new THREE.Vector3();
  private tmpCam = new THREE.Vector3();
  private tmpNdc = new THREE.Vector3();
  private camQuat = new THREE.Quaternion();

  async init(mounts: { gl: HTMLElement; overlay: HTMLElement }): Promise<void> {
    this.overlay = mounts.overlay;
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(68, w / h, 1, 12000);
    this.camera.position.set(0, 0, 0.01);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    mounts.gl.appendChild(this.renderer.domElement);

    this.buildWaypointLayer();

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

    this.particles = this.makeParticles(1400);
    this.scene.add(this.particles);

    this.bindInput(this.renderer.domElement);
    this.bindLinking();
    window.addEventListener("resize", this.onResize);
  }

  /** Waypoints and the link rubber-band live above the panels, below the HUD. */
  private buildWaypointLayer(): void {
    const layer = document.createElement("div");
    layer.id = "vs-waypoints";
    document.body.appendChild(layer);
    this.waypointLayer = layer;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "vs-link-svg");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("class", "vs-link-line");
    svg.appendChild(line);
    layer.appendChild(svg);
    this.linkSvg = svg;
    this.linkLine = line;
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

  mountSurface(surface: Surface): () => void {
    const panel = document.createElement("div");
    panel.className = "vs-panel materializing";
    panel.style.width = `${surface.width}px`;
    panel.style.height = `${surface.height}px`;

    const bar = document.createElement("div");
    bar.className = "vs-panel-bar";
    const title = document.createElement("span");
    title.className = "vs-panel-title";
    title.textContent = surface.title;

    const tools = document.createElement("div");
    tools.className = "vs-panel-tools";

    // Drag this onto another panel to weld the two into a dashboard.
    const link = document.createElement("button");
    link.className = "vs-panel-tool vs-panel-link";
    link.setAttribute("aria-label", `Link ${surface.title} to another window`);
    link.title = "drag onto another window to link";
    link.textContent = "\u29C9";

    const pin = document.createElement("button");
    pin.className = "vs-panel-tool vs-panel-pin";
    pin.setAttribute("aria-label", `Pin ${surface.title} to view`);
    pin.title = "pin to view";
    pin.textContent = "\u25C9";

    const close = document.createElement("button");
    close.className = "vs-panel-tool vs-panel-close";
    close.setAttribute("aria-label", `Dismiss ${surface.title}`);
    close.textContent = "\u2715";

    tools.append(link, pin, close);
    bar.append(title, tools);

    const body = document.createElement("div");
    body.className = "vs-panel-content";
    body.appendChild(surface.element);

    panel.append(bar, body);
    this.overlay.appendChild(panel);

    // Anchor the new panel in front of wherever the camera is currently looking
    // so it appears in view rather than somewhere behind you.
    const dir = new THREE.Vector3(0, 0, -1).applyEuler(
      new THREE.Euler(this.pitch, this.yaw, 0, "YXZ")
    );
    const anchor = dir
      // Spawn comfortably inside [MIN_DEPTH, MAX_DEPTH] so the first scroll
      // moves the panel instead of clamping it the wrong way.
      .multiplyScalar(HOME_DEPTH)
      .add(
        new THREE.Vector3(
          (Math.random() - 0.5) * 160,
          (Math.random() - 0.5) * 120,
          (Math.random() - 0.5) * 80
        )
      );

    this.panels.set(surface.id, {
      el: panel,
      title: surface.title,
      moduleId: surface.moduleId,
      anchor,
      bodyId: null,
      offset: new THREE.Vector3(),
      groupId: null,
      pinned: false,
      pinOffset: new THREE.Vector3(),
    });

    this.bindPanelDrag(surface.id, bar, tools);
    this.bindPanelDepth(surface.id, panel);
    this.bindPanelTools(surface.id, link, pin);

    requestAnimationFrame(() => panel.classList.replace("materializing", "active"));

    close.addEventListener("click", () => {
      window.dispatchEvent(
        new CustomEvent("voidshell:close-surface", { detail: { id: surface.id } })
      );
    });

    return () => {
      this.unlinkSurface(surface.id);
      this.panels.delete(surface.id);
      this.dropMarker(surface.id);
      panel.classList.remove("active");
      panel.classList.add("dissolving");
      setTimeout(() => panel.remove(), 320);
    };
  }

  applyWorldPatch(patch: Record<string, unknown>): void {
    if (typeof patch.intensity === "number") this.uniforms.uIntensity.value = patch.intensity;
    if (typeof patch.cool === "number") this.uniforms.uColorCool.value.setHex(patch.cool);
    if (typeof patch.warm === "number") this.uniforms.uColorWarm.value.setHex(patch.warm);
    if (typeof patch.voidColor === "number") this.uniforms.uColorVoid.value.setHex(patch.voidColor);

    if (typeof patch.compass === "boolean") {
      this.opts.compass = patch.compass;
      if (!patch.compass) for (const id of [...this.markers.keys()]) this.dropMarker(id);
    }
    if (typeof patch.fade === "boolean") this.opts.fade = patch.fade;
    if (typeof patch.drift === "number") this.opts.drift = patch.drift;
    if (typeof patch.snap === "boolean") this.opts.snap = patch.snap;
    if (typeof patch.reduceMotion === "boolean") {
      this.opts.reduceMotion = patch.reduceMotion;
      document.body.classList.toggle("vs-reduce-motion", patch.reduceMotion);
    }
    // A one-shot sky flash. Purely for the drama of it.
    if (patch.supernova === true) this.supernova();
  }

  private supernova(): void {
    const start = this.uniforms.uIntensity.value;
    const t0 = performance.now();
    const flash = () => {
      const k = (performance.now() - t0) / 900;
      if (k >= 1) {
        this.uniforms.uIntensity.value = start;
        return;
      }
      // Spike hard, then fall back to where the slider was.
      this.uniforms.uIntensity.value = start + Math.sin(k * Math.PI) * 2.4;
      requestAnimationFrame(flash);
    };
    flash();
  }

  // ---- Window management -------------------------------------------------

  /**
   * Bring an already-open panel back to the user instead of cloning the app.
   * The panel keeps its own anchor direction but is pulled to a comfortable
   * reading depth, released from any body it was riding, flashed so the eye
   * can find it, and handed keyboard focus.
   */
  focusSurface(id: string): void {
    const p = this.panels.get(id);
    if (!p) return;

    this.freeFromBody(p);

    // Pull it back to spawn depth so a panel pushed far away still comes back.
    const dist = p.anchor.distanceTo(this.camera.position);
    if (dist > HOME_DEPTH) {
      p.anchor
        .sub(this.camera.position)
        .normalize()
        .multiplyScalar(HOME_DEPTH)
        .add(this.camera.position);
    }

    this.pulse(p.el);

    // Focus the first editable control in the body — never the titlebar close.
    const focusable = p.el.querySelector<HTMLElement>(
      ".vs-panel-content input, .vs-panel-content textarea, .vs-panel-content select"
    );
    focusable?.focus();
  }

  /** Restart the highlight even if it's mid-animation from a previous focus. */
  private pulse(el: HTMLElement): void {
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
  }

  /** Swing the camera until the surface sits dead centre. */
  lookAtSurface(id: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    this.aimAt(this.worldOf(p, this.tmpWorld.clone()));
    this.pulse(p.el);
  }

  /** Point the camera down a world direction, taking the short way round. */
  private aimAt(target: THREE.Vector3): void {
    const d = target.clone().sub(this.camera.position).normalize();
    const pitch = Math.max(-1.2, Math.min(1.2, Math.asin(d.y)));
    let yaw = Math.atan2(-d.x, -d.z);
    // Unwrap so a target just past ±180° doesn't spin the whole way around.
    const twoPi = Math.PI * 2;
    while (yaw - this.targetYaw > Math.PI) yaw -= twoPi;
    while (yaw - this.targetYaw < -Math.PI) yaw += twoPi;
    this.targetYaw = yaw;
    this.targetPitch = pitch;
  }

  /** Gather every panel into a readable arc in front of the camera. */
  recallSurfaces(): void {
    const loose = [...this.panels.values()].filter((p) => !p.pinned);
    const n = loose.length;
    if (!n) return;
    const q = this.camQuat.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
    loose.forEach((p, i) => {
      this.freeFromBody(p);
      // Fan them across a shallow arc, stacking rows once it gets crowded.
      const perRow = Math.min(4, n);
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const spanX = (col - (perRow - 1) / 2) * 300;
      const spanY = -row * 240 + 60;
      p.anchor
        .set(spanX, spanY, -HOME_DEPTH)
        .applyQuaternion(q)
        .add(this.camera.position);
      this.pulse(p.el);
    });
  }

  // ---- Dashboards --------------------------------------------------------

  /**
   * Weld two panels together. If either is already part of a dashboard the
   * other joins it, so you can build a cluster by linking one window at a time.
   */
  linkSurfaces(aId: string, bId: string): string | null {
    const a = this.panels.get(aId);
    const b = this.panels.get(bId);
    if (!a || !b || aId === bId) return null;

    let group: GroupEntry;
    if (a.groupId && this.groups.has(a.groupId)) {
      group = this.groups.get(a.groupId)!;
    } else if (b.groupId && this.groups.has(b.groupId)) {
      group = this.groups.get(b.groupId)!;
    } else {
      const id = `dash-${++this.groupCounter}`;
      group = {
        id,
        name: `dashboard ${this.groupCounter}`,
        members: new Set<string>(),
        // Spread hues around the wheel so neighbouring dashboards read apart.
        hue: (this.groupCounter * 67) % 360,
      };
      this.groups.set(id, group);
    }

    for (const [id, p] of [
      [aId, a],
      [bId, b],
    ] as [string, PanelEntry][]) {
      if (p.groupId && p.groupId !== group.id) this.unlinkSurface(id);
      p.groupId = group.id;
      group.members.add(id);
      this.paintGroup(p, group);
    }

    this.pulse(a.el);
    this.pulse(b.el);
    return group.id;
  }

  unlinkSurface(id: string): void {
    const p = this.panels.get(id);
    if (!p || !p.groupId) return;
    const group = this.groups.get(p.groupId);
    p.groupId = null;
    p.el.style.removeProperty("--vs-group");
    p.el.classList.remove("grouped");
    p.el.querySelector(".vs-group-chip")?.remove();
    this.dropMarker(id);

    if (!group) return;
    group.members.delete(id);
    // A dashboard of one is just a window.
    if (group.members.size <= 1) {
      for (const m of [...group.members]) {
        const mp = this.panels.get(m);
        if (mp) {
          mp.groupId = null;
          mp.el.style.removeProperty("--vs-group");
          mp.el.classList.remove("grouped");
          mp.el.querySelector(".vs-group-chip")?.remove();
        }
      }
      this.dropMarker(group.id);
      this.groups.delete(group.id);
    }
  }

  private paintGroup(p: PanelEntry, group: GroupEntry): void {
    p.el.style.setProperty("--vs-group", `hsl(${group.hue} 90% 68%)`);
    p.el.classList.add("grouped");
    let chip = p.el.querySelector<HTMLElement>(".vs-group-chip");
    if (!chip) {
      chip = document.createElement("span");
      chip.className = "vs-group-chip";
      p.el.querySelector(".vs-panel-bar")?.prepend(chip);
    }
    chip.textContent = group.name;
    chip.title = "click to release from dashboard";
    chip.onclick = () => this.unlinkSurface(this.idOf(p) ?? "");
  }

  private idOf(entry: PanelEntry): string | null {
    for (const [id, p] of this.panels) if (p === entry) return id;
    return null;
  }

  /** Lay a dashboard's members out in a grid on a plane facing the camera. */
  tileGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    const members = [...group.members]
      .map((id) => this.panels.get(id))
      .filter((p): p is PanelEntry => Boolean(p));
    if (!members.length) return;

    const centre = new THREE.Vector3();
    for (const m of members) centre.add(this.worldOf(m, new THREE.Vector3()));
    centre.divideScalar(members.length);

    const q = this.camQuat.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const cols = Math.ceil(Math.sqrt(members.length));

    members.forEach((m, i) => {
      this.freeFromBody(m);
      const col = i % cols;
      const row = Math.floor(i / cols);
      const rows = Math.ceil(members.length / cols);
      const dx = (col - (cols - 1) / 2) * 300;
      const dy = -(row - (rows - 1) / 2) * 240;
      m.anchor
        .copy(centre)
        .add(right.clone().multiplyScalar(dx))
        .add(up.clone().multiplyScalar(dy));
      this.pulse(m.el);
    });
  }

  listGroups(): SurfaceGroup[] {
    return [...this.groups.values()].map((g) => ({
      id: g.id,
      name: g.name,
      members: [...g.members],
    }));
  }

  /** Lock a panel to the camera so it rides along wherever you look. */
  pinSurface(id: string, pinned: boolean): void {
    const p = this.panels.get(id);
    if (!p) return;
    const q = this.camQuat.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));
    if (pinned) {
      this.freeFromBody(p);
      // Remember where it sat relative to the camera at the moment of pinning.
      p.pinOffset
        .copy(this.worldOf(p, new THREE.Vector3()))
        .sub(this.camera.position)
        .applyQuaternion(q.clone().invert());
      p.pinned = true;
      p.el.classList.add("pinned");
      this.dropMarker(id);
    } else {
      // Drop it into the world exactly where it currently appears.
      p.anchor.copy(p.pinOffset).applyQuaternion(q).add(this.camera.position);
      p.pinned = false;
      p.el.classList.remove("pinned");
    }
    p.el.querySelector(".vs-panel-pin")?.classList.toggle("on", pinned);
  }

  getVista(): { yaw: number; pitch: number } {
    return { yaw: this.targetYaw, pitch: this.targetPitch };
  }

  gotoVista(v: { yaw: number; pitch: number }): void {
    const twoPi = Math.PI * 2;
    let yaw = v.yaw;
    while (yaw - this.targetYaw > Math.PI) yaw -= twoPi;
    while (yaw - this.targetYaw < -Math.PI) yaw += twoPi;
    this.targetYaw = yaw;
    this.targetPitch = Math.max(-1.2, Math.min(1.2, v.pitch));
  }

  // ---- Celestial bodies --------------------------------------------------

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
    };
    this.positionBody(entry);
    this.scene.add(group);
    this.bodies.set(id, entry);
    return id;
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
    } else {
      p.bodyId = null;
    }
  }

  listBodies(): { id: string; kind: BodyKind }[] {
    return [...this.bodies.values()].map((b) => ({ id: b.id, kind: b.kind }));
  }

  // ---- Frame loop --------------------------------------------------------

  start(): void {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const dt = this.clock.getDelta();
      this.uniforms.uTime.value += dt;

      this.yaw += (this.targetYaw - this.yaw) * 0.06;
      this.pitch += (this.targetPitch - this.pitch) * 0.06;
      this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
      this.camQuat.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, "YXZ"));

      if (!this.opts.reduceMotion) {
        // The void turns, not the viewer.
        this.nebula.rotation.y += dt * this.opts.drift;
        this.particles.rotation.y += dt * 0.01;

        for (const b of this.bodies.values()) {
          b.phase += dt * b.speed;
          this.positionBody(b);
          b.group.rotation.y += dt * b.spin;
        }
      }

      this.renderer.render(this.scene, this.camera);
      this.projectPanels();
    };
    loop();
  }

  /** Resolve where a panel actually lives this frame. */
  private worldOf(p: PanelEntry, out: THREE.Vector3): THREE.Vector3 {
    if (p.pinned) {
      return out.copy(p.pinOffset).applyQuaternion(this.camQuat).add(this.camera.position);
    }
    if (p.bodyId) {
      // Merged panels deliberately ride their body around its orbit.
      const b = this.bodies.get(p.bodyId);
      if (b) return out.copy(b.position).add(p.offset);
    }
    return out.copy(p.anchor);
  }

  /** Place every panel's DOM at the screen projection of its 3D anchor. */
  private projectPanels(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const camPos = this.camera.position;
    /** Targets that need an edge marker: id -> world point. */
    const offscreen = new Map<string, THREE.Vector3>();
    /** Keys with at least one visible panel; they never get an arrow. */
    const visible = new Set<string>();

    for (const [id, p] of this.panels) {
      this.worldOf(p, this.tmpWorld);

      // Behind-camera test in camera space (camera looks down -Z).
      this.tmpCam.copy(this.tmpWorld).applyMatrix4(this.camera.matrixWorldInverse);
      const behind = this.tmpCam.z > -1;

      this.tmpNdc.copy(this.tmpWorld).project(this.camera);
      const onScreen =
        !behind &&
        this.tmpNdc.x >= -1.05 &&
        this.tmpNdc.x <= 1.05 &&
        this.tmpNdc.y >= -1.05 &&
        this.tmpNdc.y <= 1.05;

      if (!onScreen) {
        p.el.style.display = "none";
        // One marker per dashboard, otherwise the edge fills with duplicates.
        const key = p.groupId ?? id;
        if (!p.pinned && !offscreen.has(key)) offscreen.set(key, this.tmpWorld.clone());
        continue;
      }
      p.el.style.display = "";
      visible.add(p.groupId ?? id);

      const x = (this.tmpNdc.x * 0.5 + 0.5) * w;
      const y = (-this.tmpNdc.y * 0.5 + 0.5) * h;
      const dist = this.tmpWorld.distanceTo(camPos);
      const scale = Math.max(0.35, Math.min(1.6, 760 / dist));

      p.el.style.left = `${x.toFixed(1)}px`;
      p.el.style.top = `${y.toFixed(1)}px`;
      p.el.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;

      // Stack by real depth so a near panel always occludes a far one, and fade
      // distant panels into the void so depth reads as depth, not just size.
      // Pinned panels sit above the lot — they're the "always on top" tray.
      p.el.style.zIndex = `${p.pinned ? 200000 : Math.max(0, Math.round(100000 - dist))}`;
      // Set as a custom property, not inline opacity: the materialize/dissolve
      // class rules are more specific and so still win during those animations.
      const fade = this.opts.fade
        ? 1 - Math.min(0.55, Math.max(0, (dist - FADE_START) / FADE_RANGE))
        : 1;
      p.el.style.setProperty("--vs-depth-fade", fade.toFixed(3));
    }

    // A dashboard you can partly see needs no arrow, whichever member we hit
    // first while walking the map.
    for (const key of visible) offscreen.delete(key);
    for (const key of visible) this.dropMarker(key);

    if (this.opts.compass) this.updateMarkers(offscreen, w, h);
    else for (const key of [...this.markers.keys()]) this.dropMarker(key);
  }

  /**
   * Edge-of-screen waypoints. Anything you've rotated away from leaves a
   * chevron on the rim pointing back toward it; click one and the camera swings
   * around until it's centred. Without this, a window you turn away from is
   * effectively lost in a 360° room.
   */
  private updateMarkers(targets: Map<string, THREE.Vector3>, w: number, h: number): void {
    const cx = w / 2;
    const cy = h / 2;
    const rx = cx - 54;
    const ry = cy - 54;

    for (const [key, world] of targets) {
      this.tmpCam.copy(world).applyMatrix4(this.camera.matrixWorldInverse);
      const behind = this.tmpCam.z > -1;
      this.tmpNdc.copy(world).project(this.camera);

      let nx = this.tmpNdc.x;
      let ny = this.tmpNdc.y;
      // Behind the camera the projection mirrors; flip it so the arrow points
      // the way you actually need to turn.
      if (behind) {
        nx = -nx;
        ny = -ny;
      }

      const angle = Math.atan2(ny, nx);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // Push out to whichever edge the ray hits first.
      const scale = Math.min(
        Math.abs(cos) < 1e-4 ? Infinity : rx / Math.abs(cos),
        Math.abs(sin) < 1e-4 ? Infinity : ry / Math.abs(sin)
      );
      const px = cx + cos * scale;
      const py = cy - sin * scale;

      const marker = this.ensureMarker(key);
      marker.style.left = `${px.toFixed(1)}px`;
      marker.style.top = `${py.toFixed(1)}px`;
      const chevron = marker.firstElementChild as HTMLElement | null;
      if (chevron) chevron.style.transform = `rotate(${(-angle * 180) / Math.PI}deg)`;
    }

    // Retire markers whose target came back into view or closed.
    for (const key of [...this.markers.keys()]) {
      if (!targets.has(key)) this.dropMarker(key);
    }
  }

  private ensureMarker(key: string): HTMLElement {
    const existing = this.markers.get(key);
    if (existing) return existing;

    const group = this.groups.get(key);
    const panel = this.panels.get(key);

    const el = document.createElement("button");
    el.className = "vs-waypoint";
    if (group) el.style.setProperty("--vs-group", `hsl(${group.hue} 90% 68%)`);
    if (group) el.classList.add("grouped");

    const chevron = document.createElement("span");
    chevron.className = "vs-waypoint-arrow";
    chevron.textContent = "\u27A4";

    const label = document.createElement("span");
    label.className = "vs-waypoint-label";
    label.textContent = group ? group.name : panel?.title ?? "window";

    el.append(chevron, label);
    el.title = `look at ${label.textContent}`;
    el.addEventListener("click", () => {
      // For a dashboard, aim at the first member — they're welded anyway.
      const targetId = group ? [...group.members][0] : key;
      if (targetId) this.lookAtSurface(targetId);
    });

    this.waypointLayer.appendChild(el);
    this.markers.set(key, el);
    return el;
  }

  private dropMarker(key: string): void {
    const el = this.markers.get(key);
    if (!el) return;
    el.remove();
    this.markers.delete(key);
  }

  // ---- Interaction -------------------------------------------------------

  /**
   * Title-bar dragging. The panel's screen position is recomputed from its 3D
   * anchor every frame, so a drag can't just set left/top — it has to move the
   * anchor itself. We cast a ray through the cursor and slide the anchor along
   * it, holding the panel's distance from the camera constant so its apparent
   * size doesn't change mid-drag. Dragging any member of a dashboard carries
   * the whole cluster along at its original relative offsets.
   */
  private bindPanelDrag(id: string, bar: HTMLElement, tools: HTMLElement): void {
    let dragging = false;
    let dist = 0;
    // Cursor-to-panel-center offset, so the panel doesn't snap under the cursor.
    let grabX = 0;
    let grabY = 0;
    let cohort: { p: PanelEntry; offset: THREE.Vector3 }[] = [];

    bar.addEventListener("pointerdown", (e) => {
      if (tools.contains(e.target as Node)) return;
      const p = this.panels.get(id);
      if (!p || p.pinned) return;

      this.freeFromBody(p);
      dist = p.anchor.distanceTo(this.camera.position);
      grabX = e.clientX - parseFloat(p.el.style.left || "0");
      grabY = e.clientY - parseFloat(p.el.style.top || "0");

      // Capture the rest of the dashboard relative to the panel being dragged.
      cohort = [];
      if (p.groupId) {
        const group = this.groups.get(p.groupId);
        if (group) {
          for (const m of group.members) {
            if (m === id) continue;
            const mp = this.panels.get(m);
            if (!mp || mp.pinned) continue;
            this.freeFromBody(mp);
            cohort.push({ p: mp, offset: mp.anchor.clone().sub(p.anchor) });
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
      this.anchorFromScreen(p.anchor, e.clientX - grabX, e.clientY - grabY, dist);
      if (this.opts.snap) {
        p.anchor.set(
          Math.round(p.anchor.x / SNAP) * SNAP,
          Math.round(p.anchor.y / SNAP) * SNAP,
          Math.round(p.anchor.z / SNAP) * SNAP
        );
      }
      for (const c of cohort) c.p.anchor.copy(p.anchor).add(c.offset);
    });

    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      cohort = [];
      bar.releasePointerCapture(e.pointerId);
      this.panels.get(id)?.el.classList.remove("dragging");
    };
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
  }

  /** The pin toggle and the link-drag handle in the title bar. */
  private bindPanelTools(id: string, link: HTMLElement, pin: HTMLElement): void {
    pin.addEventListener("click", (e) => {
      e.stopPropagation();
      const p = this.panels.get(id);
      if (p) this.pinSurface(id, !p.pinned);
    });

    link.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.linkSource = id;
      document.body.classList.add("vs-linking");
      this.linkSvg.classList.add("on");
      const p = this.panels.get(id);
      const rect = p?.el.getBoundingClientRect();
      if (rect) {
        this.linkLine.setAttribute("x1", `${rect.left + rect.width / 2}`);
        this.linkLine.setAttribute("y1", `${rect.top + rect.height / 2}`);
        this.linkLine.setAttribute("x2", `${e.clientX}`);
        this.linkLine.setAttribute("y2", `${e.clientY}`);
      }
    });
  }

  /** Global handlers that finish a link drag wherever it happens to end. */
  private bindLinking(): void {
    window.addEventListener("pointermove", (e) => {
      if (!this.linkSource) return;
      this.linkLine.setAttribute("x2", `${e.clientX}`);
      this.linkLine.setAttribute("y2", `${e.clientY}`);
      const hovered = this.panelElementAt(e.clientX, e.clientY);
      for (const p of this.panels.values()) {
        p.el.classList.toggle("link-target", p.el === hovered && p.el !== this.sourceEl());
      }
    });

    window.addEventListener("pointerup", (e) => {
      if (!this.linkSource) return;
      const hovered = this.panelElementAt(e.clientX, e.clientY);
      if (hovered) {
        for (const [id, p] of this.panels) {
          if (p.el === hovered && id !== this.linkSource) {
            this.linkSurfaces(this.linkSource, id);
            break;
          }
        }
      }
      this.linkSource = null;
      document.body.classList.remove("vs-linking");
      this.linkSvg.classList.remove("on");
      for (const p of this.panels.values()) p.el.classList.remove("link-target");
    });
  }

  private sourceEl(): HTMLElement | null {
    return this.linkSource ? this.panels.get(this.linkSource)?.el ?? null : null;
  }

  private panelElementAt(x: number, y: number): HTMLElement | null {
    const hit = document.elementFromPoint(x, y);
    return (hit as HTMLElement | null)?.closest?.(".vs-panel") ?? null;
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
  }

  /** Screen point -> world anchor at a fixed distance from the camera. */
  private anchorFromScreen(
    out: THREE.Vector3,
    cx: number,
    cy: number,
    dist: number
  ): void {
    this.tmpCam
      .set(
        (cx / window.innerWidth) * 2 - 1,
        -(cy / window.innerHeight) * 2 + 1,
        0.5
      )
      .unproject(this.camera);

    out
      .copy(this.tmpCam)
      .sub(this.camera.position)
      .normalize()
      .multiplyScalar(dist)
      .add(this.camera.position);
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
      this.targetYaw -= dx * 0.0022;
      this.targetPitch = Math.max(-1.2, Math.min(1.2, this.targetPitch - dy * 0.0022));
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
    this.renderer.dispose();
  }
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
