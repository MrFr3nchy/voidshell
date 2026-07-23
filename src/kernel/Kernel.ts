import { EventBus } from "./EventBus";
import { Store } from "./Store";
import type {
  BodyKind,
  Command,
  Compositor,
  KernelContext,
  ModuleManifest,
  Surface,
  SurfaceGroup,
  SurfaceRequest,
  Vista,
  VoidModule,
} from "./types";

/** Hard backstop so a stuck key or a bug can never spawn infinite windows. */
const MAX_SURFACES = 24;

let surfaceCounter = 0;

/**
 * The whole operating system fits in this class, and that's on purpose.
 * It owns: the module registry, the surface (window) table, the event bus,
 * shared state, the command registry and saved vistas. It renders NOTHING
 * itself — every pixel is the compositor's job. Replace the compositor and the
 * same kernel runs a different universe.
 */
export class Kernel {
  private bus = new EventBus();
  private store = new Store();
  private compositor: Compositor;

  private modules = new Map<string, VoidModule>();
  private deactivators = new Map<string, () => void>();
  private surfaces = new Map<string, Surface>();
  private surfaceDisposers = new Map<string, () => void>();
  private cmds = new Map<string, Command>();
  /** The module currently inside its launch() call, so new surfaces get tagged. */
  private activeModuleId: string | null = null;

  constructor(compositor: Compositor) {
    this.compositor = compositor;
  }

  /**
   * The same syscall surface modules get, exposed for shell UI (the launcher,
   * the command palette, the status cluster). The shell is not privileged —
   * it's just another caller, which keeps the contract honest.
   */
  shellContext(): KernelContext {
    return this.context();
  }

  private context(): KernelContext {
    return {
      emit: (t, p) => this.bus.emit(t, p),
      on: (t, h) => this.bus.on(t, h),
      state: {
        get: (k, f) => this.store.get(k, f),
        set: (k, v) => this.store.set(k, v),
        subscribe: (k, h) => this.store.subscribe(k, h),
        reset: () => this.store.clearPersisted(),
      },
      openSurface: (req) => this.openSurface(req),
      closeSurface: (id) => this.closeSurface(id),
      openSurfaces: () =>
        [...this.surfaces.values()].map((s) => ({
          id: s.id,
          title: s.title,
          moduleId: s.moduleId,
        })),
      patchWorld: (patch) => this.compositor.applyWorldPatch?.(patch),
      spawnBody: (kind: BodyKind) => this.compositor.spawnBody?.(kind) ?? "",
      attachSurface: (sid, bid) => this.compositor.attachSurface?.(sid, bid),
      listBodies: () => this.compositor.listBodies?.() ?? [],
      focusSurface: (id) => this.compositor.focusSurface?.(id),
      lookAtSurface: (id) => this.compositor.lookAtSurface?.(id),
      recallSurfaces: () => this.compositor.recallSurfaces?.(),
      linkSurfaces: (a, b) => this.compositor.linkSurfaces?.(a, b) ?? null,
      unlinkSurface: (id) => this.compositor.unlinkSurface?.(id),
      tileGroup: (gid) => this.compositor.tileGroup?.(gid),
      listGroups: (): SurfaceGroup[] => this.compositor.listGroups?.() ?? [],
      pinSurface: (id, pinned) => this.compositor.pinSurface?.(id, pinned),
      vistas: () => this.vistas(),
      saveVista: (name) => this.saveVista(name),
      gotoVista: (name) => this.gotoVista(name),
      deleteVista: (name) => this.deleteVista(name),
      addCommand: (cmd) => this.addCommand(cmd),
      commands: () => [...this.cmds.values()],
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

    // Singleton by default: re-launching a running app brings its existing
    // window back instead of cloning it. Opt out with manifest.singleton = false.
    if (mod.manifest.singleton !== false) {
      const existing = [...this.surfaces.values()].find(
        (s) => s.moduleId === moduleId
      );
      if (existing) {
        this.compositor.focusSurface?.(existing.id);
        this.bus.emit("module.focused", { id: moduleId, surface: existing.id });
        return;
      }
    }

    // Hard backstop against runaway spawning (stuck Enter, loops, etc.).
    if (this.surfaces.size >= MAX_SURFACES) {
      console.warn(`[kernel] surface limit (${MAX_SURFACES}) reached; not opening more`);
      this.bus.emit("kernel.limit", { max: MAX_SURFACES });
      return;
    }

    this.activeModuleId = moduleId;
    try {
      mod.launch?.(this.context());
    } finally {
      this.activeModuleId = null;
    }
    this.rememberSession();
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
      moduleId: this.activeModuleId ?? "unknown",
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
    this.rememberSession();
    this.bus.emit("surface.closed", { id });
  }

  /** Close everything. Bound to a command and to the palette. */
  closeAll(): void {
    for (const id of [...this.surfaces.keys()]) this.closeSurface(id);
  }

  addCommand(cmd: Command): () => void {
    this.cmds.set(cmd.id, cmd);
    this.bus.emit("commands.changed", { id: cmd.id });
    return () => {
      this.cmds.delete(cmd.id);
      this.bus.emit("commands.changed", { id: cmd.id });
    };
  }

  // ---- Vistas: saved camera orientations, the OS's "workspaces" ----

  vistas(): Vista[] {
    return this.store.get<Vista[]>("vista.list", []);
  }

  saveVista(name: string): void {
    const here = this.compositor.getVista?.();
    if (!here) return;
    const list = this.vistas().filter((v) => v.name !== name);
    list.push({ name, yaw: here.yaw, pitch: here.pitch });
    this.store.set("vista.list", list);
    this.bus.emit("vistas.changed", { name });
  }

  gotoVista(name: string): void {
    const v = this.vistas().find((x) => x.name === name);
    if (v) this.compositor.gotoVista?.({ yaw: v.yaw, pitch: v.pitch });
  }

  deleteVista(name: string): void {
    this.store.set(
      "vista.list",
      this.vistas().filter((v) => v.name !== name)
    );
    this.bus.emit("vistas.changed", { name });
  }

  /**
   * Remember which apps were open so the next boot can restore them. Stores
   * module ids only — never DOM, never live state — so a restore is just a
   * replay of launches.
   */
  private rememberSession(): void {
    const ids = [...new Set([...this.surfaces.values()].map((s) => s.moduleId))];
    this.store.set("session.open", ids);
  }

  /** Replay the last session's apps. Called once, after boot. */
  restoreSession(): boolean {
    const ids = this.store.get<string[]>("session.open", []);
    const known = ids.filter((id) => this.modules.has(id));
    for (const id of known) this.launch(id);
    return known.length > 0;
  }
}
