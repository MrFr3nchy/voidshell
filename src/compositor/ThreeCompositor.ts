import * as THREE from "three";
import type { BodyKind, Compositor, Surface } from "../kernel/types";
import { nebulaFragment, nebulaVertex } from "../world/nebulaShader";

interface PanelEntry {
  el: HTMLElement;
  /** Own world anchor, used when the panel isn't merged onto a body. */
  anchor: THREE.Vector3;
  bodyId: string | null;
  /** World-space offset from a body when merged. */
  offset: THREE.Vector3;
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
  private bodies = new Map<string, BodyEntry>();
  private bodyCounter = 0;

  // Camera rig: look-around by drag + gentle autonomous drift.
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
    const close = document.createElement("button");
    close.className = "vs-panel-close";
    close.setAttribute("aria-label", `Dismiss ${surface.title}`);
    close.textContent = "\u2715";
    bar.append(title, close);

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
      .multiplyScalar(460)
      .add(
        new THREE.Vector3(
          (Math.random() - 0.5) * 160,
          (Math.random() - 0.5) * 120,
          (Math.random() - 0.5) * 80
        )
      );

    this.panels.set(surface.id, {
      el: panel,
      anchor,
      bodyId: null,
      offset: new THREE.Vector3(),
    });

    requestAnimationFrame(() => panel.classList.replace("materializing", "active"));

    close.addEventListener("click", () => {
      window.dispatchEvent(
        new CustomEvent("voidshell:close-surface", { detail: { id: surface.id } })
      );
    });

    return () => {
      this.panels.delete(surface.id);
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
  }

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

  start(): void {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const dt = this.clock.getDelta();
      this.uniforms.uTime.value += dt;

      this.targetYaw += dt * 0.015;
      this.yaw += (this.targetYaw - this.yaw) * 0.06;
      this.pitch += (this.targetPitch - this.pitch) * 0.06;
      this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");

      this.particles.rotation.y += dt * 0.01;

      for (const b of this.bodies.values()) {
        b.phase += dt * b.speed;
        this.positionBody(b);
        b.group.rotation.y += dt * b.spin;
      }

      this.renderer.render(this.scene, this.camera);
      this.projectPanels();
    };
    loop();
  }

  /** Place every panel's DOM at the screen projection of its 3D anchor. */
  private projectPanels(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const camPos = this.camera.position;

    for (const p of this.panels.values()) {
      if (p.bodyId) {
        const b = this.bodies.get(p.bodyId);
        if (b) this.tmpWorld.copy(b.position).add(p.offset);
        else this.tmpWorld.copy(p.anchor);
      } else {
        this.tmpWorld.copy(p.anchor);
      }

      // Behind-camera test in camera space (camera looks down -Z).
      this.tmpCam.copy(this.tmpWorld).applyMatrix4(this.camera.matrixWorldInverse);
      if (this.tmpCam.z > -1) {
        p.el.style.display = "none";
        continue;
      }
      p.el.style.display = "";

      const ndc = this.tmpWorld.clone().project(this.camera);
      const x = (ndc.x * 0.5 + 0.5) * w;
      const y = (-ndc.y * 0.5 + 0.5) * h;
      const dist = this.tmpWorld.distanceTo(camPos);
      const scale = Math.max(0.35, Math.min(1.25, 760 / dist));

      p.el.style.left = `${x.toFixed(1)}px`;
      p.el.style.top = `${y.toFixed(1)}px`;
      p.el.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    }
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
