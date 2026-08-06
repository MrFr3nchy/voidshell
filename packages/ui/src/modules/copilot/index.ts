import Anthropic from "@anthropic-ai/sdk";
import type { KernelContext, VoidModule } from "../../kernel/types";
import { createToolbox, TOOL_SPECS, type ConfirmRequest } from "./tools";

/**
 * An assistant, in a window, beside the editor.
 *
 * **Its own module rather than a pane of the editor.** The editor is already a
 * buffer, a gutter, a runner, a Markdown preview and a module loader; a sixth
 * job would not have made it clearer. More to the point, windows are this
 * system's composition primitive — putting the assistant in its own surface is
 * what lets you sit it next to the editor, next to devkit, or next to nothing,
 * and close it without losing your place. It also keeps `tools.ts` — the part
 * that actually matters — in a file with no opinion about textareas.
 *
 * **The key is the user's and lives in their workspace state.** That is a real
 * tradeoff and it is stated in the UI rather than buried here: the request goes
 * from the tab straight to api.anthropic.com, so the key is in the page, and
 * unless "remember" is off it is persisted with the rest of the workspace. A
 * server-side key would be an API-package change with its own auth design.
 */

const KEY_PERSISTED = "copilot.apiKey";
/** The same key, in the namespace the Store never writes to disk. */
const KEY_SESSION = "tmp.copilot.apiKey";
const REMEMBER_KEY = "copilot.rememberKey";
const MODEL = "claude-opus-5";

/**
 * Generous, because the model is expected to think and to make several tool
 * calls in a turn. Streaming means this is not a timeout risk.
 */
const MAX_TOKENS = 16000;

const SYSTEM = `You are the assistant built into voidshell, a spatial WebOS the user is developing from inside itself. You are running in a window, in their browser, with tools that reach the real filesystem and the real running kernel.

Modules are how everything in voidshell works. A module is one file exporting a default object:

  export default {
    manifest: { id: "thing", name: "thing", kind: "app", glyph: "◇" },
    activate(ctx) { /* runs on install; return a cleanup function */ },
    launch(ctx) { ctx.openSurface({ title: "thing", render: (root, c) => { … } }); },
  };

Rules that are not negotiable, because the loader enforces them:
- Import nothing. No bare specifiers resolve. Everything arrives through \`ctx\`.
- \`export default\`. Named exports are ignored.
- A module with kind "app" must have \`launch\`, or the loader refuses it.
- Modules live in ~/modules and may be .js or .ts. TypeScript is compiled in the browser — types are stripped, NOT checked, so a wrong annotation compiles fine and fails later.
- \`render\` fills a plain DOM element and may return a cleanup function.

Working style:
- Read before you write. Use list_directory and read_file rather than assuming what is on disk.
- Write the file, say briefly what it does, then offer to load it. load_module always asks the user first — that is deliberate, not an obstacle, because loading runs the code with full kernel access.
- If a load fails, call last_build_error or read the message you got back, fix the file, and try again.
- Be concise. The window is small and the user is reading it beside their editor.`;

interface Turn {
  role: "user" | "assistant";
  content: Anthropic.MessageParam["content"];
}

export const copilot: VoidModule = {
  manifest: {
    id: "copilot",
    name: "copilot",
    kind: "app",
    glyph: "✳",
    blurb: "an assistant that can write and load modules",
    singleton: false,
  },

  activate(ctx: KernelContext) {
    ctx.defineCommand({
      id: "copilot.open",
      label: "copilot: ask the assistant",
      glyph: "✳",
      run: (c) => c.launch("copilot"),
    });

    ctx.defineSetting({
      key: REMEMBER_KEY,
      label: "Remember my Anthropic API key",
      kind: "toggle",
      group: "System",
      hint: "Off keeps it in memory only — it is re-entered each session, and never written to the server",
      default: true,
      order: 62,
    });

    ctx.defineSetting({
      key: "copilot.forget",
      label: "Forget the stored API key",
      kind: "action",
      group: "System",
      hint: "Clears it from this workspace immediately",
      order: 63,
      run: (c) => {
        c.state.set(KEY_PERSISTED, "");
        c.state.set(KEY_SESSION, "");
        c.notify("copilot: API key cleared", "good");
      },
    });
  },

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "copilot",
      width: 460,
      height: 560,
      render: (root, c) => {
        root.classList.add("cp-root");

        const log = document.createElement("div");
        log.className = "cp-log";

        const form = document.createElement("form");
        form.className = "cp-form";
        const input = document.createElement("textarea");
        input.className = "cp-input";
        input.rows = 2;
        input.placeholder = "ask for a module, or a change to one…";
        const send = document.createElement("button");
        send.className = "fm-btn";
        send.type = "submit";
        send.textContent = "send";
        form.append(input, send);

        root.append(log, form);

        /* ---------------- transcript rendering ---------------- */

        const scroll = () => (log.scrollTop = log.scrollHeight);

        const bubble = (kind: string, text = ""): HTMLElement => {
          const el = document.createElement("div");
          el.className = `cp-msg cp-${kind}`;
          el.textContent = text;
          log.append(el);
          scroll();
          return el;
        };

        const note = (text: string) => bubble("note", text);

        /* ---------------- the key ---------------- */

        const readKey = (): string =>
          c.state.get<string>(KEY_PERSISTED, "") || c.state.get<string>(KEY_SESSION, "");

        const askForKey = () => {
          const panel = document.createElement("div");
          panel.className = "cp-keyask";
          const label = document.createElement("div");
          label.className = "cp-note";
          label.textContent =
            "Paste an Anthropic API key. Requests go from this tab straight to " +
            "api.anthropic.com, so the key lives in the page. With “remember” on " +
            "it is saved into your workspace state on the server; with it off it " +
            "stays in memory and you re-enter it next session.";
          const row = document.createElement("div");
          row.className = "cp-keyrow";
          const field = document.createElement("input");
          field.type = "password";
          field.className = "cp-key";
          field.placeholder = "sk-ant-…";
          const save = document.createElement("button");
          save.className = "fm-btn";
          save.type = "button";
          save.textContent = "use key";
          row.append(field, save);

          const remember = document.createElement("label");
          remember.className = "cp-remember";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = c.state.get<boolean>(REMEMBER_KEY, true);
          remember.append(box, document.createTextNode(" remember it in my workspace"));

          save.addEventListener("click", () => {
            const value = field.value.trim();
            if (!value) return;
            c.state.set(REMEMBER_KEY, box.checked);
            c.state.set(box.checked ? KEY_PERSISTED : KEY_SESSION, value);
            if (!box.checked) c.state.set(KEY_PERSISTED, "");
            panel.remove();
            note("key set — ask away");
            input.focus();
          });

          panel.append(label, row, remember);
          log.append(panel);
          scroll();
        };

        /* ---------------- approval ---------------- */

        /**
         * Render a confirmation and block the tool on the answer.
         *
         * The promise is what makes the gate real: `run()` awaits it, so the
         * conversation genuinely stops here until somebody clicks — nothing
         * runs optimistically and gets undone.
         */
        const confirm = (request: ConfirmRequest): Promise<boolean> =>
          new Promise((resolve) => {
            const panel = document.createElement("div");
            panel.className = "cp-confirm";

            const head = document.createElement("div");
            head.className = "cp-confirm-head";
            head.textContent = request.summary;
            panel.append(head);

            if (request.detail) {
              const pre = document.createElement("pre");
              pre.className = "cp-confirm-detail";
              pre.textContent = request.detail;
              panel.append(pre);
            }

            const row = document.createElement("div");
            row.className = "cp-confirm-row";
            const decide = (allowed: boolean) => {
              panel.replaceChildren();
              panel.className = "cp-msg cp-note";
              panel.textContent = allowed
                ? `allowed: ${request.tool}`
                : `declined: ${request.tool}`;
              resolve(allowed);
            };
            const allow = document.createElement("button");
            allow.className = "fm-btn cp-allow";
            allow.type = "button";
            allow.textContent = "allow";
            allow.addEventListener("click", () => decide(true));
            const deny = document.createElement("button");
            deny.className = "fm-btn";
            deny.type = "button";
            deny.textContent = "decline";
            deny.addEventListener("click", () => decide(false));
            row.append(deny, allow);

            panel.append(row);
            log.append(panel);
            scroll();
            allow.focus();
          });

        const toolbox = createToolbox(c, { confirm });

        /* ---------------- the conversation ---------------- */

        const history: Turn[] = [];
        let busy = false;

        const setBusy = (on: boolean) => {
          busy = on;
          send.disabled = on;
          send.textContent = on ? "…" : "send";
        };

        const ask = async (text: string) => {
          const key = readKey();
          if (!key) {
            askForKey();
            return;
          }

          bubble("user", text);
          history.push({ role: "user", content: text });
          setBusy(true);

          // `dangerouslyAllowBrowser` is the honest name for what this is. The
          // SDK adds the `anthropic-dangerous-direct-browser-access` header
          // itself when it is set, which is what makes the CORS request legal.
          const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });

          try {
            // The tool loop. Each pass streams one assistant turn; if that turn
            // asked for tools, run them, append the results, and go round again.
            // It ends when the model stops asking — which is what `end_turn`
            // means and why there is no iteration cap doing the job instead.
            for (;;) {
              const stream = client.messages.stream({
                model: MODEL,
                max_tokens: MAX_TOKENS,
                system: SYSTEM,
                tools: TOOL_SPECS.map(({ name, description, input_schema }) => ({
                  name,
                  description,
                  input_schema,
                })),
                messages: history as Anthropic.MessageParam[],
              });

              let live: HTMLElement | null = null;
              stream.on("text", (delta) => {
                if (!live) live = bubble("assistant");
                live.textContent += delta;
                scroll();
              });

              const message = await stream.finalMessage();
              history.push({ role: "assistant", content: message.content });

              const calls = message.content.filter(
                (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
              );
              if (!calls.length) break;

              // Every result goes back in ONE user message. Splitting them
              // across several teaches the model to stop calling tools in
              // parallel, which is a slow regression to notice.
              const results: Anthropic.ToolResultBlockParam[] = [];
              for (const call of calls) {
                bubble("tool", `${call.name}`);
                const outcome = await toolbox.run(
                  call.name,
                  (call.input ?? {}) as Record<string, unknown>
                );
                if (outcome.isError) bubble("toolerr", outcome.content);
                results.push({
                  type: "tool_result",
                  tool_use_id: call.id,
                  content: outcome.content,
                  is_error: outcome.isError,
                });
              }
              history.push({ role: "user", content: results });
            }
          } catch (err) {
            // Typed rather than string-matched, so an expired key reads as an
            // expired key instead of as "something went wrong".
            const message =
              err instanceof Anthropic.AuthenticationError
                ? "that key was rejected — check it and try again"
                : err instanceof Anthropic.RateLimitError
                  ? "rate limited — wait a moment and retry"
                  : err instanceof Error
                    ? err.message
                    : String(err);
            bubble("toolerr", message);
            c.log(`copilot: ${message}`, "error");
          } finally {
            setBusy(false);
            input.focus();
          }
        };

        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text || busy) return;
          input.value = "";
          void ask(text);
        });

        input.addEventListener("keydown", (e) => {
          // Enter sends, shift+Enter is a newline — and everything else is kept
          // away from the shell's global keybinds, or space would summon the
          // launcher mid-sentence.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            form.requestSubmit();
            return;
          }
          e.stopPropagation();
        });

        if (readKey()) {
          note("ask for a module and I'll write it to ~/modules. Loading it will ask first.");
        } else {
          askForKey();
        }

        requestAnimationFrame(() => input.focus());
        return () => root.replaceChildren();
      },
    });
  },
};
