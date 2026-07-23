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
  /** Bring an existing surface back to the user and focus it (singleton re-launch). */
  focusSurface?(id: string): void;
  /** The world can be mutated by modules (fog, sky, gravity...). Free-form. */
  applyWorldPatch?(patch: Record<string, unknown>): void;
  /** Spawn a celestial body. Returns its id. */
  spawnBody?(kind: BodyKind): string;
  /** Anchor a surface onto a body so it rides along, or pass null to release it. */
  attachSurface?(surfaceId: string, bodyId: string | null): void;
  /** Everything currently orbiting out there. */
  listBodies?(): { id: string; kind: BodyKind }[];
  /** Per-frame hook if the compositor animates. */
  start?(): void;
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
  /**
   * If false, launching again spawns another instance. Defaults to true:
   * re-launching a running app focuses the existing window instead of cloning it.
   */
  singleton?: boolean;
  version?: string;
}

export interface VoidModule {
  manifest: ModuleManifest;
  /** Called when the kernel loads the module. Register listeners, services, etc. */
  activate(ctx: KernelContext): void | (() => void);
  /**
   * For "app" modules: called when the user launches it. Usually opens a surface.
   * Optional so world/service modules can omit it.
   */
  launch?(ctx: KernelContext): void;
}

/** A tiny typed event. Modules talk through this, never to each other directly. */
export interface KernelEvent<T = unknown> {
  type: string;
  payload?: T;
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
  /** Launch another module by id (e.g. terminal launching a viewer). */
  launch(moduleId: string): void;
  /** Everything currently registered — for launchers, task lists, etc. */
  registry(): ModuleManifest[];
}
