/**
 * TypeScript modules, asserted end to end.
 *
 * The compiler here is the `esbuild` npm package rather than `esbuild-wasm`.
 * That is not a substitute: it is the same compiler, same version, pinned
 * together in package.json — the wasm build is the identical Go program
 * compiled for a different target. What it cannot cover is the *worker*
 * plumbing, so that is tested separately against a stub, and the one genuinely
 * untested thing is instantiating the wasm in a real browser worker.
 *
 * The property worth defending is not "TypeScript loads". It is that a module
 * which compiled and then failed reports the line the author wrote, not the
 * line esbuild emitted, because stripping types is not line-preserving and the
 * gap is easily a dozen lines.
 */
import type { Kernel } from "../packages/ui/src/kernel/Kernel";
import type { KernelContext } from "../packages/ui/src/kernel/types";
import type { TransformRequest } from "../packages/ui/src/runtime/transformProtocol";

type Check = (label: string, ok: boolean) => void;

/** Types above, code below, so generated line numbers can't accidentally match. */
const SPACED = `interface Big {
  a: string;
  b: number;
  c: Array<
    string
  >;
}

type Pair<T> = { left: T; right: T };

function pick<T>(p: Pair<T>): T {
  return p.left;
}

const first: string = pick({ left: "l", right: "r" });
throw new Error(\`late failure: \${first}\`);
`;
/** The line `throw` is on in the source above. */
const THROW_LINE = 16;

/** A real module, written the way somebody would actually write one. */
const TS_MODULE = `
interface Surface {
  title: string;
}

type Decorate<T extends Surface> = (input: T) => T;

const shout: Decorate<Surface> = (input) => ({ ...input, title: input.title.toUpperCase() });

export default {
  manifest: { id: "rt-ts", name: "rt-ts", kind: "app", glyph: "T", blurb: "typed" },
  activate(ctx: any) {
    ctx.defineCommand({ id: "rt-ts.verb", label: shout({ title: "verb" }).title, run: () => {} });
    return () => {};
  },
  launch(ctx: any) {
    ctx.openSurface({
      title: shout({ title: "rt-ts" }).title,
      render: (root: any) => {
        root.className = "ts-mounted";
      },
    });
  },
};
`;

export async function typescriptChecks(
  check: Check,
  kernel: Kernel,
  ctx: KernelContext
): Promise<void> {
  const esbuild = await import("esbuild");
  const { createMapping } = await import("../packages/ui/src/runtime/sourcemap");
  const { loadModuleSource, ModuleLoadError } = await import(
    "../packages/ui/src/runtime/loadModule"
  );
  const { describeBuildFailure, needsTransform } = await import(
    "../packages/ui/src/runtime/transformProtocol"
  );
  const { createTransformClient } = await import("../packages/ui/src/runtime/transform");
  const { isModuleFile } = await import("../packages/ui/src/modules/devkit/protocol");

  const compile = (source: string, sourcefile: string) =>
    esbuild.transform(source, {
      loader: "ts",
      format: "esm",
      target: "es2021",
      sourcemap: true,
      sourcefile,
    });

  /* ---------------- which files go through the compiler ---------------- */

  check(
    "TypeScript is compiled and JavaScript is not",
    needsTransform("/home/void/modules/a.ts") &&
      needsTransform("/home/void/modules/a.mts") &&
      !needsTransform("/home/void/modules/a.js") &&
      !needsTransform("/home/void/modules/a.mjs")
  );
  // JSX needs a factory to compile against, and modules render DOM directly.
  check("tsx is not claimed", !needsTransform("/home/void/modules/a.tsx"));
  check(
    "devkit lists .ts files as loadable",
    isModuleFile("a.ts") && isModuleFile("a.mts") && !isModuleFile("a.tsx")
  );

  /* ---------------- compile errors carry a place ---------------- */

  const failure = await (async () => {
    try {
      await compile("const x: number = ;\n", "m.ts");
      return null;
    } catch (err) {
      return describeBuildFailure(err);
    }
  })();

  check("a module that does not compile reports why", Boolean(failure?.message));
  check("a compile error reports its line", failure?.line === 1);
  // esbuild counts columns from 0 and every gutter counts from 1. Converted
  // once, here, rather than at each place that renders it.
  check("and a column an editor can use", failure?.column === 19);

  /* ---------------- the map, and why it has to exist ---------------- */

  const spaced = await compile(SPACED, "spaced.ts");
  const generatedLine =
    spaced.code.split("\n").findIndex((l) => l.includes("late failure")) + 1;

  // Assert the problem before asserting the fix. If esbuild ever became
  // line-preserving this check would fail, and the mapping below would quietly
  // become dead weight rather than silently keep working.
  check(
    "stripping types does not preserve line numbers",
    generatedLine > 0 && generatedLine !== THROW_LINE
  );

  const mapping = createMapping(spaced.map);
  check("a source map decodes", Boolean(mapping));
  check(
    "and puts a generated line back where it was written",
    mapping?.originalAt(generatedLine, 1)?.line === THROW_LINE
  );
  check("a map we cannot read is not fatal", createMapping("{{not json") === null);
  check("neither is a map with no mappings", createMapping('{"version":3}') === null);

  /* ---------------- a runtime error reports the author's line ---------------- */

  const located = await (async () => {
    try {
      await loadModuleSource(spaced.code, { origin: createMapping(spaced.map) });
      return null;
    } catch (err) {
      return err instanceof ModuleLoadError ? err : null;
    }
  })();
  check("a module that throws while loading still fails", Boolean(located));
  check("and reports the line in the TypeScript, not the generated code", located?.line === THROW_LINE);

  // The negative control. Without the map the very same error lands on the
  // generated line — a real line number, confidently wrong, pointing into the
  // middle of an interface the author wrote.
  const unmapped = await (async () => {
    try {
      await loadModuleSource(spaced.code);
      return null;
    } catch (err) {
      return err instanceof ModuleLoadError ? err : null;
    }
  })();
  check(
    "without the map it would have reported the generated line instead",
    unmapped?.line === generatedLine && unmapped.line !== THROW_LINE
  );

  // A compiled module whose map cannot answer must report nothing rather than
  // a position in the wrong coordinate system.
  const dropped = await (async () => {
    try {
      await loadModuleSource(spaced.code, { origin: { originalAt: () => null } });
      return null;
    } catch (err) {
      return err instanceof ModuleLoadError ? err : null;
    }
  })();
  check("an unanswerable map drops the location rather than guessing", dropped?.line === undefined);

  /* ---------------- a real typed module loads and runs ---------------- */

  const built = await compile(TS_MODULE, "rt-ts.ts");
  const mod = await loadModuleSource(built.code, { origin: createMapping(built.map) });
  check("a module with interfaces and generics loads", mod.manifest.id === "rt-ts");

  kernel.install(mod);
  kernel.launch("rt-ts");
  const doc = (globalThis as { document?: { querySelector(s: string): unknown } }).document;
  check("it renders like any other module", Boolean(doc?.querySelector(".ts-mounted")));
  // The generic actually ran, rather than being erased into nothing.
  check(
    "its typed code really executed",
    ctx.commands().some((c) => c.id === "rt-ts.verb" && c.label === "VERB")
  );
  kernel.uninstall("rt-ts");
  check("and it uninstalls like any other", !ctx.registry().some((m) => m.id === "rt-ts"));

  /* ---------------- the seeded TypeScript example ---------------- */

  // devkit writes this into ~/modules on first run, so it is the first thing
  // anybody compiles. It going stale would be discovered by a user rather than
  // by the harness, which is the wrong way round.
  const { EXAMPLE_TS_SOURCE } = await import("../packages/ui/src/modules/devkit/example");
  check("the seeded TypeScript example compiles and loads", await (async () => {
    const seeded = await compile(EXAMPLE_TS_SOURCE, "hello.ts");
    const loaded = await loadModuleSource(seeded.code, { origin: createMapping(seeded.map) });
    return loaded.manifest.id === "hello-typed" && typeof loaded.launch === "function";
  })());

  /* ---------------- the worker client ---------------- */

  // The compiler answers out of order — the first request also waits on a 9MB
  // wasm instantiation — so requests are correlated by id. This is the part a
  // browser is least convenient for testing and most likely to be wrong.
  const stub = () => {
    const listeners: { message: ((e: unknown) => void)[]; error: ((e: unknown) => void)[] } = {
      message: [],
      error: [],
    };
    const sent: TransformRequest[] = [];
    const worker = {
      addEventListener: (type: "message" | "error", fn: (e: unknown) => void) =>
        listeners[type].push(fn),
      postMessage: (m: TransformRequest) => sent.push(m),
      terminate: () => {},
    } as unknown as Worker;
    return {
      worker,
      sent,
      reply: (data: unknown) => listeners.message.forEach((fn) => fn({ data })),
      blowUp: (message: string) => listeners.error.forEach((fn) => fn({ message })),
    };
  };

  const s = stub();
  const client = createTransformClient(() => s.worker);

  const first = client.transform("a", "/a.ts");
  const second = client.transform("b", "/b.ts");
  check("each request is sent to the worker", s.sent.length === 2);
  // Answered backwards on purpose.
  s.reply({ type: "ok", id: s.sent[1].id, code: "SECOND", map: "{}" });
  s.reply({ type: "ok", id: s.sent[0].id, code: "FIRST", map: "{}" });
  const [a, b] = await Promise.all([first, second]);
  check("answers are matched to their request, not to their order", a.code === "FIRST" && b.code === "SECOND");

  const failed = client.transform("c", "/c.ts").catch((err: unknown) => err);
  s.reply({ type: "fail", id: s.sent[2].id, message: "Unexpected \";\"", line: 4, column: 2 });
  const compileError = await failed;
  check(
    "a compile failure rejects with a located error",
    compileError instanceof ModuleLoadError &&
      compileError.line === 4 &&
      compileError.column === 2
  );

  // A worker that dies takes every in-flight request with it, and each one has
  // somebody waiting on it.
  const orphanA = client.transform("d", "/d.ts").catch((err: unknown) => err);
  const orphanB = client.transform("e", "/e.ts").catch((err: unknown) => err);
  s.blowUp("wasm blocked");
  const orphans = await Promise.all([orphanA, orphanB]);
  check(
    "a worker that dies fails everything it was holding",
    orphans.every((err) => err instanceof ModuleLoadError && /could not start/.test(err.message))
  );

  // Disposing must settle anything outstanding too, or the harness itself would
  // sit on a timer until it expired.
  const s2 = stub();
  const client2 = createTransformClient(() => s2.worker);
  const abandoned = client2.transform("f", "/f.ts").catch((err: unknown) => err);
  client2.dispose();
  check("disposing settles what was in flight", (await abandoned) instanceof ModuleLoadError);

  for (const s3 of ctx.openSurfaces()) kernel.closeSurface(s3.id);
}
