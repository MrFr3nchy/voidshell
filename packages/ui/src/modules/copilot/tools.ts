import type { KernelContext } from "../../kernel/types";
import { normalize } from "../../kernel/vfs";
import {
  LAST_ERROR_KEY,
  MODULE_DIR,
  requestReload,
  type BuildFailure,
} from "../devkit/protocol";

/**
 * What the assistant is allowed to do, and what it has to ask about first.
 *
 * This file is the security boundary. The chat plumbing next door is
 * replaceable; this is not, because a model with a tool surface is exactly as
 * dangerous as the surface allows and no more.
 *
 * Three rules, in the order they matter:
 *
 * 1. **Some things are absent, not gated.** There is no delete, no move, no
 *    uninstall, no "run this command". A confirmation dialog is a thing people
 *    click through; the only reliable way to not delete somebody's home
 *    directory is to have no tool that can. `ctx` can do all of it — the
 *    assistant just never gets offered the verb.
 *
 * 2. **Writing is inert; loading is execution.** A file on disk does nothing.
 *    A loaded module receives the full `KernelContext` — it can close windows,
 *    read and delete anything under /home/void, and make network calls. That
 *    is the real line, so `write_file` inside the module directory is
 *    automatic and `load_module` always asks. The button press is the moment a
 *    human takes responsibility for running the code.
 *
 * 3. **Writes are confined to /home/void.** Not decoration: `/etc/autostart`
 *    is a writable file that decides what launches at boot, so an unconfined
 *    write tool plus a module the user never approved is persistence. Reads
 *    are unconfined — it is all the user's own machine, and the store the API
 *    key lives in is not on the filesystem.
 */

/** The only directory the assistant may write to without being asked. */
export const HOME = "/home/void";

export type Approval = "auto" | "ask";

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** What the user is shown before a gated tool runs. */
export interface ConfirmRequest {
  tool: string;
  /** One line, in the user's terms, describing what is about to happen. */
  summary: string;
  /** The payload itself, when seeing it is the point (file contents). */
  detail?: string;
}

export interface ToolboxDeps {
  /** Resolve true to let it through. Denial is reported to the model, not thrown. */
  confirm(request: ConfirmRequest): Promise<boolean>;
}

export interface ToolOutcome {
  content: string;
  /** Sent back as `is_error`, so the model can correct itself rather than stall. */
  isError: boolean;
}

/**
 * Descriptions are prescriptive about *when* to call, not just what the tool
 * does — that is the single biggest lever on whether a tool gets used at the
 * right moment, and it costs nothing but care in the wording.
 */
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_directory",
    description:
      "List the files and directories at a path in the voidshell filesystem. " +
      "Call this before writing a file, to see what is already there — and " +
      "before assuming a path exists. `/home/void` (also written `~`) is the " +
      "user's home; `~/modules` holds runtime-loadable modules; `/projects` is " +
      "a read-only mount of real source code.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path, e.g. /home/void/modules" },
      },
      required: ["path"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a text file. Call this whenever the answer depends on what a file " +
      "actually contains — before editing it, before explaining it, and before " +
      "claiming anything about code you have not looked at. Reading is " +
      "unrestricted: source under /projects, logs under /var/log, and generated " +
      "files under /proc are all readable.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to a file" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a text file, and create any missing parent " +
      "directories. Writes are confined to /home/void. Writing under " +
      "`~/modules` happens immediately; writing anywhere else in the home " +
      "directory asks the user first, so prefer `~/modules` for module work. " +
      "This only puts the file on disk — it does NOT load or run it. Call " +
      "`load_module` afterwards if the user wants it running.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path under /home/void, e.g. /home/void/modules/clock.ts",
        },
        content: { type: "string", description: "The complete new contents of the file" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "load_module",
    description:
      "Compile and install a module from `~/modules` into the running shell, " +
      "so it appears in the launcher and can be opened. `.ts` is compiled " +
      "automatically; types are stripped, not checked. This ALWAYS asks the " +
      "user for permission first, because a loaded module receives the full " +
      "kernel context and runs immediately — write the file, explain what it " +
      "does, then offer to load it. If it fails, the error comes back with the " +
      "line number; fix the file and call this again.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to a file under /home/void/modules" },
      },
      required: ["path"],
    },
  },
  {
    name: "read_system_log",
    description:
      "Read the tail of /var/log/system.log — every module's log lines, " +
      "newest last. Call this when something did not behave as expected and " +
      "you need to see what the system recorded, rather than guessing.",
    input_schema: {
      type: "object",
      properties: {
        lines: {
          type: "integer",
          description: "How many trailing lines to return (default 80, max 400)",
        },
      },
    },
  },
  {
    name: "last_build_error",
    description:
      "Get the most recent module compile or load failure — the file, the " +
      "message, and the line and column when the runtime gave us one. Call " +
      "this first when the user says a module 'failed' or 'won't load' without " +
      "pasting the error.",
    input_schema: { type: "object", properties: {} },
  },
];

/**
 * Whether this specific call needs a human first.
 *
 * Takes the input, not just the name, because the answer genuinely depends on
 * it: writing to the module directory is the assistant doing its job, and
 * writing to `~/.config` is something the user should see coming.
 */
export function approvalFor(name: string, input: Record<string, unknown>): Approval {
  if (name === "load_module") return "ask";
  if (name === "write_file") {
    const path = typeof input.path === "string" ? normalize(input.path) : "";
    return path.startsWith(`${MODULE_DIR}/`) ? "auto" : "ask";
  }
  return "auto";
}

const ok = (content: string): ToolOutcome => ({ content, isError: false });
const bad = (content: string): ToolOutcome => ({ content, isError: true });

/** A required string argument, or a sentence explaining what was wrong with it. */
function str(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required and must be a non-empty string`);
  }
  return value;
}

/**
 * Resolve a path the model supplied, for writing.
 *
 * `normalize` collapses `..` before the check, so `/home/void/../etc/autostart`
 * is rejected rather than quietly escaping — checking the raw string instead of
 * the resolved one is the classic way this goes wrong.
 */
function writable(raw: string): string {
  const path = normalize(raw);
  if (path !== HOME && !path.startsWith(`${HOME}/`)) {
    throw new Error(
      `refusing to write outside ${HOME} (resolved "${raw}" to "${path}"). ` +
        `Only the user's home directory is writable.`
    );
  }
  return path;
}

export function createToolbox(ctx: KernelContext, deps: ToolboxDeps) {
  const handlers: Record<string, (input: Record<string, unknown>) => Promise<ToolOutcome>> = {
    async list_directory(input) {
      const path = normalize(str(input, "path"));
      const entries = ctx.fs.ls(path);
      if (!entries.length) return ok(`${path} is empty`);
      const rows = entries.map(
        (e) => `${e.kind === "dir" ? "d" : "-"} ${String(e.size).padStart(7)}  ${e.name}`
      );
      return ok([`${path}:`, ...rows].join("\n"));
    },

    async read_file(input) {
      const path = normalize(str(input, "path"));
      return ok(ctx.fs.read(path));
    },

    async write_file(input) {
      const path = writable(str(input, "path"));
      const content = input.content;
      if (typeof content !== "string") {
        throw new Error("content is required and must be a string");
      }
      const existed = ctx.fs.exists(path);
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir) ctx.fs.mkdirp(dir);
      ctx.fs.write(path, content);
      return ok(`${existed ? "overwrote" : "created"} ${path} (${content.length} bytes)`);
    },

    async load_module(input) {
      const path = normalize(str(input, "path"));
      const result = await requestReload(ctx, path);
      if (result.ok) {
        return ok(
          `loaded "${result.id}" from ${path}. It is installed and appears in the launcher.`
        );
      }
      const where = result.line ? ` at line ${result.line}` : "";
      return bad(`${path} failed to load${where}: ${result.error ?? "unknown error"}`);
    },

    async read_system_log(input) {
      const asked = Number(input.lines);
      const want = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 400) : 80;
      const text = ctx.fs.read("/var/log/system.log");
      const lines = text.split("\n").filter(Boolean);
      return ok(lines.slice(-want).join("\n") || "the log is empty");
    },

    async last_build_error() {
      const failure = ctx.state.get<BuildFailure | null>(LAST_ERROR_KEY, null);
      if (!failure) return ok("no module has failed to load this session");
      const where = failure.line
        ? ` (line ${failure.line}${failure.column ? `, column ${failure.column}` : ""})`
        : "";
      return ok(`${failure.path}${where}: ${failure.message}`);
    },
  };

  /** A sentence the user can act on, without having to read the JSON. */
  const describe = (name: string, input: Record<string, unknown>): ConfirmRequest => {
    const path = typeof input.path === "string" ? input.path : "?";
    if (name === "load_module") {
      // The source goes in the prompt, and this is the whole reason the gate is
      // worth anything. Writes inside ~/modules are automatic, so by the time
      // the assistant offers to load something, the user may never have seen a
      // line of it. "Do you approve running this?" is a rubber stamp unless
      // "this" is on screen.
      let detail: string | undefined;
      try {
        detail = ctx.fs.read(normalize(path));
      } catch {
        detail = undefined; // it will fail on load anyway, and say why
      }
      return {
        tool: name,
        summary: `Load ${path} into the running shell. It runs immediately, with full kernel access.`,
        detail,
      };
    }
    return {
      tool: name,
      summary: `Write ${path}, outside the module directory.`,
      detail: typeof input.content === "string" ? input.content : undefined,
    };
  };

  return {
    specs: TOOL_SPECS,

    /**
     * Run one tool call.
     *
     * Never throws. Everything comes back as a `ToolOutcome`, because a thrown
     * error here would break the conversation loop, while an error *returned*
     * lets the model read what went wrong and try something else — which is
     * usually what you want from a wrong path or a missing file.
     */
    async run(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
      const handler = handlers[name];
      if (!handler) return bad(`no such tool: ${name}`);

      try {
        if (approvalFor(name, input) === "ask") {
          const allowed = await deps.confirm(describe(name, input));
          if (!allowed) {
            // Phrased for the model: it should tell the user and move on, not
            // retry the same call hoping for a different answer.
            return bad(
              `the user declined this ${name} call. Do not retry it — ` +
                `acknowledge the decision and ask what they would prefer.`
            );
          }
        }
        return await handler(input);
      } catch (err) {
        return bad(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
