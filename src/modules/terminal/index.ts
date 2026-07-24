import type {
  ArrangeMode,
  BodyKind,
  KernelContext,
  LaunchArgs,
  VoidModule,
} from "../../kernel/types";
import { dirname, normalize } from "../../kernel/vfs";
import { hostExec, hostJobs, hostKill } from "../../runtime/hostBridge";

/**
 * A system console. It has no special powers — it only calls the same
 * KernelContext every module gets. That's the point: the terminal is not
 * privileged, it's just honest about what the syscall surface can do.
 *
 * Now that the kernel has a filesystem, this is a real shell: cwd, path
 * resolution, redirection, and history.
 */

/**
 * Split a command line into tokens, honouring single and double quotes and
 * backslash escapes. Needed because the desktop happily creates names with
 * spaces in them ("New Folder"), and without this they'd be unreachable from
 * the shell.
 */
interface Token {
  value: string;
  /** True if any part of the token came from inside quotes or an escape. */
  quoted: boolean;
}

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

/**
 * Split a command into its body and an optional redirect target.
 *
 * This works on *tokens*, not on the raw line: a regex would treat the `>` in
 * `(a,b)=>a+b` or in `echo "a > b"` as redirection and silently truncate the
 * command.
 */
function splitRedirect(tokens: Token[]): { body: Token[]; redirect: string | null } {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.quoted) continue;
    if (t.value === ">") {
      return { body: tokens.slice(0, i), redirect: tokens[i + 1]?.value ?? null };
    }
    if (t.value.startsWith(">") && t.value.length > 1) {
      return { body: tokens.slice(0, i), redirect: t.value.slice(1) };
    }
  }
  return { body: tokens, redirect: null };
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

const HELP = `navigation   pwd  cd <dir>  ls [-l] [dir]  tree [dir]
files        cat <f>  head <f>  write <f> <text>  echo <t> [> f]
             mkdir <d>  rm [-r] <p>  mv <a> <b>  touch <f>  find <term>
programs     run <file.py|.js>  edit <file>  launch <path>
host         anything else runs on the machine (npm install, npm run dev, git…)
             jobs  kill <job-id>  app <port>        [dev server only]
windows      wins  go <surface-id>  home  arrange <arc|wall|ring|scatter>
links        link <id> <id> [...]  groups  unlink <group-id>
world        spawn <sun|moon|planet|singularity>  bodies  merge <surf> <body>
             sky <0..1.5>  say <text>
system       apps  open <id>  set <k> <v>  get <k>  settings [filter]
             df  clear  help
projects     live under /projects — try: cd /projects && ls`;

export const terminal: VoidModule = {
  manifest: {
    id: "terminal",
    name: "Console",
    kind: "app",
    glyph: "▚",
    blurb: "drive the kernel by hand",
    version: "0.2.0",
  },

  activate() {},

  launch(ctx: KernelContext, args?: LaunchArgs) {
    ctx.openSurface({
      title: "console",
      width: 560,
      height: 380,
      render: (root) => {
        root.innerHTML = "";
        const log = document.createElement("div");
        log.className = "term-log";
        const line = document.createElement("div");
        line.className = "term-line";
        const prompt = document.createElement("span");
        prompt.className = "term-prompt";
        const input = document.createElement("input");
        input.className = "term-input";
        input.setAttribute("aria-label", "console input");
        input.autofocus = true;
        line.append(prompt, input);
        root.append(log, line);

        // "Open Console Here" passes the directory to start in.
        let cwd = "/home/void";
        if (args?.path && ctx.fs.exists(args.path)) {
          cwd = ctx.fs.isDir(args.path) ? args.path : dirname(args.path);
        }
        const history: string[] = [];
        let histIndex = 0;

        const setPrompt = () => {
          prompt.textContent = `${cwd.replace("/home/void", "~")} ›`;
        };
        setPrompt();

        const print = (text: string, cls = "") => {
          const el = document.createElement("div");
          el.className = `term-out ${cls}`;
          el.textContent = text;
          log.appendChild(el);
          log.scrollTop = log.scrollHeight;
        };

        /**
         * The host bridge speaks (kind, text); this shell's print takes
         * (text, class). Adapt once here rather than at every call site.
         */
        const hostPrint = (kind: string, text: string) => print(text, kind);

        print("voidshell console. type `help`.", "muted");
        print(`filesystem mounted — /home/void (rw) · /projects (ro)`, "muted");

        /** Resolve a user-supplied path against the shell's cwd. */
        const abs = (p: string) => normalize(p || ".", cwd);

        const fmtSize = (n: number) =>
          n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}K` : `${(n / 1048576).toFixed(1)}M`;

        const tree = (path: string, depth: number, prefix: string): void => {
          if (depth > 3) return;
          let items;
          try {
            items = ctx.fs.ls(path);
          } catch {
            return;
          }
          items.forEach((e, i) => {
            const last = i === items.length - 1;
            print(`${prefix}${last ? "└─ " : "├─ "}${e.name}${e.kind === "dir" ? "/" : ""}`);
            if (e.kind === "dir") tree(e.path, depth + 1, `${prefix}${last ? "   " : "│  "}`);
          });
        };

        const find = (path: string, term: string, hits: string[]): void => {
          if (hits.length >= 40) return;
          let items;
          try {
            items = ctx.fs.ls(path);
          } catch {
            return;
          }
          for (const e of items) {
            if (e.name.toLowerCase().includes(term.toLowerCase())) hits.push(e.path);
            if (e.kind === "dir") find(e.path, term, hits);
          }
        };

        /** Run a chain of `a && b && c`, stopping at the first failure. */
        const run = (raw: string) => {
          for (const part of splitChain(raw)) {
            if (!runOne(part)) break;
          }
        };

        /** Execute one command. Returns false if it errored, to break chains. */
        const runOne = (raw: string): boolean => {
          const trimmedRaw = raw.trim();
          // `cmd ... > file` for anything that produces text output. Detected
          // on tokens so a quoted or arrow-function `>` is left alone.
          const { body, redirect } = splitRedirect(tokenize(raw));
          const cmd = body[0]?.value ?? "";
          const rest = body.slice(1).map((t) => t.value);
          const arg = rest.join(" ");
          const captured: string[] = [];
          const out = (t: string, cls = "") =>
            redirect ? captured.push(t) : print(t, cls);

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
                const target = abs(arg || "/home/void");
                if (!ctx.fs.exists(target)) throw new Error(`no such directory: ${arg}`);
                if (!ctx.fs.isDir(target)) throw new Error(`not a directory: ${arg}`);
                cwd = target;
                setPrompt();
                break;
              }

              case "ls": {
                const long = rest.includes("-l");
                const pathArg = rest.filter((r) => !r.startsWith("-"))[0] ?? ".";
                const items = ctx.fs.ls(abs(pathArg));
                if (!items.length) out("(empty)", "muted");
                for (const e of items) {
                  const slash = e.kind === "dir" ? "/" : "";
                  if (long) {
                    const flag = e.readonly ? "r-" : "rw";
                    const size = e.kind === "dir" ? "-" : fmtSize(e.size);
                    const note = e.omitted === "binary" ? " (binary)" : e.omitted === "toolarge" ? " (too large)" : "";
                    out(`${flag}  ${size.padStart(7)}  ${e.name}${slash}${note}`);
                  } else {
                    out(`${e.name}${slash}`);
                  }
                }
                break;
              }

              case "tree":
                out(abs(arg || "."));
                tree(abs(arg || "."), 0, "");
                break;

              case "cat": {
                if (!arg) throw new Error("usage: cat <file>");
                const text = ctx.fs.read(abs(arg));
                if (!text) out("(empty file)", "muted");
                else for (const l of text.split("\n")) out(l);
                break;
              }

              case "head": {
                if (!arg) throw new Error("usage: head <file>");
                for (const l of ctx.fs.read(abs(arg)).split("\n").slice(0, 20)) out(l);
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
                if (!arg) throw new Error("usage: mkdir <dir>");
                ctx.fs.mkdir(abs(arg));
                break;

              case "rm": {
                const recursive = rest.includes("-r") || rest.includes("-rf");
                const target = rest.filter((r) => !r.startsWith("-"))[0];
                if (!target) throw new Error("usage: rm [-r] <path>");
                ctx.fs.rm(abs(target), recursive);
                break;
              }

              case "mv": {
                const [a, b] = rest;
                if (!a || !b) throw new Error("usage: mv <from> <to>");
                ctx.fs.mv(abs(a), abs(b));
                break;
              }

              case "find": {
                if (!arg) throw new Error("usage: find <term>");
                const hits: string[] = [];
                find(cwd, arg, hits);
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

              case "run": {
                if (!arg) throw new Error("usage: run <file.py|file.js>");
                const target = abs(arg);
                if (!ctx.fs.exists(target)) throw new Error(`no such file: ${arg}`);
                ctx.launch("runner", { path: target });
                break;
              }

              case "edit": {
                if (!arg) throw new Error("usage: edit <file>");
                const target = abs(arg);
                if (!ctx.fs.exists(target)) throw new Error(`no such file: ${arg}`);
                ctx.launch("editor", { path: target });
                break;
              }

              case "launch": {
                if (!arg) throw new Error("usage: launch <path>");
                ctx.openPath(abs(arg));
                break;
              }

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
                  .filter(
                    (d) => !q || `${d.key} ${d.label} ${d.group}`.toLowerCase().includes(q)
                  );
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
                // Upstream routes the sky through the settings registry, so the
                // Settings app and this command stay in agreement.
                ctx.state.set("appearance.intensity", Math.max(0, Math.min(1.5, v)));
                out(`sky intensity → ${v}`, "muted");
                break;
              }

              case "echo":
                out(arg);
                break;

              case "clear":
                log.innerHTML = "";
                break;

              case "app": {
                // Explicit escape hatch: some servers buffer their startup
                // banner, so auto-detection can't be the only way in.
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
                // Not a builtin — hand it to the machine. Real shells resolve
                // builtins first and fall through to $PATH; same idea, except
                // "$PATH" here is the dev server on the other end of the bridge.
                // Pass the raw text so the host's own shell does the quoting.
                hostExec(trimmedRaw, cwd, hostPrint, (port, jobId) =>
                  ctx.launch("webapp", { path: String(port), jobId })
                );
                return true;
            }

            if (redirect) {
              ctx.fs.write(abs(redirect), captured.join("\n"));
              print(`wrote ${captured.length} line(s) → ${redirect}`, "muted");
            }
            return true;
          } catch (err) {
            print(err instanceof Error ? err.message : String(err), "warn");
            return false;
          }
        };

        input.addEventListener("keydown", (e) => {
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
          const value = input.value;
          print(`${cwd.replace("/home/void", "~")} › ${value}`, "echoed");
          if (value.trim()) {
            history.push(value);
            histIndex = history.length;
          }
          run(value);
          input.value = "";
        });

        return () => root.replaceChildren();
      },
    });
  },
};

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
