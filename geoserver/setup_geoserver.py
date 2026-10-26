"""
Configure GeoServer via son API REST (idempotent : peut être relancé sans risque).

- espace de travail « labe »
- entrepôts PostGIS « ref » (données de référence) et « contrib » (contributions validées)
- publication des couches et des styles SLD du dossier styles/
"""
import os
import sys
import time
from pathlib import Path

import requests

GS = "http://geoserver:8080/geoserver"
REST = GS + "/rest"
AUTH = (os.environ["GEOSERVER_ADMIN_USER"], os.environ["GEOSERVER_ADMIN_PASSWORD"])
WS = "labe"
STYLES_DIR = Path(__file__).parent / "styles"

# couche -> (entrepôt, titre, style)
LAYERS = {
    "limite_commune": ("ref", "Limite de la commune urbaine", "labe_limite"),
    "quartiers": ("ref", "Quartiers", "labe_quartiers"),
    "batiments": ("ref", "Bâti", "labe_batiments"),
    "routes": ("ref", "Voirie", "labe_routes"),
    "cours_eau": ("ref", "Cours d'eau", "labe_cours_eau"),
    "surface_eau": ("ref", "Surfaces en eau", None),
    "vegetation": ("ref", "Zones boisées", None),
    "cimetieres": ("ref", "Cimetières", None),
    "terrains_sport": ("ref", "Terrains de sport", None),
    "aerodrome": ("ref", "Piste de l'aéroport", None),
    "equipements": ("ref", "Équipements (OSM)", None),
    "contributions_points": ("contrib", "Contributions validées — points", None),
    "contributions_lignes": ("contrib", "Contributions validées — lignes", None),
    "contributions_surfaces": ("contrib", "Contributions validées — surfaces", None),
    "voies_publiques": ("adr", "Adressage — voies", "labe_voies"),
    "adresses_publiques": ("adr", "Adressage — adresses validées", "labe_adresses"),
}

s = requests.Session()
s.auth = AUTH


def wait_geoserver():
    for _ in range(90):
        try:
            if s.get(REST + "/about/version.json", timeout=5).ok:
                return
        except requests.RequestException:
            pass
        time.sleep(5)
    sys.exit("GeoServer ne répond pas.")


def exists(url):
    return s.get(url, headers={"Accept": "application/json"}).status_code == 200


def check(r, what):
    if not r.ok:
        sys.exit(f"Échec {what} : {r.status_code} {r.text[:300]}")


def main():
    wait_geoserver()
    print("GeoServer prêt.")

    # URL publique déduite des en-têtes du proxy Nginx (fonctionne en local et sur le réseau)
    r = s.get(REST + "/settings.json")
    check(r, "lecture des paramètres")
    settings = r.json()
    settings["global"]["settings"]["proxyBaseUrl"] = "${X-Forwarded-Proto}://${X-Forwarded-Host}/geoserver"
    settings["global"]["useHeadersProxyURL"] = True
    settings["global"]["settings"]["numDecimals"] = 6  # ~10 cm (défaut 4 ≈ 11 m)
    check(s.put(REST + "/settings", json=settings), "paramètres du proxy")

    if not exists(f"{REST}/workspaces/{WS}"):
        check(s.post(REST + "/workspaces", json={"workspace": {"name": WS}}), "espace de travail")
        print("Espace de travail créé.")

    for store, schema in (("ref", "ref"), ("contrib", "contrib"), ("adr", "adr")):
        body = {"dataStore": {
            "name": store, "type": "PostGIS",
            "connectionParameters": {"entry": [
                {"@key": "dbtype", "$": "postgis"},
                {"@key": "host", "$": "db"},
                {"@key": "port", "$": "5432"},
                {"@key": "database", "$": os.environ["POSTGRES_DB"]},
                {"@key": "schema", "$": schema},
                {"@key": "user", "$": os.environ["POSTGRES_USER"]},
                {"@key": "passwd", "$": os.environ["POSTGRES_PASSWORD"]},
                {"@key": "Expose primary keys", "$": "true"},
                {"@key": "Estimated extends", "$": "false"},
            ]}}}
        url = f"{REST}/workspaces/{WS}/datastores"
        if exists(f"{url}/{store}"):
            check(s.put(f"{url}/{store}", json=body), f"entrepôt {store}")
        else:
            check(s.post(url, json=body), f"entrepôt {store}")
    print("Entrepôts PostGIS configurés.")

    for sld in sorted(STYLES_DIR.glob("*.sld")):
        name = sld.stem
        hdr = {"Content-Type": "application/vnd.ogc.sld+xml"}
        url = f"{REST}/workspaces/{WS}/styles"
        if exists(f"{url}/{name}"):
            r = s.put(f"{url}/{name}", data=sld.read_bytes(), headers=hdr)
        else:
            r = s.post(url, params={"name": name}, data=sld.read_bytes(), headers=hdr)
        check(r, f"style {name}")
    print("Styles chargés.")

    for layer, (store, title, style) in LAYERS.items():
        ft_url = f"{REST}/workspaces/{WS}/datastores/{store}/featuretypes"
        if not exists(f"{ft_url}/{layer}"):
            r = s.post(ft_url, json={"featureType": {
                "name": layer, "nativeName": layer, "title": title, "srs": "EPSG:4326",
                "projectionPolicy": "FORCE_DECLARED"}})
            check(r, f"couche {layer}")
        if style:
            r = s.put(f"{REST}/layers/{WS}:{layer}",
                      json={"layer": {"defaultStyle": {"name": style, "workspace": WS}}})
            check(r, f"style de {layer}")
        print(f"  couche {WS}:{layer}")

    print("Configuration GeoServer terminée.")


if __name__ == "__main__":
    main()
