import { sshScript } from "../lib/sh.mjs";
import { resolveTarget, load } from "../lib/config.mjs";
import { say, fail, dim, bold, table, green, yellow, red, step } from "../lib/ui.mjs";

export const help = `
${bold("voidshell status")} [user@host]

  One screen of everything worth knowing: whether the services are up, how
  many dashboards exist, when the last backup ran, and how close the disk is
  to full.
`;

/** One remote round trip, parsed locally — ssh latency dominates otherwise. */
const PROBE = (port, dataDir) => `
echo "api=$(systemctl is-active voidshell-api 2>/dev/null || echo unknown)"
echo "apiEnabled=$(systemctl is-enabled voidshell-api 2>/dev/null || echo unknown)"
echo "since=$(systemctl show voidshell-api -p ActiveEnterTimestamp --value 2>/dev/null)"
echo "timer=$(systemctl is-active voidshell-backup.timer 2>/dev/null || echo unknown)"
echo "nextBackup=$(systemctl show voidshell-backup.timer -p NextElapseUSecRealtime --value 2>/dev/null)"
for p in caddy nginx; do
  if systemctl list-unit-files "$p.service" >/dev/null 2>&1 && systemctl is-enabled "$p" >/dev/null 2>&1; then
    echo "proxy=$p"; echo "proxyState=$(systemctl is-active $p 2>/dev/null)"
  fi
done
echo "health=$(curl -fsS --max-time 3 http://127.0.0.1:${port}/api/health 2>/dev/null || echo unreachable)"
echo "dbSize=$(stat -c %s ${dataDir}/db.json 2>/dev/null || echo 0)"
echo "dbMode=$(stat -c %a ${dataDir}/db.json 2>/dev/null || echo none)"
echo "backups=$(find ${dataDir}/backups -maxdepth 1 -name 'db-*.json' 2>/dev/null | wc -l)"
echo "lastBackup=$(find ${dataDir}/backups -maxdepth 1 -name 'db-*.json' -printf '%f\\n' 2>/dev/null | sort | tail -1)"
echo "disk=$(df -h / | awk 'NR==2 {print $4" free of "$2" ("$5" used)"}')"
echo "mem=$(free -m | awk 'NR==2 {print $7" MB available of "$2" MB"}')"
echo "swap=$(free -m | awk 'NR==3 {print $2" MB"}')"
echo "key=$([ -s /etc/voidshell.env ] && grep -q ANTHROPIC_API_KEY /etc/voidshell.env && echo set || echo unset)"
echo "node=$(node -v 2>/dev/null || echo missing)"
`;

const tint = (value, good) => (value === good ? green : value === "unknown" ? yellow : red);

export async function status(args) {
  const config = load();
  const target = resolveTarget(args[0], config);

  step(`${bold(target)}`);
  const result = await sshScript(target, PROBE(config.port, config.dataDir), { capture: true });
  if (result.code !== 0) {
    fail(`could not reach ${target}`, result.stderr.trim() || "check the host and your ssh key");
  }

  const f = Object.fromEntries(
    result.stdout
      .split("\n")
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()])
  );

  let users = null;
  try {
    users = JSON.parse(f.health).users;
  } catch {
    /* unreachable or not JSON — reported as-is below */
  }

  say();
  table([
    ["api", `${f.api}${f.apiEnabled === "enabled" ? "" : dim(" (not enabled at boot)")}`, tint(f.api, "active")],
    ["health", users === null ? f.health : `ok · ${users} dashboard${users === 1 ? "" : "s"}`, users === null ? red : green],
    ["proxy", f.proxy ? `${f.proxy} ${f.proxyState}` : "none detected", f.proxyState === "active" ? green : yellow],
    ["running since", f.since || dim("—")],
  ]);

  say();
  table([
    ["database", f.dbMode === "none" ? dim("not created yet") : `${(Number(f.dbSize) / 1024).toFixed(1)} KB, mode ${f.dbMode}`,
      f.dbMode === "none" || f.dbMode === "600" ? undefined : red],
    ["backups", f.backups === "0" ? yellow("none yet") : `${f.backups} kept, latest ${f.lastBackup}`],
    ["backup timer", f.timer, tint(f.timer, "active")],
    ["model key", f.key === "set" ? "configured" : dim("unset — the simulator uses its mock provider")],
  ]);

  say();
  table([
    ["disk", f.disk],
    ["memory", f.mem],
    ["swap", f.swap === "0 MB" ? yellow("none — a hand-run build may be OOM-killed") : f.swap],
    ["node", f.node],
  ]);
  say();

  // The two states that are quietly wrong rather than loudly broken.
  if (f.dbMode !== "none" && f.dbMode !== "600") {
    say(`${red("!")} db.json is mode ${f.dbMode}, expected 600 — it holds every dashboard on the box.`);
  }
  if (f.backups === "0" && f.dbMode !== "none") {
    say(`${yellow("!")} There are dashboards but no backups yet. ${dim("voidshell backup")} runs one now.`);
  }
}
