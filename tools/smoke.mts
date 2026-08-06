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
import { readFileSync } from "node:fs";

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

const { Kernel } = await import("../packages/ui/src/kernel/Kernel");
const types = await import("../packages/ui/src/kernel/types");
void types;
const { aurora } = await import("../packages/ui/src/modules/aurora");
const { horizon } = await import("../packages/ui/src/modules/horizon");
const { shell } = await import("../packages/ui/src/modules/shell");
const { settings } = await import("../packages/ui/src/modules/settings");
const { dashboards } = await import("../packages/ui/src/modules/dashboards");
const { notes } = await import("../packages/ui/src/modules/notes");
const { vitals } = await import("../packages/ui/src/modules/vitals");
const { monitor } = await import("../packages/ui/src/modules/monitor");
const { portal, resolveQuery } = await import("../packages/ui/src/modules/portal");
const { chronos } = await import("../packages/ui/src/modules/chronos");
const { cosmos } = await import("../packages/ui/src/modules/cosmos");
const { cradle } = await import("../packages/ui/src/modules/cradle");
const { driftfield } = await import("../packages/ui/src/modules/driftfield");
const { sandbox } = await import("../packages/ui/src/modules/sandbox");
const { harmonograph } = await import("../packages/ui/src/modules/harmonograph");
const { lunaria } = await import("../packages/ui/src/modules/lunaria");
const { bubblewrap } = await import("../packages/ui/src/modules/bubblewrap");
const { ripple } = await import("../packages/ui/src/modules/ripple");
const { flock } = await import("../packages/ui/src/modules/flock");
const { orrery } = await import("../packages/ui/src/modules/orrery");
const { lavalamp } = await import("../packages/ui/src/modules/lavalamp");
const { turmite } = await import("../packages/ui/src/modules/turmite");
const { chaos } = await import("../packages/ui/src/modules/chaos");
const { sunclock } = await import("../packages/ui/src/modules/sunclock");
const { bell } = await import("../packages/ui/src/modules/bell");
const { arcade } = await import("../packages/ui/src/modules/arcade");
const { CABINETS } = await import("../packages/ui/src/modules/arcade/registry");
const { arcadeChecks } = await import("./arcade-checks.mts");
const { createDevkit } = await import("../packages/ui/src/modules/devkit");
const { devkitChecks } = await import("./devkit-checks.mts");
const { typescriptChecks } = await import("./ts-checks.mts");
const { workspace } = await import("../packages/ui/src/modules/workspace");
const { editor } = await import("../packages/ui/src/modules/editor");
const { webapp } = await import("../packages/ui/src/modules/webapp");
const { desktop } = await import("../packages/ui/src/modules/desktop");
const { trash: trashApp } = await import("../packages/ui/src/modules/trash");
const { calculator, evaluate, present } = await import(
  "../packages/ui/src/modules/calculator"
);
const { calendar, dayKey } = await import("../packages/ui/src/modules/calendar");
const { timer } = await import("../packages/ui/src/modules/timer");
const { renderMarkdown } = await import("../packages/ui/src/modules/editor/markdown");
const { createSpawner, resolveSlots } = await import("../packages/ui/src/ui/spawner");
const { createAppDrawer } = await import("../packages/ui/src/ui/appDrawer");
const { createPalette } = await import("../packages/ui/src/ui/palette");
const { createToasts } = await import("../packages/ui/src/ui/toasts");
const { createStatusBar } = await import("../packages/ui/src/ui/statusBar");
const { createPower } = await import("../packages/ui/src/ui/power");
const { emptyTrash, listTrash, moveToTrash, restoreFromTrash } = await import(
  "../packages/ui/src/kernel/trash"
);
const { MemoryWorkspaceHost } = await import("../packages/ui/src/kernel/persistence");

type Any = Record<string, unknown>;

const patches: Any[] = [];
const groups = new Map<string, { id: string; name: string; members: string[] }>();
const bodies = new Map<string, { id: string; kind: string }>();
let n = 0;

const mounted = new Map<string, unknown>();
/** Every rename the kernel asked the compositor to draw. */
const retitles = new Map<string, string>();
let activeSurfaceId: string | null = null;
let exposeOn = false;

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
  retitleSurface: (id: string, title: string) => void retitles.set(id, title),
  focusSurface: (id: string) => void (activeSurfaceId = id),
  activeSurface: () => activeSurfaceId,
  expose: (on?: boolean) => {
    exposeOn = on ?? !exposeOn;
    return exposeOn;
  },
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

// An explicit host, so the persistence checks can see what the kernel would
// have sent to the server.
const host = new MemoryWorkspaceHost();
const kernel = new Kernel(stub as never, host);

// Handed the kernel rather than the context: installing modules is privileged,
// and main.ts wires it the same way.
const devkit = createDevkit(kernel);

kernel
  .register(aurora)
  .register(horizon)
  .register(shell)
  .register(desktop)
  .register(workspace)
  .register(webapp)
  .register(editor)
  .register(trashApp)
  .register(calculator)
  .register(calendar)
  .register(timer)
  .register(chronos)
  .register(cosmos)
  .register(settings)
  .register(dashboards)
  .register(notes)
  .register(vitals)
  .register(monitor)
  .register(portal)
  .register(arcade)
  .register(devkit)
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
  .register(sunclock)
  .register(bell);

const MODULE_COUNT = 35;

const hud = dom.window.document.getElementById("hud")!;
const gl = dom.window.document.getElementById("void")!;
await kernel.boot({ gl, overlay: hud, hud });
const ctx = kernel.context();

check("modules registered", ctx.registry().length === MODULE_COUNT);

/**
 * The harness registers its own module list, so it stays self-consistent even
 * when it drifts from the real one — a module added to main.ts but not here
 * goes completely untested while every check still reports green. That is not
 * hypothetical: `bell` shipped that way. Read the registrations back out of
 * main.ts and make the drift itself a failure.
 */
const mainSrc = readFileSync("packages/ui/src/main.ts", "utf8");

/**
 * The compositor must not exist before there is a session.
 *
 * An ordering property, so it is checked where the ordering is written rather
 * than by booting WebGL in jsdom. Getting this wrong doesn't throw — it draws
 * the nebula and flashes the user's panels in behind a login form, which is
 * both a leak and the exact thing a lock screen is supposed to prevent.
 */
{
  const compositorAt = mainSrc.indexOf("new ThreeCompositor()");
  const runShellAt = mainSrc.indexOf("async function runShell");
  const openSessionAt = mainSrc.indexOf("await openSession()");
  const runShellCallAt = mainSrc.indexOf("await runShell(");

  check("the compositor is built inside runShell", compositorAt > runShellAt && runShellAt !== -1);
  check(
    "the session is opened before the shell runs",
    openSessionAt !== -1 && runShellCallAt !== -1 && openSessionAt < runShellCallAt
  );
  check(
    "runShell is only reached with a workspace in hand",
    /const saved = await openSession\(\);\s*await runShell\(/.test(mainSrc)
  );
  // Signing out must release the WebGL context. Browsers cap them at around
  // sixteen and then start killing the oldest, so a leak here goes black
  // several signouts later, somewhere that looks nothing like the cause.
  check("signing out disposes the kernel", /teardown\.abort\(\);[\s\S]{0,400}kernel\.dispose\(\)/.test(mainSrc));
}
const registeredInMain = [...mainSrc.matchAll(/\.register\((\w+)\)/g)].map((m) => m[1]);
check(
  `main.ts registers ${MODULE_COUNT} modules (found ${registeredInMain.length})`,
  registeredInMain.length === MODULE_COUNT
);
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
//
// Each one is closed again before the next launches. Letting them accumulate
// puts the sweep in a race with MAX_SURFACES that the apps win: once the table
// is full the kernel refuses to open anything more, and whichever app happens
// to be registered last fails a check about the surface cap while reporting it
// as its own breakage. There are already more apps than the cap allows.
for (const m of ctx.registry().filter((x) => x.kind === "app")) {
  const before = ctx.openSurfaces().length;
  kernel.launch(m.id);
  const opened = ctx.openSurfaces().length === before + 1;
  check(`launch ${m.id}`, opened);
  for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
}

/* ---------------- the overview ---------------- */

check("the overview toggles and reports its own state", (() => {
  // The caller must not keep a flag of its own: the compositor dismisses the
  // overview itself when a window is picked, so a local copy would drift.
  const on = ctx.expose();
  const off = ctx.expose();
  return on === true && off === false;
})());

/* ---------------- reopening a closed window ---------------- */

check("a closed window comes back", (() => {
  kernel.launch("chronos");
  const id = ctx.openSurfaces()[0]?.id;
  kernel.closeSurface(id);
  const gone = ctx.openSurfaces().length === 0;
  const back = kernel.reopenLast();
  const open = ctx.openSurfaces().length === 1;
  for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
  return gone && back && open;
})());

check("a reopened window keeps what it held", (() => {
  // The editor is the case that mattered: reopening it without its argument
  // brought back an *empty* editor, which is not the window you closed.
  kernel.launch("editor", { path: "/home/void/welcome.md" });
  const id = ctx.openSurfaces()[0]?.id;
  kernel.closeSurface(id);
  kernel.reopenLast();
  const titled = ctx.openSurfaces()[0]?.title === "welcome.md";
  for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
  return titled;
})());

check("the reopen ring is capped", (() => {
  // The ring cannot be drained by reopening from it — bringing a window back
  // and closing it again puts it straight back on. So the property worth
  // asserting is the cap, which is what stops a long session from holding on
  // to every window it ever had.
  for (let i = 0; i < 16; i++) {
    kernel.launch("chronos");
    for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
  }
  return kernel.reopenDepth() === 12;
})());

/* ---------------- session fidelity ---------------- */

check("a saved session carries its constellations", (() => {
  kernel.launch("chronos");
  kernel.launch("notes");
  const ids = ctx.openSurfaces().map((s) => s.id);
  ctx.linkSurfaces(ids, "test group");
  kernel.saveSession();

  for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
  for (const g of ctx.listGroups()) ctx.unlinkGroup(g.id);

  kernel.restoreSession();
  const groups = ctx.listGroups();
  const rebuilt = groups.length === 1 && groups[0].members.length === 2;
  const named = groups[0]?.name === "test group";
  for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
  for (const g of ctx.listGroups()) ctx.unlinkGroup(g.id);
  return rebuilt && named;
})());

check("a restored editor still holds its file", (() => {
  kernel.launch("editor", { path: "/home/void/welcome.md" });
  kernel.saveSession();
  for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
  kernel.restoreSession();
  const held = ctx.openSurfaces()[0]?.title === "welcome.md";
  for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
  return held;
})());

check("a session written before constellations still restores", (() => {
  // The old shape was a bare array of windows. Dropping a layout on the first
  // boot after an upgrade would be a worse bug than the one being fixed.
  ctx.state.set("system.session", [
    { moduleId: "chronos", place: { anchor: [0, 0, -600], width: 420, height: 300, pinned: false, pinX: 0, pinY: 0 } },
  ]);
  kernel.restoreSession();
  const opened = ctx.openSurfaces().length === 1;
  for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
  return opened;
})());

/* ---------------- live window titles ---------------- */

check("a window can be renamed", (() => {
  kernel.launch("chronos");
  const s = ctx.openSurfaces()[0];
  ctx.setTitle(s.id, "renamed");
  const listed = ctx.openSurfaces().find((x) => x.id === s.id)?.title === "renamed";
  // Both halves matter: the kernel is what the compass and the palette read,
  // and the compositor is what the title bar draws.
  const drawn = retitles.get(s.id) === "renamed";
  for (const open of ctx.openSurfaces()) kernel.closeSurface(open.id);
  return listed && drawn;
})());

check("an empty rename is refused", (() => {
  kernel.launch("chronos");
  const s = ctx.openSurfaces()[0];
  ctx.setTitle(s.id, "   ");
  const kept = ctx.openSurfaces().find((x) => x.id === s.id)?.title === "chronos";
  for (const open of ctx.openSurfaces()) kernel.closeSurface(open.id);
  return kept;
})());

check("the file manager is named after its directory", (() => {
  kernel.launch("workspace");
  const named = ctx.openSurfaces().some((s) => s.title === "~");
  for (const open of ctx.openSurfaces()) kernel.closeSurface(open.id);
  return named;
})());

check("singleton re-launch does not clone", (() => {
  // Self-contained: the sweep above no longer leaves anything open.
  kernel.launch("chronos");
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

/* ---------------- notices ---------------- */

check("a warning stays until it is dismissed", (() => {
  ctx.notify("something went wrong", "warn");
  const el = hud.querySelector(".toast.is-warn") as HTMLElement | null;
  return el?.dataset.sticky === "1";
})());

check("routine chatter does not stick", (() => {
  ctx.notify("just so you know");
  const els = [...hud.querySelectorAll(".toast.is-info")] as HTMLElement[];
  return els.length > 0 && els.every((e) => e.dataset.sticky !== "1");
})());

check("a notice can carry an offer", (() => {
  let ran = false;
  ctx.notify("window limit reached", {
    action: { label: "see every window", run: () => void (ran = true) },
  });
  const el = [...hud.querySelectorAll(".toast")].pop() as HTMLElement;
  const btn = el?.querySelector(".toast-action") as HTMLButtonElement | null;
  btn?.click();
  // An action implies the notice is worth keeping, so it sticks without asking.
  return Boolean(btn) && ran && el.dataset.sticky === "1";
})());

check("a notice can be dismissed", (() => {
  ctx.notify("dismiss me", "warn");
  const el = [...hud.querySelectorAll(".toast")].pop() as HTMLElement;
  (el.querySelector(".toast-close") as HTMLButtonElement).click();
  return !el.classList.contains("live");
})());

check("launcher slots resolve", resolveSlots(ctx).length === 6);
check("ring rendered nodes", hud.querySelectorAll(".spawner-node").length === 7);
check(
  "drawer listed every module",
  hud.querySelectorAll(".drawer-tile").length === MODULE_COUNT
);
check("palette listed rows", hud.querySelectorAll(".palette-row").length > 0);

// A module installed after boot has to reach the launcher, or the only way to
// open it is devkit's own row and it isn't really installed. This was the open
// question on PR #44 — the answer is that every launch surface rebuilds from
// ctx.registry() each time it opens, so none of them needed a listener adding.
check("a module installed after boot reaches the launcher", (() => {
  kernel.install({
    manifest: { id: "rt-drawer", name: "rt-drawer", kind: "app", glyph: "*" },
    activate: () => {},
    launch: () => {},
  });
  drawer.toggle(false);
  drawer.toggle(true);
  const tiles = hud.querySelectorAll(".drawer-tile").length;
  const named = [...hud.querySelectorAll(".tile-name")].some(
    (el) => (el as unknown as { textContent: string }).textContent === "rt-drawer"
  );
  // Not asserted against the launcher ring: its nodes are six *bound* slots,
  // not a listing, so a new module correctly doesn't appear there until it is
  // bound to one.
  //
  // The palette has to be searched rather than read, because it caps at twelve
  // rows — enumerating it and looking for a name proves nothing about a shell
  // with thirty-five modules in it.
  palette.toggle(false);
  palette.toggle(true);
  const search = hud.querySelector(".palette-input") as HTMLInputElement;
  search.value = "rt-drawer";
  search.dispatchEvent(new hud.ownerDocument.defaultView!.Event("input"));
  const inPalette = [...hud.querySelectorAll(".palette-row")].some((el) =>
    (el as unknown as { textContent: string }).textContent.includes("rt-drawer")
  );

  kernel.uninstall("rt-drawer");
  drawer.toggle(false);
  drawer.toggle(true);
  const restored = hud.querySelectorAll(".drawer-tile").length === MODULE_COUNT;
  // Put the palette back the way it was found — re-opening clears the query.
  palette.toggle(false);
  palette.toggle(true);
  return tiles === MODULE_COUNT + 1 && named && inPalette && restored;
})());

// Settings must render a control for every def in the active group. Launched
// here rather than relying on the sweep above, which closes what it opens.
kernel.launch("settings");
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

// Persistence: a changed setting reaches the host, and a fresh kernel
// hydrated from that snapshot comes back with it. This is the whole contract
// now that there is no browser storage to peek into — and it is a better test
// than the old one, which only checked that a string had been written and
// never proved anything could read it back.
ctx.state.set("appearance.intensity", 1.42);
ctx.fs.write("/home/void/persisted.md", "# still here");
await new Promise((r) => dom.window.setTimeout(r, 0));

check("a change reaches the workspace host", host.latest.state["appearance.intensity"] === 1.42);
check("the home tree rides along with it", JSON.stringify(host.latest.fs).includes("persisted.md"));
check(
  "ephemeral keys are not persisted",
  Object.keys(host.latest.state).every((k) => !k.startsWith("tmp."))
);

{
  const revived = new Kernel(stub as never);
  revived.hydrate(host.latest);
  const rctx = revived.context();
  check("a fresh kernel restores the setting", rctx.state.get("appearance.intensity", 0) === 1.42);
  check("a fresh kernel restores the files", rctx.fs.exists("/home/void/persisted.md"));
}

// Session round-trip.
kernel.saveSession();
check("session recorded", JSON.stringify(ctx.state.get("system.session", [])).length > 2);

// Notes are files now, not store keys — so the rest of the OS can see them.
check("notes directory exists", ctx.fs.isDir("/home/void/notes"));
ctx.fs.write("/home/void/notes/from-a-test.md", "# hello void");
check(
  "a note is an ordinary file",
  ctx.fs.read("/home/void/notes/from-a-test.md") === "# hello void"
);

// The astronomy apps are computed, not fetched — they must answer offline.
// Both are launched here for the same reason settings is, above.
kernel.launch("lunaria");
kernel.launch("sunclock");
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
check("stat carries an mtime", ctx.fs.stat("/home/void").mtime > 0);

/* ---------------- processes ---------------- */

check("kernel holds pid 1", ctx.ps()[0]?.pid === 1 && ctx.ps()[0]?.moduleId === "kernel");
check(
  "every service and world module is a daemon",
  ctx
    .registry()
    .filter((m) => m.kind !== "app")
    .every((m) => ctx.ps().some((p) => p.moduleId === m.id && p.state === "daemon"))
);
check("daemons refuse to be killed", ctx.kill(1) === false);
check("killing a pid that does not exist is refused", ctx.kill(99999) === false);

// A launch is a process; closing its last window is how that process exits.
for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
const beforeProcs = ctx.ps().length;
kernel.launch("notes");
const notesProc = ctx.ps().find((p) => p.moduleId === "notes");
check("launching an app spawns a process", Boolean(notesProc) && ctx.ps().length === beforeProcs + 1);
check("the process owns its surface", (notesProc?.surfaces.length ?? 0) === 1);
check("kill closes the window", ctx.kill(notesProc!.pid) === true && ctx.openSurfaces().length === 0);
check("killed process left the table", !ctx.ps().some((p) => p.pid === notesProc!.pid));

kernel.launch("notes");
const notes2 = ctx.ps().find((p) => p.moduleId === "notes")!;
kernel.closeSurface(notes2.surfaces[0]);
check("closing the last window reaps the process", !ctx.ps().some((p) => p.pid === notes2.pid));

/* ---------------- the system as a filesystem ---------------- */

check("/proc is mounted", ctx.fs.isDir("/proc"));
check("/dev, /etc and /var/log are mounted", ["/dev", "/etc", "/var/log"].every((p) => ctx.fs.isDir(p)));
check(
  "the mount table lists them",
  ["/home/void", "/proc", "/dev", "/etc", "/var/log"].every((at) =>
    ctx.fs.mounts().some((m) => m.at === at)
  )
);
check(
  "synthetic mounts are marked as such",
  ctx.fs.mounts().find((m) => m.at === "/proc")?.synthetic === true
);

// Generated content must be computed per read, not frozen at mount time.
const up1 = Number(ctx.fs.read("/proc/uptime").split(" ")[0]);
await new Promise((r) => dom.window.setTimeout(r, 30));
const up2 = Number(ctx.fs.read("/proc/uptime").split(" ")[0]);
check("/proc/uptime is live, not a snapshot", up2 > up1);

check("/proc/version names the compositor", ctx.fs.read("/proc/version").includes("stub"));
check("/proc/meminfo reports the filesystem", ctx.fs.read("/proc/meminfo").includes("FsFiles"));
check(
  "/proc lists one directory per process",
  ctx.ps().every((p) => ctx.fs.isDir(`/proc/${p.pid}`))
);
check(
  "/proc/<pid>/status describes the process",
  ctx.fs.read(`/proc/1/status`).includes("Pid:       1")
);

// A read-only mount must still reject mutation, generated or not.
check(
  "/proc rejects writes",
  (() => {
    try {
      ctx.fs.write("/proc/nope", "x");
      return false;
    } catch {
      return true;
    }
  })()
);

// /dev/null is a real sink: writing succeeds and reads back empty.
ctx.fs.write("/dev/null", "this goes nowhere");
check("/dev/null swallows writes", ctx.fs.read("/dev/null") === "");
check("/dev/random differs between reads", ctx.fs.read("/dev/random") !== ctx.fs.read("/dev/random"));

// /etc is generated *and* writable — the sink writes back into the store.
ctx.fs.write("/etc/hostname", "testbox");
check("writing /etc/hostname sets the store", ctx.state.get("system.hostname", "") === "testbox");
check("reading it back agrees", ctx.fs.read("/etc/hostname").trim() === "testbox");

ctx.fs.write("/etc/autostart", "notes\nvitals\n# a comment\nnot-a-module");
check(
  "/etc/autostart parses and drops unknown ids",
  JSON.stringify(ctx.state.get("system.autostart", [])) === '["notes","vitals"]'
);
check("autostart launches what it names", kernel.runAutostart() === 2);
for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
ctx.state.set("system.autostart", []);

check("/var/log/system.log carries the boot", ctx.fs.read("/var/log/system.log").includes("compositor initialised"));
check("notifications are journalled", (() => {
  ctx.notify("smoke test notice");
  return ctx.journal().some((e) => e.tag === "notify" && e.msg === "smoke test notice");
})());
check("df ignores the synthetic mounts", ctx.fs.usage().files < 100);

/* ---------------- trash ---------------- */

ctx.fs.write("/home/void/doomed.txt", "bye");
const trashedName = moveToTrash(ctx, "/home/void/doomed.txt");
check("trashing moves the file", !ctx.fs.exists("/home/void/doomed.txt"));
check("the file is in ~/.Trash", ctx.fs.exists(`/home/void/.Trash/${trashedName}`));
check("the trash remembers where it came from", listTrash(ctx)[0]?.from === "/home/void/doomed.txt");
restoreFromTrash(ctx, trashedName);
check("restore puts it back", ctx.fs.read("/home/void/doomed.txt") === "bye");

// Two files with the same name from different places must both survive.
ctx.fs.mkdirp("/home/void/sub");
ctx.fs.write("/home/void/sub/doomed.txt", "second");
moveToTrash(ctx, "/home/void/doomed.txt");
const second = moveToTrash(ctx, "/home/void/sub/doomed.txt");
check("colliding names are uniquified", second !== "doomed.txt" && listTrash(ctx).length === 2);
check("emptying the trash clears both", emptyTrash(ctx) === 2 && listTrash(ctx).length === 0);

// Start the routing checks from an empty table so they measure routing rather
// than whatever the preceding sections happened to leave open.
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
  "openPath routed a directory to the workspace",
  ctx.openSurfaces().some((s) => s.moduleId === "workspace")
);

// Launching with args must bypass the singleton short-circuit, or a second
// file would silently refocus the first instead of opening.
ctx.fs.write("/home/void/second.md", "# second");
const beforeSecond = ctx.openSurfaces().length;
ctx.openPath("/home/void/second.md");
check("a second file opens its own window", ctx.openSurfaces().length === beforeSecond + 1);

/* ---------------- associations ---------------- */

// The editor's old `handles: ["*"]` claimed every extension there is. A text
// app must not be offered for bytes it can only render as garbage.
ctx.fs.write("/home/void/pic.png", "not really a png");
check(
  "no text app is offered for a binary file",
  ctx.handlersFor("/home/void/pic.png").length === 0
);
check(
  "unclaimed text still falls back to the editor",
  ctx.handlersFor("/home/void/mystery.conf").some((m) => m.id === "editor")
);
check(
  "a directory's handler is the file manager, not the editor",
  ctx.handlersFor("/home/void/adir")[0]?.id === "workspace"
);

// Opening a binary must say so rather than opening an empty editor.
for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
const beforeBinary = ctx.openSurfaces().length;
ctx.openPath("/home/void/pic.png");
check("opening a binary opens nothing", ctx.openSurfaces().length === beforeBinary);

// A user's chosen default must beat the built-in ordering.
ctx.setDefaultApp("/home/void/routed.md", "notes");
check(
  "setting a default app is remembered",
  ctx.state.get("assoc.md", "") === "notes"
);
ctx.state.set("assoc.md", "");

/* ---------------- apps that used to do nothing on their own ---------------- */

for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
kernel.launch("editor");
const start = hud.ownerDocument.querySelector(".ed-start");
check("the editor without a file opens a start pane", Boolean(start));
check(
  "the start pane offers something to open",
  Boolean(start?.querySelector(".ed-start-row") || start?.querySelector(".ed-start-empty"))
);

for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
kernel.launch("webapp");
check(
  "the dev server app without a port offers a picker",
  Boolean(hud.ownerDocument.querySelector(".wa-jobs"))
);

/* ---------------- trash has a window ---------------- */

for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
ctx.fs.write("/home/void/tossme.md", "# bye");
moveToTrash(ctx, "/home/void/tossme.md");
kernel.launch("trash");
const tr = hud.ownerDocument.querySelector(".tr-root");
check("trash app mounted", Boolean(tr));
check(
  "the trash lists what was deleted",
  [...(tr?.querySelectorAll(".tr-name") ?? [])].some((el) => el.textContent === "tossme.md")
);
check("the trash says where it came from", Boolean(tr?.querySelector(".tr-from")));
emptyTrash(ctx);

/* ---------------- the generic apps ---------------- */

check("calculator does arithmetic", present(evaluate("2 + 3 * 4")) === "14");
check("calculator honours parentheses", present(evaluate("(2 + 3) * 4")) === "20");
check("calculator has functions", present(evaluate("sqrt(144)")) === "12");
check("calculator does percentages", present(evaluate("340 * 18%")) === "61.2");
check("calculator carries ans", present(evaluate("ans * 2", 21)) === "42");
check(
  "calculator refuses to reach outside itself",
  (() => {
    try {
      evaluate("constructor");
      return false;
    } catch {
      return true;
    }
  })()
);
check(
  "calculator refuses division by zero",
  (() => {
    try {
      evaluate("1/0");
      return false;
    } catch {
      return true;
    }
  })()
);

for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
kernel.launch("calculator");
check("calculator mounted", Boolean(hud.ownerDocument.querySelector(".calc-input")));

for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
kernel.launch("timer");
check("timer mounted", Boolean(hud.ownerDocument.querySelector(".tm-readout")));

for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
kernel.launch("calendar");
const cal = hud.ownerDocument.querySelector(".cal-root");
check("calendar mounted", Boolean(cal));
check(
  "calendar drew a whole month",
  (cal?.querySelectorAll(".cal-day:not(.pad)").length ?? 0) >= 28
);
check("calendar day keys are local dates", dayKey(new Date(2026, 7, 4)) === "2026-08-04");

/* ---------------- markdown rendering ---------------- */

{
  const md = renderMarkdown(
    "# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n```js\nlet x = 1;\n```\n"
  );
  check("markdown renders a heading", md.querySelector("h1")?.textContent === "Title");
  check("markdown renders emphasis", Boolean(md.querySelector("strong")));
  check("markdown renders lists", md.querySelectorAll(".md-list li").length === 2);
  check("markdown renders code blocks", Boolean(md.querySelector(".md-code")));
  // The renderer never sets innerHTML, so a script tag in a README is text.
  const evil = renderMarkdown("<script>window.pwned = 1</script>\n\n[x](javascript:alert(1))");
  check("markdown does not build script elements", !evil.querySelector("script"));
  check("markdown refuses non-http links", !evil.querySelector("a"));
}

/* ---------------- workspace: files + console over one cwd ---------------- */

for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
ctx.fs.mkdirp("/home/void/ws/inner");
ctx.fs.write("/home/void/ws/alpha.txt", "gamma\nalpha\nbeta\nbeta");
kernel.launch("workspace", { path: "/home/void/ws" });

const ws = hud.ownerDocument.querySelector(".ws-root");
check("workspace mounted", Boolean(ws));
check("workspace has both panes", Boolean(ws?.querySelector(".fm-list") && ws?.querySelector(".term-root")));
check("workspace has a divider", Boolean(ws?.querySelector(".ws-divider")));
check(
  "browser listed the directory",
  [...(ws?.querySelectorAll(".fm-name") ?? [])].some((el) => el.textContent === "alpha.txt")
);

const termInput = ws?.querySelector(".term-input") as HTMLInputElement | null;
const termPrompt = ws?.querySelector(".term-prompt");
// The prompt abbreviates $HOME to `~`, so /home/void/ws shows as ~/ws.
check("console opened at the launch path", termPrompt?.textContent?.includes("~/ws") === true);

/** Type a line into the console and press Enter. */
const runCmd = (line: string) => {
  if (!termInput) return;
  termInput.value = line;
  termInput.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
};
const lastOut = (n = 1) => {
  const rows = [...(ws?.querySelectorAll(".term-out") ?? [])];
  return rows.slice(-n).map((r) => r.textContent ?? "");
};

runCmd("pwd");
check("pwd reports the shared cwd", lastOut()[0] === "/home/void/ws");

// cd in the console must drag the browser pane with it — the whole point of
// merging the two apps.
runCmd("cd inner");
check(
  "cd moved the browser pane too",
  ws?.querySelector(".fm-note")?.textContent === "empty directory"
);
runCmd("cd ..");

// `~` must expand, or every absolute path has to be typed out.
runCmd("cd ~");
check("~ expanded to home", lastOut()[0] !== "no such directory: ~");
runCmd("pwd");
check("~ resolved to /home/void", lastOut()[0] === "/home/void");
runCmd("cd /home/void/ws");

// Pipelines: the filters have to read piped stdin, not just a file argument.
// gamma/alpha/beta/beta -> sorted -> deduped to alpha, beta, gamma.
runCmd("cat alpha.txt | sort | uniq | wc");
check("pipeline through sort|uniq|wc", lastOut()[0] === "3 lines  3 words  16 chars");

runCmd("cat alpha.txt | grep beta | wc");
check("grep filters piped input", lastOut()[0]?.startsWith("2 lines") === true);

// Redirection, including append.
runCmd("echo one > out.txt");
runCmd("echo two >> out.txt");
check("redirect then append wrote both lines", ctx.fs.read("/home/void/ws/out.txt") === "one\ntwo");

// A failing command must break an && chain.
runCmd("cd /nope && echo reached");
check("&& chain stops on failure", lastOut()[0] !== "reached");

// History is persisted through the store, so it survives a reload.
check(
  "console history persisted",
  ctx.state.get<string[]>("console.history", []).includes("pwd")
);

/* ---------------- console: the system commands ---------------- */

runCmd("whoami");
check("whoami reports the user", lastOut()[0] === ctx.state.get("system.user", "void"));

// $VAR expansion, including the derived names that must never go stale.
runCmd("echo $USER at $HOSTNAME");
check(
  "variables expand",
  lastOut()[0] === `${ctx.state.get("system.user", "void")} at ${ctx.state.get("system.hostname", "void")}`
);
runCmd("echo $PWD");
check("$PWD tracks cd", lastOut()[0] === "/home/void/ws");
runCmd("export GREETING=hello");
runCmd("echo $GREETING");
check("export then expand", lastOut()[0] === "hello");
runCmd("echo '$GREETING'");
check("single quotes suppress expansion", lastOut()[0] === "$GREETING");
runCmd("cd /nope");
runCmd("echo $?");
check("$? carries the exit status", lastOut()[0] === "1");
runCmd("cd /home/void/ws");
runCmd("echo $?");
check("$? resets after a success", lastOut()[0] === "0");

// ps must list the same processes the syscall does.
runCmd("ps");
check(
  "ps prints a row per process",
  [...(ws?.querySelectorAll(".term-out") ?? [])]
    .slice(-ctx.ps().length)
    .some((r) => (r.textContent ?? "").includes("kernel"))
);

runCmd("uptime");
check("uptime reports processes and windows", /up .* processes/.test(lastOut()[0] ?? ""));

runCmd("mount");
check(
  "mount lists the synthetic filesystems",
  [...(ws?.querySelectorAll(".term-out") ?? [])]
    .slice(-ctx.fs.mounts().length)
    .some((r) => (r.textContent ?? "").includes("/proc"))
);

runCmd("dmesg warn");
check("dmesg filters by level", !lastOut()[0]?.includes("compositor initialised"));

// Redirecting to /dev/null must work through the ordinary redirect path.
runCmd("ls > /dev/null");
check("redirect to /dev/null discards", ctx.fs.read("/dev/null") === "");

// rm is recoverable by default and permanent only when asked.
ctx.fs.write("/home/void/ws/temp.txt", "x");
runCmd("rm temp.txt");
check("rm sends to the trash", !ctx.fs.exists("/home/void/ws/temp.txt") && listTrash(ctx).length === 1);
runCmd("restore temp.txt");
check("restore brings it back", ctx.fs.read("/home/void/ws/temp.txt") === "x");
runCmd("rm -f temp.txt");
check("rm -f is permanent", !ctx.fs.exists("/home/void/ws/temp.txt") && listTrash(ctx).length === 0);

// Dotfiles are hidden unless asked for.
ctx.fs.write("/home/void/ws/.hidden", "x");
runCmd("ls");
const lsRows = [...(ws?.querySelectorAll(".term-out") ?? [])].slice(-6).map((r) => r.textContent ?? "");
check("ls hides dotfiles", !lsRows.some((t) => t === ".hidden"));
runCmd("ls -a");
const lsAllRows = [...(ws?.querySelectorAll(".term-out") ?? [])].slice(-8).map((r) => r.textContent ?? "");
check("ls -a shows them", lsAllRows.some((t) => t === ".hidden"));

/* ---------------- status bar and power ---------------- */

createStatusBar(hud, ctx);
const power = createPower(hud, ctx, { save: () => {}, closeAll: () => {} });

/**
 * Overlays toggled with the `hidden` property must carry an explicit
 * `[hidden] { display: none }` rule.
 *
 * Any author rule setting `display` outranks the UA stylesheet's
 * `[hidden] { display: none }`, so `.power-veil { display: grid }` silently
 * defeats `veil.hidden = true`. The veil then stays laid out at inset:0 with
 * opacity:0, and `#hud > *` grants it pointer-events — an invisible
 * full-screen sheet that eats every click in the viewport. That is the exact
 * failure the comment above `#hud > .toasts` warns about, and it shipped.
 *
 * This is a source assertion rather than a getComputedStyle one on purpose:
 * jsdom applies `hidden` as a hard override instead of a cascading UA rule, so
 * a computed-style check passes whether or not the guard exists and would be
 * worse than no test at all.
 *
 * Add a class here whenever something new is shown and hidden via `.hidden`.
 */
const css = readFileSync("packages/ui/src/style.css", "utf8");
for (const cls of ["power-veil", "statusbar", "sb-popover", "pt-marks", "pt-frame"]) {
  const declaresDisplay = new RegExp(`\\.${cls}\\s*\\{[^}]*display:`).test(css);
  const hasGuard = new RegExp(
    `\\.${cls}\\[hidden\\]\\s*\\{[^}]*display:\\s*none`
  ).test(css);
  check(`.${cls} guards its hidden state against its own display rule`, hasGuard || !declaresDisplay);
}
const bar = hud.ownerDocument.querySelector(".statusbar");
check("status bar mounted", Boolean(bar));
check("status bar shows user@host", (bar?.querySelector(".sb-who")?.textContent ?? "").includes("@"));
check("status bar shows a clock", /^\d\d:\d\d/.test(bar?.querySelector(".sb-clock")?.textContent ?? ""));
check("status bar counts processes", /\d/.test(bar?.querySelector(".sb-procs")?.textContent ?? ""));

check("power starts unlocked", power.locked() === false);
ctx.emit("system.power", { action: "lock" });
check("lock raises the veil", power.locked() === true);
check("lock screen shows the time", /^\d\d:\d\d$/.test(
  hud.ownerDocument.querySelector(".lock-time")?.textContent ?? ""
));
dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a" }));
check("any key unlocks", power.locked() === false);

/* ---------------- portal ---------------- */

// The address bar has to tell a URL, a bare domain and a search apart.
check("full URLs pass through", resolveQuery("https://example.com/a?b=1") === "https://example.com/a?b=1");
check("bare domains get https", resolveQuery("example.com") === "https://example.com");
check("domains with a path get https", resolveQuery("en.wikipedia.org/wiki/Void") === "https://en.wikipedia.org/wiki/Void");
check("prose becomes a search", resolveQuery("how do magnets work").startsWith("https://html.duckduckgo.com/html/?q="));
check("a single word is a search, not a host", resolveQuery("wikipedia").includes("duckduckgo"));
check("empty stays empty", resolveQuery("   ") === "");

for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
kernel.launch("portal");
const pt = hud.ownerDocument.querySelector(".pt-root");
check("portal mounted", Boolean(pt));
check("portal has an address bar", Boolean(pt?.querySelector(".pt-url")));
check("portal opened one tab", (pt?.querySelectorAll(".pt-tab").length ?? 0) === 1);
check("the only tab has no close button", !pt?.querySelector(".pt-tab-x"));
check("portal made an iframe", Boolean(pt?.querySelector(".pt-frame")));
check(
  "framed content is sandboxed",
  (pt?.querySelector(".pt-frame") as HTMLIFrameElement | null)
    ?.getAttribute("sandbox")
    ?.includes("allow-scripts") === true
);
// No bridge in jsdom, so it must fall back rather than hang.
await new Promise((r) => dom.window.setTimeout(r, 60));
check(
  "no bridge falls back to direct framing with an explanation",
  (pt?.querySelector(".pt-note")?.textContent ?? "").includes("X-Frame-Options")
);

// Bookmarks are a file, so they survive and can be edited like anything else.
check("portal is not a singleton", ctx.registry().find((m) => m.id === "portal")?.singleton === false);

/* ---------------- monitor ---------------- */

for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
kernel.launch("monitor");
const mon = hud.ownerDocument.querySelector(".mon-root");
check("monitor mounted", Boolean(mon));
check("monitor listed processes", (mon?.querySelectorAll(".mon-row").length ?? 0) > 1);
check("daemons have no kill button", (() => {
  const daemonRow = mon?.querySelector(".mon-row.is-daemon");
  return Boolean(daemonRow) && !daemonRow!.querySelector(".mon-kill");
})());

/* ---------------- arcade ---------------- */

for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
kernel.launch("arcade");
const arc = hud.ownerDocument.querySelector(".arcade-root");
check("arcade mounted", Boolean(arc));
check(
  "the shelf listed every cabinet",
  (arc?.querySelectorAll(".arcade-card").length ?? 0) === CABINETS.length
);
check("a cabinet card carries its record", Boolean(arc?.querySelector(".arcade-hi")));
check(
  "every cabinet publishes a palette verb",
  CABINETS.every((c) => ctx.commands().some((cmd) => cmd.id === `arcade.play.${c.id}`))
);

// Launching with a game must drop straight into the cabinet, not the shelf.
// This is also the only path that constructs a Game, so it proves the whole
// simulation can be built without a canvas — jsdom has no 2D context, and
// mountStage's null-context fallback is what keeps that from throwing.
for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
kernel.launch("arcade", { game: "joust" });
const cab = hud.ownerDocument.querySelector(".arcade-view");
check("launching with a game skips the shelf", cab?.classList.contains("stage-host") === true);
check("the cabinet asks for the keyboard", Boolean(cab?.querySelector(".arcade-veil")));

/**
 * The cabinets' own rules, asserted directly.
 *
 * A game is judged by playing it, but the constants underneath it are not:
 * getting a flap-to-gravity ratio or a ghost's speed table wrong leaves
 * something perfectly playable that simply isn't the game it claims to be, and
 * nothing about it looks broken. Those checks live in `arcade-checks.mts` —
 * there are enough of them now, across four cabinets, that keeping them here
 * made this file mostly about the arcade.
 */
await arcadeChecks(check, CABINETS);

/* ---------------- editor: buffer, gutter and run pane ---------------- */

for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
ctx.fs.write("/home/void/hello.js", "console.log('hi')\nconsole.log('there')");
kernel.launch("editor", { path: "/home/void/hello.js" });
const ed = hud.ownerDocument.querySelector(".ed-root");
check("editor mounted", Boolean(ed));
check("editor gutter numbered every line", ed?.querySelectorAll(".ed-gutter div").length === 2);
check("runnable file grew a run pane", Boolean(ed?.querySelector(".ed-out")));
check("run pane has a stdin row", Boolean(ed?.querySelector(".run-input")));

// A non-runnable file must not get the run pane.
for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
kernel.launch("editor", { path: "/home/void/routed.md" });
const edMd = hud.ownerDocument.querySelector(".ed-root");
check("non-runnable file has no run pane", !edMd?.querySelector(".ed-out"));

// Read-only files open as a viewer with no textarea to type into.
for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
ctx.fs.write("/home/void/ro.md", "# ro");
kernel.launch("editor", { path: "/home/void/ro.md" });
const edRw = hud.ownerDocument.querySelector(".ed-root");
check("writable file opens editable", Boolean(edRw?.querySelector(".ed-area")));

/* ---------------- modules loaded at runtime ---------------- */

// Last, because installing and uninstalling moves the registry underneath
// every count above. It puts back what it takes out.
for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
await devkitChecks(check, kernel, ctx);
await typescriptChecks(check, kernel, ctx);
check("the registry is back where it started", ctx.registry().length === MODULE_COUNT);

// Closing everything must not throw.
for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
check("all surfaces closed", ctx.openSurfaces().length === 0);

console.log(
  failures.length ? `\n${failures.length} FAILURE(S)` : "\nall smoke checks passed"
);
process.exit(failures.length ? 1 : 0);
