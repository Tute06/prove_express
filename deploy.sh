#!/usr/bin/env sh
# Redeploy: trae el código y reconstruye. Uso: ./deploy.sh
set -e
cd "$(dirname "$0")"
[ -f .env ] || { echo "Falta .env (copiar de .env.example)"; exit 1; }
git pull --ff-only 2>/dev/null || true
docker compose up -d --build
docker compose up -d --force-recreate nginx
sleep 2
curl -fsS "http://localhost:${HTTP_PORT:-$(grep -E '^HTTP_PORT=' .env | cut -d= -f2)}/health" && echo
