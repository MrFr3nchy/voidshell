# voidshell

A spatial WebOS **core**. Not a desktop — a place. You float inside a
shader-lit void where apps crystallize into 3D space as glass panels. There's
no taskbar; you summon a constellation of apps and pick one.

This is the kernel and its first render backend, built to be torn apart and
extended. Rename it, gut the modules, replace the compositor — that's the point.

## Run it

```bash
npm install
npm run dev      # opens http://localhost:5173
```

Other scripts: `npm run build`, `npm run preview`, `npm run typecheck`. There's
also a headless smoke harness in `tools/smoke.mts` that boots the whole kernel
and every module against a stub compositor — see the header of that file for the
two commands to run it.

## Driving it

| gesture | what happens |
| --- | --- |
| drag the void | look around |
| **space** | summon / dismiss the launcher ring |
| **⌘/ctrl + K** | command palette — apps, verbs and open windows in one list |
| **⌘/ctrl + shift + A** | all apps |
| **⌘/ctrl + ,** | settings |
| **home** | recentre the view |
| drag a title bar | move a window through space |
| scroll a window | push it away / pull it closer |
| drag the corner grip | resize |
| drag **⁙** onto another window | bind them into a constellation |
| drag **⁙** onto a celestial body | merge — the window rides that orbit |
| drag **⁙** onto a singularity | the window is eaten |
| drag a launcher node into the void | open that app exactly where you drop it |
| drag an app from All Apps onto a node | rebind that node |

Nothing is ever lost. Any window that drifts out of view puts a chevron on the
edge of the screen pointing at it — click it and the void rotates until you're
facing it again. Constellations report as one destination instead of four.

## The mental model

Three things, and they barely know about each other:

1. **The kernel** (`src/kernel/`) — the entire OS. It owns the module registry,
   the surface (window) table, the settings and command registries, an event bus,
   and shared state. It renders *nothing*. Like a microkernel, everything
   interesting lives outside it.

2. **The compositor** (`src/compositor/`) — the render backend. The kernel hands
   it abstract *surfaces* and says "give this a body." How it does that — WebGL,
   DOM, WebGPU — is entirely the compositor's business. `ThreeCompositor` is the
   spectacle one. Swapping it is **one line** in `src/main.ts`.

3. **Modules** (`src/modules/`) — the unit of everything. An app, a theme, a
   world effect, a background service: all the same contract. They never import
   each other. They talk through the event bus and shared state, so any one can
   be yanked out without the rest noticing.

### Why the panels aren't in WebGL

Live web content **cannot live inside WebGL** — you can't texture-map an
interactive `<iframe>` into a 3D scene and keep it interactive. So the world
(nebula, dust, celestial bodies) is drawn in WebGL, while every panel is
ordinary DOM in an overlay whose screen position is recomputed each frame by
projecting its 3D anchor through the camera. Clicks stay exact, text stays
selectable, and "merging a window onto a planet" is just anchoring it to that
planet's position.

## Settings are a registry, not a screen

Nothing hardcodes the settings UI. A module publishes a control and it appears:

```ts
ctx.defineSetting({
  key: "world.dust",        // a plain store key
  label: "dust motes",
  kind: "slider",           // toggle | slider | select | color | action | custom
  group: "World",           // becomes a tab
  default: 1400, min: 0, max: 5000, step: 100,
});

ctx.state.subscribe("world.dust", (v) => ctx.patchWorld({ dust: Number(v) }));
```

The Settings app walks that registry and builds a control for whatever it finds,
so adding a knob never means editing the settings screen. `kind: "custom"` hands
you a DOM node when a slider won't do — that's how the drag-to-reorder launcher
slot editor lives inside the same list as the checkboxes.

Everything written through `ctx.state` (except the `tmp.` namespace) is mirrored
to `localStorage` on a debounce. That single mechanism is the whole persistence
story: settings, launcher bindings, saved dashboards, notes and window layout
all ride on it for free.

## Constellations

A dashboard is several windows that agree to be one thing. Drag any member and
the whole group travels; light threads draw between them; the compass reports
them once, by name. Bind them with the **⁙** handle or from the Dashboards app,
and save the arrangement — a saved dashboard is just a name and a list of apps,
so it survives a reload and re-assembles itself on demand.

## Writing a module

A module is an object with a manifest and an `activate`. If it's an app, it also
has a `launch` that usually opens a surface. That's it.

```ts
import type { VoidModule } from "../../kernel/types";

export const hello: VoidModule = {
  manifest: { id: "hello", name: "Hello", kind: "app", glyph: "✶" },
  activate() {},
  launch(ctx) {
    ctx.openSurface({
      title: "hello",
      render: (root) => {
        root.textContent = "hi from the void";
      },
    });
  },
};
```

Register it in `src/main.ts` with `kernel.register(hello)` and it appears in the
launcher, the app drawer and the command palette — no other file changes.

### The syscall surface (`KernelContext`)

Everything a module can do, deliberately small:

- `emit` / `on` — the OS's IPC
- `state.get/set/subscribe` — shared memory, persisted
- `fs.*` — the filesystem (see below)
- `openSurface` / `closeSurface` / `openSurfaces` / `focusSurface`
- `lookAt` / `lookAtGroup` / `resetView` / `arrange` — move the viewer, not the windows
- `linkSurfaces` / `unlinkGroup` / `listGroups` — constellations
- `spawnBody` / `destroyBody` / `attachSurface` / `listBodies` — the sky
- `mountAnchored` / `focalPoint` / `screenToWorld` — pin bare DOM into the void
- `patchWorld` — ask the compositor to mutate the environment
- `defineSetting` / `defineCommand` — publish into the shell's registries
- `notify` — say something in the corner of the void
- `launch` / `launchAt` / `registry` — reach other modules
- `openPath(path)` — route a file to whichever module `handles` its extension

`kind: "app"` shows in the launcher. `kind: "world"` and `kind: "service"` stay
invisible — daemons. **Aurora** is worth reading: it owns every colour in the
build and exposes them purely as registered settings, which is how "theme"
becomes a *program* instead of a hardcoded palette.

## The filesystem

`src/kernel/vfs.ts` is a single tree assembled from mounts, reached by modules
through `ctx.fs`. Two mounts ship:

| mount | mode | backing |
| --- | --- | --- |
| `/home/void` | read-write | localStorage, debounced on change |
| `/projects` | read-only | build-time scan of the sibling project dirs |

Permissions live on the *node*, not on a path prefix, so a mount carries its own
rules wherever it's grafted in. Writing to `/projects` fails with `EROFS` the way
a real read-only mount does, rather than silently no-op'ing.

### How `/projects` gets there

`plugins/projects.ts` is a Vite plugin with two modes behind one API:

- **dev** — serves a live scan at `/__vs/projects.json`, so editing a file on
  disk shows up in the shell on reload.
- **build** — freezes the same scan into the bundle, because the deployed site
  is static and has no disk to read.

Text files are embedded whole under a 128KB cap. Binaries are indexed by name
and size but never embedded — that's what keeps a 27MB asset folder from
becoming a 27MB download. Classification is a binary-extension *denylist*, not a
text allowlist, so unguessable text files (`.firebaserc`, `.gql`) stay readable;
a NUL-byte check catches anything mislabeled.

Point it somewhere else with `voidshellProjects({ root: "/some/path" })` in
`vite.config.ts`. It defaults to the parent of the Vite root.

### The shell

The console is a real shell over that FS: `cd` / `ls -l` / `cat` / `tree` /
`find`, plus `mkdir`, `rm -r`, `mv`, `touch`, output redirection with `>`, `&&`
chaining, and arrow-key history. It holds no privileges the syscall surface
doesn't already grant every module.

## The desktop

One idea carries the whole thing: **the desktop is a directory**. Icons are
`/home/void/Desktop` drawn into the void, so dragging a file to the desktop is
an ordinary `mv` and needs no special case. Delete the file in the console and
its icon vanishes, because the shell and the desktop read the same tree.

Icons are anchored in 3D like windows, not pinned to a flat HUD — one coherent
world rather than a 2D layer pasted over a 3D scene. Positions persist in
`/home/void/.desktop-layout.json`, the way a real OS keeps its layout beside the
directory it describes.

| gesture | result |
| --- | --- |
| right-click void | New Folder · New File · Paste · Open Console Here · Tidy Icons |
| right-click icon | Open · Rename · Copy · Cut · Delete |
| drag icon | reposition in space, persisted |
| double-click | open in the associated app |
| drag a row out of Files | drop onto the void to put it on the desktop |
| drag onto the Files list | move it into that directory |
| click a window | raises it above its neighbours |
| drag a window's right/bottom edge or corner | resize it |
| `Delete` / `Enter` | delete or open the selected icon |

Resizing accounts for the 3D projection twice over: a drag of N screen pixels is
N/scale *logical* pixels, since panels are drawn smaller with distance; and
because a panel is centred on its anchor, the anchor shifts by half the growth
so the top-left corner stays pinned where you see it instead of the window
expanding in both directions.

Dragging *out of* `/projects` copies rather than moves — the source is a
read-only mount, and a move would fail with `EROFS` the user can do nothing
about.

### Apps, associations, and arguments

`launch(id, args)` is the OS's exec: modules receive `args.path` the way a
program receives argv. A module declares what it opens via `handles`, and
`ctx.openPath(p)` routes to whichever one claims the extension — `"dir"` goes to
Files, `"*"` is the fallback. That's the entire association table; adding a
viewer for a new filetype is one array entry, not a change to the desktop.

## Running programs

`.py` and `.js` files are executable, not just readable. Double-click one, pick
**Run** from its context menu, or type `run <file>` in the console. Each program
gets its own panel: output streams in, `stop` kills it, and the input line at
the bottom is its stdin.

| language | runtime | notes |
| --- | --- | --- |
| JavaScript | Web Worker | instant, offline, `require()` resolves against sibling files |
| Python | Pyodide (CPython 3.13 → wasm) | ~10MB fetched from jsDelivr on first run, then cached |

Sibling source files are mounted alongside the entry point, so multi-file
projects import normally. `run /projects/break-the-house/run_game.py` plays the
actual game — `import example_cards` resolves, emoji render, and `input()` works.

**`input()` is real.** Python's stdin is synchronous, but the line you type only
exists on the main thread, so the worker parks on `Atomics.wait` against a
SharedArrayBuffer until the host writes the line back. That needs the page to be
cross-origin isolated — `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, set in `vite.config.ts` for dev and
in the `Caddyfile` for production. Without those headers everything else still
works; only stdin degrades, with an explanation rather than a hang.

## The host bridge

Anything the shell doesn't recognise as a builtin is run **on the machine**:

```
cd /projects/pawnageddon
npm install
npm run dev          → detects the port, opens the game as a window
jobs                 → list running processes
kill job-3           → stop one (kills the whole process group)
app 5174             → frame a port manually
```

A browser has no process API, so this can only work via something outside the
page. `plugins/host.ts` runs inside the Vite dev server: it spawns children,
streams stdout/stderr back over SSE, and reverse-proxies a child's port under
voidshell's own origin so it can be framed.

**It is dev-only by construction.** The plugin is `apply: "serve"`, so it does
not exist in a production build — a deployed voidshell answers every bridge call
with "no host bridge" and has no code path to execute anything. Commands are
additionally confined to directories at or below the projects root; `cwd`
values that escape it (via `..` or a symlink) are rejected.

### Why each app gets its own port

A framed app is served through a small proxy on its **own ephemeral port**, not
under a path like `/__vs/app/5174/`. The path approach cannot work: a dev
server's HTML and modules use absolute URLs (`/src/main.jsx`,
`/node_modules/.vite/deps/react.js`) which resolve against the origin root and
hit voidshell instead of the app. Routing by `Referer` fixes only the first
level — a module imported by a module carries the *importing module's* URL.

Serving each app at the root of its own port makes absolute paths resolve
correctly, and since the proxy owns the response it can inject the COEP/CORP
headers the child needs to be embeddable inside a cross-origin-isolated parent
(a dev server won't send those itself). HMR websockets are forwarded too.

That is also why COEP is `credentialless` rather than `require-corp` — it still
grants SharedArrayBuffer for Python's stdin without hard-blocking every
subresource a framed app loads.

### What can't run

The Plasma widgets (`calendar-widget`, `todo-widget`) are QML and have no web
target. Everything else runs, though a project still needs its own setup —
`hero-nexus` starts and serves but returns 500 until its Firebase environment
variables are set, and the error shows up in the console like any other.

## Swapping the renderer

Write a `DomCompositor implements Compositor` that mounts surfaces as flat
draggable divs, swap it in for `new ThreeCompositor()` in `src/main.ts`, and
every module above renders unchanged in a 2D world. The optional methods
(`linkSurfaces`, `lookAtSurface`, `arrange`…) degrade to no-ops, so a minimal
backend is genuinely minimal.

## What's next

- A `DomCompositor` as the pragmatic fallback backend.
- Constellation *layouts* — remembering relative positions, not just membership.
- Multi-user: the store is already the only source of truth worth syncing.
- Syntax highlighting in the file viewer (the language is already detected).
- Multi-select on the desktop (marquee drag, shift-click) — everything today is
  single-selection.
- Undo. There is no trash: `Delete` is immediate and permanent.
- Multi-line file writing from the shell (`write` joins its arguments with
  spaces, so use the editor for anything with real line breaks).
- Running the web projects in-shell — iframe-based `render()` for `hero-nexus`
  and `stonks-surplus`, which currently browse as source only.
