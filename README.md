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
- `openSurface` / `closeSurface` / `openSurfaces` / `focusSurface`
- `lookAt` / `lookAtGroup` / `resetView` / `arrange` — move the viewer, not the windows
- `linkSurfaces` / `unlinkGroup` / `listGroups` — constellations
- `spawnBody` / `destroyBody` / `attachSurface` / `listBodies` — the sky
- `patchWorld` — ask the compositor to mutate the environment
- `defineSetting` / `defineCommand` — publish into the shell's registries
- `notify` — say something in the corner of the void
- `launch` / `launchAt` / `registry` — reach other modules

`kind: "app"` shows in the launcher. `kind: "world"` and `kind: "service"` stay
invisible — daemons. **Aurora** is worth reading: it owns every colour in the
build and exposes them purely as registered settings, which is how "theme"
becomes a *program* instead of a hardcoded palette.

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
- Your actual projects as modules — iframe-based `render()` for the ones that
  already run as web apps.
