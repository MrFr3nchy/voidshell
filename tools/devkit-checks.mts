/**
 * The runtime module path, asserted end to end.
 *
 * These live outside smoke.mts for the same reason the arcade's do: there are
 * enough of them to drown the file they'd otherwise sit in.
 *
 * The interesting property is not that a module loads — it is that unloading
 * one leaves *nothing behind*. A module publishes settings, commands, a
 * process and windows, and every one of those is a way to leak. A loader
 * without a matching teardown looks perfect right up until the third reload,
 * by which point the palette has three copies of the same verb and the id is
 * permanently taken.
 */
import type { Kernel } from "../packages/ui/src/kernel/Kernel";
import type { KernelContext, VoidModule } from "../packages/ui/src/kernel/types";

type Check = (label: string, ok: boolean) => void;

/** A minimal but complete module, built fresh so each check starts clean. */
const SOURCE = (id: string, extra = "") => `
export default {
  manifest: { id: ${JSON.stringify(id)}, name: ${JSON.stringify(id)}, kind: "app", glyph: "*", blurb: "test" },
  activate(ctx) {
    ctx.defineSetting({ key: "${id}.knob", label: "knob", kind: "toggle", group: "System", default: true });
    ctx.defineCommand({ id: "${id}.verb", label: "verb", run: () => {} });
    ${extra}
    return () => {};
  },
  launch(ctx) {
    ctx.openSurface({ title: ${JSON.stringify(id)}, render: (root) => { root.className = "rt-mounted"; } });
  },
};
`;

export async function devkitChecks(
  check: Check,
  kernel: Kernel,
  ctx: KernelContext
): Promise<void> {
  const { loadModuleSource, asVoidModule } = await import(
    "../packages/ui/src/runtime/loadModule"
  );

  /* ---------------- validation ---------------- */

  const rejects = async (label: string, source: string) => {
    try {
      await loadModuleSource(source);
      check(`rejects ${label}`, false);
    } catch {
      check(`rejects ${label}`, true);
    }
  };

  await rejects("source that exports nothing", "export default null");
  await rejects("a module with no manifest", "export default { activate(){} }");
  await rejects(
    "a manifest with no id",
    'export default { manifest: { name: "x", kind: "app" }, activate(){} }'
  );
  await rejects(
    "an unknown module kind",
    'export default { manifest: { id: "x", name: "x", kind: "widget" }, activate(){} }'
  );
  await rejects(
    "a module with no activate",
    'export default { manifest: { id: "x", name: "x", kind: "app" } }'
  );
  // An app with no launch() registers, appears in the launcher, and does
  // nothing when clicked. That is worse than refusing it.
  await rejects(
    "an app that could never be opened",
    'export default { manifest: { id: "x", name: "x", kind: "app" }, activate(){} }'
  );
  await rejects("source that does not parse", "export default { oops");

  check(
    "a service module needs no launch",
    Boolean(
      asVoidModule({
        manifest: { id: "svc", name: "svc", kind: "service" },
        activate: () => {},
      })
    )
  );

  /* ---------------- loading ---------------- */

  const mod = await loadModuleSource(SOURCE("rt-one"));
  check("source loads into a module", mod.manifest.id === "rt-one");
  check("the loaded module is callable", typeof mod.activate === "function");

  // Loading the same source twice must produce genuinely separate modules, or
  // "reload" silently hands back the instance that is already running.
  const again = await loadModuleSource(SOURCE("rt-one"));
  check("re-loading builds a fresh module", again !== mod);

  /* ---------------- installing ---------------- */

  const before = ctx.registry().length;
  const settingsBefore = ctx.settings().length;
  const commandsBefore = ctx.commands().length;

  kernel.install(mod);
  check("installing adds it to the registry", ctx.registry().length === before + 1);
  check(
    "the registry reports it by id",
    ctx.registry().some((m) => m.id === "rt-one")
  );
  check("it is listed as runtime-installed", kernel.runtimeModules().includes("rt-one"));

  // activate() must actually have run — a module that registers without
  // activating is present and inert, which is the hardest kind of broken.
  check(
    "installing activates it",
    ctx.settings().length === settingsBefore + 1 &&
      ctx.commands().length === commandsBefore + 1
  );

  kernel.launch("rt-one");
  check(
    "a runtime module launches like any other",
    ctx.openSurfaces().some((s) => s.moduleId === "rt-one")
  );
  // Typed narrowly rather than reaching for the DOM lib: this file is a Node
  // harness that happens to run against jsdom.
  const doc = (globalThis as { document?: { querySelector(s: string): unknown } }).document;
  check("its window actually rendered", Boolean(doc?.querySelector(".rt-mounted")));

  /* ---------------- hot reload ---------------- */

  // The whole point. Loading the same id again must replace what is running
  // rather than fail on a duplicate.
  const replacement = await loadModuleSource(SOURCE("rt-one"));
  kernel.uninstall("rt-one");
  kernel.install(replacement);
  check(
    "reloading the same id does not duplicate it",
    ctx.registry().filter((m) => m.id === "rt-one").length === 1
  );
  check(
    "reloading does not duplicate its settings",
    ctx.settings().filter((d) => d.key === "rt-one.knob").length === 1
  );
  check(
    "reloading does not duplicate its commands",
    ctx.commands().filter((c) => c.id === "rt-one.verb").length === 1
  );
  check("replacing closed the old window", !ctx.openSurfaces().some((s) => s.moduleId === "rt-one"));

  /* ---------------- uninstalling ---------------- */

  kernel.launch("rt-one");
  const pid = ctx.ps().find((p) => p.moduleId === "rt-one")?.pid;
  check("a launched runtime module has a process", typeof pid === "number");

  const removed = kernel.uninstall("rt-one");
  check("uninstall reports success", removed === true);
  check("it left the registry", !ctx.registry().some((m) => m.id === "rt-one"));
  check("its windows were closed", !ctx.openSurfaces().some((s) => s.moduleId === "rt-one"));
  check("its process was reaped", !ctx.ps().some((p) => p.pid === pid));
  check(
    "its settings went with it",
    !ctx.settings().some((d) => d.key === "rt-one.knob")
  );
  check(
    "its commands went with it",
    !ctx.commands().some((c) => c.id === "rt-one.verb")
  );
  check("it is no longer listed as installed", !kernel.runtimeModules().includes("rt-one"));
  check("uninstalling it twice is refused", kernel.uninstall("rt-one") === false);

  /* ---------------- teardown runs ---------------- */

  check("a module's own cleanup runs on uninstall", await (async () => {
    let torn = false;
    const watcher: VoidModule = {
      manifest: { id: "rt-teardown", name: "rt-teardown", kind: "service" },
      activate: () => () => void (torn = true),
    };
    kernel.install(watcher);
    kernel.uninstall("rt-teardown");
    return torn;
  })());

  /* ---------------- the built-ins are not removable ---------------- */

  // Uninstalling `aurora` would take every colour in the build with it, and
  // there would be no way to put it back without a reload. A module the shell
  // was compiled with is not something devkit installed, so it is not
  // something devkit gets to remove.
  const auroraGone = kernel.uninstall("aurora");
  check("a built-in module refuses to be uninstalled", auroraGone === false);
  check(
    "and it is still registered",
    ctx.registry().some((m) => m.id === "aurora")
  );

  check("uninstalling a module that never existed is refused", kernel.uninstall("nope") === false);

  /* ---------------- installing over a built-in ---------------- */

  check("a runtime module cannot squat a registered id", (() => {
    try {
      kernel.install({
        manifest: { id: "aurora", name: "impostor", kind: "service" },
        activate: () => {},
      });
      return false;
    } catch {
      return true;
    }
  })());

  /* ---------------- a module that throws ---------------- */

  // A broken module must fail loudly and leave nothing behind, rather than
  // half-installing and poisoning the registry.
  check("a module that throws while activating does not stay registered", (() => {
    try {
      kernel.install({
        manifest: { id: "rt-boom", name: "rt-boom", kind: "service" },
        activate: () => {
          throw new Error("boom");
        },
      });
    } catch {
      /* expected */
    }
    return !ctx.registry().some((m) => m.id === "rt-boom");
  })());

  for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
}
