# voidshell module SDK

The complete surface a module may use. If it isn't here, it isn't public — reaching around this contract into `Kernel`, `ThreeCompositor` or another module's internals is the one thing that will get a change rejected.

**Source of truth:** `packages/ui/src/kernel/types.ts`. This document explains it; that file defines it. If they disagree, the file wins and this document is a bug.

---

## 1. What a module is

Everything in voidshell is a module: apps, world effects, system services. There is no other kind of thing.

```ts
export interface VoidModule {
  manifest: ModuleManifest;
  activate(ctx: KernelContext): void | (() => void);
  launch?(ctx: KernelContext, args?: LaunchArgs): void;
  handles?: string[];
  fallback?: boolean;
  priority?: number;
}
```

| Field | Meaning |
|---|---|
| `manifest` | Identity. See below. |
| `activate` | Called once when the module loads. Register listeners, settings, commands, services. **Return a function to undo all of it.** |
| `launch` | Called when the user opens it. Usually opens a surface. Required for `kind: "app"`. |
| `handles` | File extensions this module opens, lowercase, no dot. `"dir"` is the pseudo-extension for directories. |
| `fallback` | Take unclaimed **text** files when nothing else names their extension. Never offered for binary or directories. |
| `priority` | Tie-break when several modules handle a type; higher wins. |

### The manifest

```ts
interface ModuleManifest {
  id: string;                            // unique; the launch/exec key
  name: string;                          // human label
  kind: "app" | "world" | "service";     // "app" shows in the launcher
  glyph?: string;                        // one character for the radial launcher
  blurb?: string;                        // one line for the drawer and palette
  singleton?: boolean;                   // default true
  version?: string;
}
```

`kind` decides two things: `"app"` appears in the launcher and only becomes a process when launched; `"world"` and `"service"` become daemons the moment they activate and **cannot be killed**.

`singleton` defaults to **true** — re-launching focuses the existing window instead of cloning it. Launching *with args* bypasses this, which is what makes "open this file" work.

### The cleanup return is not optional in spirit

```ts
activate(ctx) {
  const off = ctx.on("something", handler);
  const timer = setInterval(tick, 1000);
  return () => { off(); clearInterval(timer); };
}
```

A module that leaks its listeners is invisible until it is unloaded and its handlers keep firing against a dead context. Same for `render` — the function it returns runs when the window closes.

---

## 2. KernelContext — the entire syscall surface

Handed to `activate`, `launch`, and every `render`. Deliberately small. Grow it on purpose, never by accident.

### Events (IPC)

```ts
emit(type: string, payload?: unknown): void
on(type: string, handler: (e: KernelEvent) => void): () => void   // returns unsubscriber
```

Modules **never** talk to each other directly. They talk through this.

### Shared state

```ts
state.get<T>(key: string, fallback: T): T
state.set(key: string, value: unknown): void
state.subscribe(key: string, handler: (value: unknown) => void): () => void
```

Namespace your keys (`"myapp.thing"`). Persisted to the server automatically. Keys starting with `tmp.` are ephemeral and never written.

### Filesystem

```ts
fs.ls(path): FsEntry[]
fs.read(path): string          // throws if missing
fs.write(path, content): void
fs.mkdir(path) / fs.mkdirp(path)
fs.rm(path, recursive?)
fs.mv(from, to)
fs.stat(path): FsEntry
fs.exists(path): boolean
fs.isDir(path): boolean
fs.onChange(fn): () => void    // any mutation; for refreshing views
fs.usage(): { files, dirs, bytes, indexed }
fs.mounts(): MountInfo[]
```

```ts
interface FsEntry {
  name: string; path: string; kind: "file" | "dir";
  size: number; readonly: boolean; mtime: number;
  omitted?: "binary" | "toolarge";
  meta?: Record<string, string>;
}
```

Layout: `/home/void` is writable and persisted. `/projects` is a read-only mount of real source. `/proc`, `/dev`, `/etc`, `/var/log` are generated and computed per read.

### Windows

```ts
openSurface(req: SurfaceRequest): Surface
closeSurface(id: string): void
setTitle(surfaceId: string, title: string): void
openSurfaces(): { id, title, moduleId }[]
focusSurface(id): void
activeSurface(): string | null
expose(on?: boolean): boolean     // overview; omit to toggle, returns new state
lookAt(id) / lookAtGroup(id) / resetView()
```

```ts
interface SurfaceRequest {
  title: string;
  width?: number;                          // default 420
  height?: number;                         // default 300
  position?: Partial<Vec3>;
  render: (root: HTMLElement, ctx: KernelContext) => void | (() => void);
}
```

`render` gets a live element to fill and returns optional cleanup. **Call `setTitle` whenever the document changes** — an app that holds a file and never retitles goes stale in the title bar, the compass and the palette at once.

Hard cap of 24 open surfaces, enforced by the kernel.

### Launching and file routing

```ts
launch(moduleId: string, args?: LaunchArgs): void     // exec
launchAt(moduleId: string, x: number, y: number): void
openPath(path: string): void                          // route by association
handlersFor(path: string): ModuleManifest[]           // "Open With…", best first; [] means nothing can
openWith(path: string, moduleId: string): void
setDefaultApp(path: string, moduleId: string): void
registry(): ModuleManifest[]
```

`LaunchArgs` is `{ path?: string; [key: string]: unknown }`. `path` is the conventional one. Args must be JSON-serialisable to survive session restore.

### Settings

Settings are a **registry, not a screen**. Publish a control and it appears in the Settings app automatically.

```ts
defineSetting(def: SettingDef): void
settings(): SettingDef[]
```

```ts
interface SettingDef {
  key: string;          // namespaced store key, e.g. "myapp.enabled"
  label: string;
  kind: "toggle" | "slider" | "select" | "color" | "action" | "custom";
  group: string;        // "Appearance" | "Launcher" | "World" | "System" | "Links" | "Apps"
  hint?: string;
  order?: number;       // lower floats to the top; default 100
  default?: unknown;    // seeded into the store on first run
  min?, max?, step?, unit?              // slider
  options?: { value, label }[]          // select
  run?: (ctx) => void                   // action
  render?: (root, ctx) => void | (() => void)  // custom
}
```

Adding a knob never means editing the settings UI. If you find yourself editing the settings app, you are doing it wrong.

### Commands (palette)

```ts
defineCommand(cmd: Command): void
commands(): Command[]
```

```ts
interface Command { id: string; label: string; hint?: string; glyph?: string; run: (ctx) => void; }
```

### Notifications

```ts
notify(text: string, kind?: NotifyKind | NotifyOptions): void
```

```ts
type NotifyKind = "info" | "good" | "warn";
interface NotifyOptions {
  kind?: NotifyKind;
  action?: { label: string; run: (ctx) => void };
  sticky?: boolean;   // defaults true for "warn" and for anything with an action
}
```

**A warning without an offer to fix it is a bug.** If you can tell the user what went wrong, you can usually give them a button.

### Processes and the journal

```ts
ps(): ProcInfo[]
kill(pid: number): boolean          // false = refused (daemons, kernel)
log(msg: string, level?: LogLevel)  // tagged with your module id; readable at /var/log/system.log
journal(): LogEntry[]
uptime(): number                    // ms since boot
```

A launch is a process. Closing its last window is how it exits — derived from surface ownership, never tracked separately.

### The world (compositor-dependent)

Every one of these degrades safely if the active compositor doesn't implement it.

```ts
patchWorld(patch: Record<string, unknown>): void
spawnBody(kind: BodyKind): string          // "sun"|"moon"|"planet"|"singularity"; "" if unsupported
destroyBody(id): void
attachSurface(surfaceId, bodyId | null): void
listBodies(): { id, kind }[]
linkSurfaces(ids, name?, style?): string   // constellations
unlinkGroup(id) / listGroups(): GroupInfo[]
arrange(mode: "arc" | "ring" | "wall" | "scatter"): void
focalPoint(dist?): Vec3
mountAnchored(el: HTMLElement, anchor: Vec3): AnchorHandle
screenToWorld(x, y, dist): Vec3
stats(): { fps, panels, bodies, groups }
```

**Nothing above knows Three.js exists.** Modules render DOM; the compositor gives it a body in space. That is why swapping the compositor changes the universe without touching a module.

---

## 3. Modules loaded at runtime

Since PR #44, a module can be written to `~/modules/*.js`, loaded, reloaded and unloaded from the **devkit** app without rebuilding.

The reason this works with no import map or shared-runtime plumbing: **`activate(ctx)` takes the kernel as an argument**, so a module imports nothing from the shell and evaluates as a standalone ES module.

```js
export default {
  manifest: { id: "my-thing", name: "my thing", kind: "app", glyph: "◇" },
  activate(ctx) {
    ctx.log("up");
    return () => ctx.log("down");
  },
  launch(ctx) {
    ctx.openSurface({
      title: "my thing",
      render: (root, c) => {
        root.textContent = "hello";
        return () => c.log("closed");
      },
    });
  },
};
```

### Rules

- **JavaScript or TypeScript** — `.js`, `.mjs`, `.ts`, `.mts`. No JSX: it needs a
  factory to compile against, and modules render DOM directly.
- **`export default`.** Named exports are ignored.
- **Import nothing.** No bare specifiers resolve. Everything comes through `ctx`.
- **`kind: "app"` must have `launch()`.** The loader refuses an app with none — it would sit in the launcher doing nothing.
- **Ids must be unique.** Re-loading the same id is treated as an update: the old one is uninstalled first.
- **Built-ins can't be uninstalled.** Only runtime-installed modules may be removed.

### The privileged host

`install` / `uninstall` / `runtimeModules` are **not** on `KernelContext`. They are handed to devkit directly from `main.ts`:

```ts
interface ModuleHost {
  install(mod: VoidModule): string;   // throws on duplicate id; rolls back if activate() throws
  uninstall(id: string): boolean;     // false if built-in or absent
  runtimeModules(): string[];
}
```

Installing modules is not a capability every module should have. Same reasoning as `createPower` receiving `closeAll` from the shell.

### TypeScript

A `.ts` module is compiled by **esbuild-wasm in a worker** (`runtime/tsWorker.ts`),
transform-only — never bundle. There is no graph to walk: a module imports
nothing, which is the property the whole loader rests on. The wasm is ~11MB and
is fetched on the *first* compile, so a session that never opens a `.ts` module
never pays for it.

There is no server-side compile endpoint, and there should not be one. "POST
arbitrary source and we run the compiler on the droplet" is remote code
execution offered as a feature; it would need its own auth design first.

**Types are stripped, not checked.** `const n: number = "no"` compiles clean.
esbuild does no type analysis at all, and the UI says so — in devkit's header and
in the editor's hint — rather than implying a safety that isn't there. Getting
real checking means shipping `typescript` itself, which is a much larger decision
than this was.

**Compiled modules carry a source map, and it is load-bearing.** Stripping types
is *not* line-preserving: seven lines of interfaces above a `throw` move it from
line 16 to line 5. Without the map, every runtime error in a `.ts` module would
be reported against a line the author never wrote — the exact failure
`locateError` exists to prevent. `runtime/sourcemap.ts` translates positions back,
and when it can't answer, the location is **dropped** rather than reported in the
wrong coordinate system.

### Editing one

A writable file under `~/modules` opens in the editor as a **module** rather than
as a script: it gets a **Reload** button (and `^⏎`) instead of a run pane, because
running a module's source through the JS sandbox evaluates an object literal and
prints nothing. Reload saves the buffer, installs it, and reports the result
against the offending line when the runtime gave us one.

The editor does **not** hold `install`. It asks devkit over the bus:

```ts
ctx.emit(RELOAD_REQUEST, { path, nonce });     // editor  → devkit
ctx.on(RELOAD_RESULT, …);                      // devkit  → editor
```

Both constants live in `modules/devkit/protocol.ts`, so a module can speak the
protocol without importing devkit. Every request gets exactly one answer.

**Error locations are best-effort and frequently absent.** Firefox and Safari put
`lineNumber` on a `SyntaxError`; V8 does not, so in Chrome and in Node a module
that fails to *parse* has no locatable line at all. Worse, Node gives such an
error a stack made entirely of its own loader internals — reading the topmost
frame reports a line inside `node:internal/modules/esm/utils` and underlines it
in the author's gutter. `locateError` therefore accepts a frame only if it names
the module's own URL, and returns nothing otherwise. A wrong location is worse
than none.

### Launch surfaces are already live

A module installed after boot appears in the app drawer and the command palette
with no work: **every launch surface rebuilds from `ctx.registry()` each time it
opens.** Nothing listens to `module.installed`, and nothing needs to. The
launcher *ring* is the exception, and correctly so — its nodes are bound slots,
not a listing, so a new module shows up there once you bind it to one.

### What uninstall withdraws

Windows (via the normal close path, so their cleanup runs), the deactivator, every setting and command the module defined, and its daemon process. Setting **values** stay in the store, so re-installing finds your toggles as you left them.

---

## 4. House rules

These are not style preferences. Each one is here because breaking it has already cost a debugging session.

**CSS imports belong in `main.ts`.** esbuild bundles modules to a single outfile; a CSS import from a TypeScript module breaks it. Add `import "./modules/x/x.css";` at the top of `main.ts`.

**Anything hidden with the `hidden` property needs a guard.** If your CSS sets `display` on the element, add `.your-class[hidden] { display: none }`. An author rule outranks the UA stylesheet, so without it `el.hidden = true` silently does nothing and you get an invisible full-screen sheet eating every click. This has shipped once already.

**The smoke harness has three touch points that move together.** When adding a module: `MODULE_COUNT` in `tools/smoke.mts`, the `.register(...)` call in that file, and the `.register(...)` in `main.ts`. Update one and the harness reports green while testing nothing. Registrations in `main.ts` must be **bare identifiers** — the harness counts them with `/\.register\((\w+)\)/`, so `.register(createThing(kernel))` is invisible to it. Bind it to a const first.

**Never push directly to `main`.** Every change is a PR. Branch is tested before merge.

**Verify before pushing.** Typecheck and build (or smoke) must pass locally. The
client harness needs two externals, and the second is easy to miss:

```
npm i --no-save jsdom @types/jsdom
npx esbuild tools/smoke.mts --bundle --platform=node --format=esm \
  --outfile=smoke.mjs --external:jsdom --external:esbuild \
  && node smoke.mjs && rm smoke.mjs
```

`--external:esbuild` because the TypeScript checks compile with the real
compiler; bundled, its `main.js` loses the `__dirname` it uses to find its own
binary and the harness dies on the first transform.
 Numbers get checked against reality — physics against energy conservation, astronomy against published values, chess against perft.

**Read the current branch state before designing a solution.** Two rounds of silent no-ops have happened because a handler was implemented without confirming the call site existed.

**`push_files` has no patch API.** It takes whole files. Pushing a reconstruction from stale local context has silently dropped imports twice, both times in `main.ts`. Fetch the current version first, apply changes by string replacement with assertions on the old string, then push. Verify sizes afterwards.

---

## 5. Where things live

| Path | What |
|---|---|
| `packages/ui/src/kernel/types.ts` | The contract. Source of truth for this document. |
| `packages/ui/src/kernel/Kernel.ts` | Registry, surfaces, settings, commands, session, install/uninstall. |
| `packages/ui/src/main.ts` | Registration, CSS imports, keybinds, session lifecycle. |
| `packages/ui/src/runtime/loadModule.ts` | Source text → live module, and error → line. |
| `packages/ui/src/runtime/tsWorker.ts` | esbuild-wasm, transform-only, off the main thread. |
| `packages/ui/src/runtime/transform.ts` | The compiler's main-thread client. |
| `packages/ui/src/runtime/sourcemap.ts` | Generated position → the line that was written. |
| `packages/ui/src/modules/devkit/protocol.ts` | The editor ↔ devkit reload conversation. |
| `packages/ui/src/runtime/program.ts` | Headless killable JS/Python runner with streaming output. |
| `packages/ui/src/modules/devkit/` | Load, reload, unload modules at runtime. |
| `packages/ui/src/ui/blip.ts` | Shared AudioContext. Do not create your own. |
| `tools/smoke.mts` | Headless harness — boots the real kernel in jsdom. |
