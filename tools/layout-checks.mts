/**
 * Checks for constellation layouts.
 *
 * Two halves, and the split is the design. The arithmetic — centroid, offsets,
 * pairing slots to ids — is pure and lives in `kernel/layout.ts`, so most of
 * what follows is plain data with no DOM in sight. The second half then runs a
 * real round trip through the flat compositor, because "the numbers are right"
 * and "a window lands where it was" are different claims and only the second
 * one is the feature.
 *
 *   npx esbuild tools/layout-checks.mts --bundle --platform=node \
 *     --format=esm --outfile=layout-checks.mjs --external:jsdom \
 *     --log-level=error && node layout-checks.mjs
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { pretendToBeVisual: true });
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.CustomEvent = dom.window.CustomEvent;
g.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
g.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);

const { captureLayout, placementsFor, layoutFits } = await import(
  "../packages/ui/src/kernel/layout"
);
const { DomCompositor } = await import("../packages/ui/src/compositor/DomCompositor");
type SurfacePlacement = import("../packages/ui/src/kernel/types").SurfacePlacement;

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

const place = (x: number, y: number, z = 0, extra: Partial<SurfacePlacement> = {}): SurfacePlacement => ({
  anchor: [x, y, z],
  width: 420,
  height: 300,
  pinned: false,
  pinX: 0,
  pinY: 0,
  snap: null,
  minimized: false,
  form: "plain",
  ...extra,
});

/* ---------------- the arithmetic ---------------- */

{
  const places = { a: place(100, 0), b: place(-100, 0), c: place(0, 60) };
  const layout = captureLayout("test", ["a", "b", "c"], places)!;

  check("it records which backend made it", layout.backend === "test");
  check("one slot per window", layout.slots.length === 3);

  // Offsets from the group's own centre, so the sum of them is zero. That is
  // the whole property: nothing in a layout refers to where the group was.
  const sum = (k: "dx" | "dy" | "dz") =>
    layout.slots.reduce((a, s) => a + s[k], 0);
  check("the offsets are centred", Math.abs(sum("dx")) < 1e-9 && Math.abs(sum("dy")) < 1e-9);

  // Move the entire group a long way and the layout must be identical: a
  // dashboard saved at the far end of the void is the same dashboard.
  const far = { a: place(9100, 5000), b: place(8900, 5000), c: place(9000, 5060) };
  const moved = captureLayout("test", ["a", "b", "c"], far)!;
  check("moving the whole group changes nothing", JSON.stringify(moved) === JSON.stringify(layout));

  check("sizes are carried", layout.slots.every((s) => s.width === 420 && s.height === 300));
}

/* ---------------- what it declines to remember ---------------- */

{
  check("nothing at all", captureLayout("test", [], {}) === null);
  // One window has no arrangement, and pretending otherwise puts the group's
  // centre on the window itself — restoring it exactly where you already are.
  check("a single window is not an arrangement", captureLayout("test", ["a"], { a: place(5, 5) }) === null);
  check("ids with no placement are ignored", captureLayout("test", ["a", "ghost"], { a: place(5, 5) }) === null);

  // Pinned and snapped windows are measured against the viewport, so their
  // position is a fact about the screen the dashboard was saved on.
  const mixed = {
    a: place(100, 0),
    b: place(-100, 0),
    p: place(0, 0, 0, { pinned: true, pinX: 40, pinY: 40 }),
    s: place(0, 0, 0, { snap: "left" }),
  };
  const only = captureLayout("test", ["a", "b", "p", "s"], mixed)!;
  check("pinned and snapped windows are left out", only.slots.length === 2);
}

/* ---------------- states worth carrying ---------------- */

{
  const places = {
    a: place(50, 0, 0, { minimized: true }),
    b: place(-50, 0, 0, { form: "lamp" }),
  };
  const layout = captureLayout("test", ["a", "b"], places)!;
  check("a collapsed window stays collapsed", layout.slots[0].minimized === true);
  check("a shaped window keeps its shape", layout.slots[1].form === "lamp");
  // "plain" is the absence of a shape, so writing it down would put a field in
  // every slot of every layout to say nothing.
  check("an ordinary panel records no shape", layout.slots[0].form === undefined);
}

/* ---------------- putting it back ---------------- */

{
  const places = { a: place(100, 0), b: place(-100, 0) };
  const layout = captureLayout("test", ["a", "b"], places)!;
  const rows = placementsFor(layout, ["x", "y"], { x: 1000, y: 2000, z: 0 });

  check("it pairs slots with the ids given", rows.map((r) => r.id).join() === "x,y");
  check("centred on where you are looking", rows[0].place.anchor[0] === 1100 && rows[1].place.anchor[0] === 900);
  check("and the shape between them is preserved", rows[0].place.anchor[0] - rows[1].place.anchor[0] === 200);
  // A restored window is a floating window. Carrying "pinned" would stick a
  // dashboard to a corner of a screen it was never saved on.
  check("nothing comes back pinned or snapped", rows.every((r) => !r.place.pinned && !r.place.snap));

  // A dashboard whose app list was edited since, or one where a module refused
  // to launch, should arrange the windows it does have rather than nothing.
  check("fewer ids than slots is not an error", placementsFor(layout, ["x"], { x: 0, y: 0, z: 0 }).length === 1);
  check("more ids than slots is not an error", placementsFor(layout, ["x", "y", "z"], { x: 0, y: 0, z: 0 }).length === 2);
}

/* ---------------- a layout from another world ---------------- */

/**
 * The whole cross-backend policy. `anchor` is a point in a 3D world under one
 * compositor and a point on a plane under the other, in units that do not
 * correspond — so a layout is refused rather than approximated. A dashboard
 * that reopens scattered across the void is worse than one that reopens
 * unarranged, because the second is obviously unarranged.
 */
{
  const layout = captureLayout("three-projected", ["a", "b"], { a: place(1, 0), b: place(-1, 0) })!;
  check("its own backend fits", layoutFits(layout, "three-projected"));
  check("another backend does not", !layoutFits(layout, "dom-flat"));
  check("a dashboard saved before layouts existed does not", !layoutFits(undefined, "dom-flat"));
  check("nor does an empty one", !layoutFits({ backend: "dom-flat", slots: [] }, "dom-flat"));
}

/* ---------------- and a real round trip ---------------- */

/**
 * The claim the feature actually makes: windows land back where they were,
 * relative to each other. Run against a live compositor rather than against
 * the arithmetic, because `snapshot` and `placeSurface` are the pair this
 * rests on and only one of them is exercised above.
 */
{
  const doc = dom.window.document;
  const mount = (id: string) => {
    const el = doc.createElement("div");
    el.id = id;
    doc.body.appendChild(el);
    return el;
  };
  const c = new DomCompositor();
  c.init({ gl: mount("void"), overlay: mount("panel-layer"), hud: mount("hud") });

  let n = 0;
  const surf = () => {
    const element = doc.createElement("div");
    return { id: `s${++n}`, moduleId: "test", title: "w", element, width: 420, height: 300, position: { x: 0, y: 0, z: 0 } };
  };
  const ids = [surf(), surf(), surf()].map((s) => {
    c.mountSurface(s);
    return s.id;
  });

  c.arrange("wall");
  const before = c.snapshot();
  const layout = captureLayout(c.name, ids, before)!;
  check("a live compositor yields a layout", layout.slots.length === 3);
  check("stamped with its own name", layout.backend === "dom-flat");

  // Scatter them, then put them back.
  c.arrange("scatter");
  const scattered = c.snapshot();
  const spread = (p: Record<string, typeof before[string]>) =>
    Math.max(...ids.map((i) => p[i].anchor[0])) - Math.min(...ids.map((i) => p[i].anchor[0]));
  check("scattering moved them", spread(scattered) !== spread(before));

  for (const row of placementsFor(layout, ids, { x: 0, y: 0, z: 0 })) c.placeSurface(row.id, row.place);
  const after = c.snapshot();

  // Relative geometry, not absolute: the group is deliberately re-centred.
  const rel = (p: Record<string, typeof before[string]>) => {
    const cx = ids.reduce((a, i) => a + p[i].anchor[0], 0) / ids.length;
    const cy = ids.reduce((a, i) => a + p[i].anchor[1], 0) / ids.length;
    return ids.map((i) => [p[i].anchor[0] - cx, p[i].anchor[1] - cy].map((v) => v.toFixed(3)).join()).join("|");
  };
  check("the arrangement came back exactly", rel(after) === rel(before));
  check("and so did the sizes", ids.every((i) => after[i].width === before[i].width));

  c.dispose();
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("all layout checks passed");
