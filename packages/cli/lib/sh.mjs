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
 *
 * The cost of that is real and worth stating: BatchMode also suppresses the
 * passphrase prompt for an encrypted key. A key that is not loaded into an
 * agent therefore fails here as `Permission denied (publickey)`, which is the
 * same string ssh prints for a key the server has never seen. `sshPreflight`
 * exists to tell those two apart before a deploy has done any work.
 */
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/**
 * The exit status ssh uses for its own failures — DNS, TCP, host keys, auth —
 * as opposed to relaying the remote command's status. 255 means no remote
 * shell ever ran, so nothing that happened on the droplet can be blamed.
 */
export const SSH_TRANSPORT_FAILURE = 255;

/**
 * Turns ssh's terser refusals into the sentence that fixes them.
 *
 * Returns null for anything unrecognised, so the caller falls back to printing
 * ssh's own stderr rather than a confidently wrong guess.
 */
export function sshHint(stderr) {
  if (/Permission denied \(publickey/i.test(stderr)) {
    return "ssh could not authenticate without prompting. If your key has a passphrase, load it once with `ssh-add` — deploy captures output on some steps, and a prompt there cannot be answered.";
  }
  if (/Host key verification failed/i.test(stderr)) {
    return "the droplet's host key is not in ~/.ssh/known_hosts — connect once by hand to accept it.";
  }
  if (/Could not resolve hostname/i.test(stderr)) {
    return "that hostname does not resolve — check the address.";
  }
  if (/Connection timed out|No route to host|Connection refused/i.test(stderr)) {
    return "the droplet did not answer — check that it is running and reachable on port 22.";
  }
  return null;
}

/**
 * Confirms ssh can authenticate unattended, before anything expensive happens.
 *
 * Without this the first failure surfaces at the restart step, after a full
 * build and two rsyncs, wearing the label "the API did not come back healthy"
 * — which sends you to the droplet's logs to debug a laptop's ssh-agent.
 */
export async function sshPreflight(target) {
  const result = await run("ssh", [...SSH_OPTS, target, "true"], { capture: true });
  if (result.code === 0) return { ok: true };
  const stderr = result.stderr.trim();
  return { ok: false, stderr, hint: sshHint(stderr) };
}

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
