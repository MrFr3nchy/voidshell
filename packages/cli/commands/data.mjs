import { basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { run, sshScript, q } from "../lib/sh.mjs";
import { resolveTarget, load } from "../lib/config.mjs";
import { step, ok, warn, info, say, fail, dim, bold, confirm, secret, table, yellow } from "../lib/ui.mjs";

export const backupHelp = `
${bold("voidshell backup")} [user@host] [options]

  Runs the nightly backup now and lists what's kept.

  ${dim("--pull [file]")}   also download the current db.json for local inspection
`;

export async function backup(args, flags) {
  const config = load();
  const target = resolveTarget(args[0], config);

  step(`Backing up ${bold(target)}`);
  const result = await sshScript(
    target,
    `set -euo pipefail
/opt/voidshell/backup.sh
echo "---"
find ${q(config.dataDir)}/backups -maxdepth 1 -name 'db-*.json' -printf '%f\\t%s\\n' | sort`,
    { capture: true }
  );

  if (result.code !== 0) {
    // The script refuses to copy invalid JSON on purpose — retention is a
    // rolling window, so backing up a corrupt database for fourteen nights is
    // how a working backup set becomes fourteen copies of the same bad file.
    fail("the backup did not run", result.stderr.trim() || result.stdout.trim());
  }

  const [message, listing = ""] = result.stdout.split("---");
  say();
  ok(message.trim());
  const rows = listing
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, size] = line.split("\t");
      return [name, `${(Number(size) / 1024).toFixed(1)} KB`];
    });
  if (rows.length) {
    say();
    table(rows);
  }

  if (flags.pull) {
    const dest = typeof flags.pull === "string" ? flags.pull : `db-${new Date().toISOString().slice(0, 10)}.json`;
    step(`Downloading db.json → ${dest}`);
    const r = await run("scp", ["-q", `${target}:${config.dataDir}/db.json`, dest]);
    if (r.code !== 0) fail("could not download db.json");
    ok(`Saved ${dest}`);
    warn("That file contains every dashboard on the box. Don't commit it.");
  }
  say();
}

export const restoreHelp = `
${bold("voidshell restore")} <file|backup-name> [user@host] [--yes]

  Replaces the live database. Stops the API first — the process holds the whole
  database in memory and writes it out whole, so a restore underneath a running
  service is overwritten by the next save.

  Takes either a local file or the name of a backup already on the box:

    voidshell restore ./db-20260729.json
    voidshell restore db-20260729.json      ${dim("(from the droplet's backups/)")}
`;

export async function restore(args, flags) {
  const config = load();
  const source = args[0];
  if (!source) fail("nothing to restore from", restoreHelp.trim());
  const target = resolveTarget(args[1], config);

  const isLocal = existsSync(source);
  if (isLocal) {
    // Refusing a malformed file here beats discovering it after the live
    // database has already been replaced.
    try {
      const parsed = JSON.parse(readFileSync(source, "utf8"));
      if (!parsed || typeof parsed !== "object" || !parsed.users) {
        fail(`${source} parses but doesn't look like a voidshell database`, "expected a top-level `users` object");
      }
      info(`${source} is valid JSON with ${Object.keys(parsed.users).length} dashboard(s)`);
    } catch (err) {
      fail(`${source} is not valid JSON`, String(err));
    }
  }

  say();
  warn(`This replaces every dashboard on ${bold(target)} with ${bold(basename(source))}.`);
  warn("A backup of the current database is taken first, but this is not otherwise reversible.");
  if (!flags.yes && !(await confirm("Replace the live database?"))) return say("Nothing changed.");

  if (isLocal) {
    step("Uploading");
    const up = await run("scp", ["-q", source, `${target}:/tmp/voidshell-restore.json`]);
    if (up.code !== 0) fail("could not upload the file");
  }

  const remoteSource = isLocal ? "/tmp/voidshell-restore.json" : `${config.dataDir}/backups/${basename(source)}`;

  step("Restoring");
  const result = await sshScript(
    target,
    `set -euo pipefail
[ -f ${q(remoteSource)} ] || { echo "no such file on the droplet: ${remoteSource}" >&2; exit 1; }
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' ${q(remoteSource)} \\
  || { echo "refusing to restore: that file is not valid JSON" >&2; exit 1; }

# Safety net, taken before anything is overwritten.
if [ -f ${q(config.dataDir)}/db.json ]; then
  cp ${q(config.dataDir)}/db.json ${q(config.dataDir)}/backups/db-pre-restore-$(date -u +%Y%m%d%H%M%S).json
fi

systemctl stop voidshell-api
install -o voidshell -g voidshell -m 600 ${q(remoteSource)} ${q(config.dataDir)}/db.json
systemctl start voidshell-api

for i in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:${config.port}/api/health; then echo; exit 0; fi
  sleep 1
done
echo "restored, but the api did not come back healthy" >&2
exit 1`,
    { capture: true }
  );

  if (isLocal) await sshScript(target, `rm -f /tmp/voidshell-restore.json`, { capture: true });

  if (result.code !== 0) fail("the restore failed", result.stderr.trim() || result.stdout.trim());

  say();
  ok("Restored");
  info(result.stdout.trim().split("\n").pop() ?? "");
  info("the previous database was copied to backups/ as db-pre-restore-*.json");
  say();
}

export const keyHelp = `
${bold("voidshell key")} [user@host] [--clear]

  Stores an Anthropic API key on the droplet so the trading simulator can ask
  for decisions without the key ever reaching a browser.

  Prompted for, never passed as an argument — anything in argv is visible in
  ${dim("ps")} to every user on the machine. Piping works too:

    ${dim("pass show anthropic/voidshell | voidshell key")}
`;

export async function key(args, flags) {
  const config = load();
  const target = resolveTarget(args[0], config);

  if (flags.clear) {
    if (!flags.yes && !(await confirm(`Remove the model key from ${target}?`))) return say("Nothing changed.");
    const r = await sshScript(
      target,
      `set -euo pipefail
rm -f /etc/voidshell.env
systemctl restart voidshell-api`,
      { capture: true }
    );
    if (r.code !== 0) fail("could not clear the key", r.stderr.trim());
    ok("Key removed — the simulator falls back to its mock provider.");
    return;
  }

  const value = await secret("Anthropic API key:");
  if (!value) return say("Nothing entered, nothing changed.");
  if (!value.startsWith("sk-ant-")) {
    warn(`That doesn't start with ${dim("sk-ant-")}. Storing it anyway.`);
  }

  step(`Writing /etc/voidshell.env on ${bold(target)}`);

  // The key travels in the script body on stdin, never in argv — on either
  // side. umask 077 makes the file 600 from the moment it exists rather than
  // after a chmod, so there is no window where it is world-readable.
  const script = [
    "set -euo pipefail",
    "umask 077",
    "cat > /etc/voidshell.env <<'VOIDSHELL_ENV_EOF'",
    `ANTHROPIC_API_KEY=${value}`,
    "VOIDSHELL_ENV_EOF",
    "chown root:root /etc/voidshell.env",
    "systemctl restart voidshell-api",
    "for i in $(seq 1 20); do",
    `  curl -fsS --max-time 2 http://127.0.0.1:${config.port}/api/health >/dev/null && exit 0`,
    "  sleep 1",
    "done",
    'echo "the api did not come back healthy" >&2',
    "exit 1",
  ].join("\n");

  const result = await sshScript(target, script, { capture: true });

  if (result.code !== 0) fail("could not store the key", result.stderr.trim());
  say();
  ok("Key stored, API restarted");
  info("mode 600, owned by root, outside the repo and outside /var/www");
  say();
}

export const logsHelp = `
${bold("voidshell logs")} [user@host] [options]

  ${dim("-n <count>")}   lines of history ${dim("(default: 80)")}
  ${dim("-f")}           follow
  ${dim("--proxy")}      the reverse proxy's log instead of the API's
`;

export async function logs(args, flags) {
  const config = load();
  const target = resolveTarget(args[0], config);
  const unit = flags.proxy ? (config.proxy === "nginx" ? "nginx" : "caddy") : "voidshell-api";
  const lines = flags.n ?? "80";

  // Inherited stdio rather than captured: -f should stream, and Ctrl-C should
  // end it the way it ends any other tail.
  await run("ssh", ["-t", target, `journalctl -u ${unit} -n ${lines} --no-pager ${flags.f ? "-f" : ""}`]);
}
