/**
 * What a module is allowed to do.
 *
 * Until now the answer was "everything". `activate(ctx)` hands every module
 * the entire syscall surface, which was exactly right while every module was
 * compiled into the build by the person running it. It stops being right the
 * moment modules arrive at runtime — from `~/modules`, from an agent, from a
 * paste — because the loader cannot tell a lava lamp from something that
 * enumerates `/projects` and writes it somewhere.
 *
 * The mechanism is deliberately small and deliberately honest:
 *
 * - A manifest may declare `permissions`. If it does, that list is the whole
 *   of what it gets, and every other syscall throws `CapabilityError`.
 * - A manifest that declares nothing is trusted, exactly as before, unless the
 *   user turns on strict mode — at which point it gets `SAFE_DEFAULT` and
 *   nothing else. Zero regression by default, a real fence when asked for.
 * - Modules compiled into the shell are never restricted. They are the shell.
 *
 * ## What this does not claim to do
 *
 * A module is still ordinary JavaScript on the page. It can call `fetch`, read
 * `document`, and reach anything else the browser gives a script. **This is not
 * a sandbox and must not be described as one.** It fences the *kernel* — the
 * filesystem, the window table, the process table, the settings registry, the
 * privileged half of the event bus — which is the part that holds the user's
 * files and the part a module has no other route to. Fencing the rest needs an
 * iframe or a worker, which is a different and much larger change; this is the
 * half that can be done without moving every module into one.
 *
 * Named accordingly: `restrict`, not `sandbox`.
 */

import type { KernelContext } from "./types";

/**
 * Every capability, in the order they're worth reading.
 *
 * Kept as a const tuple so the type is derived from the list rather than
 * declared next to it — the two cannot drift apart, and `parsePermissions`
 * validates against the same array the type came from.
 */
export const CAPABILITIES = [
  "fs.read",
  "fs.write",
  "state.write",
  "surface",
  "world",
  "launch",
  "process",
  "shell",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** One line each, for `/proc/permissions` and for anything that asks a user. */
export const CAPABILITY_BLURBS: Record<Capability, string> = {
  "fs.read": "read your files and list directories",
  "fs.write": "create, change and delete your files",
  "state.write": "change system and app settings values",
  surface: "open windows and move the view",
  world: "spawn bodies, link windows, rearrange the void",
  launch: "start other apps and open files with them",
  process: "kill running processes",
  shell: "publish settings and commands, raise notices, ask the shell to act",
};

/**
 * Event prefixes that are requests to the shell rather than module chatter.
 *
 * `shell.factoryReset` erases the workspace and `shell.signOut` ends the
 * session — both reachable from `emit`, which every module has. Gating the
 * whole bus would be worse than useless (a module that cannot publish cannot
 * cooperate with anything), so only the privileged half is fenced and ordinary
 * events stay open.
 */
export const PRIVILEGED_EVENTS = ["shell.", "system."] as const;

/**
 * What an undeclared module gets when strict mode is on.
 *
 * Windows and nothing else. An app that cannot open a surface cannot show the
 * user why it is broken, so this is the floor below which restriction stops
 * being a policy and starts being a crash.
 */
export const SAFE_DEFAULT: readonly Capability[] = ["surface"];

/** Settings key for strict mode. Read live, so flipping it takes effect at once. */
export const STRICT_KEY = "security.strictModules";

/** Refused at the kernel boundary. Carries enough to say what to add to the manifest. */
export class CapabilityError extends Error {
  readonly moduleId: string;
  readonly capability: Capability;

  constructor(moduleId: string, capability: Capability, what: string) {
    super(
      `${moduleId}: not permitted to ${what} — add "${capability}" to ` +
        `manifest.permissions (it would let this module ${CAPABILITY_BLURBS[capability]})`
    );
    this.name = "CapabilityError";
    this.moduleId = moduleId;
    this.capability = capability;
  }
}

export function isCapability(value: unknown): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value as string);
}

/**
 * Read a manifest's `permissions`, or say it didn't declare any.
 *
 * `null` means undeclared, which is a different fact from `[]` — the empty
 * array is a module asking for nothing at all, and honouring that is how a
 * genuinely inert module proves it is inert. Anything malformed throws rather
 * than being quietly dropped: a typo'd capability that silently became "no
 * permission" would present as the module mysteriously failing at runtime,
 * and the author would have no reason to suspect the manifest.
 */
export function parsePermissions(
  moduleId: string,
  raw: unknown
): Capability[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new Error(
      `${moduleId}: manifest.permissions must be an array of capabilities, got ${typeof raw}`
    );
  }
  const bad = raw.filter((c) => !isCapability(c));
  if (bad.length) {
    throw new Error(
      `${moduleId}: unknown permission${bad.length === 1 ? "" : "s"} ` +
        `${bad.map((b) => JSON.stringify(b)).join(", ")} — ` +
        `valid ones are ${CAPABILITIES.join(", ")}`
    );
  }
  // Deduplicated and put in a stable order so `/proc/permissions` and the
  // journal read the same for two manifests that asked for the same things.
  return CAPABILITIES.filter((c) => (raw as Capability[]).includes(c));
}

/** What one module declared, and what it actually gets. Backs `/proc/permissions`. */
export interface ModulePermissions {
  id: string;
  /** False for modules the shell was compiled with. Those are never fenced. */
  runtime: boolean;
  /** What the manifest asked for, or null when it asked for nothing. */
  declared: Capability[] | null;
  /** What it gets, or null when it is trusted outright. */
  granted: Capability[] | null;
  /**
   * Where the source came from, when it did not come from here.
   *
   * Reported because it is the *reason* for the fence around a fetched module,
   * and a fence whose reason cannot be seen is one people work around.
   */
  origin?: string;
}

/**
 * `/proc/permissions`, rendered.
 *
 * Lives here rather than in sysfs so that the one place that knows what a
 * capability *is* is also the place that decides how to say so — a second
 * vocabulary for the same facts is how "granted" and "declared" end up meaning
 * different things in two windows.
 */
export function formatPermissions(rows: ModulePermissions[]): string {
  const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
  const width = Math.max(6, ...rows.map((r) => r.id.length)) + 2;

  const body = rows.map((r) => {
    const origin = r.origin ? "fetched" : r.runtime ? "runtime" : "built-in";
    const what =
      r.granted === null
        ? r.runtime
          ? "unrestricted (declared nothing)"
          : "unrestricted"
        : r.granted.length
          ? r.granted.join(" ")
          : "(nothing)";
    const from = r.origin ? `\n${" ".repeat(width)}          from ${r.origin}` : "";
    return `${pad(r.id, width)}${pad(origin, 10)}${what}${from}`;
  });

  return [
    `${pad("MODULE", width)}${pad("ORIGIN", 10)}ALLOWED`,
    ...body,
    "",
    "# built-in modules are the shell and are never restricted.",
    "# a runtime module with no manifest.permissions is trusted unless",
    `# ${STRICT_KEY} is on, which drops it to: ${SAFE_DEFAULT.join(" ")}`,
    "# a *fetched* module never gets that benefit of the doubt: with no",
    `# declaration it is held to ${SAFE_DEFAULT.join(" ")} whatever that setting says.`,
    "#",
    ...CAPABILITIES.map((c) => `# ${pad(c, 14)}${CAPABILITY_BLURBS[c]}`),
    "",
  ].join("\n");
}

export interface RestrictOptions {
  moduleId: string;
  /**
   * What this module may do, resolved on *every call*.
   *
   * A thunk rather than a set because a module holds the context it was
   * activated with for its whole life. Resolving grants once at wrap time
   * would mean turning strict mode on had no effect until reload, which is
   * the kind of security control that is worse than none: it reports a state
   * the system is not in. Returning `null` means trusted, and passes through.
   */
  granted(): ReadonlySet<Capability> | null;
  /** Called the first time each distinct capability is refused. */
  onDenied?(err: CapabilityError): void;
}

/**
 * A context that refuses what the module didn't ask for.
 *
 * Explicit rather than a `Proxy`: the wrapped surface is the syscall surface,
 * and a list of it that the typechecker validates against `KernelContext` is
 * the thing that fails loudly when a capability is added to the kernel and
 * nobody decides which permission it belongs under. A proxy would silently
 * pass new syscalls straight through, which is precisely the failure this
 * exists to prevent.
 */
export function restrict(ctx: KernelContext, opts: RestrictOptions): KernelContext {
  const { moduleId } = opts;
  /** One complaint per capability per context, so a loop can't storm the HUD. */
  const complained = new Set<Capability>();

  const deny = (cap: Capability, what: string): never => {
    const err = new CapabilityError(moduleId, cap, what);
    if (!complained.has(cap)) {
      complained.add(cap);
      opts.onDenied?.(err);
    }
    throw err;
  };

  const need = <T>(cap: Capability, what: string, run: () => T): T => {
    const granted = opts.granted();
    return !granted || granted.has(cap) ? run() : deny(cap, what);
  };

  return {
    ...ctx,

    /* ---------------- the bus ---------------- */

    // Subscribing stays open: listening reveals nothing a module could not
    // already infer, and a module that cannot listen cannot react to the
    // system at all.
    emit: (type, payload) => {
      if (PRIVILEGED_EVENTS.some((p) => type.startsWith(p))) {
        return need("shell", `emit "${type}"`, () => ctx.emit(type, payload));
      }
      ctx.emit(type, payload);
    },

    /* ---------------- state ---------------- */

    // Reads are deliberately open, and this is a real limit worth naming: the
    // store is one flat namespace, so gating reads would also gate a module
    // reading back its *own* keys. Writes are where the damage is.
    state: {
      get: <T,>(key: string, fallback: T): T => ctx.state.get(key, fallback),
      set: (key, value) =>
        need("state.write", `set "${key}"`, () => ctx.state.set(key, value)),
      subscribe: (key, handler) => ctx.state.subscribe(key, handler),
    },

    /* ---------------- the filesystem ---------------- */

    fs: {
      ls: (p) => need("fs.read", `list ${p}`, () => ctx.fs.ls(p)),
      read: (p) => need("fs.read", `read ${p}`, () => ctx.fs.read(p)),
      stat: (p) => need("fs.read", `stat ${p}`, () => ctx.fs.stat(p)),
      exists: (p) => need("fs.read", `test ${p}`, () => ctx.fs.exists(p)),
      isDir: (p) => need("fs.read", `test ${p}`, () => ctx.fs.isDir(p)),
      usage: () => need("fs.read", "measure the filesystem", () => ctx.fs.usage()),
      mounts: () => need("fs.read", "list mounts", () => ctx.fs.mounts()),
      onChange: (fn) => need("fs.read", "watch the filesystem", () => ctx.fs.onChange(fn)),

      write: (p, c) => need("fs.write", `write ${p}`, () => ctx.fs.write(p, c)),
      mkdir: (p) => need("fs.write", `create ${p}`, () => ctx.fs.mkdir(p)),
      mkdirp: (p) => need("fs.write", `create ${p}`, () => ctx.fs.mkdirp(p)),
      rm: (p, r) => need("fs.write", `delete ${p}`, () => ctx.fs.rm(p, r)),
      mv: (a, b) => need("fs.write", `move ${a} to ${b}`, () => ctx.fs.mv(a, b)),
    },

    /* ---------------- windows ---------------- */

    openSurface: (req) => need("surface", "open a window", () => ctx.openSurface(req)),
    closeSurface: (id) => need("surface", "close a window", () => ctx.closeSurface(id)),
    setTitle: (id, title) => need("surface", "retitle a window", () => ctx.setTitle(id, title)),
    openSurfaces: () => need("surface", "list open windows", () => ctx.openSurfaces()),
    focusSurface: (id) => need("surface", "focus a window", () => ctx.focusSurface(id)),
    activeSurface: () => need("surface", "read the focused window", () => ctx.activeSurface()),
    expose: (on) => need("surface", "show every window", () => ctx.expose(on)),
    lookAt: (id) => need("surface", "move the camera", () => ctx.lookAt(id)),
    lookAtGroup: (id) => need("surface", "move the camera", () => ctx.lookAtGroup(id)),
    resetView: () => need("surface", "move the camera", () => ctx.resetView()),
    mountAnchored: (el, anchor) =>
      need("surface", "pin DOM into the world", () => ctx.mountAnchored(el, anchor)),

    /* ---------------- the world ---------------- */

    patchWorld: (patch) => need("world", "change the world", () => ctx.patchWorld(patch)),
    spawnBody: (kind, orbitCenter) =>
      need("world", "spawn a body", () => ctx.spawnBody(kind, orbitCenter)),
    destroyBody: (id) => need("world", "destroy a body", () => ctx.destroyBody(id)),
    attachSurface: (sid, bid) =>
      need("world", "attach a window to a body", () => ctx.attachSurface(sid, bid)),
    listBodies: () => need("world", "list bodies", () => ctx.listBodies()),
    spawnStation: (kind, name, position) =>
      need("world", "found a station", () => ctx.spawnStation(kind, name, position)),
    listStations: () => need("world", "list stations", () => ctx.listStations()),
    renameStation: (id, name) =>
      need("world", "rename a station", () => ctx.renameStation(id, name)),
    destroyStation: (id) => need("world", "destroy a station", () => ctx.destroyStation(id)),
    travelTo: (id) => need("world", "travel to a station", () => ctx.travelTo(id)),
    travelHome: () => need("world", "travel home", () => ctx.travelHome()),
    dockSurface: (sid, stid) =>
      need("world", "dock a window onto a station", () => ctx.dockSurface(sid, stid)),
    orbitSurface: (sid, bid) =>
      need("world", "send a window into orbit", () => ctx.orbitSurface(sid, bid)),
    currentStation: () =>
      need("world", "read the current station", () => ctx.currentStation()),
    linkSurfaces: (ids, name, style) =>
      need("world", "link windows", () => ctx.linkSurfaces(ids, name, style)),
    unlinkGroup: (id) => need("world", "unlink a constellation", () => ctx.unlinkGroup(id)),
    listGroups: () => need("world", "list constellations", () => ctx.listGroups()),
    arrange: (mode) => need("world", "rearrange every window", () => ctx.arrange(mode)),
    // Reading a layout is as much "where is everything" as `listGroups`, but
    // applying one moves other modules' windows through space, and gating only
    // half of a pair is how a fence acquires a gap. Both sit under `world`,
    // which is already what "rearrange the void" means.
    captureLayout: (ids) =>
      need("world", "read where windows sit", () => ctx.captureLayout(ids)),
    applyLayout: (layout, ids) =>
      need("world", "move windows into a saved arrangement", () =>
        ctx.applyLayout(layout, ids)
      ),

    /* ---------------- running other things ---------------- */

    launch: (id, args) => need("launch", `launch "${id}"`, () => ctx.launch(id, args)),
    launchAt: (id, x, y) => need("launch", `launch "${id}"`, () => ctx.launchAt(id, x, y)),
    openPath: (p) => need("launch", `open ${p}`, () => ctx.openPath(p)),
    openWith: (p, id) => need("launch", `open ${p}`, () => ctx.openWith(p, id)),
    setDefaultApp: (p, id) =>
      need("launch", "change the default app for a file type", () => ctx.setDefaultApp(p, id)),

    /* ---------------- processes ---------------- */

    // `ps` stays open — it is the same information `/proc` already gives to
    // anything that can read a file, and refusing it here while `cat` allows
    // it would be a fence with a gate next to it.
    kill: (pid) => need("process", `kill pid ${pid}`, () => ctx.kill(pid)),

    /* ---------------- talking to the user ---------------- */

    defineSetting: (def) =>
      need("shell", "publish a setting", () => ctx.defineSetting(def)),
    defineCommand: (cmd) =>
      need("shell", "publish a command", () => ctx.defineCommand(cmd)),
    notify: (text, kind) => need("shell", "raise a notice", () => ctx.notify(text, kind)),
  };
}
