import { EventBus } from "./EventBus";
import { Store } from "./Store";
import { VFS } from "./vfs";
import { Journal } from "./journal";
import { KERNEL_PID, ProcTable } from "./procs";
import {
  AUTOSTART_KEY,
  buildDev,
  buildEtc,
  buildProc,
  buildVarLog,
  type SysfsHooks,
} from "./sysfs";
import type {
  ArrangeMode,
  BodyKind,
  Command,
  Compositor,
  CompositorStats,
  GroupInfo,
  KernelContext,
  LaunchArgs,
  ModuleManifest,
  NotifyKind,
  SettingDef,
  Surface,
  SurfacePlacement,
  SurfaceRequest,
  VoidModule,
} from "./types";

/** Hard backstop so a stuck key or a bug can never spawn infinite windows. */
const MAX_SURFACES = 24;

const SESSION_KEY = "system.session";

interface SessionEntry {
  moduleId: string;
  place: SurfacePlacement;
}

let surfaceCounter = 0;

/**
 * The whole operating system fits in this class, and that's on purpose.
 * It owns: the module registry, the surface (window) table, the settings and
 * command registries, the event bus, and shared state. It renders NOTHING
 * itself — every pixel is the compositor's job. Replace the compositor and the
 * same kernel runs a different universe.
 */
export class Kernel {
  private bus = new EventBus();
  private store = new Store();
  private compositor: Compositor;
  /** Public so main.ts can mount /projects before boot. */
  readonly fs = new VFS();
  /** Public so the shell can render the log and the uptime without a syscall. */
  readonly journal = new Journal();
  readonly procs = new ProcTable();

  private modules = new Map<string, VoidModule>();
  private deactivators = new Map<string, () => void>();
  private surfaces = new Map<string, Surface>();
  private surfaceDisposers = new Map<string, () => void>();
  private settingDefs = new Map<string, SettingDef>();
  private commandDefs = new Map<string, Command>();
  /** The module currently inside its launch() call, so new surfaces get tagged. */
  private activeModuleId: string | null = null;
  /** The process that owns whatever surfaces the current launch() opens. */
  private activePid: number | null = null;
  /** Placement waiting to be applied to the next surface a module opens. */
  private pendingPlacement: SurfacePlacement | null = null;

  constructor(compositor: Compositor) {
    this.compositor = compositor;
  }

  /**
   * The syscall surface handed to every module — and to the shell UI.
   *
   * `tag` is who is calling, used to attribute journal writes. Modules get
   * their own id so the log can say which one spoke; the shell's own UI gets
   * the default.
   */
  context(tag = "shell"): KernelContext {
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
        mounts: () => this.fs.mounts(),
      },
      openSurface: (req) => this.openSurface(req),
      closeSurface: (id) => this.closeSurface(id),
      openSurfaces: () =>
        [...this.surfaces.values()].map((s) => ({
          id: s.id,
          title: s.title,
          moduleId: s.moduleId,
        })),
      focusSurface: (id) => this.compositor.focusSurface?.(id),
      lookAt: (id) => this.compositor.lookAtSurface?.(id),
      lookAtGroup: (id) => this.compositor.lookAtGroup?.(id),
      resetView: () => this.compositor.resetView?.(),
      patchWorld: (patch) => this.compositor.applyWorldPatch?.(patch),
      spawnBody: (kind: BodyKind) => this.compositor.spawnBody?.(kind) ?? "",
      destroyBody: (id) => this.compositor.destroyBody?.(id),
      attachSurface: (sid, bid) => this.compositor.attachSurface?.(sid, bid),
      listBodies: () => this.compositor.listBodies?.() ?? [],
      linkSurfaces: (ids, name) =>
        this.compositor.linkSurfaces?.(ids, name) ?? "",
      unlinkGroup: (id) => this.compositor.unlinkGroup?.(id),
      listGroups: (): GroupInfo[] => this.compositor.listGroups?.() ?? [],
      arrange: (mode: ArrangeMode) => this.compositor.arrange?.(mode),
      launch: (id, args) => this.launch(id, args),
      launchAt: (id, x, y) => {
        this.compositor.setSpawnHint?.(x, y);
        this.launch(id);
      },
      openPath: (p) => this.openPath(p),
      focalPoint: (dist) =>
        this.compositor.focalPoint?.(dist) ?? { x: 0, y: 0, z: -600 },
      mountAnchored: (el, anchor) =>
        this.compositor.mountAnchored?.(el, anchor) ?? {
          setAnchor: () => {},
          getAnchor: () => anchor,
          dispose: () => el.remove(),
        },
      screenToWorld: (x, y, d) =>
        this.compositor.screenToWorld?.(x, y, d) ?? { x: 0, y: 0, z: -d },
      registry: () => this.registry(),
      defineSetting: (def) => this.defineSetting(def),
      settings: () => this.settings(),
      defineCommand: (cmd) => this.defineCommand(cmd),
      commands: () => this.commands(),
      notify: (text, kind) => this.notify(text, kind),
      stats: (): CompositorStats =>
        this.compositor.stats?.() ?? {
          fps: 0,
          panels: this.surfaces.size,
          bodies: 0,
          groups: 0,
        },
      ps: () => this.procs.list(),
      kill: (pid) => this.kill(pid),
      log: (msg, level) => this.journal.write(tag, msg, level),
      journal: () => this.journal.read(),
      uptime: () => this.journal.uptime(),
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

  /** Boot: init the compositor, mount the system tree, then activate modules. */
  async boot(mounts: {
    gl: HTMLElement;
    overlay: HTMLElement;
    hud: HTMLElement;
  }): Promise<void> {
    this.procs.initKernel();
    this.journal.write("kernel", `voidshell starting on ${this.compositor.name}`);

    await this.compositor.init(mounts);
    this.compositor.start?.();
    this.journal.write("kernel", "compositor initialised");

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

    this.mountSysfs();

    // Subscribed before any module activates, so a notice raised during startup
    // is journalled too. Notifications are the system talking; the journal is
    // the system remembering. Mirroring here means every module's notify() is
    // recoverable from /var/log/system.log without any module knowing the
    // journal exists.
    this.bus.on("system.notify", (e) => {
      const p = e.payload as { text?: string; kind?: NotifyKind } | undefined;
      if (!p?.text) return;
      this.journal.write("notify", p.text, p.kind === "warn" ? "warn" : "info");
    });

    for (const mod of this.modules.values()) {
      const { id, name, kind } = mod.manifest;
      // Background modules become visible processes the moment they activate.
      // Apps stay absent from the table until something launches them, which
      // is the distinction between "installed" and "running".
      if (kind !== "app") this.procs.spawnDaemon(id, name, kind);
      try {
        const off = mod.activate(this.context(id));
        if (typeof off === "function") this.deactivators.set(id, off);
      } catch (err) {
        this.journal.write("kernel", `${id} failed to activate: ${err}`, "error");
        console.error(`[kernel] "${id}" threw while activating:`, err);
      }
    }

    this.journal.write(
      "kernel",
      `${this.modules.size} modules activated, ${this.procs.list().length} processes`
    );
    this.bus.emit("kernel.booted", { modules: this.registry() });
  }

  /**
   * Graft /proc, /dev, /etc and /var/log into the tree. These are mounts like
   * any other, so nothing downstream — not the file manager, not tab
   * completion, not the desktop — needed to learn they exist.
   */
  private mountSysfs(): void {
    const hooks: SysfsHooks = {
      journal: this.journal,
      procs: this.procs,
      registry: () => this.registry(),
      usage: () => this.fs.usage(),
      stats: () =>
        this.compositor.stats?.() ?? { fps: 0, panels: this.surfaces.size, bodies: 0, groups: 0 },
      store: {
        get: (k, f) => this.store.get(k, f),
        set: (k, v) => this.store.set(k, v),
      },
      notify: (text) => this.notify(text),
      compositorName: this.compositor.name,
    };

    this.fs.mount("/proc", buildProc(hooks));
    this.fs.mount("/dev", buildDev(hooks));
    this.fs.mount("/etc", buildEtc(hooks));
    this.fs.mount("/var/log", buildVarLog(hooks));
    this.journal.write("vfs", "mounted /proc /dev /etc /var/log");
  }

  /**
   * Launch whatever /etc/autostart names, in order. Called by the shell after
   * session restore, so the two can't both open the same singleton twice.
   */
  runAutostart(): number {
    const ids = this.store.get<string[]>(AUTOSTART_KEY, []);
    let started = 0;
    for (const id of ids) {
      if (!this.modules.has(id)) {
        this.journal.write("autostart", `no such module: ${id}`, "warn");
        continue;
      }
      this.launch(id);
      started++;
    }
    if (started) this.journal.write("autostart", `launched ${started} module(s)`);
    return started;
  }

  launch(moduleId: string, args?: LaunchArgs): void {
    const mod = this.modules.get(moduleId);
    if (!mod) {
      console.warn(`[kernel] no module "${moduleId}"`);
      this.notify(`no module "${moduleId}"`, "warn");
      return;
    }

    // Singleton by default: re-launching a running app brings its existing
    // window back instead of cloning it. Opt out with manifest.singleton = false.
    //
    // Launching *with arguments* is exempt: "open this file" is a request about
    // a specific document, and silently refocusing whatever the app already had
    // open would drop the path on the floor. That is why openPath works at all.
    if (mod.manifest.singleton !== false && !args) {
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
      console.warn(`[kernel] surface limit (${MAX_SURFACES}) reached`);
      this.notify(`window limit reached (${MAX_SURFACES})`, "warn");
      this.bus.emit("kernel.limit", { max: MAX_SURFACES });
      return;
    }

    // A launch is a process. Surfaces opened while it runs belong to it, which
    // is what lets the process exit when its last window closes.
    const proc = this.procs.spawnApp(moduleId, mod.manifest.name, args);
    this.activeModuleId = moduleId;
    this.activePid = proc.pid;
    try {
      mod.launch?.(this.context(moduleId), args);
    } catch (err) {
      console.error(`[kernel] "${moduleId}" threw while launching:`, err);
      this.journal.write("kernel", `${moduleId} failed to launch: ${err}`, "error");
      this.notify(`${moduleId} failed to launch`, "warn");
    } finally {
      this.activeModuleId = null;
      this.activePid = null;
    }

    // A module with no launch(), or one that threw before opening anything,
    // leaves an ownerless process behind. Reap it rather than let `ps` fill up
    // with entries that can never exit.
    if (proc.surfaces.length === 0) {
      this.procs.reap(proc.pid);
    } else {
      this.journal.write("kernel", `spawned ${moduleId} as pid ${proc.pid}`);
      this.bus.emit("proc.spawned", { pid: proc.pid, moduleId });
    }

    this.bus.emit("module.launched", { id: moduleId, args, pid: proc.pid });
  }

  /**
   * Terminate a process by closing every window it owns, which routes through
   * the ordinary close path so each module still runs its own cleanup.
   *
   * Daemons and the kernel itself refuse to die. That is not a limitation being
   * papered over: aurora owns every colour in the build and horizon owns the
   * sky, so "killed the theme daemon" would be an unrecoverable state reachable
   * by typing four characters. A real OS refuses to kill init for the same
   * reason, and reports EPERM rather than pretending it worked.
   */
  kill(pid: number): boolean {
    const proc = this.procs.get(pid);
    if (!proc) {
      this.notify(`no such process: ${pid}`, "warn");
      return false;
    }
    if (pid === KERNEL_PID || proc.state === "daemon") {
      this.notify(`operation not permitted: ${proc.name} (pid ${pid})`, "warn");
      return false;
    }
    // Copy: closeSurface mutates the array this iterates through.
    for (const sid of [...proc.surfaces]) this.closeSurface(sid);
    this.procs.reap(pid);
    this.journal.write("kernel", `killed ${proc.moduleId} (pid ${pid})`);
    return true;
  }

  /**
   * Route a path to the module registered for its extension. Directories
   * always go to the file manager; unknown types fall back to whichever module
   * declared `handles: ["*"]`.
   */
  openPath(path: string): void {
    if (!this.fs.exists(path)) {
      console.warn(`[kernel] no such path: ${path}`);
      this.notify(`no such path: ${path}`, "warn");
      return;
    }

    if (this.fs.isDir(path)) {
      const browser = [...this.modules.values()].find((m) =>
        m.handles?.includes("dir")
      );
      if (browser) this.launch(browser.manifest.id, { path });
      return;
    }

    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const mods = [...this.modules.values()];
    const owner =
      mods.find((m) => m.handles?.includes(ext)) ??
      mods.find((m) => m.handles?.includes("*"));
    if (owner) this.launch(owner.manifest.id, { path });
    else this.notify(`nothing handles .${ext}`, "warn");
  }

  registry(): ModuleManifest[] {
    return [...this.modules.values()].map((m) => m.manifest);
  }

  /* ---------------- settings & commands ---------------- */

  defineSetting(def: SettingDef): void {
    this.settingDefs.set(def.key, def);
    // Seed the store so a fresh install reads the author's default rather than
    // whatever fallback each call site happens to pass.
    if (def.default !== undefined && !this.store.has(def.key)) {
      this.store.set(def.key, def.default);
    }
    this.bus.emit("settings.changed", { key: def.key });
  }

  settings(): SettingDef[] {
    return [...this.settingDefs.values()].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100)
    );
  }

  defineCommand(cmd: Command): void {
    this.commandDefs.set(cmd.id, cmd);
  }

  commands(): Command[] {
    return [...this.commandDefs.values()];
  }

  notify(text: string, kind: NotifyKind = "info"): void {
    this.bus.emit("system.notify", { text, kind });
  }

  /* ---------------- surfaces ---------------- */

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

    const cleanup = req.render(element, this.context(surface.moduleId));
    this.surfaces.set(id, surface);
    if (this.activePid !== null) this.procs.attachSurface(this.activePid, id);
    const dispose = this.compositor.mountSurface(surface);

    // Session restore hands us the exact place this window used to occupy.
    if (this.pendingPlacement) {
      this.compositor.placeSurface?.(id, this.pendingPlacement);
      this.pendingPlacement = null;
    }

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

    // Closing the last window a process owns is how that process exits. Deriving
    // it from surface ownership rather than tracking it separately is what keeps
    // `ps` from ever disagreeing with what's on screen.
    const orphaned = this.procs.detachSurface(id);
    if (orphaned) {
      this.procs.reap(orphaned.pid);
      this.journal.write("kernel", `${orphaned.moduleId} exited (pid ${orphaned.pid})`);
      this.bus.emit("proc.exited", { pid: orphaned.pid, moduleId: orphaned.moduleId });
    }

    this.bus.emit("surface.closed", { id });
  }

  /* ---------------- session ---------------- */

  /**
   * Write down which apps were open and exactly where they floated, so the
   * void looks the way you left it next time you open the tab.
   */
  saveSession(): void {
    const places = this.compositor.snapshot?.() ?? {};
    const entries: SessionEntry[] = [];
    for (const s of this.surfaces.values()) {
      const place = places[s.id];
      if (place) entries.push({ moduleId: s.moduleId, place });
    }
    this.store.set(SESSION_KEY, entries);
  }

  /** Re-open last session's apps, each one dropped back into its old spot. */
  restoreSession(): void {
    const entries = this.store.get<SessionEntry[]>(SESSION_KEY, []);
    if (!Array.isArray(entries) || entries.length === 0) return;
    for (const entry of entries) {
      if (!this.modules.has(entry.moduleId)) continue;
      this.pendingPlacement = entry.place;
      this.launch(entry.moduleId);
      this.pendingPlacement = null;
    }
  }

  /** Forget everything: settings, layout, notes. Used by Settings > System. */
  factoryReset(): void {
    this.store.wipe();
  }

  dispose(): void {
    for (const off of this.deactivators.values()) off();
    this.compositor.dispose();
  }
}
