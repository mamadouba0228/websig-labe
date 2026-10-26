#!/bin/sh
# Charge les données de référence (GeoJSON découpés sur la commune) dans le schéma « ref ».
# Ne recharge rien si les tables existent déjà, sauf si FORCE_IMPORT=1
# (les modifications faites dans la base, par ex. depuis QGIS, sont ainsi préservées).
set -e

PG="PG:host=db port=5432 dbname=$POSTGRES_DB user=$POSTGRES_USER password=$POSTGRES_PASSWORD"

if [ "$FORCE_IMPORT" != "1" ] && ogrinfo -ro -so "$PG" ref.quartiers >/dev/null 2>&1; then
    echo "Données de référence déjà présentes : import ignoré (FORCE_IMPORT=1 pour réimporter)."
    exit 0
fi

for f in limite_commune quartiers routes cours_eau surface_eau vegetation cimetieres \
         terrains_sport aerodrome equipements batiments; do
    echo "Import de $f..."
    ogr2ogr -f PostgreSQL "$PG" "/data/$f.geojson" \
        -nln "ref.$f" -overwrite \
        -lco GEOMETRY_NAME=geom -lco FID=gid -lco SPATIAL_INDEX=GIST \
        -t_srs EPSG:4326
done

echo "Import terminé."
