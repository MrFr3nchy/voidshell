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

Then: **drag the void** to look around, press **Space** (or click ◎) to summon
apps. Open the Console and type `help`. Open Aurora Forge and repaint the sky.

Other scripts: `npm run build`, `npm run preview`, `npm run typecheck`.

## The mental model

Three things, and they barely know about each other:

1. **The kernel** (`src/kernel/`) — the entire OS. It owns the module registry,
   the surface (window) table, an event bus, and shared state. It renders
   *nothing*. It's ~150 lines on purpose. Like a microkernel, everything
   interesting lives outside it.

2. **The compositor** (`src/compositor/`) — the render backend. The kernel hands
   it abstract *surfaces* and says "give this a body." How it does that — WebGL,
   DOM, WebGPU — is entirely the compositor's business. `ThreeCompositor` is the
   spectacle one. Swapping it is **one line** in `src/main.ts`.

3. **Modules** (`src/modules/`) — the unit of everything. An app, a theme, a
   world effect, a background service: all the same contract. They never import
   each other. They talk through the event bus and shared state, so any one can
   be yanked out without the rest noticing.

### Why two render layers

Live web content **cannot live inside WebGL** — you can't texture-map an
interactive `<iframe>` into a 3D scene and keep it interactive. So the
compositor runs a WebGL layer for the *world* (the nebula, particles, depth)
and a `CSS3DRenderer` layer for the *panels* (real DOM, positioned in the same
3D space, sharing the same camera). That hybrid is what lets your actual
projects drop in later as normal web apps while still hanging in space.

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
launcher — no other file changes.

### The syscall surface (`KernelContext`)

Everything a module can do, deliberately small:

- `emit(type, payload)` / `on(type, handler)` — the OS's IPC
- `state.get/set/subscribe` — shared memory
- `openSurface(req)` / `closeSurface(id)` — windows into the world
- `patchWorld(patch)` — ask the compositor to mutate the environment
- `launch(id)` / `registry()` — reach other modules

`kind: "app"` shows in the launcher. `kind: "world"` and `kind: "service"` stay
invisible — daemons. **Aurora Forge** is worth reading: it's an app that repaints
the entire sky through `patchWorld`, which is how "theme" becomes a *program*
instead of a setting.

## Swapping the renderer

Write a `DomCompositor implements Compositor` that mounts surfaces as flat
draggable divs, swap it in for `new ThreeCompositor()` in `src/main.ts`, and
every module above renders unchanged in a 2D world. The kernel never learns the
difference.

## What's stubbed / next

- Surface persistence (mirror `Store` to localStorage — one file).
- Panel dragging in 3D + focus/z-ordering.
- A `DomCompositor` as the pragmatic fallback backend.
- Your actual projects as modules — iframe-based `render()` for the ones that
  already run as web apps.
