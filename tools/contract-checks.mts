/**
 * Static checks on the module sources themselves.
 *
 * Everything else in the harness boots a kernel and pokes it. This reads the
 * files, because the property it defends is about the source and not about the
 * runtime: **a module that imports anything cannot be loaded at runtime.**
 *
 * That is not a style rule. `loadModuleSource` evaluates a standalone ES module
 * where no bare specifier resolves, so a single stray `import { x } from "…"`
 * is the difference between a module the user can edit and reload and one
 * welded into the build. It regresses silently — the shell keeps working, the
 * module just quietly stops being convertible — which is exactly the kind of
 * thing that needs a test rather than a habit.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { STOCK_IDS } from "./emit-modules.mts";

type Check = (label: string, ok: boolean) => void;

const MODULES = "packages/ui/src/modules";

/**
 * Modules that must stay import-free, because they are the ones that can
 * become runtime-loadable. The OS furniture is deliberately absent: it reaches
 * into the kernel and the shell by design and is compiled in for that reason.
 */
const PORTABLE = [
  "aurora", "bell", "bubblewrap", "chaos", "chronos", "cosmos", "cradle",
  "calculator", "dashboards", "driftfield", "flock", "harmonograph", "horizon",
  "lavalamp",
  "lunaria", "orrery", "portal", "ripple", "sandbox", "settings", "sunclock",
  "timer", "turmite",
];

/** Every .ts file under a directory. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * Specifiers a file imports for their *value*.
 *
 * `import type` is erased by the compiler and costs nothing at runtime, so it
 * doesn't count — which is what lets a portable module still be written in
 * typed TypeScript against `KernelContext`. `import { type A, type B }` is
 * erased too, and is handled here rather than reported as a false positive.
 */
function valueImports(src: string): string[] {
  const found: string[] = [];
  const from = /^import\s+(type\s+)?([\s\S]*?)from\s+"([^"]+)"/gm;
  for (let m = from.exec(src); m; m = from.exec(src)) {
    if (m[1]) continue;
    const clause = m[2].trim().replace(/^\{|\}$/g, "").trim();
    const parts = clause.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length && parts.every((p) => p.startsWith("type "))) continue;
    found.push(m[3]);
  }
  // Bare side-effect imports (`import "./x.css"`) count too — nothing resolves
  // them at runtime either.
  const bare = /^import\s+"([^"]+)"/gm;
  for (let m = bare.exec(src); m; m = bare.exec(src)) found.push(m[1]);
  return found;
}

export function contractChecks(check: Check): void {
  const offenders: string[] = [];
  for (const id of PORTABLE) {
    for (const file of sources(join(MODULES, id))) {
      const bad = valueImports(readFileSync(file, "utf8"));
      if (bad.length) offenders.push(`${id}: ${bad.join(", ")}`);
    }
  }
  check(
    `${PORTABLE.length} modules import nothing, so they can be loaded at runtime`,
    offenders.length === 0
  );
  if (offenders.length) for (const line of offenders) console.log(`      ${line}`);

  // The audit finding, kept fixed. A module reaching into another module's
  // source is the one thing the SDK says will get a change rejected, and the
  // calculator was doing it for a single settings-key string.
  const crossModule: string[] = [];
  for (const name of readdirSync(MODULES)) {
    const home = join(MODULES, name);
    if (!statSync(home).isDirectory()) continue;
    for (const file of sources(home)) {
      for (const spec of valueImports(readFileSync(file, "utf8"))) {
        if (!spec.startsWith(".")) continue; // a package, not a sibling module
        // Resolve it, rather than pattern-matching the specifier. Arcade's
        // `../shared/pixel` climbs out of `games/galaga/` and lands back
        // inside arcade — reading the string alone calls that a violation and
        // it isn't one.
        const target = resolve(dirname(file), spec);
        const root = resolve(MODULES);
        // Only an import that lands inside *another module's* directory counts.
        // Climbing out into `kernel/` or `ui/` is the ordinary way a built-in
        // reaches the platform, and is a different question entirely.
        if (!target.startsWith(`${root}${sep}`)) continue;
        const other = relative(root, target).split(sep)[0];
        if (!other || other === name) continue;
        // A file sitting directly under modules/ — stock.generated.ts — is
        // shared build output, not another module's insides.
        if (!existsSync(join(MODULES, other)) || !statSync(join(MODULES, other)).isDirectory()) {
          continue;
        }
        crossModule.push(`${name} -> ${other} (${spec})`);
      }
    }
  }
  // The editor's is the documented exception: `devkit/protocol` is a shared
  // message contract, imported by both sides precisely so neither has to
  // import the other's implementation.
  const unexpected = crossModule.filter((line) => !line.includes("devkit/protocol"));
  check("no module reaches into another module's source", unexpected.length === 0);
  if (unexpected.length) for (const line of unexpected) console.log(`      ${line}`);

  /* ---------------- the generated sources ---------------- */

  // A stale generated file is the failure mode of this whole approach: the
  // module keeps shipping its old behaviour while the TypeScript next to it
  // says otherwise, and nothing anywhere goes red. The emitter's own --check
  // is what CI runs; this is the same guarantee inside the harness, so a local
  // run catches it too.
  const generated = readFileSync(join(MODULES, "stock.generated.ts"), "utf8");
  const shipped = [...generated.matchAll(/\{ id: "([^"]+)"/g)].map((m) => m[1]);

  check(
    `${shipped.length} stock modules are generated from their TypeScript`,
    shipped.length === STOCK_IDS.length && shipped.every((id, i) => id === STOCK_IDS[i])
  );

  const stale = STOCK_IDS.filter((id) => {
    const source = readFileSync(join(MODULES, id, "index.ts"), "utf8");
    // Cheap staleness proxy: every manifest id in the TypeScript must appear
    // in the emitted text. A full re-transform is the emitter's job.
    const declared = /manifest:\s*\{[\s\S]*?id:\s*"([^"]+)"/.exec(source)?.[1];
    return !declared || !generated.includes(`"${declared}"`);
  });
  check("and each one's manifest survived the trip", stale.length === 0);
  if (stale.length) for (const id of stale) console.log(`      stale: ${id}`);

  // Nothing that ships as source may import anything, for the same reason as
  // above — but this is the emitted text rather than the TypeScript, so it
  // catches a compiler that stopped erasing something as well as an author who
  // added an import.
  const withImports = shipped.filter((id) => {
    const entry = new RegExp(`\\{ id: "${id}"[\\s\\S]*?source: ("(?:[^"\\\\]|\\\\.)*")`).exec(
      generated
    );
    if (!entry) return true;
    const code = JSON.parse(entry[1]) as string;
    return /^\s*import\s/m.test(code) || !/export\s+default/.test(code);
  });
  check("every emitted module imports nothing and exports a default", withImports.length === 0);
  if (withImports.length) for (const id of withImports) console.log(`      ${id}`);
}
