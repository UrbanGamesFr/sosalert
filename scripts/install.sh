#!/usr/bin/env bash
# Installation initiale de SOSAlert sur un VPS Ubuntu 24.04 neuf.
# Usage (en root, depuis le dossier du dépôt cloné) : sudo bash scripts/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/6 Mises à jour système et pare-feu"
apt-get update -y && apt-get upgrade -y
apt-get install -y ca-certificates curl ufw unattended-upgrades openssl
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw --force enable
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "== 2/6 Docker (script officiel get.docker.com)"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "== 3/6 Fichier .env"
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
fi
set_var() { # remplit une variable vide, ne touche jamais une valeur existante
  local k="$1" v="$2"
  if grep -qE "^${k}=$" .env; then sed -i "s|^${k}=$|${k}=${v}|" .env; fi
}
set_var POSTGRES_PASSWORD "$(openssl rand -hex 24)"
set_var BACKUP_PASSPHRASE "$(openssl rand -hex 32)"

echo "== 4/6 Construction de l'image"
docker compose build

if grep -qE "^VAPID_PUBLIC_KEY=$" .env; then
  KEYS=$(docker compose run --rm --no-deps api node -e "const k=require('web-push').generateVAPIDKeys();console.log(k.publicKey+' '+k.privateKey)")
  set_var VAPID_PUBLIC_KEY "$(echo "$KEYS" | awk '{print $1}')"
  set_var VAPID_PRIVATE_KEY "$(echo "$KEYS" | awk '{print $2}')"
fi

echo "== 5/6 Vérification de la configuration"
if grep -qE "^SMTP_PASS=$" .env; then
  echo "!! SMTP_PASS est vide : éditez .env (nano .env) pour y mettre le mot de passe de la boîte IONOS, puis relancez ce script."
  exit 1
fi

echo "== 6/6 Démarrage"
docker compose up -d
sleep 8
docker compose ps

# Sauvegarde quotidienne à 3 h 17
CRON="17 3 * * * cd $(pwd) && bash scripts/backup.sh >> /var/log/sosalert-backup.log 2>&1"
( crontab -l 2>/dev/null | grep -v 'scripts/backup.sh' ; echo "$CRON" ) | crontab -

echo
echo "Installation terminée. Vérifiez : https://$(grep ^DOMAIN= .env | cut -d= -f2)/healthz"
echo "IMPORTANT : copiez BACKUP_PASSPHRASE (dans .env) dans votre gestionnaire de mots de passe."
