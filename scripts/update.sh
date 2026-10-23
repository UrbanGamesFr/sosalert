#!/usr/bin/env bash
# Mise à jour : sauvegarde, récupération du code, reconstruction, redémarrage.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/backup.sh
git pull --ff-only
docker compose build
docker compose up -d
sleep 6
curl -fsS "https://$(grep ^DOMAIN= .env | cut -d= -f2)/healthz" && echo && echo "Mise à jour OK"
