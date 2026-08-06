/**
 * Turn the portable modules into loadable source, at build time.
 *
 *   npx esbuild tools/emit-modules.mts --bundle --platform=node --format=esm \
 *     --outfile=emit.mjs --external:esbuild && node emit.mjs && rm emit.mjs
 *
 * Pass `--check` to verify the generated file is current without writing it.
 * CI does that, because a stale generated file is a module that silently keeps
 * shipping its old behaviour while the source next to it says otherwise.
 *
 * ## Why a build step rather than any of the alternatives
 *
 * A runtime module has to be plain JavaScript that imports nothing. The three
 * ways to get there each cost something, and this is the one that costs least:
 *
 * - **Hand-write them as `.js`.** No build step, but nineteen modules leave the
 *   typechecker, and a typo in `ctx` usage becomes a runtime surprise.
 * - **Ship the TypeScript and compile in the browser.** No build step, source
 *   stays typed — but it fetches an 11MB wasm compiler on *every* boot and
 *   compiles nineteen files before the shell is usable.
 * - **This.** Source stays `.ts` under `src/` and is typechecked exactly as
 *   before (tsconfig includes by directory, not by import graph), and what
 *   ships is plain JS that the loader takes directly.
 *
 * ## Deliberately not minified
 *
 * The emitted source is what the user opens in the editor when they want to
 * change how the lava lamp behaves. Minifying it would save perhaps a hundred
 * kilobytes and destroy the entire point of doing this.
 */
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * The modules that ship as loadable source.
 *
 * Absent on purpose: the OS furniture (shell, workspace, editor, devkit,
 * copilot, desktop, trash, monitor, vitals, portal, webapp, settings), which
 * reaches into the kernel by design; `aurora` and `horizon`, which are world
 * modules the kernel already refuses to uninstall because removing them takes
 * every colour in the build with them; and `arcade`, which is seventeen files
 * and needs a multi-file story first.
 */
export const STOCK_IDS = [
  "bell",
  "bubblewrap",
  "calculator",
  "chaos",
  "chronos",
  "cosmos",
  "cradle",
  "dashboards",
  "driftfield",
  "flock",
  "harmonograph",
  "lavalamp",
  "lunaria",
  "orrery",
  "ripple",
  "sandbox",
  "sunclock",
  "timer",
  "turmite",
];

const OUT = "packages/ui/src/modules/stock.generated.ts";

/**
 * Anything left that would need resolving at load time.
 *
 * `export default` is fine and expected. A surviving `import` or a re-export
 * means the module reached for something outside itself, and would fail at
 * load with a specifier error rather than here with a useful one.
 */
const UNRESOLVABLE = /^\s*(import\s|export\s+\*|export\s*\{[^}]*\}\s*from\s)/m;

function compile(id: string): string {
  const path = `packages/ui/src/modules/${id}/index.ts`;
  const source = readFileSync(path, "utf8");

  // Built-ins export a named binding, because main.ts imports them by name.
  // The loader reads `export default` and ignores everything else, so the
  // default is appended rather than swapped in — the named export still has to
  // work for as long as anything is still compiled against it, and the smoke
  // harness imports several of these directly to unit-test their internals.
  const binding = /export\s+const\s+(\w+)\s*:\s*VoidModule\b/.exec(source);
  if (!binding) {
    throw new Error(
      `${path} has no \`export const <name>: VoidModule\`, so there is nothing ` +
        `to make the default export. Add the annotation or drop it from STOCK_IDS.`
    );
  }

  const out = esbuild.transformSync(source, {
    loader: "ts",
    format: "esm",
    target: "es2021",
    // No sourcemap: the emitted JS *is* the file the user edits and reloads, so
    // there is no other coordinate system to map back to.
    sourcemap: false,
  });

  const bad = UNRESOLVABLE.exec(out.code);
  if (bad) {
    throw new Error(
      `${path} still needs "${bad[0].trim()}" after compiling.\n` +
        `A runtime module imports nothing — everything comes through ctx. ` +
        `Either reach it via ctx, or drop this module from STOCK_IDS.`
    );
  }
  return `${out.code}\nexport default ${binding[1]};\n`;
}

function render(): string {
  const entries = STOCK_IDS.map((id) => {
    const code = compile(id);
    return `  { id: ${JSON.stringify(id)}, file: ${JSON.stringify(`${id}.js`)}, source: ${JSON.stringify(code)} },`;
  }).join("\n");

  return `/**
 * GENERATED FILE — do not edit.
 *
 * Produced from packages/ui/src/modules/<id>/index.ts by tools/emit-modules.mts.
 * Edit the TypeScript and re-run the emitter; editing this file means your
 * change is undone by the next build.
 *
 * These are the modules that ship as *source* rather than as code: devkit
 * writes them into ~/modules on first run and loads them like anything the
 * user wrote, which is what makes them editable, reloadable and removable.
 */

export interface StockModule {
  id: string;
  /** Filename under ~/modules. Plain .js — nothing compiles this at boot. */
  file: string;
  source: string;
}

export const STOCK_MODULES: StockModule[] = [
${entries}
];
`;
}

const generated = render();
const checking = process.argv.includes("--check");
const current = (() => {
  try {
    return readFileSync(OUT, "utf8");
  } catch {
    return "";
  }
})();

if (checking) {
  if (current !== generated) {
    console.error(
      `${OUT} is out of date.\nRegenerate it with tools/emit-modules.mts (no --check).`
    );
    process.exit(1);
  }
  console.log(`${OUT} is up to date (${STOCK_IDS.length} modules).`);
} else {
  writeFileSync(OUT, generated);
  const bytes = generated.length;
  console.log(
    `wrote ${OUT} — ${STOCK_IDS.length} modules, ${(bytes / 1024).toFixed(0)}KB of source`
  );
}
