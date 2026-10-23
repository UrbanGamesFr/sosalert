# SOSAlert

Application d'alertes géolocalisées vers des contacts de confiance.
Propriété de SAS HEVEA COMMUNICATION. Code privé.

## Contenu

- `server/` : backend Node.js (Fastify, PostgreSQL), worker d'envoi, application web installable (`server/public`).
- `docker-compose.yml`, `Caddyfile` : déploiement sur un VPS avec HTTPS automatique.
- `scripts/` : installation, mise à jour, sauvegarde chiffrée, restauration.
- `RUNBOOK.md` : **procédure de mise en production et d'exploitation, à lire en premier.**

## Fonctions (phase A)

| Fonction | Exigences CDC |
| --- | --- |
| Compte, vérification e-mail, mot de passe oublié, sessions révocables | F-001 à F-004 |
| Export JSON et suppression du compte | F-005 |
| Contacts invités par e-mail, acceptation explicite, sans compte ni app pour le contact, désinscription | F-010 à F-014 |
| SOS par appui maintenu + 5 s annulables, type, message, position horodatée | F-020 à F-022 |
| Alerte enregistrée avant envoi, clé d'idempotence, file locale si hors réseau | F-023, F-027, R-09 |
| Statuts par destinataire et par canal, reprises, accusé de lecture, clôture | F-024, F-025, F-028, F-033 à F-035 |
| Position mise à jour pendant une alerte ouverte, fraîcheur affichée | F-040, F-042, F-044 |
| Partage ponctuel par lien expirant et révocable | F-041 |
| Trajet à échéance **vérifiée côté serveur**, rappel, délai de grâce, alerte automatique | F-050 à F-058 |
| Journal d'activité, rétention automatique | F-077, 6.3 |

Hors phase A : SMS, application native (GPS en arrière-plan iPhone), portail professionnel, console d'administration.

## Tests

`cd server && DATABASE_URL=postgres://… npm test` : scénarios de recette R-01 à R-09, R-12, R-13 sur une vraie base.
