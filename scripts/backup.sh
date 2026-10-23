#!/usr/bin/env bash
# Sauvegarde chiffrée de la base. Garde 14 jours en local.
# Une copie HORS du serveur est indispensable (voir RUNBOOK.md, section Sauvegardes).
set -euo pipefail
cd "$(dirname "$0")/.."
PASS=$(grep ^BACKUP_PASSPHRASE= .env | cut -d= -f2-)
[ -n "$PASS" ] || { echo "BACKUP_PASSPHRASE vide dans .env"; exit 1; }
mkdir -p backups && chmod 700 backups
F="backups/sosalert-$(date +%Y%m%d-%H%M%S).sql.gz.enc"
docker compose exec -T db pg_dump -U sosalert -d sosalert --no-owner \
  | gzip -9 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "pass:$PASS" -out "$F"
# Contrôle : l'archive se déchiffre et se décompresse
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "pass:$PASS" -in "$F" | gunzip | head -c 100 >/dev/null
find backups -name 'sosalert-*.enc' -mtime +14 -delete
echo "$(date -Is) sauvegarde OK : $F ($(du -h "$F" | cut -f1))"
