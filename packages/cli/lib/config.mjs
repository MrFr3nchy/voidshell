import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fail, dim } from "./ui.mjs";

/** Repo root, derived from this file rather than from the caller's cwd. */
export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Per-checkout settings, so the droplet address is typed once.
 *
 * Deliberately repo-local and gitignored rather than in ~/.config: the target
 * belongs to this checkout, and a machine-wide default is how you deploy a
 * branch to the wrong box.
 */
const FILE = join(REPO, ".voidshell.json");

const DEFAULTS = {
  target: null,
  domain: null,
  wwwDir: "/var/www/voidshell",
  apiDir: "/opt/voidshell/api",
  dataDir: "/var/lib/voidshell",
  port: 3000,
  proxy: "caddy",
};

export function load() {
  if (!existsSync(FILE)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(FILE, "utf8")) };
  } catch (err) {
    fail(`.voidshell.json is not valid JSON`, String(err));
  }
}

export function save(config) {
  const { ...rest } = config;
  writeFileSync(FILE, `${JSON.stringify(rest, null, 2)}\n`, "utf8");
}

/**
 * The droplet to act on: an explicit argument, else the saved default.
 *
 * Positional wins so a one-off against a staging box never needs the config
 * edited and edited back.
 */
export function resolveTarget(explicit, config) {
  const target = explicit ?? config.target;
  if (!target) {
    fail(
      "no droplet configured",
      `pass one — ${dim("voidshell deploy root@1.2.3.4")} — or save it with ${dim("voidshell config target root@1.2.3.4")}`
    );
  }
  if (!/^[\w.\-]+@[\w.\-]+$/.test(target)) {
    fail(`"${target}" doesn't look like user@host`, "expected something like root@203.0.113.10");
  }
  return target;
}
