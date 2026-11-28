#!/usr/bin/env bash
# LOV-DEVIL VPS redeploy — build frontendu + rsync kódu + docker rebuild API + databázové migrácie + restart kontajnera + Nginx reload + health check.
# Použitie: ./deploy/vps-redeploy.sh [ssh-host]   (default: root@2.29.52.59)
set -euo pipefail

SSH_HOST="${1:-${SSH_HOST:-root@2.29.52.59}}"
REMOTE_DIR="/opt/lov-devil"
HOST_PORT="8788"          # Nginx proxy_pass smeruje na 127.0.0.1:8788
CONTAINER_PORT="8787"     # API počúva na internom porte 8787
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🚀 Začínam deploy LOV-DEVIL na ${SSH_HOST}:${REMOTE_DIR}"

echo "==> 1/7 Lokálny build produkčného frontendu (Vite)"
(cd "$REPO_ROOT" && npm run build)

echo "==> 2/7 Rsync kódu ${REPO_ROOT} → ${SSH_HOST}:${REMOTE_DIR}"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .env \
  "$REPO_ROOT/" "$SSH_HOST:$REMOTE_DIR/"

echo "==> 3/7 Nastavenie práv a ochrana .env na VPS"
ssh -o StrictHostKeyChecking=no "$SSH_HOST" "chown -R root:root $REMOTE_DIR
find $REMOTE_DIR -type d -exec chmod 755 {} +
find $REMOTE_DIR -type f ! -name .env ! -name '.env.*' -exec chmod 644 {} +
chmod +x $REMOTE_DIR/deploy/*.sh 2>/dev/null || true
chmod 600 $REMOTE_DIR/.env
[ -f $REMOTE_DIR/.env ] || { echo 'CHYBA: $REMOTE_DIR/.env neexistuje na VPS!'; exit 1; }"

echo "==> 4/7 Docker build API kontajnera (lov-devil-api)"
ssh -o StrictHostKeyChecking=no "$SSH_HOST" "docker build -t lov-devil-api -f $REMOTE_DIR/deploy/Dockerfile $REMOTE_DIR/"

echo "==> 5/7 Spustenie kontajnera lov-devil-api (port ${HOST_PORT}:${CONTAINER_PORT})"
ssh -o StrictHostKeyChecking=no "$SSH_HOST" "set -eu
sandbox_network=''
if grep -qx 'SANDBOX_MODE=isolated' $REMOTE_DIR/.env; then
  test \"\$(docker network inspect -f '{{.Internal}}' lov-sandbox-control)\" = true
  sandbox_network='--network lov-sandbox-control'
fi
docker rm -f lov-devil-api >/dev/null 2>&1 || true
docker run -d --name lov-devil-api --restart unless-stopped --network lov-net \$sandbox_network \\
  --env-file $REMOTE_DIR/.env \\
  -e AGENT_JOBS_WORKER=1 \
  -v lov-devil-sessions:/data/sessions \\
  -p 127.0.0.1:${HOST_PORT}:${CONTAINER_PORT} \\
  --memory 700m \\
  lov-devil-api"

echo "==> 6/7 Aplikácia a overenie databázových migrácií (PostgreSQL)"
# Počkáme 3 sekundy na inicializáciu API
sleep 3
ssh -o StrictHostKeyChecking=no "$SSH_HOST" "docker exec lov-devil-api npx tsx server/db/migrate.ts"

# Zabezpečenie verejných ciest /p/ a /api/share/ bez auth_basic
ssh -o StrictHostKeyChecking=no "$SSH_HOST" 'python3 -c "
with open(\"/etc/nginx/sites-available/lov-devil\", \"r\") as f:
    content = f.read()
share_block = \"\"\"    location /p/ {
        auth_basic off;
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /api/share/ {
        auth_basic off;
        proxy_pass http://127.0.0.1:8788;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
\"\"\"
if \"location /p/ {\" not in content:
    content = content.replace(\"location /api/ {\", share_block + \"\n    location /api/ {\")
    with open(\"/etc/nginx/sites-available/lov-devil\", \"w\") as f:
        f.write(content)
" && nginx -t && systemctl reload nginx'

echo "==> 7/7 Health check & overenie dostupnosti"
ssh -o StrictHostKeyChecking=no "$SSH_HOST" "curl -sf http://127.0.0.1:${HOST_PORT}/api/health && echo '' && docker ps --filter name=lov-devil-api --format '{{.Names}}: {{.Status}} ({{.Ports}})'"

echo "✅ Redeploy úspešne dokončený!"
echo "   Verejná URL: https://lov.vorkei.com"
echo "   Wildcard alias: https://lov.2.29.52.59.sslip.io"
