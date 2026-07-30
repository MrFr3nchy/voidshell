/**
 * Checks for the deployment CLI.
 *
 * The interesting part is `setup`: it composes a bash script that writes
 * systemd units and a proxy config through heredocs, and a heredoc that
 * mangles its payload produces a droplet that is subtly wrong rather than
 * obviously broken. So the script is generated, run against a sandboxed
 * filesystem with the destructive commands stubbed, and the files it wrote are
 * diffed byte-for-byte against the originals.
 *
 *   npx esbuild tools/cli-smoke.mts --bundle --platform=node --format=esm \
 *     --outfile=cli-smoke.mjs --log-level=error && node cli-smoke.mjs
 */
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);

/**
 * Resolved from cwd, like the other harnesses in this directory, and not from
 * import.meta.url: bundling collapses that to wherever the bundle was written,
 * which silently points every path one level too high.
 */
const REPO = process.cwd();
const CLI = join(REPO, "packages/cli/bin/voidshell.mjs");

const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
  if (!ok) failures.push(label);
};

const sandbox = await mkdtemp(join(tmpdir(), "voidshell-cli-"));

async function cli(args: string[], opts: { cwd?: string } = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? REPO,
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/* ---------------- the surface ---------------- */

{
  const usage = await cli([]);
  check("bare invocation prints usage", usage.stdout.includes("set up, deploy, and operate"));
  check("usage lists every command", ["dev", "setup", "deploy", "status", "restore", "key"].every((c) => usage.stdout.includes(c)));

  const unknown = await cli(["depoy"]);
  check("an unknown command exits non-zero", unknown.code !== 0);
  // A typo at 3am should be answered with the fix, not just a rejection.
  check("an unknown command suggests near matches", unknown.stderr.includes("deploy"));

  const help = await cli(["restore", "--help"]);
  check("per-command help works", help.stdout.includes("Replaces the live database"));
  check("restore's help explains why the service stops first", help.stdout.includes("overwritten by the next save"));
}

/* ---------------- config ---------------- */

{
  // A scratch checkout, so the real .voidshell.json is never touched.
  const fake = join(sandbox, "checkout");
  await mkdir(fake, { recursive: true });

  const bad = await cli(["config", "nonsense", "x"]);
  check("an unknown setting is rejected", bad.code !== 0 && bad.stderr.includes("not a setting"));

  const badTarget = await cli(["status", "not-a-target"]);
  check("a malformed target is refused before any ssh", badTarget.code !== 0 && badTarget.stderr.includes("user@host"));

  // The shape most likely to be pasted by accident.
  const hostOnly = await cli(["status", "203.0.113.10"]);
  check("a bare host without a user is refused", hostOnly.code !== 0);
}

/* ---------------- the generated setup script ---------------- */

const script = (await cli(["setup", "root@203.0.113.10", "--domain", "voidshell.test", "--dry-run"])).stdout;

{
  check("dry-run emits a script rather than connecting", script.includes("READY") && script.length > 500);

  await writeFile(join(sandbox, "setup.sh"), script);
  const parsed = await exec("bash", ["-n", join(sandbox, "setup.sh")]).then(
    () => true,
    () => false
  );
  check("the generated script is valid bash", parsed);

  check("it is idempotent about the service user", script.includes("id -u voidshell") && script.includes("||"));
  check("it locks the data directory to 700", script.includes("chmod 700"));
  check("the placeholder domain is gone", !script.includes("example.com"));
  check("the real domain is in the proxy config", script.includes("voidshell.test"));
  // The single most load-bearing line in the whole deployment.
  check("the isolation headers survive generation", script.includes("Cross-Origin-Embedder-Policy credentialless"));
  check("it validates the proxy config before reloading", script.includes("caddy validate"));
}

/* ---------------- run it against a sandboxed filesystem ---------------- */

{
  const root = join(sandbox, "root");
  await mkdir(join(root, "etc/systemd/system"), { recursive: true });
  await mkdir(join(root, "etc/caddy"), { recursive: true });
  await mkdir(join(root, "opt/voidshell"), { recursive: true });

  // Stubs for everything that would touch a real machine. `setup` is supposed
  // to be safe to re-run, so this also proves it doesn't blow up on a second
  // pass over state it already created.
  const bin = join(sandbox, "bin");
  await mkdir(bin, { recursive: true });
  for (const stub of ["systemctl", "apt-get", "adduser", "ufw", "swapon", "mkswap", "caddy", "nginx", "gpg", "curl"]) {
    const path = join(bin, stub);
    await writeFile(path, `#!/bin/sh\nexit 0\n`);
    await chmod(path, 0o755);
  }
  // fallocate creates the file for real, so the run exercises the path a
  // working droplet takes rather than the dd fallback.
  await writeFile(join(bin, "fallocate"), `#!/bin/sh\n: > "$3"\n`);
  await chmod(join(bin, "fallocate"), 0o755);

  // One map, applied to the script *and* to the expected file contents below.
  // The rewrite necessarily lands inside the heredoc bodies too — a unit's
  // ExecStart and a Caddyfile comment both name absolute paths — so the files
  // that get written legitimately carry sandbox paths. Deriving both sides
  // from the same map is what keeps the comparison honest: what's verified is
  // that everything else about each file survived the heredoc intact.
  const PATHS: Array<[string, string]> = [
    ["/etc/systemd/system/", `${root}/etc/systemd/system/`],
    ["/etc/caddy/Caddyfile", `${root}/etc/caddy/Caddyfile`],
    ["/opt/voidshell/backup.sh", `${root}/opt/voidshell/backup.sh`],
    ["/opt/voidshell/api", `${root}/opt/voidshell/api`],
    ["/var/lib/voidshell", `${root}/var/lib/voidshell`],
    ["/var/www/voidshell", `${root}/var/www/voidshell`],
  ];
  const sandboxPaths = (text: string) => PATHS.reduce((acc, [from, to]) => acc.replaceAll(from, to), text);

  const rewritten = sandboxPaths(script)
    .replaceAll("/etc/fstab", `${root}/etc/fstab`)
    .replaceAll(". /etc/os-release", `ID=ubuntu; PRETTY_NAME="Ubuntu (sandbox)"`)
    .replaceAll("chown -R voidshell:voidshell", "true")
    .replaceAll("/swapfile", `${root}/swapfile`);

  const runner = join(sandbox, "run.sh");
  await writeFile(runner, rewritten);

  let ran = { code: 0, stdout: "", stderr: "" };
  try {
    const { stdout, stderr } = await exec("bash", [runner], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      maxBuffer: 8 * 1024 * 1024,
    });
    ran = { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    ran = { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }

  check(`the script runs to completion (exit ${ran.code})`, ran.code === 0 && ran.stdout.includes("READY"));

  // The point of the whole exercise: what landed on disk must be exactly what
  // is in the repo, not a heredoc-mangled approximation.
  for (const unit of ["voidshell-api.service", "voidshell-backup.service", "voidshell-backup.timer"]) {
    const expected = sandboxPaths(await readFile(join(REPO, "deploy/systemd", unit), "utf8"));
    const actual = await readFile(join(root, "etc/systemd/system", unit), "utf8").catch(() => "");
    check(`${unit} round-trips byte-for-byte`, actual.trim() === expected.trim());
  }

  const expectedCaddy = sandboxPaths(
    (await readFile(join(REPO, "Caddyfile"), "utf8")).replaceAll("example.com", "voidshell.test")
  );
  const actualCaddy = await readFile(join(root, "etc/caddy/Caddyfile"), "utf8").catch(() => "");
  check("the Caddyfile round-trips with the domain substituted", actualCaddy.trim() === expectedCaddy.trim());

  const expectedBackup = sandboxPaths(await readFile(join(REPO, "deploy/backup.sh"), "utf8"));
  const actualBackup = await readFile(join(root, "opt/voidshell/backup.sh"), "utf8").catch(() => "");
  check("backup.sh round-trips byte-for-byte", actualBackup.trim() === expectedBackup.trim());

  // Tabs, `$` and backticks are exactly what a naive heredoc eats.
  check("tabs in the Caddyfile survive", actualCaddy.includes("\t"));
  check("shell metacharacters in backup.sh survive", actualBackup.includes("$(") && actualBackup.includes("${"));

  // Re-running must be a no-op rather than an error.
  const second = await exec("bash", [runner], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    maxBuffer: 8 * 1024 * 1024,
  }).then(
    () => true,
    () => false
  );
  check("running setup a second time succeeds", second);
}

/* ---------------- nginx variant ---------------- */

{
  const ng = (await cli(["setup", "root@203.0.113.10", "--domain", "voidshell.test", "--proxy", "nginx", "--dry-run"])).stdout;
  await writeFile(join(sandbox, "nginx.sh"), ng);
  const parsed = await exec("bash", ["-n", join(sandbox, "nginx.sh")]).then(
    () => true,
    () => false
  );
  check("the nginx variant is valid bash", parsed);
  check("it validates the config before reloading", ng.includes("nginx -t"));
  check("it keeps the isolation headers", ng.includes("Cross-Origin-Embedder-Policy credentialless"));
  check("it mentions certbot rather than assuming TLS", ng.includes("certbot"));

  const bogus = await cli(["setup", "root@203.0.113.10", "--domain", "x.test", "--proxy", "lighttpd", "--dry-run"]);
  check("an unsupported proxy is rejected", bogus.code !== 0);
}

await rm(sandbox, { recursive: true, force: true });

console.log("");
if (failures.length) {
  console.log(`${failures.length} FAILURE(S)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("all cli smoke checks passed");
