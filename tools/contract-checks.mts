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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

type Check = (label: string, ok: boolean) => void;

const MODULES = "packages/ui/src/modules";

/**
 * Modules that must stay import-free, because they are the ones that can
 * become runtime-loadable. The OS furniture is deliberately absent: it reaches
 * into the kernel and the shell by design and is compiled in for that reason.
 */
const PORTABLE = [
  "aurora", "bell", "bubblewrap", "chaos", "chronos", "cosmos", "cradle",
  "dashboards", "driftfield", "flock", "harmonograph", "horizon", "lavalamp",
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
        if (other && other !== name) crossModule.push(`${name} -> ${other} (${spec})`);
      }
    }
  }
  // The editor's is the documented exception: `devkit/protocol` is a shared
  // message contract, imported by both sides precisely so neither has to
  // import the other's implementation.
  const unexpected = crossModule.filter((line) => !line.includes("devkit/protocol"));
  check("no module reaches into another module's source", unexpected.length === 0);
  if (unexpected.length) for (const line of unexpected) console.log(`      ${line}`);
}
