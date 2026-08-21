/**
 * Checks for the workspace file format.
 *
 * An import replaces an entire workspace, which makes this the one place where
 * "that didn't work" is an unacceptable answer: the person is holding the only
 * copy of something and has just been told nothing about it. So most of what
 * is asserted below is not *that* a bad file is refused — it is that the
 * refusal names what was wrong.
 *
 * No DOM at all. The format is plain data, which is what makes it the easiest
 * part of the shell to be sure about.
 *
 *   npx esbuild tools/workspace-file-checks.mts --bundle --platform=node \
 *     --format=esm --outfile=workspace-file-checks.mjs --log-level=error \
 *     && node workspace-file-checks.mjs
 */
import {
  ImportError,
  WORKSPACE_FILE_VERSION,
  parseWorkspaceFile,
  serialiseWorkspace,
  summarise,
  workspaceFilename,
} from "../packages/ui/src/kernel/workspaceFile";

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

/** The message from a refusal, or "" if it was accepted. */
function refusal(text: string): string {
  try {
    parseWorkspaceFile(text);
    return "";
  } catch (err) {
    return err instanceof ImportError ? err.message : `WRONG ERROR TYPE: ${String(err)}`;
  }
}

const tree = {
  n: "void",
  k: "d",
  m: 1,
  ch: [
    { n: "welcome.md", k: "f", c: "hello", m: 1 },
    { n: "notes", k: "d", m: 1, ch: [{ n: "a.md", k: "f", c: "12345", m: 1 }] },
  ],
};
const snapshot = { state: { "world.dust": 1400, "aurora.hue": 200 }, fs: tree };

/* ---------------- a round trip is exact ---------------- */

{
  const text = serialiseWorkspace(snapshot);
  const back = parseWorkspaceFile(text);
  check("what goes out comes back", JSON.stringify(back.workspace) === JSON.stringify(snapshot));
  check("it stamps the format version", back.voidshell === WORKSPACE_FILE_VERSION);
  check("and when it was written", back.exportedAt.length > 0);
  // A file somebody may open, diff, or keep in a repository. The saving from
  // minifying it is nothing next to being able to read it.
  check("it is written to be read", text.includes("\n  "));
}

/* ---------------- an empty void is a legitimate export ---------------- */

{
  const text = serialiseWorkspace({ state: {}, fs: null });
  check("a workspace with nothing in it exports", refusal(text) === "");
  check("and comes back with a null tree", parseWorkspaceFile(text).workspace.fs === null);
}

/* ---------------- what it counts ---------------- */

{
  const s = summarise(snapshot);
  check("it counts files, at any depth", s.files === 2);
  // The home directory itself is not a directory anybody put there, so
  // reporting it would tell somebody they have one more folder than they made.
  check("it counts folders without counting home", s.dirs === 1);
  check("it counts settings", s.settings === 2);
  check("it counts bytes", s.bytes === "hello".length + "12345".length);

  const empty = summarise({ state: {}, fs: null });
  check("an empty workspace summarises to zero", empty.files === 0 && empty.dirs === 0);
}

/* ---------------- every refusal says why ---------------- */

/**
 * These are ordered the way the parser orders them, which is by how likely the
 * mistake is. The first thing somebody is told should be the thing that most
 * often went wrong: they picked the wrong file.
 */
{
  check("not JSON at all", refusal("<html>").includes("isn't JSON"));
  check("JSON, but not an object", refusal("[1,2,3]").includes("not an object"));

  // The most common wrong file is somebody's package.json, so the message has
  // to name the field that is missing rather than say "invalid format".
  const pkg = refusal('{"name":"my-app","version":"1.0.0"}');
  check("somebody else's json is named as such", pkg.includes("voidshell"));
  check("and it says what a real one starts with", pkg.includes("version field"));

  const future = refusal(JSON.stringify({ voidshell: 99, workspace: { state: {}, fs: null } }));
  check("a newer format is refused", future.includes("newer voidshell"));
  check("and says which versions are involved", future.includes("99") && future.includes("1"));

  check(
    "a truncated export says so",
    refusal(JSON.stringify({ voidshell: 1 })).includes("no workspace")
  );
  check(
    "a bent settings block is named",
    refusal(JSON.stringify({ voidshell: 1, workspace: { state: [], fs: null } })).includes("settings")
  );
  check(
    "a bent file tree is named",
    refusal(JSON.stringify({ voidshell: 1, workspace: { state: {}, fs: [] } })).includes("file tree")
  );
  // A tree rooted at a file rather than a directory would hydrate into a home
  // folder that is a file, which the VFS cannot represent.
  check(
    "a tree that isn't rooted at a folder is refused",
    refusal(JSON.stringify({ voidshell: 1, workspace: { state: {}, fs: { n: "x", k: "f", c: "" } } }))
      .includes("directory")
  );

  // Every one of the above must be an ImportError, or the UI shows a raw
  // exception instead of the sentence written for it.
  check("nothing leaks a non-ImportError", ![
    "<html>", "[1,2,3]", '{"name":"x"}',
    JSON.stringify({ voidshell: 99, workspace: {} }),
    JSON.stringify({ voidshell: 1 }),
  ].some((t) => refusal(t).startsWith("WRONG ERROR TYPE")));
}

/* ---------------- an older file still reads ---------------- */

{
  // Adding a Store key must not invalidate files written before it existed:
  // `hydrate` merges, so an old export restores exactly as well as it ever did.
  const old = JSON.stringify({ voidshell: 1, exportedAt: "2026-01-01T00:00:00Z", workspace: { state: { a: 1 }, fs: null } });
  check("a file from an older run is accepted", refusal(old) === "");
  check("missing keys are not invented", Object.keys(parseWorkspaceFile(old).workspace.state).length === 1);
  // A file with no timestamp is odd, not broken.
  check(
    "a missing timestamp is tolerated",
    parseWorkspaceFile(JSON.stringify({ voidshell: 1, workspace: { state: {}, fs: null } })).exportedAt === ""
  );
}

/* ---------------- the filename ---------------- */

{
  const name = workspaceFilename(new Date("2026-08-20T21:56:00Z"));
  check("the filename says what it is", name.startsWith("voidshell-"));
  check("and sorts by date", name.includes("2026-08-20"));
  check("and is a json file", name.endsWith(".json"));
  // A colon is not legal in a filename on Windows and is awkward everywhere.
  check("with nothing a filesystem will refuse", !name.includes(":"));
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("all workspace file checks passed");
