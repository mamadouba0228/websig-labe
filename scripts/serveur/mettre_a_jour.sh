#!/usr/bin/env bash
# Met le serveur à jour avec la dernière version du dépôt GitHub (code et pages) :
#   sudo /opt/websig-labe/scripts/serveur/mettre_a_jour.sh
# Une sauvegarde de la base est faite avant. Les données de la base ne sont pas touchées.
set -euo pipefail
cd /opt/websig-labe
./scripts/serveur/sauvegarder.sh
git pull --ff-only
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
# Nginx garde l'adresse interne de l'API connue à son démarrage : on le relance si l'API a été recréée.
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart web
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps geoserver-init > /dev/null
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps --format 'table {{.Service}}\t{{.Status}}'
echo "Mise à jour terminée."
