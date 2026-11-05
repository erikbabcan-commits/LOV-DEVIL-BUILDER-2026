#!/usr/bin/env bash
# LOV-DEVIL VPS redeploy — rsync kódu + docker rebuild + restart kontajnera + health check.
# Použitie: ./deploy/vps-redeploy.sh [ssh-host]   (default: hetzner-vps z ~/.ssh/config)
set -euo pipefail

SSH_HOST="${1:-hetzner-vps}"
REMOTE_DIR="/opt/lov-devil"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> 1/5 rsync ${REPO_ROOT} → ${SSH_HOST}:${REMOTE_DIR}"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .env \
  "$REPO_ROOT/" "$SSH_HOST:$REMOTE_DIR/"

echo "==> 2/5 práva + ochrana .env"
ssh "$SSH_HOST" "chown -R root:root $REMOTE_DIR
find $REMOTE_DIR -type d -exec chmod 755 {} +
find $REMOTE_DIR -type f -exec chmod 644 {} +
chmod 600 $REMOTE_DIR/.env
[ -f $REMOTE_DIR/.env ] || { echo 'CHYBA: $REMOTE_DIR/.env neexistuje — doplň ho pred deployom'; exit 1; }"

echo "==> 3/5 docker build"
ssh "$SSH_HOST" "docker build -q -t lov-devil-api -f $REMOTE_DIR/deploy/Dockerfile $REMOTE_DIR/ >/dev/null"

echo "==> 4/5 restart kontajnera"
ssh "$SSH_HOST" "docker rm -f lov-devil-api >/dev/null 2>&1 || true
docker run -d --name lov-devil-api --restart unless-stopped \
  --env-file $REMOTE_DIR/.env \
  -v lov-devil-sessions:/data/sessions \
  -p 127.0.0.1:8787:8787 \
  --memory 700m \
  lov-devil-api >/dev/null"

echo "==> 5/5 health check"
sleep 3
ssh "$SSH_HOST" "curl -sf http://127.0.0.1:8787/api/health && echo && docker ps --filter name=lov-devil-api --format '{{.Names}}: {{.Status}}'"

echo "✅ Redeploy hotový. Verejná URL: https://lov.2.29.52.59.sslip.io (basic auth: /etc/nginx/.htpasswd-lov)"
