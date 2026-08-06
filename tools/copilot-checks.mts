/**
 * The assistant's tool surface, asserted against the real kernel.
 *
 * None of this talks to the Anthropic API, and that is the point rather than a
 * limitation: the chat plumbing is replaceable, while the tool surface is the
 * security boundary. What a model is allowed to do — and what it must ask about
 * first — is testable without a model, and is exactly the part that would be
 * expensive to get wrong.
 *
 * The confirm callback is a stub that says yes or no on command, which is how
 * the gate gets tested in both directions: that a denial actually prevents the
 * write, not merely reports one.
 */
import type { Kernel } from "../packages/ui/src/kernel/Kernel";
import type { KernelContext } from "../packages/ui/src/kernel/types";
import type { ConfirmRequest } from "../packages/ui/src/modules/copilot/tools";

type Check = (label: string, ok: boolean) => void;

export async function copilotChecks(
  check: Check,
  kernel: Kernel,
  ctx: KernelContext
): Promise<void> {
  const { createToolbox, approvalFor, TOOL_SPECS, HOME } = await import(
    "../packages/ui/src/modules/copilot/tools"
  );
  const { MODULE_DIR, LAST_ERROR_KEY } = await import(
    "../packages/ui/src/modules/devkit/protocol"
  );

  /** Records what it was asked, and answers however the test needs. */
  const gate = (answer: boolean) => {
    const asked: ConfirmRequest[] = [];
    return {
      asked,
      deps: {
        confirm: async (request: ConfirmRequest) => {
          asked.push(request);
          return answer;
        },
      },
    };
  };

  const allowAll = gate(true);
  const box = createToolbox(ctx, allowAll.deps);

  /* ---------------- the surface itself ---------------- */

  const names = TOOL_SPECS.map((t) => t.name).sort();
  check(
    "the tool surface is exactly what was designed",
    names.join(",") ===
      "last_build_error,list_directory,load_module,read_file,read_system_log,write_file"
  );

  // The strongest guarantee here is about verbs that do not exist. A
  // confirmation dialog is a thing people click through; a tool that was never
  // defined cannot be invoked at all.
  check(
    "there is no tool that can delete, move, or uninstall anything",
    !names.some((n) => /delete|remove|rm\b|move|rename|uninstall|exec|spawn/.test(n))
  );

  check(
    "every tool describes itself in more than a phrase",
    TOOL_SPECS.every((t) => t.description.length > 120)
  );
  check(
    "every required parameter is documented",
    TOOL_SPECS.every((t) =>
      (t.input_schema.required ?? []).every(
        (key) => typeof (t.input_schema.properties as Record<string, { description?: string }>)[key]
          ?.description === "string"
      )
    )
  );

  /* ---------------- the approval policy ---------------- */

  check(
    "writing inside the module directory does not interrupt anybody",
    approvalFor("write_file", { path: `${MODULE_DIR}/thing.ts` }) === "auto"
  );
  check(
    "writing elsewhere in the home directory asks first",
    approvalFor("write_file", { path: `${HOME}/notes/thing.md` }) === "ask"
  );
  // The real line isn't reading versus writing — it's inert versus running.
  check(
    "loading a module always asks, wherever it lives",
    approvalFor("load_module", { path: `${MODULE_DIR}/thing.ts` }) === "ask"
  );
  check(
    "reading never asks",
    approvalFor("read_file", { path: "/etc/hostname" }) === "auto" &&
      approvalFor("list_directory", { path: HOME }) === "auto" &&
      approvalFor("read_system_log", {}) === "auto" &&
      approvalFor("last_build_error", {}) === "auto"
  );

  /* ---------------- reading ---------------- */

  ctx.fs.mkdirp(`${HOME}/cptest`);
  ctx.fs.write(`${HOME}/cptest/hello.txt`, "hello from the harness");

  check(
    "read_file returns the file",
    (await box.run("read_file", { path: `${HOME}/cptest/hello.txt` })).content ===
      "hello from the harness"
  );
  check(
    "list_directory lists it",
    (await box.run("list_directory", { path: `${HOME}/cptest` })).content.includes("hello.txt")
  );
  check(
    "a missing file is an error the model can read, not a thrown exception",
    (await box.run("read_file", { path: `${HOME}/cptest/nope.txt` })).isError
  );
  check(
    "an unknown tool is refused rather than crashing the turn",
    (await box.run("wipe_everything", {})).isError
  );
  check(
    "a missing argument comes back as a sentence",
    (await box.run("read_file", {})).content.includes("path is required")
  );

  /* ---------------- writing, and its confinement ---------------- */

  const source = `export default {
  manifest: { id: "cp-loaded", name: "cp-loaded", kind: "app", glyph: "*" },
  activate() { return () => {}; },
  launch(ctx) { ctx.openSurface({ title: "cp", render: (r) => { r.className = "cp-mounted"; } }); },
};`;
  const wrote = await box.run("write_file", {
    path: `${MODULE_DIR}/from-harness.js`,
    content: source,
  });
  check("write_file creates the file", !wrote.isError);
  check("and it is really on disk", ctx.fs.read(`${MODULE_DIR}/from-harness.js`) === source);
  check("writing inside ~/modules asked nobody", allowAll.asked.length === 0);

  check(
    "write_file creates missing parent directories",
    !(await box.run("write_file", { path: `${HOME}/a/b/c/deep.txt`, content: "x" })).isError &&
      ctx.fs.read(`${HOME}/a/b/c/deep.txt`) === "x"
  );

  // The confinement check that matters: /etc/autostart decides what launches at
  // boot, so an escape here plus a module nobody approved is persistence.
  const escapes = [
    "/etc/autostart",
    "/etc/hostname",
    `${HOME}/../etc/autostart`,
    `${MODULE_DIR}/../../../etc/autostart`,
    "/projects/anything.ts",
  ];
  let blocked = true;
  for (const path of escapes) {
    const out = await box.run("write_file", { path, content: "pwned" });
    if (!out.isError) blocked = false;
  }
  check("writes cannot escape the home directory, including via ..", blocked);
  check("and /etc/autostart is untouched", !ctx.fs.read("/etc/autostart").includes("pwned"));

  /* ---------------- the gate, in both directions ---------------- */

  const outside = gate(true);
  const permissive = createToolbox(ctx, outside.deps);
  const allowed = await permissive.run("write_file", {
    path: `${HOME}/cptest/asked.txt`,
    content: "approved",
  });
  check("writing outside ~/modules prompts", outside.asked.length === 1);
  check(
    "the prompt says which file, and shows what would be written",
    outside.asked[0].summary.includes("asked.txt") && outside.asked[0].detail === "approved"
  );
  check("and allowing it writes the file", !allowed.isError && ctx.fs.exists(`${HOME}/cptest/asked.txt`));

  const refuser = gate(false);
  const strict = createToolbox(ctx, refuser.deps);
  const denied = await strict.run("write_file", {
    path: `${HOME}/cptest/denied.txt`,
    content: "should not exist",
  });
  check("declining is reported to the model as an error", denied.isError);
  // The whole point: a denial must PREVENT the write, not narrate one.
  check("and nothing was written", !ctx.fs.exists(`${HOME}/cptest/denied.txt`));
  check(
    "the refusal tells the model not to just try again",
    /do not retry/i.test(denied.content)
  );

  // Deliberately `.js`. jsdom has no `Worker`, so a `.ts` module cannot reach
  // the esbuild-wasm compiler here at all — the TypeScript path is covered in
  // ts-checks against the native compiler instead. What is being tested here is
  // the gate and the install, which are extension-agnostic.
  const noLoad = gate(false);
  const cautious = createToolbox(ctx, noLoad.deps);
  const before = ctx.registry().length;
  const refusedLoad = await cautious.run("load_module", {
    path: `${MODULE_DIR}/from-harness.js`,
  });
  check("declining a load is refused too", refusedLoad.isError);
  check("and nothing was installed", ctx.registry().length === before);
  check(
    "the load prompt warns that the code runs with full kernel access",
    noLoad.asked[0]?.summary.includes("full kernel access") === true
  );
  // Without this the gate is a rubber stamp: writes inside ~/modules are
  // automatic, so the user can reach the load prompt having never seen a line
  // of what they are about to run.
  check(
    "and shows the source it is about to run",
    noLoad.asked[0]?.detail === source
  );

  /* ---------------- loading, once allowed ---------------- */

  const loaded = await box.run("load_module", { path: `${MODULE_DIR}/from-harness.js` });
  check("allowing a load installs the module", !loaded.isError);
  check(
    "and the shell is running it",
    ctx.registry().some((m) => m.id === "cp-loaded")
  );
  check("the model is told the id it got", loaded.content.includes("cp-loaded"));
  kernel.uninstall("cp-loaded");

  /* ---------------- the diagnostics tools ---------------- */

  const log = await box.run("read_system_log", { lines: 5 });
  check("read_system_log returns the tail", !log.isError && log.content.length > 0);
  check(
    "and an absurd line count is clamped rather than honoured",
    !(await box.run("read_system_log", { lines: 10_000 })).isError
  );

  ctx.state.set(LAST_ERROR_KEY, {
    path: `${MODULE_DIR}/broken.ts`,
    message: "Unexpected token",
    line: 7,
    column: 3,
    at: Date.now(),
  });
  const failure = await box.run("last_build_error", {});
  check(
    "last_build_error reports the file, the line and the message",
    failure.content.includes("broken.ts") &&
      failure.content.includes("line 7") &&
      failure.content.includes("Unexpected token")
  );
  ctx.state.set(LAST_ERROR_KEY, null);
  check(
    "and says so plainly when nothing has failed",
    (await box.run("last_build_error", {})).content.includes("no module has failed")
  );

  // The key lives in the store, not the filesystem — so a read tool cannot
  // fetch it back out. Worth asserting, because /etc and /proc DO surface
  // other store-backed values as files.
  ctx.state.set("copilot.apiKey", "sk-ant-secret-do-not-leak");
  const etc = await box.run("list_directory", { path: "/etc" });
  check(
    "the API key is not reachable through the filesystem",
    !etc.content.includes("apiKey") &&
      !(await box.run("read_file", { path: "/etc/hostname" })).content.includes("sk-ant-secret")
  );
  ctx.state.set("copilot.apiKey", "");

  ctx.fs.rm(`${HOME}/cptest`, true);
  ctx.fs.rm(`${HOME}/a`, true);
  ctx.fs.rm(`${MODULE_DIR}/from-harness.js`);
  for (const s of ctx.openSurfaces()) kernel.closeSurface(s.id);
}
