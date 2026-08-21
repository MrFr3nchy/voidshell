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
import { PLAIN, applyForm, clearForm, defaultFormFor, formById, isFormId } from "./surfaceForms";
import { TetherLayer } from "./tethers";

/**
 * The flat render backend.
 *
 * The README has claimed since the first commit that the renderer is a plugin
 * and that swapping it is one line. That claim was unfalsifiable while there
 * was exactly one compositor: an interface with a single implementation is a
 * description of that implementation, however carefully it was written. This
 * is the second one, and writing it is the only way to find out whether the
 * seam was real.
 *
 * It mostly was. Everything below reuses `createPanelChrome`, `panelMenuItems`,
 * `TetherLayer`, `Compass`, the window shapes and the shared context menu
 * without changing any of them — those files were already written to know
 * nothing about 3D, and it turns out they meant it. What had to move was one
 * four-line function (`closeSurfaceById`) that was private to the Three
 * backend, and nothing else.
 *
 * ## The model
 *
 * An infinite *plane* rather than an infinite sphere: same idea, one dimension
 * fewer. A window has a position on the plane, the view has a pan offset and a
 * zoom, and dragging the background moves you over it. Everything the spatial
 * model buys you survives the flattening — windows have places, you can lose
 * one, and the compass points at whatever has drifted off the edge.
 *
 * Depth becomes stacking. `nudge` still reads "pull closer" and "push away" in
 * the shared window menu, and on a plane that is what raising and lowering a
 * window through the stack means. Celestial bodies do not survive: there is no
 * honest flat analogue of a window riding a moon's orbit, so `spawnBody`
 * returns `""` and the kernel's callers already treat that as "unsupported"
 * rather than crashing.
 *
 * ## Why it earns its place
 *
 * Not as a proof. A void that needs WebGL is a void that is blank on a locked
 * down laptop, in a VM with no GPU passthrough, over a remote desktop, on the
 * long tail of Android that blocklists the driver, and in every headless
 * browser — and "install a different OS shell" is not an answer anybody takes.
 * This one draws a gradient and some divs. It also stops moving when you do:
 * a panel's transform is only rewritten when its projected position actually
 * changed, which on a still plane is never, so an idle void costs nothing.
 */

/** Which half of the screen a window has stopped floating in. */
type SnapMode = "full" | "left" | "right";

/** Viewport insets for a snapped window: clear of the status bar, and framed. */
const SNAP_INSET = { top: 52, right: 16, bottom: 16, left: 16 };

/** How close to an edge a title-bar drag must get before it offers to snap. */
const SNAP_EDGE = 26;

/**
 * Stacking bands, matching the Three backend's so the two feel the same.
 * Pinned above snapped above floating, and the focused window above its peers.
 */
const Z_FLOATING = 0;
const Z_SNAPPED = 500_000;
const Z_PINNED = 1_000_000;
const Z_FOCUS_BUMP = 150_000;

/** How far a window may be pushed or pulled through the stack. */
const ORDER_STEP = 1;

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.6;

/** Nothing smaller than this is a usable window, whatever the grip says. */
const MIN_W = 220;
const MIN_H = 120;

interface FlatPanel {
  id: string;
  title: string;
  el: HTMLElement;
  titleEl: HTMLElement;
  /** Centre of the window in plane coordinates, in CSS pixels. */
  x: number;
  y: number;
  /**
   * Carried, never used for position.
   *
   * A session written by the Three backend has three meaningful numbers per
   * window, and a plane has room for two. Dropping the third would mean that
   * opening the shell flat once silently flattened every saved layout — so it
   * rides along and goes back out through `snapshot` exactly as it came in.
   */
  z: number;
  width: number;
  height: number;
  pinned: boolean;
  pinX: number;
  pinY: number;
  minimized: boolean;
  form: string;
  snap: SnapMode | null;
  /** The floating box to come back to when a snapped window is released. */
  restore: { x: number; y: number; width: number; height: number } | null;
  groupId: string | null;
  /** Position within the floating band; what "pull closer" moves. */
  order: number;
  /** Last projected screen centre, for tethers, the compass, and dirty checks. */
  sx: number;
  sy: number;
  /** The transform string last written, so an unchanged frame writes nothing. */
  painted: string;
}

interface GroupEntry {
  id: string;
  name: string;
  members: Set<string>;
  color: string;
  rigid: boolean;
}

interface AnchorEntry {
  el: HTMLElement;
  anchor: Vec3;
  painted: string;
}

export class DomCompositor implements Compositor {
  readonly name = "dom-flat";

  private overlay!: HTMLElement;
  private ground!: HTMLElement;
  private grid!: HTMLElement;
  private compass!: Compass;
  private tethers!: TetherLayer;
  private snapGhost!: HTMLElement;

  private panels = new Map<string, FlatPanel>();
  private groups = new Map<string, GroupEntry>();
  private anchors = new Set<AnchorEntry>();
  private groupCounter = 0;
  private orderCounter = 0;
  private activeId: string | null = null;
  private spawnHint: { x: number; y: number } | null = null;
  /** Positions held while the overview is up, so leaving it restores them. */
  private exposed: Map<string, { x: number; y: number }> | null = null;

  /** The view: where on the plane the centre of the screen is, and how close. */
  private panX = 0;
  private panY = 0;
  private zoom = 1;
  /** Eased toward the values above, so panning has weight rather than snapping. */
  private viewX = 0;
  private viewY = 0;
  private viewZoom = 1;

  private raf = 0;
  private fps = 60;
  private lastFrame = 0;

  private cfg = {
    /** Multiplies pointer travel when dragging the ground. */
    sensitivity: 1,
    /** 0 is instant, 1 never arrives. Same knob the Three backend exposes. */
    smoothing: 0.18,
    compass: true,
    tethers: true,
    grid: true,
    linkOpacity: 0.5,
    linkWidth: 1.2,
    linkGlow: 6,
    linkLabels: true,
    linkAutoTidy: true,
  };

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  init(mounts: { gl: HTMLElement; overlay: HTMLElement; hud: HTMLElement }): void {
    this.overlay = mounts.overlay;

    // `gl` is the mount the Three backend puts its canvas in. Nothing about
    // the name obliges a compositor to put WebGL there, and reusing it is what
    // keeps the swap to one line — the shell hands over the same three
    // elements and does not ask what happened to them.
    this.ground = document.createElement("div");
    this.ground.className = "vs-flat-ground";
    this.grid = document.createElement("div");
    this.grid.className = "vs-flat-grid";
    this.ground.appendChild(this.grid);
    mounts.gl.appendChild(this.ground);

    // Under the panels, so a thread never eats a click. The threads are also
    // controls: clicking one hardens or loosens that bond.
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

    this.bindGround();
    window.addEventListener("resize", this.onResize);
  }

  private onResize = (): void => {
    // Snapped windows are measured against the viewport, so they are the only
    // thing a resize actually invalidates. Everything else is projected from
    // the plane each frame and lands in the right place on its own.
    for (const p of this.panels.values()) if (p.snap) this.setSnap(p, p.snap);
  };

  start(): void {
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = this.lastFrame ? (now - this.lastFrame) / 1000 : 1 / 60;
      this.lastFrame = now;
      if (dt > 0) this.fps += ((1 / dt) - this.fps) * 0.1;

      // Ease the view toward where the input put it. `1 - smoothing` per frame
      // is frame-rate dependent, which is the same approximation the Three
      // backend makes and is imperceptible between 60 and 144Hz.
      const k = 1 - Math.pow(this.cfg.smoothing, Math.max(dt, 0.001) * 60);
      this.viewX += (this.panX - this.viewX) * k;
      this.viewY += (this.panY - this.viewY) * k;
      this.viewZoom += (this.zoom - this.viewZoom) * k;

      this.paintGround();
      this.projectPanels();
      this.projectAnchors();
      this.drawTethers();
      this.updateCompass();
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    for (const a of this.anchors) a.el.remove();
    this.anchors.clear();
    this.compass?.dispose();
    this.tethers?.clear();
    this.ground?.remove();
    this.snapGhost?.remove();
  }

  /* ------------------------------------------------------------------ */
  /* Projection                                                          */
  /* ------------------------------------------------------------------ */

  /** Plane point -> screen point, under the current pan and zoom. */
  private toScreen(x: number, y: number): { sx: number; sy: number } {
    return {
      sx: (x - this.viewX) * this.viewZoom + window.innerWidth / 2,
      sy: (y - this.viewY) * this.viewZoom + window.innerHeight / 2,
    };
  }

  /** Screen point -> plane point. The inverse, and the one drags need. */
  private toPlane(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - window.innerWidth / 2) / this.viewZoom + this.viewX,
      y: (sy - window.innerHeight / 2) / this.viewZoom + this.viewY,
    };
  }

  private paintGround(): void {
    if (!this.cfg.grid) return;
    // The grid is a repeating background, so panning it is a background-position
    // offset rather than a transform on an enormous element. It moves at 40% of
    // the plane's rate: enough parallax to make the motion legible, little
    // enough that it never competes with the windows.
    const x = (-this.viewX * this.viewZoom * 0.4).toFixed(1);
    const y = (-this.viewY * this.viewZoom * 0.4).toFixed(1);
    const size = (72 * this.viewZoom).toFixed(2);
    this.grid.style.backgroundSize = `${size}px ${size}px`;
    this.grid.style.backgroundPosition = `${x}px ${y}px`;
  }

  private projectPanels(): void {
    const zoom = this.viewZoom;
    for (const p of this.panels.values()) {
      let sx: number;
      let sy: number;
      let scale: number;

      if (p.pinned || p.snap) {
        // Out of the world: measured in screen pixels and unaffected by the
        // view. A pinned window that drifted when you panned would not be
        // pinned to anything.
        sx = p.pinX;
        sy = p.pinY;
        scale = 1;
      } else {
        const s = this.toScreen(p.x, p.y);
        sx = s.sx;
        sy = s.sy;
        scale = zoom;
      }

      p.sx = sx;
      p.sy = sy;
      p.el.style.zIndex = String(this.zIndexOf(p));

      const transform =
        `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)` +
        ` translate(-50%, -50%) scale(${scale.toFixed(3)})`;

      // The whole reason this backend is cheap. A still plane recomputes the
      // same string every frame and writes none of them, so an idle void does
      // no style work at all — which is not true of a compositor that must
      // redraw a shader whether or not anything moved.
      if (transform !== p.painted) {
        p.painted = transform;
        p.el.style.transform = transform;
      }

      // Off the edge is not off the plane: the compass will point at it.
      const half = (p.width * scale) / 2;
      const onScreen =
        sx > -half && sx < window.innerWidth + half && sy > -80 && sy < window.innerHeight + 80;
      p.el.classList.toggle("offscreen", !onScreen);
    }
  }

  private zIndexOf(p: FlatPanel): number {
    const band = p.pinned ? Z_PINNED : p.snap ? Z_SNAPPED : Z_FLOATING;
    const bump = p.id === this.activeId ? Z_FOCUS_BUMP : 0;
    return band + bump + p.order;
  }

  private projectAnchors(): void {
    for (const a of this.anchors) {
      const { sx, sy } = this.toScreen(a.anchor.x, a.anchor.y);
      const transform =
        `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)` +
        ` translate(-50%, -50%) scale(${this.viewZoom.toFixed(3)})`;
      if (transform !== a.painted) {
        a.painted = transform;
        a.el.style.transform = transform;
      }
    }
  }

  private drawTethers(): void {
    if (!this.cfg.tethers) {
      this.tethers.draw([], this.tetherStyle());
      return;
    }
    this.tethers.draw(
      [...this.groups.values()].map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        rigid: g.rigid,
        points: [...g.members]
          .map((id) => this.panels.get(id))
          .filter((p): p is FlatPanel => Boolean(p))
          .map((p) => ({ sx: p.sx, sy: p.sy })),
      })),
      this.tetherStyle()
    );
  }

  private tetherStyle() {
    return {
      opacity: this.cfg.linkOpacity,
      width: this.cfg.linkWidth,
      glow: this.cfg.linkGlow,
      labels: this.cfg.linkLabels,
    };
  }

  /**
   * Chevrons for everything that has drifted off the edge.
   *
   * The bearing is a plain screen-space angle from the centre of the viewport,
   * which is the thing the Three backend needed a matrix and a behind-the-camera
   * correction to work out. On a plane nothing can be behind you, so `behind`
   * is always false and the marker never has to apologise for pointing the
   * wrong way.
   */
  private updateCompass(): void {
    if (!this.cfg.compass) return;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const items: CompassItem[] = [];
    const claimed = new Set<string>();

    const bearing = (sx: number, sy: number): CompassItem["angle"] | null => {
      const dx = sx - cx;
      const dy = sy - cy;
      // Comfortably inside the viewport is not lost, so it gets no marker.
      if (Math.abs(dx) < cx - 40 && Math.abs(dy) < cy - 40) return null;
      return Math.atan2(-dy, dx);
    };

    for (const g of this.groups.values()) {
      for (const m of g.members) claimed.add(m);
      const centre = this.groupCentre(g);
      if (!centre) continue;
      const { sx, sy } = this.toScreen(centre.x, centre.y);
      const angle = bearing(sx, sy);
      if (angle === null) continue;
      items.push({
        id: g.id,
        kind: "group",
        label: g.name,
        angle,
        dist: Math.hypot(centre.x - this.viewX, centre.y - this.viewY),
        behind: false,
      });
    }

    for (const p of this.panels.values()) {
      if (p.pinned || p.snap || claimed.has(p.id)) continue;
      const angle = bearing(p.sx, p.sy);
      if (angle === null) continue;
      items.push({
        id: p.id,
        kind: "surface",
        label: p.title,
        angle,
        dist: Math.hypot(p.x - this.viewX, p.y - this.viewY),
        behind: false,
      });
    }

    this.compass.sync(items);
  }

  /* ------------------------------------------------------------------ */
  /* Surfaces                                                            */
  /* ------------------------------------------------------------------ */

  mountSurface(surface: Surface): () => void {
    const { panel, bar, title, tools, link, grips, more, pin, min, max, close } =
      createPanelChrome(surface);
    this.overlay.appendChild(panel);

    // Where the user asked (drag-from-drawer), or near the middle of the view
    // with enough jitter that a second window does not land exactly on the
    // first one.
    let x: number;
    let y: number;
    if (this.spawnHint) {
      const at = this.toPlane(this.spawnHint.x, this.spawnHint.y);
      x = at.x;
      y = at.y;
      this.spawnHint = null;
    } else {
      x = this.panX + (Math.random() - 0.5) * 260;
      y = this.panY + (Math.random() - 0.5) * 180;
    }

    const entry: FlatPanel = {
      id: surface.id,
      title: surface.title,
      el: panel,
      titleEl: title,
      x,
      y,
      z: 0,
      width: surface.width,
      height: surface.height,
      pinned: false,
      pinX: 0,
      pinY: 0,
      minimized: false,
      form: PLAIN,
      snap: null,
      restore: null,
      groupId: null,
      order: ++this.orderCounter,
      sx: 0,
      sy: 0,
      painted: "",
    };
    this.panels.set(surface.id, entry);

    // A module can suggest the shape it opens as. Only a starting point: from
    // here the window owns it, and session restore overwrites it.
    this.setSurfaceForm(surface.id, defaultFormFor(surface.moduleId));

    this.bindPanelDrag(surface.id, bar, tools, link);
    this.bindPanelStack(surface.id, panel);
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

    bar.addEventListener("dblclick", (e) => {
      if (tools.contains(e.target as Node) || link.contains(e.target as Node)) return;
      this.toggleSnap(surface.id, "full");
    });

    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      this.openPanelMenu(surface.id, r.left, r.bottom + 4);
    });
    bar.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openPanelMenu(surface.id, e.clientX, e.clientY);
    });

    // A shaped window has no title bar to aim at — the silhouette is drawn over
    // it — so right-clicking the object itself has to reach the same menu, or a
    // shape you cannot see past is a window you cannot get back.
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

  retitleSurface(id: string, title: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    p.title = title;
    p.titleEl.textContent = title;
    const close = p.el.querySelector(".vs-panel-close");
    close?.setAttribute("aria-label", `Dismiss ${title}`);
  }

  focusSurface(id: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    this.setActive(id);
    if (this.exposed) this.expose(false);
    // Un-collapse on focus: being sent a window you cannot read is worse than
    // not being sent it.
    if (p.minimized) this.toggleMinimize(id);
    this.lookAtSurface(id);
  }

  activeSurface(): string | null {
    return this.activeId;
  }

  private setActive(id: string): void {
    if (this.activeId === id) return;
    this.panels.get(this.activeId ?? "")?.el.classList.remove("focused");
    this.activeId = id;
    this.panels.get(id)?.el.classList.add("focused");
  }

  /* ------------------------------------------------------------------ */
  /* Window states                                                       */
  /* ------------------------------------------------------------------ */

  private togglePin(id: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    if (p.pinned) {
      p.pinned = false;
      p.el.classList.remove("pinned");
      // Come back to the plane where the window is on screen, not to wherever
      // it happened to be pinned from — the view has probably moved since.
      const at = this.toPlane(p.pinX, p.pinY);
      p.x = at.x;
      p.y = at.y;
      return;
    }
    if (p.snap) this.unsnap(p);
    p.pinned = true;
    p.pinX = p.sx || window.innerWidth / 2;
    p.pinY = p.sy || window.innerHeight / 2;
    p.el.classList.add("pinned");
  }

  private toggleMinimize(id: string): void {
    const p = this.panels.get(id);
    if (!p || p.form !== PLAIN) return;
    p.minimized = !p.minimized;
    p.el.classList.toggle("minimized", p.minimized);
    p.el.style.height = p.minimized ? "" : `${p.height}px`;
  }

  setSurfaceForm(id: string, formId: string): void {
    const p = this.panels.get(id);
    if (!p) return;
    if (formId !== PLAIN && !isFormId(formId)) return;

    if (formId === PLAIN) {
      p.form = PLAIN;
      clearForm(p.el);
      p.el.style.height = p.minimized ? "" : `${p.height}px`;
      return;
    }

    const form = formById(formId);
    if (!form) return;
    // A shape is an object, not a rectangle: there is nothing honest for a lava
    // lamp filling the left half of the screen to look like, and nothing to
    // collapse to once the silhouette covers the title bar.
    if (p.snap) this.unsnap(p);
    if (p.minimized) this.toggleMinimize(id);
    p.form = formId;
    applyForm(p.el, form, p.width);
  }

  surfaceForm(id: string): string {
    return this.panels.get(id)?.form ?? PLAIN;
  }

  private toggleSnap(id: string, mode: SnapMode): void {
    const p = this.panels.get(id);
    if (!p || p.form !== PLAIN) return;
    if (p.snap === mode) this.unsnap(p);
    else this.setSnap(p, mode);
  }

  private setSnap(p: FlatPanel, mode: SnapMode): void {
    // Captured once. Snapping left and then right must still remember the
    // floating box, not the left half.
    if (!p.snap) {
      p.restore = { x: p.x, y: p.y, width: p.width, height: p.height };
      if (p.pinned) {
        p.pinned = false;
        p.el.classList.remove("pinned");
      }
      if (p.minimized) this.toggleMinimize(p.id);
    }
    const r = this.snapRect(mode);
    p.snap = mode;
    p.width = r.width;
    p.height = r.height;
    p.pinX = r.cx;
    p.pinY = r.cy;
    p.el.style.width = `${r.width}px`;
    p.el.style.height = `${r.height}px`;
    p.el.classList.add("snapped");
  }

  private unsnap(p: FlatPanel): void {
    if (!p.snap) return;
    p.snap = null;
    p.el.classList.remove("snapped");
    if (p.restore) {
      p.x = p.restore.x;
      p.y = p.restore.y;
      p.width = p.restore.width;
      p.height = p.restore.height;
      p.el.style.width = `${p.width}px`;
      p.el.style.height = `${p.height}px`;
      p.restore = null;
    }
  }

  private snapRect(mode: SnapMode): { cx: number; cy: number; width: number; height: number } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const top = SNAP_INSET.top;
    const height = vh - top - SNAP_INSET.bottom;
    if (mode === "full") {
      const width = vw - SNAP_INSET.left - SNAP_INSET.right;
      return { cx: SNAP_INSET.left + width / 2, cy: top + height / 2, width, height };
    }
    const width = (vw - SNAP_INSET.left - SNAP_INSET.right - 12) / 2;
    const left = mode === "left" ? SNAP_INSET.left : SNAP_INSET.left + width + 12;
    return { cx: left + width / 2, cy: top + height / 2, width, height };
  }

  /** Raise or lower a window through the floating stack. */
  private nudgeStack(id: string, dir: number): void {
    const p = this.panels.get(id);
    if (!p || p.pinned || p.snap) return;
    if (dir < 0) {
      p.order = ++this.orderCounter;
    } else {
      const lowest = Math.min(...[...this.panels.values()].map((q) => q.order));
      p.order = lowest - ORDER_STEP;
    }
  }

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
          // Nothing to be in orbit around: this backend has no bodies, so the
          // entry that would release one never appears.
          merged: false,
          form: p.form,
          group: g ? { color: g.color, rigid: g.rigid } : null,
        },
        {
          togglePin: () => this.togglePin(id),
          toggleMinimize: () => this.toggleMinimize(id),
          toggleSnap: () => this.toggleSnap(id, "full"),
          snapLeft: () => this.toggleSnap(id, "left"),
          snapRight: () => this.toggleSnap(id, "right"),
          nudge: (dir) => this.nudgeStack(id, dir),
          release: () => {},
          setForm: (formId) => this.setSurfaceForm(id, formId),
          setRigid: (rigid) => this.setGroupRigid(p.groupId, rigid),
          setColor: (color) => this.setGroupColor(p.groupId, color),
          dissolve: () => p.groupId && this.unlinkGroup(p.groupId),
          close: () => closeSurfaceById(id),
        }
      )
    );
  }

  /* ------------------------------------------------------------------ */
  /* The view                                                            */
  /* ------------------------------------------------------------------ */

  lookAtSurface(id: string): void {
    const p = this.panels.get(id);
    if (!p || p.pinned || p.snap) return;
    this.panX = p.x;
    this.panY = p.y;
  }

  lookAtGroup(id: string): void {
    const g = this.groups.get(id);
    const centre = g && this.groupCentre(g);
    if (!centre) return;
    this.panX = centre.x;
    this.panY = centre.y;
  }

  /**
   * Back to where the windows are.
   *
   * The Three backend puts the camera back on its starting horizon, which is
   * the right answer for a rotation you got lost in. A plane has a different
   * failure: you panned somewhere empty, or a session written by the other
   * backend restored with 3D world coordinates that are hundreds of units from
   * the origin. Both are fixed by going to the middle of what is actually open,
   * and neither is fixed by going to (0, 0).
   */
  resetView(): void {
    const list = [...this.panels.values()].filter((p) => !p.pinned && !p.snap);
    this.zoom = 1;
    if (!list.length) {
      this.panX = 0;
      this.panY = 0;
      return;
    }
    this.panX = list.reduce((a, p) => a + p.x, 0) / list.length;
    this.panY = list.reduce((a, p) => a + p.y, 0) / list.length;
  }

  focalPoint(): Vec3 {
    return { x: this.panX, y: this.panY, z: 0 };
  }

  screenToWorld(x: number, y: number): Vec3 {
    const at = this.toPlane(x, y);
    return { x: at.x, y: at.y, z: 0 };
  }

  mountAnchored(el: HTMLElement, anchor: Vec3): AnchorHandle {
    el.classList.add("vs-anchored");
    this.overlay.appendChild(el);
    const entry: AnchorEntry = { el, anchor: { ...anchor }, painted: "" };
    this.anchors.add(entry);
    return {
      setAnchor: (p) => {
        entry.anchor = { ...p };
      },
      getAnchor: () => ({ ...entry.anchor }),
      dispose: () => {
        this.anchors.delete(entry);
        el.remove();
      },
    };
  }

  setSpawnHint(x: number, y: number): void {
    this.spawnHint = { x, y };
  }

  /* ------------------------------------------------------------------ */
  /* Celestial bodies: not in a flat world                               */
  /* ------------------------------------------------------------------ */

  /**
   * There is no flat analogue of a window riding a moon's orbit, and inventing
   * a dishonest one would be worse than declining. The empty string is what the
   * kernel's own contract calls "unsupported", and every caller already treats
   * it that way — so the launcher's merge gesture simply finds nothing to
   * merge onto rather than failing.
   */
  spawnBody(): string {
    return "";
  }

  destroyBody(): void {}

  attachSurface(): void {}

  listBodies(): { id: string; kind: BodyKind }[] {
    return [];
  }

  /* ------------------------------------------------------------------ */
  /* Constellations                                                      */
  /* ------------------------------------------------------------------ */

  linkSurfaces(ids: string[], name?: string, style?: GroupStyle): string {
    const members = ids.filter((id) => this.panels.has(id));
    if (members.length < 2) return "";

    // Joining a window that is already linked merges the two constellations
    // rather than making a second one that shares a member.
    const existing = new Set<string>();
    for (const id of members) {
      const g = this.panels.get(id)!.groupId;
      if (g) existing.add(g);
    }
    const all = new Set(members);
    for (const gid of existing) {
      const g = this.groups.get(gid);
      if (!g) continue;
      for (const m of g.members) all.add(m);
      this.groups.delete(gid);
      this.tethers.remove(gid);
    }

    const id = `grp-${++this.groupCounter}`;
    const group: GroupEntry = {
      id,
      name: name ?? `constellation ${this.groupCounter}`,
      members: all,
      color: style?.color ?? GROUP_COLORS[this.groupCounter % GROUP_COLORS.length],
      rigid: style?.rigid ?? false,
    };
    this.groups.set(id, group);
    for (const m of all) {
      const p = this.panels.get(m);
      if (p) p.groupId = id;
    }
    if (this.cfg.linkAutoTidy) this.tidyGroup(id);
    return id;
  }

  unlinkGroup(id: string): void {
    const g = this.groups.get(id);
    if (!g) return;
    for (const m of g.members) {
      const p = this.panels.get(m);
      if (p) p.groupId = null;
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

  /** Lay a constellation out in a ring around its own centre, so it reads as one object. */
  private tidyGroup(id: string): void {
    const g = this.groups.get(id);
    if (!g) return;
    const list = [...g.members]
      .map((m) => this.panels.get(m))
      .filter((p): p is FlatPanel => Boolean(p) && !p!.pinned && !p!.snap);
    if (list.length < 2) return;

    const cx = list.reduce((a, p) => a + p.x, 0) / list.length;
    const cy = list.reduce((a, p) => a + p.y, 0) / list.length;
    const radius = 150 + list.length * 55;
    list.forEach((p, i) => {
      const a = (i / list.length) * Math.PI * 2 - Math.PI / 2;
      p.x = cx + Math.cos(a) * radius;
      p.y = cy + Math.sin(a) * radius * 0.7;
    });
  }

  private groupCentre(g: GroupEntry): { x: number; y: number } | null {
    const list = [...g.members]
      .map((m) => this.panels.get(m))
      .filter((p): p is FlatPanel => Boolean(p) && !p!.pinned && !p!.snap);
    if (!list.length) return null;
    return {
      x: list.reduce((a, p) => a + p.x, 0) / list.length,
      y: list.reduce((a, p) => a + p.y, 0) / list.length,
    };
  }

  private setGroupColor(groupId: string | null, color: string): void {
    const g = groupId ? this.groups.get(groupId) : null;
    if (g) g.color = color;
  }

  private setGroupRigid(groupId: string | null, rigid: boolean): void {
    const g = groupId ? this.groups.get(groupId) : null;
    if (g) g.rigid = rigid;
  }

  /* ------------------------------------------------------------------ */
  /* Overview and arrangement                                            */
  /* ------------------------------------------------------------------ */

  expose(on?: boolean): boolean {
    const wasUp = Boolean(this.exposed);
    const want = on ?? !wasUp;
    if (want === wasUp) return wasUp;

    if (!want) {
      for (const [id, at] of this.exposed!) {
        const p = this.panels.get(id);
        if (p) {
          p.x = at.x;
          p.y = at.y;
        }
      }
      this.exposed = null;
      document.body.classList.remove("vs-exposed");
      return false;
    }

    const list = [...this.panels.values()].filter((p) => !p.pinned && !p.snap);
    if (!list.length) return false;

    this.exposed = new Map(list.map((p) => [p.id, { x: p.x, y: p.y }]));
    document.body.classList.add("vs-exposed");

    // A square-ish grid centred on the view, zoomed out until it fits. Being
    // able to *zoom* is what a plane has instead of stepping the camera back,
    // and it means the overview is exact rather than approximately far enough.
    const cols = Math.ceil(Math.sqrt(list.length));
    const rows = Math.ceil(list.length / cols);
    const cellW = 360;
    const cellH = 290;

    list.forEach((p, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      p.x = this.panX + (col - (cols - 1) / 2) * cellW;
      p.y = this.panY + (row - (rows - 1) / 2) * cellH;
    });

    const fit = Math.min(
      (window.innerWidth - 80) / (cols * cellW),
      (window.innerHeight - 140) / (rows * cellH)
    );
    this.zoom = Math.max(MIN_ZOOM, Math.min(1, fit));
    return true;
  }

  arrange(mode: ArrangeMode): void {
    const list = [...this.panels.values()].filter((p) => !p.pinned && !p.snap);
    const n = list.length;
    if (!n) return;

    const cx = this.panX;
    const cy = this.panY;

    if (mode === "ring") {
      const radius = 220 + n * 60;
      list.forEach((p, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        p.x = cx + Math.cos(a) * radius;
        p.y = cy + Math.sin(a) * radius * 0.62;
      });
      return;
    }

    if (mode === "scatter") {
      list.forEach((p) => {
        p.x = cx + (Math.random() - 0.5) * 1600;
        p.y = cy + (Math.random() - 0.5) * 1100;
      });
      return;
    }

    const cols = Math.min(n, 4);
    const rows = Math.ceil(n / cols);
    list.forEach((p, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const dx = (col - (cols - 1) / 2) * 400;
      const dy = (row - (rows - 1) / 2) * 320;
      p.x = cx + dx;
      // An arc is a wall with a sag in it. The Three backend gets its curve
      // from windows sitting on a sphere around the camera; here it has to be
      // drawn, and a parabola through the row is what that shape looks like
      // flattened.
      p.y = cy + dy + (mode === "arc" ? Math.pow(dx / 400, 2) * 46 : 0);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  placeSurface(id: string, place: SurfacePlacement): void {
    const p = this.panels.get(id);
    if (!p) return;
    p.x = place.anchor[0];
    p.y = place.anchor[1];
    p.z = place.anchor[2];
    p.width = place.width;
    p.height = place.height;
    p.el.style.width = `${place.width}px`;
    p.el.style.height = `${place.height}px`;
    // Before the states below: a shape refuses to be snapped or collapsed, and
    // the ones that survive have to be applied over it rather than under it.
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
    // Last, so the restore box it captures is the floating window just rebuilt.
    if (place.snap) this.setSnap(p, place.snap);
  }

  snapshot(): Record<string, SurfacePlacement> {
    const out: Record<string, SurfacePlacement> = {};
    for (const [id, p] of this.panels) {
      // A snapped window's own width and height are its region's, which would
      // become its floating size on the next boot. Its restore box is the one
      // worth writing down.
      const box = p.snap && p.restore ? p.restore : p;
      out[id] = {
        anchor: [box.x, box.y, p.z],
        width: box.width,
        height: box.height,
        pinned: p.pinned,
        pinX: p.pinX,
        pinY: p.pinY,
        snap: p.snap,
        minimized: p.minimized,
        form: p.form,
      };
    }
    return out;
  }

  stats(): CompositorStats {
    return {
      fps: Math.round(this.fps),
      panels: this.panels.size,
      bodies: 0,
      groups: this.groups.size,
    };
  }

  /* ------------------------------------------------------------------ */
  /* World tuning                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Take what applies and ignore the rest.
   *
   * Settings publishes one set of world knobs and does not know which backend
   * is listening, so roughly half of what arrives here is about a nebula that
   * does not exist. Silently dropping those is the correct behaviour and the
   * reason the method is `applyWorldPatch(patch)` rather than a typed struct:
   * a compositor honours what it can and is not obliged to explain the rest.
   */
  applyWorldPatch(patch: Record<string, unknown>): void {
    const num = (k: string) => (typeof patch[k] === "number" ? (patch[k] as number) : null);
    const bool = (k: string) => (typeof patch[k] === "boolean" ? (patch[k] as boolean) : null);

    const sens = num("sensitivity");
    if (sens !== null) this.cfg.sensitivity = sens;
    const smooth = num("smoothing");
    if (smooth !== null) this.cfg.smoothing = Math.max(0, Math.min(0.95, smooth));

    const compass = bool("compass");
    if (compass !== null) {
      this.cfg.compass = compass;
      this.compass.setEnabled(compass);
    }
    const tethers = bool("tethers");
    if (tethers !== null) this.cfg.tethers = tethers;

    // "dust" is a count of particles in a world with no particles. Read as a
    // yes/no about background texture, it is the nearest honest translation.
    const dust = num("dust");
    if (dust !== null) {
      this.cfg.grid = dust > 0;
      this.grid.style.opacity = dust > 0 ? "" : "0";
    }

    const opacity = num("linkOpacity");
    if (opacity !== null) this.cfg.linkOpacity = opacity;
    const width = num("linkWidth");
    if (width !== null) this.cfg.linkWidth = width;
    const glow = num("linkGlow");
    if (glow !== null) this.cfg.linkGlow = glow;
    const labels = bool("linkLabels");
    if (labels !== null) this.cfg.linkLabels = labels;
    const tidy = bool("linkAutoTidy");
    if (tidy !== null) this.cfg.linkAutoTidy = tidy;
  }

  /* ------------------------------------------------------------------ */
  /* Input                                                               */
  /* ------------------------------------------------------------------ */

  private bindGround(): void {
    let panning = false;
    let lastX = 0;
    let lastY = 0;

    this.ground.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.ground.setPointerCapture?.(e.pointerId);
      document.body.classList.add("vs-panning");
    });

    this.ground.addEventListener("pointermove", (e) => {
      if (!panning) return;
      // Divided by the zoom so a drag moves the plane under your finger by the
      // same screen distance however far out you are. Without it, panning while
      // zoomed out feels like the world has become heavy.
      this.panX -= ((e.clientX - lastX) * this.cfg.sensitivity) / this.zoom;
      this.panY -= ((e.clientY - lastY) * this.cfg.sensitivity) / this.zoom;
      lastX = e.clientX;
      lastY = e.clientY;
    });

    const stop = (e: PointerEvent) => {
      if (!panning) return;
      panning = false;
      this.ground.releasePointerCapture?.(e.pointerId);
      document.body.classList.remove("vs-panning");
    };
    this.ground.addEventListener("pointerup", stop);
    this.ground.addEventListener("pointercancel", stop);

    this.ground.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          // Zoom about the pointer, not the centre: zooming toward a corner and
          // watching it slide away is the single most disorienting thing a
          // pannable surface can do.
          const before = this.toPlane(e.clientX, e.clientY);
          const next = this.zoom * (e.deltaY > 0 ? 0.9 : 1.1);
          this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
          // Applied to the eased value too, or the correction is computed
          // against a zoom that has not arrived yet and the point drifts.
          this.viewZoom = this.zoom;
          const after = this.toPlane(e.clientX, e.clientY);
          this.panX += before.x - after.x;
          this.panY += before.y - after.y;
          this.viewX = this.panX;
          this.viewY = this.panY;
          return;
        }
        this.panX += e.deltaX / this.zoom;
        this.panY += e.deltaY / this.zoom;
      },
      { passive: false }
    );
  }

  private bindPanelDrag(
    id: string,
    bar: HTMLElement,
    tools: HTMLElement,
    link: HTMLElement
  ): void {
    let dragging = false;
    let grabX = 0;
    let grabY = 0;
    let snapTo: SnapMode | null = null;

    bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (tools.contains(e.target as Node) || link.contains(e.target as Node)) return;
      const p = this.panels.get(id);
      if (!p) return;
      dragging = true;
      this.setActive(id);
      // Grab offset in the coordinate space the window actually lives in, so
      // the pointer stays on the same pixel of the title bar for both a
      // floating window (plane space) and a pinned one (screen space).
      if (p.pinned || p.snap) {
        grabX = e.clientX - p.pinX;
        grabY = e.clientY - p.pinY;
      } else {
        const at = this.toPlane(e.clientX, e.clientY);
        grabX = at.x - p.x;
        grabY = at.y - p.y;
      }
      bar.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });

    bar.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const p = this.panels.get(id);
      if (!p) return;

      // Dragging a snapped window pulls it out, the way it does everywhere
      // else. Done before the move so it lands under the pointer rather than
      // jumping back to where it was snapped from.
      if (p.snap) {
        this.unsnap(p);
        const at = this.toPlane(e.clientX, e.clientY);
        grabX = 0;
        grabY = -p.height / 2 + 18;
        p.x = at.x;
        p.y = at.y;
      }

      if (p.pinned) {
        p.pinX = e.clientX - grabX;
        p.pinY = e.clientY - grabY;
      } else {
        const at = this.toPlane(e.clientX, e.clientY);
        p.x = at.x - grabX;
        p.y = at.y - grabY;
        // Constellations travel together. Flat, "rigid" and "loose" both come
        // out as translation — there is no camera to orbit about — so the two
        // still differ in what the thread looks like and in nothing else.
        this.dragGroupWith(p, at.x - grabX, at.y - grabY);
      }

      snapTo = p.form === PLAIN && !p.pinned ? this.edgeSnapAt(e.clientX, e.clientY) : null;
      this.showSnapGhost(snapTo);
    });

    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      bar.releasePointerCapture?.(e.pointerId);
      this.showSnapGhost(null);
      const p = this.panels.get(id);
      if (p && snapTo) this.setSnap(p, snapTo);
      snapTo = null;
    };
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
  }

  /** Move every other member of a dragged window's constellation with it. */
  private dragGroupWith(p: FlatPanel, nx: number, ny: number): void {
    if (!p.groupId) return;
    const g = this.groups.get(p.groupId);
    if (!g) return;
    const dx = nx - p.x;
    const dy = ny - p.y;
    if (!dx && !dy) return;
    for (const m of g.members) {
      if (m === p.id) continue;
      const q = this.panels.get(m);
      if (!q || q.pinned || q.snap) continue;
      q.x += dx;
      q.y += dy;
    }
  }

  private edgeSnapAt(x: number, y: number): SnapMode | null {
    if (y <= SNAP_EDGE) return "full";
    if (x <= SNAP_EDGE) return "left";
    if (x >= window.innerWidth - SNAP_EDGE) return "right";
    return null;
  }

  private showSnapGhost(mode: SnapMode | null): void {
    if (!mode) {
      this.snapGhost.classList.remove("up");
      return;
    }
    const r = this.snapRect(mode);
    this.snapGhost.style.width = `${r.width}px`;
    this.snapGhost.style.height = `${r.height}px`;
    this.snapGhost.style.transform =
      `translate3d(${r.cx.toFixed(0)}px, ${r.cy.toFixed(0)}px, 0) translate(-50%, -50%)`;
    this.snapGhost.classList.add("up");
  }

  /** Ctrl/cmd + scroll over a window raises or lowers it through the stack. */
  private bindPanelStack(id: string, panel: HTMLElement): void {
    panel.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        e.stopPropagation();
        this.nudgeStack(id, e.deltaY > 0 ? 1 : -1);
      },
      { passive: false }
    );
  }

  private bindLinkDrag(id: string, handle: HTMLElement): void {
    let dragging = false;

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      dragging = true;
      handle.setPointerCapture?.(e.pointerId);
      this.tethers.beginLive();
    });

    handle.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const p = this.panels.get(id);
      if (!p) return;
      this.tethers.updateLive(p.sx, p.sy, e.clientX, e.clientY);
      const hit = this.hitTest(e.clientX, e.clientY, id);
      for (const q of this.panels.values()) {
        q.el.classList.toggle("link-target", q.id === hit);
      }
    });

    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      handle.releasePointerCapture?.(e.pointerId);
      this.tethers.endLive();
      const hit = this.hitTest(e.clientX, e.clientY, id);
      for (const q of this.panels.values()) q.el.classList.remove("link-target");
      if (hit) this.linkSurfaces([id, hit]);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  /** Which other window is under this screen point, if any. */
  private hitTest(x: number, y: number, exclude: string): string | null {
    let best: string | null = null;
    let bestZ = -Infinity;
    for (const p of this.panels.values()) {
      if (p.id === exclude) continue;
      const r = p.el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const z = this.zIndexOf(p);
      if (z > bestZ) {
        bestZ = z;
        best = p.id;
      }
    }
    return best;
  }

  private bindResize(id: string, grip: HTMLElement, axis: ResizeAxis): void {
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let startPx = 0;
    let startPy = 0;

    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const p = this.panels.get(id);
      if (!p || p.form !== PLAIN) return;
      resizing = true;
      this.setActive(id);
      if (p.snap) this.unsnap(p);
      startX = e.clientX;
      startY = e.clientY;
      startW = p.width;
      startH = p.height;
      startPx = p.pinned ? p.pinX : p.x;
      startPy = p.pinned ? p.pinY : p.y;
      grip.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    });

    grip.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      const p = this.panels.get(id);
      if (!p) return;
      // A window is drawn from its centre, so growing from a west or north
      // grip has to move the centre by half of what the edge moved, or the
      // opposite edge walks across the screen as you drag.
      const scale = p.pinned ? 1 : this.viewZoom;
      const dx = (e.clientX - startX) / scale;
      const dy = (e.clientY - startY) / scale;

      let w = startW;
      let h = startH;
      let cx = startPx;
      let cy = startPy;

      if (axis.includes("e")) w = Math.max(MIN_W, startW + dx);
      if (axis.includes("w")) w = Math.max(MIN_W, startW - dx);
      if (axis.includes("s")) h = Math.max(MIN_H, startH + dy);
      if (axis.includes("n")) h = Math.max(MIN_H, startH - dy);

      if (axis.includes("e")) cx = startPx + (w - startW) / 2;
      if (axis.includes("w")) cx = startPx - (w - startW) / 2;
      if (axis.includes("s")) cy = startPy + (h - startH) / 2;
      if (axis.includes("n")) cy = startPy - (h - startH) / 2;

      p.width = w;
      p.height = h;
      p.el.style.width = `${w}px`;
      if (!p.minimized) p.el.style.height = `${h}px`;
      if (p.pinned) {
        p.pinX = cx;
        p.pinY = cy;
      } else {
        p.x = cx;
        p.y = cy;
      }
    });

    const end = (e: PointerEvent) => {
      if (!resizing) return;
      resizing = false;
      grip.releasePointerCapture?.(e.pointerId);
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  }
}
