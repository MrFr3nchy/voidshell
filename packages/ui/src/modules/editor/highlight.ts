/**
 * Syntax highlighting for the file viewer.
 *
 * Hand-written for the same reason `markdown.ts` is: the app ships with one
 * runtime dependency, and a highlighter is not worth being the second when the
 * job is making a source file readable in a window. Prism and highlight.js are
 * both larger than this entire module directory.
 *
 * It builds DOM nodes and sets `textContent`, never `innerHTML`. That is not
 * belt-and-braces — the files it renders come from /projects, which is a scan
 * of whatever is on the machine's disk, so "the input is trusted" is not a
 * claim anyone should make about it. Nothing here can produce an element this
 * file did not decide to create, and the only elements it creates are spans.
 *
 * ## What it is not
 *
 * Not a parser. It is one regex alternation per language, scanned left to
 * right, and it will get things wrong that a parser would not — a `#` inside a
 * shell string, a regex literal that looks like division. That is the right
 * trade for a viewer: being wrong about a colour costs a moment of confusion,
 * and being a parser costs a dependency, a build step, and a language server's
 * worth of edge cases. Where it cannot do a decent job at all it returns
 * `null` and the caller shows plain text, which is what the viewer did before.
 */

/** Token classes. Kept short because they appear once per span in the DOM. */
type Tok = "com" | "str" | "num" | "kw" | "con" | "key" | "tag" | "att";

interface Grammar {
  /** Everything after these, to end of line, is a comment. */
  line?: string[];
  /** Block comment open/close pairs. */
  block?: [string, string][];
  /** Quote characters that open a string. Backslash escapes are honoured. */
  quotes?: string[];
  keywords?: string[];
  /** Words that read as values rather than as syntax: true, null, nil, self. */
  constants?: string[];
  /**
   * Config formats are mostly keys and values, and colouring the key is the
   * whole of what makes one readable. `yaml.key: value` and `toml_key = value`.
   */
  keyed?: RegExp;
  /** No identifier keywords at all — JSON, where every bare word is a value. */
  wordless?: boolean;
}

const C_LIKE = ["//"];
const C_BLOCK: [string, string][] = [["/*", "*/"]];
const QUOTES = ['"', "'", "`"];

const JS_KW = [
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
  "finally", "for", "from", "function", "get", "if", "implements", "import",
  "in", "instanceof", "interface", "let", "new", "of", "private", "protected",
  "public", "readonly", "return", "satisfies", "set", "static", "super",
  "switch", "this", "throw", "try", "type", "typeof", "var", "void", "while",
  "yield", "declare", "namespace", "abstract", "override", "keyof", "infer",
];
const JS_CONST = ["true", "false", "null", "undefined", "NaN", "Infinity"];

const PY_KW = [
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
  "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
  "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "while", "with", "yield", "match", "case",
];
const PY_CONST = ["True", "False", "None", "self", "cls"];

const RS_KW = [
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
  "enum", "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match",
  "mod", "move", "mut", "pub", "ref", "return", "static", "struct", "super",
  "trait", "type", "unsafe", "use", "where", "while", "union",
];
const RS_CONST = ["true", "false", "None", "Some", "Ok", "Err", "self", "Self"];

const GO_KW = [
  "break", "case", "chan", "const", "continue", "default", "defer", "else",
  "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
  "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
];
const GO_CONST = ["true", "false", "nil", "iota"];

const C_KW = [
  "auto", "break", "case", "char", "class", "const", "constexpr", "continue",
  "default", "delete", "do", "double", "else", "enum", "extern", "float",
  "for", "goto", "if", "inline", "int", "long", "namespace", "new", "operator",
  "private", "protected", "public", "register", "return", "short", "signed",
  "sizeof", "static", "struct", "switch", "template", "this", "typedef",
  "typename", "union", "unsigned", "using", "virtual", "void", "volatile", "while",
];
const C_CONST = ["true", "false", "NULL", "nullptr"];

const SH_KW = [
  "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "function", "in", "return", "local", "export", "readonly",
  "set", "unset", "source", "echo", "cd", "exit", "trap", "shift", "eval",
];

const SQL_KW = [
  "select", "from", "where", "insert", "into", "values", "update", "set",
  "delete", "create", "table", "drop", "alter", "add", "column", "index",
  "join", "left", "right", "inner", "outer", "on", "group", "by", "order",
  "having", "limit", "offset", "as", "and", "or", "not", "null", "primary",
  "key", "foreign", "references", "unique", "default", "distinct", "union",
];

const GD_KW = [
  "and", "as", "assert", "await", "break", "class", "class_name", "const",
  "continue", "elif", "else", "enum", "export", "extends", "for", "func", "if",
  "in", "is", "match", "not", "or", "pass", "print", "return", "signal",
  "static", "var", "while", "yield", "onready", "tool", "@export", "@onready",
];
const GD_CONST = ["true", "false", "null", "self", "PI", "INF", "NAN"];

const CSS_KW = [
  "important", "media", "import", "keyframes", "supports", "font-face",
  "charset", "namespace", "container", "layer", "property",
];

/**
 * Every language, by the extension that names it.
 *
 * Keyed on extension rather than on `filetypes.ts`'s ids because the two
 * disagree on purpose: that table answers "what is this file called and what
 * icon does it get", and one id there covers `.c` and `.cpp` together, which
 * is right for an icon and wrong for a keyword list.
 */
const GRAMMARS: Record<string, Grammar> = {
  ts: { line: C_LIKE, block: C_BLOCK, quotes: QUOTES, keywords: JS_KW, constants: JS_CONST },
  py: { line: ["#"], quotes: ['"', "'"], keywords: PY_KW, constants: PY_CONST },
  rs: { line: C_LIKE, block: C_BLOCK, quotes: ['"'], keywords: RS_KW, constants: RS_CONST },
  go: { line: C_LIKE, block: C_BLOCK, quotes: ['"', "`"], keywords: GO_KW, constants: GO_CONST },
  c: { line: C_LIKE, block: C_BLOCK, quotes: ['"', "'"], keywords: C_KW, constants: C_CONST },
  sh: { line: ["#"], quotes: ['"', "'"], keywords: SH_KW },
  sql: { line: ["--"], block: C_BLOCK, quotes: ["'", '"'], keywords: SQL_KW },
  gd: { line: ["#"], quotes: ['"', "'"], keywords: GD_KW, constants: GD_CONST },
  css: { block: C_BLOCK, quotes: QUOTES, keywords: CSS_KW, keyed: /^[ \t]*[-\w]+(?=[ \t]*:)/ },
  json: { quotes: ['"'], constants: ["true", "false", "null"], wordless: true, keyed: /^[ \t]*"(?:[^"\\]|\\.)*"(?=[ \t]*:)/ },
  yaml: { line: ["#"], quotes: ['"', "'"], constants: ["true", "false", "null", "yes", "no"], keyed: /^[ \t]*(?:- )?[\w.-]+(?=[ \t]*:(?:[ \t]|$))/ },
  toml: { line: ["#"], quotes: ['"', "'"], constants: ["true", "false"], keyed: /^[ \t]*[\w.-]+(?=[ \t]*=)/ },
};

/** Extensions that share a grammar with another. */
const ALIASES: Record<string, string> = {
  tsx: "ts", mts: "ts", cts: "ts",
  js: "ts", jsx: "ts", mjs: "ts", cjs: "ts",
  pyi: "py",
  h: "c", cc: "c", cpp: "c", hpp: "c",
  bash: "sh", zsh: "sh", fish: "sh",
  scss: "css", sass: "css", less: "css",
  yml: "yaml",
  ini: "toml", conf: "toml", cfg: "toml",
  jsonc: "json", json5: "json",
  qml: "ts",
  htm: "html", xml: "html", svg: "html",
};

/**
 * Above this, plain text.
 *
 * A 128KB source file is roughly 40,000 tokens, and a span each is a DOM tree
 * large enough that opening the window is a visible stall — on a compositor
 * that reprojects every panel each frame, a stall is dropped frames across the
 * whole void and not just in this window. The cap is generous enough that no
 * file anyone reads for pleasure hits it, and files that do hit it are
 * generated, which is the category least worth colouring.
 */
const MAX_BYTES = 120_000;

export function canHighlight(ext: string): boolean {
  const id = ALIASES[ext] ?? ext;
  return id === "html" || id in GRAMMARS;
}

/**
 * Colour `code`, or answer `null` when there is nothing useful to do.
 *
 * `null` rather than an unstyled fragment so the caller keeps its existing
 * single `textContent` assignment for the plain case — which is both faster
 * and the behaviour every unsupported file already had.
 */
export function highlight(code: string, ext: string): DocumentFragment | null {
  if (code.length > MAX_BYTES) return null;
  const id = ALIASES[ext] ?? ext;
  if (id === "html") return markup(code);
  const grammar = GRAMMARS[id];
  return grammar ? tokenize(code, grammar) : null;
}

/* ------------------------------------------------------------------ */

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Built once per grammar; the alternation is the same for every file. */
const cache = new Map<Grammar, RegExp>();

function patternFor(g: Grammar): RegExp {
  const cached = cache.get(g);
  if (cached) return cached;

  const parts: string[] = [];
  // Order is precedence. Comments first, then strings — a `#` inside a string
  // must not open a comment, and a quote inside a comment must not open a
  // string, so whichever opens first wins and consumes to its own end.
  for (const [open, close] of g.block ?? []) {
    parts.push(`(?:${esc(open)}[\\s\\S]*?(?:${esc(close)}|$))`);
  }
  for (const marker of g.line ?? []) parts.push(`(?:${esc(marker)}[^\\n]*)`);
  for (const q of g.quotes ?? []) {
    // `[^\\]` before the closing quote, and no newline for the single-line
    // quotes, so an unterminated string colours one line rather than the
    // rest of the file.
    const multiline = q === "`";
    const body = multiline ? `(?:[^${esc(q)}\\\\]|\\\\[\\s\\S])*` : `(?:[^${esc(q)}\\\\\\n]|\\\\.)*`;
    parts.push(`(?:${esc(q)}${body}${esc(q)}?)`);
  }
  parts.push("(?:\\b0[xXbBoO][0-9a-fA-F_]+\\b)");
  parts.push("(?:\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)");
  if (!g.wordless) parts.push("(?:[@$]?[A-Za-z_][\\w-]*)");
  else if (g.constants?.length) parts.push("(?:[A-Za-z_][\\w]*)");

  const re = new RegExp(parts.join("|"), "g");
  cache.set(g, re);
  return re;
}

function classOf(token: string, g: Grammar): Tok | null {
  for (const [open] of g.block ?? []) if (token.startsWith(open)) return "com";
  for (const marker of g.line ?? []) if (token.startsWith(marker)) return "com";
  for (const q of g.quotes ?? []) if (token.startsWith(q)) return "str";
  if (/^[\d.]/.test(token)) return "num";
  if (g.constants?.includes(token)) return "con";
  if (g.keywords?.includes(token)) return "kw";
  return null;
}

function span(cls: Tok, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = `hl-${cls}`;
  el.textContent = text;
  return el;
}

function tokenize(code: string, g: Grammar): DocumentFragment {
  const out = document.createDocumentFragment();
  const re = patternFor(g);
  re.lastIndex = 0;

  // Config formats live and die by their keys, and a key is a position rather
  // than a word — `port` is a key on the left of a colon and a value on the
  // right. So it is matched per line, before the token scan, and the scan
  // resumes after it.
  const keyRanges: [number, number][] = [];
  if (g.keyed) {
    let at = 0;
    for (const line of code.split("\n")) {
      const m = g.keyed.exec(line);
      if (m) keyRanges.push([at + m.index, at + m.index + m[0].length]);
      at += line.length + 1;
    }
  }

  let last = 0;
  let keyAt = 0;
  // Keyed on where a key *starts*, not where it ends. A JSON key is itself a
  // quoted string, so the token scan finds `"a"` at an index inside the range
  // `  "a"` already claimed — and a range that only flushed once the scanner
  // had passed its end always lost to the string sitting in the middle of it.
  const flushKeysBefore = (limit: number) => {
    while (keyAt < keyRanges.length && keyRanges[keyAt][0] <= limit) {
      const [s, e] = keyRanges[keyAt];
      if (s < last) { keyAt++; continue; }
      if (s > last) out.appendChild(document.createTextNode(code.slice(last, s)));
      out.appendChild(span("key", code.slice(s, e)));
      last = e;
      keyAt++;
    }
  };

  for (let m = re.exec(code); m; m = re.exec(code)) {
    flushKeysBefore(m.index);
    // A key that already claimed this range wins; skip the token inside it.
    if (m.index < last) continue;
    const cls = classOf(m[0], g);
    if (!cls) continue;
    if (m.index > last) out.appendChild(document.createTextNode(code.slice(last, m.index)));
    out.appendChild(span(cls, m[0]));
    last = m.index + m[0].length;
  }
  flushKeysBefore(code.length);
  if (last < code.length) out.appendChild(document.createTextNode(code.slice(last)));
  return out;
}

/**
 * Markup gets its own pass.
 *
 * HTML is not a language with keywords in it; it is angle brackets containing
 * a different grammar. Running the generic tokenizer over it colours `div` and
 * `class` identically to the text between them, which is worse than no colour
 * at all — so this walks tags instead, and everything outside one stays plain,
 * which is exactly the distinction a reader wants.
 */
function markup(code: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const re = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z][\w:-]*|>|\/>|[\w:-]+(?==)|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  let last = 0;
  /** Attribute names only mean anything between `<` and `>`. */
  let inTag = false;

  for (let m = re.exec(code); m; m = re.exec(code)) {
    const t = m[0];
    let cls: Tok | null = null;
    if (t.startsWith("<!--")) cls = "com";
    else if (t.startsWith("<")) { cls = "tag"; inTag = true; }
    else if (t === ">" || t === "/>") { cls = "tag"; inTag = false; }
    else if (t.startsWith('"') || t.startsWith("'")) cls = inTag ? "str" : null;
    else if (inTag) cls = "att";

    if (!cls) continue;
    if (m.index > last) out.appendChild(document.createTextNode(code.slice(last, m.index)));
    out.appendChild(span(cls, t));
    last = m.index + t.length;
  }
  if (last < code.length) out.appendChild(document.createTextNode(code.slice(last)));
  return out;
}
