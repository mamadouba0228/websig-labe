#!/usr/bin/env bash
# Installation du WebSIG de Labé sur un VPS Ubuntu (OVH ou autre), en une fois.
#
#   sudo bash installer.sh <domaine> <e-mail de l'administrateur> [chemin/vers/labe.dump]
#
#   <domaine>   : nom pointant vers le serveur, ex. sig-labe.org, ou le nom fourni par OVH
#                 (ex. vps-1a2b3c4d.vps.ovh.net) si vous n'avez pas encore de domaine.
#   labe.dump   : copie de la base du poste (scripts/exporter_base.ps1). Sans ce fichier, la base est
#                 créée à partir des données de référence du dépôt (sans vos modifications QGIS ni comptes).
#
# Ce que fait le script : mises à jour, pare-feu (SSH, HTTP, HTTPS), mémoire d'échange, Docker,
# récupération du projet dans /opt/websig-labe, fichier .env avec des mots de passe neufs,
# restauration de la base, démarrage, sauvegarde automatique chaque nuit.
# On peut le relancer sans risque : il ne remplace ni le .env ni une base déjà en place.
set -euo pipefail

DOMAINE="${1:-}"
EMAIL="${2:-}"
DUMP="${3:-}"
DEPOT="https://github.com/mamadouba0228/websig-labe.git"
DOSSIER="/opt/websig-labe"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)

etape() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
erreur() { printf '\n\033[1;31mErreur : %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || erreur "lancez le script avec sudo."
[ -n "$DOMAINE" ] && [ -n "$EMAIL" ] || erreur "usage : sudo bash installer.sh <domaine> <e-mail admin> [labe.dump]"
[ -z "$DUMP" ] || [ -f "$DUMP" ] || erreur "fichier introuvable : $DUMP"
[ -z "$DUMP" ] || DUMP="$(readlink -f "$DUMP")"

etape "Mises à jour du système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ca-certificates curl git ufw fail2ban unattended-upgrades openssl

etape "Pare-feu : seuls SSH, HTTP et HTTPS sont ouverts"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

if ! swapon --show | grep -q .; then
  etape "Mémoire d'échange de 2 Go (sécurité pour GeoServer)"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v docker >/dev/null; then
  etape "Installation de Docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

etape "Récupération du projet dans $DOSSIER"
if [ -d "$DOSSIER/.git" ]; then
  git -C "$DOSSIER" pull --ff-only
else
  git clone "$DEPOT" "$DOSSIER"
fi
cd "$DOSSIER"

NOUVEL_ENV=0
if [ ! -f .env ]; then
  etape "Création du fichier .env (mots de passe neufs)"
  mdp() { openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20; }
  ADMIN_MDP="$(mdp)7a"
  cat > .env <<EOF
# Serveur en ligne — mots de passe générés à l'installation, à conserver en lieu sûr
POSTGRES_DB=labe
POSTGRES_USER=labe
POSTGRES_PASSWORD=$(mdp)
GEOSERVER_ADMIN_USER=admin
GEOSERVER_ADMIN_PASSWORD=$(mdp)
# Premier compte administrateur de l'application (créé seulement si la base n'en a aucun)
APP_ADMIN_EMAIL=$EMAIL
APP_ADMIN_PASSWORD=$ADMIN_MDP
DB_PORT=5433
WEB_PORT=8080
DOMAINE=$DOMAINE
EOF
  chmod 600 .env
  NOUVEL_ENV=1
else
  grep -q '^DOMAINE=' .env || echo "DOMAINE=$DOMAINE" >> .env
fi
set -a; . ./.env; set +a

etape "Démarrage de la base de données"
"${COMPOSE[@]}" up -d db
until "${COMPOSE[@]}" exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do sleep 2; done

DEJA=$("${COMPOSE[@]}" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT to_regclass('ref.quartiers') IS NOT NULL")
if [ -n "$DUMP" ] && [ "$DEJA" = "t" ]; then
  echo "La base contient déjà des données : restauration ignorée (pour la remplacer, voir le guide)."
elif [ -n "$DUMP" ]; then
  etape "Restauration de la base du poste ($DUMP)"
  "${COMPOSE[@]}" cp "$DUMP" db:/tmp/labe.dump
  # Base neuve : on retire les schémas vides créés à l'initialisation (db/init), la copie les recrée à l'identique.
  "${COMPOSE[@]}" exec -T db psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA IF EXISTS contrib, ref CASCADE" 2>/dev/null
  # --no-owner : les objets appartiennent à l'utilisateur du serveur
  "${COMPOSE[@]}" exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges /tmp/labe.dump \
    || erreur "la restauration de la base a échoué (voir les messages ci-dessus)."
  "${COMPOSE[@]}" exec -T db rm -f /tmp/labe.dump
  "${COMPOSE[@]}" exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
    "SELECT 'bâtiments : ' || count(*) FROM ref.batiments UNION ALL SELECT 'comptes : ' || count(*) FROM app.utilisateurs"
fi

etape "Démarrage de tous les services (première fois : quelques minutes)"
"${COMPOSE[@]}" up -d --build
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'

etape "Sauvegarde automatique chaque nuit à 2 h 30 (14 jours gardés)"
chmod +x scripts/serveur/*.sh
echo "30 2 * * * root $DOSSIER/scripts/serveur/sauvegarder.sh >> /var/log/websig-sauvegarde.log 2>&1" > /etc/cron.d/websig-labe

etape "Vérification"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "https://$DOMAINE/"; then OK=1; break; fi
  sleep 5
done
if [ "${OK:-0}" = 1 ]; then
  echo "Le site répond en HTTPS : https://$DOMAINE/"
else
  echo "Le site ne répond pas encore en HTTPS. Vérifiez que le domaine pointe bien vers l'adresse IP de ce serveur,"
  echo "puis regardez : cd $DOSSIER && docker compose -f docker-compose.yml -f docker-compose.prod.yml logs caddy"
fi

cat <<EOF

=====================================================================
 WebSIG de Labé installé
   Accueil        : https://$DOMAINE/
   Carte publique : https://$DOMAINE/carte.html
   Espace agents  : https://$DOMAINE/espace.html
   Administration : https://$DOMAINE/admin.html
 Mots de passe du serveur : $DOSSIER/.env (sudo cat $DOSSIER/.env)
EOF
if [ "$NOUVEL_ENV" = 1 ] && [ -z "$DUMP" ]; then
  echo " Compte administrateur : $EMAIL / $ADMIN_MDP  (à changer dans « Mon compte »)"
elif [ -n "$DUMP" ]; then
  echo " Comptes : ceux de votre poste (même e-mail, même mot de passe qu'en local)"
fi
echo "====================================================================="
