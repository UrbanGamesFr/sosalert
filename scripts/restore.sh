#!/usr/bin/env bash
# Restaure une sauvegarde chiffrée. ÉCRASE la base actuelle.
# Usage : bash scripts/restore.sh backups/sosalert-AAAAMMJJ-HHMMSS.sql.gz.enc
set -euo pipefail
cd "$(dirname "$0")/.."
F="${1:?Fichier de sauvegarde attendu}"
PASS=$(grep ^BACKUP_PASSPHRASE= .env | cut -d= -f2-)
read -r -p "Cela remplace TOUTES les données actuelles par $F. Taper RESTAURER pour confirmer : " ok
[ "$ok" = "RESTAURER" ] || { echo "Annulé."; exit 1; }
docker compose stop api worker
docker compose exec -T db psql -U sosalert -d postgres -c "DROP DATABASE IF EXISTS sosalert WITH (FORCE);" -c "CREATE DATABASE sosalert OWNER sosalert;"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "pass:$PASS" -in "$F" | gunzip | docker compose exec -T db psql -q -U sosalert -d sosalert
docker compose start api worker
echo "Restauration terminée."
