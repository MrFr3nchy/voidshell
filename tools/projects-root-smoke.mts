/**
 * Where `/projects` points, asserted directly.
 *
 *   npx esbuild tools/projects-root-smoke.mts --bundle --platform=node \
 *     --format=esm --packages=external --outfile=pr-smoke.mjs \
 *     && node pr-smoke.mjs && rm pr-smoke.mjs
 *
 * This resolution is exactly the kind of thing that cannot be caught by
 * looking at the shell: every wrong answer produces a perfectly valid dev
 * server, and the only symptom is that `/projects` contains the wrong things —
 * which looks identical to "I have different repos on this machine". That is
 * how the original `../../..` survived as long as it did.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONFIG_FILE,
  ENV_VAR,
  createRootHandle,
  expandPath,
  readLocalConfig,
  resolveProjectsRoot,
  writeLocalConfig,
} from "../packages/ui/plugins/projectsRoot";

const failures: string[] = [];
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}`);
  if (!ok) failures.push(label);
}

/** A throwaway checkout: <tmp>/repo/packages/ui, with siblings beside it. */
function scaffold(): { uiDir: string; repoRoot: string; holder: string; configPath: string } {
  const holder = mkdtempSync(path.join(tmpdir(), "vs-root-"));
  const repoRoot = path.join(holder, "repo");
  const uiDir = path.join(repoRoot, "packages", "ui");
  mkdirSync(uiDir, { recursive: true });
  mkdirSync(path.join(holder, "some-other-repo"));
  return { uiDir, repoRoot, holder, configPath: path.join(repoRoot, CONFIG_FILE) };
}

const HOME = path.join(tmpdir(), "vs-fake-home");
mkdirSync(HOME, { recursive: true });

/* ---------------- the fallback is what it always was ---------------- */

{
  const { uiDir, holder } = scaffold();
  const r = resolveProjectsRoot({ uiDir, env: {}, home: HOME });
  check("with nothing set, the root is the directory holding the checkout", r.root === holder);
  check("and it says so", r.source === "default");
  check("and it exists", r.exists);
}

/* ---------------- the environment wins ---------------- */

{
  const { uiDir, holder } = scaffold();
  const elsewhere = path.join(holder, "elsewhere");
  mkdirSync(elsewhere);
  const r = resolveProjectsRoot({ uiDir, env: { [ENV_VAR]: elsewhere }, home: HOME });
  check("an env var overrides the fallback", r.root === elsewhere && r.source === "env");

  // Blank must not count as set, or an exported-but-empty variable silently
  // mounts "" and the shell comes up with no projects and no explanation.
  const blank = resolveProjectsRoot({ uiDir, env: { [ENV_VAR]: "   " }, home: HOME });
  check("an empty env var is not a setting", blank.source === "default");
}

/* ---------------- the config file, and its precedence ---------------- */

{
  const { uiDir, holder, configPath } = scaffold();
  const configured = path.join(holder, "configured");
  const fromEnv = path.join(holder, "from-env");
  mkdirSync(configured);
  mkdirSync(fromEnv);

  writeFileSync(configPath, JSON.stringify({ projectsRoot: configured }));
  const r = resolveProjectsRoot({ uiDir, env: {}, home: HOME });
  check("the config file overrides the fallback", r.root === configured && r.source === "config");

  const both = resolveProjectsRoot({ uiDir, env: { [ENV_VAR]: fromEnv }, home: HOME });
  check("and the environment outranks the config file", both.root === fromEnv);

  // A hand-edited file with a trailing comma must not stop the dev server.
  writeFileSync(configPath, "{ nope, ");
  const broken = resolveProjectsRoot({ uiDir, env: {}, home: HOME });
  check("a malformed config falls through instead of throwing", broken.source === "default");
  check("and reading it returns null", readLocalConfig(configPath) === null);
}

/* ---------------- paths people actually type ---------------- */

{
  const { uiDir, repoRoot, holder } = scaffold();
  mkdirSync(path.join(HOME, "code"), { recursive: true });

  check("~ expands to home", expandPath("~/code", repoRoot, HOME) === path.join(HOME, "code"));
  check("a bare ~ expands", expandPath("~", repoRoot, HOME) === HOME);
  check(
    "a relative path resolves against the checkout, not cwd",
    expandPath("../some-other-repo", repoRoot, HOME) === path.join(holder, "some-other-repo")
  );
  check(
    "an absolute path is left alone",
    expandPath(holder, repoRoot, HOME) === holder
  );

  const r = resolveProjectsRoot({ uiDir, env: { [ENV_VAR]: "~/code" }, home: HOME });
  check("and ~ works through the env var", r.root === path.join(HOME, "code"));
}

/* ---------------- a missing directory is reported, not fatal ---------------- */

{
  const { uiDir, holder } = scaffold();
  const gone = path.join(holder, "not-here");
  const r = resolveProjectsRoot({ uiDir, env: { [ENV_VAR]: gone }, home: HOME });
  check("a nonexistent root still resolves", r.root === gone);
  check("but is flagged as missing", !r.exists);
}

/* ---------------- the live handle ---------------- */

{
  const { uiDir, holder, configPath } = scaffold();
  const target = path.join(holder, "target");
  mkdirSync(target);

  const handle = createRootHandle(resolveProjectsRoot({ uiDir, env: {}, home: HOME }), HOME);
  check("the handle starts at the resolved root", handle.get() === holder);

  handle.set(target);
  check("setting it moves the root", handle.get() === target);
  check("and records the new source", handle.info().source === "config");
  check(
    "and persists to the config file",
    readLocalConfig(configPath)?.projectsRoot === target
  );

  // The next dev server must come up where you left it.
  const again = resolveProjectsRoot({ uiDir, env: {}, home: HOME });
  check("so the next start resolves there", again.root === target);

  let threw = "";
  try {
    handle.set(path.join(holder, "typo"));
  } catch (err) {
    threw = String((err as Error).message);
  }
  check("a path that isn't a directory is refused", threw.includes("not a directory"));
  check("and the old root survives the refusal", handle.get() === target);

  threw = "";
  try {
    handle.set("   ");
  } catch (err) {
    threw = String((err as Error).message);
  }
  check("an empty path is refused too", threw.includes("cannot be empty"));

  // Writing the root must not eat anything else in the file.
  writeLocalConfig(configPath, { projectsRoot: target });
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...raw, droplet: "keep-me" }, null, 2));
  handle.set(holder);
  check(
    "and merges rather than clobbering the config",
    readLocalConfig(configPath)?.projectsRoot === holder &&
      (readLocalConfig(configPath) as Record<string, unknown>).droplet === "keep-me"
  );
}

rmSync(HOME, { recursive: true, force: true });

console.log(
  failures.length ? `\n${failures.length} FAILURE(S)` : "\nall projects-root checks passed"
);
process.exit(failures.length ? 1 : 0);
