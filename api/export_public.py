"""
Exporte les données publiques (référence + contributions validées) en fichiers statiques
pour la carte publique hébergée sur GitHub Pages.

    docker compose run --rm export        → écrit dans data/public/

Seules les informations publiques sont exportées : ni comptes, ni contacts, ni photos,
ni contributions en attente ou rejetées.
"""
import json
import os
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from main import DSN, compute_stats

OUT = Path(os.environ.get("EXPORT_DIR", "/out"))

# couche -> colonnes publiées
LAYERS = {
    "limite_commune": "name, area_km2",
    "quartiers": "nom, superficie_km2, nb_batiments",
    "routes": "nature, nom, numero, cl_admin",
    "cours_eau": "nom, regime",
    "surface_eau": "nature",
    "vegetation": "nature, nom",
    "cimetieres": "nom, nature",
    "terrains_sport": "nature",
    "aerodrome": "nature",
    "equipements": "categorie, nom, nature",
    "batiments": "nature",
}


def feature_collection(cur, sql: str, precision: int) -> dict:
    cur.execute(f"""
        SELECT json_build_object('type', 'FeatureCollection', 'features', COALESCE(json_agg(
                 json_build_object('type', 'Feature',
                                   'geometry', ST_AsGeoJSON(t.geom, {precision})::json,
                                   'properties', to_jsonb(t) - 'geom') ORDER BY t.ordre), '[]'::json)) AS fc
        FROM ({sql}) t""")
    return cur.fetchone()["fc"]


def write(name: str, data):
    path = OUT / name
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  {name:32s} {path.stat().st_size / 1024:8.0f} Ko")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with psycopg.connect(DSN, row_factory=dict_row) as con, con.cursor() as cur:
        cur.execute("SELECT column_name, table_name FROM information_schema.columns WHERE table_schema = 'ref'")
        existing = {}
        for r in cur.fetchall():
            existing.setdefault(r["table_name"], set()).add(r["column_name"])
        for layer, cols in LAYERS.items():
            keep = [c.strip() for c in cols.split(",") if c.strip() in existing.get(layer, set())]
            cols_sql = "".join(c + ", " for c in keep)
            sql = f"SELECT gid AS ordre, {cols_sql}geom FROM ref.{layer}"
            fc = feature_collection(cur, sql, 5 if layer == "batiments" else 6)
            for f in fc["features"]:
                f["properties"].pop("ordre", None)
            write(f"{layer}.geojson", fc)

        fc = feature_collection(cur, """
            SELECT id AS ordre, id, categorie, type, nom, description, quartier, statut,
                   to_char(cree_le, 'YYYY-MM-DD') AS date, geom
            FROM contrib.contributions WHERE statut IN ('Validé', 'Traité')""", 6)
        for f in fc["features"]:
            f["properties"].pop("ordre", None)
        write("contributions.geojson", fc)

        # Adressage : toutes les voies, adresses validées ou posées uniquement
        cur.execute("SELECT to_regclass('adr.voies') IS NOT NULL AS ok")
        if cur.fetchone()["ok"]:
            fc = feature_collection(cur, """
                SELECT id AS ordre, code, type_voie, nom, statut_nom, quartier, libelle, geom
                FROM adr.voies_publiques""", 6)
            for f in fc["features"]:
                f["properties"].pop("ordre", None)
            write("voies.geojson", fc)
            fc = feature_collection(cur, """
                SELECT id AS ordre, num, cote, quartier, statut, code_voie, libelle, geom
                FROM adr.adresses_publiques""", 6)
            for f in fc["features"]:
                f["properties"].pop("ordre", None)
            write("adresses.geojson", fc)
        write("stats.json", compute_stats(cur))
    print("Export terminé.")


if __name__ == "__main__":
    main()
