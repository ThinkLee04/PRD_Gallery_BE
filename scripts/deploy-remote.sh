#!/usr/bin/env bash
# Runs on the VPS after release files are uploaded. Streamed by
# .github/workflows/deploy.yml via `bash -s`; expects these env vars:
#   APP_DIR, RELEASE_DIR, SERVICE_NAME, BACKUP_BEFORE_MIGRATE
# Real credentials are never passed here — they are sourced server-side from
# $APP_DIR/photo-vault.env (chmod 600).
set -euo pipefail

RELEASE="$APP_DIR/$RELEASE_DIR"
echo "==> release: $RELEASE"

# Make Node/npm visible in non-interactive SSH shells (nvm-style installs).
if [ -s "$HOME/.nvm/nvm.sh" ]; then
	# shellcheck disable=SC1091
	. "$HOME/.nvm/nvm.sh"
fi
if ! command -v npm >/dev/null 2>&1; then
	echo "==> npm not found on PATH. Install Node.js >= 20.19 system-wide (e.g. NodeSource) so npm is available to non-interactive shells, then re-run." >&2
	exit 1
fi

# 1. Production dependencies only (dev deps are never shipped).
cd "$RELEASE"
npm ci --omit=dev --no-audit --no-fund

# 2. Point the live release at this build.
ln -sfn "$RELEASE" "$APP_DIR/current"

# 3. Optional pre-migration backup (DATABASE_URL read server-side).
if [ "$BACKUP_BEFORE_MIGRATE" = "true" ]; then
	mkdir -p "$APP_DIR/backups"
	set -a
	. "$APP_DIR/photo-vault.env"
	set +a
	pg_dump "$DATABASE_URL" > "$APP_DIR/backups/pre-${RELEASE_DIR##*/}.sql" 2>/dev/null
fi

# 4. Apply migrations from the deployed build (spec §14 order).
cd "$APP_DIR/current"
set -a
. "$APP_DIR/photo-vault.env"
set +a
node dist/db/migrate.js

# 5. Restart the service (root, or passwordless sudo for the SSH user).
if ! systemctl restart "$SERVICE_NAME" 2>/dev/null; then
	sudo -n systemctl restart "$SERVICE_NAME"
fi

# 6. Health check against the loopback-bound API (default port 3000).
for i in $(seq 1 15); do
	if curl -fsS "http://127.0.0.1:3000/health" >/dev/null 2>&1; then
		echo "==> healthy after $i attempt(s)"
		exit 0
	fi
	sleep 2
done
echo "==> health check failed" >&2
exit 1
