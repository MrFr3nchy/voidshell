import type { KernelContext, VoidModule } from "../../kernel/types";

/**
 * A system console. It has no special powers — it only calls the same
 * KernelContext every module gets. That's the point: the terminal is not
 * privileged, it's just honest about what the syscall surface can do.
 */
export const terminal: VoidModule = {
  manifest: {
    id: "terminal",
    name: "Console",
    kind: "app",
    glyph: "▚",
    version: "0.1.0",
  },

  activate() {},

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "console",
      width: 460,
      height: 320,
      render: (root) => {
        root.innerHTML = "";
        const log = document.createElement("div");
        log.className = "term-log";
        const line = document.createElement("div");
        line.className = "term-line";
        const prompt = document.createElement("span");
        prompt.className = "term-prompt";
        prompt.textContent = "void ›";
        const input = document.createElement("input");
        input.className = "term-input";
        input.setAttribute("aria-label", "console input");
        input.autofocus = true;
        line.append(prompt, input);
        root.append(log, line);

        const print = (text: string, cls = "") => {
          const el = document.createElement("div");
          el.className = `term-out ${cls}`;
          el.textContent = text;
          log.appendChild(el);
          log.scrollTop = log.scrollHeight;
        };

        print("voidshell console. type `help`.", "muted");

        const run = (raw: string) => {
          const [cmd, ...rest] = raw.trim().split(/\s+/);
          const arg = rest.join(" ");
          switch (cmd) {
            case "":
              break;
            case "help":
              print("help  ls  open <id>  sky <0..1>  echo <text>  clear");
              break;
            case "ls":
            case "apps":
              for (const m of ctx.registry()) print(`${m.glyph ?? "·"}  ${m.id}  —  ${m.name}`);
              break;
            case "open":
              if (!arg) print("usage: open <module-id>", "warn");
              else ctx.launch(arg);
              break;
            case "sky": {
              const v = Number(arg);
              if (Number.isFinite(v)) {
                ctx.patchWorld({ intensity: Math.max(0, Math.min(1.5, v)) });
                print(`sky intensity → ${v}`, "muted");
              } else print("usage: sky <number>", "warn");
              break;
            }
            case "echo":
              print(arg);
              break;
            case "clear":
              log.innerHTML = "";
              break;
            default:
              print(`unknown: ${cmd}`, "warn");
          }
        };

        input.addEventListener("keydown", (e) => {
          if (e.key !== "Enter") return;
          print(`void › ${input.value}`, "echoed");
          run(input.value);
          input.value = "";
        });

        return () => root.replaceChildren();
      },
    });
  },
};
