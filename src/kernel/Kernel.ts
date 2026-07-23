import { EventBus } from "./EventBus";
import { Store } from "./Store";
import { VFS } from "./vfs";
import type {
  BodyKind,
  Compositor,
  KernelContext,
  LaunchArgs,
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
  /** Public so main.ts can mount /projects before boot. */
  readonly fs = new VFS();

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
      fs: {
        ls: (p) => this.fs.ls(p),
        read: (p) => this.fs.read(p),
        write: (p, c) => this.fs.write(p, c),
        mkdir: (p) => this.fs.mkdir(p),
        mkdirp: (p) => this.fs.mkdirp(p),
        rm: (p, r) => this.fs.rm(p, r),
        mv: (a, b) => this.fs.mv(a, b),
        stat: (p) => this.fs.stat(p),
        exists: (p) => this.fs.exists(p),
        isDir: (p) => this.fs.isDir(p),
        onChange: (fn) => this.fs.onChange(fn),
        usage: () => this.fs.usage(),
      },
      openSurface: (req) => this.openSurface(req),
      closeSurface: (id) => this.closeSurface(id),
      openSurfaces: () =>
        [...this.surfaces.values()].map((s) => ({ id: s.id, title: s.title })),
      patchWorld: (patch) => this.compositor.applyWorldPatch?.(patch),
      spawnBody: (kind: BodyKind) => this.compositor.spawnBody?.(kind) ?? "",
      attachSurface: (sid, bid) => this.compositor.attachSurface?.(sid, bid),
      listBodies: () => this.compositor.listBodies?.() ?? [],
      launch: (id, args) => this.launch(id, args),
      openPath: (p) => this.openPath(p),
      focalPoint: (dist) => this.compositor.focalPoint?.(dist) ?? { x: 0, y: 0, z: -600 },
      mountAnchored: (el, anchor) =>
        this.compositor.mountAnchored?.(el, anchor) ?? {
          setAnchor: () => {},
          getAnchor: () => anchor,
          dispose: () => el.remove(),
        },
      screenToWorld: (x, y, d) =>
        this.compositor.screenToWorld?.(x, y, d) ?? { x: 0, y: 0, z: -d },
      focusSurface: (id) => this.compositor.focusSurface?.(id),
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

    // Restore the user's files, then persist on every later mutation. Debounced
    // because a shell loop can touch the tree many times in one frame, and each
    // save re-serialises the whole home tree.
    this.fs.load();
    let saveTimer = 0;
    this.fs.onChange(() => {
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => this.fs.save(), 250);
    });
    window.addEventListener("beforeunload", () => this.fs.save());

    for (const mod of this.modules.values()) {
      const off = mod.activate(this.context());
      if (typeof off === "function") this.deactivators.set(mod.manifest.id, off);
    }
    this.bus.emit("kernel.booted", { modules: this.registry() });
  }

  launch(moduleId: string, args?: LaunchArgs): void {
    const mod = this.modules.get(moduleId);
    if (!mod) return console.warn(`[kernel] no module "${moduleId}"`);
    mod.launch?.(this.context(), args);
    this.bus.emit("module.launched", { id: moduleId, args });
  }

  /**
   * Route a path to the module registered for its extension. Directories
   * always go to the file manager; unknown types fall back to whichever module
   * declared `handles: ["*"]`.
   */
  openPath(path: string): void {
    if (!this.fs.exists(path)) return console.warn(`[kernel] no such path: ${path}`);

    if (this.fs.isDir(path)) {
      const browser = [...this.modules.values()].find((m) => m.handles?.includes("dir"));
      if (browser) this.launch(browser.manifest.id, { path });
      return;
    }

    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const mods = [...this.modules.values()];
    const owner =
      mods.find((m) => m.handles?.includes(ext)) ?? mods.find((m) => m.handles?.includes("*"));
    if (owner) this.launch(owner.manifest.id, { path });
    else console.warn(`[kernel] nothing handles ${path}`);
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
