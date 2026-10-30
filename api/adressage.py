"""
Adressage : voies (code + nom officiel) et numérotation métrique des bâtiments.

- Numéro = distance en mètres depuis le début de la voie, pair à droite, impair à gauche.
- Adresse « Proposée » (calcul automatique) → « Validée » (superviseur) → « Plaque posée » (terrain).
- Une adresse validée ne change plus jamais de numéro, même si la voie est renumérotée.
"""
import csv
import io
import json
import re
import unicodedata
from pathlib import Path

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field

from main import admin, current_user, cursor, journal, superviseur

router = APIRouter(prefix="/adressage")

TYPES_VOIE = ["Rue", "Avenue", "Boulevard", "Route", "Impasse", "Allée", "Place", "Corniche"]
STATUTS_NOM = ["Sans nom", "Nom d'usage", "Proposé", "Officiel"]
STATUTS_ADR = ["Proposée", "Validée", "Plaque posée"]
# Type de voie déduit de la classification OSM
TYPE_OSM = {
    "Voie rapide": "Route", "Route primaire": "Route", "Route secondaire": "Route",
    "Route tertiaire": "Avenue", "Route d accès": "Impasse",
}


def apply_schema(cur):
    cur.execute((Path(__file__).parent / "adressage.sql").read_text(encoding="utf-8"))


# ---------------------------------------------------------------- codes des quartiers
def _sans_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").upper()


def codes_quartiers(noms: list[str]) -> dict[str, str]:
    """« Daka 1 » → DK1, « Kouroula » → KRL, « Madina » → MDN ; unicité garantie."""
    used, out = set(), {}
    for nom in sorted(noms):
        s = _sans_accents(nom)
        m = re.search(r"(\d+)\s*$", s)
        chiffre = m.group(1) if m else ""
        lettres = re.sub(r"[^A-Z]", "", s[:m.start()] if m else s)
        cons = [c for c in lettres[1:] if c not in "AEIOUY"]
        autres = [c for c in lettres[1:] if c not in cons]
        pool = cons + autres
        n = 1 if chiffre else 2
        candidats = []
        if n == 1:
            candidats = [lettres[0] + c + chiffre for c in pool]
        else:
            candidats = [lettres[0] + a + b for i, a in enumerate(pool) for b in pool[i + 1:]]
        candidats += [lettres[:2] + str(i) for i in range(1, 100)]
        code = next(c for c in candidats if c not in used)
        used.add(code)
        out[nom] = code
    return out


# ---------------------------------------------------------------- initialisation depuis OSM
@router.post("/initialiser")
def initialiser(u: dict = Depends(admin)):
    """Crée les voies à partir de la voirie OSM puis propose les adresses de tous les bâtiments."""
    with cursor() as cur:
        cur.execute("SELECT count(*)::int AS n FROM adr.voies")
        if cur.fetchone()["n"]:
            raise HTTPException(409, "Les voies existent déjà : l'initialisation ne peut être faite qu'une fois.")
        nb_bati = cur.execute("SELECT adr.rafraichir_batiments() AS n").fetchone()["n"]

        cur.execute("SELECT nom FROM ref.quartiers")
        codes = codes_quartiers([r["nom"] for r in cur.fetchall()])
        for nom, code in codes.items():
            cur.execute("INSERT INTO adr.quartiers (nom, code) VALUES (%s, %s) ON CONFLICT (nom) DO NOTHING", (nom, code))

        # Centre-ville : centroïde du quartier « Mairie » (sinon de la commune)
        cur.execute("""SELECT ST_Transform(COALESCE(
                         (SELECT ST_Centroid(geom) FROM ref.quartiers WHERE nom = 'Mairie'),
                         (SELECT ST_Centroid(geom) FROM ref.limite_commune LIMIT 1)), 32628) AS c""")
        centre = cur.fetchone()["c"]

        cur.execute("""
            WITH src AS (
                SELECT nature, NULLIF(NULLIF(nom, 'NC'), '') AS nom, NULLIF(NULLIF(numero, 'NC'), '') AS numero, geom
                FROM ref.routes WHERE nature <> 'Chemin non carrossable'
            ),
            lignes AS (   -- tronçons de même nom fusionnés ; voies sans nom gardées telles quelles
                SELECT min(nature) AS nature, nom, min(numero) AS numero,
                       (ST_Dump(ST_LineMerge(ST_Collect(geom)))).geom AS g
                FROM src WHERE nom IS NOT NULL GROUP BY nom
                UNION ALL
                SELECT nature, NULL, numero, (ST_Dump(geom)).geom FROM src WHERE nom IS NULL
            ),
            orientees AS (  -- le début de la voie est l'extrémité la plus proche du centre-ville
                SELECT nature, nom, numero,
                       CASE WHEN ST_Distance(ST_Transform(ST_EndPoint(g), 32628), %(c)s::geometry)
                               < ST_Distance(ST_Transform(ST_StartPoint(g), 32628), %(c)s::geometry)
                            THEN ST_Reverse(g) ELSE g END AS g
                FROM lignes
                WHERE GeometryType(g) = 'LINESTRING' AND ST_Length(g::geography) >= 20
            ),
            avec_quartier AS (
                SELECT o.*,
                       (SELECT q.nom FROM ref.quartiers q WHERE ST_Intersects(q.geom, o.g)
                        ORDER BY ST_Length(ST_Intersection(q.geom, o.g)::geography) DESC LIMIT 1) AS quartier,
                       ST_Distance(ST_Transform(ST_Centroid(o.g), 32628), %(c)s::geometry) AS d_centre
                FROM orientees o
            )
            INSERT INTO adr.voies (code, type_voie, nom, statut_nom, quartier, source, geom, cree_par)
            SELECT COALESCE(aq.code, 'LAB') || '-' ||
                       lpad(row_number() OVER (PARTITION BY a.quartier ORDER BY a.d_centre)::text, 3, '0'),
                   COALESCE(%(types)s::jsonb ->> a.nature, 'Rue'),
                   COALESCE(a.nom, CASE WHEN a.numero ~ '^N\\d+' THEN 'Nationale ' || a.numero END),
                   CASE WHEN a.nom IS NOT NULL OR a.numero ~ '^N\\d+' THEN 'Nom d''usage' ELSE 'Sans nom' END,
                   a.quartier, 'OSM', a.g, %(uid)s
            FROM avec_quartier a LEFT JOIN adr.quartiers aq ON aq.nom = a.quartier""",
            {"c": centre, "types": json.dumps(TYPE_OSM), "uid": u["id"]})
        nb_voies = cur.rowcount
        cur.execute("SELECT COALESCE(sum(adr.numeroter_voie(id)), 0)::int AS n FROM adr.voies")
        nb_adr = cur.fetchone()["n"]
        journal(cur, u["id"], "initialisation de l'adressage", None,
                f"{nb_voies} voies, {nb_adr} adresses proposées sur {nb_bati} bâtiments")
    return {"voies": nb_voies, "adresses": nb_adr, "batiments": nb_bati}


# ---------------------------------------------------------------- voies
class VoieIn(BaseModel):
    geometry: dict | None = None
    type_voie: str | None = None
    nom: str | None = Field(None, max_length=120)
    statut_nom: str | None = None
    deliberation: str | None = Field(None, max_length=200)


def _check_voie(body: VoieIn):
    if body.type_voie is not None and body.type_voie not in TYPES_VOIE:
        raise HTTPException(400, "Type de voie invalide.")
    if body.statut_nom is not None and body.statut_nom not in STATUTS_NOM:
        raise HTTPException(400, "Statut du nom invalide.")
    if body.statut_nom == "Officiel" and not (body.nom or "").strip():
        raise HTTPException(400, "Un nom officiel est requis pour le statut « Officiel ».")


def _line(cur, geometry: dict) -> str:
    if not isinstance(geometry, dict) or geometry.get("type") != "LineString" or len(geometry.get("coordinates") or []) < 2:
        raise HTTPException(400, "Une voie est une ligne d'au moins deux points.")
    gj = json.dumps({"type": "LineString", "coordinates": geometry["coordinates"]})
    cur.execute("""SELECT ST_IsValid(g) AS ok, EXISTS (SELECT 1 FROM ref.limite_commune c
                     WHERE ST_DWithin(c.geom::geography, g::geography, 500)) AS dedans
                   FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326) AS g) t""", (gj,))
    r = cur.fetchone()
    if not r["ok"] or not r["dedans"]:
        raise HTTPException(400, "Ligne invalide ou hors de la commune.")
    return gj


VOIE_SELECT = """
    SELECT v.id, v.code, v.type_voie, v.nom, v.statut_nom, v.deliberation, v.quartier, v.source,
           v.longueur_m::float AS longueur_m,
           count(a.id) FILTER (WHERE a.statut = 'Proposée')::int AS nb_proposees,
           count(a.id) FILTER (WHERE a.statut = 'Validée')::int AS nb_validees,
           count(a.id) FILTER (WHERE a.statut = 'Plaque posée')::int AS nb_posees,
           ST_AsGeoJSON(v.geom, 6)::json AS geometry
    FROM adr.voies v LEFT JOIN adr.adresses a ON a.voie_id = v.id
"""


def _voie_feature(r):
    g = r.pop("geometry")
    return {"type": "Feature", "id": r["id"], "geometry": g, "properties": r}


@router.get("/voies")
def lister_voies(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute(VOIE_SELECT + " GROUP BY v.id ORDER BY v.code")
        return {"type": "FeatureCollection", "features": [_voie_feature(r) for r in cur.fetchall()]}


@router.post("/voies", status_code=201)
def creer_voie(body: VoieIn, u: dict = Depends(superviseur)):
    _check_voie(body)
    with cursor() as cur:
        gj = _line(cur, body.geometry)
        cur.execute("""SELECT q.nom, aq.code FROM ref.quartiers q LEFT JOIN adr.quartiers aq ON aq.nom = q.nom
                       WHERE ST_Intersects(q.geom, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326))
                       ORDER BY ST_Length(ST_Intersection(q.geom, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326))::geography) DESC
                       LIMIT 1""", (gj, gj))
        q = cur.fetchone() or {"nom": None, "code": None}
        prefix = q["code"] or "LAB"
        cur.execute("""SELECT COALESCE(max(substring(code FROM '-(\\d+)$')::int), 0) + 1 AS n
                       FROM adr.voies WHERE code LIKE %s""", (prefix + "-%",))
        code = f"{prefix}-{cur.fetchone()['n']:03d}"
        nom = (body.nom or "").strip() or None
        cur.execute("""INSERT INTO adr.voies (code, type_voie, nom, statut_nom, deliberation, quartier, geom, cree_par)
                       VALUES (%s, %s, %s, %s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s) RETURNING id""",
                    (code, body.type_voie or "Rue", nom, body.statut_nom or ("Proposé" if nom else "Sans nom"),
                     body.deliberation, q["nom"], gj, u["id"]))
        vid = cur.fetchone()["id"]
        cur.execute("SELECT adr.numeroter_voie(%s) AS n", (vid,))
        n = cur.fetchone()["n"]
        journal(cur, u["id"], "création de voie", code, f"{n} adresses proposées")
        cur.execute(VOIE_SELECT + " WHERE v.id = %s GROUP BY v.id", (vid,))
        return _voie_feature(cur.fetchone())


@router.put("/voies/{vid}")
def modifier_voie(vid: int, body: VoieIn, u: dict = Depends(superviseur)):
    _check_voie(body)
    d = body.model_dump(exclude_unset=True)
    with cursor() as cur:
        cur.execute("SELECT code, nom FROM adr.voies WHERE id = %s", (vid,))
        old = cur.fetchone()
        if not old:
            raise HTTPException(404, "Voie introuvable.")
        sets, vals = [], []
        for k in ("type_voie", "statut_nom", "deliberation"):
            if k in d:
                sets.append(f"{k} = %s")
                vals.append(d[k])
        if "nom" in d:
            sets.append("nom = %s")
            vals.append((d["nom"] or "").strip() or None)
        if d.get("geometry"):
            sets.append("geom = ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)")
            vals.append(_line(cur, d["geometry"]))
        if not sets:
            raise HTTPException(400, "Rien à modifier.")
        sets.append("modifie_le = now()")
        cur.execute(f"UPDATE adr.voies SET {', '.join(sets)} WHERE id = %s", vals + [vid])
        if d.get("geometry"):
            cur.execute("SELECT adr.numeroter_voie(%s)", (vid,))
        detail = ", ".join(f"{k} = {v}" for k, v in d.items() if k != "geometry") or "géométrie"
        journal(cur, u["id"], "modification de voie", old["code"], detail)
        cur.execute(VOIE_SELECT + " WHERE v.id = %s GROUP BY v.id", (vid,))
        return _voie_feature(cur.fetchone())


@router.post("/voies/{vid}/inverser")
def inverser_voie(vid: int, u: dict = Depends(superviseur)):
    """Change le début de la voie (et donc tous les numéros proposés)."""
    with cursor() as cur:
        cur.execute("SELECT count(*)::int AS n FROM adr.adresses WHERE voie_id = %s AND statut <> 'Proposée'", (vid,))
        if cur.fetchone()["n"]:
            raise HTTPException(409, "Impossible : cette voie a des adresses validées ou des plaques posées.")
        cur.execute("UPDATE adr.voies SET geom = ST_Reverse(geom), modifie_le = now() WHERE id = %s RETURNING code", (vid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Voie introuvable.")
        cur.execute("DELETE FROM adr.adresses WHERE voie_id = %s", (vid,))
        cur.execute("SELECT adr.numeroter_voie(%s) AS n", (vid,))
        n = cur.fetchone()["n"]
        journal(cur, u["id"], "inversion du sens de la voie", r["code"], f"{n} adresses recalculées")
    return {"adresses": n}


@router.delete("/voies/{vid}")
def supprimer_voie(vid: int, u: dict = Depends(superviseur)):
    with cursor() as cur:
        cur.execute("SELECT count(*)::int AS n FROM adr.adresses WHERE voie_id = %s AND statut <> 'Proposée'", (vid,))
        if cur.fetchone()["n"]:
            raise HTTPException(409, "Impossible : cette voie a des adresses validées ou des plaques posées.")
        cur.execute("DELETE FROM adr.voies WHERE id = %s RETURNING code", (vid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Voie introuvable.")
        journal(cur, u["id"], "suppression de voie", r["code"])
    return {"ok": True}


# ---------------------------------------------------------------- numérotation et validation en masse
class Cible(BaseModel):
    voie_id: int | None = None
    quartier: str | None = None


def _voies_cibles(cur, c: Cible) -> list[int]:
    if c.voie_id:
        cur.execute("SELECT id FROM adr.voies WHERE id = %s", (c.voie_id,))
    elif c.quartier:
        cur.execute("SELECT id FROM adr.voies WHERE quartier = %s", (c.quartier,))
    else:
        raise HTTPException(400, "Indiquez une voie ou un quartier.")
    return [r["id"] for r in cur.fetchall()]


@router.post("/numeroter")
def numeroter(c: Cible, u: dict = Depends(superviseur)):
    """Recalcule les adresses proposées (les adresses validées ne bougent pas)."""
    with cursor() as cur:
        ids = _voies_cibles(cur, c)
        n = 0
        for vid in ids:
            cur.execute("SELECT adr.numeroter_voie(%s) AS n", (vid,))
            n += cur.fetchone()["n"]
        journal(cur, u["id"], "numérotation", c.quartier or f"voie {c.voie_id}", f"{n} adresses proposées")
    return {"voies": len(ids), "adresses": n}


@router.post("/valider")
def valider_en_masse(c: Cible, u: dict = Depends(superviseur)):
    with cursor() as cur:
        ids = _voies_cibles(cur, c)
        cur.execute("""UPDATE adr.adresses SET statut = 'Validée', valide_par = %s, valide_le = now(), modifie_le = now()
                       WHERE voie_id = ANY(%s) AND statut = 'Proposée'""", (u["id"], ids))
        n = cur.rowcount
        journal(cur, u["id"], "validation d'adresses", c.quartier or f"voie {c.voie_id}", f"{n} adresses")
    return {"adresses": n}


# ---------------------------------------------------------------- adresses
class AdresseIn(BaseModel):
    lon: float | None = None
    lat: float | None = None
    voie_id: int | None = None
    numero: int | None = Field(None, gt=0, lt=100000)
    suffixe: str | None = Field(None, pattern=r"^[A-Z]?$")
    statut: str | None = None
    complement: str | None = Field(None, max_length=200)


ADR_SELECT = """
    SELECT a.id, a.voie_id, a.numero, a.suffixe, a.cote, a.batiment_gid, a.complement, a.quartier, a.statut,
           v.code AS code_voie, v.nom AS nom_voie, v.type_voie,
           adr.libelle(a.numero, a.suffixe, v.type_voie, v.nom, v.code) AS libelle,
           ST_X(a.geom) AS lon, ST_Y(a.geom) AS lat
    FROM adr.adresses a JOIN adr.voies v ON v.id = a.voie_id
"""


def _adr_feature(r):
    lon, lat = r.pop("lon"), r.pop("lat")
    return {"type": "Feature", "id": r["id"], "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
            "properties": r}


@router.get("/adresses")
def lister_adresses(bbox: str = Query(..., description="ouest,sud,est,nord"), u: dict = Depends(current_user)):
    try:
        w, s, e, n = (float(x) for x in bbox.split(","))
    except ValueError:
        raise HTTPException(400, "bbox invalide.")
    if (e - w) * (n - s) > 0.01:
        raise HTTPException(400, "Zone trop grande : zoomez davantage.")
    with cursor() as cur:
        cur.execute(ADR_SELECT + " WHERE a.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326) LIMIT 5000", (w, s, e, n))
        return {"type": "FeatureCollection", "features": [_adr_feature(r) for r in cur.fetchall()]}


@router.post("/adresses", status_code=201)
def creer_adresse(body: AdresseIn, u: dict = Depends(current_user)):
    """Ajoute une adresse à un point : voie la plus proche (ou imposée) et numéro métrique calculé."""
    if body.lon is None or body.lat is None:
        raise HTTPException(400, "Position manquante.")
    with cursor() as cur:
        cur.execute("""
            WITH p AS (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326), 32628) AS p),
            v AS (SELECT w.id, w.geom_m, ST_Distance(w.geom_m, p.p) AS d FROM adr.voies w, p
                  WHERE (%(vid)s::int IS NULL OR w.id = %(vid)s) ORDER BY w.geom_m <-> p.p LIMIT 1)
            SELECT v.id, v.d, (adr.numero_metrique(v.geom_m, p.p)).*,
                   (SELECT b.gid FROM ref.batiments b
                    WHERE ST_Contains(b.geom, ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326))
                      AND NOT EXISTS (SELECT 1 FROM adr.adresses a WHERE a.batiment_gid = b.gid) LIMIT 1) AS gid,
                   (SELECT q.nom FROM ref.quartiers q
                    WHERE ST_Intersects(q.geom, ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326)) LIMIT 1) AS quartier
            FROM v, p""", {"lon": body.lon, "lat": body.lat, "vid": body.voie_id})
        r = cur.fetchone()
        if not r:
            raise HTTPException(400, "Aucune voie trouvée.")
        if r["d"] > 150:
            raise HTTPException(400, f"Le point est à {round(r['d'])} m de la voie la plus proche : tracez d'abord la voie.")
        numero = body.numero or r["numero"]
        cur.execute("SELECT count(*)::int AS n FROM adr.adresses WHERE voie_id = %s AND numero = %s", (r["id"], numero))
        rang = cur.fetchone()["n"]
        suffixe = body.suffixe if body.suffixe is not None else ("" if rang == 0 else chr(64 + rang))
        cote = "pair" if numero % 2 == 0 else "impair"
        try:
            cur.execute("""INSERT INTO adr.adresses (voie_id, numero, suffixe, cote, batiment_gid, complement, quartier, statut, geom)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, 'Proposée', ST_SetSRID(ST_MakePoint(%s, %s), 4326))
                           RETURNING id""",
                        (r["id"], numero, suffixe, cote, r["gid"], body.complement, r["quartier"], body.lon, body.lat))
        except psycopg.errors.UniqueViolation:
            cur.connection.rollback()
            raise HTTPException(409, "Ce numéro existe déjà sur cette voie.")
        aid = cur.fetchone()["id"]
        cur.execute(ADR_SELECT + " WHERE a.id = %s", (aid,))
        f = _adr_feature(cur.fetchone())
        journal(cur, u["id"], "ajout d'adresse", f["properties"]["libelle"])
        return f


@router.put("/adresses/{aid}")
def modifier_adresse(aid: int, body: AdresseIn, u: dict = Depends(current_user)):
    validateur = u["role"] in ("superviseur", "admin")
    d = body.model_dump(exclude_unset=True)
    with cursor() as cur:
        cur.execute("SELECT statut FROM adr.adresses WHERE id = %s FOR UPDATE", (aid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Adresse introuvable.")
        if not validateur:
            # un agent de terrain peut seulement constater la pose de la plaque et compléter l'adresse
            if set(d) - {"statut", "complement"}:
                raise HTTPException(403, "Seul un superviseur peut modifier le numéro.")
            if "statut" in d and not (d["statut"] == "Plaque posée" and row["statut"] == "Validée"):
                raise HTTPException(403, "Un agent peut seulement indiquer « Plaque posée » sur une adresse validée.")
        sets, vals = [], []
        if "statut" in d:
            if d["statut"] not in STATUTS_ADR:
                raise HTTPException(400, "Statut invalide.")
            sets += ["statut = %s", "valide_par = COALESCE(valide_par, %s)",
                     "valide_le = CASE WHEN %s <> 'Proposée' THEN COALESCE(valide_le, now()) END"]
            vals += [d["statut"], u["id"], d["statut"]]
            if d["statut"] == "Plaque posée":
                sets += ["pose_le = now()", "pose_par = %s"]
                vals.append(u["id"])
        if "complement" in d:
            sets.append("complement = %s")
            vals.append(d["complement"])
        if "numero" in d:
            sets += ["numero = %s", "cote = %s"]
            vals += [d["numero"], "pair" if d["numero"] % 2 == 0 else "impair"]
        if "suffixe" in d:
            sets.append("suffixe = %s")
            vals.append(d["suffixe"] or "")
        if not sets:
            raise HTTPException(400, "Rien à modifier.")
        sets.append("modifie_le = now()")
        try:
            cur.execute(f"UPDATE adr.adresses SET {', '.join(sets)} WHERE id = %s", vals + [aid])
        except psycopg.errors.UniqueViolation:
            cur.connection.rollback()
            raise HTTPException(409, "Ce numéro existe déjà sur cette voie.")
        cur.execute(ADR_SELECT + " WHERE a.id = %s", (aid,))
        f = _adr_feature(cur.fetchone())
        journal(cur, u["id"], "modification d'adresse", f["properties"]["libelle"],
                ", ".join(f"{k} = {v}" for k, v in d.items()))
        return f


@router.delete("/adresses/{aid}")
def supprimer_adresse(aid: int, u: dict = Depends(superviseur)):
    with cursor() as cur:
        cur.execute(ADR_SELECT + " WHERE a.id = %s", (aid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Adresse introuvable.")
        cur.execute("DELETE FROM adr.adresses WHERE id = %s", (aid,))
        journal(cur, u["id"], "suppression d'adresse", r["libelle"])
    return {"ok": True}


# ---------------------------------------------------------------- public : quelle est l'adresse de ce point ?
@router.get("/localiser")
def localiser(lon: float, lat: float):
    with cursor() as cur:
        cur.execute("""
            WITH p AS (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326), 32628) AS p),
            v AS (SELECT w.*, ST_Distance(w.geom_m, p.p) AS d FROM adr.voies w, p ORDER BY w.geom_m <-> p.p LIMIT 1)
            SELECT v.code, v.nom, v.type_voie, v.statut_nom, round(v.d)::int AS distance_voie_m,
                   (adr.numero_metrique(v.geom_m, p.p)).*,
                   (SELECT q.nom FROM ref.quartiers q
                    WHERE ST_Intersects(q.geom, ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326)) LIMIT 1) AS quartier
            FROM v, p""", {"lon": lon, "lat": lat})
        r = cur.fetchone()
        if not r or r["distance_voie_m"] > 150:
            return {"trouve": False}
        cur.execute("""SELECT libelle, statut, round(ST_Distance(geom::geography,
                              ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326)::geography))::int AS distance_m
                       FROM adr.adresses_publiques
                       WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326)::geography, 30)
                       ORDER BY geom <-> ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326) LIMIT 1""",
                    {"lon": lon, "lat": lat})
        officielle = cur.fetchone()
    voie = (r["type_voie"] + " " + (f"{r['nom']} ({r['code']})" if r["nom"] else r["code"]))
    return {"trouve": True, "voie": voie, "code_voie": r["code"], "numero_calcule": r["numero"], "cote": r["cote"],
            "distance_m": float(r["distance_m"]), "distance_voie_m": r["distance_voie_m"], "quartier": r["quartier"],
            "adresse_officielle": officielle}


# ---------------------------------------------------------------- suivi et exports
@router.get("/stats")
def stats(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT count(*)::int AS n FROM adr.voies")
        initialise = cur.fetchone()["n"] > 0
        cur.execute("""
            SELECT q.nom AS quartier, aq.code, q.nb_batiments::int AS batiments,
                   (SELECT count(*) FROM adr.voies v WHERE v.quartier = q.nom)::int AS voies,
                   (SELECT count(*) FROM adr.voies v WHERE v.quartier = q.nom AND v.statut_nom = 'Officiel')::int AS voies_officielles,
                   count(a.id) FILTER (WHERE a.statut = 'Proposée')::int AS proposees,
                   count(a.id) FILTER (WHERE a.statut = 'Validée')::int AS validees,
                   count(a.id) FILTER (WHERE a.statut = 'Plaque posée')::int AS posees
            FROM ref.quartiers q
            LEFT JOIN adr.quartiers aq ON aq.nom = q.nom
            LEFT JOIN adr.adresses a ON a.quartier = q.nom
            GROUP BY q.nom, aq.code, q.nb_batiments ORDER BY q.nom""")
        return {"initialise": initialise, "quartiers": cur.fetchall()}


def _csv(rows: list[dict], filename: str) -> Response:
    buf = io.StringIO()
    if rows:
        w = csv.DictWriter(buf, fieldnames=list(rows[0].keys()), delimiter=";")
        w.writeheader()
        w.writerows(rows)
    # BOM UTF-8 et « ; » : ouverture directe dans Excel en français
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/export/adresses.csv")
def export_adresses(quartier: str | None = None, statut: str | None = None, u: dict = Depends(superviseur)):
    with cursor() as cur:
        cur.execute("""
            SELECT a.quartier, v.code AS code_voie, v.type_voie, v.nom AS nom_voie, a.numero, a.suffixe, a.cote,
                   adr.libelle(a.numero, a.suffixe, v.type_voie, v.nom, v.code) AS adresse, a.complement, a.statut,
                   round(ST_Y(a.geom)::numeric, 6) AS latitude, round(ST_X(a.geom)::numeric, 6) AS longitude,
                   a.batiment_gid AS id_batiment
            FROM adr.adresses a JOIN adr.voies v ON v.id = a.voie_id
            WHERE (%(q)s::text IS NULL OR a.quartier = %(q)s) AND (%(s)s::text IS NULL OR a.statut = %(s)s)
            ORDER BY a.quartier, v.code, a.cote, a.numero, a.suffixe""", {"q": quartier, "s": statut})
        return _csv(cur.fetchall(), "adresses_labe.csv")


@router.get("/export/voies.csv")
def export_voies(u: dict = Depends(superviseur)):
    with cursor() as cur:
        cur.execute("""
            SELECT v.quartier, v.code, v.type_voie, v.nom, v.statut_nom, v.deliberation, v.longueur_m,
                   count(a.id)::int AS nb_adresses,
                   round(ST_Y(ST_StartPoint(v.geom))::numeric, 6) AS lat_debut,
                   round(ST_X(ST_StartPoint(v.geom))::numeric, 6) AS lon_debut
            FROM adr.voies v LEFT JOIN adr.adresses a ON a.voie_id = v.id
            GROUP BY v.id ORDER BY v.quartier, v.code""")
        return _csv(cur.fetchall(), "registre_voies_labe.csv")


# ---------------------------------------------------------------- campagne de pose des plaques
@router.get("/a-poser")
def a_poser(lon: float, lat: float, limite: int = 40, u: dict = Depends(current_user)):
    """Adresses validées sans plaque, les plus proches de l'agent (tournée de pose)."""
    with cursor() as cur:
        cur.execute(ADR_SELECT.replace("SELECT a.id,", """SELECT round(ST_Distance(a.geom::geography,
                        ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326)::geography))::int AS distance_m, a.id,""") + """
            WHERE a.statut = 'Validée'
            ORDER BY a.geom <-> ST_SetSRID(ST_MakePoint(%(lon)s, %(lat)s), 4326) LIMIT %(n)s""",
                    {"lon": lon, "lat": lat, "n": min(max(limite, 1), 200)})
        return {"type": "FeatureCollection", "features": [_adr_feature(r) for r in cur.fetchall()]}


@router.get("/poses")
def suivi_poses(jours: int = 30, u: dict = Depends(current_user)):
    """Plaques posées par jour et par agent (suivi de la campagne)."""
    with cursor() as cur:
        cur.execute("""SELECT to_char(d, 'YYYY-MM-DD') AS jour, count(a.id)::int AS n
                       FROM generate_series(current_date - %s + 1, current_date, interval '1 day') d
                       LEFT JOIN adr.adresses a ON a.pose_le::date = d::date
                       GROUP BY d ORDER BY d""", (min(max(jours, 1), 365),))
        par_jour = cur.fetchall()
        cur.execute("""SELECT COALESCE(u.nom, '—') AS agent, count(*)::int AS n, max(a.pose_le)::date::text AS dernier
                       FROM adr.adresses a LEFT JOIN app.utilisateurs u ON u.id = a.pose_par
                       WHERE a.statut = 'Plaque posée' GROUP BY 1 ORDER BY n DESC""")
        return {"par_jour": par_jour, "par_agent": cur.fetchall()}


# ---------------------------------------------------------------- certificat d'adresse (public)
@router.get("/certificat")
def certificat(voie: str, num: str):
    """Données du certificat d'une adresse validée : ?voie=DK1-012&num=42A (code de la voie, numéro)."""
    m = re.fullmatch(r"\s*(\d{1,6})\s*([A-Za-z]?)\s*", num)
    if not m:
        raise HTTPException(400, "Numéro invalide.")
    with cursor() as cur:
        cur.execute("""
            SELECT a.id, a.numero, a.suffixe, a.cote, a.quartier, a.statut, a.complement, a.valide_le, a.pose_le,
                   v.code AS code_voie, v.type_voie, v.nom AS nom_voie, v.statut_nom, v.deliberation,
                   adr.libelle(a.numero, a.suffixe, v.type_voie, v.nom, v.code) AS libelle,
                   round(ST_Y(a.geom)::numeric, 6)::float AS lat, round(ST_X(a.geom)::numeric, 6)::float AS lon
            FROM adr.adresses a JOIN adr.voies v ON v.id = a.voie_id
            WHERE upper(v.code) = upper(%s) AND a.numero = %s AND a.suffixe = upper(%s)""",
                    (voie.strip(), int(m.group(1)), m.group(2)))
        r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Adresse inconnue.")
    if r["statut"] == "Proposée":
        raise HTTPException(409, "Cette adresse n'est pas encore validée par la mairie : pas de certificat possible.")
    for k in ("valide_le", "pose_le"):
        r[k] = r[k].date().isoformat() if r[k] else None
    r["reference"] = f"LAB-ADR-{r['id']:06d}"
    return r
