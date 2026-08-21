/**
 * The capability layer, checked without a browser.
 *
 *   npx esbuild tools/caps-checks.mts --bundle --platform=node --format=esm \
 *     --outfile=caps-checks.mjs --log-level=error && node caps-checks.mjs
 *
 * Two things are being proven here, and they pull in opposite directions.
 *
 * The first is that a declared permission list is actually enforced — every
 * gated syscall throws for a module that didn't ask for it. That one is easy
 * to write and easy to believe.
 *
 * The second is the one worth the file: that **nothing is gated by accident**.
 * A restriction layer that quietly fenced off `ps` or `on` would break modules
 * in ways that look like the modules being buggy, and it would do it silently.
 * So the ungated surface is asserted explicitly, name by name, against a
 * context granted nothing at all.
 */

import {
  CAPABILITIES,
  CAPABILITY_BLURBS,
  CapabilityError,
  formatPermissions,
  PRIVILEGED_EVENTS,
  SAFE_DEFAULT,
  isCapability,
  parsePermissions,
  restrict,
  type Capability,
} from "../packages/ui/src/kernel/caps";
import type { KernelContext } from "../packages/ui/src/kernel/types";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

function throws(label: string, run: () => unknown, cap?: Capability): void {
  checks++;
  try {
    run();
    failures++;
    console.error(`  ✗ ${label} — did not throw`);
  } catch (err) {
    if (!(err instanceof CapabilityError)) {
      failures++;
      console.error(`  ✗ ${label} — threw ${String(err)}, expected CapabilityError`);
      return;
    }
    if (cap && err.capability !== cap) {
      failures++;
      console.error(`  ✗ ${label} — blamed "${err.capability}", expected "${cap}"`);
    }
  }
}

function allows(label: string, run: () => unknown): void {
  checks++;
  try {
    run();
  } catch (err) {
    failures++;
    console.error(`  ✗ ${label} — threw ${String(err)}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/* ------------------------------------------------------------------ */
/* A context that records what reached it                              */
/* ------------------------------------------------------------------ */

interface Trace {
  calls: string[];
  ctx: KernelContext;
}

/**
 * Every syscall, stubbed to record its own name.
 *
 * Built by hand rather than with a Proxy so that a syscall added to
 * `KernelContext` without a decision about which permission it falls under
 * fails *here*, at compile time, rather than shipping ungated.
 */
function traceContext(): Trace {
  const calls: string[] = [];
  const note =
    <T,>(name: string, value: T) =>
    (): T => {
      calls.push(name);
      return value;
    };

  const ctx: KernelContext = {
    emit: (type) => void calls.push(`emit:${type}`),
    on: () => {
      calls.push("on");
      return () => {};
    },
    state: {
      get: <T,>(_k: string, fallback: T): T => {
        calls.push("state.get");
        return fallback;
      },
      set: () => void calls.push("state.set"),
      subscribe: () => {
        calls.push("state.subscribe");
        return () => {};
      },
    },
    fs: {
      ls: note("fs.ls", []),
      read: note("fs.read", ""),
      write: () => void calls.push("fs.write"),
      mkdir: () => void calls.push("fs.mkdir"),
      mkdirp: () => void calls.push("fs.mkdirp"),
      rm: () => void calls.push("fs.rm"),
      mv: () => void calls.push("fs.mv"),
      stat: note("fs.stat", {
        name: "x",
        path: "/x",
        kind: "file" as const,
        size: 0,
        readonly: false,
        mtime: 0,
      }),
      exists: note("fs.exists", true),
      isDir: note("fs.isDir", false),
      onChange: note("fs.onChange", () => {}),
      usage: note("fs.usage", { files: 0, dirs: 0, bytes: 0, indexed: 0 }),
      mounts: note("fs.mounts", []),
    },
    openSurface: note("openSurface", {
      id: "s1",
      moduleId: "m",
      title: "t",
      element: null as unknown as HTMLElement,
      width: 1,
      height: 1,
      position: { x: 0, y: 0, z: 0 },
    }),
    closeSurface: () => void calls.push("closeSurface"),
    setTitle: () => void calls.push("setTitle"),
    openSurfaces: note("openSurfaces", []),
    focusSurface: () => void calls.push("focusSurface"),
    activeSurface: note("activeSurface", null),
    expose: note("expose", false),
    lookAt: () => void calls.push("lookAt"),
    lookAtGroup: () => void calls.push("lookAtGroup"),
    resetView: () => void calls.push("resetView"),
    patchWorld: () => void calls.push("patchWorld"),
    spawnBody: note("spawnBody", ""),
    destroyBody: () => void calls.push("destroyBody"),
    attachSurface: () => void calls.push("attachSurface"),
    listBodies: note("listBodies", []),
    linkSurfaces: note("linkSurfaces", ""),
    unlinkGroup: () => void calls.push("unlinkGroup"),
    listGroups: note("listGroups", []),
    arrange: () => void calls.push("arrange"),
    launch: () => void calls.push("launch"),
    launchAt: () => void calls.push("launchAt"),
    openPath: () => void calls.push("openPath"),
    handlersFor: note("handlersFor", []),
    openWith: () => void calls.push("openWith"),
    setDefaultApp: () => void calls.push("setDefaultApp"),
    focalPoint: note("focalPoint", { x: 0, y: 0, z: 0 }),
    mountAnchored: note("mountAnchored", {
      setAnchor: () => {},
      getAnchor: () => ({ x: 0, y: 0, z: 0 }),
      dispose: () => {},
    }),
    screenToWorld: note("screenToWorld", { x: 0, y: 0, z: 0 }),
    registry: note("registry", []),
    defineSetting: () => void calls.push("defineSetting"),
    settings: note("settings", []),
    defineCommand: () => void calls.push("defineCommand"),
    commands: note("commands", []),
    notify: () => void calls.push("notify"),
    stats: note("stats", { fps: 0, panels: 0, bodies: 0, groups: 0 }),
    ps: note("ps", []),
    kill: note("kill", true),
    log: () => void calls.push("log"),
    journal: note("journal", []),
    uptime: note("uptime", 0),
    stage: {
      mount: note("stage.mount", () => {}),
      palette: note("stage.palette", {
        cyan: "",
        magenta: "",
        ember: "",
        text: "",
        dim: "",
      }),
      withAlpha: note("stage.withAlpha", ""),
      rgbOf: note("stage.rgbOf", [0, 0, 0] as [number, number, number]),
      toolbar: note("stage.toolbar", null as unknown as HTMLElement),
      toolButton: note("stage.toolButton", null as unknown as HTMLButtonElement),
    },
    audio: {
      burst: () => void calls.push("audio.burst"),
      tone: () => void calls.push("audio.tone"),
      enabled: note("audio.enabled", false),
    },
  };

  return { calls, ctx };
}

/** A restricted context granted exactly `caps`, plus the denials it recorded. */
function fenced(caps: Capability[]): {
  ctx: KernelContext;
  denials: CapabilityError[];
  calls: string[];
} {
  const { ctx: raw, calls } = traceContext();
  const denials: CapabilityError[] = [];
  const granted = new Set(caps);
  const ctx = restrict(raw, {
    moduleId: "probe",
    granted: () => granted,
    onDenied: (err) => denials.push(err),
  });
  return { ctx, denials, calls };
}

/* ------------------------------------------------------------------ */

section("parsePermissions");
{
  ok("undefined is undeclared", parsePermissions("m", undefined) === null);
  ok("null is undeclared", parsePermissions("m", null) === null);

  const empty = parsePermissions("m", []);
  ok("an empty array is a declaration, not an absence", Array.isArray(empty) && empty.length === 0);

  const parsed = parsePermissions("m", ["shell", "fs.read", "fs.read"]);
  ok(
    "deduplicated and put in canonical order",
    JSON.stringify(parsed) === JSON.stringify(["fs.read", "shell"]),
    JSON.stringify(parsed)
  );

  let threw = "";
  try {
    parsePermissions("m", ["fs.reed"]);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  ok("a typo throws rather than silently granting nothing", threw.includes("fs.reed"), threw);
  ok("and the message lists what is valid", threw.includes("state.write"), threw);

  let notArray = "";
  try {
    parsePermissions("m", "fs.read");
  } catch (err) {
    notArray = err instanceof Error ? err.message : String(err);
  }
  ok("a bare string is refused", notArray.includes("must be an array"), notArray);

  ok("every capability has a blurb", CAPABILITIES.every((c) => !!CAPABILITY_BLURBS[c]));
  ok("isCapability rejects nonsense", !isCapability("fs.everything"));
  ok("SAFE_DEFAULT is all real capabilities", SAFE_DEFAULT.every(isCapability));
}

section("a module granted nothing");
{
  const { ctx, denials } = fenced([]);

  throws("fs.read is refused", () => ctx.fs.read("/etc/passwd"), "fs.read");
  throws("fs.ls is refused", () => ctx.fs.ls("/"), "fs.read");
  throws("fs.write is refused", () => ctx.fs.write("/a", "b"), "fs.write");
  throws("fs.rm is refused", () => ctx.fs.rm("/a"), "fs.write");
  throws("state.set is refused", () => ctx.state.set("k", 1), "state.write");
  throws("openSurface is refused", () => ctx.openSurface({ title: "t", render: () => {} }), "surface");
  throws("spawnBody is refused", () => ctx.spawnBody("sun"), "world");
  // Both halves of the layout pair, because gating only one of them is how a
  // fence acquires a gap: reading where every window sits is a survey of the
  // void, and applying a layout moves other modules' windows through it.
  throws("captureLayout is refused", () => ctx.captureLayout(["a"]), "world");
  throws(
    "applyLayout is refused",
    () => ctx.applyLayout({ backend: "x", slots: [] }, ["a"]),
    "world"
  );
  throws("launch is refused", () => ctx.launch("editor"), "launch");
  throws("kill is refused", () => ctx.kill(3), "process");
  throws("notify is refused", () => ctx.notify("hi"), "shell");
  throws("defineCommand is refused", () => ctx.defineCommand({ id: "x", label: "x", run: () => {} }), "shell");

  ok("each refusal was reported once", denials.length > 0);
  const seen = new Set(denials.map((d) => d.capability));
  ok(
    "and deduplicated by capability",
    denials.length === seen.size,
    `${denials.length} denials, ${seen.size} distinct`
  );
  ok(
    "the message names the manifest field",
    denials.every((d) => d.message.includes("manifest.permissions")),
    denials[0]?.message
  );
}

section("what stays open to a module granted nothing");
{
  const { ctx, calls } = fenced([]);

  // Every one of these is a deliberate decision, not an oversight. If a future
  // change fences one of them, this section is where that shows up.
  allows("subscribing to the bus", () => ctx.on("anything", () => {}));
  allows("emitting an ordinary event", () => ctx.emit("mymodule.tick", 1));
  allows("reading state", () => ctx.state.get("k", 0));
  allows("subscribing to state", () => ctx.state.subscribe("k", () => {}));
  allows("reading the registry", () => ctx.registry());
  allows("reading settings definitions", () => ctx.settings());
  allows("reading commands", () => ctx.commands());
  allows("reading the process table", () => ctx.ps());
  allows("reading the journal", () => ctx.journal());
  allows("writing to the journal", () => ctx.log("hello"));
  allows("reading uptime", () => ctx.uptime());
  allows("reading compositor stats", () => ctx.stats());
  allows("asking which apps handle a path", () => ctx.handlersFor("/a.md"));
  allows("reading the focal point", () => ctx.focalPoint());
  allows("projecting a screen point", () => ctx.screenToWorld(0, 0, 1));
  allows("the canvas stage", () => ctx.stage.palette());
  allows("audio", () => ctx.audio.enabled());

  ok("the ungated calls really reached the kernel", calls.length >= 15, String(calls.length));
}

section("privileged events");
{
  const { ctx, calls } = fenced([]);
  for (const prefix of PRIVILEGED_EVENTS) {
    throws(`emit "${prefix}…" needs shell`, () => ctx.emit(`${prefix}factoryReset`), "shell");
  }
  ok(
    "and none of them reached the bus",
    !calls.some((c) => c.startsWith("emit:")),
    calls.join(",")
  );

  const withShell = fenced(["shell"]);
  allows("granted shell, the same event goes through", () =>
    withShell.ctx.emit("shell.factoryReset")
  );
  ok(
    "and it did reach the bus",
    withShell.calls.includes("emit:shell.factoryReset"),
    withShell.calls.join(",")
  );
}

section("a module granted what it asked for");
{
  const { ctx, calls, denials } = fenced(["fs.read", "surface", "shell"]);

  allows("reads its files", () => ctx.fs.read("/home/void/notes.md"));
  allows("opens a window", () => ctx.openSurface({ title: "t", render: () => {} }));
  allows("raises a notice", () => ctx.notify("hello"));
  throws("but still cannot write", () => ctx.fs.write("/a", "b"), "fs.write");
  throws("and still cannot launch", () => ctx.launch("editor"), "launch");

  ok("granted calls reached the kernel", calls.includes("fs.read") && calls.includes("openSurface"));
  ok("only the ungranted ones were denied", denials.length === 2, String(denials.length));
}

section("grants are resolved per call, not at wrap time");
{
  // The property that makes a strict-mode toggle mean anything: a module holds
  // the context it was activated with forever, so if grants were snapshotted
  // when the context was built, turning restriction on would do nothing until
  // reload while reporting that it had.
  const { ctx: raw } = traceContext();
  let granted: ReadonlySet<Capability> | null = null;
  const ctx = restrict(raw, { moduleId: "probe", granted: () => granted });

  allows("trusted while grants resolve to null", () => ctx.fs.write("/a", "b"));
  granted = new Set<Capability>(["surface"]);
  throws("refused the moment the policy changes", () => ctx.fs.write("/a", "b"), "fs.write");
  allows("and what the new policy allows still works", () =>
    ctx.openSurface({ title: "t", render: () => {} })
  );
  granted = null;
  allows("and back again", () => ctx.fs.write("/a", "b"));
}

section("the restricted context is still a KernelContext");
{
  const { ctx: raw } = traceContext();
  const ctx = restrict(raw, { moduleId: "probe", granted: () => null });
  const missing = (Object.keys(raw) as (keyof KernelContext)[]).filter(
    (k) => ctx[k] === undefined
  );
  ok("no syscall was dropped by the wrapper", missing.length === 0, missing.join(", "));

  const wrongType = (Object.keys(raw) as (keyof KernelContext)[]).filter(
    (k) => typeof ctx[k] !== typeof raw[k]
  );
  ok("and none changed shape", wrongType.length === 0, wrongType.join(", "));
}

section("/proc/permissions");
{
  const text = formatPermissions([
    { id: "editor", runtime: false, declared: null, granted: null },
    { id: "hello", runtime: true, declared: null, granted: null },
    { id: "clock", runtime: true, declared: ["surface"], granted: ["surface"] },
    { id: "inert", runtime: true, declared: [], granted: [] },
  ]);
  ok("built-in modules are named as such", text.includes("built-in"), text);
  ok("an undeclared runtime module is called out", text.includes("declared nothing"), text);
  ok("a module that asked for nothing reads as nothing", text.includes("(nothing)"), text);
  ok("the legend explains every capability", CAPABILITIES.every((c) => text.includes(c)));
  ok("and names the strict-mode key", text.includes("security.strictModules"), text);
}

/* ------------------------------------------------------------------ */

console.log(
  `\n${failures ? "FAILED" : "ok"} — ${checks - failures}/${checks} capability checks passed`
);
process.exit(failures ? 1 : 0);
