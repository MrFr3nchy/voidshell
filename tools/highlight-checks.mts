/**
 * Checks for the syntax highlighter, in jsdom.
 *
 * One property matters more than every other rule here combined: **the text
 * must survive**. A highlighter is a pure re-presentation, so for any input the
 * concatenated `textContent` of what comes out has to equal what went in,
 * character for character. Get that wrong and the viewer silently drops or
 * duplicates a line of somebody's source — a bug that looks like a corrupted
 * file rather than like a colouring mistake, which is the worst place for it
 * to appear.
 *
 * So the last block below runs every source file in the repository through it
 * and asserts exactly that. It is a property test wearing a smoke test's
 * clothes, and it is the reason the tokenizer can afford to be regexes.
 *
 *   npx esbuild tools/highlight-checks.mts --bundle --platform=node \
 *     --format=esm --outfile=highlight-checks.mjs --external:jsdom \
 *     --log-level=error && node highlight-checks.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!doctype html><html><body></body></html>`);
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;

const { highlight, canHighlight } = await import(
  "../packages/ui/src/modules/editor/highlight"
);

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

/** The tokens a snippet produced, as [class, text] pairs. */
function toks(code: string, ext: string): [string, string][] {
  const frag = highlight(code, ext);
  if (!frag) return [];
  const out: [string, string][] = [];
  for (const node of [...frag.childNodes]) {
    if (node.nodeType === 1) {
      const el = node as HTMLElement;
      out.push([el.className.replace("hl-", ""), el.textContent ?? ""]);
    }
  }
  return out;
}

/** Everything the fragment renders, flattened. */
function flat(code: string, ext: string): string {
  const frag = highlight(code, ext);
  return frag ? (frag.textContent ?? "") : code;
}

const has = (code: string, ext: string, cls: string, text: string) =>
  toks(code, ext).some(([c, t]) => c === cls && t === text);

/* ---------------- it colours the obvious things ---------------- */

{
  check("a keyword is a keyword", has("const x = 1;", "ts", "kw", "const"));
  check("a number is a number", has("const x = 42;", "ts", "num", "42"));
  check("a string is a string", has('const s = "hi";', "ts", "str", '"hi"'));
  check("true is a value, not syntax", has("a = true", "ts", "con", "true"));
  check("a line comment runs to the newline", has("// note\nconst x = 1;", "ts", "com", "// note"));
  check("a block comment spans lines", has("/* a\n b */\nx", "ts", "com", "/* a\n b */"));
  check("python has its own words", has("def f():", "py", "kw", "def"));
  check("and its own constants", has("x = None", "py", "con", "None"));
  check("rust too", has("fn main() {}", "rs", "kw", "fn"));
  check("a hex literal is a number", has("const c = 0xff;", "ts", "num", "0xff"));
}

/* ---------------- the mistakes a regex scanner would make ---------------- */

/**
 * These are the cases that decide whether a scanner is usable at all. Each one
 * is a token opening inside another token, and getting any of them wrong
 * colours the rest of the file as one long string or one long comment — which
 * is not a subtle wrongness, it is the file becoming unreadable.
 */
{
  // `#` inside a shell string must not open a comment.
  check("a hash inside a string is not a comment", has(`echo "a # b"`, "sh", "str", '"a # b"'));
  check("and the string ends where it should", !has(`echo "a # b"`, "sh", "com", "# b\""));

  // A quote inside a comment must not open a string.
  check("an apostrophe in a comment stays in the comment", has("// don't\nx", "ts", "com", "// don't"));
  check("and does not swallow the next line", flat("// don't\nconst x = 1;", "ts") === "// don't\nconst x = 1;");

  // An unterminated quote must colour one line, not the remainder of the file.
  const un = toks('const a = "oops\nconst b = 2;', "ts");
  check("an unterminated string stops at the newline", un.some(([c, t]) => c === "str" && !t.includes("\n")));
  check("and the next line still parses", un.some(([c, t]) => c === "kw" && t === "const"));

  // A comment marker inside a string must not open a comment.
  check("a URL in a string is not a comment", has('const u = "http://x";', "ts", "str", '"http://x"'));

  // Block comments that never close must not throw or run away.
  check("an unterminated block comment is still one comment", has("/* forever", "ts", "com", "/* forever"));
}

/* ---------------- config formats are keys and values ---------------- */

{
  check("a yaml key is a key", has("name: voidshell\n", "yaml", "key", "name"));
  check("a toml key is a key", has("port = 3000\n", "toml", "key", "port"));
  check("a json key is a key", has('{\n  "a": 1\n}', "json", "key", '  "a"'));
  // The value on the right of the colon must not also be a key, or every
  // config file is entirely keys and the colouring says nothing.
  check("a json string value is a string", has('{\n  "a": "b"\n}', "json", "str", '"b"'));
  check("a css property is a key", has("a {\n  color: red;\n}", "css", "key", "  color"));
}

/* ---------------- markup is not a language with keywords in it ---------------- */

{
  check("an element is a tag", has('<div class="a">hi</div>', "html", "tag", "<div"));
  check("an attribute is an attribute", has('<div class="a">hi</div>', "html", "att", "class"));
  check("an attribute value is a string", has('<div class="a">hi</div>', "html", "str", '"a"'));
  // Text between tags is prose, and colouring it is worse than not colouring.
  check(
    "text between tags is left alone",
    !toks('<p>const</p>', "html").some(([, t]) => t === "const")
  );
  check("a comment is a comment", has("<!-- x -->", "html", "com", "<!-- x -->"));
  check("svg goes through the markup path", canHighlight("svg"));
}

/* ---------------- when it declines ---------------- */

{
  check("an unknown extension gets nothing", highlight("hello", "wat") === null);
  check("and says so up front", !canHighlight("wat"));
  check("a known one says so too", canHighlight("ts") && canHighlight("yml"));
  // Above the cap, plain text — a span per token on a generated file is a
  // stall the whole void feels, not just this window.
  check("a file too large to be worth it gets nothing", highlight("x\n".repeat(200_000), "ts") === null);
  check("an empty file is not an error", flat("", "ts") === "");
}

/* ---------------- the property that actually matters ---------------- */

/**
 * Every source file in the repository, through the highlighter, asserting the
 * text comes out identical. Real input, including whatever is in it that no
 * hand-written snippet above thought to contain.
 */
{
  const SKIP = new Set(["node_modules", ".git", "dist", "docs", ".github"]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk("packages");
  walk("tools");

  let checked = 0;
  let mangled = "";
  for (const path of files) {
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    if (!canHighlight(ext)) continue;
    const src = readFileSync(path, "utf8");
    if (src.length > 120_000) continue;
    checked++;
    if (flat(src, ext) !== src && !mangled) mangled = path;
  }

  check(`${checked} real source files survived being highlighted`, checked > 50 && !mangled);
  if (mangled) console.log(`      first file altered: ${mangled}`);
}

console.log("");
if (failures.length) {
  console.error(`${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("all highlighter checks passed");
