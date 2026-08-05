/**
 * The contracts every part of voidshell speaks.
 *
 * The whole point of this file: the kernel knows about Modules, Surfaces and
 * Settings. It does NOT know about Three.js, DOM, or how anything is drawn.
 * That job belongs to whatever Compositor is installed. Swap the compositor and
 * the same modules render in a completely different world.
 */

import type { LogEntry, LogLevel } from "./journal";
import type { ProcInfo } from "./procs";
import type { MountInfo } from "./vfs";

export type { LogEntry, LogLevel, MountInfo, ProcInfo };

/** A 3D-ish position in the void. Compositors decide what the units mean. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The kinds of celestial body the world can hold. */
export type BodyKind = "sun" | "moon" | "planet" | "singularity";

/** How `arrange` should re-lay-out every open window at once. */
export type ArrangeMode = "arc" | "ring" | "wall" | "scatter";

/**
 * A surface is "a thing that wants to exist in space and show some DOM."
 * The kernel tracks surfaces; the compositor gives them a body.
 */
export interface Surface {
  id: string;
  /** Which module owns this surface. */
  moduleId: string;
  title: string;
  /** The live DOM the module renders into. The compositor mounts this somewhere. */
  element: HTMLElement;
  /** Suggested size in CSS pixels of the surface's own coordinate space. */
  width: number;
  height: number;
  /** Where it lives in the world. Compositor is free to interpret/animate this. */
  position: Vec3;
}

/** What a module asks for when it opens a window into the world. */
export interface SurfaceRequest {
  title: string;
  width?: number;
  height?: number;
  position?: Partial<Vec3>;
  /** Called once with the element the module should render into. */
  render: (root: HTMLElement, ctx: KernelContext) => void | (() => void);
}

/** A live constellation of windows that move, focus and dissolve as one. */
export interface GroupInfo {
  id: string;
  name: string;
  members: string[];
  /** Thread colour. Optional so a minimal compositor need not have the idea. */
  color?: string;
  /** Whether the bond translates (hard) or rotates about the camera (loose). */
  rigid?: boolean;
}

/** Enough about a constellation to rebuild the same one. */
export interface GroupStyle {
  color?: string;
  rigid?: boolean;
}

/** A saved constellation: which apps, under what name. Survives reloads. */
export interface SavedDashboard {
  id: string;
  name: string;
  moduleIds: string[];
}

/** What the compositor is willing to admit about its own performance. */
export interface CompositorStats {
  fps: number;
  panels: number;
  bodies: number;
  groups: number;
}

/**
 * A Compositor is the render backend. Everything visual is delegated here,
 * which is how "the renderer is a plugin" actually works. Ship a Three.js one,
 * a plain-DOM one, a WebGPU one later — the kernel never changes.
 */
export interface Compositor {
  readonly name: string;
  /** Called once at boot with the mount points. */
  init(mounts: {
    gl: HTMLElement;
    overlay: HTMLElement;
    hud: HTMLElement;
  }): void | Promise<void>;
  /** Give a surface a body in the world. Returns a disposer. */
  mountSurface(surface: Surface): () => void;
  /** Change the name a mounted window shows. */
  retitleSurface?(id: string, title: string): void;
  /** Bring an existing surface back to the user and focus it (singleton re-launch). */
  focusSurface?(id: string): void;
  /** Which window currently has focus, if the backend has such a notion. */
  activeSurface?(): string | null;
  /**
   * Show every window at once in a readable formation, and put them back.
   *
   * Distinct from `arrange`, which is a permanent re-layout: an overview has to
   * be *reversible*, or looking at everything costs you the arrangement you had.
   *
   * Omit `on` to toggle. Returns whether the overview is now up — the
   * compositor dismisses it itself when a window is picked, so the caller
   * cannot keep a flag of its own without it drifting.
   */
  expose?(on?: boolean): boolean;
  /** Swing the camera until the given surface is dead ahead. */
  lookAtSurface?(id: string): void;
  /** Swing the camera to the centre of a linked constellation. */
  lookAtGroup?(id: string): void;
  /** Point the camera back at the horizon it started on. */
  resetView?(): void;
  /** The world can be mutated by modules (fog, sky, gravity...). Free-form. */
  applyWorldPatch?(patch: Record<string, unknown>): void;
  /** Spawn a celestial body. Returns its id. */
  spawnBody?(kind: BodyKind): string;
  /** Remove a celestial body and release anything riding it. */
  destroyBody?(id: string): void;
  /** Anchor a surface onto a body so it rides along, or pass null to release it. */
  attachSurface?(surfaceId: string, bodyId: string | null): void;
  /** Everything currently orbiting out there. */
  listBodies?(): { id: string; kind: BodyKind }[];
  /**
   * Mount arbitrary DOM at a world position — desktop icons, labels, markers.
   * Lighter than a Surface: no chrome, no depth control, just projection.
   */
  mountAnchored?(el: HTMLElement, anchor: Vec3): AnchorHandle;
  /** Where the camera is looking, `dist` units out. For placing new things. */
  focalPoint?(dist?: number): Vec3;
  /** Convert a screen point to a world position at a given distance. */
  screenToWorld?(x: number, y: number, dist: number): Vec3;
  /** Tie windows together so they drag, focus and travel as one. */
  linkSurfaces?(ids: string[], name?: string, style?: GroupStyle): string;
  /** Cut a constellation loose; its windows go back to being individuals. */
  unlinkGroup?(id: string): void;
  listGroups?(): GroupInfo[];
  /** Re-lay-out every open window into a chosen formation. */
  arrange?(mode: ArrangeMode): void;
  /**
   * Where the next surface should materialise, in screen pixels. Consumed by
   * the very next mountSurface — this is how drag-an-app-into-the-void works.
   */
  setSpawnHint?(x: number, y: number): void;
  /** Restore a window's exact place in space (used by session restore). */
  placeSurface?(id: string, place: SurfacePlacement): void;
  /** Snapshot every window's place in space, for persistence. */
  snapshot?(): Record<string, SurfacePlacement>;
  stats?(): CompositorStats;
  /** Per-frame hook if the compositor animates. */
  start?(): void;
  dispose(): void;
}

/** Control handle for a piece of DOM anchored in the world. */
export interface AnchorHandle {
  setAnchor(p: Vec3): void;
  getAnchor(): Vec3;
  dispose(): void;
}

/** Enough about a window's position to put it back exactly where it was. */
export interface SurfacePlacement {
  anchor: [number, number, number];
  width: number;
  height: number;
  pinned: boolean;
  pinX: number;
  pinY: number;
  /**
   * Which region of the screen it fills, if it stopped floating. Optional so
   * a session written before snapping existed still restores cleanly.
   */
  snap?: "full" | "left" | "right" | null;
  /** Collapsed to just its title bar. */
  minimized?: boolean;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/**
 * Settings are not a hardcoded screen — they're a registry. Any module can
 * publish a control and it shows up in the Settings app automatically, in the
 * group it asked for. That's what keeps "modular" honest: adding a knob never
 * means editing the settings UI.
 */
export type SettingKind =
  | "toggle"
  | "slider"
  | "select"
  | "color"
  | "action"
  | "custom";

export interface SettingDef {
  /** Namespaced store key, e.g. "world.dust". Actions may use a bare id. */
  key: string;
  label: string;
  kind: SettingKind;
  /** Tab it lands under: "Appearance", "Launcher", "World", "System"... */
  group: string;
  hint?: string;
  /** Sort weight inside the group; lower floats to the top. */
  order?: number;
  default?: unknown;
  /** slider */
  min?: number;
  max?: number;
  step?: number;
  /** slider display suffix, e.g. "°" or "×" */
  unit?: string;
  /** select */
  options?: { value: string; label: string }[];
  /** action */
  run?: (ctx: KernelContext) => void;
  /** custom — render whatever control you like into the given root. */
  render?: (root: HTMLElement, ctx: KernelContext) => void | (() => void);
}

/* ------------------------------------------------------------------ */
/* Modules                                                             */
/* ------------------------------------------------------------------ */

/**
 * A Module is voidshell's unit of everything: an app, a theme, a world effect,
 * a system service. If it registers against this contract, it plugs in.
 */
export interface ModuleManifest {
  id: string;
  name: string;
  /** Freeform tags. "app" surfaces in the launcher; "world"/"service" don't. */
  kind: "app" | "world" | "service";
  /** A single glyph shown in the radial launcher. Keep it weird. */
  glyph?: string;
  /** One line for the app drawer and the command palette. */
  blurb?: string;
  /**
   * If false, launching again spawns another instance. Defaults to true:
   * re-launching a running app focuses the existing window instead of cloning it.
   */
  singleton?: boolean;
  version?: string;
}

/** Arguments passed to a module at launch. `path` is the conventional one. */
export interface LaunchArgs {
  path?: string;
  [key: string]: unknown;
}

export interface VoidModule {
  manifest: ModuleManifest;
  /** Called when the kernel loads the module. Register listeners, services, etc. */
  activate(ctx: KernelContext): void | (() => void);
  /**
   * For "app" modules: called when the user launches it. Usually opens a surface.
   * Optional so world/service modules can omit it.
   */
  launch?(ctx: KernelContext, args?: LaunchArgs): void;
  /**
   * File extensions this module can open, lowercase and without the dot.
   * The kernel builds its association table from these. `"dir"` is the
   * pseudo-extension for directories.
   */
  handles?: string[];
  /**
   * Take unclaimed *text* files when nothing else names their extension.
   *
   * Replaces the old `handles: ["*"]`, which also claimed PNGs and ZIPs. A
   * fallback is never offered for binary types or for directories.
   */
  fallback?: boolean;
  /**
   * Tie-break weight when several modules handle the same type; higher wins.
   *
   * Association used to be decided by registration order, which meant the one
   * comment in `main.ts` explaining that order was the only thing standing
   * between you and directories opening in a text editor.
   */
  priority?: number;
}

/** A tiny typed event. Modules talk through this, never to each other directly. */
export interface KernelEvent<T = unknown> {
  type: string;
  payload?: T;
}

export type NotifyKind = "info" | "good" | "warn";

/**
 * A notice that can be acted on.
 *
 * Every notice used to be a sentence that expired after 2.6 seconds whatever it
 * said, which made warnings the worst case: the system told you something was
 * wrong, gave you no way to do anything about it, and then took the message
 * away. An offer to fix it belongs on the thing that reported it.
 */
export interface NotifyOptions {
  kind?: NotifyKind;
  /** A single offer — "undo", "open it", "see every window". */
  action?: { label: string; run: (ctx: KernelContext) => void };
  /**
   * Stay until dismissed. Defaults to true for `warn` and for anything
   * carrying an action, since both are worth more than two seconds.
   */
  sticky?: boolean;
}

/** A single entry in the command palette. */
export interface Command {
  id: string;
  label: string;
  hint?: string;
  glyph?: string;
  run: (ctx: KernelContext) => void;
}

/**
 * The filesystem as modules see it. Deliberately the shape of POSIX-ish calls
 * rather than the VFS class itself, so the backing store can change (IndexedDB,
 * a real server) without touching a single module.
 */
export interface FsApi {
  ls(path: string): FsEntry[];
  read(path: string): string;
  write(path: string, content: string): void;
  mkdir(path: string): void;
  /** mkdir -p: creates missing parents, succeeds if the path already exists. */
  mkdirp(path: string): void;
  rm(path: string, recursive?: boolean): void;
  mv(from: string, to: string): void;
  stat(path: string): FsEntry;
  exists(path: string): boolean;
  isDir(path: string): boolean;
  /** Fired on any mutation, so viewers can refresh. Returns an unsubscriber. */
  onChange(fn: () => void): () => void;
  usage(): { files: number; dirs: number; bytes: number; indexed: number };
  /** Every filesystem grafted into the tree, for `mount`. */
  mounts(): MountInfo[];
}

export interface FsEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  readonly: boolean;
  /** Last modification, epoch ms. */
  mtime: number;
  /** Set when a real file's contents were not embedded in the build. */
  omitted?: "binary" | "toolarge";
  meta?: Record<string, string>;
}

/**
 * The context handed to every module. This is the entire syscall surface of
 * voidshell — deliberately small. Grow it on purpose, never by accident.
 */
export interface KernelContext {
  /** Publish/subscribe bus (the OS's IPC). */
  emit(type: string, payload?: unknown): void;
  on(type: string, handler: (e: KernelEvent) => void): () => void;
  /** Shared reactive state (the OS's shared memory), mirrored to disk. */
  state: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
    subscribe(key: string, handler: (value: unknown) => void): () => void;
  };
  /** The filesystem (the OS's storage syscalls). */
  fs: FsApi;
  /** Open a window into the world. */
  openSurface(req: SurfaceRequest): Surface;
  closeSurface(id: string): void;
  /**
   * Rename an open window.
   *
   * A title used to be fixed at open, which is fine for an app that is only
   * ever itself and wrong for every app that holds a *document*: the editor's
   * title went stale the moment you opened a second file into it, the file
   * manager never said which directory you were in, and the browser always
   * claimed to be "portal" whatever page it was showing. The title bar, the
   * compass and the command palette all read the same string, so this fixes
   * all three at once.
   */
  setTitle(surfaceId: string, title: string): void;
  /** Every surface currently open — for launchers, task lists, merge pickers. */
  openSurfaces(): { id: string; title: string; moduleId: string }[];
  /** Bring a window back to the front of your attention. */
  focusSurface(id: string): void;
  /** Which window has focus right now, or null when nothing does. */
  activeSurface(): string | null;
  /**
   * Fan every window into a facing grid, or put them back where they were.
   * Omit `on` to toggle; returns whether the overview is now up.
   */
  expose(on?: boolean): boolean;
  /** Swing the camera until a window (or constellation) is dead ahead. */
  lookAt(id: string): void;
  lookAtGroup(id: string): void;
  resetView(): void;
  /** Ask the active compositor to mutate the world. */
  patchWorld(patch: Record<string, unknown>): void;
  /** Spawn a celestial body; returns its id (empty string if unsupported). */
  spawnBody(kind: BodyKind): string;
  destroyBody(id: string): void;
  /** Merge a window onto a body so it rides along, or null to release it. */
  attachSurface(surfaceId: string, bodyId: string | null): void;
  /** The bodies currently in the sky. */
  listBodies(): { id: string; kind: BodyKind }[];
  /** Constellations: windows that move and travel as one. */
  linkSurfaces(ids: string[], name?: string, style?: GroupStyle): string;
  unlinkGroup(id: string): void;
  listGroups(): GroupInfo[];
  /** Re-lay-out every open window into a formation. */
  arrange(mode: ArrangeMode): void;
  /**
   * Launch another module by id, optionally with arguments — the OS's exec.
   * Args reach the module's `launch(ctx, args)`, which is how "open this file
   * in the editor" works without the editor being a special case.
   */
  launch(moduleId: string, args?: LaunchArgs): void;
  /** Launch a module so its window materialises at a screen point (drag-drop). */
  launchAt(moduleId: string, x: number, y: number): void;
  /**
   * Open a path with whatever module is registered for its type. Directories
   * go to the file manager, text to the editor. The desktop and file manager
   * both route double-clicks through here rather than deciding themselves.
   */
  openPath(path: string): void;
  /**
   * Every app that could open this path, best first — the "Open With…" menu.
   *
   * Empty means nothing can, which is a thing worth saying out loud rather
   * than handing the file to a text editor and letting it fail.
   */
  handlersFor(path: string): ModuleManifest[];
  /** Open a path with a named module, ignoring the association table. */
  openWith(path: string, moduleId: string): void;
  /**
   * Make `moduleId` the default for this path's type from now on. Pass an
   * empty id to go back to whatever the system would have picked.
   */
  setDefaultApp(path: string, moduleId: string): void;
  /** 3D world position the camera is currently looking at, `dist` units out. */
  focalPoint(dist?: number): Vec3;
  /** Pin bare DOM into the world (desktop icons). */
  mountAnchored(el: HTMLElement, anchor: Vec3): AnchorHandle;
  /** Screen point -> world position at `dist` from the camera. */
  screenToWorld(x: number, y: number, dist: number): Vec3;
  /** Everything currently registered — for launchers, task lists, etc. */
  registry(): ModuleManifest[];
  /** Publish a control into the Settings app. */
  defineSetting(def: SettingDef): void;
  settings(): SettingDef[];
  /** Publish a verb into the command palette. */
  defineCommand(cmd: Command): void;
  commands(): Command[];
  /**
   * Say something in the corner of the void. Pass options instead of a kind to
   * attach an offer to act on it.
   */
  notify(text: string, kind?: NotifyKind | NotifyOptions): void;
  /** Live render telemetry, for the Vitals app. */
  stats(): CompositorStats;

  /* ---------------- processes and the journal ---------------- */

  /** Everything currently running — daemons included. Also readable as /proc. */
  ps(): ProcInfo[];
  /**
   * Terminate a process by pid. Returns false when refused: daemons and the
   * kernel decline, the way init does.
   */
  kill(pid: number): boolean;
  /**
   * Write to the system journal, tagged with the calling module's id. Survives
   * for the session and is readable as /var/log/system.log, which is where it
   * differs from console.log.
   */
  log(msg: string, level?: LogLevel): void;
  /** Read the journal back — for the Journal app and notification history. */
  journal(): LogEntry[];
  /** Milliseconds since the kernel booted. */
  uptime(): number;
}
