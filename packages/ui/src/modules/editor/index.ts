import type { KernelContext, LaunchArgs, VoidModule } from "../../kernel/types";
import { basename } from "../../kernel/vfs";
import { tildify } from "../../kernel/fsutil";
import { extensionOf } from "../../kernel/filetypes";
import { createProgram, isRunnable, type Program } from "../../runtime/program";
import { renderMarkdown } from "./markdown";
import { openStartPane, rememberRecent } from "./start";
import {
  RELOAD_REQUEST,
  RELOAD_RESULT,
  isModulePath,
  type ReloadRequest,
  type ReloadResult,
} from "../devkit/protocol";
import { TYPES_ARE_NOT_CHECKED, needsTransform } from "../../runtime/transformProtocol";

/**
 * The editor, and the place code actually runs.
 *
 * It declares the extensions it handles, so the kernel routes double-clicks
 * here and hands the path to `launch(ctx, args)` like argv. For anything
 * runnable (.py/.js) it grows a second pane: write, hit Run, watch the output
 * without ever leaving the window. The program executes off the buffer, not the
 * last saved copy, so there's no save-then-run dance.
 *
 * Read-only files (anything under /projects) open as a viewer — same window,
 * no save button, rather than a save that would fail with EROFS. They can still
 * be run: reading is allowed, it's only writing that isn't.
 *
 * Launched with no file it used to be a rectangle reading "No file.", which is
 * an app that exists in the launcher and does nothing when you use it from
 * there. It now opens on what you were last working on: recent files, the
 * documents in your home directory, and a way to make a new one.
 */

/** Tab inserts this much, matching the repo's own style. */
const INDENT = "  ";

/**
 * How long to wait for devkit before giving up on a reload.
 *
 * There has to be a limit, because the request goes out on the bus and nothing
 * guarantees anybody is listening — devkit can be uninstalled, or the event can
 * arrive before it has activated. Silence would otherwise leave the button
 * saying "loading" forever, which reads as a hang in the loader rather than as
 * an answer that never came.
 */
const RELOAD_TIMEOUT = 5000;

export const editor: VoidModule = {
  manifest: {
    id: "editor",
    name: "Editor",
    kind: "app",
    glyph: "✎",
    blurb: "write and run code",
    singleton: false,
    version: "0.3.0",
  },

  // Text it knows by name, plus `fallback` for unclaimed text types. The old
  // `"*"` also claimed PNGs and ZIPs, which meant "open with the editor" was
  // offered for files it can only render as replacement characters.
  handles: ["md", "markdown", "txt", "text", "log", "json", "jsonc", "ts", "tsx",
            "js", "jsx", "mjs", "cjs", "css", "scss", "html", "htm", "svg", "xml",
            "py", "rs", "go", "c", "h", "cc", "cpp", "sh", "bash", "toml", "ini",
            "conf", "yml", "yaml", "env", "csv", "sql", "gd", "qml"],
  fallback: true,

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "editor.new",
      label: "New file",
      hint: "in your home directory",
      glyph: "✎",
      run: (c) => c.launch("editor", { new: true }),
    });
  },

  launch(ctx: KernelContext, args?: LaunchArgs) {
    const path = args?.path;
    const autoRun = args?.run === true;
    if (path) rememberRecent(ctx, path);

    // Assigned right after openSurface returns. Every use is inside an event
    // handler, so it is always set by the time it is read — render() itself
    // runs before the kernel has registered the surface, and a rename there
    // would have nothing to rename.
    let sid = "";

    const surface = ctx.openSurface({
      title: path ? basename(path) : "editor",
      width: 640,
      height: 460,
      render: (root) => {
        root.innerHTML = "";
        root.className = "ed-root";

        // No argument means "I want to write something", not "show me an
        // error". The start pane answers that with the files you had open
        // last, what is in your home directory, and a new-file line.
        if (!path) {
          return openStartPane(root, ctx, {
            open: (p) => ctx.launch("editor", { path: p }),
            newFile: args?.new === true,
          });
        }

        let text = "";
        let readonly = true;
        let error = "";
        try {
          text = ctx.fs.read(path);
          readonly = ctx.fs.stat(path).readonly;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }

        const head = document.createElement("div");
        head.className = "ed-head";
        const title = document.createElement("span");
        title.className = "ed-title";
        // `~/notes/x.md` rather than `/home/void/notes/x.md`: the prefix is the
        // same for every file you own and tells you nothing.
        title.textContent = tildify(path);
        title.title = path;
        head.appendChild(title);
        root.appendChild(head);

        if (error) {
          const e = document.createElement("div");
          e.className = "ed-empty warn";
          e.textContent = error;
          root.append(e);
          return () => root.replaceChildren();
        }

        // A writable file under ~/modules is a module, and its verb is Reload,
        // not Run. Running one through the JS sandbox evaluates an object
        // literal and prints nothing, so the run pane it would otherwise get is
        // structurally incapable of ever showing output — which is a worse
        // answer to "what does this button do" than not offering the button.
        const isModule = !readonly && isModulePath(path);
        const runnable = isRunnable(path) && !isModule;

        /* ---------------- the buffer ---------------- */

        // Read-only files get a <pre>; writable ones a textarea with gutter.
        const wrap = document.createElement("div");
        wrap.className = "ed-wrap";

        const gutter = document.createElement("div");
        gutter.className = "ed-gutter";

        let ta: HTMLTextAreaElement | null = null;
        let pre: HTMLPreElement | null = null;
        /** Whatever is currently on screen, saved or not. */
        const buffer = () => ta?.value ?? text;

        if (readonly) {
          const badge = document.createElement("span");
          badge.className = "ed-badge";
          badge.textContent = "read-only";
          head.appendChild(badge);

          pre = document.createElement("pre");
          const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
          const prose = ext === "md" || ext === "txt";
          pre.className = `ed-pre${prose ? " wrap" : ""}`;
          pre.textContent = text;
          wrap.append(gutter, pre);
        } else {
          ta = document.createElement("textarea");
          ta.className = "ed-area";
          ta.value = text;
          ta.spellcheck = false;
          ta.wrap = "off";
          wrap.append(gutter, ta);
        }

        // Typed as HTMLElement, not the union: a textarea|pre union loses the
        // event map, and every keydown handler below would see a bare Event.
        const scroller: HTMLElement = ta ?? pre!;

        /** Line numbers, re-rendered only when the count actually changes. */
        let lineCount = -1;
        const renderGutter = () => {
          const n = buffer().split("\n").length;
          if (n === lineCount) return;
          lineCount = n;
          gutter.replaceChildren();
          for (let i = 1; i <= n; i++) {
            const d = document.createElement("div");
            d.textContent = String(i);
            gutter.appendChild(d);
          }
        };
        // The gutter is a separate element, so it has to track the buffer's
        // scroll or the numbers drift out of alignment with the text.
        scroller.addEventListener("scroll", () => {
          gutter.scrollTop = scroller.scrollTop;
        });

        /* ---------------- status bar ---------------- */

        const bar = document.createElement("div");
        bar.className = "ed-bar";
        const status = document.createElement("span");
        status.className = "ed-status";
        const hint = document.createElement("span");
        hint.className = "ed-hint";
        hint.textContent = readonly
          ? runnable
            ? "^⏎ run"
            : ""
          : isModule
            ? // Compiling a .ts module and loading it looks exactly like having
              // checked it. Say which one actually happened.
              needsTransform(path)
              ? `^S save · ^⏎ reload · ${TYPES_ARE_NOT_CHECKED}`
              : "^S save · ^⏎ reload"
            : runnable
              ? "^S save · ^⏎ run"
              : "^S save";

        const runBtn = document.createElement("button");
        runBtn.className = "fm-btn";
        runBtn.textContent = "run";
        const stopBtn = document.createElement("button");
        stopBtn.className = "fm-btn";
        stopBtn.textContent = "stop";
        stopBtn.disabled = true;
        const saveBtn = document.createElement("button");
        saveBtn.className = "fm-btn";
        saveBtn.textContent = "save";
        const reloadBtn = document.createElement("button");
        reloadBtn.className = "fm-btn";
        reloadBtn.textContent = "reload";
        reloadBtn.title = needsTransform(path)
          ? `save, compile, and install this module into the running shell — ${TYPES_ARE_NOT_CHECKED}`
          : "save, then install this module into the running shell";

        /** Where a failed load gets reported, against the line when we have one. */
        const modErr = document.createElement("div");
        modErr.className = "ed-moderr";
        modErr.hidden = true;

        /* ---------------- markdown preview ---------------- */

        // Markdown is the format the shell writes by default — the welcome
        // file, the desktop readme, every note — and until now the only way to
        // see one rendered was to not have written it in Markdown.
        const isMarkdown = extensionOf(path) === "md" || extensionOf(path) === "markdown";
        const preview = document.createElement("div");
        preview.className = "ed-preview";
        const previewBtn = document.createElement("button");
        previewBtn.className = "fm-btn";
        previewBtn.textContent = "preview";

        let previewing = false;
        const paintPreview = () => {
          preview.replaceChildren(renderMarkdown(buffer()));
        };
        const setPreview = (on: boolean) => {
          previewing = on;
          previewBtn.classList.toggle("on", on);
          wrap.classList.toggle("hidden", on);
          preview.classList.toggle("shown", on);
          if (on) paintPreview();
        };
        previewBtn.addEventListener("click", () => setPreview(!previewing));

        bar.append(status, hint);
        if (isMarkdown) bar.append(previewBtn);
        if (runnable) bar.append(stopBtn, runBtn);
        if (isModule) bar.append(reloadBtn);
        if (!readonly) bar.append(saveBtn);

        /* ---------------- the run pane ---------------- */

        const out = document.createElement("div");
        out.className = "ed-out";
        const outLog = document.createElement("div");
        outLog.className = "run-log";
        const inputRow = document.createElement("div");
        inputRow.className = "run-input-row";
        const inputPrompt = document.createElement("span");
        inputPrompt.className = "run-input-prompt";
        inputPrompt.textContent = "›";
        const stdin = document.createElement("input");
        stdin.className = "run-input";
        stdin.placeholder = "stdin — the program is not waiting for input";
        stdin.disabled = true;
        inputRow.append(inputPrompt, stdin);
        out.append(outLog, inputRow);

        root.append(wrap, preview, bar);
        if (runnable) root.append(out);
        if (isModule) root.append(modErr);

        // A read-only .md is almost always something you want to read rather
        // than audit the source of — /projects READMEs, the welcome file.
        if (isMarkdown && readonly) setPreview(true);

        const print = (kind: string, line: string) => {
          const el = document.createElement("div");
          el.className = `run-line ${kind}`;
          el.textContent = line;
          outLog.appendChild(el);
          outLog.scrollTop = outLog.scrollHeight;
        };

        let program: Program | null = null;
        if (runnable) {
          program = createProgram(ctx, path, {
            print,
            onState: (running) => {
              runBtn.disabled = running;
              stopBtn.disabled = !running;
              status.textContent = running ? "running" : "";
              if (!running) {
                stdin.disabled = true;
                stdin.placeholder = "stdin — the program is not waiting for input";
              }
            },
            onStdin: (waiting) => {
              stdin.disabled = !waiting;
              stdin.placeholder = waiting
                ? ""
                : "stdin — the program is not waiting for input";
              if (waiting) stdin.focus();
            },
          });
        }

        /* ---------------- actions ---------------- */

        const doSave = (): boolean => {
          if (readonly || !ta) return false;
          try {
            ctx.fs.write(path, ta.value);
            status.textContent = "saved";
            markDirty(false);
            setTimeout(() => {
              if (status.textContent === "saved") status.textContent = "";
            }, 1400);
            return true;
          } catch (err) {
            status.textContent = err instanceof Error ? err.message : String(err);
            return false;
          }
        };

        // Run the buffer, not the file on disk — running what you're looking at
        // is the whole point of putting the two panes in one window. Save first
        // when we can, so the file and the run agree afterwards.
        const doRun = () => {
          if (!program) return;
          if (!readonly) doSave();
          outLog.replaceChildren();
          program.start(buffer());
        };

        /* ---------------- reloading a module ---------------- */

        // The editor does not install anything. `install` isn't on
        // KernelContext on purpose — devkit holds it, handed over by main.ts —
        // so this asks devkit over the bus and waits for its answer, which is
        // the same way every other pair of modules talks.

        // Marks are found by class rather than by remembered index, because
        // renderGutter throws its children away whenever the line count
        // changes and a remembered index would then point at a stranger.
        const clearMark = () => {
          for (const el of gutter.querySelectorAll(".is-bad")) el.classList.remove("is-bad");
        };

        /** Put the caret on a line, and get it on screen. */
        const goToLine = (line: number, column: number) => {
          const lines = buffer().split("\n");
          gutter.children[line - 1]?.classList.add("is-bad");
          if (!ta) return;
          let offset = 0;
          for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
          offset += Math.min(Math.max(0, column - 1), lines[line - 1]?.length ?? 0);
          ta.focus();
          ta.setSelectionRange(offset, offset);
          // Setting a selection doesn't scroll to it in every engine, so put the
          // line roughly mid-pane ourselves.
          const perLine = scroller.scrollHeight / Math.max(1, lines.length);
          scroller.scrollTop = Math.max(0, (line - 1) * perLine - scroller.clientHeight / 2);
          gutter.scrollTop = scroller.scrollTop;
        };

        const showLoadError = (message: string, line?: number, column?: number) => {
          // The location is genuinely often unknown — V8 gives a parse error no
          // stack worth reading — so the message has to stand on its own.
          modErr.textContent = line ? `line ${line}: ${message}` : message;
          modErr.hidden = false;
          if (line) goToLine(line, column ?? 1);
        };

        /** The nonce we are currently waiting on, or "" if we are not. */
        let awaiting = "";

        const doReload = () => {
          if (!isModule) return;
          // Reload reads the file, so an unsaved buffer would install the
          // previous version and report success for code that isn't running.
          if (!doSave()) return;
          clearMark();
          modErr.hidden = true;
          status.textContent = "loading";
          const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          awaiting = nonce;
          ctx.emit(RELOAD_REQUEST, { path, nonce } satisfies ReloadRequest);
          setTimeout(() => {
            if (awaiting !== nonce) return;
            awaiting = "";
            status.textContent = "";
            showLoadError("devkit did not answer — is it still installed?");
          }, RELOAD_TIMEOUT);
        };

        const offResult = ctx.on(RELOAD_RESULT, (e) => {
          const res = e.payload as Partial<ReloadResult> | undefined;
          if (!res || !awaiting || res.nonce !== awaiting) return;
          awaiting = "";
          if (res.ok) {
            modErr.hidden = true;
            clearMark();
            status.textContent = `loaded ${res.id ?? ""}`.trim();
            setTimeout(() => {
              if (status.textContent?.startsWith("loaded")) status.textContent = "";
            }, 1800);
            return;
          }
          status.textContent = "failed";
          showLoadError(res.error ?? "the module did not load", res.line, res.column);
        });

        runBtn.addEventListener("click", doRun);
        stopBtn.addEventListener("click", () => program?.stop());
        saveBtn.addEventListener("click", doSave);
        reloadBtn.addEventListener("click", doReload);

        stdin.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key !== "Enter") return;
          const line = stdin.value;
          print("echoed", `› ${line}`);
          stdin.value = "";
          program?.send(line);
        });

        // The window title carries the dirty state too. The status line is
        // inside the window, which is no use at all once the window is one of
        // six floating in the void.
        const markDirty = (dirty: boolean) => {
          if (!path) return;
          ctx.setTitle(sid, dirty ? `\u2022 ${basename(path)}` : basename(path));
        };

        if (ta) {
          ta.addEventListener("input", () => {
            status.textContent = "modified";
            markDirty(true);
            renderGutter();
            if (previewing) paintPreview();
          });
        }

        scroller.addEventListener("keydown", (e) => {
          const mod = e.ctrlKey || e.metaKey;

          if (mod && e.key === "Enter") {
            e.preventDefault();
            if (isModule) doReload();
            else doRun();
            return;
          }
          if (mod && e.key.toLowerCase() === "s") {
            e.preventDefault();
            doSave();
            return;
          }
          if (mod && isMarkdown && e.key.toLowerCase() === "p") {
            e.preventDefault();
            setPreview(!previewing);
            return;
          }
          // Tab indents instead of escaping to the next control. An editor that
          // can't type a tab isn't an editor.
          if (e.key === "Tab" && ta) {
            e.preventDefault();
            const { selectionStart: s, selectionEnd: t } = ta;
            ta.value = ta.value.slice(0, s) + INDENT + ta.value.slice(t);
            ta.selectionStart = ta.selectionEnd = s + INDENT.length;
            status.textContent = "modified";
            markDirty(true);
            return;
          }
          // Keep typing out of the shell's global keybinds (space summons the
          // launcher, Escape closes overlays).
          e.stopPropagation();
        });

        renderGutter();
        if (autoRun && runnable) requestAnimationFrame(doRun);
        requestAnimationFrame(() => (ta ?? scroller).focus());

        return () => {
          offResult();
          program?.dispose();
          root.replaceChildren();
        };
      },
    });

    sid = surface.id;
  },
};
