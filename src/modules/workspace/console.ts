import type { ArrangeMode, BodyKind, KernelContext, LogLevel } from "../../kernel/types";
import { normalize } from "../../kernel/vfs";
import { ProcTable } from "../../kernel/procs";
import {
  DEFAULT_HOSTNAME,
  DEFAULT_MOTD,
  DEFAULT_USER,
  HOSTNAME_KEY,
  MOTD_KEY,
  USER_KEY,
} from "../../kernel/sysfs";
import { emptyTrash, listTrash, moveToTrash, restoreFromTrash } from "../../kernel/trash";
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
 * Split a command line into tokens, honouring single and double quotes,
 * backslash escapes and `$VAR` expansion. Needed because the desktop happily
 * creates names with spaces in them ("New Folder"), and without this they'd be
 * unreachable.
 *
 * Expansion happens here rather than as a pre-pass over the raw line because
 * quoting has to be respected: `'$HOME'` is a literal, `"$HOME"` is not, and a
 * regex over the whole line cannot tell those apart.
 */
function tokenize(line: string, lookup?: (name: string) => string): Token[] {
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
    } else if (c === "$" && quote !== "'" && lookup) {
      // `${NAME}` and `$NAME`; `$?` is the previous command's exit status.
      let name = "";
      if (line[i + 1] === "{") {
        const close = line.indexOf("}", i + 2);
        if (close > 0) {
          name = line.slice(i + 2, close);
          i = close;
        }
      } else {
        const m = /^[A-Za-z_?][A-Za-z0-9_]*/.exec(line.slice(i + 1));
        if (m) {
          name = m[0];
          i += m[0].length;
        }
      }
      if (!name) cur += c;
      else {
        cur += lookup(name);
        has = true;
        // An expanded value is treated as quoted so that a variable holding
        // `|` or `>` can't silently turn into a pipe or a redirect.
        wasQuoted = true;
      }
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

const HELP = `navigation   pwd  cd <dir>  ls [-l] [-a] [dir]  tree [dir]
files        cat <f>  head [-n N]  tail [-n N]  write <f> <text>  touch <f>
             mkdir <d>  rm [-r|-f] <p>  mv <a> <b>  find <term>  df  mount
trash        rm sends to the trash · trash · restore <name> · rm -f is forever
filters      grep [-i] <pat>  sort [-r]  uniq  wc        (use with |)
pipes        ls -l | grep .md | wc      redirect with > and >>  or > /dev/null
processes    ps  kill <pid>  uptime  free  dmesg [level]
environment  env  export K=V  unset K  whoami  hostname [name]   $VAR expands
programs     run <file.py|.js>  edit <file>  launch <path>
host         anything else runs on the machine (npm install, git…)
             jobs  kill <job-id>  app <port>        [dev server only]
windows      wins  go <surface-id>  home  arrange <arc|wall|ring|scatter>
links        link <id> <id> [...]  groups  unlink <group-id>
world        spawn <sun|moon|planet|singularity>  bodies  merge <surf> <body>
             sky <0..1.5>  say <text>
system       apps  open <id>  set <k> <v>  get <k>  settings [filter]
             lock  reboot  shutdown  history  clear  help
the system   ls /proc · cat /proc/uptime · cat /etc/autostart · /var/log
keys         Tab complete · ^R search history · ^A/^E/^U/^K/^W · ^L clear
             ~ is ${HOME} · !! repeats the last command`;

/** Everything the shell resolves itself. Also the tab-completion vocabulary. */
const BUILTINS = [
  "help", "pwd", "cd", "ls", "tree", "cat", "head", "tail", "write", "touch",
  "mkdir", "rm", "mv", "find", "df", "grep", "sort", "uniq", "wc", "run",
  "edit", "launch", "apps", "open", "wins", "go", "home", "arrange", "link",
  "groups", "unlink", "spawn", "bodies", "merge", "set", "get", "settings",
  "say", "sky", "echo", "clear", "history", "app", "jobs", "kill",
  "ps", "uptime", "free", "dmesg", "mount", "env", "export", "unset",
  "whoami", "hostname", "trash", "restore", "lock", "reboot", "shutdown",
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

const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");

/**
 * `ls -l`'s date column, following coreutils: a time for anything in the last
 * six months, a year for anything older. Both are twelve characters wide so the
 * filename column stays aligned.
 */
function fmtDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const day = String(d.getDate()).padStart(2, " ");
  const stamp =
    now - ms < 182 * 86400_000
      ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
      : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${day} ${stamp}`;
}

/** How long the system has been up, in the words `uptime` uses. */
function fmtUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d) return `${d} day${d === 1 ? "" : "s"}, ${h}:${String(m).padStart(2, "0")}`;
  if (h) return `${h}:${String(m).padStart(2, "0")}`;
  return `${m} min`;
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

  /* ---------------- environment ---------------- */

  /**
   * Variables the user sets with `export`. The interesting ones aren't in here:
   * PWD, USER and HOSTNAME are *derived* on every lookup, so `$USER` can never
   * disagree with /etc/passwd and `cd` can never leave `$PWD` stale. A shell
   * that caches those has two sources of truth for one fact.
   */
  const exported = new Map<string, string>([
    ["SHELL", "/bin/vsh"],
    ["TERM", "void"],
    ["LANG", "en_US.UTF-8"],
  ]);

  /** The previous command's exit status, readable as `$?`. */
  let lastStatus = 0;

  const user = () => ctx.state.get<string>(USER_KEY, DEFAULT_USER);
  const hostname = () => ctx.state.get<string>(HOSTNAME_KEY, DEFAULT_HOSTNAME);

  const envGet = (name: string): string => {
    switch (name) {
      case "HOME":
        return HOME;
      case "PWD":
        return cwd;
      case "USER":
        return user();
      case "HOSTNAME":
        return hostname();
      case "?":
        return String(lastStatus);
      case "RANDOM":
        return String(Math.floor(Math.random() * 32768));
      default:
        return exported.get(name) ?? "";
    }
  };

  /** Everything `env` prints: the derived names first, then whatever was set. */
  const envAll = (): [string, string][] => [
    ...(["HOME", "PWD", "USER", "HOSTNAME"] as const).map(
      (k) => [k, envGet(k)] as [string, string]
    ),
    ...[...exported.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  ];

  const setPrompt = () => {
    prompt.textContent = search
      ? `(reverse-i-search)\`${search.term}':`
      : `${user()}@${hostname()} ${tildify(cwd)} ›`;
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
          // -a and -l compose, and `-la`/`-al` are the way people actually type
          // it, so the flags are matched by letter rather than by whole token.
          const letters = flags.join("");
          const long = letters.includes("l");
          const all = letters.includes("a");
          const items = ctx.fs
            .ls(abs(operands[0] ?? "."))
            .filter((e) => all || !e.name.startsWith("."));
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
              out(
                `${flag}  ${size.padStart(7)}  ${fmtDate(e.mtime)}  ` +
                  `${e.name}${slash}${note}`
              );
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
          if (!operands.length) throw new Error("usage: rm [-r] [-f] <path>");
          const letters = flags.join("");
          const permanent = letters.includes("f");
          const recursive = letters.includes("r");

          for (const p of operands) {
            const target = abs(p);
            if (permanent) {
              ctx.fs.rm(target, recursive);
              out(`deleted ${p} permanently`, "muted");
            } else {
              // The default is recoverable. `-r` isn't required to trash a
              // directory because a move is a move — the flag only guards the
              // irreversible path, which is where a guard is worth anything.
              const name = moveToTrash(ctx, target);
              out(`${p} → trash (restore ${name})`, "muted");
            }
          }
          break;
        }

        case "trash": {
          const items = listTrash(ctx);
          if (!items.length) {
            out("the trash is empty", "muted");
            break;
          }
          if (flags.includes("-e") || operands[0] === "empty") {
            const n = emptyTrash(ctx);
            out(`deleted ${n} item${n === 1 ? "" : "s"} for good`, "muted");
            break;
          }
          for (const i of items)
            out(`${pad(i.name, 24)} ${pad(fmtDate(i.at), 13)} was ${tildify(i.from)}`);
          out(`restore <name> · trash -e empties it`, "muted");
          break;
        }

        case "restore": {
          if (!arg) throw new Error("usage: restore <name>   (see `trash`)");
          out(`restored → ${tildify(restoreFromTrash(ctx, arg))}`, "muted");
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

        case "mount": {
          for (const m of ctx.fs.mounts())
            out(
              `${pad(m.at, 14)} ${pad(m.backing, 14)} ${m.readonly ? "ro" : "rw"}` +
                `${m.synthetic ? "  (synthetic)" : ""}`
            );
          break;
        }

        /* ---------------- processes ---------------- */

        case "ps": {
          out(`${"PID".padStart(5)}  ${pad("STAT", 8)}${pad("ELAPSED", 10)}${pad("MODULE", 14)}NAME`);
          for (const p of ctx.ps())
            out(
              `${String(p.pid).padStart(5)}  ${pad(p.state, 8)}` +
                `${pad(ProcTable.elapsed(p), 10)}${pad(p.moduleId, 14)}${p.name}`
            );
          break;
        }

        case "kill": {
          if (!arg) throw new Error("usage: kill <pid>   (or kill <job-id> for a host job)");
          // Host jobs are named `job-3`; processes are numeric. Dispatching on
          // the shape means one verb covers both without a second command.
          const pid = Number(arg);
          if (!Number.isInteger(pid)) {
            hostKill(arg, hostPrint);
            break;
          }
          if (!ctx.kill(pid)) return false;
          out(`killed ${pid}`, "muted");
          break;
        }

        case "uptime": {
          const procs = ctx.ps();
          const wins = ctx.openSurfaces().length;
          out(
            `up ${fmtUptime(ctx.uptime())} · ${procs.length} processes · ` +
              `${wins} window${wins === 1 ? "" : "s"} · ${ctx.stats().fps} fps`
          );
          break;
        }

        // These read the same generated files the shell exposes, rather than
        // recomputing the numbers — one source of truth, two ways in.
        case "free":
          for (const l of ctx.fs.read("/proc/meminfo").split("\n")) out(l);
          break;

        case "dmesg": {
          const levels: LogLevel[] = ["debug", "info", "warn", "error"];
          const min = levels.find((l) => l === operands[0]);
          if (operands[0] && !min) throw new Error(`usage: dmesg [${levels.join("|")}]`);
          const entries = ctx.journal().filter((e) => {
            if (!min) return true;
            return levels.indexOf(e.level) >= levels.indexOf(min);
          });
          if (!entries.length) out("nothing logged at that level", "muted");
          for (const e of entries)
            out(
              `[${(e.t / 1000).toFixed(3).padStart(9)}] ${pad(e.tag, 10)} ${e.msg}`,
              e.level === "warn" || e.level === "error" ? "warn" : ""
            );
          break;
        }

        /* ---------------- environment ---------------- */

        case "env":
          for (const [k, v] of envAll()) out(`${k}=${v}`);
          break;

        case "export": {
          if (!arg) throw new Error("usage: export NAME=value");
          const eq = arg.indexOf("=");
          if (eq < 1) throw new Error("usage: export NAME=value");
          const name = arg.slice(0, eq).trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            throw new Error(`not a valid variable name: ${name}`);
          exported.set(name, arg.slice(eq + 1));
          break;
        }

        case "unset":
          if (!arg) throw new Error("usage: unset NAME");
          exported.delete(arg);
          break;

        case "whoami":
          out(user());
          break;

        case "hostname": {
          if (!arg) {
            out(hostname());
            break;
          }
          // Writing the file *is* setting the hostname — /etc/hostname's sink
          // is the only path that state has.
          ctx.fs.write("/etc/hostname", arg);
          setPrompt();
          out(`hostname → ${arg}`, "muted");
          break;
        }

        /* ---------------- power ---------------- */

        case "lock":
        case "reboot":
        case "shutdown":
          // The shell owns the screen, so these are requests, not actions. Same
          // reasoning as `shell.factoryReset`: a module can't reach the HUD.
          ctx.emit("system.power", { action: cmd });
          break;

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

    const segments = splitPipes(tokenize(raw, envGet));
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
      const ok = runPipeline(part);
      // `$?` is the exit status of the last thing that ran, so it's recorded
      // per segment rather than once for the whole line.
      lastStatus = ok ? 0 : 1;
      if (!ok) break;
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
      print(`${user()}@${hostname()} ${tildify(cwd)} › ${value}`, "echoed");
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
    print(`${user()}@${hostname()} ${tildify(cwd)} › ${value}`, "echoed");
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
  // The greeting is /etc/motd, so changing what the shell says on open is
  // editing a file rather than editing this source.
  print(ctx.state.get<string>(MOTD_KEY, DEFAULT_MOTD), "muted");
  print(
    `${ctx.fs.mounts().length} filesystems mounted · \`mount\` lists them · ` +
      "Tab completes · ^R searches",
    "muted"
  );

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
