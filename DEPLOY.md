# Deploying voidshell

voidshell builds to **static files** (`npm run build` → `dist/`), so hosting it
is simple. Two roads:

- **Free / easiest:** DigitalOcean App Platform's free static-site tier (or
  Netlify, Cloudflare Pages, etc.) — connect the repo, it builds on push, gives
  you HTTPS + CDN. Fine until you add a backend that needs your keys.
- **Droplet:** more control, and the right foundation for later when you add a
  key-holding backend or always-on services. That's what this doc covers.

## What you need

- A droplet — Ubuntu LTS, Basic plan. 512 MB works if you build locally; pick
  1 GB+ if you'd rather build on the server or run other services next to it.
- A domain — from Cloudflare or Porkbun. (DigitalOcean doesn't sell domains; it
  only manages DNS.)
- An SSH key added to the droplet at creation.
- Caddy on the droplet — reverse proxy with automatic HTTPS.
- Node on your local machine — to build.

## One-time setup

### 1. Create the droplet
Ubuntu 24.04 LTS, Basic plan, a region near you, attach your SSH key. Note the
public IP.

### 2. Point your domain
Add a DNS `A` record: `@` → droplet IP (and `www` too).

### 3. Firewall
```bash
ssh root@YOUR_DROPLET_IP
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

### 4. Install Caddy
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

### 5. Configure Caddy
Edit `Caddyfile` — replace `example.com` — then copy it up and reload:
```bash
scp Caddyfile root@YOUR_DROPLET_IP:/etc/caddy/Caddyfile
ssh root@YOUR_DROPLET_IP 'sudo systemctl reload caddy'
```

## Deploy (and every deploy after)

```bash
./deploy.sh root@YOUR_DROPLET_IP
```
That builds, syncs `dist/` to `/var/www/voidshell`, and reloads Caddy.

## Later: adding a backend (for your API keys)

Run a small service on the droplet (Node or Docker) on `localhost:3000` holding
the key in an env var, uncomment the `reverse_proxy /api/*` line in `Caddyfile`,
and have the frontend call `/api/...`. The key stays server-side.
