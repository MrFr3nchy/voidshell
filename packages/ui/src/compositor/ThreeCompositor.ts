import * as THREE from "three";
import type {
  AnchorHandle,
  ArrangeMode,
  BodyKind,
  Compositor,
  CompositorStats,
  GroupInfo,
  GroupStyle,
  Surface,
  SurfacePlacement,
  Vec3,
} from "../kernel/types";
import { nebulaFragment, nebulaVertex } from "../world/nebulaShader";
import { Compass, type CompassItem } from "../ui/compass";
import { showContextMenu } from "../ui/contextMenu";
import {
  GROUP_COLORS,
  RESIZE_AXES,
  closeSurfaceById,
  createPanelChrome,
  panelMenuItems,
  type ResizeAxis,
} from "./panelChrome";
import {
  PLAIN,
  applyForm,
  clearForm,
  defaultFormFor,
  formById,
  isFormId,
} from "./surfaceForms";
import { TetherLayer } from "./tethers";

interface PanelEntry {
  id: string;
  title: string;
  el: HTMLElement;
  /** The title span and the close button, both of which carry the name. */
  titleEl: HTMLElement;
  closeEl: HTMLElement;
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
  /**
   * Which silhouette this window wears, or PLAIN for an ordinary glass panel.
   *
   * Lives on the panel rather than on the module, which is the whole of the
   * change: a shape is an opinion about *this* window. Two clocks can be two
   * different objects, and the one you shaped by accident is the only one you
   * have to put back.
   */
  form: string;
  /** Filling a region of the screen: the window has left the void entirely. */
  snap: SnapMode | null;
  /** Where to put it back when it unsnaps. */
  restore: RestoreBox | null;
  width: number;
  height: number;
  /** Per-panel phase so ambient drift doesn't move everything in lockstep. */
  phase: number;
  /** Last computed screen position, reused by tethers and link-dragging. */
  sx: number;
  sy: number;
  /** Last computed projection scale. Resizing needs it to stay in step. */
  scale: number;
  onScreen: boolean;
}

/** How a window fills the screen when it stops floating. */
type SnapMode = "full" | "left" | "right";

/** Everything needed to undo a snap. */
interface RestoreBox {
  anchor: THREE.Vector3;
  width: number;
  height: number;
  pinned: boolean;
  pinX: number;
  pinY: number;
}

/** A piece of DOM pinned to a world position — desktop icons and the like. */
interface AnchorEntry {
  el: HTMLElement;
  anchor: THREE.Vector3;
}

/**
 * One live meteor. Its own `Line` and `Material` rather than a shared buffer
 * slot, because unlike `warpField` these are born and die continuously over a
 * session — a shared-buffer approach would need slot bookkeeping to get that
 * right, and a handful of short-lived draw calls costs nothing next to a scene
 * that already draws 1400 dust points in one call.
 */
interface MeteorEntity {
  obj: THREE.Line;
  geo: THREE.BufferGeometry;
  mat: THREE.LineBasicMaterial;
  /** 0 at spawn, 1 at burnout. */
  t: number;
  life: number;
  dirA: THREE.Vector3;
  dirB: THREE.Vector3;
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
  /**
   * A hard bond translates: every member moves by the same vector, so the
   * formation keeps its shape and members nearer the camera grow as it
   * travels. A loose one rotates the formation about the camera instead,
   * which holds every member's distance — and so its size — exactly constant.
   *
   * This used to be one global setting, which meant it was a property of the
   * whole void rather than of a particular constellation. It is per-group now,
   * and the setting seeds the default for new ones.
   */
  rigid: boolean;
}

const PLANET_COLORS = [0x6ec6ff, 0xb98cff, 0x5fd6a8, 0xff9d6e];

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

const MIN_PANEL_W = 240;
const MIN_PANEL_H = 140;

/**
 * Stacking bands.
 *
 * Depth alone used to decide the whole order, which meant clicking a window
 * could not raise it: two overlapping panels were ranked by their distance to
 * the camera forever, and the nearer one won even when you were working in the
 * other. Focus now adds a bump inside the band, so a click raises a window
 * without letting it jump over a class of window that should always be above
 * it. The bump is deliberately smaller than the gap between bands.
 *
 * This also fixes pinned panels: at a flat 90000 they sat *below* every
 * floating panel (which score ~97800-99500), so "pin to screen" quietly put a
 * window behind the void it was supposed to stick in front of.
 */
const Z_FLOATING = 0;
const Z_SNAPPED = 500_000;
const Z_PINNED = 1_000_000;
const Z_FOCUS_BUMP = 150_000;

/** Viewport insets for a snapped window: clear of the status bar, and framed. */
const SNAP_INSET = { top: 52, right: 16, bottom: 16, left: 16 };

/** How close to an edge a title-bar drag must get before it offers to snap. */
const SNAP_EDGE = 26;

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
  private tethers!: TetherLayer;
  private snapGhost!: HTMLElement;

  /** Live streaks, each its own short Line so it can fade and be disposed independently. */
  private meteors: MeteorEntity[] = [];
  private meteorTimer = 4;
  private static readonly METEOR_RADIUS = 5200;
  private static readonly METEOR_MAX = 5;

  /**
   * One shared field of directional streaks for warp, distinct from `particles`
   * (ordinary decorative dust) so engaging warp can never perturb the dust
   * count or drift settings someone has already tuned. Each entry only ever
   * moves along its own radius — direction is fixed once, picked fresh only on
   * recycle — so the whole field is three parallel typed arrays rather than an
   * array of objects, cheap enough to walk every frame at `WARP_COUNT` size.
   */
  private warpField!: THREE.LineSegments;
  private warpDir!: Float32Array; // unit vectors, 3 per entry
  private warpRadius!: Float32Array;
  private warpCurrent = 0; // eased 0..1, never snaps straight to the target
  private static readonly WARP_COUNT = 240;
  private static readonly WARP_MIN_R = 200;
  private static readonly WARP_MAX_R = 5200;
  private static readonly WARP_SPEED = 5200; // px/sec of streak growth at warpCurrent = 1

  /** Undisturbed star density; twinkle oscillates around this, not over it. */
  private baseStars = 0.55;

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
  /** Anchors held while the overview is up, so leaving it restores them. */
  private exposed: Map<string, THREE.Vector3> | null = null;

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
    meteors: false,
    meteorRate: 6,
    meteorColor: null as number | null,
    starTwinkle: 0,
    bloom: 1,
    cameraRoll: true,
    inertia: true,
    clickEcho: true,
    linkPulse: false,
    warp: false,
    compass: true,
    tethers: true,
    baseIntensity: 1,
    // Constellations
    linkOpacity: 0.5,
    linkWidth: 1.2,
    linkGlow: 6,
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
  /** Eased bank angle, driven by how fast yaw is currently changing. */
  private roll = 0;
  private lastYaw = 0;
  /** Thrown-window momentum: panel id -> world-units/sec, decayed each frame. */
  private inertia = new Map<string, THREE.Vector3>();
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

    this.warpField = this.makeWarpField(ThreeCompositor.WARP_COUNT);
    this.scene.add(this.warpField);

    // Tethers live under the panels so a link line never eats a click. The
    // threads are also controls: clicking one hardens or loosens that bond.
    this.tethers = new TetherLayer(this.overlay, (gid) => {
      const g = this.groups.get(gid);
      if (g) this.setGroupRigid(gid, !g.rigid);
    });

    this.snapGhost = document.createElement("div");
    this.snapGhost.className = "vs-snap-ghost";
    this.overlay.appendChild(this.snapGhost);

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

  /**
   * `WARP_COUNT` streaks, each a two-point line segment that only ever moves
   * along its own fixed direction. At `warpCurrent = 0` the material is fully
   * transparent and the segments are never touched, so idling costs nothing
   * beyond the one-time buffer this allocates.
   */
  private makeWarpField(count: number): THREE.LineSegments {
    this.warpDir = new Float32Array(count * 3);
    this.warpRadius = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const [dx, dy, dz] = randomUnitVector();
      this.warpDir[i * 3] = dx;
      this.warpDir[i * 3 + 1] = dy;
      this.warpDir[i * 3 + 2] = dz;
      this.warpRadius[i] =
        ThreeCompositor.WARP_MIN_R + Math.random() * (ThreeCompositor.WARP_MAX_R - ThreeCompositor.WARP_MIN_R);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xdff3ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    return new THREE.LineSegments(geo, mat);
  }

  /**
   * Advance every warp streak by one frame. Each entry only ever grows its own
   * radius — direction is fixed until a recycle picks a fresh one — which is
   * what makes "how far it moved this frame" the whole streak: draw a segment
   * from where it was to where it is.
   *
   * A recycled entry draws both ends at its fresh, small radius rather than at
   * its old, far one — the two would otherwise span nearly the whole field in
   * a single frame, a visible flash that has nothing to do with warp speed.
   */
  private stepWarpField(dt: number): void {
    const mat = this.warpField.material as THREE.LineBasicMaterial;
    mat.opacity = this.warpCurrent * 0.85;
    if (this.warpCurrent < 0.002) return;

    const speed = ThreeCompositor.WARP_SPEED * this.warpCurrent;
    const pos = this.warpField.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    const count = ThreeCompositor.WARP_COUNT;

    for (let i = 0; i < count; i++) {
      const prevR = this.warpRadius[i];
      let r = prevR + speed * dt;
      let drawFromR = prevR;

      if (r > ThreeCompositor.WARP_MAX_R) {
        const [dx, dy, dz] = randomUnitVector();
        this.warpDir[i * 3] = dx;
        this.warpDir[i * 3 + 1] = dy;
        this.warpDir[i * 3 + 2] = dz;
        r = ThreeCompositor.WARP_MIN_R + Math.random() * 150;
        drawFromR = r; // this frame is a fresh spawn, not a jump across the sky
      }
      this.warpRadius[i] = r;

      const dx = this.warpDir[i * 3];
      const dy = this.warpDir[i * 3 + 1];
      const dz = this.warpDir[i * 3 + 2];
      const base = i * 6;
      arr[base] = dx * drawFromR;
      arr[base + 1] = dy * drawFromR;
      arr[base + 2] = dz * drawFromR;
      arr[base + 3] = dx * r;
      arr[base + 4] = dy * r;
      arr[base + 5] = dz * r;
    }
    pos.needsUpdate = true;
  }

  /**
   * A meteor is a short chord across the far sky: pick a point, nudge it
   * sideways by a random tangent to get a second point, and travel between
   * them. Not a true geodesic — a linear blend renormalised each step — but
   * over the small arc a meteor covers the difference is invisible and the
   * maths is a fraction of the cost.
   */
  private spawnMeteor(): void {
    if (this.meteors.length >= ThreeCompositor.METEOR_MAX) return;

    const [ax, ay, az] = randomUnitVector();
    const dirA = new THREE.Vector3(ax, ay, az);
    const rand = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    const tangent = rand.sub(dirA.clone().multiplyScalar(rand.dot(dirA)));
    if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0); // the 1-in-a-billion parallel pick
    tangent.normalize();
    const spread = 0.35 + Math.random() * 0.55;
    const dirB = dirA.clone().addScaledVector(tangent, spread).normalize();

    const color =
      this.cfg.meteorColor !== null
        ? new THREE.Color(this.cfg.meteorColor)
        : new THREE.Color().copy(this.uniforms.uColorWarm.value).lerp(new THREE.Color(0xffffff), 0.55);
    const start = dirA.clone().multiplyScalar(ThreeCompositor.METEOR_RADIUS);
    const geo = new THREE.BufferGeometry().setFromPoints([start, start.clone()]);
    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const obj = new THREE.Line(geo, mat);
    this.scene.add(obj);
    this.meteors.push({ obj, geo, mat, t: 0, life: 0.55 + Math.random() * 0.5, dirA, dirB });
  }

  /** Advance and cull every live meteor, and consider spawning a new one. */
  private stepMeteors(dt: number): void {
    this.meteorTimer -= dt;
    if (this.cfg.meteors && this.meteorTimer <= 0) {
      this.spawnMeteor();
      const perMinute = Math.max(0.5, this.cfg.meteorRate);
      const avgGap = 60 / perMinute;
      this.meteorTimer = avgGap * (0.6 + Math.random() * 0.8);
    }

    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.t += dt / m.life;
      if (m.t >= 1) {
        this.scene.remove(m.obj);
        m.geo.dispose();
        m.mat.dispose();
        this.meteors.splice(i, 1);
        continue;
      }

      const headT = m.t;
      const tailT = Math.max(0, m.t - 0.12);
      const head = m.dirA
        .clone()
        .lerp(m.dirB, headT)
        .normalize()
        .multiplyScalar(ThreeCompositor.METEOR_RADIUS);
      const tail = m.dirA
        .clone()
        .lerp(m.dirB, tailT)
        .normalize()
        .multiplyScalar(ThreeCompositor.METEOR_RADIUS);

      const pos = m.geo.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, tail.x, tail.y, tail.z);
      pos.setXYZ(1, head.x, head.y, head.z);
      pos.needsUpdate = true;

      // In over the first 15% of its life, out over the last 20% — a hard cut
      // at either end reads as a glitch rather than as a streak burning out.
      const fadeIn = m.t < 0.15 ? m.t / 0.15 : 1;
      const fadeOut = m.t > 0.8 ? (1 - m.t) / 0.2 : 1;
      m.mat.opacity = Math.max(0, Math.min(1, fadeIn * fadeOut)) * 0.9;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Surfaces                                                            */
  /* ------------------------------------------------------------------ */

  mountSurface(surface: Surface): () => void {
    // One place decides what a window is made of. The compositor used to build
    // this inline while `createPanelChrome` sat unused next to it.
    const { panel, bar, title, tools, link, grips, more, pin, min, max, close } =
      createPanelChrome(surface);
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
      titleEl: title,
      closeEl: close,
      anchor,
      bodyId: null,
      offset: new THREE.Vector3(),
      groupId: null,
      pinned: false,
      pinX: 0,
      pinY: 0,
      minimized: false,
      form: PLAIN,
      snap: null,
      restore: null,
      width: surface.width,
      height: surface.height,
      phase: Math.random() * Math.PI * 2,
      sx: 0,
      sy: 0,
      scale: 1,
      onScreen: true,
    };
    this.panels.set(surface.id, entry);

    // A module can suggest the shape it looks like — a lava lamp opens as a
    // lamp. It is only a starting point: from here the window owns it, and
    // session restore overwrites this with whatever the user chose.
    this.setSurfaceForm(surface.id, defaultFormFor(surface.moduleId));

    this.bindPanelDrag(surface.id, bar, tools, link);
    this.bindPanelDepth(surface.id, panel);
    this.bindLinkDrag(surface.id, link);
    for (const axis of RESIZE_AXES) this.bindResize(surface.id, grips[axis], axis);

    panel.addEventListener("pointerdown", () => {
      this.setActive(surface.id);
      // Picking a window out of the overview is what you came to do, so it
      // dismisses the overview rather than making you press escape as well.
      if (this.exposed) {
        this.expose(false);
        this.lookAtSurface(surface.id);
      }
    });

    pin.addEventListener("click", () => this.togglePin(surface.id));
    min.addEventListener("click", () => this.toggleMinimize(surface.id));
    max.addEventListener("click", () => this.toggleSnap(surface.id, "full"));
    close.addEventListener("click", () => closeSurfaceById(surface.id));

    // The gesture every windowing system has had for thirty years.
    bar.addEventListener("dblclick", (e) => {
      if (tools.contains(e.target as Node) || link.contains(e.target as Node)) return;
      this.toggleSnap(surface.id, "full");
    });

    // Two doors onto the same menu: the ⋯ button for people who look, and
    // right-clicking the title bar for people who already know.
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      this.openPanelMenu(surface.id, r.left, r.bottom + 4);
    });
    bar.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openPanelMenu(surface.id, e.clientX, e.clientY);
    });

    // A third door, and the one that matters: a shaped window has no title bar
    // to aim at — the silhouette is drawn over it — so right-clicking the
    // object itself has to reach the same menu. Without it a shape you cannot
    // see past is a window you cannot get back, which is exactly how an orb
    // swallowed the only control that could un-orb it.
    //
    // Deliberately only for shaped windows: a plain panel's body belongs to
    // whatever module rendered it, and the file manager has its own menu there.
    panel.addEventListener("contextmenu", (e) => {
      const p = this.panels.get(surface.id);
      if (!p || p.form === PLAIN) return;
      if (bar.contains(e.target as Node)) return;
      e.preventDefault();
      this.openPanelMenu(surface.id, e.clientX, e.clientY);
    });

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
   * Rename a live window. The compass and the palette read the kernel's copy of
   * the title, so all this has to do is the two places it is drawn.
   */
  retitleSurface(id: string, title: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    p.title = title;
    p.titleEl.textContent = title;
    const label = `Dismiss ${title}`;
    p.closeEl.title = label;
    p.closeEl.setAttribute("aria-label", label);
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

  activeSurface(): string | null {
    return this.activeId;
  }

  private setActive(id: string): void {
    if (this.activeId === id) return;
    this.activeId = id;
    for (const [pid, p] of this.panels) p.el.classList.toggle("focused", pid === id);
  }

  private togglePin(id: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    // Pinning and snapping are both "stop being projected"; a window can't do
    // both, so asking for one drops the other.
    if (p.snap) this.unsnap(p);
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
    // A shaped window has no title bar left to collapse to — the silhouette is
    // drawn over it — so collapsing one leaves an object with its head cut off.
    if (p.form !== PLAIN) return;
    p.minimized = !p.minimized;
    p.el.classList.toggle("minimized", p.minimized);
    p.el.style.height = p.minimized ? "" : `${p.height}px`;
  }

  /* ------------------------------------------------------------------ */
  /* Window shape                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Give one window a silhouette, or take it away.
   *
   * This used to live in a DOM observer watching the panel layer, keyed on
   * module id, driven by a table in Settings — three indirections for a
   * property of a window the compositor was already holding. The observer
   * existed because `mountSurface` built its own markup and `createPanelChrome`
   * was dead code; that is fixed, so this is fixed with it.
   *
   * Unknown ids fall back to a plain panel rather than throwing. A restored
   * session naming a shape that no longer exists should open a window, not
   * fail to.
   */
  setSurfaceForm(id: string, formId: string): void {
    const p = this.panels.get(id);
    if (!p) return;

    p.form = isFormId(formId) ? formId : PLAIN;
    const form = formById(p.form);

    if (!form) {
      clearForm(p.el);
      p.el.style.width = `${p.width}px`;
      // Restore the height the window actually has: a shape overrides it to
      // hold its aspect, and leaving that behind would make "back to a glass
      // panel" quietly resize the window.
      p.el.style.height = p.minimized ? "" : `${p.height}px`;
      return;
    }

    // A shape is a state of its own, and cannot be combined with the two that
    // stop a window being its own size: filling a region, and being collapsed.
    this.unsnap(p);
    if (p.minimized) {
      p.minimized = false;
      p.el.classList.remove("minimized");
    }
    applyForm(p.el, form, p.width);
  }

  /** What shape a window is wearing right now. */
  surfaceForm(id: string): string {
    return this.panels.get(id)?.form ?? PLAIN;
  }

  /* ------------------------------------------------------------------ */
  /* Snapping — the way out of the void                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Fill a region of the screen with a window, or put it back.
   *
   * A panel is normally a rectangle projected from a point in 3D, which is
   * lovely and also means it can never be exactly the size of your screen —
   * there is no distance at which "as big as the viewport" is a stable answer,
   * because the projection changes it whenever you look around. So a snapped
   * window stops being projected at all and is laid out in screen space, the
   * same trick pinning already used. Its 3D anchor is kept untouched underneath
   * so unsnapping is a restore rather than a re-placement.
   */
  private toggleSnap(id: string, mode: SnapMode): void {
    const p = this.panels.get(id);
    if (!p) return;
    if (p.snap === mode) this.unsnap(p);
    else this.setSnap(p, mode);
  }

  private setSnap(p: PanelEntry, mode: SnapMode): void {
    // A shaped window is not a rectangle, so there is no honest way for it to
    // fill a rectangular region. Refused here rather than in the menu so the
    // title-bar double-click and the drag-to-edge gesture are covered too.
    if (p.form !== PLAIN) return;
    // Only capture the restore box on the way *in*, so going full -> left ->
    // full and then unsnapping still lands on the original floating window
    // rather than on whichever snap you passed through last.
    if (!p.snap) {
      p.restore = {
        anchor: p.anchor.clone(),
        width: p.width,
        height: p.height,
        pinned: p.pinned,
        pinX: p.pinX,
        pinY: p.pinY,
      };
    }
    this.freeFromBody(p);
    p.snap = mode;
    p.pinned = false;
    p.minimized = false;
    p.el.classList.remove("pinned", "minimized");
    p.el.classList.add("snapped");
    p.el.dataset.snap = mode;
    this.setActive(p.id);
  }

  private unsnap(p: PanelEntry): void {
    if (!p.snap) return;
    p.snap = null;
    p.el.classList.remove("snapped");
    delete p.el.dataset.snap;

    const box = p.restore;
    p.restore = null;
    if (!box) return;
    p.anchor.copy(box.anchor);
    p.width = box.width;
    p.height = box.height;
    p.pinned = box.pinned;
    p.pinX = box.pinX;
    p.pinY = box.pinY;
    p.el.classList.toggle("pinned", p.pinned);
    p.el.style.width = `${p.width}px`;
    p.el.style.height = `${p.height}px`;
  }

  /** Where a snapped window sits, in screen pixels. */
  private snapRect(mode: SnapMode): {
    x: number;
    y: number;
    w: number;
    h: number;
  } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { top, right, bottom, left } = SNAP_INSET;
    const h = Math.max(MIN_PANEL_H, vh - top - bottom);
    const full = Math.max(MIN_PANEL_W, vw - left - right);
    if (mode === "full") return { x: left, y: top, w: full, h };

    // Halves share the gutter between them so the two together look like one
    // split rather than two windows that happen to be adjacent.
    const half = Math.max(MIN_PANEL_W, (full - right) / 2);
    return {
      x: mode === "left" ? left : vw - right - half,
      y: top,
      w: half,
      h,
    };
  }

  /**
   * The per-window menu.
   *
   * Everything here is scoped to this window or to the constellation it belongs
   * to — global state should cost a trip to Settings, and window state
   * shouldn't. Built as items for the shared context menu so that a title bar
   * and a desktop icon open the same kind of menu, drawn by the same code.
   */
  private openPanelMenu(id: string, x: number, y: number): void {
    const p = this.panels.get(id);
    if (!p) return;
    this.setActive(id);
    const g = p.groupId ? this.groups.get(p.groupId) : null;

    showContextMenu(
      x,
      y,
      panelMenuItems(
        {
          pinned: p.pinned,
          minimized: p.minimized,
          snapped: Boolean(p.snap),
          merged: Boolean(p.bodyId),
          form: p.form,
          group: g ? { color: g.color, rigid: g.rigid } : null,
        },
        {
          togglePin: () => this.togglePin(id),
          toggleMinimize: () => this.toggleMinimize(id),
          toggleSnap: () => this.toggleSnap(id, "full"),
          snapLeft: () => this.toggleSnap(id, "left"),
          snapRight: () => this.toggleSnap(id, "right"),
          nudge: (dir) => this.nudgeDepth(id, dir),
          release: () => this.attachSurface(id, null),
          setForm: (formId) => this.setSurfaceForm(id, formId),
          setRigid: (rigid) => this.setGroupRigid(p.groupId, rigid),
          setColor: (color) => this.setGroupColor(p.groupId, color),
          dissolve: () => p.groupId && this.unlinkGroup(p.groupId),
          close: () => closeSurfaceById(id),
        }
      )
    );
  }

  /** Push a window one comfortable step further away, or pull it back. */
  private nudgeDepth(id: string, dir: number): void {
    const p = this.panels.get(id);
    if (!p || p.pinned || p.snap) return;
    this.freeFromBody(p);
    const dist = p.anchor.distanceTo(this.camera.position);
    const next = Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, dist * (dir > 0 ? 1.25 : 0.8)));
    p.anchor
      .sub(this.camera.position)
      .normalize()
      .multiplyScalar(next)
      .add(this.camera.position);
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
    if (typeof patch.meteorColor === "number") this.cfg.meteorColor = patch.meteorColor;

    const stars = num("stars");
    if (stars !== null) {
      this.baseStars = stars;
      this.uniforms.uStars.value = stars;
    }
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
      "meteorRate",
      "starTwinkle",
      "bloom",
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
      "meteors",
      "warp",
      "compass",
      "tethers",
      "cameraRoll",
      "inertia",
      "clickEcho",
      "linkPulse",
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
    if (!this.cfg.tethers) this.tethers.clear();
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

    // A snapped window is already as present as it can get; hauling the camera
    // around to "face" something that fills the screen would just spin the void.
    if (!p.snap) this.freeFromBody(p);
    if (!p.pinned && !p.snap) {
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
    // Pinned and snapped windows are stuck to the glass; there is no direction
    // to turn towards, and aiming at their stale anchor would spin the void.
    if (!p || p.pinned || p.snap) return;
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

  linkSurfaces(ids: string[], name?: string, style?: GroupStyle): string {
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
      this.tethers.remove(gid);
    }

    const id = `group-${++this.groupCounter}`;
    const entry: GroupEntry = {
      id,
      name: name?.trim() || `constellation ${this.groupCounter}`,
      members,
      color: style?.color ?? GROUP_COLORS[(this.groupCounter - 1) % GROUP_COLORS.length],
      // The world setting is the default for new constellations, not a law
      // over the live ones — a bond you hardened stays hardened. Session
      // restore passes the style it wrote down, so a rebuilt constellation
      // comes back the colour and firmness you left it.
      rigid: style?.rigid ?? !this.cfg.linkOrbit,
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
    this.tethers.remove(id);
  }

  listGroups(): GroupInfo[] {
    return [...this.groups.values()].map((g) => ({
      id: g.id,
      name: g.name,
      members: [...g.members],
      color: g.color,
      rigid: g.rigid,
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
      .filter((p): p is PanelEntry => Boolean(p) && !p!.pinned && !p!.snap);
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
      if (!p || p.pinned || p.snap) continue;
      centre.add(this.worldOf(p, new THREE.Vector3()));
      n++;
    }
    return n ? centre.multiplyScalar(1 / n) : null;
  }

  /* ------------------------------------------------------------------ */
  /* Overview                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Every window at once, in a grid facing you — and then back exactly as it
   * was.
   *
   * `arrange` already fans windows into formations, but it is a permanent
   * re-layout: using it to *find* something costs you the arrangement you had,
   * which is why nobody uses it to find things. The difference here is the
   * whole feature — every anchor is remembered on the way in and restored on
   * the way out, so an overview is a look rather than a decision.
   *
   * Snapped and pinned windows are left alone. They are already on the glass,
   * fully visible, and dragging them into the world to show them to you would
   * be undoing the thing you asked them to do.
   */
  expose(on?: boolean): boolean {
    const wasUp = Boolean(this.exposed);
    const want = on ?? !wasUp;
    if (want === wasUp) return wasUp;

    if (!want) {
      for (const [id, anchor] of this.exposed!) {
        this.panels.get(id)?.anchor.copy(anchor);
      }
      this.exposed = null;
      document.body.classList.remove("vs-exposed");
      return false;
    }

    const list = [...this.panels.values()].filter((p) => !p.pinned && !p.snap);
    if (!list.length) return false;

    this.exposed = new Map(list.map((p) => [p.id, p.anchor.clone()]));
    document.body.classList.add("vs-exposed");

    // A square-ish grid on the plane the camera is facing, far enough back
    // that a full one fits inside the field of view.
    const cols = Math.ceil(Math.sqrt(list.length));
    const rows = Math.ceil(list.length / cols);
    const euler = new THREE.Euler(this.targetPitch, this.targetYaw, 0, "YXZ");
    const fwd = new THREE.Vector3(0, 0, -1).applyEuler(euler);
    const right = new THREE.Vector3(1, 0, 0).applyEuler(euler);
    const up = new THREE.Vector3(0, 1, 0).applyEuler(euler);
    const depth = 700 + Math.max(cols, rows) * 120;

    list.forEach((p, i) => {
      this.freeFromBody(p);
      const col = i % cols;
      const row = Math.floor(i / cols);
      p.anchor
        .copy(this.camera.position)
        .addScaledVector(fwd, depth)
        .addScaledVector(right, (col - (cols - 1) / 2) * 330)
        .addScaledVector(up, ((rows - 1) / 2 - row) * 260);
    });
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Arrangement                                                         */
  /* ------------------------------------------------------------------ */

  arrange(mode: ArrangeMode): void {
    // Snapped and pinned windows aren't in the world, so a formation has
    // nowhere to put them.
    const list = [...this.panels.values()].filter((p) => !p.pinned && !p.snap);
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
    // Before the states below, because a shape refuses to be snapped or
    // collapsed and the ones that survive have to be applied over it, not
    // under it. A session that predates shapes says nothing here and gets the
    // module's default, which is what it had.
    if (place.form !== undefined) this.setSurfaceForm(id, place.form);
    if (place.pinned) {
      p.pinned = true;
      p.pinX = place.pinX;
      p.pinY = place.pinY;
      p.el.classList.add("pinned");
    }
    if (place.minimized) {
      p.minimized = true;
      p.el.classList.add("minimized");
      p.el.style.height = "";
    }
    // Applied last, so the restore box it captures is the floating window we
    // just rebuilt — restoring a maximized window and then un-maximizing it
    // has to land on the size it had before it was maximized, not on the
    // screen-sized box it was wearing when the session was written.
    if (place.snap) this.setSnap(p, place.snap);
  }

  snapshot(): Record<string, SurfacePlacement> {
    const out: Record<string, SurfacePlacement> = {};
    for (const [id, p] of this.panels) {
      // A snapped window's own width/height are its region's, which would
      // become its "floating" size on the next boot. Its restore box is the
      // one worth writing down.
      const box = p.snap && p.restore ? p.restore : p;
      out[id] = {
        anchor: [box.anchor.x, box.anchor.y, box.anchor.z],
        width: box.width,
        height: box.height,
        pinned: box.pinned,
        pinX: box.pinX,
        pinY: box.pinY,
        snap: p.snap,
        minimized: p.minimized,
        // Read off the panel rather than the restore box: a shaped window can
        // never be snapped, so there is only one place the answer lives.
        form: p.form,
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

      // A slight bank into a fast turn — the same ease the camera itself uses,
      // so it reads as inertia rather than as a wobble bolted on afterwards.
      const yawVel = dt > 0 ? (this.yaw - this.lastYaw) / dt : 0;
      const targetRoll = this.cfg.cameraRoll
        ? Math.max(-0.22, Math.min(0.22, -yawVel * 0.12))
        : 0;
      this.roll += (targetRoll - this.roll) * Math.min(1, dt * 6);
      this.lastYaw = this.yaw;
      this.camera.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");

      // The void turns, not the viewer.
      this.nebula.rotation.y += dt * 0.015 * this.cfg.nebulaSpin;
      this.particles.rotation.y += dt * 0.01 * this.cfg.nebulaSpin;

      // Slow aurora weather (when storms is on) times bloom (always) — one
      // multiply, written every frame, rather than a value that only moves
      // when storms happens to be the thing touching it.
      const stormPulse = this.cfg.storms
        ? 0.72 + 0.28 * (Math.sin(this.uniforms.uTime.value * 0.11) * 0.5 + 0.5)
        : 1;
      this.uniforms.uIntensity.value = this.cfg.baseIntensity * this.cfg.bloom * stormPulse;

      if (this.inertia.size) {
        for (const [id, vel] of this.inertia) {
          const p = this.panels.get(id);
          if (!p || p.pinned || p.snap) {
            this.inertia.delete(id);
            continue;
          }
          p.anchor.addScaledVector(vel, dt);
          vel.multiplyScalar(Math.exp(-dt * 2.6));
          if (vel.lengthSq() < 25) this.inertia.delete(id);
        }
      }

      if (this.cfg.starTwinkle > 0) {
        const t = this.uniforms.uTime.value;
        const osc = Math.sin(t * 1.7) * 0.6 + Math.sin(t * 4.3) * 0.4;
        this.uniforms.uStars.value = Math.max(
          0,
          Math.min(1, this.baseStars + osc * 0.15 * this.cfg.starTwinkle)
        );
      } else if (this.uniforms.uStars.value !== this.baseStars) {
        this.uniforms.uStars.value = this.baseStars;
      }

      this.stepMeteors(dt);

      // Eased toward its target rather than snapped, the same reasoning as the
      // camera's own smoothing just above: engaging warp should read as a
      // spool-up, not a cut.
      const warpTarget = this.cfg.warp ? 1 : 0;
      this.warpCurrent += (warpTarget - this.warpCurrent) * (1 - Math.exp(-dt * 2.2));
      if (Math.abs(this.warpCurrent - warpTarget) < 0.001) this.warpCurrent = warpTarget;
      this.stepWarpField(dt);

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
      const x = (this.tmpNdc.x * 0.5 + 0.5) * w;
      const y = (-this.tmpNdc.y * 0.5 + 0.5) * h;
      // Transform-only, for the same reason panels are — see projectPanels.
      a.el.style.transform =
        `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)` +
        ` translate(-50%, -50%) scale(${scale.toFixed(3)})`;
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

  /**
   * Place every panel's DOM at the screen projection of its 3D anchor.
   *
   * Position goes through `transform` rather than `left`/`top`. Writing those
   * every frame for every panel forces a layout pass per panel per frame — with
   * a 14px backdrop-filter behind each one, which is the expensive case. A
   * transform is composited, so the whole overlay stops touching layout at all.
   */
  private projectPanels(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const camPos = this.camera.position;

    for (const p of this.panels.values()) {
      if (p.snap) {
        const r = this.snapRect(p.snap);
        p.sx = r.x + r.w / 2;
        p.sy = r.y + r.h / 2;
        p.scale = 1;
        p.onScreen = true;
        p.el.style.display = "";
        p.el.style.width = `${r.w}px`;
        if (!p.minimized) p.el.style.height = `${r.h}px`;
        this.place(p, p.sx, p.sy, 1);
        p.el.style.zIndex = `${Z_SNAPPED + this.focusBump(p)}`;
        p.el.style.setProperty("--vs-depth-fade", "1");
        continue;
      }

      if (p.pinned) {
        p.sx = p.pinX;
        p.sy = p.pinY;
        p.scale = 1;
        p.onScreen = true;
        p.el.style.display = "";
        this.place(p, p.pinX, p.pinY, 1);
        p.el.style.zIndex = `${Z_PINNED + this.focusBump(p)}`;
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
      p.scale = scale;
      p.onScreen =
        Math.abs(this.tmpNdc.x) <= 1.08 && Math.abs(this.tmpNdc.y) <= 1.08;

      this.place(p, x, y, scale);

      // Stack by real depth so a near panel always occludes a far one, then let
      // focus lift the active window inside that band — clicking a window has
      // to be able to raise it, which distance alone could never express.
      p.el.style.zIndex = `${
        Z_FLOATING + Math.max(0, Math.round(100000 - dist)) + this.focusBump(p)
      }`;
      // Set as a custom property, not inline opacity: the materialize/dissolve
      // class rules are more specific and so still win during those animations.
      const fade =
        1 - Math.min(this.cfg.fade, Math.max(0, (dist - FADE_START) / FADE_RANGE));
      p.el.style.setProperty("--vs-depth-fade", fade.toFixed(3));
    }
  }

  /** One transform write per panel per frame — no layout, no reflow. */
  private place(p: PanelEntry, x: number, y: number, scale: number): void {
    p.el.style.transform =
      `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)` +
      ` translate(-50%, -50%) scale(${scale.toFixed(3)})`;
  }

  private focusBump(p: PanelEntry): number {
    return p.id === this.activeId ? Z_FOCUS_BUMP : 0;
  }

  /**
   * Draw the light-threads between linked windows. This is what makes a
   * dashboard legible as one object instead of four coincidental windows.
   *
   * The drawing itself lives in `TetherLayer`, which knows nothing about 3D —
   * it takes screen positions and group state. All this does is reduce the
   * world to that. The compositor grew its own thinner copy of this while the
   * real layer sat unimported, which is why the threads had no click target
   * and no loose/hard distinction despite both being written and documented.
   */
  private drawTethers(): void {
    if (!this.cfg.tethers) return;

    const pulse = this.cfg.linkPulse
      ? 0.78 + 0.22 * (Math.sin(this.uniforms.uTime.value * 1.3) * 0.5 + 0.5)
      : 1;

    this.tethers.draw(
      [...this.groups.values()].map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        rigid: g.rigid,
        points: [...g.members]
          .map((m) => this.panels.get(m))
          .filter((p): p is PanelEntry => Boolean(p) && p!.el.style.display !== "none")
          .map((p) => ({ sx: p.sx, sy: p.sy })),
      })),
      {
        opacity: this.cfg.linkOpacity * pulse,
        width: this.cfg.linkWidth,
        glow: this.cfg.linkGlow * this.cfg.bloom,
        labels: this.cfg.linkLabels,
      }
    );
  }

  /** Colour and firmness are properties of the bond, so they live on the group. */
  private setGroupColor(groupId: string | null, color: string): void {
    const g = groupId ? this.groups.get(groupId) : null;
    if (!g) return;
    g.color = color;
    for (const m of g.members) {
      this.panels.get(m)?.el.style.setProperty("--vs-group", color);
    }
  }

  private setGroupRigid(groupId: string | null, rigid: boolean): void {
    const g = groupId ? this.groups.get(groupId) : null;
    if (!g) return;
    g.rigid = rigid;
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
      if (p.pinned || p.snap || claimed.has(p.id)) continue;
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
    let pendingSnap: SnapMode | null = null;
    const start = new THREE.Vector3();
    const others: { p: PanelEntry; base: THREE.Vector3 }[] = [];
    // Thrown-window momentum: the anchor's own velocity, resampled on every
    // move so whatever it reads at release is the speed of the actual flick.
    let lastMoveTime = 0;
    const lastAnchor = new THREE.Vector3();
    const velocity = new THREE.Vector3();

    bar.addEventListener("pointerdown", (e) => {
      if (tools.contains(e.target as Node) || link.contains(e.target as Node)) return;
      const p = this.panels.get(id);
      if (!p) return;
      this.setActive(id);
      pendingSnap = null;
      this.inertia.delete(id);
      lastMoveTime = performance.now();
      lastAnchor.copy(p.anchor);
      velocity.set(0, 0, 0);

      // Tearing a snapped window off its region. It comes back to its floating
      // size straight under the cursor, rather than leaping to wherever it used
      // to live — you asked for it *here*.
      if (p.snap) {
        this.unsnap(p);
        this.anchorFromScreen(p.anchor, e.clientX, e.clientY, REST_DEPTH);
        dist = REST_DEPTH;
        grabX = 0;
        grabY = 0;
        start.copy(p.anchor);
        others.length = 0;
        dragging = true;
        bar.setPointerCapture(e.pointerId);
        p.el.classList.add("dragging");
        e.preventDefault();
        e.stopPropagation();
        return;
      }

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
            if (!other || other.pinned || other.snap) continue;
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

      // Shove a window against an edge of the screen and it offers to fill it.
      // Only offered for lone, unshaped windows: a constellation travels as one
      // object and snapping one member would silently tear it out of its group,
      // and a shaped window has no rectangle to fill — offering a preview of a
      // snap that setSnap will refuse is a promise the release cannot keep.
      pendingSnap =
        p.groupId || p.form !== PLAIN ? null : this.edgeSnapAt(e.clientX, e.clientY);
      this.showSnapGhost(pendingSnap);

      if (p.pinned) {
        p.pinX = e.clientX - grabX;
        p.pinY = e.clientY - grabY;
        return;
      }
      this.anchorFromScreen(p.anchor, e.clientX - grabX, e.clientY - grabY, dist);

      const now = performance.now();
      const dt = (now - lastMoveTime) / 1000;
      if (dt > 0.001) {
        velocity.subVectors(p.anchor, lastAnchor).multiplyScalar(1 / dt);
        lastAnchor.copy(p.anchor);
        lastMoveTime = now;
      }

      if (!others.length) return;

      // Per-constellation now: `linkOrbit` only seeds the default for new ones.
      if (!this.groups.get(p.groupId!)?.rigid) {
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
      const p = this.panels.get(id);
      p?.el.classList.remove("dragging");
      this.showSnapGhost(null);
      if (p && pendingSnap) {
        this.setSnap(p, pendingSnap);
      } else if (p && !p.pinned && this.cfg.inertia && velocity.lengthSq() > 2500) {
        velocity.clampLength(0, 6000);
        this.inertia.set(id, velocity.clone());
      }
      pendingSnap = null;
    };
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
  }

  /** Which region, if any, a title-bar drag ending here is asking to fill. */
  private edgeSnapAt(x: number, y: number): SnapMode | null {
    if (y <= SNAP_EDGE) return "full";
    if (x <= SNAP_EDGE) return "left";
    if (x >= window.innerWidth - SNAP_EDGE) return "right";
    return null;
  }

  /**
   * The outline that says where a window is about to land. Without it, snapping
   * is a surprise that happens on release — the preview is what turns it into a
   * thing you chose.
   */
  private showSnapGhost(mode: SnapMode | null): void {
    if (!mode) {
      this.snapGhost.classList.remove("live");
      return;
    }
    const r = this.snapRect(mode);
    this.snapGhost.style.transform = `translate3d(${r.x}px, ${r.y}px, 0)`;
    this.snapGhost.style.width = `${r.w}px`;
    this.snapGhost.style.height = `${r.h}px`;
    this.snapGhost.classList.add("live");
  }

  /**
   * The link handle. Drag it out and a live thread follows the cursor: drop on
   * another window to fuse them into a constellation, drop on a celestial body
   * to merge the window onto it, drop on a singularity to let it be eaten.
   */
  private bindLinkDrag(id: string, handle: HTMLElement): void {
    let active = false;
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
      this.tethers.beginLive();
      document.body.classList.add("vs-linking");
      e.preventDefault();
      e.stopPropagation();
    });

    handle.addEventListener("pointermove", (e) => {
      if (!active) return;
      const p = this.panels.get(id);
      if (!p) return;
      this.tethers.updateLive(p.sx, p.sy, e.clientX, e.clientY);

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
      this.tethers.endLive();
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

  /**
   * Drag-to-resize, in screen pixels corrected for the panel's distance scale.
   *
   * `axis` picks which edges move. All eight exist because a panel that is the
   * right width but the wrong height is the common case, and a corner-only grip
   * makes you fight whichever dimension was already correct.
   *
   * The subtle part is that a panel is *centred* on its anchor — it is drawn
   * with `translate(-50%, -50%)` about a projected point. So growing it moves
   * both edges outward by half the change, and simply writing the new width
   * made the grip travel at half the speed of the cursor and dragged the
   * opposite edge along with it. Every resize therefore also walks the anchor
   * half a delta the other way, which is what pins the edge you *aren't*
   * holding and lets the one you are holding track the pointer exactly.
   */
  private bindResize(id: string, grip: HTMLElement, axis: ResizeAxis): void {
    const movesX = axis.includes("e") || axis.includes("w");
    const movesY = axis.includes("n") || axis.includes("s");
    const signX = axis.includes("w") ? -1 : 1;
    const signY = axis.includes("n") ? -1 : 1;

    let active = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let startCX = 0;
    let startCY = 0;
    let dist = 0;
    let scale = 1;

    grip.addEventListener("pointerdown", (e) => {
      const p = this.panels.get(id);
      if (!p) return;
      active = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = p.width;
      startH = p.height;
      startCX = p.sx;
      startCY = p.sy;
      scale = Math.max(0.2, p.scale);
      // From where the panel actually *is*, which for a merged panel is its
      // body's position rather than its own (stale) anchor.
      dist = this.worldOf(p, this.tmpWorld).distanceTo(this.camera.position);
      this.setActive(id);
      grip.setPointerCapture(e.pointerId);
      p.el.classList.add("resizing");
      e.preventDefault();
      e.stopPropagation();
    });

    grip.addEventListener("pointermove", (e) => {
      if (!active) return;
      const p = this.panels.get(id);
      if (!p) return;

      // A snapped window is the size of its region by definition; resizing one
      // is a request to go back to being a window you can size.
      if (p.snap) this.unsnap(p);

      let cx = startCX;
      let cy = startCY;

      if (movesX) {
        const want = startW + (signX * (e.clientX - startX)) / scale;
        p.width = Math.max(MIN_PANEL_W, Math.round(want));
        p.el.style.width = `${p.width}px`;
        cx = startCX + (signX * (p.width - startW) * scale) / 2;
      }
      if (movesY) {
        const want = startH + (signY * (e.clientY - startY)) / scale;
        p.height = Math.max(MIN_PANEL_H, Math.round(want));
        if (!p.minimized) p.el.style.height = `${p.height}px`;
        cy = startCY + (signY * (p.height - startH) * scale) / 2;
      }

      // Walk the panel to the new centre so the opposite edge stays put. A
      // merged panel is positioned by its offset from a body, so that is the
      // thing to move — writing its anchor would have no visible effect.
      if (p.pinned) {
        p.pinX = cx;
        p.pinY = cy;
      } else if (p.bodyId) {
        const body = this.bodies.get(p.bodyId);
        if (body) {
          this.anchorFromScreen(this.tmpWorld, cx, cy, dist);
          p.offset.copy(this.tmpWorld).sub(body.position);
        }
      } else {
        this.anchorFromScreen(p.anchor, cx, cy, dist);
      }
    });

    const end = (e: PointerEvent) => {
      if (!active) return;
      active = false;
      grip.releasePointerCapture(e.pointerId);
      this.panels.get(id)?.el.classList.remove("resizing");
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }

  /**
   * Ctrl/⌘ + scroll over a panel pushes it deeper into the void or pulls it
   * closer. A bare wheel is left alone so panel content always scrolls the way
   * it looks like it should.
   */
  private bindPanelDepth(id: string, panel: HTMLElement): void {
    panel.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;

        const p = this.panels.get(id);
        // Snapped windows have no depth to push into.
        if (!p || p.pinned || p.snap) return;

        // Claim the gesture from the browser's own ctrl+wheel page zoom.
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
    let downX = 0;
    let downY = 0;
    let downTime = 0;
    el.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      downX = e.clientX;
      downY = e.clientY;
      downTime = performance.now();
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
    const end = (e: PointerEvent) => {
      this.dragging = false;
      // A tap rather than a drag: nothing moved, nothing took long. Click in
      // open space and the void should still acknowledge you touched it.
      if (
        this.cfg.clickEcho &&
        Math.hypot(e.clientX - downX, e.clientY - downY) < 6 &&
        performance.now() - downTime < 400
      ) {
        this.spawnClickEcho(e.clientX, e.clientY);
      }
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }

  private spawnClickEcho(x: number, y: number): void {
    const ring = document.createElement("div");
    ring.className = "vs-click-echo";
    ring.style.left = `${x.toFixed(1)}px`;
    ring.style.top = `${y.toFixed(1)}px`;
    this.overlay.appendChild(ring);
    ring.addEventListener("animationend", () => ring.remove(), { once: true });
    // Belt and braces: a backgrounded tab can drop the animationend entirely.
    setTimeout(() => ring.remove(), 900);
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
    // Unlike the nebula and the dust, meteors are created continuously over
    // the life of a session rather than once at boot — leaving them for the
    // GC would leak a Line and a Material every few seconds a shower runs.
    for (const m of this.meteors) {
      this.scene.remove(m.obj);
      m.geo.dispose();
      m.mat.dispose();
    }
    this.meteors = [];
    this.compass?.dispose();
    this.renderer.dispose();
  }
}

/* ---------------------------------------------------------------- */

/** A uniformly random point on the unit sphere — the standard z-symmetric trick. */
function randomUnitVector(): [number, number, number] {
  const u = Math.random() * 2 - 1;
  const th = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - u * u);
  return [r * Math.cos(th), u, r * Math.sin(th)];
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
