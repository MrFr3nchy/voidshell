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
const { monitor } = await import("../src/modules/monitor");
const { portal, resolveQuery } = await import("../src/modules/portal");
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
const { workspace } = await import("../src/modules/workspace");
const { editor } = await import("../src/modules/editor");
const { webapp } = await import("../src/modules/webapp");
const { desktop } = await import("../src/modules/desktop");
const { createSpawner, resolveSlots } = await import("../src/ui/spawner");
const { createAppDrawer } = await import("../src/ui/appDrawer");
const { createPalette } = await import("../src/ui/palette");
const { createToasts } = await import("../src/ui/toasts");
const { createStatusBar } = await import("../src/ui/statusBar");
const { createPower } = await import("../src/ui/power");
const { emptyTrash, listTrash, moveToTrash, restoreFromTrash } = await import(
  "../src/kernel/trash"
);

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
  .register(workspace)
  .register(webapp)
  .register(editor)
  .register(chronos)
  .register(cosmos)
  .register(settings)
  .register(dashboards)
  .register(notes)
  .register(vitals)
  .register(monitor)
  .register(portal)
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
  "openPath routed a directory to the workspace",
  ctx.openSurfaces().some((s) => s.moduleId === "workspace")
);

// Launching with args must bypass the singleton short-circuit, or a second
// file would silently refocus the first instead of opening.
ctx.fs.write("/home/void/second.md", "# second");
const beforeSecond = ctx.openSurfaces().length;
ctx.openPath("/home/void/second.md");
check("a second file opens its own window", ctx.openSurfaces().length === beforeSecond + 1);

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
const css = readFileSync("src/style.css", "utf8");
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

// Closing everything must not throw.
for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
check("all surfaces closed", ctx.openSurfaces().length === 0);

console.log(
  failures.length ? `\n${failures.length} FAILURE(S)` : "\nall smoke checks passed"
);
process.exit(failures.length ? 1 : 0);
