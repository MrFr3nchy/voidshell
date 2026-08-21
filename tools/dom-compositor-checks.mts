/**
 * Checks for the flat compositor, in jsdom.
 *
 * The point of a second render backend is that the *contract* is real, so what
 * is asserted here is the contract rather than the appearance: that a snapshot
 * round-trips, that the overview is reversible, that the unsupported half
 * declines in the way the kernel's callers already expect, and that the choice
 * between backends prefers the right source.
 *
 * No WebGL is involved, which is the whole reason this backend can be checked
 * headlessly at all — the Three one cannot be, and that asymmetry is worth
 * something on its own.
 *
 *   npx esbuild tools/dom-compositor-checks.mts --bundle --platform=node \
 *     --format=esm --outfile=dom-compositor-checks.mjs --external:jsdom \
 *     --log-level=error && node dom-compositor-checks.mjs
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, {
  pretendToBeVisual: true,
  url: "https://example.test",
});

const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.CustomEvent = dom.window.CustomEvent;
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});

// jsdom reports a 1024x768 window, which is all the projection maths needs.
const VW = dom.window.innerWidth;
const VH = dom.window.innerHeight;

const { DomCompositor } = await import("../packages/ui/src/compositor/DomCompositor");
const { chooseBackend, AUTO, BACKEND_KEY } = await import(
  "../packages/ui/src/compositor/select"
);

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

const doc = dom.window.document;

function mounts() {
  const make = (id: string) => {
    const el = doc.createElement("div");
    el.id = id;
    doc.body.appendChild(el);
    return el;
  };
  return { gl: make("void"), overlay: make("panel-layer"), hud: make("hud") };
}

let seq = 0;
function surface(title = "win", width = 420, height = 300) {
  const element = doc.createElement("div");
  return {
    id: `s${++seq}`,
    moduleId: "test",
    title,
    element,
    width,
    height,
    position: { x: 0, y: 0, z: 0 },
  };
}

/* ---------------- it implements the contract ---------------- */

{
  const c = new DomCompositor();
  c.init(mounts());

  check("it names itself", c.name === "dom-flat");

  const a = surface("alpha");
  const off = c.mountSurface(a);
  check("a mounted surface gets a panel in the overlay", doc.querySelectorAll(".vs-panel").length === 1);
  check("the panel carries its surface id", doc.querySelector(".vs-panel")?.getAttribute("data-surface") === a.id);
  check("the module's element is inside it", doc.querySelector(".vs-panel-content")?.firstChild === a.element);
  check("mounting focuses it", c.activeSurface() === a.id);

  c.retitleSurface(a.id, "renamed");
  check("retitling reaches the title bar", doc.querySelector(".vs-panel-title")?.textContent === "renamed");

  // Closing is the kernel's job; the compositor only asks. Nothing else can
  // run the module's teardown, so a close button that acted directly would
  // leave the surface table holding a window that is no longer on screen.
  let asked = "";
  dom.window.addEventListener("voidshell:close-surface", (e: Event) => {
    asked = (e as CustomEvent<{ id: string }>).detail.id;
  });
  (doc.querySelector(".vs-panel-close") as HTMLElement).click();
  check("the close button asks the shell rather than acting", asked === a.id);

  off();
  check("the disposer drops it from the table", c.stats().panels === 0);
  c.dispose();
  doc.body.replaceChildren();
}

/* ---------------- the unsupported half declines honestly ---------------- */

{
  const c = new DomCompositor();
  c.init(mounts());

  // There is no flat analogue of a window riding a moon's orbit. The contract
  // says an empty id means unsupported, and every caller in the kernel already
  // treats it that way — so declining is a supported answer, not a failure.
  check("it spawns no bodies", c.spawnBody("moon") === "");
  check("and reports none", c.listBodies().length === 0);
  check("stats agree there are none", c.stats().bodies === 0);

  // A patch is published by Settings, which does not know which backend is
  // listening. Half of what arrives is about a nebula that does not exist here.
  c.applyWorldPatch({ nebulaSpin: 4, uStars: 0.9, compass: false, smoothing: 0.4 });
  check("it survives knobs meant for the other world", true);

  c.dispose();
  doc.body.replaceChildren();
}

/* ---------------- a layout survives being written down ---------------- */

{
  const c = new DomCompositor();
  c.init(mounts());
  const a = surface("alpha");
  const b = surface("beta", 500, 380);
  c.mountSurface(a);
  c.mountSurface(b);

  c.arrange("wall");
  const before = c.snapshot();
  check("every window is in the snapshot", Object.keys(before).length === 2);
  check("a snapshot carries a size", before[b.id].width === 500);

  // The round trip is what session restore actually does, and the bug it
  // catches is the one where a window comes back a few pixels out every boot.
  c.placeSurface(a.id, before[a.id]);
  c.placeSurface(b.id, before[b.id]);
  const after = c.snapshot();
  check(
    "placing a snapshot back reproduces it exactly",
    JSON.stringify(after) === JSON.stringify(before)
  );

  // A maximized window's own box is the screen's. Writing that down would make
  // it the floating size on the next boot, and un-maximizing would land on it.
  c.placeSurface(a.id, { ...before[a.id], width: 400, height: 300, snap: "full" });
  const snapped = c.snapshot()[a.id];
  check("a snapped window records its restore box, not the screen", snapped.width === 400);
  check("and records that it was snapped", snapped.snap === "full");

  c.dispose();
  doc.body.replaceChildren();
}

/* ---------------- the overview is a look, not a re-layout ---------------- */

{
  const c = new DomCompositor();
  c.init(mounts());
  for (let i = 0; i < 5; i++) c.mountSurface(surface(`w${i}`));

  c.arrange("scatter");
  const before = JSON.stringify(c.snapshot());

  check("expose reports itself up", c.expose(true) === true);
  check("it actually moved things", JSON.stringify(c.snapshot()) !== before);
  check("asking again while up is not a toggle", c.expose(true) === true);
  check("dismissing reports itself down", c.expose(false) === false);
  // The distinction the interface draws between `expose` and `arrange`: an
  // overview you cannot undo has cost you the arrangement you had.
  check("and every window is back where it was", JSON.stringify(c.snapshot()) === before);

  c.dispose();
  doc.body.replaceChildren();
}

/* ---------------- constellations ---------------- */

{
  const c = new DomCompositor();
  c.init(mounts());
  const a = surface("a");
  const b = surface("b");
  const d = surface("d");
  c.mountSurface(a);
  c.mountSurface(b);
  c.mountSurface(d);

  check("one window is not a constellation", c.linkSurfaces([a.id]) === "");
  const gid = c.linkSurfaces([a.id, b.id], "pair");
  check("two are", gid !== "");
  check("it is listed", c.listGroups().length === 1);
  check("with the name it was given", c.listGroups()[0].name === "pair");

  // Linking into an existing constellation has to grow it. Two groups sharing
  // a member is a state nothing else in the shell knows how to draw.
  c.linkSurfaces([b.id, d.id]);
  check("linking into one merges rather than overlapping", c.listGroups().length === 1);
  check("and the merged one holds all three", c.listGroups()[0].members.length === 3);

  c.unlinkGroup(c.listGroups()[0].id);
  check("dissolving leaves none", c.listGroups().length === 0);

  c.dispose();
  doc.body.replaceChildren();
}

/* ---------------- the view goes back to where the windows are ---------------- */

{
  const c = new DomCompositor();
  c.init(mounts());
  const a = surface("a");
  c.mountSurface(a);
  // Where a session written by the Three backend would land: 3D world
  // coordinates, hundreds of units from a plane's origin.
  c.placeSurface(a.id, {
    anchor: [1400, -900, 560],
    width: 420,
    height: 300,
    pinned: false,
    pinX: 0,
    pinY: 0,
  });

  c.resetView();
  const at = c.focalPoint();
  // Recentring on the origin would leave the window off-screen and the user
  // looking at an empty plane, which is the failure this exists to prevent.
  check("resetView goes to the windows, not to (0,0)", at.x === 1400 && at.y === -900);

  // The third coordinate has nowhere to live on a plane, but dropping it would
  // mean opening the shell flat once silently flattened every saved layout.
  check("the depth a plane cannot use is carried, not discarded", c.snapshot()[a.id].anchor[2] === 560);

  c.dispose();
  doc.body.replaceChildren();
}

/* ---------------- screen and plane are inverses ---------------- */

{
  const c = new DomCompositor();
  c.init(mounts());
  const centre = c.screenToWorld(VW / 2, VH / 2, 0);
  check("the centre of the screen is the focal point", centre.x === 0 && centre.y === 0);

  const off = c.screenToWorld(VW / 2 + 120, VH / 2 - 80, 0);
  check("and offsets carry through unzoomed", off.x === 120 && off.y === -80);

  c.dispose();
  doc.body.replaceChildren();
}

/* ---------------- picking a backend ---------------- */

/**
 * Precedence between three sources is exactly the kind of thing that quietly
 * inverts during a refactor and presents months later as "my setting doesn't
 * stick", so it is asserted rather than assumed.
 */
{
  check(
    "a URL override beats a saved choice",
    chooseBackend({ [BACKEND_KEY]: "three" }, "?compositor=dom", true).id === "dom"
  );
  check(
    "a saved choice beats the probe",
    chooseBackend({ [BACKEND_KEY]: "dom" }, "", true).id === "dom"
  );
  check(
    "with no choice at all, WebGL wins",
    chooseBackend({}, "", true).id === "three"
  );
  check(
    "and without WebGL it falls back",
    chooseBackend({}, "", false).id === "dom"
  );
  // A stored preference for WebGL on a machine that has none is still a black
  // screen. The setting is honoured wherever honouring it is possible.
  const forced = chooseBackend({ [BACKEND_KEY]: "three" }, "", false);
  check("a preference that cannot be met is overridden", forced.id === "dom");
  check("and says it was overridden, so it can be reported", forced.reason === "fallback");
  // `auto` is not a backend. If it were treated as one the probe would never
  // run and every machine would get whichever branch the string fell into.
  check("auto defers to the probe", chooseBackend({ [BACKEND_KEY]: AUTO }, "", false).id === "dom");
  check("nonsense defers to the probe", chooseBackend({ [BACKEND_KEY]: "banana" }, "", true).id === "three");
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("all flat compositor checks passed");
