import { EventBus } from "./EventBus";
import { Store } from "./Store";
import type {
  BodyKind,
  Compositor,
  KernelContext,
  ModuleManifest,
  Surface,
  SurfaceRequest,
  VoidModule,
} from "./types";

let surfaceCounter = 0;

/**
 * The whole operating system fits in this class, and that's on purpose.
 * It owns: the module registry, the surface (window) table, the event bus,
 * and shared state. It renders NOTHING itself — every pixel is the
 * compositor's job. Replace the compositor and the same kernel runs a
 * different universe.
 */
export class Kernel {
  private bus = new EventBus();
  private store = new Store();
  private compositor: Compositor;

  private modules = new Map<string, VoidModule>();
  private deactivators = new Map<string, () => void>();
  private surfaces = new Map<string, Surface>();
  private surfaceDisposers = new Map<string, () => void>();

  constructor(compositor: Compositor) {
    this.compositor = compositor;
  }

  /** The syscall surface handed to every module. */
  private context(): KernelContext {
    return {
      emit: (t, p) => this.bus.emit(t, p),
      on: (t, h) => this.bus.on(t, h),
      state: {
        get: (k, f) => this.store.get(k, f),
        set: (k, v) => this.store.set(k, v),
        subscribe: (k, h) => this.store.subscribe(k, h),
      },
      openSurface: (req) => this.openSurface(req),
      closeSurface: (id) => this.closeSurface(id),
      openSurfaces: () =>
        [...this.surfaces.values()].map((s) => ({ id: s.id, title: s.title })),
      patchWorld: (patch) => this.compositor.applyWorldPatch?.(patch),
      spawnBody: (kind: BodyKind) => this.compositor.spawnBody?.(kind) ?? "",
      attachSurface: (sid, bid) => this.compositor.attachSurface?.(sid, bid),
      listBodies: () => this.compositor.listBodies?.() ?? [],
      launch: (id) => this.launch(id),
      registry: () => [...this.modules.values()].map((m) => m.manifest),
    };
  }

  /** Register a module. Order-independent; modules find each other via the bus. */
  register(mod: VoidModule): this {
    if (this.modules.has(mod.manifest.id)) {
      console.warn(`[kernel] module "${mod.manifest.id}" already registered`);
      return this;
    }
    this.modules.set(mod.manifest.id, mod);
    return this;
  }

  /** Boot: init the compositor, then activate every module. */
  async boot(mounts: { gl: HTMLElement; overlay: HTMLElement }): Promise<void> {
    await this.compositor.init(mounts);
    this.compositor.start?.();
    for (const mod of this.modules.values()) {
      const off = mod.activate(this.context());
      if (typeof off === "function") this.deactivators.set(mod.manifest.id, off);
    }
    this.bus.emit("kernel.booted", { modules: this.registry() });
  }

  launch(moduleId: string): void {
    const mod = this.modules.get(moduleId);
    if (!mod) return console.warn(`[kernel] no module "${moduleId}"`);
    mod.launch?.(this.context());
    this.bus.emit("module.launched", { id: moduleId });
  }

  registry(): ModuleManifest[] {
    return [...this.modules.values()].map((m) => m.manifest);
  }

  openSurface(req: SurfaceRequest): Surface {
    const id = `surface-${++surfaceCounter}`;
    const element = document.createElement("div");
    element.className = "vs-surface-body";

    const surface: Surface = {
      id,
      moduleId: "unknown",
      title: req.title,
      element,
      width: req.width ?? 420,
      height: req.height ?? 300,
      position: {
        x: req.position?.x ?? (Math.random() - 0.5) * 600,
        y: req.position?.y ?? (Math.random() - 0.5) * 200,
        z: req.position?.z ?? -200 - Math.random() * 200,
      },
    };

    const cleanup = req.render(element, this.context());
    this.surfaces.set(id, surface);
    const dispose = this.compositor.mountSurface(surface);
    this.surfaceDisposers.set(id, () => {
      if (typeof cleanup === "function") cleanup();
      dispose();
    });
    this.bus.emit("surface.opened", { id, title: surface.title });
    return surface;
  }

  closeSurface(id: string): void {
    this.surfaceDisposers.get(id)?.();
    this.surfaceDisposers.delete(id);
    this.surfaces.delete(id);
    this.bus.emit("surface.closed", { id });
  }
}
