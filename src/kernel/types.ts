/**
 * The contracts every part of voidshell speaks.
 *
 * The whole point of this file: the kernel knows about Modules and Surfaces.
 * It does NOT know about Three.js, DOM, or how anything is drawn. That job
 * belongs to whatever Compositor is installed. Swap the compositor and the
 * same modules render in a completely different world.
 */

/** A 3D-ish position in the void. Compositors decide what the units mean. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** The kinds of celestial body the world can hold. */
export type BodyKind = "sun" | "moon" | "planet";

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

/**
 * A Compositor is the render backend. Everything visual is delegated here,
 * which is how "the renderer is a plugin" actually works. Ship a Three.js one,
 * a plain-DOM one, a WebGPU one later — the kernel never changes.
 */
export interface Compositor {
  readonly name: string;
  /** Called once at boot with the mount points. */
  init(mounts: { gl: HTMLElement; overlay: HTMLElement }): void | Promise<void>;
  /** Give a surface a body in the world. Returns a disposer. */
  mountSurface(surface: Surface): () => void;
  /** The world can be mutated by modules (fog, sky, gravity...). Free-form. */
  applyWorldPatch?(patch: Record<string, unknown>): void;
  /** Spawn a celestial body. Returns its id. */
  spawnBody?(kind: BodyKind): string;
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
  /** Raise a surface above its depth-sorted neighbours (click-to-focus). */
  focusSurface?(id: string): void;
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
   * The kernel builds its association table from these. `"*"` means "will
   * take anything", used as the fallback opener.
   */
  handles?: string[];
}

/** A tiny typed event. Modules talk through this, never to each other directly. */
export interface KernelEvent<T = unknown> {
  type: string;
  payload?: T;
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
}

export interface FsEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  size: number;
  readonly: boolean;
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
  /** Shared reactive state (the OS's shared memory). */
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
  /** Every surface currently open — for launchers, task lists, merge pickers. */
  openSurfaces(): { id: string; title: string }[];
  /** Ask the active compositor to mutate the world. */
  patchWorld(patch: Record<string, unknown>): void;
  /** Spawn a celestial body; returns its id (empty string if unsupported). */
  spawnBody(kind: BodyKind): string;
  /** Merge a window onto a body so it rides along, or null to release it. */
  attachSurface(surfaceId: string, bodyId: string | null): void;
  /** The bodies currently in the sky. */
  listBodies(): { id: string; kind: BodyKind }[];
  /**
   * Launch another module by id, optionally with arguments — the OS's exec.
   * Args reach the module's `launch(ctx, args)`, which is how "open this file
   * in the editor" works without the editor being a special case.
   */
  launch(moduleId: string, args?: LaunchArgs): void;
  /**
   * Open a path with whatever module is registered for its type. Directories
   * go to the file manager, text to the editor. The desktop and file manager
   * both route double-clicks through here rather than deciding themselves.
   */
  openPath(path: string): void;
  /** 3D world position the camera is currently looking at, `dist` units out. */
  focalPoint(dist?: number): Vec3;
  /** Pin bare DOM into the world (desktop icons). */
  mountAnchored(el: HTMLElement, anchor: Vec3): AnchorHandle;
  /** Screen point -> world position at `dist` from the camera. */
  screenToWorld(x: number, y: number, dist: number): Vec3;
  /** Raise a window above its neighbours. */
  focusSurface(id: string): void;
  /** Everything currently registered — for launchers, task lists, etc. */
  registry(): ModuleManifest[];
}
