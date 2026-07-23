import type { ArrangeMode, BodyKind, KernelContext, VoidModule } from "../../kernel/types";

const HELP = [
  "help                    this",
  "ls | apps               installed modules",
  "open <id>               launch a module",
  "wins                    open windows",
  "go <surface-id>         turn the void to face a window",
  "home                    recentre the view",
  "arrange <arc|wall|ring|scatter>",
  "link <id> <id> [...]    bind windows into a constellation",
  "groups                  live constellations",
  "unlink <group-id>       cut one loose",
  "spawn <sun|moon|planet|singularity>",
  "bodies                  what's in orbit",
  "merge <surface> <body>  ride an orbit",
  "set <key> <value>       write shared state",
  "get <key>               read shared state",
  "settings [filter]       every registered knob",
  "sky <0..1.5>            aurora intensity",
  "say <text>              raise a notification",
  "echo <text>             clear",
];

/**
 * A system console. It has no special powers — it only calls the same
 * KernelContext every module gets. That's the point: the terminal is not
 * privileged, it's just the most honest window onto what the syscall surface
 * can actually do. Every verb below maps one-to-one onto a public call.
 */
export const terminal: VoidModule = {
  manifest: {
    id: "terminal",
    name: "Console",
    kind: "app",
    glyph: "\u259a",
    blurb: "drive the kernel by hand",
    version: "0.2.0",
  },

  activate() {},

  launch(ctx: KernelContext) {
    ctx.openSurface({
      title: "console",
      width: 500,
      height: 340,
      render: (root) => {
        root.innerHTML = "";
        const log = document.createElement("div");
        log.className = "term-log";
        const line = document.createElement("div");
        line.className = "term-line";
        const prompt = document.createElement("span");
        prompt.className = "term-prompt";
        prompt.textContent = "void \u203a";
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

        const history: string[] = [];
        let cursor = -1;

        const run = (raw: string) => {
          const [cmd, ...rest] = raw.trim().split(/\s+/);
          const arg = rest.join(" ");
          switch (cmd) {
            case "":
              break;
            case "help":
              for (const h of HELP) print(h, "muted");
              break;
            case "ls":
            case "apps":
              for (const m of ctx.registry())
                print(`${m.glyph ?? "\u00b7"}  ${pad(m.id, 12)} ${pad(m.kind, 8)} ${m.name}`);
              break;
            case "wins":
              for (const s of ctx.openSurfaces())
                print(`${pad(s.id, 12)} ${pad(s.moduleId, 12)} ${s.title}`);
              break;
            case "open":
              if (!arg) print("usage: open <module-id>", "warn");
              else ctx.launch(arg);
              break;
            case "go":
              if (!arg) print("usage: go <surface-id>", "warn");
              else {
                ctx.focusSurface(arg);
                ctx.lookAt(arg);
              }
              break;
            case "home":
              ctx.resetView();
              break;
            case "arrange": {
              const modes: ArrangeMode[] = ["arc", "wall", "ring", "scatter"];
              const mode = modes.find((m) => m === arg);
              if (!mode) print(`usage: arrange <${modes.join("|")}>`, "warn");
              else ctx.arrange(mode);
              break;
            }
            case "link": {
              if (rest.length < 2) print("usage: link <id> <id> [...]", "warn");
              else {
                const id = ctx.linkSurfaces(rest);
                print(id ? `bound \u2192 ${id}` : "need two live windows", id ? "muted" : "warn");
              }
              break;
            }
            case "groups": {
              const groups = ctx.listGroups();
              if (!groups.length) print("nothing bound", "muted");
              for (const g of groups) print(`${pad(g.id, 10)} ${pad(g.name, 22)} ${g.members.join(" ")}`);
              break;
            }
            case "unlink":
              if (!arg) print("usage: unlink <group-id>", "warn");
              else ctx.unlinkGroup(arg);
              break;
            case "spawn": {
              const kinds: BodyKind[] = ["sun", "moon", "planet", "singularity"];
              const kind = kinds.find((k) => k === arg);
              if (!kind) print(`usage: spawn <${kinds.join("|")}>`, "warn");
              else print(`\u2192 ${ctx.spawnBody(kind)}`, "muted");
              break;
            }
            case "bodies": {
              const bodies = ctx.listBodies();
              if (!bodies.length) print("the sky is empty", "muted");
              for (const b of bodies) print(`${pad(b.id, 10)} ${b.kind}`);
              break;
            }
            case "merge":
              if (rest.length < 2) print("usage: merge <surface-id> <body-id>", "warn");
              else ctx.attachSurface(rest[0], rest[1]);
              break;
            case "set": {
              const [key, ...v] = rest;
              if (!key || !v.length) print("usage: set <key> <value>", "warn");
              else {
                ctx.state.set(key, coerce(v.join(" ")));
                print(`${key} \u2190 ${v.join(" ")}`, "muted");
              }
              break;
            }
            case "get":
              if (!arg) print("usage: get <key>", "warn");
              else print(`${arg} = ${JSON.stringify(ctx.state.get(arg, null))}`, "muted");
              break;
            case "settings": {
              const q = arg.toLowerCase();
              const defs = ctx
                .settings()
                .filter((d) => !q || `${d.key} ${d.label} ${d.group}`.toLowerCase().includes(q));
              if (!defs.length) print("no matching settings", "muted");
              for (const d of defs)
                print(`${pad(d.group, 12)} ${pad(d.key, 26)} ${JSON.stringify(ctx.state.get(d.key, d.default ?? null))}`);
              break;
            }
            case "sky": {
              const v = Number(arg);
              if (Number.isFinite(v)) {
                ctx.state.set("appearance.intensity", Math.max(0, Math.min(1.5, v)));
                print(`sky intensity \u2192 ${v}`, "muted");
              } else print("usage: sky <number>", "warn");
              break;
            }
            case "say":
              ctx.notify(arg || "\u2026");
              break;
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
          if (e.key === "ArrowUp") {
            e.preventDefault();
            if (!history.length) return;
            cursor = cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1);
            input.value = history[cursor];
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (cursor < 0) return;
            cursor = Math.min(history.length - 1, cursor + 1);
            input.value = history[cursor];
            return;
          }
          if (e.key !== "Enter") return;
          const raw = input.value;
          if (raw.trim()) history.push(raw);
          cursor = -1;
          print(`void \u203a ${raw}`, "echoed");
          run(raw);
          input.value = "";
        });

        // render() runs before the surface is mounted, so `autofocus` can miss.
        // Grab focus on the next frame, once the input is actually in the DOM.
        requestAnimationFrame(() => input.focus());

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
