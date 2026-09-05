# Backend server setup (Ubuntu VPS)

One-time provisioning for the Photo Vault API. The CI/CD workflow in
`.github/workflows/deploy.yml` expects exactly this layout.

## 1. Directories and service user

```bash
sudo mkdir -p /opt/photo-vault/backups
# Simple path: run the service as root (deploy SSH user is root too).
# Optional dedicated user (see photo-vault.service notes):
# sudo useradd --system --no-create-home --shell /usr/sbin/nologin photo-vault
```

## 2. Node.js (>= 20.19, so `npm` is on PATH for non-interactive shells)

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && npm -v
```

## 3. Environment file

Build `/opt/photo-vault/photo-vault.env` from `photo-vault.env.example` with the
same values you use locally in `be/.env`, changing the environment-specific ones:

| Local `be/.env` | Server change |
| --- | --- |
| `NODE_ENV=development` | `production` |
| `CORS_ORIGIN=http://localhost:5173` | `https://<your-vercel-app-domain>` |
| `APP_BASE_URL` | `https://<your-vercel-app-domain>` |
| `GOOGLE_REDIRECT_URI` | `https://<your-api-domain>/auth/google/callback` |

```bash
# from your machine, once the file has real values:
# (note: scp uses UPPERCASE -P for port; ssh uses lowercase -p)
scp -i ~/.ssh/photo_vault_deploy -P 8686 photo-vault.env root@<vps>:/opt/photo-vault/photo-vault.env
ssh -i ~/.ssh/photo_vault_deploy -p 8686 root@<vps> 'chmod 600 /opt/photo-vault/photo-vault.env'
```

Rules (kept compatible with both systemd and the deploy script's `source`):
no `export`, no spaces around `=`, quote values with special characters.

## 4. systemd unit

The files in this `deploy/` folder live in the git repo, **not** on the server.
Copy the ones you need first (from your machine):

```bash
scp -i ~/.ssh/photo_vault_deploy -P 8686 deploy/photo-vault.service root@<vps>:/opt/photo-vault/photo-vault.service
```

Then run on the server (paths are absolute, so it works from any directory):

```bash
sudo install -m 644 /opt/photo-vault/photo-vault.service /etc/systemd/system/photo-vault.service
sudo systemctl daemon-reload
sudo systemctl enable --now photo-vault
sudo systemctl status photo-vault
```

`/opt/photo-vault/current` is created by the first deploy (symlink). Until then
the service will fail to start because `current` doesn't exist — that is
expected; it starts after the first successful deploy.

## 5. Caddy (TLS + reverse proxy)

Install `deploy/Caddyfile` (set your real domain first), reload, and verify:

```bash
# from your machine:
scp -i ~/.ssh/photo_vault_deploy -P 8686 deploy/Caddyfile root@<vps>:/opt/photo-vault/Caddyfile
# on the server:
sudo apt install -y caddy
sudo install -m 644 /opt/photo-vault/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -fsS https://<your-api-domain>/health
```

## 6. Test the whole loop

```bash
# local -> server non-interactive node/npm check
ssh -i ~/.ssh/photo_vault_deploy root@<vps> 'node -v && npm -v'
# after merging to master: CI runs, then be-deploy uploads + migrates + restarts
```

Watch a deploy in the `be` repo Actions tab. If the remote step fails, the
messages in `scripts/deploy-remote.sh` say exactly what is missing.
