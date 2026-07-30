import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sshScript, q } from "../lib/sh.mjs";
import { REPO, resolveTarget, load, save } from "../lib/config.mjs";
import { step, ok, warn, info, say, fail, dim, bold, confirm } from "../lib/ui.mjs";

export const help = `
${bold("voidshell setup")} [user@host] [options]

  Provisions a fresh Ubuntu droplet: Node, the service user, directories,
  systemd units, the nightly backup timer, and the reverse proxy.

  Safe to re-run. Every step checks before it acts, so this is also how you
  apply a changed unit file or Caddyfile to a box that already exists.

  ${dim("--domain <name>")}   domain for the reverse proxy (asked for if omitted)
  ${dim("--proxy caddy|nginx")}  which reverse proxy to install ${dim("(default: caddy)")}
  ${dim("--dry-run")}         print the remote script instead of running it
  ${dim("--yes")}             skip the confirmation
`;

/** Composed remotely so the whole thing is one idempotent transaction. */
function remoteScript({ domain, proxy, dataDir, wwwDir, apiDir, units, proxyConf, backupSh }) {
  return `set -euo pipefail

echo "── checking the box"
. /etc/os-release
echo "   \${PRETTY_NAME:-unknown}"
[ "\${ID:-}" = "ubuntu" ] || [ "\${ID_LIKE:-}" = "debian" ] || {
  echo "this expects Ubuntu or Debian" >&2; exit 1;
}

echo "── swap"
if [ -f /swapfile ] || swapon --show | grep -q .; then
  echo "   already present"
else
  # A 1GB box running a hand-rolled build will OOM without this. fallocate
  # isn't supported on every filesystem (ZFS, tmpfs, some container storage),
  # so fall back to dd rather than dying three lines later on a chmod against
  # a file that was never created.
  if fallocate -l 2G /swapfile 2>/dev/null \\
    || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none 2>/dev/null; then
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "   created 2G"
  else
    # Not fatal. Builds happen in CI; swap only matters for a build run by
    # hand on the box, and failing provisioning over it would be worse.
    echo "   could not create one — fine unless you build on the droplet"
  fi
fi

echo "── node"
if command -v node >/dev/null && [ "\$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')" -ge 22 ]; then
  echo "   \$(node -v) already installed"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs >/dev/null
  echo "   installed \$(node -v)"
fi

echo "── service user and directories"
id -u voidshell >/dev/null 2>&1 || adduser --system --group --no-create-home voidshell
mkdir -p ${q(dataDir)}/backups ${q(apiDir)} ${q(wwwDir)}
chown -R voidshell:voidshell ${q(dataDir)}
# 700 because db.json holds every dashboard on the box.
chmod 700 ${q(dataDir)}
echo "   ok"

echo "── backup script"
cat > /opt/voidshell/backup.sh <<'VOIDSHELL_BACKUP_EOF'
${backupSh}
VOIDSHELL_BACKUP_EOF
chmod +x /opt/voidshell/backup.sh
echo "   installed"

echo "── systemd units"
${units
  .map(
    ({ name, body }) => `cat > /etc/systemd/system/${name} <<'VOIDSHELL_UNIT_EOF'
${body}
VOIDSHELL_UNIT_EOF`
  )
  .join("\n")}
systemctl daemon-reload
systemctl enable voidshell-backup.timer >/dev/null 2>&1
systemctl restart voidshell-backup.timer
echo "   installed and enabled"

echo "── reverse proxy (${proxy})"
${
  proxy === "caddy"
    ? `if ! command -v caddy >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y caddy >/dev/null
  echo "   installed caddy"
fi
cat > /etc/caddy/Caddyfile <<'VOIDSHELL_PROXY_EOF'
${proxyConf}
VOIDSHELL_PROXY_EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy || systemctl restart caddy
echo "   configured for ${domain}"`
    : `command -v nginx >/dev/null || { apt-get update >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx >/dev/null; }
cat > /etc/nginx/sites-available/voidshell <<'VOIDSHELL_PROXY_EOF'
${proxyConf}
VOIDSHELL_PROXY_EOF
ln -sf /etc/nginx/sites-available/voidshell /etc/nginx/sites-enabled/voidshell
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
echo "   configured for ${domain} — run 'certbot --nginx' for TLS"`
}

echo "── firewall"
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 80,443/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  echo "   OpenSSH + 80/443 allowed"
else
  echo "   ufw not installed, skipping"
fi

echo
echo "READY"
`;
}

export async function setup(args, flags) {
  const config = load();
  const target = resolveTarget(args[0], config);
  const proxy = flags.proxy ?? config.proxy ?? "caddy";

  if (proxy !== "caddy" && proxy !== "nginx") {
    fail(`unknown proxy "${proxy}"`, "expected caddy or nginx");
  }

  const domain = flags.domain ?? config.domain;
  if (!domain) {
    fail(
      "no domain set",
      `pass --domain voidshell.example, or save it with ${dim("voidshell config domain voidshell.example")}`
    );
  }

  const backupSh = readFileSync(join(REPO, "deploy", "backup.sh"), "utf8");
  const units = ["voidshell-api.service", "voidshell-backup.service", "voidshell-backup.timer"].map(
    (name) => ({ name, body: readFileSync(join(REPO, "deploy", "systemd", name), "utf8") })
  );

  const proxyConf =
    proxy === "caddy"
      ? readFileSync(join(REPO, "Caddyfile"), "utf8").replaceAll("example.com", domain)
      : readFileSync(join(REPO, "deploy", "nginx", "voidshell.conf"), "utf8").replaceAll(
          "voidshell.example",
          domain
        );

  const script = remoteScript({
    domain,
    proxy,
    dataDir: config.dataDir,
    wwwDir: config.wwwDir,
    apiDir: config.apiDir,
    units,
    proxyConf,
    backupSh,
  });

  if (flags["dry-run"]) {
    say(script);
    return;
  }

  say();
  step(`Provisioning ${bold(target)}`);
  info(`domain  ${domain}`);
  info(`proxy   ${proxy}`);
  info(`data    ${config.dataDir}`);
  say();
  warn("This installs packages and rewrites the proxy config on that box.");
  if (!flags.yes && !(await confirm("Continue?"))) return say("Nothing changed.");
  say();

  const result = await sshScript(target, script);
  if (result.code !== 0) {
    fail("setup did not finish", "the box is unchanged from the failing step onward — fix and re-run");
  }

  // Deliberately after provisioning: nothing is written down until the run
  // that used it actually worked.
  config.domain = domain;
  config.proxy = proxy;
  config.target = config.target ?? target;
  save(config);

  say();
  ok(`${target} is provisioned`);
  info(`saved to .voidshell.json — later commands can omit the target`);
  say();
  say(`  Next: ${dim("voidshell deploy")}`);
  if (proxy === "nginx") say(`        ${dim(`ssh ${target} 'certbot --nginx'`)} for TLS`);
  say(`        ${dim("voidshell key")} to enable the trading simulator's model calls`);
  say();
}

/** Exposed so `doctor` can check reachability with the same ssh options. */
export async function reachable(target) {
  const { code } = await sshScript(target, "exit 0", { capture: true });
  return code === 0;
}
