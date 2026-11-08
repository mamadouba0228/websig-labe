#!/usr/bin/env bash
# Sauvegarde de la base du serveur (lancée chaque nuit par /etc/cron.d/websig-labe, ou à la main) :
#   sudo /opt/websig-labe/scripts/serveur/sauvegarder.sh
# Fichiers : /opt/sauvegardes-labe/labe-AAAA-MM-JJ.dump (14 derniers jours gardés).
# Pour en récupérer une sur le poste : scp ubuntu@<serveur>:/opt/sauvegardes-labe/<fichier> .
set -euo pipefail
DOSSIER="/opt/websig-labe"
CIBLE="/opt/sauvegardes-labe"
mkdir -p "$CIBLE"
chmod 700 "$CIBLE"
cd "$DOSSIER"
set -a; . ./.env; set +a
FICHIER="$CIBLE/labe-$(date +%F).dump"
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$FICHIER.tmp"
mv "$FICHIER.tmp" "$FICHIER"
find "$CIBLE" -name 'labe-*.dump' -mtime +14 -delete
echo "$(date '+%F %T') sauvegarde : $FICHIER ($(du -h "$FICHIER" | cut -f1))"
