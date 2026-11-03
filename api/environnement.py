"""
Protection de l'environnement : zones protégées, atteintes, arbres et reboisement, sources et points d'eau, feux.

- Zones protégées : berges des cours d'eau, bas-fonds, pentes fortes et boisements calculés à partir des données
  de référence et du relief ; périmètres des sources créés avec les points d'eau ; forêts classées, espaces verts,
  zones de reboisement dessinés. Chaque zone a une règle (protection intégrale, inconstructible, sous conditions)
  qui alimente les contrôles du foncier.
- Atteintes : Signalée → Constatée → Mise en demeure → Sanctionnée / Remise en état → Close (ou Classée sans suite).
  La personne mise en cause n'est visible que du service de l'environnement et des superviseurs.
- Plantations et suivis de survie ; points d'eau et constats (débit, tarissement, pollution) ; feux de brousse
  (saisie sur le terrain ou import des détections satellite NASA FIRMS).
"""
import csv
import datetime as dt
import gzip
import io
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from dechets import csv_reponse, iso, quartier_de
from main import check_geometry, current_user, cursor, decode_photo, historiser, journal

router = APIRouter(prefix="/environnement")

SERVICES_ENV = ("Environnement et cadre de vie", "Hygiène et salubrité")
RELIEF = Path("/relief")
TYPES_ZONE = ["Berge de cours d'eau", "Périmètre de source", "Bas-fond / zone humide", "Pente forte", "Forêt classée",
              "Boisement", "Espace vert", "Zone de reboisement", "Autre"]
REGLES = ["Protection intégrale", "Inconstructible", "Constructible sous conditions"]
STRICTES = ("Protection intégrale", "Inconstructible")
TYPES_ATTEINTE = ["Coupe abusive d'arbres", "Feu de brousse", "Extraction de sable ou de gravier",
                  "Construction ou occupation de berge", "Rejet d'eaux usées",
                  "Pollution d'une source ou d'un cours d'eau", "Érosion / ravinement", "Carrière sauvage", "Autre"]
STATUTS = ["Signalée", "Constatée", "Mise en demeure", "Sanctionnée", "Remise en état", "Close", "Classée sans suite"]
OUVERTS = ("Signalée", "Constatée", "Mise en demeure", "Sanctionnée")
GRAVITES = ["Faible", "Moyenne", "Grave"]
TYPES_PLANTATION = ["Arbres d'alignement", "Reboisement", "Haie vive", "Verger communautaire", "Arbre isolé", "Espace vert"]
ETATS_SUIVI = ["Bon", "Moyen", "Mauvais"]
TYPES_EAU = ["Source", "Puits", "Forage", "Mare / retenue"]
PREFIXE_EAU = {"Source": "SO", "Puits": "PU", "Forage": "FO", "Mare / retenue": "RE"}
ETATS_EAU = ["Permanent", "Tarit en saison sèche", "Tari", "Pollué"]
CAUSES_FEU = ["Défrichement agricole", "Chasse", "Accident", "Malveillance", "Inconnue"]
# signalements de l'onglet Saisie que le service peut convertir en atteintes
SIGNALEMENTS = {"Coupe d'arbres": "Coupe abusive d'arbres", "Feu de brousse": "Feu de brousse",
                "Atteinte à l'environnement": "Autre", "Inondation / érosion": "Érosion / ravinement"}
# zones calculées : nom, type, règle par défaut
CALCULS = {
    "berges": ("Berges des cours d'eau", "Berge de cours d'eau", "Inconstructible"),
    "basfonds": ("Bas-fonds (zones inondables, aléa fort)", "Bas-fond / zone humide", "Constructible sous conditions"),
    "pentes": ("Pentes très fortes", "Pente forte", "Constructible sous conditions"),
    "forets": ("Boisements (OpenStreetMap)", "Boisement", "Inconstructible"),
}


def apply_schema(cur):
    cur.execute((Path(__file__).parent / "environnement.sql").read_text(encoding="utf-8"))


# ---------------------------------------------------------------- droits et outils
def peut_gerer(u: dict) -> bool:
    return u["role"] in ("superviseur", "admin") or u["service"] in SERVICES_ENV


def exiger_gestion(u: dict):
    if not peut_gerer(u):
        raise HTTPException(403, "Réservé au service Environnement et cadre de vie, à l'Hygiène et aux superviseurs.")


def param(cur, cle: str) -> float:
    cur.execute("SELECT env.param(%s)::float AS v", (cle,))
    return cur.fetchone()["v"]


def numero_suivant(cur, table: str, prefixe: str, largeur: int = 4) -> str:
    col = "code" if table == "env.zones" else "numero"
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (table + prefixe,))
    n = len(prefixe) + 1
    cur.execute(f"SELECT COALESCE(max(substring({col} FROM {n + 1})::int), 0) + 1 AS n FROM {table} WHERE {col} LIKE %s",
                (prefixe + "-%",))
    return f"{prefixe}-{cur.fetchone()['n']:0{largeur}d}"


def lire_geom(cur, geometry: dict | None, types=("Point", "LineString", "Polygon")) -> str:
    if not isinstance(geometry, dict) or geometry.get("type") not in types:
        raise HTTPException(400, "Forme invalide : " + ", ".join(types) + " attendu.")
    return check_geometry(cur, geometry)


def lire_surface(cur, geometry: dict | None) -> str:
    """Polygon ou MultiPolygon d'une zone protégée."""
    if not isinstance(geometry, dict) or geometry.get("type") not in ("Polygon", "MultiPolygon"):
        raise HTTPException(400, "Une zone protégée se dessine en surface.")
    gj = json.dumps({"type": geometry["type"], "coordinates": geometry.get("coordinates")})
    cur.execute("""SELECT ST_IsValid(g) AS v, ST_NPoints(g) AS n,
                          EXISTS (SELECT 1 FROM ref.limite_commune c WHERE ST_Intersects(c.geom, g)) AS dedans
                   FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326) AS g) t""", (gj,))
    r = cur.fetchone()
    if not r["v"]:
        raise HTTPException(400, "Forme invalide (les côtés se croisent ?).")
    if r["n"] > 20000:
        raise HTTPException(400, "Forme trop complexe (20 000 sommets maximum).")
    if not r["dedans"]:
        raise HTTPException(400, "La zone est en dehors de la commune.")
    return gj


def photo_reponse(cur, sql: str, *params) -> Response:
    cur.execute(sql, params)
    r = cur.fetchone()
    if not r or not r["photo"]:
        raise HTTPException(404, "Pas de photo.")
    return Response(bytes(r["photo"]), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@router.get("/listes")
def listes(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT cle, valeur::float, description FROM env.parametres ORDER BY cle")
        parametres = cur.fetchall()
        cur.execute("SELECT env.saison(current_date) AS s, fon.param('berge_cours_eau_m', 10)::float AS berge")
        r = cur.fetchone()
    return {"types_zone": TYPES_ZONE, "regles": REGLES, "types_atteinte": TYPES_ATTEINTE, "statuts": STATUTS,
            "gravites": GRAVITES, "types_plantation": TYPES_PLANTATION, "etats_suivi": ETATS_SUIVI, "types_eau": TYPES_EAU,
            "etats_eau": ETATS_EAU, "causes_feu": CAUSES_FEU, "peut_gerer": peut_gerer(u), "parametres": parametres,
            "saison": r["s"], "berge_m": r["berge"]}


# ---------------------------------------------------------------- zones protégées
ZONE_COLS = """z.id, z.code, z.type, z.nom, z.regle, z.reference, z.calcul, z.point_eau, z.superficie_ha::float, z.active,
    z.observations, z.cree_le, z.modifie_le,
    (SELECT count(*) FROM adr.batiments_points b WHERE b.p && z.geom_m AND ST_Intersects(z.geom_m, b.p))::int AS batiments"""


def feature_zone(r: dict) -> dict:
    g = r.pop("geometry")
    iso(r, "cree_le", "modifie_le")
    return {"type": "Feature", "id": r["id"], "geometry": g, "properties": r}


def une_zone(cur, zid: int) -> dict:
    cur.execute(f"SELECT {ZONE_COLS}, ST_AsGeoJSON(z.geom, 6)::json AS geometry FROM env.zones z WHERE z.id = %s", (zid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Zone introuvable.")
    return feature_zone(r)


@router.get("/zones")
def lister_zones(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute(f"""SELECT {ZONE_COLS}, ST_AsGeoJSON(ST_SimplifyPreserveTopology(z.geom, 0.00002), 6)::json AS geometry
                        FROM env.zones z ORDER BY z.active DESC, z.code""")
        return {"type": "FeatureCollection", "features": [feature_zone(r) for r in cur.fetchall()]}


@router.get("/zones/{zid}")
def lire_zone(zid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        f = une_zone(cur, zid)
        cur.execute("""SELECT COALESCE(q.quartier, '—') AS quartier, count(*)::int AS n
                       FROM env.zones z JOIN dech.bati_quartier q ON q.p && z.geom_m AND ST_Intersects(z.geom_m, q.p)
                       WHERE z.id = %s GROUP BY 1 ORDER BY 2 DESC""", (zid,))
        f["batiments_quartiers"] = cur.fetchall()
        cur.execute("""SELECT a.id, a.numero, a.type, a.statut FROM env.atteintes a, env.zones z
                       WHERE z.id = %s AND z.code = ANY (a.zones) ORDER BY a.cree_le DESC LIMIT 50""", (zid,))
        f["atteintes"] = cur.fetchall()
        cur.execute("""SELECT count(*)::int AS n FROM fon.parcelles p, env.zones z
                       WHERE z.id = %s AND p.etat <> 'Archivée' AND p.geom_m && z.geom_m AND ST_Intersects(p.geom_m, z.geom_m)""", (zid,))
        f["parcelles"] = cur.fetchone()["n"]
    return f


@router.get("/zones/{zid}/batiments")
def batiments_zone(zid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("""SELECT round(ST_X(ST_Transform(b.p, 4326))::numeric, 6)::float AS x, round(ST_Y(ST_Transform(b.p, 4326))::numeric, 6)::float AS y
                       FROM env.zones z JOIN adr.batiments_points b ON b.p && z.geom_m AND ST_Intersects(z.geom_m, b.p)
                       WHERE z.id = %s AND NOT ST_IsEmpty(b.p) LIMIT 30000""", (zid,))
        return [[r["x"], r["y"]] for r in cur.fetchall()]


class ZoneIn(BaseModel):
    geometry: dict | None = None
    type: str | None = None
    nom: str | None = Field(None, min_length=2, max_length=150)
    regle: str | None = None
    reference: str | None = Field(None, max_length=200)
    active: bool | None = None
    observations: str | None = Field(None, max_length=2000)


@router.post("/zones", status_code=201)
def creer_zone(body: ZoneIn, u: dict = Depends(current_user)):
    exiger_gestion(u)
    if body.type not in TYPES_ZONE or (body.regle and body.regle not in REGLES) or not body.nom:
        raise HTTPException(400, "Type, nom et règle de la zone requis.")
    with cursor() as cur:
        gj = lire_surface(cur, body.geometry)
        code = numero_suivant(cur, "env.zones", "ZP")
        cur.execute("""INSERT INTO env.zones (code, type, nom, regle, reference, observations, geom, cree_par)
                       VALUES (%s, %s, %s, %s, %s, %s, ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON(%s)), 4326), %s) RETURNING id""",
                    (code, body.type, body.nom, body.regle or "Inconstructible", body.reference, body.observations, gj, u["id"]))
        zid = cur.fetchone()["id"]
        journal(cur, u["id"], "création d'une zone protégée", f"zone {code}", f"{body.type} — {body.nom}")
        return une_zone(cur, zid)


@router.put("/zones/{zid}")
def modifier_zone(zid: int, body: ZoneIn, u: dict = Depends(current_user)):
    exiger_gestion(u)
    d = body.model_dump(exclude_unset=True)
    with cursor() as cur:
        cur.execute("SELECT code, calcul FROM env.zones WHERE id = %s FOR UPDATE", (zid,))
        z = cur.fetchone()
        if not z:
            raise HTTPException(404, "Zone introuvable.")
        if ("type" in d and d["type"] not in TYPES_ZONE) or ("regle" in d and d["regle"] not in REGLES):
            raise HTTPException(400, "Type ou règle invalide.")
        sets, vals = [], []
        for k in ("type", "nom", "regle", "reference", "active", "observations"):
            if k in d:
                sets.append(f"{k} = %s")
                vals.append(d[k])
        if body.geometry:
            if z["calcul"]:
                raise HTTPException(400, "Zone calculée : sa forme se met à jour par « Recalculer ».")
            sets.append("geom = ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON(%s)), 4326)")
            vals.append(lire_surface(cur, body.geometry))
        if not sets:
            raise HTTPException(400, "Rien à modifier.")
        sets.append("modifie_le = now()")
        cur.execute(f"UPDATE env.zones SET {', '.join(sets)} WHERE id = %s", vals + [zid])
        journal(cur, u["id"], "modification d'une zone protégée", f"zone {z['code']}", ", ".join(d.keys()))
        return une_zone(cur, zid)


@router.delete("/zones/{zid}")
def supprimer_zone(zid: int, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("SELECT code, calcul FROM env.zones WHERE id = %s", (zid,))
        z = cur.fetchone()
        if not z:
            raise HTTPException(404, "Zone introuvable.")
        if z["calcul"] == "source":
            raise HTTPException(400, "Périmètre d'un point d'eau : il se modifie depuis la fiche du point d'eau.")
        cur.execute("DELETE FROM env.zones WHERE id = %s", (zid,))
        journal(cur, u["id"], "suppression d'une zone protégée", f"zone {z['code']}")
    return {"ok": True}


def cellules_pente(seuil_pct: float) -> tuple[dict, list[int], list[int]]:
    """Cellules de la grille du relief (30 m) dont la pente dépasse le seuil, dans la commune."""
    try:
        meta = json.loads((RELIEF / "relief.json").read_text(encoding="utf-8"))
        raw = gzip.decompress((RELIEF / "relief.bin.gz").read_bytes())
    except OSError:
        raise HTTPException(503, "Relief indisponible : lancez d'abord le calcul du relief (docker compose --profile outils run --rm relief).")
    w, h = meta["largeur"], meta["hauteur"]
    n = w * h
    pente, hand = raw[2 * n:3 * n], raw[3 * n:4 * n]
    lim = seuil_pct * 2                        # pente stockée en demi-pourcents
    ii, jj = [], []
    for k in range(n):
        if pente[k] >= lim and hand[k] != 255:
            ii.append(k % w)
            jj.append(k // w)
    return meta, ii, jj


@router.post("/zones/calculer/{quoi}")
def calculer_zone(quoi: str, u: dict = Depends(current_user)):
    """(Re)calcule une zone à partir des données de référence ; garde la règle et l'état choisis par le service."""
    exiger_gestion(u)
    if quoi not in CALCULS:
        raise HTTPException(404, "Calcul inconnu.")
    nom, type_, regle = CALCULS[quoi]
    with cursor() as cur:
        smin = param(cur, "surface_min_ha") * 10000
        if quoi == "berges":
            berge = float(cur.execute("SELECT fon.param('berge_cours_eau_m', 10)::float AS b").fetchone()["b"])
            nom = f"{nom} ({berge:g} m)"
            cur.execute("""SELECT ST_AsEWKB(ST_Transform(ST_Union(ST_Buffer(ST_Transform(geom, 32628), %s, 'quad_segs=4')), 4326)) AS g
                           FROM ref.cours_eau""", (berge,))
        elif quoi == "basfonds":
            cur.execute("""SELECT ST_AsEWKB(ST_Union(g)) AS g FROM (SELECT (ST_Dump(geom)).geom AS g FROM ref.zones_inondables
                           WHERE alea = 'Fort') t WHERE ST_Area(ST_Transform(g, 32628)) >= %s""", (smin,))
        elif quoi == "forets":
            cur.execute("SELECT ST_AsEWKB(ST_Union(geom)) AS g FROM ref.vegetation")
        else:
            seuil = param(cur, "pente_forte_pct")
            nom = f"{nom} (plus de {seuil:g} %)"
            meta, ii, jj = cellules_pente(seuil)
            if not ii:
                raise HTTPException(400, "Aucune pente au-dessus du seuil.")
            cur.execute("""WITH c AS (
                               SELECT ST_MakeEnvelope(%(x0)s + (i - 0.5) * %(dx)s, %(y0)s + (j + 0.5) * %(dy)s,
                                                      %(x0)s + (i + 0.5) * %(dx)s, %(y0)s + (j - 0.5) * %(dy)s, 4326) AS g
                               FROM unnest(%(i)s::int[], %(j)s::int[]) t(i, j)),
                           parts AS (SELECT (ST_Dump(ST_Union(g))).geom AS g FROM c)
                           SELECT ST_AsEWKB(ST_Union(g)) AS g FROM parts WHERE ST_Area(ST_Transform(g, 32628)) >= %(smin)s""",
                        {"x0": meta["x0"], "y0": meta["y0"], "dx": meta["dx"], "dy": meta["dy"], "i": ii, "j": jj, "smin": smin})
        g = cur.fetchone()["g"]
        if g is None:
            raise HTTPException(400, "Aucune zone à créer avec les données disponibles.")
        cur.execute("SELECT id FROM env.zones WHERE calcul = %s", (quoi,))
        r = cur.fetchone()
        if r:
            cur.execute("UPDATE env.zones SET geom = %s::geometry, nom = %s, modifie_le = now() WHERE id = %s", (g, nom, r["id"]))
            zid = r["id"]
        else:
            code = numero_suivant(cur, "env.zones", "ZP")
            cur.execute("""INSERT INTO env.zones (code, type, nom, regle, calcul, geom, cree_par)
                           VALUES (%s, %s, %s, %s, %s, %s::geometry, %s) RETURNING id""", (code, type_, nom, regle, quoi, g, u["id"]))
            zid = cur.fetchone()["id"]
        journal(cur, u["id"], "calcul d'une zone protégée", f"zone {zid}", nom)
        return une_zone(cur, zid)


def alertes_zones(cur, gj: str, pour_foncier: bool = True) -> list[dict]:
    """Zones protégées touchées par une forme. Pour le foncier, les berges et bas-fonds calculés sont déjà contrôlés."""
    cur.execute("""SELECT z.code, z.type, z.nom, z.regle,
                          round(ST_Area(ST_Intersection(z.geom_m, g))::numeric)::float AS m2, GeometryType(g) AS gt
                   FROM env.zones z, (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 32628) AS g) t
                   WHERE z.active AND z.geom_m && g AND ST_Intersects(z.geom_m, g)
                     AND NOT (%s AND COALESCE(z.calcul, '') IN ('berges', 'basfonds'))
                   ORDER BY z.regle = 'Protection intégrale' DESC, m2 DESC""", (gj, pour_foncier))
    out = []
    for r in cur.fetchall():
        surf = r["gt"] in ("POLYGON", "MULTIPOLYGON")
        if surf and r["m2"] < 1:
            continue
        niveau = "bloquant" if r["regle"] == "Protection intégrale" else "alerte" if r["regle"] == "Inconstructible" else "info"
        out.append({"type": "environnement", "niveau": niveau, "zone": r["code"], "m2": r["m2"] if surf else None,
                    "message": f"Zone protégée {r['code']} « {r['nom']} » ({r['regle'].lower()})"
                               + (f" : {r['m2']:,.0f} m² concernés".replace(",", " ") if surf else "")})
    return out


class ControleIn(BaseModel):
    geometry: dict


@router.post("/controle")
def controle(body: ControleIn, u: dict = Depends(current_user)):
    with cursor() as cur:
        return alertes_zones(cur, lire_geom(cur, body.geometry), pour_foncier=False)


# ---------------------------------------------------------------- atteintes
def voir_responsable(u: dict, r: dict) -> bool:
    return peut_gerer(u) or r.get("cree_par") == u["id"]


ATTEINTE_COLS = """a.id, a.numero, a.type, a.statut, a.gravite, a.description, a.surface_m2::float, a.responsable, a.echeance,
    a.amende_gnf::float, a.quartier, a.zones, a.contribution, a.cree_le, a.cree_par, a.clos_le, a.modifie_le,
    (a.photo IS NOT NULL) AS a_photo, c.nom AS cree_par_nom, ST_AsGeoJSON(a.geom, 7)::json AS geometry"""


def feature_atteinte(r: dict, u: dict) -> dict:
    g = r.pop("geometry")
    if not voir_responsable(u, r):
        r["responsable"] = None
    iso(r, "echeance", "cree_le", "clos_le", "modifie_le")
    r["photo_url"] = f"/api/environnement/atteintes/{r['id']}/photo" if r.pop("a_photo") else None
    r["en_retard"] = bool(r["statut"] == "Mise en demeure" and r["echeance"] and r["echeance"] < dt.date.today().isoformat())
    return {"type": "Feature", "id": r["id"], "geometry": g, "properties": r}


def une_atteinte(cur, aid: int, u: dict) -> dict:
    cur.execute(f"SELECT {ATTEINTE_COLS} FROM env.atteintes a LEFT JOIN app.utilisateurs c ON c.id = a.cree_par WHERE a.id = %s", (aid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Atteinte introuvable.")
    return feature_atteinte(r, u)


def histo_atteinte(cur, aid: int, u: dict | None, action: str, avant, apres, commentaire=None, photo=None):
    cur.execute("""INSERT INTO env.atteintes_historique (atteinte, utilisateur, action, statut_avant, statut_apres, commentaire, photo)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""", (aid, u["id"] if u else None, action, avant, apres, commentaire, photo))


def zones_touchees(cur, gj: str) -> list[str]:
    return [a["zone"] for a in alertes_zones(cur, gj, pour_foncier=False)]


@router.get("/atteintes")
def lister_atteintes(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute(f"SELECT {ATTEINTE_COLS} FROM env.atteintes a LEFT JOIN app.utilisateurs c ON c.id = a.cree_par ORDER BY a.id DESC")
        return {"type": "FeatureCollection", "features": [feature_atteinte(r, u) for r in cur.fetchall()]}


@router.get("/atteintes/{aid}")
def lire_atteinte(aid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        f = une_atteinte(cur, aid, u)
        cur.execute("""SELECT h.id, h.date, h.action, h.statut_avant, h.statut_apres, h.commentaire, (h.photo IS NOT NULL) AS a_photo,
                              x.nom AS utilisateur FROM env.atteintes_historique h LEFT JOIN app.utilisateurs x ON x.id = h.utilisateur
                       WHERE h.atteinte = %s ORDER BY h.date DESC, h.id DESC""", (aid,))
        hist = cur.fetchall()
        for h in hist:
            iso(h, "date")
            h["photo_url"] = f"/api/environnement/atteintes/{aid}/historique/{h['id']}/photo" if h.pop("a_photo") else None
        f["historique"] = hist
        f["peut_gerer"] = peut_gerer(u)
    return f


@router.get("/atteintes/{aid}/photo")
def photo_atteinte(aid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        return photo_reponse(cur, "SELECT photo FROM env.atteintes WHERE id = %s", aid)


@router.get("/atteintes/{aid}/historique/{hid}/photo")
def photo_histo_atteinte(aid: int, hid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        return photo_reponse(cur, "SELECT photo FROM env.atteintes_historique WHERE atteinte = %s AND id = %s", aid, hid)


class AtteinteIn(BaseModel):
    geometry: dict
    type: str
    gravite: str = "Moyenne"
    description: str = Field(min_length=3, max_length=2000)
    surface_m2: float | None = Field(None, ge=0, le=100_000_000)
    responsable: str | None = Field(None, max_length=200)
    photo: str | None = None
    uid: str | None = Field(None, pattern=r"^[0-9a-fA-F-]{36}$")


@router.post("/atteintes", status_code=201)
def creer_atteinte(body: AtteinteIn, u: dict = Depends(current_user)):
    if body.type not in TYPES_ATTEINTE or body.gravite not in GRAVITES:
        raise HTTPException(400, "Type ou gravité invalide.")
    with cursor() as cur:
        if body.uid:
            cur.execute("SELECT id FROM env.atteintes WHERE uid = %s", (body.uid,))
            deja = cur.fetchone()
            if deja:
                return une_atteinte(cur, deja["id"], u)
        gj = lire_geom(cur, body.geometry, ("Point", "Polygon"))
        surface = body.surface_m2
        if surface is None and body.geometry["type"] == "Polygon":
            surface = cur.execute("SELECT round(ST_Area(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 32628))) AS s",
                                  (gj,)).fetchone()["s"]
        numero = numero_suivant(cur, "env.atteintes", f"AE-{dt.date.today().year}")
        photo = decode_photo(body.photo)
        cur.execute("""INSERT INTO env.atteintes (numero, uid, type, gravite, description, surface_m2, responsable, quartier, zones,
                                                  photo, geom, cree_par)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s) RETURNING id""",
                    (numero, body.uid, body.type, body.gravite, body.description, surface, body.responsable, quartier_de(cur, gj),
                     zones_touchees(cur, gj), photo, gj, u["id"]))
        aid = cur.fetchone()["id"]
        histo_atteinte(cur, aid, u, "signalement", None, "Signalée", body.description, photo)
        journal(cur, u["id"], "signalement d'une atteinte à l'environnement", f"atteinte {numero}", body.type)
        return une_atteinte(cur, aid, u)


class ActionAtteinte(BaseModel):
    action: str = Field(pattern=r"^(constater|mettre_en_demeure|sanctionner|remettre_en_etat|clore|classer|rouvrir|commenter)$")
    commentaire: str | None = Field(None, max_length=2000)
    photo: str | None = None
    gravite: str | None = None
    surface_m2: float | None = Field(None, ge=0, le=100_000_000)
    responsable: str | None = Field(None, max_length=200)
    echeance: dt.date | None = None
    amende_gnf: float | None = Field(None, ge=0, le=1e13)


TRANSITIONS = {   # action : (statuts de départ, statut d'arrivée, réservée au service)
    "constater": (("Signalée",), "Constatée", False),
    "mettre_en_demeure": (("Signalée", "Constatée"), "Mise en demeure", True),
    "sanctionner": (("Constatée", "Mise en demeure"), "Sanctionnée", True),
    "remettre_en_etat": (("Constatée", "Mise en demeure", "Sanctionnée"), "Remise en état", True),
    "clore": (("Sanctionnée", "Remise en état"), "Close", True),
    "classer": (OUVERTS, "Classée sans suite", True),
    "rouvrir": (("Close", "Classée sans suite", "Remise en état"), "Constatée", True),
}
LIBELLES = {"constater": "constat sur place", "mettre_en_demeure": "mise en demeure", "sanctionner": "sanction",
            "remettre_en_etat": "remise en état", "clore": "clôture", "classer": "classement sans suite",
            "rouvrir": "réouverture", "commenter": "commentaire"}


@router.post("/atteintes/{aid}/action")
def action_atteinte(aid: int, body: ActionAtteinte, u: dict = Depends(current_user)):
    a = body.action
    with cursor() as cur:
        cur.execute("SELECT statut, numero, contribution FROM env.atteintes WHERE id = %s FOR UPDATE", (aid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Atteinte introuvable.")
        avant, apres = r["statut"], r["statut"]
        photo = decode_photo(body.photo)
        sets, vals = [], []
        if a == "commenter":
            if not (body.commentaire or "").strip() and not photo:
                raise HTTPException(400, "Écrivez un commentaire ou joignez une photo.")
        else:
            depart, apres, reserve = TRANSITIONS[a]
            if reserve:
                exiger_gestion(u)
            if avant not in depart:
                raise HTTPException(409, f"Impossible depuis le statut « {avant} ».")
            if a == "mettre_en_demeure" and not body.echeance:
                raise HTTPException(400, "Indiquez le délai accordé (échéance) de la mise en demeure.")
            if a in ("sanctionner", "classer") and not (body.commentaire or "").strip():
                raise HTTPException(400, "Indiquez la décision ou le motif.")
            sets.append("statut = %s")
            vals.append(apres)
            if apres in ("Close", "Classée sans suite"):
                sets.append("clos_le = now()")
            if a == "rouvrir":
                sets.append("clos_le = NULL")
        if body.gravite:
            if body.gravite not in GRAVITES:
                raise HTTPException(400, "Gravité invalide.")
            sets.append("gravite = %s")
            vals.append(body.gravite)
        for k in ("surface_m2", "echeance", "amende_gnf"):
            if getattr(body, k) is not None:
                sets.append(f"{k} = %s")
                vals.append(getattr(body, k))
        if body.responsable is not None:
            exiger_gestion(u)
            sets.append("responsable = %s")
            vals.append(body.responsable.strip() or None)
        if photo and a != "commenter":
            sets.append("photo = %s")
            vals.append(photo)
        if sets:
            sets.append("modifie_le = now()")
            cur.execute(f"UPDATE env.atteintes SET {', '.join(sets)} WHERE id = %s", vals + [aid])
        detail = body.commentaire
        if a == "mettre_en_demeure":
            detail = f"délai jusqu'au {body.echeance.strftime('%d/%m/%Y')}" + (f" — {body.commentaire}" if body.commentaire else "")
        if a == "sanctionner" and body.amende_gnf:
            detail = f"amende {body.amende_gnf:,.0f} GNF — ".replace(",", " ") + body.commentaire
        histo_atteinte(cur, aid, u, LIBELLES[a], avant, apres, detail, photo)
        journal(cur, u["id"], LIBELLES[a], f"atteinte {r['numero']}", detail)
        if r["contribution"] and apres != avant and apres in ("Remise en état", "Close", "Classée sans suite"):
            cur.execute("""UPDATE contrib.contributions SET statut = 'Traité', traite_le = now(), modifie_le = now(), modifie_par = %s
                           WHERE id = %s AND statut <> 'Traité' RETURNING id""", (u["nom"], r["contribution"]))
            if cur.fetchone():
                historiser(cur, r["contribution"], u["id"], "traitement", "En cours", "Traité", f"atteinte {r['numero']} : {apres.lower()}")
        return une_atteinte(cur, aid, u)


@router.get("/signalements")
def signalements(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("""SELECT c.id, c.type, c.nom, c.description, c.quartier, c.cree_le, COALESCE(a.nom, c.auteur) AS auteur,
                              ST_AsGeoJSON(ST_PointOnSurface(c.geom), 7)::json AS geometry
                       FROM contrib.contributions c LEFT JOIN app.utilisateurs a ON a.id = c.cree_par
                       WHERE c.categorie = 'Signalement' AND c.type = ANY(%s) AND c.statut IN ('Validé', 'Affecté', 'En cours')
                         AND NOT EXISTS (SELECT 1 FROM env.atteintes x WHERE x.contribution = c.id)
                       ORDER BY c.cree_le""", (list(SIGNALEMENTS),))
        return [iso(r, "cree_le") for r in cur.fetchall()]


@router.post("/signalements/{cid}/convertir")
def convertir(cid: int, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("""SELECT id, type, nom, description, statut, photo, ST_AsGeoJSON(geom, 7) AS g, GeometryType(geom) AS gt
                       FROM contrib.contributions WHERE id = %s AND categorie = 'Signalement' AND type = ANY(%s) FOR UPDATE""",
                    (cid, list(SIGNALEMENTS)))
        c = cur.fetchone()
        if not c:
            raise HTTPException(404, "Signalement introuvable.")
        cur.execute("SELECT 1 FROM env.atteintes WHERE contribution = %s", (cid,))
        if cur.fetchone():
            raise HTTPException(409, "Signalement déjà pris en charge.")
        if c["gt"] not in ("POINT", "POLYGON"):
            cur.execute("SELECT ST_AsGeoJSON(ST_PointOnSurface(geom), 7) AS g FROM contrib.contributions WHERE id = %s", (cid,))
            c["g"] = cur.fetchone()["g"]
        numero = numero_suivant(cur, "env.atteintes", f"AE-{dt.date.today().year}")
        desc = " — ".join(x for x in (c["nom"], c["description"]) if x) or c["type"]
        cur.execute("""INSERT INTO env.atteintes (numero, type, description, quartier, zones, photo, geom, contribution, cree_par)
                       VALUES (%s, %s, %s, %s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s, %s) RETURNING id""",
                    (numero, SIGNALEMENTS[c["type"]], desc, quartier_de(cur, c["g"]), zones_touchees(cur, c["g"]), c["photo"], c["g"],
                     cid, u["id"]))
        aid = cur.fetchone()["id"]
        histo_atteinte(cur, aid, u, f"signalement n° {cid} pris en charge", None, "Signalée", desc)
        if c["statut"] != "En cours":
            cur.execute("""UPDATE contrib.contributions SET statut = 'En cours', service_affecte = COALESCE(service_affecte, %s),
                                  affecte_le = COALESCE(affecte_le, now()), modifie_le = now(), modifie_par = %s WHERE id = %s""",
                        (SERVICES_ENV[0], u["nom"], cid))
        historiser(cur, cid, u["id"], "prise en charge", c["statut"], "En cours", f"atteinte {numero} (environnement)")
        journal(cur, u["id"], "signalement converti en atteinte", f"contribution {cid}", numero)
        return une_atteinte(cur, aid, u)


# ---------------------------------------------------------------- plantations
PLANTATION_COLS = """p.id, p.numero, p.type, p.espece, p.nombre_plants, p.date_plantation, p.campagne, p.organisme, p.quartier,
    p.observations, p.cree_le, p.cree_par, (p.photo IS NOT NULL) AS a_photo, c.nom AS cree_par_nom,
    s.vivants, s.date AS dernier_suivi, s.etat AS etat_suivi,
    (SELECT count(*) FROM env.plantations_suivis x WHERE x.plantation = p.id)::int AS nb_suivis,
    ST_AsGeoJSON(p.geom, 7)::json AS geometry"""
PLANTATION_FROM = """ FROM env.plantations p LEFT JOIN app.utilisateurs c ON c.id = p.cree_par
    LEFT JOIN LATERAL (SELECT vivants, date, etat FROM env.plantations_suivis x WHERE x.plantation = p.id
                       ORDER BY date DESC, id DESC LIMIT 1) s ON true """


def feature_plantation(r: dict) -> dict:
    g = r.pop("geometry")
    iso(r, "date_plantation", "cree_le", "dernier_suivi")
    r["survie_pct"] = round(100 * r["vivants"] / r["nombre_plants"]) if r["vivants"] is not None else None
    r["photo_url"] = f"/api/environnement/plantations/{r['id']}/photo" if r.pop("a_photo") else None
    return {"type": "Feature", "id": r["id"], "geometry": g, "properties": r}


def une_plantation(cur, pid: int) -> dict:
    cur.execute(f"SELECT {PLANTATION_COLS} {PLANTATION_FROM} WHERE p.id = %s", (pid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Plantation introuvable.")
    return feature_plantation(r)


@router.get("/plantations")
def lister_plantations(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute(f"SELECT {PLANTATION_COLS} {PLANTATION_FROM} ORDER BY p.id DESC")
        return {"type": "FeatureCollection", "features": [feature_plantation(r) for r in cur.fetchall()]}


@router.get("/plantations/{pid}")
def lire_plantation(pid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        f = une_plantation(cur, pid)
        cur.execute("""SELECT s.id, s.date, s.vivants, s.etat, s.commentaire, (s.photo IS NOT NULL) AS a_photo, x.nom AS utilisateur
                       FROM env.plantations_suivis s LEFT JOIN app.utilisateurs x ON x.id = s.utilisateur
                       WHERE s.plantation = %s ORDER BY s.date DESC, s.id DESC""", (pid,))
        suivis = cur.fetchall()
        for s in suivis:
            iso(s, "date")
            s["photo_url"] = f"/api/environnement/suivis/{s['id']}/photo" if s.pop("a_photo") else None
        f["suivis"] = suivis
        f["peut_modifier"] = peut_gerer(u) or f["properties"]["cree_par"] == u["id"]
    return f


@router.get("/plantations/{pid}/photo")
def photo_plantation(pid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        return photo_reponse(cur, "SELECT photo FROM env.plantations WHERE id = %s", pid)


@router.get("/suivis/{sid}/photo")
def photo_suivi(sid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        return photo_reponse(cur, "SELECT photo FROM env.plantations_suivis WHERE id = %s", sid)


class PlantationIn(BaseModel):
    geometry: dict | None = None
    type: str | None = None
    espece: str | None = Field(None, max_length=150)
    nombre_plants: int | None = Field(None, gt=0, le=10_000_000)
    date_plantation: dt.date | None = None
    campagne: str | None = Field(None, max_length=80)
    organisme: str | None = Field(None, max_length=150)
    observations: str | None = Field(None, max_length=2000)
    photo: str | None = None
    uid: str | None = Field(None, pattern=r"^[0-9a-fA-F-]{36}$")


@router.post("/plantations", status_code=201)
def creer_plantation(body: PlantationIn, u: dict = Depends(current_user)):
    if body.type not in TYPES_PLANTATION or not body.nombre_plants:
        raise HTTPException(400, "Type de plantation et nombre de plants requis.")
    with cursor() as cur:
        if body.uid:
            cur.execute("SELECT id FROM env.plantations WHERE uid = %s", (body.uid,))
            deja = cur.fetchone()
            if deja:
                return une_plantation(cur, deja["id"])
        gj = lire_geom(cur, body.geometry)
        d = body.date_plantation or dt.date.today()
        numero = numero_suivant(cur, "env.plantations", "PL")
        cur.execute("""INSERT INTO env.plantations (numero, uid, type, espece, nombre_plants, date_plantation, campagne, organisme,
                                                    quartier, observations, photo, geom, cree_par)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s) RETURNING id""",
                    (numero, body.uid, body.type, body.espece, body.nombre_plants, d, body.campagne or f"Campagne {d.year}",
                     body.organisme, quartier_de(cur, gj), body.observations, decode_photo(body.photo), gj, u["id"]))
        pid = cur.fetchone()["id"]
        journal(cur, u["id"], "plantation enregistrée", f"plantation {numero}", f"{body.nombre_plants} plants — {body.espece or body.type}")
        return une_plantation(cur, pid)


@router.put("/plantations/{pid}")
def modifier_plantation(pid: int, body: PlantationIn, u: dict = Depends(current_user)):
    d = body.model_dump(exclude_unset=True)
    with cursor() as cur:
        cur.execute("SELECT numero, cree_par FROM env.plantations WHERE id = %s FOR UPDATE", (pid,))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "Plantation introuvable.")
        if not (peut_gerer(u) or p["cree_par"] == u["id"]):
            raise HTTPException(403, "Vous ne pouvez modifier que vos propres saisies.")
        if "type" in d and d["type"] not in TYPES_PLANTATION:
            raise HTTPException(400, "Type invalide.")
        sets, vals = [], []
        for k in ("type", "espece", "nombre_plants", "date_plantation", "campagne", "organisme", "observations"):
            if k in d and d[k] is not None:
                sets.append(f"{k} = %s")
                vals.append(d[k])
        if "photo" in d:
            sets.append("photo = %s")
            vals.append(decode_photo(d["photo"]))
        if body.geometry:
            gj = lire_geom(cur, body.geometry)
            sets += ["geom = ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)", "quartier = %s"]
            vals += [gj, quartier_de(cur, gj)]
        if not sets:
            raise HTTPException(400, "Rien à modifier.")
        sets.append("modifie_le = now()")
        cur.execute(f"UPDATE env.plantations SET {', '.join(sets)} WHERE id = %s", vals + [pid])
        journal(cur, u["id"], "plantation modifiée", f"plantation {p['numero']}")
        return une_plantation(cur, pid)


@router.delete("/plantations/{pid}")
def supprimer_plantation(pid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("""SELECT numero, cree_par, (SELECT count(*) FROM env.plantations_suivis s WHERE s.plantation = p.id)::int AS n
                       FROM env.plantations p WHERE id = %s""", (pid,))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "Plantation introuvable.")
        if not (peut_gerer(u) or (p["cree_par"] == u["id"] and not p["n"])):
            raise HTTPException(403, "Suppression réservée au service (ou à l'auteur, avant le premier suivi).")
        cur.execute("DELETE FROM env.plantations WHERE id = %s", (pid,))
        journal(cur, u["id"], "plantation supprimée", f"plantation {p['numero']}")
    return {"ok": True}


class SuiviIn(BaseModel):
    date: dt.date | None = None
    vivants: int = Field(ge=0)
    etat: str = "Bon"
    commentaire: str | None = Field(None, max_length=1000)
    photo: str | None = None


@router.post("/plantations/{pid}/suivi")
def suivi_plantation(pid: int, body: SuiviIn, u: dict = Depends(current_user)):
    if body.etat not in ETATS_SUIVI:
        raise HTTPException(400, "État invalide.")
    with cursor() as cur:
        cur.execute("SELECT numero, nombre_plants FROM env.plantations WHERE id = %s", (pid,))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "Plantation introuvable.")
        if body.vivants > p["nombre_plants"]:
            raise HTTPException(400, f"Plus de plants vivants ({body.vivants}) que de plants mis en terre ({p['nombre_plants']}).")
        cur.execute("""INSERT INTO env.plantations_suivis (plantation, date, vivants, etat, commentaire, photo, utilisateur)
                       VALUES (%s, COALESCE(%s, current_date), %s, %s, %s, %s, %s)""",
                    (pid, body.date, body.vivants, body.etat, body.commentaire, decode_photo(body.photo), u["id"]))
        journal(cur, u["id"], "suivi d'une plantation", f"plantation {p['numero']}", f"{body.vivants}/{p['nombre_plants']} vivants")
        return une_plantation(cur, pid)


# ---------------------------------------------------------------- points d'eau
EAU_COLS = """e.id, e.numero, e.type, e.nom, e.etat, e.usage, e.amenage, e.perimetre_m::float, e.quartier, e.observations,
    e.dernier_constat, e.cree_le, e.cree_par, (e.photo IS NOT NULL) AS a_photo, c.nom AS cree_par_nom,
    z.id AS zone_id, z.code AS zone_code,
    (SELECT count(*) FROM adr.batiments_points b WHERE z.geom_m IS NOT NULL AND b.p && z.geom_m AND ST_Intersects(z.geom_m, b.p))::int AS batiments,
    (SELECT count(*) FROM dech.points d WHERE z.geom_m IS NOT NULL AND d.etat NOT IN ('Fermé', 'Résorbé')
       AND ST_Intersects(z.geom_m, ST_Transform(d.geom, 32628)))::int AS depots,
    ST_AsGeoJSON(e.geom, 7)::json AS geometry"""
EAU_FROM = """ FROM env.points_eau e LEFT JOIN app.utilisateurs c ON c.id = e.cree_par
    LEFT JOIN env.zones z ON z.calcul = 'source' AND z.point_eau = e.id """


def feature_eau(r: dict) -> dict:
    g = r.pop("geometry")
    iso(r, "dernier_constat", "cree_le")
    r["photo_url"] = f"/api/environnement/points-eau/{r['id']}/photo" if r.pop("a_photo") else None
    return {"type": "Feature", "id": r["id"], "geometry": g, "properties": r}


def un_point_eau(cur, eid: int) -> dict:
    cur.execute(f"SELECT {EAU_COLS} {EAU_FROM} WHERE e.id = %s", (eid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Point d'eau introuvable.")
    return feature_eau(r)


def maj_perimetre(cur, eid: int, u: dict):
    """Périmètre de protection du point d'eau : zone protégée « Périmètre de source », inconstructible."""
    cur.execute("SELECT numero, type, nom, COALESCE(perimetre_m, env.param('perimetre_source_m'))::float AS r FROM env.points_eau WHERE id = %s",
                (eid,))
    e = cur.fetchone()
    cur.execute("SELECT id FROM env.zones WHERE calcul = 'source' AND point_eau = %s", (eid,))
    z = cur.fetchone()
    if not e["r"]:
        if z:
            cur.execute("DELETE FROM env.zones WHERE id = %s", (z["id"],))
        return
    nom = f"Périmètre {'de la ' if e['type'] in ('Source', 'Mare / retenue') else 'du '}{e['type'].lower()} {e['numero']}" + \
          (f" ({e['nom']})" if e["nom"] else "")
    geom = """(SELECT ST_Multi(ST_Transform(ST_Buffer(ST_Transform(geom, 32628), %s, 'quad_segs=8'), 4326)) FROM env.points_eau WHERE id = %s)"""
    if z:
        cur.execute(f"UPDATE env.zones SET geom = {geom}, nom = %s, modifie_le = now() WHERE id = %s", (e["r"], eid, nom, z["id"]))
    else:
        code = numero_suivant(cur, "env.zones", "ZP")
        cur.execute(f"""INSERT INTO env.zones (code, type, nom, regle, calcul, point_eau, geom, cree_par)
                        VALUES (%s, 'Périmètre de source', %s, 'Inconstructible', 'source', %s, {geom}, %s)""",
                    (code, nom, eid, e["r"], eid, u["id"]))


@router.get("/points-eau")
def lister_points_eau(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute(f"SELECT {EAU_COLS} {EAU_FROM} ORDER BY e.id DESC")
        return {"type": "FeatureCollection", "features": [feature_eau(r) for r in cur.fetchall()]}


@router.get("/points-eau/{eid}")
def lire_point_eau(eid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        f = un_point_eau(cur, eid)
        cur.execute("""SELECT k.id, k.date, k.etat, k.debit, k.qualite, k.commentaire, (k.photo IS NOT NULL) AS a_photo, x.nom AS utilisateur
                       FROM env.points_eau_constats k LEFT JOIN app.utilisateurs x ON x.id = k.utilisateur
                       WHERE k.point_eau = %s ORDER BY k.date DESC, k.id DESC""", (eid,))
        cons = cur.fetchall()
        for k in cons:
            iso(k, "date")
            k["photo_url"] = f"/api/environnement/constats-eau/{k['id']}/photo" if k.pop("a_photo") else None
        f["constats"] = cons
        cur.execute("""SELECT d.id, d.numero, d.type, d.etat FROM dech.points d, env.zones z
                       WHERE z.calcul = 'source' AND z.point_eau = %s AND d.etat NOT IN ('Fermé', 'Résorbé')
                         AND ST_Intersects(z.geom_m, ST_Transform(d.geom, 32628))""", (eid,))
        f["depots"] = cur.fetchall()
        cur.execute("""SELECT a.id, a.numero, a.type, a.statut FROM env.atteintes a, env.zones z
                       WHERE z.calcul = 'source' AND z.point_eau = %s AND z.code = ANY (a.zones) ORDER BY a.id DESC""", (eid,))
        f["atteintes"] = cur.fetchall()
        f["peut_modifier"] = peut_gerer(u) or f["properties"]["cree_par"] == u["id"]
    return f


@router.get("/points-eau/{eid}/photo")
def photo_eau(eid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        return photo_reponse(cur, "SELECT photo FROM env.points_eau WHERE id = %s", eid)


@router.get("/constats-eau/{kid}/photo")
def photo_constat_eau(kid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        return photo_reponse(cur, "SELECT photo FROM env.points_eau_constats WHERE id = %s", kid)


class EauIn(BaseModel):
    geometry: dict | None = None
    type: str | None = None
    nom: str | None = Field(None, max_length=150)
    etat: str | None = None
    usage: str | None = Field(None, max_length=200)
    amenage: bool | None = None
    perimetre_m: float | None = Field(None, ge=0, le=2000)
    observations: str | None = Field(None, max_length=2000)
    photo: str | None = None
    uid: str | None = Field(None, pattern=r"^[0-9a-fA-F-]{36}$")


@router.post("/points-eau", status_code=201)
def creer_point_eau(body: EauIn, u: dict = Depends(current_user)):
    if body.type not in TYPES_EAU or (body.etat and body.etat not in ETATS_EAU):
        raise HTTPException(400, "Type ou état invalide.")
    with cursor() as cur:
        if body.uid:
            cur.execute("SELECT id FROM env.points_eau WHERE uid = %s", (body.uid,))
            deja = cur.fetchone()
            if deja:
                return un_point_eau(cur, deja["id"])
        gj = lire_geom(cur, body.geometry, ("Point",))
        numero = numero_suivant(cur, "env.points_eau", PREFIXE_EAU[body.type])
        etat = body.etat or "Permanent"
        cur.execute("""INSERT INTO env.points_eau (numero, uid, type, nom, etat, usage, amenage, perimetre_m, quartier, observations,
                                                   photo, geom, cree_par)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s) RETURNING id""",
                    (numero, body.uid, body.type, body.nom, etat, body.usage, bool(body.amenage), body.perimetre_m,
                     quartier_de(cur, gj), body.observations, decode_photo(body.photo), gj, u["id"]))
        eid = cur.fetchone()["id"]
        cur.execute("INSERT INTO env.points_eau_constats (point_eau, etat, commentaire, utilisateur) VALUES (%s, %s, 'recensement', %s)",
                    (eid, etat, u["id"]))
        maj_perimetre(cur, eid, u)
        journal(cur, u["id"], "point d'eau recensé", f"point d'eau {numero}", body.type)
        return un_point_eau(cur, eid)


@router.put("/points-eau/{eid}")
def modifier_point_eau(eid: int, body: EauIn, u: dict = Depends(current_user)):
    d = body.model_dump(exclude_unset=True)
    with cursor() as cur:
        cur.execute("SELECT numero, cree_par FROM env.points_eau WHERE id = %s FOR UPDATE", (eid,))
        e = cur.fetchone()
        if not e:
            raise HTTPException(404, "Point d'eau introuvable.")
        if not (peut_gerer(u) or e["cree_par"] == u["id"]):
            raise HTTPException(403, "Vous ne pouvez modifier que vos propres saisies.")
        if "type" in d and d["type"] not in TYPES_EAU:
            raise HTTPException(400, "Type invalide.")
        sets, vals = [], []
        for k in ("type", "nom", "usage", "amenage", "perimetre_m", "observations"):
            if k in d:
                sets.append(f"{k} = %s")
                vals.append(d[k])
        if "photo" in d:
            sets.append("photo = %s")
            vals.append(decode_photo(d["photo"]))
        if body.geometry:
            gj = lire_geom(cur, body.geometry, ("Point",))
            sets += ["geom = ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)", "quartier = %s"]
            vals += [gj, quartier_de(cur, gj)]
        if not sets:
            raise HTTPException(400, "Rien à modifier.")
        sets.append("modifie_le = now()")
        cur.execute(f"UPDATE env.points_eau SET {', '.join(sets)} WHERE id = %s", vals + [eid])
        maj_perimetre(cur, eid, u)
        journal(cur, u["id"], "point d'eau modifié", f"point d'eau {e['numero']}")
        return un_point_eau(cur, eid)


@router.delete("/points-eau/{eid}")
def supprimer_point_eau(eid: int, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("DELETE FROM env.zones WHERE calcul = 'source' AND point_eau = %s", (eid,))
        cur.execute("DELETE FROM env.points_eau WHERE id = %s RETURNING numero", (eid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Point d'eau introuvable.")
        journal(cur, u["id"], "point d'eau supprimé", f"point d'eau {r['numero']}")
    return {"ok": True}


class ConstatEauIn(BaseModel):
    etat: str
    debit: str | None = Field(None, max_length=80)
    qualite: str | None = Field(None, max_length=150)
    commentaire: str | None = Field(None, max_length=1000)
    photo: str | None = None


@router.post("/points-eau/{eid}/constat")
def constat_eau(eid: int, body: ConstatEauIn, u: dict = Depends(current_user)):
    if body.etat not in ETATS_EAU:
        raise HTTPException(400, "État invalide.")
    with cursor() as cur:
        cur.execute("UPDATE env.points_eau SET etat = %s, dernier_constat = now() WHERE id = %s RETURNING numero", (body.etat, eid))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Point d'eau introuvable.")
        cur.execute("""INSERT INTO env.points_eau_constats (point_eau, etat, debit, qualite, commentaire, photo, utilisateur)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                    (eid, body.etat, body.debit, body.qualite, body.commentaire, decode_photo(body.photo), u["id"]))
        journal(cur, u["id"], "constat sur un point d'eau", f"point d'eau {r['numero']}", body.etat)
        return un_point_eau(cur, eid)


# ---------------------------------------------------------------- feux de brousse
FEU_COLS = """f.id, f.date_feu, env.saison(f.date_feu) AS saison, f.origine, f.cause, f.surface_ha::float, f.confiance,
    f.description, f.quartier, f.cree_le, f.cree_par, c.nom AS cree_par_nom, ST_AsGeoJSON(f.geom, 6)::json AS geometry"""


def feature_feu(r: dict) -> dict:
    g = r.pop("geometry")
    iso(r, "date_feu", "cree_le")
    return {"type": "Feature", "id": r["id"], "geometry": g, "properties": r}


@router.get("/feux")
def lister_feux(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute(f"SELECT {FEU_COLS} FROM env.feux f LEFT JOIN app.utilisateurs c ON c.id = f.cree_par ORDER BY f.date_feu DESC, f.id DESC")
        return {"type": "FeatureCollection", "features": [feature_feu(r) for r in cur.fetchall()]}


class FeuIn(BaseModel):
    geometry: dict
    date_feu: dt.date
    cause: str = "Inconnue"
    surface_ha: float | None = Field(None, ge=0, le=100000)
    description: str | None = Field(None, max_length=2000)


@router.post("/feux", status_code=201)
def creer_feu(body: FeuIn, u: dict = Depends(current_user)):
    if body.cause not in CAUSES_FEU:
        raise HTTPException(400, "Cause invalide.")
    if body.date_feu > dt.date.today():
        raise HTTPException(400, "La date du feu est dans le futur.")
    with cursor() as cur:
        gj = lire_geom(cur, body.geometry, ("Point", "Polygon"))
        surface = body.surface_ha
        if surface is None and body.geometry["type"] == "Polygon":
            surface = cur.execute("SELECT round((ST_Area(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 32628)) / 10000)::numeric, 2)::float AS s",
                                  (gj,)).fetchone()["s"]
        cur.execute("""INSERT INTO env.feux (date_feu, cause, surface_ha, description, quartier, geom, cree_par)
                       VALUES (%s, %s, %s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s) RETURNING id""",
                    (body.date_feu, body.cause, surface, body.description, quartier_de(cur, gj), gj, u["id"]))
        fid = cur.fetchone()["id"]
        journal(cur, u["id"], "feu de brousse enregistré", f"feu {fid}", body.date_feu.isoformat())
        cur.execute(f"SELECT {FEU_COLS} FROM env.feux f LEFT JOIN app.utilisateurs c ON c.id = f.cree_par WHERE f.id = %s", (fid,))
        return feature_feu(cur.fetchone())


@router.delete("/feux/{fid}")
def supprimer_feu(fid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT cree_par FROM env.feux WHERE id = %s", (fid,))
        f = cur.fetchone()
        if not f:
            raise HTTPException(404, "Feu introuvable.")
        if not (peut_gerer(u) or f["cree_par"] == u["id"]):
            raise HTTPException(403, "Vous ne pouvez supprimer que vos propres saisies.")
        cur.execute("DELETE FROM env.feux WHERE id = %s", (fid,))
        journal(cur, u["id"], "feu de brousse supprimé", f"feu {fid}")
    return {"ok": True}


class ImportFirms(BaseModel):
    csv: str = Field(max_length=20_000_000)


@router.post("/feux/import-firms")
def import_firms(body: ImportFirms, u: dict = Depends(current_user)):
    """Fichier CSV des détections de feux actifs de la NASA (FIRMS, capteurs MODIS ou VIIRS) : on garde celles de la commune."""
    exiger_gestion(u)
    lignes = list(csv.DictReader(io.StringIO(body.csv.lstrip("﻿"))))
    if not lignes or not {"latitude", "longitude", "acq_date"} <= set(lignes[0]):
        raise HTTPException(400, "Fichier FIRMS attendu (colonnes latitude, longitude, acq_date…).")
    lus = len(lignes)
    pts = []
    for l in lignes:
        try:
            x, y, d = float(l["longitude"]), float(l["latitude"]), dt.date.fromisoformat(l["acq_date"])
        except (ValueError, TypeError):
            continue
        conf = (l.get("confidence") or "").strip()
        conf = {"l": "faible", "n": "nominale", "h": "haute"}.get(conf, conf)
        capteur = (l.get("instrument") or l.get("satellite") or "").strip()
        pts.append((x, y, d, conf, capteur, (l.get("acq_time") or "").strip(), f"{d}|{x:.4f}|{y:.4f}|{capteur}"))
    ajoutes = doublons = dedans = 0
    with cursor() as cur:
        for x, y, d, conf, capteur, heure, cle in pts:
            cur.execute("SELECT EXISTS (SELECT 1 FROM ref.limite_commune c WHERE ST_Contains(c.geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326))) AS ok",
                        (x, y))
            if not cur.fetchone()["ok"]:
                continue
            dedans += 1
            gj = json.dumps({"type": "Point", "coordinates": [x, y]})
            cur.execute("""INSERT INTO env.feux (date_feu, origine, confiance, cle_firms, description, quartier, geom, cree_par)
                           VALUES (%s, 'Satellite (FIRMS)', %s, %s, %s, %s, ST_SetSRID(ST_MakePoint(%s, %s), 4326), %s)
                           ON CONFLICT (cle_firms) DO NOTHING RETURNING id""",
                        (d, conf or None, cle, f"Détection {capteur} {heure}".strip(), quartier_de(cur, gj), x, y, u["id"]))
            if cur.fetchone():
                ajoutes += 1
            else:
                doublons += 1
        journal(cur, u["id"], "import des feux FIRMS", None, f"{ajoutes} ajouté(s) sur {lus} détection(s)")
    return {"lus": lus, "dans_commune": dedans, "ajoutes": ajoutes, "doublons": doublons}


# ---------------------------------------------------------------- bâtiments en zone protégée, bilan
@router.get("/batiments-zones")
def batiments_zones(u: dict = Depends(current_user)):
    """Bâtiments situés dans une zone protégée stricte (protection intégrale ou inconstructible)."""
    with cursor() as cur:
        cur.execute("""SELECT DISTINCT ON (b.gid) round(ST_X(ST_Transform(b.p, 4326))::numeric, 6)::float AS x,
                              round(ST_Y(ST_Transform(b.p, 4326))::numeric, 6)::float AS y, z.code
                       FROM env.zones z JOIN adr.batiments_points b ON b.p && z.geom_m AND ST_Intersects(z.geom_m, b.p)
                       WHERE z.active AND z.regle = ANY(%s) AND NOT ST_IsEmpty(b.p)
                       ORDER BY b.gid, z.regle = 'Protection intégrale' DESC LIMIT 40000""", (list(STRICTES),))
        return [[r["x"], r["y"], r["code"]] for r in cur.fetchall()]


@router.get("/bilan")
def bilan(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("""SELECT type, count(*) FILTER (WHERE statut = ANY(%s))::int AS ouvertes, count(*)::int AS total
                       FROM env.atteintes GROUP BY 1 ORDER BY 2 DESC, 3 DESC""", (list(OUVERTS),))
        atteintes_type = cur.fetchall()
        cur.execute("SELECT statut, count(*)::int AS n FROM env.atteintes GROUP BY 1")
        atteintes_statut = {r["statut"]: r["n"] for r in cur.fetchall()}
        cur.execute("""SELECT COALESCE(quartier, '—') AS quartier, count(*)::int AS n FROM env.atteintes
                       WHERE statut = ANY(%s) GROUP BY 1 ORDER BY 2 DESC""", (list(OUVERTS),))
        atteintes_quartier = cur.fetchall()
        cur.execute("""SELECT round(avg(EXTRACT(epoch FROM clos_le - cree_le) / 86400)::numeric, 1)::float AS j, count(*)::int AS n
                       FROM env.atteintes WHERE clos_le IS NOT NULL AND statut <> 'Classée sans suite'""")
        delai = cur.fetchone()
        cur.execute("SELECT count(*)::int AS n FROM env.atteintes WHERE statut = 'Mise en demeure' AND echeance < current_date")
        en_retard = cur.fetchone()["n"]
        cur.execute("""SELECT COALESCE(p.campagne, '—') AS campagne, count(*)::int AS plantations, sum(p.nombre_plants)::int AS plants,
                              sum(s.vivants) FILTER (WHERE s.vivants IS NOT NULL)::int AS vivants,
                              sum(p.nombre_plants) FILTER (WHERE s.vivants IS NOT NULL)::int AS plants_suivis
                       FROM env.plantations p LEFT JOIN LATERAL (SELECT vivants FROM env.plantations_suivis x WHERE x.plantation = p.id
                                                                 ORDER BY date DESC, id DESC LIMIT 1) s ON true
                       GROUP BY 1 ORDER BY 1 DESC""")
        campagnes = cur.fetchall()
        cur.execute("SELECT type, etat, count(*)::int AS n FROM env.points_eau GROUP BY 1, 2 ORDER BY 1, 2")
        eau = cur.fetchall()
        cur.execute("""SELECT env.saison(date_feu) AS saison, count(*)::int AS n, COALESCE(sum(surface_ha), 0)::float AS ha,
                              count(*) FILTER (WHERE origine = 'Satellite (FIRMS)')::int AS satellite
                       FROM env.feux GROUP BY 1 ORDER BY 1 DESC LIMIT 6""")
        feux_saisons = cur.fetchall()
        cur.execute("""SELECT to_char(m, 'YYYY-MM') AS mois, (SELECT count(*) FROM env.feux f WHERE date_trunc('month', f.date_feu) = m)::int AS n
                       FROM generate_series(make_date(split_part(env.saison(current_date), '-', 1)::int, env.param('mois_debut_saison_feux')::int, 1),
                                            make_date(split_part(env.saison(current_date), '-', 1)::int, env.param('mois_debut_saison_feux')::int, 1)
                                              + interval '11 months', interval '1 month') m ORDER BY m""")
        feux_mois = cur.fetchall()
        # bâtiments en zone protégée stricte, par type de zone et par quartier
        cur.execute("""WITH b AS (SELECT DISTINCT ON (q.gid) q.gid, q.quartier, z.type FROM env.zones z
                                  JOIN dech.bati_quartier q ON q.p && z.geom_m AND ST_Intersects(z.geom_m, q.p)
                                  WHERE z.active AND z.regle = ANY(%s) ORDER BY q.gid, z.regle = 'Protection intégrale' DESC)
                       SELECT 'type' AS k, type AS lib, count(*)::int AS n FROM b GROUP BY type
                       UNION ALL SELECT 'quartier', COALESCE(quartier, '—'), count(*)::int FROM b GROUP BY quartier
                       ORDER BY 1, 3 DESC""", (list(STRICTES),))
        bz = cur.fetchall()
        # couverture végétale par quartier : boisements (OSM), zones boisées ou de reboisement, plantations en surface
        cur.execute("""WITH v AS (
                           SELECT ST_Union(g) AS g FROM (
                               SELECT ST_Transform(geom, 32628) AS g FROM ref.vegetation
                               UNION ALL SELECT geom_m FROM env.zones WHERE active AND type IN ('Forêt classée', 'Boisement', 'Espace vert', 'Zone de reboisement')
                               UNION ALL SELECT ST_Transform(geom, 32628) FROM env.plantations WHERE GeometryType(geom) = 'POLYGON') t)
                       SELECT q.nom AS quartier, round((ST_Area(ST_Transform(q.geom, 32628)) / 10000)::numeric, 1)::float AS ha,
                              round((COALESCE(ST_Area(ST_Intersection(ST_Transform(q.geom, 32628), v.g)), 0) / 10000)::numeric, 2)::float AS vert_ha,
                              (SELECT COALESCE(sum(p.nombre_plants), 0) FROM env.plantations p WHERE p.quartier = q.nom)::int AS plants
                       FROM ref.quartiers q, v""")
        vegetation = cur.fetchall()
        for r in vegetation:
            r["pct"] = round(100 * r["vert_ha"] / r["ha"], 1) if r["ha"] else 0
        vegetation.sort(key=lambda r: r["pct"])
    return {"atteintes_type": atteintes_type, "atteintes_statut": atteintes_statut, "atteintes_quartier": atteintes_quartier,
            "delai": delai, "en_retard": en_retard, "campagnes": campagnes, "eau": eau, "feux_saisons": feux_saisons,
            "feux_mois": feux_mois, "bati_zones_type": [r for r in bz if r["k"] == "type"],
            "bati_zones_quartier": [r for r in bz if r["k"] == "quartier"], "vegetation": vegetation}


class Parametre(BaseModel):
    valeur: float = Field(ge=0, le=100000)


@router.put("/parametres/{cle}")
def modifier_parametre(cle: str, body: Parametre, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("UPDATE env.parametres SET valeur = %s WHERE cle = %s RETURNING cle", (body.valeur, cle))
        if not cur.fetchone():
            raise HTTPException(404, "Paramètre inconnu.")
        if cle == "perimetre_source_m":    # périmètres des points d'eau sans rayon propre
            cur.execute("SELECT id FROM env.points_eau WHERE perimetre_m IS NULL")
            for r in cur.fetchall():
                maj_perimetre(cur, r["id"], u)
        journal(cur, u["id"], "paramètre de l'environnement", cle, str(body.valeur))
    return {"ok": True}


# ---------------------------------------------------------------- exports
@router.get("/export/{quoi}.csv")
def exporter(quoi: str, u: dict = Depends(current_user)):
    with cursor() as cur:
        if quoi == "atteintes":
            cur.execute("""SELECT numero, type, statut, gravite, description, surface_m2::float, responsable, to_char(echeance, 'YYYY-MM-DD') AS echeance_le,
                                  amende_gnf::float, quartier, array_to_string(zones, ', ') AS zones_txt,
                                  round(ST_X(ST_PointOnSurface(geom))::numeric, 6)::float AS lon, round(ST_Y(ST_PointOnSurface(geom))::numeric, 6)::float AS lat,
                                  to_char(cree_le, 'YYYY-MM-DD') AS signalee_le, to_char(clos_le, 'YYYY-MM-DD') AS close_le
                           FROM env.atteintes ORDER BY numero""")
            rows = cur.fetchall()
            if not peut_gerer(u):
                for r in rows:
                    r["responsable"] = None
            return csv_reponse(["Numéro", "Type", "Statut", "Gravité", "Description", "Surface (m²)", "Mis en cause", "Échéance",
                                "Amende (GNF)", "Quartier", "Zones protégées", "Longitude", "Latitude", "Signalée le", "Close le"],
                               rows, "atteintes_environnement_labe.csv")
        if quoi == "plantations":
            cur.execute(f"""SELECT p.numero, p.type, p.espece, p.nombre_plants, to_char(p.date_plantation, 'YYYY-MM-DD') AS plantee_le, p.campagne,
                                   p.organisme, p.quartier, s.vivants, to_char(s.date, 'YYYY-MM-DD') AS dernier_suivi,
                                   round(ST_X(ST_PointOnSurface(p.geom))::numeric, 6)::float AS lon, round(ST_Y(ST_PointOnSurface(p.geom))::numeric, 6)::float AS lat
                            {PLANTATION_FROM} ORDER BY p.numero""")
            return csv_reponse(["Numéro", "Type", "Espèce", "Plants", "Plantée le", "Campagne", "Organisme", "Quartier",
                                "Vivants (dernier suivi)", "Dernier suivi", "Longitude", "Latitude"], cur.fetchall(), "plantations_labe.csv")
        if quoi == "points-eau":
            cur.execute("""SELECT numero, type, nom, etat, usage, CASE WHEN amenage THEN 'oui' ELSE 'non' END AS amenage_txt,
                                  COALESCE(perimetre_m, env.param('perimetre_source_m'))::float AS perimetre, quartier,
                                  round(ST_X(geom)::numeric, 6)::float AS lon, round(ST_Y(geom)::numeric, 6)::float AS lat,
                                  to_char(dernier_constat, 'YYYY-MM-DD') AS constat_le FROM env.points_eau ORDER BY numero""")
            return csv_reponse(["Numéro", "Type", "Nom", "État", "Usage", "Aménagé", "Périmètre (m)", "Quartier", "Longitude", "Latitude",
                                "Dernier constat"], cur.fetchall(), "points_eau_labe.csv")
        if quoi == "feux":
            cur.execute("""SELECT to_char(date_feu, 'YYYY-MM-DD') AS jour, env.saison(date_feu) AS saison, origine, cause, surface_ha::float, confiance,
                                  quartier, round(ST_X(ST_PointOnSurface(geom))::numeric, 6)::float AS lon,
                                  round(ST_Y(ST_PointOnSurface(geom))::numeric, 6)::float AS lat, description
                           FROM env.feux ORDER BY date_feu""")
            return csv_reponse(["Date", "Saison", "Origine", "Cause", "Surface (ha)", "Confiance", "Quartier", "Longitude", "Latitude",
                                "Description"], cur.fetchall(), "feux_brousse_labe.csv")
        if quoi == "batiments-zones":
            cur.execute("""SELECT b.gid, q.quartier, z.code, z.type, z.nom, z.regle,
                                  round(ST_X(ST_Transform(b.p, 4326))::numeric, 6)::float AS lon, round(ST_Y(ST_Transform(b.p, 4326))::numeric, 6)::float AS lat
                           FROM env.zones z JOIN adr.batiments_points b ON b.p && z.geom_m AND ST_Intersects(z.geom_m, b.p)
                           LEFT JOIN dech.bati_quartier q ON q.gid = b.gid
                           WHERE z.active AND z.regle = ANY(%s) ORDER BY q.quartier, b.gid""", (list(STRICTES),))
            return csv_reponse(["Bâtiment n°", "Quartier", "Zone", "Type de zone", "Nom de la zone", "Règle", "Longitude", "Latitude"],
                               cur.fetchall(), "batiments_zones_protegees_labe.csv")
    raise HTTPException(404, "Export inconnu.")


# ---------------------------------------------------------------- carte publique (sans compte)
def fc(cur, sql: str, params=()) -> dict:
    cur.execute(f"""SELECT json_build_object('type', 'FeatureCollection', 'features', COALESCE(json_agg(json_build_object(
                        'type', 'Feature', 'geometry', ST_AsGeoJSON(t.geom, 6)::json, 'properties', to_jsonb(t) - 'geom')), '[]'::json)) AS fc
                    FROM ({sql}) t""", params)
    return cur.fetchone()["fc"]


def donnees_publiques(cur) -> dict:
    return {
        "zones": fc(cur, """SELECT code, type, nom, regle, reference, superficie_ha::float AS superficie_ha,
                                   ST_SimplifyPreserveTopology(geom, 0.00002) AS geom FROM env.zones WHERE active ORDER BY code"""),
        "plantations": fc(cur, f"""SELECT p.numero, p.type, p.espece, p.nombre_plants, to_char(p.date_plantation, 'YYYY-MM-DD') AS date,
                                         p.campagne, p.organisme, p.quartier,
                                         CASE WHEN s.vivants IS NOT NULL THEN round(100.0 * s.vivants / p.nombre_plants) END AS survie_pct, p.geom
                                  {PLANTATION_FROM} ORDER BY p.id"""),
        "points_eau": fc(cur, """SELECT numero, type, nom, etat, CASE WHEN amenage THEN 'oui' ELSE 'non' END AS amenage, quartier, geom
                                 FROM env.points_eau ORDER BY id"""),
        "feux": fc(cur, """SELECT to_char(date_feu, 'YYYY-MM-DD') AS date, env.saison(date_feu) AS saison, origine, cause,
                                  surface_ha::float AS surface_ha, quartier, geom FROM env.feux
                           WHERE date_feu >= current_date - interval '3 years' ORDER BY date_feu"""),
    }


@router.get("/public")
def publiques():
    with cursor() as cur:
        return donnees_publiques(cur)
