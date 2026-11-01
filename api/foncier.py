"""
Foncier : registre communal des parcelles, dossiers fonciers et contrôles géométriques.

- Parcelle « Provisoire » (recensée sur le terrain ou digitalisée) → « Enregistrée » (validée par un superviseur)
  → « Archivée » (remplacée après un morcellement ou une fusion). Chaque changement est gardé dans l'historique.
- Dossier foncier : Déposé → En instruction → Visite effectuée → Avis favorable / défavorable → Approuvé / Rejeté.
  La décision approuvée est appliquée au registre (nouvelle parcelle, découpage, fusion, nouvelles limites, mutation).
- Contrôles (fon.controler) : chevauchements, emprise des voies, berges et plans d'eau, cimetières, zones inondables.

Le registre est un outil de gestion communal : il ne remplace pas le titre foncier délivré par l'État.
"""
import csv
import datetime as dt
import io
import json
from pathlib import Path

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from main import admin, current_user, cursor, journal, superviseur

router = APIRouter(prefix="/foncier")

SERVICE_FONCIER = "Urbanisme et domaines"
USAGES = ["Habitation", "Commerce", "Mixte", "Équipement public", "Culte", "Agricole", "Espace vert", "Réserve",
          "Non bâti", "Autre"]
STATUTS_JURIDIQUES = ["Titre foncier", "Permis d'habiter", "Attestation de cession", "Acte coutumier",
                      "Domaine public", "Réserve communale", "Non documenté"]
SOURCES = ["Digitalisation", "Levé GPS", "Levé topographique", "Plan de lotissement"]
TYPES_DOSSIER = ["Attribution", "Régularisation", "Morcellement", "Fusion", "Mutation (vente)",
                 "Mutation (succession)", "Mutation (donation)", "Bornage", "Changement d'usage"]
CLOS = ("Approuvé", "Rejeté", "Abandonné")
# nombre de parcelles existantes attendues et forme proposée, par type de dossier
REGLES = {
    "Attribution": (0, "une"), "Régularisation": (None, "option"), "Morcellement": (1, "plusieurs"),
    "Fusion": (2, "aucune"), "Mutation (vente)": (1, "aucune"), "Mutation (succession)": (1, "aucune"),
    "Mutation (donation)": (1, "aucune"), "Bornage": (1, "une"), "Changement d'usage": (1, "aucune"),
}


def apply_schema(cur):
    cur.execute((Path(__file__).parent / "foncier.sql").read_text(encoding="utf-8"))
    cur.execute((Path(__file__).parent / "foncier_gestion.sql").read_text(encoding="utf-8"))
    cur.execute("REFRESH MATERIALIZED VIEW fon.zones_inondables_m")
    # codes des quartiers (partagés avec l'adressage) : préfixe des numéros de parcelle
    cur.execute("SELECT count(*)::int AS n FROM adr.quartiers")
    if not cur.fetchone()["n"]:
        import adressage
        cur.execute("SELECT nom FROM ref.quartiers")
        for nom, code in adressage.codes_quartiers([r["nom"] for r in cur.fetchall()]).items():
            cur.execute("INSERT INTO adr.quartiers (nom, code) VALUES (%s, %s) ON CONFLICT DO NOTHING", (nom, code))


# ---------------------------------------------------------------- droits
def est_superviseur(u: dict) -> bool:
    return u["role"] in ("superviseur", "admin")


def peut_instruire(u: dict) -> bool:
    return est_superviseur(u) or u["service"] == SERVICE_FONCIER


def peut_modifier_parcelle(u: dict, p: dict) -> bool:
    if p["etat"] == "Archivée":
        return False
    if est_superviseur(u):
        return True
    return p["etat"] == "Provisoire" and (p["cree_par"] == u["id"] or u["service"] == SERVICE_FONCIER)


# ---------------------------------------------------------------- géométries
def lire_polygone(cur, geometry: dict | None) -> str:
    """GeoJSON Polygon (ou MultiPolygon à une seule partie) → GeoJSON Polygon valide, en WGS84."""
    if not isinstance(geometry, dict) or geometry.get("type") not in ("Polygon", "MultiPolygon"):
        raise HTTPException(400, "Une parcelle se dessine en surface (Polygon).")
    if geometry["type"] == "MultiPolygon":
        if len(geometry.get("coordinates") or []) != 1:
            raise HTTPException(400, "Une parcelle doit être d'un seul tenant.")
        geometry = {"type": "Polygon", "coordinates": geometry["coordinates"][0]}
    gj = json.dumps({"type": "Polygon", "coordinates": geometry.get("coordinates")})
    try:
        cur.execute("""SELECT ST_IsValid(g) AS valide, ST_NPoints(g) AS n, ST_Area(ST_Transform(g, 32628)) AS s,
                              ST_IsValidReason(g) AS raison
                       FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326) AS g) t""", (gj,))
    except psycopg.Error:
        cur.connection.rollback()
        raise HTTPException(400, "Forme illisible.")
    r = cur.fetchone()
    if not r["valide"]:
        raise HTTPException(400, f"Forme invalide (les côtés se croisent ?) : {r['raison']}.")
    if r["n"] > 2000:
        raise HTTPException(400, "Forme trop complexe (2000 sommets maximum).")
    if r["s"] < 10:
        raise HTTPException(400, "Parcelle trop petite (moins de 10 m²).")
    if r["s"] > 2_000_000:
        raise HTTPException(400, "Parcelle trop grande (plus de 200 ha) : vérifiez la forme.")
    return gj


def lire_parties(cur, geometry: dict | None) -> list[str]:
    """Polygon ou MultiPolygon → liste de polygones GeoJSON (parcelles issues d'un morcellement)."""
    if not isinstance(geometry, dict):
        raise HTTPException(400, "Forme proposée manquante.")
    if geometry.get("type") == "Polygon":
        return [lire_polygone(cur, geometry)]
    if geometry.get("type") == "MultiPolygon":
        return [lire_polygone(cur, {"type": "Polygon", "coordinates": c}) for c in geometry.get("coordinates") or []]
    raise HTTPException(400, "Forme proposée : Polygon ou MultiPolygon attendu.")


def controler(cur, gj: str, exclure: list[int] | None = None) -> list[dict]:
    cur.execute("SELECT fon.controler(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s::int[]) AS a", (gj, exclure or []))
    alertes = cur.fetchone()["a"]
    import environnement   # zones protégées (sources, pentes, forêts…), en plus des contrôles du foncier
    return alertes + environnement.alertes_zones(cur, gj)


def bloquants(alertes: list[dict]) -> list[dict]:
    return [a for a in alertes if a.get("niveau") == "bloquant"]


def quartier_de(cur, gj: str) -> str | None:
    cur.execute("""SELECT q.nom FROM ref.quartiers q, (SELECT ST_PointOnSurface(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)) AS p) t
                   WHERE ST_Contains(q.geom, t.p) LIMIT 1""", (gj,))
    r = cur.fetchone()
    return r["nom"] if r else None


# ---------------------------------------------------------------- parcelles
PARCELLE_COLS = """p.id, p.numero, p.quartier, p.usage, p.statut_juridique, p.reference_acte, p.date_acte, p.lotissement,
    p.lot, p.etat, p.source_geom, p.precision_m, p.observations, p.superficie_m2::float, p.perimetre_m::float, p.meres,
    p.dossier_origine, p.alertes, p.cree_le, p.cree_par, p.modifie_le, p.valide_le, p.archive_le, p.archive_motif,
    c.nom AS cree_par_nom, v.nom AS valide_par_nom,
    (SELECT count(*) FROM fon.dossiers d WHERE p.id = ANY (d.parcelles) AND d.statut NOT IN ('Approuvé', 'Rejeté', 'Abandonné'))::int
        AS dossiers_ouverts,
    (SELECT count(*) FROM fon.litiges l WHERE p.id = ANY (l.parcelles)
        AND l.statut IN ('Signalé', 'En médiation', 'Transmis au tribunal'))::int AS litiges_ouverts,
    ST_AsGeoJSON(p.geom, 7)::json AS geometry"""
PARCELLE_FROM = """ FROM fon.parcelles p LEFT JOIN app.utilisateurs c ON c.id = p.cree_par
    LEFT JOIN app.utilisateurs v ON v.id = p.valide_par """


def iso(r: dict, *cles):
    for k in cles:
        if r.get(k) is not None and hasattr(r[k], "isoformat"):
            r[k] = r[k].isoformat(timespec="seconds") if isinstance(r[k], dt.datetime) else r[k].isoformat()
    return r


def feature_parcelle(r: dict) -> dict:
    geom = r.pop("geometry")
    iso(r, "date_acte", "cree_le", "modifie_le", "valide_le", "archive_le")
    r["precision_m"] = float(r["precision_m"]) if r.get("precision_m") is not None else None
    return {"type": "Feature", "id": r["id"], "geometry": geom, "properties": r}


def lire_parcelle(cur, pid: int, verrou: bool = False) -> dict:
    cur.execute("SELECT * FROM fon.parcelles WHERE id = %s" + (" FOR UPDATE" if verrou else ""), (pid,))
    p = cur.fetchone()
    if not p:
        raise HTTPException(404, f"Parcelle n° {pid} introuvable.")
    return p


def une_parcelle(cur, pid: int) -> dict:
    cur.execute(f"SELECT {PARCELLE_COLS} {PARCELLE_FROM} WHERE p.id = %s", (pid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Parcelle introuvable.")
    return feature_parcelle(r)


ATTRIBUTS = ("quartier", "usage", "statut_juridique", "reference_acte", "date_acte", "lotissement", "lot", "etat",
             "source_geom", "precision_m", "observations")


def historiser_parcelle(cur, pid: int, uid: int | None, action: str, commentaire: str | None = None,
                        dossier: int | None = None, avec_geom: bool = False):
    """Garde l'état de la parcelle avant le changement (attributs, et limites si elles changent)."""
    cur.execute(f"""INSERT INTO fon.parcelles_historique (parcelle, utilisateur, action, dossier, commentaire, attributs, geom)
                    SELECT id, %s, %s, %s, %s, jsonb_build_object({', '.join(f"'{a}', {a}" for a in ATTRIBUTS)}),
                           CASE WHEN %s THEN geom END
                    FROM fon.parcelles WHERE id = %s""", (uid, action, dossier, commentaire, avec_geom, pid))


def inserer_parcelle(cur, gj: str, attrs: dict, u: dict, etat: str, action: str, meres: list[int] | None = None,
                     dossier: int | None = None, alertes: list | None = None) -> int:
    quartier = attrs.get("quartier") or quartier_de(cur, gj)
    for essai in range(5):   # numéro unique : on réessaie si deux saisies simultanées prennent le même
        cur.execute("SELECT fon.prochain_numero(%s) AS n", (quartier,))
        numero = cur.fetchone()["n"]
        try:
            cur.execute("SAVEPOINT num")
            cur.execute("""INSERT INTO fon.parcelles (numero, quartier, usage, statut_juridique, reference_acte, date_acte,
                                  lotissement, lot, etat, source_geom, precision_m, observations, geom, meres, dossier_origine,
                                  alertes, cree_par, valide_le, valide_par)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326),
                                   %s, %s, %s, %s, CASE WHEN %s = 'Enregistrée' THEN now() END,
                                   CASE WHEN %s = 'Enregistrée' THEN %s END)
                           RETURNING id""",
                        (numero, quartier, attrs.get("usage") or "Habitation", attrs.get("statut_juridique") or "Non documenté",
                         attrs.get("reference_acte"), attrs.get("date_acte"), attrs.get("lotissement"), attrs.get("lot"),
                         etat, attrs.get("source_geom") or "Digitalisation", attrs.get("precision_m"),
                         attrs.get("observations"), gj, meres or [], dossier, json.dumps(alertes or []),
                         u["id"], etat, etat, u["id"]))
            pid = cur.fetchone()["id"]
            cur.execute("RELEASE SAVEPOINT num")
            break
        except psycopg.errors.UniqueViolation:
            cur.execute("ROLLBACK TO SAVEPOINT num")
    else:
        raise HTTPException(409, "Numérotation impossible, réessayez.")
    cur.execute("""INSERT INTO fon.parcelles_historique (parcelle, utilisateur, action, dossier, commentaire)
                   VALUES (%s, %s, %s, %s, %s)""", (pid, u["id"], action, dossier, attrs.get("commentaire")))
    return pid


class ParcelleIn(BaseModel):
    geometry: dict | None = None
    usage: str | None = None
    statut_juridique: str | None = None
    reference_acte: str | None = Field(None, max_length=120)
    date_acte: dt.date | None = None
    lotissement: str | None = Field(None, max_length=120)
    lot: str | None = Field(None, max_length=30)
    source_geom: str | None = None
    precision_m: float | None = Field(None, ge=0, le=100)
    observations: str | None = Field(None, max_length=2000)
    quartier: str | None = Field(None, max_length=80)
    commentaire: str | None = Field(None, max_length=1000)   # motif du changement (historique)
    forcer: bool = False                                      # superviseur : passer outre un contrôle bloquant


def verifier_attributs(d: dict):
    if d.get("usage") and d["usage"] not in USAGES:
        raise HTTPException(400, "Usage inconnu.")
    if d.get("statut_juridique") and d["statut_juridique"] not in STATUTS_JURIDIQUES:
        raise HTTPException(400, "Statut juridique inconnu.")
    if d.get("source_geom") and d["source_geom"] not in SOURCES:
        raise HTTPException(400, "Source de la forme inconnue.")


@router.get("/listes")
def listes(u: dict = Depends(current_user)):
    return {"usages": USAGES, "statuts_juridiques": STATUTS_JURIDIQUES, "sources": SOURCES, "types_dossier": TYPES_DOSSIER,
            "regles": {k: {"parcelles": v[0], "forme": v[1]} for k, v in REGLES.items()},
            "peut_instruire": peut_instruire(u), "service_foncier": SERVICE_FONCIER}


@router.get("/parcelles")
def lister_parcelles(archives: bool = False, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute(f"SELECT {PARCELLE_COLS} {PARCELLE_FROM}" + ("" if archives else " WHERE p.etat <> 'Archivée'") +
                    " ORDER BY p.numero")
        return {"type": "FeatureCollection", "features": [feature_parcelle(r) for r in cur.fetchall()]}


@router.get("/parcelles/{pid}")
def fiche_parcelle(pid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        f = une_parcelle(cur, pid)
        cur.execute("""SELECT h.id, h.date, h.action, h.dossier, h.commentaire, h.attributs, (h.geom IS NOT NULL) AS a_forme,
                              u.nom AS utilisateur, d.numero AS dossier_numero
                       FROM fon.parcelles_historique h LEFT JOIN app.utilisateurs u ON u.id = h.utilisateur
                       LEFT JOIN fon.dossiers d ON d.id = h.dossier
                       WHERE h.parcelle = %s ORDER BY h.date, h.id""", (pid,))
        f["historique"] = [iso(r, "date") for r in cur.fetchall()]
        cur.execute("""SELECT id, numero, type, statut, demandeur_nom, depose_le FROM fon.dossiers
                       WHERE %s = ANY (parcelles) OR %s = ANY (parcelles_creees) ORDER BY depose_le DESC""", (pid, pid))
        f["dossiers"] = [iso(r, "depose_le") for r in cur.fetchall()]
        # bâti et adresses situés sur la parcelle
        cur.execute("""SELECT count(*)::int AS n FROM adr.batiments_points b, fon.parcelles p
                       WHERE p.id = %s AND ST_Contains(p.geom_m, b.p)""", (pid,))
        f["properties"]["nb_batiments"] = cur.fetchone()["n"]
        cur.execute("""SELECT a.numero || a.suffixe || ', ' || v.type_voie || ' ' || COALESCE(v.nom, v.code) AS libelle, a.statut
                       FROM adr.adresses a JOIN adr.voies v ON v.id = a.voie_id, fon.parcelles p
                       WHERE p.id = %s AND ST_Contains(p.geom, a.geom) ORDER BY a.numero""", (pid,))
        f["adresses"] = cur.fetchall()
        cur.execute("SELECT numero FROM fon.parcelles WHERE id = ANY (%s)", (f["properties"]["meres"],))
        f["properties"]["meres_numeros"] = [r["numero"] for r in cur.fetchall()]
        cur.execute("SELECT id, numero FROM fon.parcelles WHERE %s = ANY (meres) ORDER BY numero", (pid,))
        f["filles"] = cur.fetchall()
        p = lire_parcelle(cur, pid)
        f["peut_modifier"] = peut_modifier_parcelle(u, p)
    return f


@router.get("/parcelles/{pid}/historique/{hid}/forme")
def ancienne_forme(pid: int, hid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT ST_AsGeoJSON(geom, 7)::json AS g FROM fon.parcelles_historique WHERE id = %s AND parcelle = %s",
                    (hid, pid))
        r = cur.fetchone()
    if not r or not r["g"]:
        raise HTTPException(404, "Pas de forme pour cette étape.")
    return r["g"]


@router.post("/controle")
def controle(body: dict, u: dict = Depends(current_user)):
    """Contrôle d'une forme avant enregistrement (pendant le dessin)."""
    with cursor() as cur:
        parties = lire_parties(cur, body.get("geometry"))
        exclure = [int(x) for x in body.get("exclure") or []]
        return {"alertes": [a for gj in parties for a in controler(cur, gj, exclure)]}


@router.post("/decouper")
def decouper(body: dict, u: dict = Depends(current_user)):
    """Découpe une ou plusieurs surfaces par une ligne (morcellement) ; retourne les morceaux."""
    ligne = body.get("ligne")
    if not isinstance(ligne, dict) or ligne.get("type") != "LineString" or len(ligne.get("coordinates") or []) < 2:
        raise HTTPException(400, "Ligne de découpage invalide.")
    with cursor() as cur:
        parties = lire_parties(cur, body.get("geometry"))
        cur.execute("""SELECT ST_AsGeoJSON(ST_Transform(d.geom, 4326), 7)::json AS g, ST_Area(d.geom) AS s
                       FROM (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(x), 4326), 32628) AS g FROM unnest(%s::text[]) x) t,
                            (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 32628) AS l) k,
                            LATERAL ST_Dump(ST_Split(t.g, k.l)) d
                       WHERE ST_Area(d.geom) > 1""", (parties, json.dumps(ligne)))
        morceaux = cur.fetchall()
    if len(morceaux) <= len(parties):
        raise HTTPException(400, "La ligne doit traverser la parcelle de part en part.")
    return {"type": "MultiPolygon", "coordinates": [m["g"]["coordinates"] for m in morceaux],
            "superficies": [round(m["s"], 1) for m in morceaux]}


@router.post("/parcelles", status_code=201)
def creer_parcelle(body: ParcelleIn, u: dict = Depends(current_user)):
    d = body.model_dump()
    verifier_attributs(d)
    with cursor() as cur:
        gj = lire_polygone(cur, body.geometry)
        alertes = controler(cur, gj)
        if bloquants(alertes) and not (body.forcer and est_superviseur(u)):
            raise HTTPException(409, {"message": "Contrôle bloquant : " + " ".join(a["message"] for a in bloquants(alertes)),
                                      "alertes": alertes})
        pid = inserer_parcelle(cur, gj, d, u, "Provisoire", "recensement", alertes=alertes)
        journal(cur, u["id"], "ajout de parcelle", f"parcelle {pid}", d.get("observations"))
        return une_parcelle(cur, pid)


@router.put("/parcelles/{pid}")
def modifier_parcelle(pid: int, body: ParcelleIn, u: dict = Depends(current_user)):
    d = body.model_dump(exclude_unset=True)
    verifier_attributs(d)
    with cursor() as cur:
        p = lire_parcelle(cur, pid, verrou=True)
        if not peut_modifier_parcelle(u, p):
            raise HTTPException(403, "Parcelle archivée, ou parcelle enregistrée : seul un superviseur peut la modifier "
                                     "(ou un dossier foncier approuvé).")
        sets, vals = [], []
        for k in ("usage", "statut_juridique", "reference_acte", "date_acte", "lotissement", "lot", "source_geom",
                  "precision_m", "observations", "quartier"):
            if k in d:
                sets.append(f"{k} = %s")
                vals.append(d[k] if d[k] != "" else None)
        forme = bool(body.geometry)
        if forme:
            gj = lire_polygone(cur, body.geometry)
            alertes = controler(cur, gj, [pid])
            if bloquants(alertes) and not (body.forcer and est_superviseur(u)):
                raise HTTPException(409, {"message": "Contrôle bloquant : " + " ".join(a["message"] for a in bloquants(alertes)),
                                          "alertes": alertes})
            sets += ["geom = ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)", "alertes = %s"]
            vals += [gj, json.dumps(alertes)]
        if not sets:
            raise HTTPException(400, "Rien à modifier.")
        if p["etat"] == "Enregistrée" and not d.get("commentaire"):
            raise HTTPException(400, "Parcelle enregistrée : indiquez le motif de la modification.")
        historiser_parcelle(cur, pid, u["id"], "modification des limites" if forme else "modification", d.get("commentaire"),
                            avec_geom=forme)
        sets += ["modifie_le = now()", "modifie_par = %s"]
        vals.append(u["id"])
        cur.execute(f"UPDATE fon.parcelles SET {', '.join(sets)} WHERE id = %s", vals + [pid])
        journal(cur, u["id"], "modification de parcelle", f"parcelle {pid}", p["numero"])
        return une_parcelle(cur, pid)


class Decision(BaseModel):
    commentaire: str | None = Field(None, max_length=1000)
    forcer: bool = False


@router.post("/parcelles/{pid}/valider")
def valider_parcelle(pid: int, body: Decision, u: dict = Depends(superviseur)):
    with cursor() as cur:
        p = lire_parcelle(cur, pid, verrou=True)
        if p["etat"] != "Provisoire":
            raise HTTPException(409, "Seule une parcelle provisoire peut être validée.")
        cur.execute("SELECT ST_AsGeoJSON(geom) AS g FROM fon.parcelles WHERE id = %s", (pid,))
        alertes = controler(cur, cur.fetchone()["g"], [pid])
        if bloquants(alertes) and not (body.forcer and body.commentaire):
            raise HTTPException(409, {"message": "Contrôle bloquant : " + " ".join(a["message"] for a in bloquants(alertes)) +
                                      " Corrigez la forme, ou validez quand même en indiquant un motif.", "alertes": alertes})
        historiser_parcelle(cur, pid, u["id"], "validation (enregistrement au registre)", body.commentaire)
        cur.execute("""UPDATE fon.parcelles SET etat = 'Enregistrée', valide_le = now(), valide_par = %s, alertes = %s
                       WHERE id = %s""", (u["id"], json.dumps(alertes), pid))
        journal(cur, u["id"], "validation de parcelle", f"parcelle {pid}", p["numero"])
        return une_parcelle(cur, pid)


@router.delete("/parcelles/{pid}")
def supprimer_parcelle(pid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        p = lire_parcelle(cur, pid, verrou=True)
        if p["etat"] != "Provisoire" or not peut_modifier_parcelle(u, p):
            raise HTTPException(403, "Seule une parcelle provisoire peut être supprimée (par son auteur ou un superviseur).")
        cur.execute("SELECT 1 FROM fon.dossiers WHERE %s = ANY (parcelles) LIMIT 1", (pid,))
        if cur.fetchone():
            raise HTTPException(409, "Un dossier foncier concerne cette parcelle : elle ne peut pas être supprimée.")
        cur.execute("DELETE FROM fon.parcelles WHERE id = %s", (pid,))
        journal(cur, u["id"], "suppression de parcelle", f"parcelle {pid}", p["numero"])
    return {"ok": True}


@router.post("/parcelles/recontroler")
def recontroler(u: dict = Depends(superviseur)):
    """Refait les contrôles de toutes les parcelles (après une mise à jour des données de référence)."""
    with cursor() as cur:
        cur.execute("REFRESH MATERIALIZED VIEW fon.zones_inondables_m")
        cur.execute("""UPDATE fon.parcelles p SET alertes = fon.controler(p.geom, ARRAY[p.id] || p.meres)
                       WHERE p.etat <> 'Archivée'""")
        n = cur.rowcount
        journal(cur, u["id"], "contrôle du registre foncier", None, f"{n} parcelles")
    return {"parcelles": n}


# ---------------------------------------------------------------- contrôles d'ensemble et tableau de bord
@router.get("/controles")
def controles(u: dict = Depends(current_user)):
    with cursor() as cur:
        tol = cur.execute("SELECT fon.param('tolerance_chevauchement_m2', 2) AS t").fetchone()["t"]
        cur.execute("""SELECT a.id AS id_a, a.numero AS numero_a, b.id AS id_b, b.numero AS numero_b, a.quartier,
                              round(ST_Area(ST_Intersection(a.geom_m, b.geom_m))::numeric, 1)::float AS m2,
                              ST_AsGeoJSON(ST_Transform(ST_CollectionExtract(ST_Intersection(a.geom_m, b.geom_m), 3), 4326), 7)::json
                                  AS geometry
                       FROM fon.parcelles a JOIN fon.parcelles b
                         ON a.id < b.id AND a.geom_m && b.geom_m AND ST_Intersects(a.geom_m, b.geom_m)
                       WHERE a.etat <> 'Archivée' AND b.etat <> 'Archivée'
                         AND ST_Area(ST_Intersection(a.geom_m, b.geom_m)) > %s
                       ORDER BY m2 DESC""", (tol,))
        chevauchements = cur.fetchall()
        cur.execute("""SELECT p.id, p.numero, p.quartier, p.etat, a AS alerte
                       FROM fon.parcelles p, jsonb_array_elements(p.alertes) a
                       WHERE p.etat <> 'Archivée' AND a->>'type' <> 'chevauchement'
                       ORDER BY a->>'type', p.numero""")
        risques = cur.fetchall()
        # bâtiments sans parcelle, par quartier (là où le recensement a commencé)
        cur.execute("""WITH q AS (SELECT DISTINCT quartier FROM fon.parcelles WHERE etat <> 'Archivée')
                       SELECT rq.nom AS quartier, count(*)::int AS batiments,
                              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM fon.parcelles p
                                    WHERE p.etat <> 'Archivée' AND ST_Contains(p.geom_m, b.p)))::int AS couverts
                       FROM ref.quartiers rq JOIN q ON q.quartier = rq.nom
                       JOIN adr.batiments_points b ON ST_Contains(ST_Transform(rq.geom, 32628), b.p)
                       GROUP BY rq.nom ORDER BY rq.nom""")
        couverture = cur.fetchall()
    return {"chevauchements": chevauchements, "risques": risques, "couverture": couverture}


@router.get("/batiments-sans-parcelle")
def batiments_sans_parcelle(quartier: str, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("""SELECT b.gid, ST_X(ST_Transform(b.p, 4326)) AS lon, ST_Y(ST_Transform(b.p, 4326)) AS lat
                       FROM adr.batiments_points b JOIN ref.quartiers q ON q.nom = %s
                         AND ST_Contains(ST_Transform(q.geom, 32628), b.p)
                       WHERE NOT EXISTS (SELECT 1 FROM fon.parcelles p WHERE p.etat <> 'Archivée' AND ST_Contains(p.geom_m, b.p))
                       LIMIT 5000""", (quartier,))
        return cur.fetchall()


@router.get("/tableau-de-bord")
def tableau_de_bord(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("""SELECT quartier, count(*)::int AS parcelles,
                              count(*) FILTER (WHERE etat = 'Enregistrée')::int AS enregistrees,
                              count(*) FILTER (WHERE etat = 'Provisoire')::int AS provisoires,
                              count(*) FILTER (WHERE statut_juridique = 'Titre foncier')::int AS titrees,
                              count(*) FILTER (WHERE statut_juridique = 'Non documenté')::int AS non_documentees,
                              round(sum(superficie_m2) / 10000, 2)::float AS ha,
                              count(*) FILTER (WHERE jsonb_array_length(alertes) > 0)::int AS avec_alertes
                       FROM fon.parcelles WHERE etat <> 'Archivée' GROUP BY quartier ORDER BY quartier""")
        quartiers = cur.fetchall()
        cur.execute("""SELECT statut_juridique, count(*)::int AS n FROM fon.parcelles WHERE etat <> 'Archivée'
                       GROUP BY 1 ORDER BY n DESC""")
        juridique = cur.fetchall()
        cur.execute("""SELECT statut, count(*)::int AS n FROM fon.dossiers GROUP BY 1""")
        dossiers = {r["statut"]: r["n"] for r in cur.fetchall()}
        cur.execute("""SELECT count(*)::int AS n FROM fon.dossiers
                       WHERE statut NOT IN ('Approuvé', 'Rejeté', 'Abandonné') AND echeance < current_date""")
        retard = cur.fetchone()["n"]
        cur.execute("""SELECT round(avg(extract(epoch FROM decide_le - depose_le) / 86400)::numeric, 1)::float AS j
                       FROM fon.dossiers WHERE decide_le > now() - interval '90 days'""")
        delai = cur.fetchone()["j"]
    return {"quartiers": quartiers, "juridique": juridique, "dossiers": dossiers, "retard": retard, "delai_moyen_j": delai}


@router.get("/export.csv")
def export_registre(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("""SELECT numero, quartier, usage, statut_juridique, reference_acte, date_acte, lotissement, lot, etat,
                              superficie_m2, perimetre_m, source_geom, precision_m,
                              round(ST_X(ST_PointOnSurface(geom))::numeric, 6) AS lon,
                              round(ST_Y(ST_PointOnSurface(geom))::numeric, 6) AS lat,
                              (SELECT string_agg(a->>'message', ' | ') FROM jsonb_array_elements(alertes) a) AS alertes,
                              to_char(cree_le, 'YYYY-MM-DD') AS cree_le, to_char(valide_le, 'YYYY-MM-DD') AS valide_le
                       FROM fon.parcelles WHERE etat <> 'Archivée' ORDER BY numero""")
        rows = cur.fetchall()
    buf = io.StringIO()
    buf.write("﻿")
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Numéro", "Quartier", "Usage", "Statut juridique", "Référence de l'acte", "Date de l'acte", "Lotissement",
                "Lot", "État", "Superficie (m²)", "Périmètre (m)", "Source", "Précision (m)", "Longitude", "Latitude",
                "Alertes", "Recensée le", "Validée le"])
    for r in rows:
        w.writerow([("" if v is None else str(v).replace(".", ",") if isinstance(v, float) else v) for v in r.values()])
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": "attachment; filename=registre_foncier_labe.csv"})


@router.get("/parametres")
def lire_parametres(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT cle, valeur::float, libelle FROM fon.parametres ORDER BY cle")
        return cur.fetchall()


@router.put("/parametres/{cle}")
def maj_parametre(cle: str, body: dict, u: dict = Depends(admin)):
    try:
        v = float(body.get("valeur"))
    except (TypeError, ValueError):
        raise HTTPException(400, "Valeur numérique attendue.")
    if v < 0 or v > 1000:
        raise HTTPException(400, "Valeur hors limites.")
    with cursor() as cur:
        cur.execute("UPDATE fon.parametres SET valeur = %s WHERE cle = %s RETURNING libelle", (v, cle))
        if not cur.fetchone():
            raise HTTPException(404, "Paramètre inconnu.")
        journal(cur, u["id"], "paramètre foncier", cle, str(v))
    return {"ok": True}


# ---------------------------------------------------------------- dossiers fonciers
DOSSIER_COLS = """d.id, d.numero, d.type, d.statut, d.parcelles, d.quartier, d.objet, d.demandeur_nom, d.demandeur_telephone,
    d.demandeur_piece, d.usage_demande, d.statut_juridique, d.reference_acte, d.service, d.instructeur, d.echeance,
    d.visite_le, d.compte_rendu, d.avis_motif, d.decision_ref, d.decide_le, d.motif_rejet, d.parcelles_creees, d.alertes,
    d.depose_le, d.depose_par, d.modifie_le, i.nom AS instructeur_nom, dp.nom AS depose_par_nom, dd.nom AS decide_par_nom,
    (SELECT array_agg(p.numero ORDER BY p.numero) FROM fon.parcelles p WHERE p.id = ANY (d.parcelles)) AS parcelles_numeros,
    (SELECT array_agg(p.numero ORDER BY p.numero) FROM fon.parcelles p WHERE p.id = ANY (d.parcelles_creees)) AS creees_numeros,
    ST_AsGeoJSON(COALESCE(d.geom_proposee,
        (SELECT ST_Multi(ST_Union(p.geom)) FROM fon.parcelles p WHERE p.id = ANY (d.parcelles))), 7)::json AS geometry"""
DOSSIER_FROM = """ FROM fon.dossiers d LEFT JOIN app.utilisateurs i ON i.id = d.instructeur
    LEFT JOIN app.utilisateurs dp ON dp.id = d.depose_par LEFT JOIN app.utilisateurs dd ON dd.id = d.decide_par """


def feature_dossier(r: dict, u: dict) -> dict:
    geom = r.pop("geometry")
    iso(r, "echeance", "visite_le", "decide_le", "depose_le", "modifie_le")
    r["parcelles_numeros"] = r["parcelles_numeros"] or []
    r["creees_numeros"] = r["creees_numeros"] or []
    if not (peut_instruire(u) or r["depose_par"] == u["id"]):
        r["demandeur_telephone"] = r["demandeur_piece"] = None     # données personnelles : accès réservé
    return {"type": "Feature", "id": r["id"], "geometry": geom, "properties": r}


def un_dossier(cur, did: int, u: dict) -> dict:
    cur.execute(f"SELECT {DOSSIER_COLS} {DOSSIER_FROM} WHERE d.id = %s", (did,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Dossier introuvable.")
    return feature_dossier(r, u)


def historiser_dossier(cur, did: int, uid: int, action: str, avant: str | None, apres: str | None, commentaire: str | None = None):
    cur.execute("""INSERT INTO fon.dossiers_historique (dossier, utilisateur, action, statut_avant, statut_apres, commentaire)
                   VALUES (%s, %s, %s, %s, %s, %s)""", (did, uid, action, avant, apres, commentaire))


class DossierIn(BaseModel):
    type: str
    parcelles: list[int] = []
    geometry: dict | None = None            # nouvelles limites proposées
    objet: str | None = Field(None, max_length=2000)
    demandeur_nom: str = Field(min_length=2, max_length=150)
    demandeur_telephone: str | None = Field(None, max_length=30)
    demandeur_piece: str | None = Field(None, max_length=60)
    usage_demande: str | None = None
    statut_juridique: str | None = None
    reference_acte: str | None = Field(None, max_length=120)
    echeance: dt.date | None = None


def verifier_dossier(cur, type_: str, parcelles: list[int], geometry: dict | None) -> tuple[list[str], list[dict]]:
    """Contrôle la cohérence du dossier ; retourne les polygones proposés et les alertes."""
    if type_ not in REGLES:
        raise HTTPException(400, "Type de dossier inconnu.")
    nb, forme = REGLES[type_]
    if nb == 0 and parcelles:
        raise HTTPException(400, "Une attribution porte sur un nouveau terrain : ne choisissez pas de parcelle existante.")
    if nb == 1 and len(parcelles) != 1:
        raise HTTPException(400, f"Un dossier « {type_} » porte sur une seule parcelle existante.")
    if nb == 2 and len(parcelles) < 2:
        raise HTTPException(400, "Une fusion porte sur au moins deux parcelles voisines.")
    if type_ == "Régularisation" and len(parcelles) > 1:
        raise HTTPException(400, "Une régularisation porte sur une seule parcelle.")
    for pid in parcelles:
        p = lire_parcelle(cur, pid)
        if p["etat"] == "Archivée":
            raise HTTPException(400, f"La parcelle {p['numero']} est archivée.")
    parties = lire_parties(cur, geometry) if geometry else []
    if forme in ("une", "plusieurs") and not parties:
        raise HTTPException(400, "Dessinez les limites proposées.")
    if forme == "une" and len(parties) != 1:
        raise HTTPException(400, "Une seule surface attendue.")
    if forme == "plusieurs" and len(parties) < 2:
        raise HTTPException(400, "Un morcellement donne au moins deux parcelles.")
    if type_ == "Régularisation" and not parcelles and len(parties) != 1:
        raise HTTPException(400, "Régularisation : choisissez la parcelle concernée ou dessinez le terrain.")
    if forme == "aucune":
        parties = []
    alertes = []
    for gj in parties:
        alertes += controler(cur, gj, parcelles)
    if type_ == "Morcellement":
        # les parcelles issues du découpage doivent rester dans la parcelle mère et ne pas se chevaucher
        cur.execute("""SELECT ST_Area(ST_Difference(u, m.geom_m)) AS dehors, ST_Area(m.geom_m) - ST_Area(u) AS reste,
                              (SELECT sum(ST_Area(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(x), 4326), 32628))) FROM unnest(%s::text[]) x)
                                - ST_Area(u) AS recouvrement
                       FROM fon.parcelles m,
                            (SELECT ST_Union(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(x), 4326), 32628)) AS u
                             FROM unnest(%s::text[]) x) t
                       WHERE m.id = %s""", (parties, parties, parcelles[0]))
        r = cur.fetchone()
        if r["dehors"] > 2:
            alertes.append({"type": "morcellement", "niveau": "bloquant", "m2": round(r["dehors"], 1),
                            "message": f"Les nouvelles parcelles débordent de {round(r['dehors'])} m² de la parcelle mère."})
        if r["recouvrement"] > 2:
            alertes.append({"type": "morcellement", "niveau": "bloquant", "m2": round(r["recouvrement"], 1),
                            "message": f"Les nouvelles parcelles se chevauchent sur {round(r['recouvrement'])} m²."})
        if r["reste"] > 5:
            alertes.append({"type": "morcellement", "niveau": "info", "m2": round(r["reste"], 1),
                            "message": f"{round(r['reste'])} m² de la parcelle mère ne sont dans aucune nouvelle parcelle "
                                       "(voie de desserte ?)."})
    if type_ == "Fusion":
        cur.execute("""SELECT ST_NumGeometries(ST_Union(ST_Buffer(geom_m, 0.5))) AS n FROM fon.parcelles WHERE id = ANY (%s)""",
                    (parcelles,))
        if cur.fetchone()["n"] != 1:
            raise HTTPException(400, "Les parcelles à fusionner ne sont pas contiguës.")
    import foncier_gestion   # litiges en cours sur les parcelles concernées (import tardif : modules liés)
    alertes += foncier_gestion.alertes_litiges(cur, parcelles)
    return parties, alertes


@router.get("/dossiers")
def lister_dossiers(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute(f"SELECT {DOSSIER_COLS} {DOSSIER_FROM} ORDER BY d.depose_le DESC")
        return {"type": "FeatureCollection", "features": [feature_dossier(r, u) for r in cur.fetchall()]}


@router.get("/dossiers/{did}")
def fiche_dossier(did: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        f = un_dossier(cur, did, u)
        cur.execute("""SELECT h.date, h.action, h.statut_avant, h.statut_apres, h.commentaire, u.nom AS utilisateur
                       FROM fon.dossiers_historique h LEFT JOIN app.utilisateurs u ON u.id = h.utilisateur
                       WHERE h.dossier = %s ORDER BY h.date, h.id""", (did,))
        f["historique"] = [iso(r, "date") for r in cur.fetchall()]
        if peut_instruire(u):
            cur.execute("""SELECT id, nom FROM app.utilisateurs WHERE statut = 'actif'
                             AND (service = %s OR role IN ('superviseur', 'admin')) ORDER BY nom""", (SERVICE_FONCIER,))
            f["instructeurs"] = cur.fetchall()
    return f


@router.post("/dossiers", status_code=201)
def deposer(body: DossierIn, u: dict = Depends(current_user)):
    if body.usage_demande and body.usage_demande not in USAGES:
        raise HTTPException(400, "Usage inconnu.")
    if body.statut_juridique and body.statut_juridique not in STATUTS_JURIDIQUES:
        raise HTTPException(400, "Statut juridique inconnu.")
    if body.type == "Changement d'usage" and not body.usage_demande:
        raise HTTPException(400, "Indiquez le nouvel usage demandé.")
    with cursor() as cur:
        parties, alertes = verifier_dossier(cur, body.type, body.parcelles, body.geometry)
        quartier = quartier_de(cur, parties[0]) if parties else None
        if not quartier and body.parcelles:
            quartier = lire_parcelle(cur, body.parcelles[0])["quartier"]
        annee = dt.date.today().year
        cur.execute("""SELECT %s || lpad((COALESCE(max(substring(numero FROM '(\\d+)$')::int), 0) + 1)::text, 4, '0') AS n
                       FROM fon.dossiers WHERE numero LIKE %s""", (f"DF-{annee}-", f"DF-{annee}-%"))
        numero = cur.fetchone()["n"]
        cur.execute("""INSERT INTO fon.dossiers (numero, type, parcelles, geom_proposee, quartier, objet, demandeur_nom,
                              demandeur_telephone, demandeur_piece, usage_demande, statut_juridique, reference_acte, echeance,
                              alertes, depose_par)
                       VALUES (%s, %s, %s,
                               (SELECT ST_Multi(ST_Collect(ST_SetSRID(ST_GeomFromGeoJSON(x), 4326))) FROM unnest(%s::text[]) x),
                               %s, %s, %s, %s, %s, %s, %s, %s, COALESCE(%s, current_date + 30), %s, %s)
                       RETURNING id""",
                    (numero, body.type, body.parcelles, parties, quartier, body.objet, body.demandeur_nom.strip(),
                     body.demandeur_telephone, body.demandeur_piece, body.usage_demande, body.statut_juridique,
                     body.reference_acte, body.echeance, json.dumps(alertes), u["id"]))
        did = cur.fetchone()["id"]
        historiser_dossier(cur, did, u["id"], "dépôt", None, "Déposé", body.objet)
        journal(cur, u["id"], "dépôt de dossier foncier", f"dossier {did}", f"{numero} {body.type}")
        return un_dossier(cur, did, u)


class ActionDossier(BaseModel):
    action: str = Field(pattern=r"^(instruire|visite|avis_favorable|avis_defavorable|approuver|rejeter|abandonner|commenter|limites)$")
    instructeur: int | None = None
    echeance: dt.date | None = None
    visite_le: dt.date | None = None
    commentaire: str | None = Field(None, max_length=2000)
    decision_ref: str | None = Field(None, max_length=120)
    geometry: dict | None = None            # « limites » : nouvelles limites relevées lors de la visite
    forcer: bool = False


@router.post("/dossiers/{did}/action")
def action_dossier(did: int, body: ActionDossier, u: dict = Depends(current_user)):
    a = body.action
    with cursor() as cur:
        cur.execute("SELECT * FROM fon.dossiers WHERE id = %s FOR UPDATE", (did,))
        d = cur.fetchone()
        if not d:
            raise HTTPException(404, "Dossier introuvable.")
        s = d["statut"]
        if a == "commenter":
            if not body.commentaire:
                raise HTTPException(400, "Commentaire vide.")
            historiser_dossier(cur, did, u["id"], "commentaire", s, s, body.commentaire)
            return un_dossier(cur, did, u)
        if s in CLOS:
            raise HTTPException(409, f"Dossier clos ({s.lower()}).")
        instructeur_ou_sup = est_superviseur(u) or (d["instructeur"] == u["id"])
        sets, vals, nouveau = [], [], s
        if a == "instruire":
            if not peut_instruire(u):
                raise HTTPException(403, f"Réservé au service {SERVICE_FONCIER} et aux superviseurs.")
            if s not in ("Déposé", "En instruction"):
                raise HTTPException(409, "Le dossier est déjà au-delà de l'instruction.")
            inst = body.instructeur or u["id"]
            cur.execute("SELECT nom FROM app.utilisateurs WHERE id = %s AND statut = 'actif'", (inst,))
            r = cur.fetchone()
            if not r:
                raise HTTPException(400, "Instructeur inconnu.")
            nouveau = "En instruction"
            sets += ["instructeur = %s", "echeance = COALESCE(%s, echeance)"]
            vals += [inst, body.echeance]
            commentaire = f"instructeur : {r['nom']}" + (f" — {body.commentaire}" if body.commentaire else "")
        elif a == "limites":
            if not instructeur_ou_sup:
                raise HTTPException(403, "Réservé à l'instructeur du dossier et aux superviseurs.")
            if REGLES[d["type"]][1] == "aucune":
                raise HTTPException(400, "Ce type de dossier ne modifie pas les limites.")
            parties, alertes = verifier_dossier(cur, d["type"], d["parcelles"], body.geometry)
            sets += ["geom_proposee = (SELECT ST_Multi(ST_Collect(ST_SetSRID(ST_GeomFromGeoJSON(x), 4326))) FROM unnest(%s::text[]) x)",
                     "alertes = %s"]
            vals += [parties, json.dumps(alertes)]
            commentaire = body.commentaire or "limites relevées sur le terrain"
        elif a == "visite":
            if not instructeur_ou_sup:
                raise HTTPException(403, "Réservé à l'instructeur du dossier et aux superviseurs.")
            if s != "En instruction":
                raise HTTPException(409, "Le dossier doit être en instruction.")
            if not body.commentaire:
                raise HTTPException(400, "Indiquez le compte rendu de la visite.")
            nouveau = "Visite effectuée"
            sets += ["visite_le = %s", "compte_rendu = %s"]
            vals += [body.visite_le or dt.date.today(), body.commentaire]
            commentaire = body.commentaire
        elif a in ("avis_favorable", "avis_defavorable"):
            if not instructeur_ou_sup:
                raise HTTPException(403, "Réservé à l'instructeur du dossier et aux superviseurs.")
            if s not in ("Visite effectuée", "Avis favorable", "Avis défavorable"):
                raise HTTPException(409, "L'avis est donné après la visite de terrain.")
            if a == "avis_defavorable" and not body.commentaire:
                raise HTTPException(400, "Motivez l'avis défavorable.")
            nouveau = "Avis favorable" if a == "avis_favorable" else "Avis défavorable"
            sets.append("avis_motif = %s")
            vals.append(body.commentaire)
            commentaire = body.commentaire
        elif a == "approuver":
            if not est_superviseur(u):
                raise HTTPException(403, "La décision revient à un superviseur.")
            if s != "Avis favorable":
                raise HTTPException(409, "Un dossier est approuvé après un avis favorable.")
            if not body.decision_ref:
                raise HTTPException(400, "Indiquez la référence de la décision (n° d'arrêté ou de délibération).")
            nouveau = "Approuvé"
            creees = appliquer_decision(cur, d, u, body)
            sets += ["decision_ref = %s", "decide_le = now()", "decide_par = %s", "parcelles_creees = %s"]
            vals += [body.decision_ref, u["id"], creees]
            commentaire = f"décision {body.decision_ref}" + (f" — {body.commentaire}" if body.commentaire else "")
        elif a == "rejeter":
            if not est_superviseur(u):
                raise HTTPException(403, "La décision revient à un superviseur.")
            if not body.commentaire:
                raise HTTPException(400, "Indiquez le motif du rejet.")
            nouveau = "Rejeté"
            sets += ["motif_rejet = %s", "decide_le = now()", "decide_par = %s", "decision_ref = %s"]
            vals += [body.commentaire, u["id"], body.decision_ref]
            commentaire = body.commentaire
        else:   # abandonner
            if not (est_superviseur(u) or d["depose_par"] == u["id"]):
                raise HTTPException(403, "Seul l'agent qui a déposé le dossier, ou un superviseur, peut l'abandonner.")
            nouveau = "Abandonné"
            sets += ["motif_rejet = %s", "decide_le = now()"]
            vals.append(body.commentaire)
            commentaire = body.commentaire
        sets += ["statut = %s", "modifie_le = now()"]
        vals.append(nouveau)
        historiser_dossier(cur, did, u["id"], {"instruire": "mise en instruction", "limites": "limites relevées",
                                               "visite": "visite de terrain", "avis_favorable": "avis favorable",
                                               "avis_defavorable": "avis défavorable", "approuver": "approbation",
                                               "rejeter": "rejet", "abandonner": "abandon"}[a], s, nouveau, commentaire)
        cur.execute(f"UPDATE fon.dossiers SET {', '.join(sets)} WHERE id = %s", vals + [did])
        journal(cur, u["id"], f"dossier foncier : {a}", f"dossier {did}", d["numero"])
        return un_dossier(cur, did, u)


def appliquer_decision(cur, d: dict, u: dict, body: ActionDossier) -> list[int]:
    """Applique au registre un dossier approuvé ; retourne les parcelles créées."""
    t, did, ref = d["type"], d["id"], body.decision_ref
    cur.execute("SELECT ST_AsGeoJSON((ST_Dump(geom_proposee)).geom, 7) AS g FROM fon.dossiers WHERE id = %s", (did,))
    parties = [r["g"] for r in cur.fetchall() if r["g"]]
    # contrôles au moment de la décision (le registre a pu changer depuis le dépôt)
    parties_v, alertes = verifier_dossier(cur, t, d["parcelles"], {"type": "MultiPolygon", "coordinates":
                                          [json.loads(g)["coordinates"] for g in parties]} if parties else None)
    if bloquants(alertes) and not (body.forcer and body.commentaire):
        raise HTTPException(409, {"message": "Contrôle bloquant : " + " ".join(x["message"] for x in bloquants(alertes)) +
                                  " Corrigez les limites, ou approuvez quand même en indiquant un motif.", "alertes": alertes})
    attrs = {"statut_juridique": d["statut_juridique"], "reference_acte": d["reference_acte"] or ref,
             "usage": d["usage_demande"], "source_geom": "Levé topographique" if d["visite_le"] else None,
             "commentaire": f"dossier {d['numero']} ({t.lower()}), décision {ref}"}
    creees: list[int] = []
    fin = f"dossier {d['numero']}, décision {ref}"

    def archiver(pid: int, motif: str):
        historiser_parcelle(cur, pid, u["id"], "archivage", motif, did)
        cur.execute("""UPDATE fon.parcelles SET etat = 'Archivée', archive_le = now(), archive_motif = %s, modifie_le = now(),
                              modifie_par = %s WHERE id = %s""", (motif, u["id"], pid))

    if t == "Attribution" or (t == "Régularisation" and not d["parcelles"]):
        attrs["statut_juridique"] = attrs["statut_juridique"] or "Attestation de cession"
        creees.append(inserer_parcelle(cur, parties_v[0], attrs, u, "Enregistrée", t.lower(), dossier=did,
                                       alertes=controler(cur, parties_v[0])))
    elif t == "Morcellement":
        mere = lire_parcelle(cur, d["parcelles"][0])
        for gj in parties_v:
            a2 = {k: mere[k] for k in ATTRIBUTS if k not in ("etat", "quartier")}
            a2.update({k: v for k, v in attrs.items() if v})
            a2["reference_acte"] = d["reference_acte"] or mere["reference_acte"]
            creees.append(inserer_parcelle(cur, gj, a2, u, "Enregistrée", "morcellement", meres=[mere["id"]], dossier=did))
        archiver(mere["id"], f"morcellement ({fin})")
        for pid in creees:
            cur.execute("UPDATE fon.parcelles SET alertes = fon.controler(geom, ARRAY[id]) WHERE id = %s", (pid,))
    elif t == "Fusion":
        cur.execute("""SELECT ST_AsGeoJSON(ST_Buffer(ST_Buffer(ST_Union(geom_m), 0.5), -0.5), 7) AS g,
                              (array_agg(statut_juridique ORDER BY superficie_m2 DESC))[1] AS sj,
                              (array_agg(usage ORDER BY superficie_m2 DESC))[1] AS usage
                       FROM fon.parcelles WHERE id = ANY (%s)""", (d["parcelles"],))
        r = cur.fetchone()
        cur.execute("SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 32628), 4326), 7) AS g", (r["g"],))
        gj = cur.fetchone()["g"]
        a2 = {"statut_juridique": attrs["statut_juridique"] or r["sj"], "usage": attrs["usage"] or r["usage"],
              "reference_acte": attrs["reference_acte"], "commentaire": attrs["commentaire"]}
        for pid in d["parcelles"]:
            archiver(pid, f"fusion ({fin})")
        creees.append(inserer_parcelle(cur, gj, a2, u, "Enregistrée", "fusion", meres=d["parcelles"], dossier=did,
                                       alertes=controler(cur, gj)))
    else:
        # la parcelle reste la même : nouvelles limites (bornage, régularisation), nouveau statut ou nouvel usage
        pid = d["parcelles"][0]
        p = lire_parcelle(cur, pid, verrou=True)
        sets, vals = ["etat = 'Enregistrée'", "valide_le = COALESCE(valide_le, now())", "valide_par = COALESCE(valide_par, %s)",
                      "modifie_le = now()", "modifie_par = %s"], [u["id"], u["id"]]
        avec_geom = bool(parties_v) and t in ("Bornage", "Régularisation")
        if avec_geom:
            sets += ["geom = ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)", "source_geom = 'Levé topographique'"]
            vals.append(parties_v[0])
        if t == "Changement d'usage":
            sets.append("usage = %s")
            vals.append(d["usage_demande"])
        if t.startswith("Mutation") or t == "Régularisation":
            if d["statut_juridique"]:
                sets.append("statut_juridique = %s")
                vals.append(d["statut_juridique"])
            sets.append("reference_acte = %s")
            vals.append(d["reference_acte"] or ref)
        historiser_parcelle(cur, pid, u["id"], t.lower(), f"{fin} — demandeur : {d['demandeur_nom']}", did, avec_geom)
        cur.execute(f"UPDATE fon.parcelles SET {', '.join(sets)} WHERE id = %s", vals + [pid])
        cur.execute("UPDATE fon.parcelles SET alertes = fon.controler(geom, ARRAY[id] || meres) WHERE id = %s", (pid,))
        journal(cur, u["id"], f"parcelle : {t.lower()}", f"parcelle {pid}", p["numero"])
    import foncier_gestion   # les droits (titulaires) suivent la décision
    foncier_gestion.transferer_titulaires(cur, d, u, creees)
    return creees
