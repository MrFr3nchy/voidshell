import type { ArrangeMode, BodyKind, KernelContext } from "../../kernel/types";
import { normalize } from "../../kernel/vfs";
import { hostExec, hostJobs, hostKill } from "../../runtime/hostBridge";

/**
 * The console half of the Workspace.
 *
 * It has no special powers — it only calls the same KernelContext every module
 * gets. That's the point: the console is not privileged, it's just the most
 * honest window onto what the syscall surface can actually do.
 *
 * Now that the kernel has a filesystem it is a real shell: cwd, path
 * resolution, pipelines, redirection, tab completion and history search.
 * Anything that isn't a builtin is handed to the machine over the host bridge.
 */

const HOME = "/home/void";
const HISTORY_KEY = "console.history";
const HISTORY_MAX = 200;

/* ------------------------------------------------------------------ */
/* Line parsing                                                        */
/* ------------------------------------------------------------------ */

interface Token {
  value: string;
  /** True if any part of the token came from inside quotes or an escape. */
  quoted: boolean;
}

/**
 * Split a command line into tokens, honouring single and double quotes and
 * backslash escapes. Needed because the desktop happily creates names with
 * spaces in them ("New Folder"), and without this they'd be unreachable.
 */
function tokenize(line: string): Token[] {
  const out: Token[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  let wasQuoted = false;

  const flush = () => {
    if (has || cur) out.push({ value: cur, quoted: wasQuoted });
    cur = "";
    has = false;
    wasQuoted = false;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
      wasQuoted = true;
    } else if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
      wasQuoted = true;
    } else if (/\s/.test(c)) {
      flush();
    } else {
      cur += c;
    }
  }
  flush();
  return out;
}

/** Split a token run on unquoted `|` into pipeline segments. */
function splitPipes(tokens: Token[]): Token[][] {
  const segs: Token[][] = [];
  let cur: Token[] = [];
  for (const t of tokens) {
    if (!t.quoted && t.value === "|") {
      segs.push(cur);
      cur = [];
    } else cur.push(t);
  }
  segs.push(cur);
  return segs;
}

/**
 * Split a segment into its body and an optional redirect target.
 *
 * This works on *tokens*, not on the raw line: a regex would treat the `>` in
 * `(a,b)=>a+b` or in `echo "a > b"` as redirection and silently truncate.
 */
function splitRedirect(tokens: Token[]): {
  body: Token[];
  redirect: string | null;
  append: boolean;
} {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.quoted) continue;
    if (t.value === ">" || t.value === ">>") {
      return {
        body: tokens.slice(0, i),
        redirect: tokens[i + 1]?.value ?? null,
        append: t.value === ">>",
      };
    }
    if (t.value.startsWith(">>") && t.value.length > 2) {
      return { body: tokens.slice(0, i), redirect: t.value.slice(2), append: true };
    }
    if (t.value.startsWith(">") && t.value.length > 1) {
      return { body: tokens.slice(0, i), redirect: t.value.slice(1), append: false };
    }
  }
  return { body: tokens, redirect: null, append: false };
}

/** Split on unquoted `&&` so quoted text containing it stays intact. */
function splitChain(line: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) {
      cur += c + line[++i];
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "&" && line[i + 1] === "&") {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/* ------------------------------------------------------------------ */

const HELP = `navigation   pwd  cd <dir>  ls [-l] [dir]  tree [dir]
files        cat <f>  head [-n N]  tail [-n N]  write <f> <text>  touch <f>
             mkdir <d>  rm [-r] <p>  mv <a> <b>  find <term>  df
filters      grep [-i] <pat>  sort [-r]  uniq  wc        (use with |)
pipes        ls -l | grep .md | wc      redirect with > and >>
programs     run <file.py|.js>  edit <file>  launch <path>
host         anything else runs on the machine (npm install, git…)
             jobs  kill <job-id>  app <port>        [dev server only]
windows      wins  go <surface-id>  home  arrange <arc|wall|ring|scatter>
links        link <id> <id> [...]  groups  unlink <group-id>
world        spawn <sun|moon|planet|singularity>  bodies  merge <surf> <body>
             sky <0..1.5>  say <text>
system       apps  open <id>  set <k> <v>  get <k>  settings [filter]
             history  clear  help
keys         Tab complete · ^R search history · ^A/^E/^U/^K/^W · ^L clear
             ~ is ${HOME} · !! repeats the last command`;

/** Everything the shell resolves itself. Also the tab-completion vocabulary. */
const BUILTINS = [
  "help", "pwd", "cd", "ls", "tree", "cat", "head", "tail", "write", "touch",
  "mkdir", "rm", "mv", "find", "df", "grep", "sort", "uniq", "wc", "run",
  "edit", "launch", "apps", "open", "wins", "go", "home", "arrange", "link",
  "groups", "unlink", "spawn", "bodies", "merge", "set", "get", "settings",
  "say", "sky", "echo", "clear", "history", "app", "jobs", "kill",
];

function expandTilde(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return HOME + p.slice(1);
  return p;
}

function tildify(p: string): string {
  return p === HOME || p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** `set world.drift true` should store a boolean, not the string "true". */
function coerce(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  return Number.isFinite(n) && raw.trim() !== "" ? n : raw;
}

function fmtSize(n: number): string {
  return n < 1024
    ? `${n}B`
    : n < 1024 * 1024
      ? `${(n / 1024).toFixed(1)}K`
      : `${(n / 1048576).toFixed(1)}M`;
}

/* ------------------------------------------------------------------ */

export interface ConsoleHandle {
  el: HTMLElement;
  /** Follow the browser pane into a new directory. */
  setCwd(path: string): void;
  focus(): void;
  dispose(): void;
}

export function createConsole(
  ctx: KernelContext,
  opts: { cwd: string; onCwd(path: string): void }
): ConsoleHandle {
  const el = document.createElement("div");
  el.className = "term-root";

  const log = document.createElement("div");
  log.className = "term-log";
  const line = document.createElement("div");
  line.className = "term-line";
  const prompt = document.createElement("span");
  prompt.className = "term-prompt";
  const input = document.createElement("input");
  input.className = "term-input";
  input.setAttribute("aria-label", "console input");
  input.autocomplete = "off";
  input.spellcheck = false;
  line.append(prompt, input);
  el.append(log, line);

  let cwd = opts.cwd;

  const history: string[] = [...ctx.state.get<string[]>(HISTORY_KEY, [])];
  let histIndex = history.length;

  /** Reverse-i-search state. Null when not searching. */
  let search: { term: string; index: number } | null = null;

  const setPrompt = () => {
    prompt.textContent = search
      ? `(reverse-i-search)\`${search.term}':`
      : `${tildify(cwd)} ›`;
    prompt.classList.toggle("searching", !!search);
  };

  const print = (text: string, cls = "") => {
    const d = document.createElement("div");
    d.className = `term-out ${cls}`;
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  };

  /**
   * The host bridge speaks (kind, text); this shell's print takes (text, class).
   * Adapt once here rather than at every call site.
   */
  const hostPrint = (kind: string, text: string) => print(text, kind);

  /** Resolve a user-supplied path against the shell's cwd, expanding `~`. */
  const abs = (p: string) => normalize(expandTilde(p || "."), cwd);

  const setCwd = (next: string, announce = true) => {
    cwd = next;
    setPrompt();
    if (announce) opts.onCwd(next);
  };

  /* ---------------- recursive helpers ---------------- */

  const tree = (path: string, depth: number, prefix: string, out: Out): void => {
    if (depth > 3) return;
    let items;
    try {
      items = ctx.fs.ls(path);
    } catch {
      return;
    }
    items.forEach((e, i) => {
      const last = i === items.length - 1;
      out(`${prefix}${last ? "└─ " : "├─ "}${e.name}${e.kind === "dir" ? "/" : ""}`);
      if (e.kind === "dir") tree(e.path, depth + 1, `${prefix}${last ? "   " : "│  "}`, out);
    });
  };

  const findIn = (path: string, term: string, hits: string[]): void => {
    if (hits.length >= 40) return;
    let items;
    try {
      items = ctx.fs.ls(path);
    } catch {
      return;
    }
    for (const e of items) {
      if (e.name.toLowerCase().includes(term.toLowerCase())) hits.push(e.path);
      if (e.kind === "dir") findIn(e.path, term, hits);
    }
  };

  /* ---------------- execution ---------------- */

  type Out = (text: string, cls?: string) => void;

  /**
   * One command. `stdin` carries the previous segment's output, so filters work
   * the same whether they were given a file or piped into.
   *
   * Returns false on error, which breaks both the pipeline and any enclosing
   * `&&` chain, and null for "not a builtin" so the caller can fall through to
   * the host bridge.
   */
  const exec = (body: string[], stdin: string[] | null, out: Out): boolean | null => {
    const cmd = body[0] ?? "";
    const rest = body.slice(1);
    const arg = rest.join(" ");
    const flags = rest.filter((r) => r.startsWith("-"));
    const operands = rest.filter((r) => !r.startsWith("-"));

    /** Lines a filter should work on: piped input, else the named file. */
    const sourceLines = (): string[] => {
      if (stdin) return stdin;
      if (!operands.length) throw new Error(`usage: ${cmd} <file>  (or pipe into it)`);
      return ctx.fs.read(abs(operands[0])).split("\n");
    };

    /** `-n 20` or `-20`, defaulting to 10 as in coreutils. */
    const countFlag = (fallback: number): number => {
      const n = rest.indexOf("-n");
      if (n >= 0 && rest[n + 1]) return Math.max(0, Number(rest[n + 1]) || fallback);
      const short = flags.find((f) => /^-\d+$/.test(f));
      return short ? Number(short.slice(1)) : fallback;
    };

    try {
      switch (cmd) {
        case "":
          break;

        case "help":
          out(HELP);
          break;

        case "pwd":
          out(cwd);
          break;

        case "cd": {
          const target = abs(operands[0] || HOME);
          if (!ctx.fs.exists(target)) throw new Error(`no such directory: ${arg}`);
          if (!ctx.fs.isDir(target)) throw new Error(`not a directory: ${arg}`);
          setCwd(target);
          break;
        }

        case "ls": {
          const long = flags.includes("-l");
          const items = ctx.fs.ls(abs(operands[0] ?? "."));
          if (!items.length) out("(empty)", "muted");
          for (const e of items) {
            const slash = e.kind === "dir" ? "/" : "";
            if (long) {
              const flag = e.readonly ? "r-" : "rw";
              const size = e.kind === "dir" ? "-" : fmtSize(e.size);
              const note =
                e.omitted === "binary"
                  ? " (binary)"
                  : e.omitted === "toolarge"
                    ? " (too large)"
                    : "";
              out(`${flag}  ${size.padStart(7)}  ${e.name}${slash}${note}`);
            } else out(`${e.name}${slash}`);
          }
          break;
        }

        case "tree":
          out(abs(operands[0] || "."));
          tree(abs(operands[0] || "."), 0, "", out);
          break;

        case "cat": {
          const text = stdin ? stdin.join("\n") : ctx.fs.read(abs(operands[0] ?? ""));
          if (!stdin && !operands.length) throw new Error("usage: cat <file>");
          if (!text) out("(empty file)", "muted");
          else for (const l of text.split("\n")) out(l);
          break;
        }

        case "head":
          for (const l of sourceLines().slice(0, countFlag(10))) out(l);
          break;

        case "tail":
          for (const l of sourceLines().slice(-countFlag(10))) out(l);
          break;

        case "grep": {
          const pat = operands[0];
          if (!pat) throw new Error("usage: grep [-i] <pattern> [file]");
          const ci = flags.includes("-i");
          const src = stdin ?? ctx.fs.read(abs(operands[1] ?? "")).split("\n");
          if (!stdin && !operands[1]) throw new Error("usage: grep <pattern> <file>");
          const needle = ci ? pat.toLowerCase() : pat;
          const hits = src.filter((l) => (ci ? l.toLowerCase() : l).includes(needle));
          if (!hits.length) return false; // grep exits non-zero on no match
          for (const l of hits) out(l);
          break;
        }

        case "sort": {
          const lines = [...sourceLines()].sort((a, b) => a.localeCompare(b));
          if (flags.includes("-r")) lines.reverse();
          for (const l of lines) out(l);
          break;
        }

        case "uniq": {
          let prev: string | null = null;
          for (const l of sourceLines()) {
            if (l !== prev) out(l);
            prev = l;
          }
          break;
        }

        case "wc": {
          const lines = sourceLines();
          const chars = lines.join("\n").length;
          const words = lines.join(" ").split(/\s+/).filter(Boolean).length;
          out(`${lines.length} lines  ${words} words  ${chars} chars`);
          break;
        }

        case "write": {
          const [target, ...words] = rest;
          if (!target) throw new Error("usage: write <file> <text>");
          ctx.fs.write(abs(target), words.join(" "));
          out(`wrote ${target}`, "muted");
          break;
        }

        case "touch":
          if (!arg) throw new Error("usage: touch <file>");
          if (!ctx.fs.exists(abs(arg))) ctx.fs.write(abs(arg), "");
          break;

        case "mkdir":
          if (!operands.length) throw new Error("usage: mkdir <dir>");
          for (const d of operands) ctx.fs.mkdir(abs(d));
          break;

        case "rm": {
          const recursive = flags.some((f) => f === "-r" || f === "-rf");
          if (!operands.length) throw new Error("usage: rm [-r] <path>");
          for (const p of operands) ctx.fs.rm(abs(p), recursive);
          break;
        }

        case "mv": {
          const [a, b] = operands;
          if (!a || !b) throw new Error("usage: mv <from> <to>");
          ctx.fs.mv(abs(a), abs(b));
          break;
        }

        case "find": {
          if (!arg) throw new Error("usage: find <term>");
          const hits: string[] = [];
          findIn(cwd, arg, hits);
          if (!hits.length) out("no matches", "muted");
          else hits.forEach((h) => out(h));
          break;
        }

        case "df": {
          const u = ctx.fs.usage();
          out(`${u.files} files · ${u.dirs} dirs`);
          out(`${fmtSize(u.bytes)} readable · ${fmtSize(u.indexed)} indexed on disk`);
          break;
        }

        case "history":
          history.forEach((h, i) => out(`${pad(String(i + 1), 5)}${h}`));
          break;

        case "run": {
          if (!arg) throw new Error("usage: run <file.py|file.js>");
          const target = abs(arg);
          if (!ctx.fs.exists(target)) throw new Error(`no such file: ${arg}`);
          ctx.launch("editor", { path: target, run: true });
          break;
        }

        case "edit": {
          if (!arg) throw new Error("usage: edit <file>");
          const target = abs(arg);
          if (!ctx.fs.exists(target)) throw new Error(`no such file: ${arg}`);
          ctx.launch("editor", { path: target });
          break;
        }

        case "launch":
          if (!arg) throw new Error("usage: launch <path>");
          ctx.openPath(abs(arg));
          break;

        case "apps":
          for (const m of ctx.registry())
            out(`${m.glyph ?? "·"}  ${pad(m.id, 12)} ${pad(m.kind, 8)} ${m.name}`);
          break;

        case "open":
          if (!arg) throw new Error("usage: open <module-id>");
          ctx.launch(arg);
          break;

        case "wins":
          for (const s of ctx.openSurfaces())
            out(`${pad(s.id, 12)} ${pad(s.moduleId, 12)} ${s.title}`);
          break;

        case "go":
          if (!arg) throw new Error("usage: go <surface-id>");
          ctx.focusSurface(arg);
          ctx.lookAt(arg);
          break;

        case "home":
          ctx.resetView();
          break;

        case "arrange": {
          const modes: ArrangeMode[] = ["arc", "wall", "ring", "scatter"];
          const mode = modes.find((m) => m === arg);
          if (!mode) throw new Error(`usage: arrange <${modes.join("|")}>`);
          ctx.arrange(mode);
          break;
        }

        case "link": {
          if (rest.length < 2) throw new Error("usage: link <id> <id> [...]");
          const id = ctx.linkSurfaces(rest);
          if (!id) throw new Error("need two live windows");
          out(`bound → ${id}`, "muted");
          break;
        }

        case "groups": {
          const groups = ctx.listGroups();
          if (!groups.length) out("nothing bound", "muted");
          for (const g of groups)
            out(`${pad(g.id, 10)} ${pad(g.name, 22)} ${g.members.join(" ")}`);
          break;
        }

        case "unlink":
          if (!arg) throw new Error("usage: unlink <group-id>");
          ctx.unlinkGroup(arg);
          break;

        case "spawn": {
          const kinds: BodyKind[] = ["sun", "moon", "planet", "singularity"];
          const kind = kinds.find((k) => k === arg);
          if (!kind) throw new Error(`usage: spawn <${kinds.join("|")}>`);
          out(`→ ${ctx.spawnBody(kind)}`, "muted");
          break;
        }

        case "bodies": {
          const bodies = ctx.listBodies();
          if (!bodies.length) out("the sky is empty", "muted");
          for (const b of bodies) out(`${pad(b.id, 10)} ${b.kind}`);
          break;
        }

        case "merge":
          if (rest.length < 2) throw new Error("usage: merge <surface-id> <body-id>");
          ctx.attachSurface(rest[0], rest[1]);
          break;

        case "set": {
          const [key, ...v] = rest;
          if (!key || !v.length) throw new Error("usage: set <key> <value>");
          ctx.state.set(key, coerce(v.join(" ")));
          out(`${key} ← ${v.join(" ")}`, "muted");
          break;
        }

        case "get":
          if (!arg) throw new Error("usage: get <key>");
          out(`${arg} = ${JSON.stringify(ctx.state.get(arg, null))}`, "muted");
          break;

        case "settings": {
          const q = arg.toLowerCase();
          const defs = ctx
            .settings()
            .filter((d) => !q || `${d.key} ${d.label} ${d.group}`.toLowerCase().includes(q));
          if (!defs.length) out("no matching settings", "muted");
          for (const d of defs)
            out(
              `${pad(d.group, 12)} ${pad(d.key, 26)} ${JSON.stringify(
                ctx.state.get(d.key, d.default ?? null)
              )}`
            );
          break;
        }

        case "say":
          ctx.notify(arg || "…");
          break;

        case "sky": {
          const v = Number(arg);
          if (!Number.isFinite(v)) throw new Error("usage: sky <number>");
          // Route through the settings registry so the Settings app agrees.
          ctx.state.set("appearance.intensity", Math.max(0, Math.min(1.5, v)));
          out(`sky intensity → ${v}`, "muted");
          break;
        }

        case "echo":
          out(arg);
          break;

        case "clear":
          log.replaceChildren();
          break;

        case "app": {
          // Explicit escape hatch: some servers buffer their startup banner, so
          // auto-detection can't be the only way in.
          const port = Number(arg);
          if (!port) throw new Error("usage: app <port>");
          ctx.launch("webapp", { path: String(port) });
          break;
        }

        case "jobs":
          hostJobs(hostPrint);
          break;

        case "kill":
          if (!arg) throw new Error("usage: kill <job-id>");
          hostKill(arg, hostPrint);
          break;

        default:
          return null; // not a builtin — the caller hands it to the machine
      }
      return true;
    } catch (err) {
      print(err instanceof Error ? err.message : String(err), "warn");
      return false;
    }
  };

  /** Run one `a | b | c` pipeline, with redirection applied to the tail. */
  const runPipeline = (raw: string): boolean => {
    const trimmed = raw.trim();
    if (!trimmed) return true;

    const segments = splitPipes(tokenize(raw));
    let stdin: string[] | null = null;

    for (let i = 0; i < segments.length; i++) {
      const last = i === segments.length - 1;
      const { body, redirect, append } = splitRedirect(segments[i]);
      const words = body.map((t) => t.value);
      const capture = !last || (last && !!redirect);
      const captured: string[] = [];
      const out: Out = (t, cls) => (capture ? void captured.push(t) : print(t, cls));

      const result = exec(words, stdin, out);

      // Not a builtin. Only meaningful as a whole command, so hand the raw text
      // to the machine — the host's own shell does its own quoting and piping.
      if (result === null) {
        if (segments.length > 1 || stdin) {
          print(`unknown filter: ${words[0]}`, "warn");
          return false;
        }
        hostExec(trimmed, cwd, hostPrint, (port, jobId) =>
          ctx.launch("webapp", { path: String(port), jobId })
        );
        return true;
      }
      if (result === false) return false;

      if (redirect) {
        try {
          const target = abs(redirect);
          const prior = append && ctx.fs.exists(target) ? ctx.fs.read(target) : "";
          const body = captured.join("\n");
          ctx.fs.write(target, prior ? `${prior}\n${body}` : body);
          print(`wrote ${captured.length} line(s) → ${redirect}`, "muted");
        } catch (err) {
          print(err instanceof Error ? err.message : String(err), "warn");
          return false;
        }
        stdin = null;
      } else stdin = captured;
    }
    return true;
  };

  /** Run a chain of `a && b && c`, stopping at the first failure. */
  const run = (raw: string) => {
    for (const part of splitChain(raw)) {
      if (!runPipeline(part)) break;
    }
  };

  /* ---------------- tab completion ---------------- */

  /** Longest string that all candidates start with. */
  const commonPrefix = (xs: string[]): string => {
    if (!xs.length) return "";
    let p = xs[0];
    for (const x of xs) {
      while (!x.startsWith(p)) p = p.slice(0, -1);
    }
    return p;
  };

  /** Directory entries matching a partial path, preserving what the user typed. */
  const pathCandidates = (frag: string): string[] => {
    const expanded = expandTilde(frag);
    const slash = expanded.lastIndexOf("/");
    const dirPart = slash >= 0 ? expanded.slice(0, slash + 1) : "";
    const basePart = slash >= 0 ? expanded.slice(slash + 1) : expanded;
    // Keep the user's own prefix (`~/`, `../`) rather than the resolved path,
    // so completing never silently rewrites what they typed.
    const typedDir = frag.slice(0, frag.length - basePart.length);
    let items;
    try {
      items = ctx.fs.ls(abs(dirPart || "."));
    } catch {
      return [];
    }
    return items
      .filter((e) => e.name.startsWith(basePart))
      .map((e) => `${typedDir}${e.name}${e.kind === "dir" ? "/" : ""}`);
  };

  const complete = () => {
    const value = input.value;
    const upto = value.slice(0, input.selectionStart ?? value.length);
    // The fragment under the cursor: everything since the last unescaped space.
    const frag = /(?:^|\s)([^\s]*)$/.exec(upto)?.[1] ?? "";
    const isFirstWord = upto.trimStart() === frag;

    const candidates = isFirstWord
      ? BUILTINS.filter((c) => c.startsWith(frag)).sort()
      : pathCandidates(frag);

    if (!candidates.length) return;

    const fill = candidates.length === 1 ? candidates[0] : commonPrefix(candidates);
    if (fill && fill.length > frag.length) {
      const head = upto.slice(0, upto.length - frag.length);
      const tail = value.slice(upto.length);
      // A single completed command or file gets a trailing space; a directory
      // doesn't, so you can keep descending without retyping the slash.
      const suffix = candidates.length === 1 && !fill.endsWith("/") ? " " : "";
      input.value = head + fill + suffix + tail;
      const caret = (head + fill + suffix).length;
      input.setSelectionRange(caret, caret);
    } else if (candidates.length > 1) {
      // Ambiguous and nothing more to fill in — show the options, as bash does.
      print(`${tildify(cwd)} › ${value}`, "echoed");
      print(candidates.join("   "), "muted");
    }
  };

  /* ---------------- history ---------------- */

  const remember = (value: string) => {
    if (!value.trim()) return;
    if (history[history.length - 1] !== value) history.push(value);
    while (history.length > HISTORY_MAX) history.shift();
    histIndex = history.length;
    ctx.state.set(HISTORY_KEY, history);
  };

  /** Walk backwards from `from` for the newest entry containing `term`. */
  const searchBack = (term: string, from: number): number => {
    for (let i = Math.min(from, history.length - 1); i >= 0; i--) {
      if (history[i].includes(term)) return i;
    }
    return -1;
  };

  const applySearch = () => {
    if (!search) return;
    const i = searchBack(search.term, search.index);
    if (i >= 0) {
      search.index = i;
      input.value = history[i];
    }
    setPrompt();
  };

  const endSearch = (keep: boolean) => {
    if (!search) return;
    if (!keep) input.value = "";
    search = null;
    setPrompt();
  };

  const submit = () => {
    const value = input.value;
    print(`${tildify(cwd)} › ${value}`, "echoed");
    remember(value);
    input.value = "";
    run(value);
  };

  /* ---------------- key handling ---------------- */

  input.addEventListener("keydown", (e) => {
    // The console owns its keystrokes; the shell's global binds (space summons
    // the launcher) must not fire while typing here.
    e.stopPropagation();

    const mod = e.ctrlKey || e.metaKey;

    // --- reverse-i-search mode swallows most keys ---
    if (search) {
      if (e.key === "Escape" || (e.ctrlKey && e.key.toLowerCase() === "g")) {
        e.preventDefault();
        endSearch(false);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        endSearch(true);
        submit();
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        search.index -= 1;
        applySearch();
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        search.term = search.term.slice(0, -1);
        search.index = history.length - 1;
        applySearch();
        return;
      }
      if (e.key.length === 1 && !mod) {
        e.preventDefault();
        search.term += e.key;
        search.index = history.length - 1;
        applySearch();
        return;
      }
      // Anything else (arrows, Tab…) leaves search but keeps the line.
      endSearch(true);
    }

    if (e.ctrlKey && e.key.toLowerCase() === "r") {
      e.preventDefault();
      search = { term: "", index: history.length - 1 };
      setPrompt();
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      complete();
      return;
    }

    // --- readline-style line editing ---
    if (e.ctrlKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const caret = input.selectionStart ?? 0;
      if (k === "a") {
        e.preventDefault();
        input.setSelectionRange(0, 0);
        return;
      }
      if (k === "e") {
        e.preventDefault();
        input.setSelectionRange(input.value.length, input.value.length);
        return;
      }
      if (k === "u") {
        e.preventDefault();
        input.value = input.value.slice(caret);
        input.setSelectionRange(0, 0);
        return;
      }
      if (k === "k") {
        e.preventDefault();
        input.value = input.value.slice(0, caret);
        return;
      }
      if (k === "w") {
        e.preventDefault();
        const head = input.value.slice(0, caret).replace(/\s*\S+$/, "");
        input.value = head + input.value.slice(caret);
        input.setSelectionRange(head.length, head.length);
        return;
      }
      if (k === "l") {
        e.preventDefault();
        log.replaceChildren();
        return;
      }
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (histIndex > 0) input.value = history[--histIndex] ?? "";
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIndex < history.length - 1) input.value = history[++histIndex] ?? "";
      else {
        histIndex = history.length;
        input.value = "";
      }
      return;
    }
    if (e.key !== "Enter") return;

    e.preventDefault();
    // `!!` repeats the previous command, echoed so you see what actually ran.
    if (input.value.trim() === "!!") {
      const prev = history[history.length - 1];
      if (!prev) {
        print("no previous command", "warn");
        input.value = "";
        return;
      }
      input.value = prev;
    }
    submit();
  });

  // Clicking anywhere in the pane focuses the prompt, as a terminal would.
  el.addEventListener("mousedown", (e) => {
    if (window.getSelection()?.toString()) return; // don't fight text selection
    if (e.target === input) return;
    e.preventDefault();
    input.focus();
  });

  setPrompt();
  print("voidshell console. type `help`.", "muted");
  print("/home/void (rw) · /projects (ro) · Tab completes · ^R searches", "muted");

  return {
    el,
    setCwd(path) {
      // announce=false: the browser told us, telling it back would loop.
      setCwd(path, false);
    },
    focus() {
      input.focus();
    },
    dispose() {
      el.replaceChildren();
    },
  };
}
