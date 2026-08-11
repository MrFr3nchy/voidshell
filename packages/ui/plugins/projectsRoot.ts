import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where `/projects` and the host bridge look on disk.
 *
 * This used to be one line in `vite.config.ts`: `path.resolve(uiDir, "../../..")`
 * — the directory holding the voidshell checkout. That is not a hard-coded
 * *path*, but it is a hard-coded *assumption*, and it has the same effect. It
 * happens to be right when voidshell is cloned into a folder full of other
 * repos, and it silently mounts something else entirely when it isn't. Nothing
 * reports the difference: `/projects` is simply whatever was next door on that
 * machine, which is why the mount changes shape depending on which computer
 * you sat down at.
 *
 * So the location is now something you state rather than something the tree
 * infers, with the old behaviour kept as the last resort so an untouched
 * checkout still works exactly as it did.
 *
 * Resolution order, first hit wins:
 *
 * 1. `VOIDSHELL_PROJECTS_ROOT` in the environment — also picked up from
 *    `.env.local`, since Vite loads those before this runs.
 * 2. `projectsRoot` in `voidshell.local.json` at the repo root. Gitignored,
 *    per-machine, and what the in-shell setting writes to.
 * 3. The directory containing the checkout, as before.
 */

export const CONFIG_FILE = "voidshell.local.json";
export const ENV_VAR = "VOIDSHELL_PROJECTS_ROOT";

export type RootSource = "env" | "config" | "default";

export interface RootInfo {
  /** Absolute, symlinks unresolved. */
  root: string;
  source: RootSource;
  /** False is not fatal — the mount is skipped and the shell says so. */
  exists: boolean;
  /** Absolute path of the config file, whether or not it exists yet. */
  configPath: string;
}

/**
 * Expand `~`, then resolve against `base`.
 *
 * `~` is worth handling explicitly because the two places a value can come
 * from — a shell env var and a hand-edited JSON file — are both places where
 * people write `~/code` and reasonably expect it to mean something. Only a
 * shell expands it, and a JSON file has no shell.
 */
export function expandPath(raw: string, base: string, home = os.homedir()): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  let expanded = trimmed;
  if (expanded === "~") expanded = home;
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(home, expanded.slice(2));
  }
  return path.resolve(base, expanded);
}

/** A directory we could actually mount. Not a symlink check — those are the caller's problem. */
function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export interface LocalConfig {
  projectsRoot?: string;
}

/**
 * Read the local config, tolerating every way it can be absent or wrong.
 *
 * A malformed config must not stop the dev server: this file is hand-edited by
 * design, and "voidshell won't start" is a terrible way to learn you left a
 * trailing comma in it. A bad file falls through to the next source instead.
 */
export function readLocalConfig(configPath: string): LocalConfig | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as LocalConfig;
  } catch {
    return null;
  }
}

/** Merge one key into the config, preserving anything else already in it. */
export function writeLocalConfig(configPath: string, patch: LocalConfig): void {
  const current = readLocalConfig(configPath) ?? {};
  const next = { ...current, ...patch };
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
}

export interface ResolveOptions {
  /** The Vite root — `packages/ui`. */
  uiDir: string;
  env?: Record<string, string | undefined>;
  /** Overridable so the harness doesn't depend on whoever is logged in. */
  home?: string;
}

export function resolveProjectsRoot(opts: ResolveOptions): RootInfo {
  const { uiDir, env = process.env, home = os.homedir() } = opts;

  // packages/ui -> packages -> the checkout
  const repoRoot = path.resolve(uiDir, "../..");
  const configPath = path.join(repoRoot, CONFIG_FILE);
  const describe = (root: string, source: RootSource): RootInfo => ({
    root,
    source,
    exists: isDirectory(root),
    configPath,
  });

  const fromEnv = env[ENV_VAR];
  if (fromEnv && fromEnv.trim()) {
    // Relative to the checkout, not to cwd: `npm run dev` can be invoked from
    // anywhere in the workspace and the answer must not move with it.
    return describe(expandPath(fromEnv, repoRoot, home), "env");
  }

  const fromConfig = readLocalConfig(configPath)?.projectsRoot;
  if (typeof fromConfig === "string" && fromConfig.trim()) {
    return describe(expandPath(fromConfig, repoRoot, home), "config");
  }

  // What this always did: the directory the checkout sits in.
  return describe(path.resolve(repoRoot, ".."), "default");
}

/**
 * A root that can change while the dev server is running.
 *
 * Both plugins read through this rather than closing over a string, so
 * repointing the mount from inside the shell takes effect on the next scan
 * instead of on the next restart. In a production build nothing ever calls
 * `set` — `configureServer` doesn't run, so there is no endpoint to call it.
 */
export interface RootHandle {
  get(): string;
  info(): RootInfo;
  /** Throws if `next` is not a directory, so a typo can't blank the mount. */
  set(next: string): RootInfo;
}

export function createRootHandle(initial: RootInfo, home = os.homedir()): RootHandle {
  let current = initial;
  const repoRoot = path.dirname(initial.configPath);
  return {
    get: () => current.root,
    info: () => current,
    set(next: string) {
      const resolved = expandPath(next, repoRoot, home);
      if (!resolved) throw new Error("a projects root cannot be empty");
      if (!isDirectory(resolved)) throw new Error(`not a directory: ${resolved}`);
      writeLocalConfig(current.configPath, { projectsRoot: resolved });
      current = { root: resolved, source: "config", exists: true, configPath: current.configPath };
      return current;
    },
  };
}

/** Accepted by both plugins, so callers may pass a fixed path or a live handle. */
export type RootOption = string | RootHandle;

export function readRoot(option: RootOption | undefined, fallback: string): string {
  if (typeof option === "string") return option;
  if (option) return option.get();
  return fallback;
}
