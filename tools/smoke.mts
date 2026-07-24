/**
 * Headless smoke test. Boots the real kernel and every real module against a
 * stub compositor inside jsdom, so wiring mistakes surface here instead of in
 * the browser. Deliberately not wired into package.json: it needs jsdom, and
 * the shipped app has exactly one runtime dependency and should keep it.
 *
 *   npm i --no-save jsdom @types/jsdom
 *   npx esbuild tools/smoke.mts --bundle --platform=node --format=esm \
 *     --outfile=smoke.mjs --external:jsdom && node smoke.mjs && rm smoke.mjs
 *
 * jsdom has no canvas backend, so the ambient apps log one "not implemented"
 * notice each and mount an inert canvas. That's the intended fallback path in
 * `mountStage` — no 2D context means no resize observer and no frame loop.
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM(
  `<!doctype html><html><head><meta name="theme-color" content="#000"></head>
   <body><div id="void"></div><div id="hud"></div></body></html>`,
  { pretendToBeVisual: true, url: "https://example.test" }
);

const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// Node >=21 defines `navigator` as a getter-only global, so a plain assignment
// throws. Redefine it instead.
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
g.localStorage = dom.window.localStorage;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
g.HTMLSelectElement = dom.window.HTMLSelectElement;
g.CustomEvent = dom.window.CustomEvent;
g.requestAnimationFrame = (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(0), 0);
g.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id);
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// jsdom has no layout, so nothing implements scrollIntoView.
dom.window.Element.prototype.scrollIntoView = function () {};

const { Kernel } = await import("../src/kernel/Kernel");
const types = await import("../src/kernel/types");
void types;
const { aurora } = await import("../src/modules/aurora");
const { horizon } = await import("../src/modules/horizon");
const { shell } = await import("../src/modules/shell");
const { settings } = await import("../src/modules/settings");
const { dashboards } = await import("../src/modules/dashboards");
const { notes } = await import("../src/modules/notes");
const { vitals } = await import("../src/modules/vitals");
const { terminal } = await import("../src/modules/terminal");
const { chronos } = await import("../src/modules/chronos");
const { cosmos } = await import("../src/modules/cosmos");
const { cradle } = await import("../src/modules/cradle");
const { driftfield } = await import("../src/modules/driftfield");
const { sandbox } = await import("../src/modules/sandbox");
const { harmonograph } = await import("../src/modules/harmonograph");
const { lunaria } = await import("../src/modules/lunaria");
const { bubblewrap } = await import("../src/modules/bubblewrap");
const { ripple } = await import("../src/modules/ripple");
const { flock } = await import("../src/modules/flock");
const { orrery } = await import("../src/modules/orrery");
const { lavalamp } = await import("../src/modules/lavalamp");
const { turmite } = await import("../src/modules/turmite");
const { chaos } = await import("../src/modules/chaos");
const { sunclock } = await import("../src/modules/sunclock");
const { files } = await import("../src/modules/files");
const { editor } = await import("../src/modules/editor");
const { runner } = await import("../src/modules/runner");
const { webapp } = await import("../src/modules/webapp");
const { desktop } = await import("../src/modules/desktop");
const { createSpawner, resolveSlots } = await import("../src/ui/spawner");
const { createAppDrawer } = await import("../src/ui/appDrawer");
const { createPalette } = await import("../src/ui/palette");
const { createToasts } = await import("../src/ui/toasts");

type Any = Record<string, unknown>;

const patches: Any[] = [];
const groups = new Map<string, { id: string; name: string; members: string[] }>();
const bodies = new Map<string, { id: string; kind: string }>();
let n = 0;

const mounted = new Map<string, unknown>();

const stub = {
  name: "stub",
  init: () => {},
  mountSurface: (surface: { id: string; element: HTMLElement }) => {
    // A faithful stub actually attaches the module's DOM, the way the real
    // compositor does — otherwise every render-path assertion is vacuous.
    dom.window.document.getElementById("hud")!.appendChild(surface.element);
    mounted.set(surface.id, surface);
    return () => {
      surface.element.remove();
      mounted.delete(surface.id);
    };
  },
  focusSurface: () => {},
  lookAtSurface: () => {},
  lookAtGroup: () => {},
  resetView: () => {},
  applyWorldPatch: (p: Any) => patches.push(p),
  spawnBody: (kind: string) => {
    const id = `body-${++n}`;
    bodies.set(id, { id, kind });
    return id;
  },
  destroyBody: (id: string) => void bodies.delete(id),
  attachSurface: () => {},
  listBodies: () => [...bodies.values()],
  linkSurfaces: (ids: string[], name?: string) => {
    const id = `group-${++n}`;
    groups.set(id, { id, name: name || id, members: ids });
    return id;
  },
  unlinkGroup: (id: string) => void groups.delete(id),
  listGroups: () => [...groups.values()],
  arrange: () => {},
  // Anchored DOM: desktop icons ride this rather than the surface table, so the
  // stub has to attach them for real or the icon assertions are vacuous.
  mountAnchored: (el: HTMLElement, anchor: Any) => {
    dom.window.document.getElementById("hud")!.appendChild(el);
    let at = { ...anchor };
    return {
      setAnchor: (p: Any) => void (at = { ...p }),
      getAnchor: () => at,
      dispose: () => el.remove(),
    };
  },
  focalPoint: () => ({ x: 0, y: 0, z: -620 }),
  screenToWorld: (_x: number, _y: number, d: number) => ({ x: 0, y: 0, z: -d }),
  setSpawnHint: () => {},
  placeSurface: () => {},
  snapshot: () => {
    const out: Record<string, unknown> = {};
    for (const id of mounted.keys())
      out[id] = { anchor: [0, 0, -600], width: 400, height: 300, pinned: false, pinX: 0, pinY: 0 };
    return out;
  },
  stats: () => ({ fps: 60, panels: 0, bodies: bodies.size, groups: groups.size }),
  start: () => {},
  dispose: () => {},
};

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

const kernel = new Kernel(stub as never);
kernel
  .register(aurora)
  .register(horizon)
  .register(shell)
  .register(desktop)
  .register(terminal)
  .register(files)
  .register(runner)
  .register(webapp)
  .register(editor)
  .register(chronos)
  .register(cosmos)
  .register(settings)
  .register(dashboards)
  .register(notes)
  .register(vitals)
  .register(cradle)
  .register(driftfield)
  .register(sandbox)
  .register(harmonograph)
  .register(lunaria)
  .register(bubblewrap)
  .register(ripple)
  .register(flock)
  .register(orrery)
  .register(lavalamp)
  .register(turmite)
  .register(chaos)
  .register(sunclock);

const MODULE_COUNT = 28;

const hud = dom.window.document.getElementById("hud")!;
const gl = dom.window.document.getElementById("void")!;
await kernel.boot({ gl, overlay: hud, hud });
const ctx = kernel.context();

check("modules registered", ctx.registry().length === MODULE_COUNT);
check("world patches flushed at boot", patches.length > 0);
check("settings registry populated", ctx.settings().length >= 20);
check(
  "settings cover every group",
  ["Appearance", "Launcher", "World", "System", "Links", "Apps"].every((grp) =>
    ctx.settings().some((d) => d.group === grp)
  )
);
check("commands registered", ctx.commands().length >= 8);
check("defaults seeded into the store", ctx.state.get("world.fov", 0) === 68);

// Every app must launch, render and close without throwing.
for (const m of ctx.registry().filter((x) => x.kind === "app")) {
  const before = ctx.openSurfaces().length;
  kernel.launch(m.id);
  check(`launch ${m.id}`, ctx.openSurfaces().length === before + 1);
}

check("singleton re-launch does not clone", (() => {
  const before = ctx.openSurfaces().length;
  kernel.launch("chronos");
  return ctx.openSurfaces().length === before;
})());

// Shell UI must build against a live registry.
const spawner = createSpawner(hud, ctx, () => {});
spawner.toggle(true);
const drawer = createAppDrawer(hud, ctx, { openRing: () => {} });
drawer.toggle(true);
const palette = createPalette(hud, ctx);
palette.toggle(true);
createToasts(hud, ctx);

check("launcher slots resolve", resolveSlots(ctx).length === 6);
check("ring rendered nodes", hud.querySelectorAll(".spawner-node").length === 7);
check(
  "drawer listed every module",
  hud.querySelectorAll(".drawer-tile").length === MODULE_COUNT
);
check("palette listed rows", hud.querySelectorAll(".palette-row").length > 0);

// Settings must render a control for every def in the active group.
const setBody = hud.ownerDocument.querySelector(".set-body");
check("settings app rendered controls", (setBody?.children.length ?? 0) > 0);

// Constellation controls must be published and default sanely.
check(
  "link settings registered",
  ctx.settings().filter((d) => d.group === "Links").length === 6
);
check("orbit drag is the default", ctx.state.get("links.orbit", false) === true);
check(
  "no collapsing spread control survives",
  !ctx.settings().some((d) => d.key === "links.spread")
);

// Rebinding a slot must persist and reshape the ring.
ctx.state.set("launcher.count", 3);
check("slot count honoured", resolveSlots(ctx).length === 3);

// Linking through the public syscall.
const ids = ctx.openSurfaces().slice(0, 2).map((s) => s.id);
const gid = ctx.linkSurfaces(ids, "test cluster");
check("linkSurfaces returns an id", Boolean(gid));
check("group visible to modules", ctx.listGroups()[0]?.name === "test cluster");
ctx.unlinkGroup(gid);
check("unlink removes it", ctx.listGroups().length === 0);

// Persistence: settings survive a fresh kernel reading the same storage.
ctx.state.set("appearance.intensity", 1.42);
await new Promise((r) => dom.window.setTimeout(r, 400));
const raw = dom.window.localStorage.getItem("voidshell:state") ?? "";
check("state written to disk", raw.includes("appearance.intensity"));

// Session round-trip.
kernel.saveSession();
check("session recorded", JSON.stringify(ctx.state.get("system.session", [])).length > 2);

// Notes actually persist their text.
ctx.state.set("notes.doc.test", "hello void");
check("note text stored", ctx.state.get("notes.doc.test", "") === "hello void");

// The astronomy apps are computed, not fetched — they must answer offline.
const readouts = [...hud.ownerDocument.querySelectorAll(".stage-value")].map(
  (el) => el.textContent ?? ""
);
check(
  "lunaria reported a phase",
  readouts.some((t) => /crescent|gibbous|quarter|full|new/i.test(t))
);
check(
  "sunclock reported a day length",
  readouts.some((t) => /^\d+h \d\dm$/.test(t) || /midnight sun|polar night/.test(t))
);

/* ---------------- filesystem ---------------- */

ctx.fs.mkdirp("/home/void/smoke");
ctx.fs.write("/home/void/smoke/a.txt", "hello");
check("write then read round-trips", ctx.fs.read("/home/void/smoke/a.txt") === "hello");
check("ls sees the new file", ctx.fs.ls("/home/void/smoke").some((e) => e.name === "a.txt"));
check("isDir distinguishes", ctx.fs.isDir("/home/void/smoke") && !ctx.fs.isDir("/home/void/smoke/a.txt"));
ctx.fs.mv("/home/void/smoke/a.txt", "/home/void/smoke/b.txt");
check("mv moves", !ctx.fs.exists("/home/void/smoke/a.txt") && ctx.fs.exists("/home/void/smoke/b.txt"));
ctx.fs.rm("/home/void/smoke", true);
check("recursive rm clears", !ctx.fs.exists("/home/void/smoke"));

// The launch sweep above left the surface table near MAX_SURFACES, so clear it
// before the routing checks — otherwise they fail on the cap, not on routing.
for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);

// openPath must route by extension through the `handles` table.
ctx.fs.write("/home/void/routed.md", "# routed");
const beforeRoute = ctx.openSurfaces().length;
ctx.openPath("/home/void/routed.md");
check("openPath opened a window", ctx.openSurfaces().length === beforeRoute + 1);
check(
  "openPath routed .md to the editor",
  ctx.openSurfaces().some((s) => s.moduleId === "editor")
);

// A directory must route to the file manager, not the editor.
ctx.fs.mkdirp("/home/void/adir");
ctx.openPath("/home/void/adir");
check(
  "openPath routed a directory to files",
  ctx.openSurfaces().some((s) => s.moduleId === "files")
);

// Launching with args must bypass the singleton short-circuit, or a second
// file would silently refocus the first instead of opening.
ctx.fs.write("/home/void/second.md", "# second");
const beforeSecond = ctx.openSurfaces().length;
ctx.openPath("/home/void/second.md");
check("a second file opens its own window", ctx.openSurfaces().length === beforeSecond + 1);

// Closing everything must not throw.
for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
check("all surfaces closed", ctx.openSurfaces().length === 0);

console.log(
  failures.length ? `\n${failures.length} FAILURE(S)` : "\nall smoke checks passed"
);
process.exit(failures.length ? 1 : 0);
