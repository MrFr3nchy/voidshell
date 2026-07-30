import { spawn } from "node:child_process";
import { fail } from "./ui.mjs";

/**
 * Everything that shells out goes through here.
 *
 * Commands are always an argv array, never a string. A target like
 * `root@$(curl evil)` is then an argument to ssh rather than something the
 * local shell expands, and a path with a space is one argument rather than two.
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: opts.capture ? ["inherit", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Runs a command and aborts the CLI if it fails. */
export async function must(cmd, args, opts = {}) {
  const result = await run(cmd, args, opts);
  if (result.code !== 0) {
    fail(opts.message ?? `${cmd} ${args.join(" ")} failed`, result.stderr.trim() || undefined);
  }
  return result;
}

/**
 * `BatchMode=yes` so a host that wants a password fails fast with a readable
 * error instead of hanging on an invisible prompt inside a captured pipe.
 */
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

export const ssh = (target, script, opts = {}) =>
  run("ssh", [...SSH_OPTS, target, "bash -s"], { ...opts, input: script, capture: opts.capture });

/**
 * Sends a script over stdin rather than as an argument.
 *
 * Passing a multi-line script as an ssh argv element means it is re-parsed by
 * the remote login shell, which mangles quoting in ways that are painful to
 * debug. stdin arrives verbatim.
 */
export function sshScript(target, script, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn("ssh", [...SSH_OPTS, target, "bash -s"], {
      stdio: ["pipe", opts.capture ? "pipe" : "inherit", opts.capture ? "pipe" : "inherit"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(script);
  });
}

/** Same, but a non-zero exit aborts with the remote stderr attached. */
export async function sshMust(target, script, message, opts = {}) {
  const result = await sshScript(target, script, opts);
  if (result.code !== 0) fail(message, result.stderr.trim() || result.stdout.trim() || undefined);
  return result;
}

export const rsync = (args) => run("rsync", args);

/** True when a binary is on PATH. */
export async function have(cmd) {
  const { code } = await run("sh", ["-c", `command -v ${cmd}`], { capture: true });
  return code === 0;
}

/**
 * Shell-quotes a value for safe interpolation into a remote script.
 *
 * Single quotes with the standard `'\''` escape: nothing inside is expanded, so
 * a path or key containing `$`, backticks, or spaces stays literal.
 */
export function q(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
