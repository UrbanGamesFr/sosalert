# SOSAlert : mise en production et exploitation

Phase A : application web installable (PWA) + backend. Un seul VPS.

## Architecture

| Service | Rôle |
| --- | --- |
| `caddy` | HTTPS automatique (Let's Encrypt), seul service exposé (ports 80/443) |
| `api` | Application web, pages des contacts, API |
| `worker` | File d'envoi (e-mail, push), échéances de trajet, rétention des données. Processus séparé : si l'API tombe, les échéances continuent d'être surveillées |
| `db` | PostgreSQL 16, volume `dbdata` |

## 1. Prérequis (à faire par toi)

1. VPS Ubuntu 24.04, 2 vCPU / 4 Go / 40 Go, région UE, accès SSH par clé.
2. Boîte e-mail IONOS `alerte@alert.escapegameurbain.com` (ou autre) et son mot de passe.
3. DNS IONOS, zone `escapegameurbain.com` :
   - `alert` type A : IP du VPS (remplace 217.160.0.161).
   - `alert` type AAAA : IPv6 du VPS, ou **supprimer** l'AAAA actuel (sinon une partie des visiteurs arrive encore chez IONOS).
   - `www.alert` : supprimer ou pointer aussi vers le VPS.
   - Ne pas toucher MX, TXT (SPF) ni les CNAME DKIM : ils servent à l'envoi d'e-mails.
   - Si IONOS refuse la modification (enregistrements « Webhosting » verrouillés), dans Domaines et SSL > alert.escapegameurbain.com > Utilisation, choisir « Autre / Personnalisé » au lieu de « Espace web ».

## 2. Installation (15 minutes)

```bash
ssh root@IP_DU_VPS
git clone https://github.com/PROPRIETAIRE/sosalert.git /opt/sosalert
cd /opt/sosalert
cp .env.example .env && nano .env      # renseigner SMTP_PASS (et le domaine si différent)
bash scripts/install.sh
```

Le script : pare-feu, mises à jour automatiques de sécurité, Docker, génération des secrets (base, clés push, sauvegardes), construction, démarrage, sauvegarde quotidienne à 3 h 17.

Vérification : `https://alert.escapegameurbain.com/healthz` doit répondre `"ok":true`.

**Copie immédiatement `BACKUP_PASSPHRASE` (dans `.env`) dans ton gestionnaire de mots de passe.** Sans elle, les sauvegardes sont illisibles.

## 3. Recette après installation (20 minutes, sur ton Android)

1. Créer un compte, confirmer l'e-mail (vérifier qu'il n'arrive pas en spam).
2. Inviter une 2e adresse e-mail à toi, accepter depuis l'e-mail, activer les notifications sur ce 2e navigateur.
3. Réglages > Activer les notifications.
4. SOS : maintenir, laisser partir. Contrôler : e-mail reçu, notification reçue, page de l'alerte avec la bonne position, bouton « J'ai vu » répercuté dans l'app.
5. Clôturer : le contact reçoit « en sécurité ».
6. Trajet 1 min + 1 min de grâce, **fermer l'application**, attendre 3 min : l'alerte doit partir quand même (contrôle de l'échéance côté serveur).
7. Réglages > Télécharger mes données : le fichier contient bien alertes et positions.

## 4. Mises à jour

```bash
cd /opt/sosalert && bash scripts/update.sh
```
Sauvegarde, `git pull`, reconstruction, redémarrage, contrôle `/healthz`. Coupure de quelques secondes.

## 5. Sauvegardes

- Quotidiennes, chiffrées (AES-256), 14 jours gardés dans `/opt/sosalert/backups`.
- **Une sauvegarde qui reste sur le même serveur ne protège pas d'une perte du serveur.** Copie hebdomadaire hors serveur obligatoire, par exemple depuis ton ordinateur :
  `scp root@IP_DU_VPS:/opt/sosalert/backups/$(ssh root@IP_DU_VPS 'ls -t /opt/sosalert/backups | head -1') .`
  Ou activer l'option de sauvegarde/snapshot du fournisseur du VPS.
- Restauration : `bash scripts/restore.sh backups/FICHIER.enc`. **À tester une fois avant l'ouverture** (scénario R-14 du cahier des charges).

## 6. Supervision

- Créer une sonde gratuite (UptimeRobot, Better Stack…) sur `https://alert.escapegameurbain.com/healthz`, toutes les 5 min, alerte par SMS/e-mail.
- `/healthz` renvoie 503 si la base ne répond pas **ou si le worker est arrêté depuis plus de 2 minutes** : c'est le cas le plus grave, car plus aucune alerte ni échéance n'est traitée.
- Journaux : `docker compose logs -f --tail=200 api worker`.

## 7. Incidents courants

| Symptôme | Cause probable | Action |
| --- | --- | --- |
| `/healthz` 503, `workerHeartbeatAgeS` élevé | Worker planté | `docker compose restart worker` puis lire `docker compose logs worker` |
| E-mails en échec (« Échec » dans le détail d'une alerte) | Mot de passe SMTP, limite d'envoi IONOS | Vérifier `.env`, `docker compose logs worker`, limites de l'offre IONOS |
| Certificat HTTPS absent | DNS pas encore propagé, ports 80/443 fermés | `dig alert.escapegameurbain.com`, `ufw status`, `docker compose logs caddy` |
| Notifications non reçues sur iPhone | App non installée sur l'écran d'accueil | Comportement d'iOS, voir limites |

## 8. Limites connues de la phase A

- **iPhone** : Safari coupe le GPS quand l'écran est verrouillé. Le serveur déclenche bien l'alerte à l'échéance, mais avec la dernière position reçue, qui peut dater. Les notifications ne fonctionnent que si l'app est installée sur l'écran d'accueil. Correction : app native (phase B).
- **E-mail IONOS** : pas de suivi de délivrabilité (« envoyé » = accepté par le serveur SMTP IONOS). Passer à un service transactionnel = remplacer `server/src/mailer.js`.
- **Pas de SMS** en phase A.
- **Pas de console d'administration** : les opérations se font en base (`docker compose exec db psql -U sosalert`).
- **Documents juridiques** (`/conditions.html`, `/confidentialite.html`) : brouillons à faire valider. AIPD à réaliser (traitement de géolocalisation).

## 9. Développement local

```bash
cd server && npm install
createdb sosalert && DATABASE_URL=postgres://localhost/sosalert node src/server.js   # API + app, e-mails affichés dans la console
DATABASE_URL=postgres://localhost/sosalert node src/worker.js
DATABASE_URL=postgres://localhost/sosalert_test npm test                          # base dédiée, effacée à chaque run
```
