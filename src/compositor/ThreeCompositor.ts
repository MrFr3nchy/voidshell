import * as THREE from "three";
import { CSS3DRenderer, CSS3DObject } from "three/addons/renderers/CSS3DRenderer.js";
import type { Compositor, Surface } from "../kernel/types";
import { nebulaFragment, nebulaVertex } from "../world/nebulaShader";

/**
 * The spectacle compositor.
 *
 * WebGL draws the world (nebula skybox + drifting particles). A second,
 * layered CSS3DRenderer draws the actual app panels as real, interactive DOM
 * positioned in the same 3D space — because you cannot put live web content
 * *inside* WebGL, only alongside it. The camera is shared, so both layers
 * agree on where "there" is.
 */
export class ThreeCompositor implements Compositor {
  readonly name = "three-spectacle";

  private renderer!: THREE.WebGLRenderer;
  private css3d!: CSS3DRenderer;
  private scene = new THREE.Scene();
  private cssScene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();

  private nebula!: THREE.Mesh;
  private particles!: THREE.Points;
  private uniforms = {
    uTime: { value: 0 },
    uIntensity: { value: 1.0 },
    uColorCool: { value: new THREE.Color(0x4fe3d0) },
    uColorWarm: { value: new THREE.Color(0xc05cff) },
    uColorVoid: { value: new THREE.Color(0x05060c) },
  };

  private yaw = 0;
  private pitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private raf = 0;

  async init(mounts: { gl: HTMLElement; overlay: HTMLElement }): Promise<void> {
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(68, w / h, 1, 8000);
    this.camera.position.set(0, 0, 0.01);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    mounts.gl.appendChild(this.renderer.domElement);

    this.css3d = new CSS3DRenderer();
    this.css3d.setSize(w, h);
    const cssEl = this.css3d.domElement;
    cssEl.style.position = "absolute";
    cssEl.style.top = "0";
    cssEl.style.left = "0";
    cssEl.style.pointerEvents = "none";
    mounts.overlay.appendChild(cssEl);

    this.nebula = new THREE.Mesh(
      new THREE.SphereGeometry(4000, 48, 48),
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
    close.textContent = "✕";
    bar.append(title, close);

    const body = document.createElement("div");
    body.className = "vs-panel-content";
    body.appendChild(surface.element);

    panel.append(bar, body);

    const dir = new THREE.Vector3(0, 0, -1).applyEuler(
      new THREE.Euler(this.pitch, this.yaw, 0, "YXZ")
    );
    const dist = 720;
    const obj = new CSS3DObject(panel);
    obj.position.copy(dir.multiplyScalar(dist));
    obj.lookAt(this.camera.position);
    this.cssScene.add(obj);

    requestAnimationFrame(() => panel.classList.replace("materializing", "active"));

    const dispose = () => {
      panel.classList.remove("active");
      panel.classList.add("dissolving");
      setTimeout(() => this.cssScene.remove(obj), 320);
    };
    close.addEventListener("click", () => {
      panel.dispatchEvent(new CustomEvent("vs:close", { bubbles: true }));
    });
    panel.addEventListener("vs:close", () => {
      const evt = new CustomEvent("voidshell:close-surface", {
        detail: { id: surface.id },
        bubbles: true,
      });
      window.dispatchEvent(evt);
    });

    return dispose;
  }

  applyWorldPatch(patch: Record<string, unknown>): void {
    if (typeof patch.intensity === "number") this.uniforms.uIntensity.value = patch.intensity;
    if (typeof patch.cool === "number") this.uniforms.uColorCool.value.setHex(patch.cool);
    if (typeof patch.warm === "number") this.uniforms.uColorWarm.value.setHex(patch.warm);
    if (typeof patch.voidColor === "number") this.uniforms.uColorVoid.value.setHex(patch.voidColor);
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

      this.renderer.render(this.scene, this.camera);
      this.css3d.render(this.cssScene, this.camera);
    };
    loop();
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
    this.css3d.setSize(w, h);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    this.renderer.dispose();
  }
}
