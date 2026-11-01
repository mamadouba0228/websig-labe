"""
Gestion des déchets : points de collecte et dépotoirs, tournées de collecte, suivi des passages, bilan.

- Points : dépôts sauvages, dépotoirs autorisés, bacs, points de regroupement, centres de transfert, décharge.
  Saisis par les agents (carte ou GPS), vérifiés par le service Hygiène et salubrité, puis publiés sur la carte publique.
  Chaque constat (état, volume, photo) est gardé dans l'historique du point. Un signalement « Dépôt d'ordures »
  peut être converti en dépôt sauvage : le signalement est marqué traité quand le dépôt est résorbé.
- Tournées : suite ordonnée de points, jours de passage, moyen, équipe ; trajet calculé sur la voirie
  (dans le navigateur) ou tracé à la main ; durée = trajet + arrêts.
- Passages : sur le terrain, chaque point est marqué collecté, non collecté (motif) ou saturé. Les envois
  portent un identifiant créé par le téléphone : ils peuvent être faits hors connexion et renvoyés sans doublon.
- Couverture : bâtiments à plus d'une distance réglable d'une tournée ou d'un point de collecte.
"""
import csv
import datetime as dt
import io
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from main import check_geometry, current_user, cursor, decode_photo, historiser, journal

router = APIRouter(prefix="/dechets")

SERVICES_DECHETS = ("Hygiène et salubrité", "Voirie et assainissement")
TYPES = ["Dépôt sauvage", "Dépotoir autorisé", "Bac / conteneur", "Point de regroupement", "Centre de transfert",
         "Décharge finale"]
PREFIXE = {"Dépôt sauvage": "DS", "Dépotoir autorisé": "DA", "Bac / conteneur": "BC", "Point de regroupement": "PR",
           "Centre de transfert": "CT", "Décharge finale": "DF"}
ETATS = ["Actif", "Saturé", "Fermé", "Résorbé"]
ACCES = ["Camion", "Tricycle", "Charrette / à pied"]
MOTIFS = ["Point inaccessible", "Véhicule en panne", "Véhicule plein", "Manque de carburant", "Absence de l'équipe",
          "Pluie / route impraticable", "Autre"]
JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
VITESSE_KMH = {"Camion": 15, "Tricycle": 10, "Charrette / à pied": 4}   # vitesse moyenne en tournée, en ville
# types qui assurent la desserte des habitants (un dépôt sauvage n'en fait pas partie)
DESSERTE = ("Dépotoir autorisé", "Bac / conteneur", "Point de regroupement", "Centre de transfert")
FERMES = ("Fermé", "Résorbé")


def apply_schema(cur):
    cur.execute((Path(__file__).parent / "dechets.sql").read_text(encoding="utf-8"))
    maj_bati_quartier(cur)


def maj_bati_quartier(cur):
    """Centre et quartier de chaque bâtiment (pour la couverture), recalculés si le bâti a changé."""
    cur.execute("""SELECT (SELECT count(*) FROM adr.batiments_points WHERE NOT ST_IsEmpty(p)) AS n,
                          (SELECT count(*) FROM dech.bati_quartier) AS m,
                          EXISTS (SELECT 1 FROM adr.batiments_points b LEFT JOIN dech.bati_quartier q USING (gid)
                                  WHERE q.gid IS NULL AND NOT ST_IsEmpty(b.p)) AS manque""")
    r = cur.fetchone()
    if r["n"] == r["m"] and not r["manque"]:
        return
    cur.execute("TRUNCATE dech.bati_quartier")
    cur.execute("""INSERT INTO dech.bati_quartier (gid, quartier, p)
                   SELECT b.gid, q.nom, b.p FROM adr.batiments_points b
                   LEFT JOIN LATERAL (SELECT nom FROM ref.quartiers q WHERE ST_Contains(q.geom, ST_Transform(b.p, 4326))
                                      LIMIT 1) q ON true
                   WHERE NOT ST_IsEmpty(b.p)""")


# ---------------------------------------------------------------- droits
def peut_gerer(u: dict) -> bool:
    """Vérifier les points, organiser les tournées : superviseurs et services chargés de la salubrité."""
    return u["role"] in ("superviseur", "admin") or u["service"] in SERVICES_DECHETS


def exiger_gestion(u: dict):
    if not peut_gerer(u):
        raise HTTPException(403, "Réservé au service Hygiène et salubrité, à la Voirie et aux superviseurs.")


def param(cur, cle: str) -> float:
    cur.execute("SELECT dech.param(%s)::float AS v", (cle,))
    return cur.fetchone()["v"]


def iso(r: dict, *cles):
    for k in cles:
        if r.get(k) is not None and hasattr(r[k], "isoformat"):
            r[k] = r[k].isoformat(timespec="seconds") if isinstance(r[k], dt.datetime) else r[k].isoformat()
    return r


def quartier_de(cur, gj: str) -> str | None:
    cur.execute("""SELECT q.nom FROM ref.quartiers q, (SELECT ST_PointOnSurface(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)) AS p) t
                   WHERE ST_Contains(q.geom, t.p) LIMIT 1""", (gj,))
    r = cur.fetchone()
    return r["nom"] if r else None


@router.get("/listes")
def listes(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT cle, valeur::float, description FROM dech.parametres ORDER BY cle")
        parametres = cur.fetchall()
    return {"types": TYPES, "etats": ETATS, "acces": ACCES, "moyens": ACCES, "motifs": MOTIFS, "jours": JOURS,
            "desserte": list(DESSERTE), "peut_gerer": peut_gerer(u), "parametres": parametres}


# ---------------------------------------------------------------- points
POINT_COLS = """p.id, p.numero, p.type, p.nom, p.etat, p.volume_m3::float, p.capacite_m3::float, p.acces, p.description,
    p.quartier, p.verifie, p.verifie_le, p.dernier_constat, p.resorbe_le, p.contribution, p.cree_le, p.cree_par,
    p.modifie_le, (p.photo IS NOT NULL) AS a_photo, c.nom AS cree_par_nom, v.nom AS verifie_par_nom,
    (SELECT COALESCE(array_agg(t.code ORDER BY t.code), '{}') FROM dech.tournees t WHERE p.id = ANY (t.points) AND t.active)
        AS tournees,
    ST_AsGeoJSON(p.geom, 7)::json AS geometry"""
POINT_FROM = """ FROM dech.points p LEFT JOIN app.utilisateurs c ON c.id = p.cree_par
    LEFT JOIN app.utilisateurs v ON v.id = p.verifie_par """


def feature_point(r: dict) -> dict:
    g = r.pop("geometry")
    iso(r, "verifie_le", "dernier_constat", "resorbe_le", "cree_le", "modifie_le")
    r["photo_url"] = f"/api/dechets/points/{r['id']}/photo" if r.pop("a_photo") else None
    return {"type": "Feature", "id": r["id"], "geometry": g, "properties": r}


def un_point(cur, pid: int) -> dict:
    cur.execute(f"SELECT {POINT_COLS} {POINT_FROM} WHERE p.id = %s", (pid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Point introuvable.")
    return feature_point(r)


def peut_modifier_point(u: dict, p: dict) -> bool:
    return peut_gerer(u) or (p["cree_par"] == u["id"] and not p["verifie"])


def constater(cur, pid: int, u: dict, action: str, avant: str | None, apres: str | None,
              volume=None, commentaire: str | None = None, photo: bytes | None = None):
    cur.execute("""INSERT INTO dech.constats (point, utilisateur, action, etat_avant, etat_apres, volume_m3, commentaire, photo)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (pid, u["id"] if u else None, action, avant, apres, volume, commentaire, photo))


def changer_etat(cur, pid: int, u: dict, nouveau: str):
    """Effets d'un changement d'état : date de résorption, signalement d'origine marqué traité."""
    if nouveau in FERMES:
        cur.execute("UPDATE dech.points SET resorbe_le = COALESCE(resorbe_le, now()) WHERE id = %s RETURNING contribution, numero",
                    (pid,))
        r = cur.fetchone()
        if r["contribution"]:
            cur.execute("""UPDATE contrib.contributions SET statut = 'Traité', traite_le = now(), modifie_le = now(), modifie_par = %s
                           WHERE id = %s AND statut <> 'Traité' RETURNING id""", (u["nom"], r["contribution"]))
            if cur.fetchone():
                historiser(cur, r["contribution"], u["id"], "traitement", "En cours", "Traité",
                           f"dépôt {r['numero']} {nouveau.lower()}")
    else:
        cur.execute("UPDATE dech.points SET resorbe_le = NULL WHERE id = %s", (pid,))


class PointIn(BaseModel):
    geometry: dict | None = None
    type: str | None = None
    nom: str | None = Field(None, max_length=150)
    etat: str | None = None
    volume_m3: float | None = Field(None, ge=0, le=100000)
    capacite_m3: float | None = Field(None, ge=0, le=100000)
    acces: str | None = None
    description: str | None = Field(None, max_length=2000)
    photo: str | None = None                    # data:image/jpeg;base64,…  ("" pour supprimer)
    uid: str | None = Field(None, pattern=r"^[0-9a-fA-F-]{36}$")
    forcer: bool = False                        # enregistrer malgré un point existant tout près
    commentaire: str | None = Field(None, max_length=1000)


def lire_point(cur, geometry: dict | None) -> str:
    if not isinstance(geometry, dict) or geometry.get("type") != "Point":
        raise HTTPException(400, "Un point de collecte se place par un point sur la carte.")
    return check_geometry(cur, geometry)


def voisin(cur, gj: str, exclure: int | None = None) -> dict | None:
    cur.execute("""SELECT id, numero, type, round(ST_Distance(ST_Transform(geom, 32628),
                          ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 32628)))::int AS d
                   FROM dech.points WHERE etat NOT IN ('Fermé', 'Résorbé') AND id <> %s
                     AND ST_DWithin(ST_Transform(geom, 32628), ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 32628), 15)
                   ORDER BY 4 LIMIT 1""", (gj, exclure or 0, gj))
    return cur.fetchone()


def prochain_numero(cur, type_: str) -> str:
    pre = PREFIXE[type_]
    cur.execute("SELECT pg_advisory_xact_lock(hashtext('dech.numero.' || %s))", (pre,))
    cur.execute("SELECT COALESCE(max(substring(numero FROM 4)::int), 0) + 1 AS n FROM dech.points WHERE numero LIKE %s",
                (pre + "-%",))
    return f"{pre}-{cur.fetchone()['n']:05d}"


@router.get("/points")
def lister_points(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute(f"SELECT {POINT_COLS} {POINT_FROM} ORDER BY p.id DESC")
        return {"type": "FeatureCollection", "features": [feature_point(r) for r in cur.fetchall()]}


@router.get("/points/{pid}")
def lire_un_point(pid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        f = un_point(cur, pid)
        cur.execute("""SELECT c.id, c.date, c.action, c.etat_avant, c.etat_apres, c.volume_m3::float, c.commentaire,
                              (c.photo IS NOT NULL) AS a_photo, u.nom AS utilisateur
                       FROM dech.constats c LEFT JOIN app.utilisateurs u ON u.id = c.utilisateur
                       WHERE c.point = %s ORDER BY c.date DESC, c.id DESC""", (pid,))
        hist = cur.fetchall()
        for h in hist:
            iso(h, "date")
            h["photo_url"] = f"/api/dechets/constats/{h['id']}/photo" if h.pop("a_photo") else None
        cur.execute("""SELECT pp.statut, pp.motif, pp.heure, t.code, t.nom FROM dech.passages_points pp
                       JOIN dech.passages pa ON pa.id = pp.passage JOIN dech.tournees t ON t.id = pa.tournee
                       WHERE pp.point = %s ORDER BY pp.heure DESC LIMIT 20""", (pid,))
        collectes = [iso(r, "heure") for r in cur.fetchall()]
    f["constats"] = hist
    f["collectes"] = collectes
    f["peut_modifier"] = peut_modifier_point(u, f["properties"])
    return f


@router.get("/points/{pid}/photo")
def photo_point(pid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT photo FROM dech.points WHERE id = %s", (pid,))
        r = cur.fetchone()
    if not r or not r["photo"]:
        raise HTTPException(404, "Pas de photo.")
    return Response(bytes(r["photo"]), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@router.get("/constats/{cid}/photo")
def photo_constat(cid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT photo FROM dech.constats WHERE id = %s", (cid,))
        r = cur.fetchone()
    if not r or not r["photo"]:
        raise HTTPException(404, "Pas de photo.")
    return Response(bytes(r["photo"]), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@router.post("/points", status_code=201)
def creer_point(body: PointIn, u: dict = Depends(current_user)):
    if body.type not in TYPES:
        raise HTTPException(400, "Choisissez le type de point.")
    etat = body.etat or "Actif"
    if etat not in ETATS or body.acces and body.acces not in ACCES:
        raise HTTPException(400, "État ou accès invalide.")
    with cursor() as cur:
        if body.uid:   # renvoi d'une saisie hors connexion déjà reçue
            cur.execute("SELECT id FROM dech.points WHERE uid = %s", (body.uid,))
            deja = cur.fetchone()
            if deja:
                return un_point(cur, deja["id"])
        gj = lire_point(cur, body.geometry)
        v = voisin(cur, gj)
        if v and not body.forcer:
            raise HTTPException(409, {"message": f"Un point existe déjà à {v['d']} m : {v['numero']} ({v['type']}). "
                                                 "Ajoutez plutôt un constat sur ce point, ou confirmez qu'il s'agit d'un autre point.",
                                      "proche": v})
        verifie = peut_gerer(u)
        numero = prochain_numero(cur, body.type)
        cur.execute("""INSERT INTO dech.points (numero, uid, type, nom, etat, volume_m3, capacite_m3, acces, description,
                                                quartier, photo, geom, verifie, verifie_le, verifie_par, cree_par)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326),
                               %s, CASE WHEN %s THEN now() END, %s, %s) RETURNING id""",
                    (numero, body.uid, body.type, body.nom, etat, body.volume_m3, body.capacite_m3, body.acces or "Camion",
                     body.description, quartier_de(cur, gj), decode_photo(body.photo), gj, verifie, verifie,
                     u["id"] if verifie else None, u["id"]))
        pid = cur.fetchone()["id"]
        constater(cur, pid, u, "recensement", None, etat, body.volume_m3, body.commentaire or body.description)
        if etat in FERMES:
            changer_etat(cur, pid, u, etat)
        journal(cur, u["id"], "ajout d'un point de collecte", f"point {numero}", body.type)
        return un_point(cur, pid)


@router.put("/points/{pid}")
def modifier_point(pid: int, body: PointIn, u: dict = Depends(current_user)):
    d = body.model_dump(exclude_unset=True)
    with cursor() as cur:
        cur.execute("SELECT cree_par, verifie, etat, numero FROM dech.points WHERE id = %s FOR UPDATE", (pid,))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "Point introuvable.")
        if not peut_modifier_point(u, p):
            raise HTTPException(403, "Seul le service Hygiène et salubrité modifie un point vérifié.")
        sets, vals = [], []
        if "type" in d and d["type"] not in TYPES or "acces" in d and d["acces"] not in ACCES:
            raise HTTPException(400, "Type ou accès invalide.")
        for k in ("type", "nom", "volume_m3", "capacite_m3", "acces", "description"):
            if k in d:
                sets.append(f"{k} = %s")
                vals.append(d[k])
        if "photo" in d:
            sets.append("photo = %s")
            vals.append(decode_photo(d["photo"]))
        if body.geometry:
            gj = lire_point(cur, body.geometry)
            v = voisin(cur, gj, pid)
            if v and not body.forcer:
                raise HTTPException(409, {"message": f"Un autre point existe à {v['d']} m : {v['numero']}.", "proche": v})
            sets += ["geom = ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)", "quartier = %s"]
            vals += [gj, quartier_de(cur, gj)]
        if not sets:
            raise HTTPException(400, "Rien à modifier.")
        sets.append("modifie_le = now()")
        cur.execute(f"UPDATE dech.points SET {', '.join(sets)} WHERE id = %s", vals + [pid])
        constater(cur, pid, u, "déplacement" if body.geometry else "modification", p["etat"], p["etat"],
                  commentaire=body.commentaire)
        journal(cur, u["id"], "modification d'un point de collecte", f"point {p['numero']}", body.commentaire)
        return un_point(cur, pid)


class ConstatIn(BaseModel):
    etat: str
    volume_m3: float | None = Field(None, ge=0, le=100000)
    commentaire: str | None = Field(None, max_length=1000)
    photo: str | None = None


@router.post("/points/{pid}/constat")
def nouveau_constat(pid: int, body: ConstatIn, u: dict = Depends(current_user)):
    """Constat sur le terrain (tous les agents) : état, volume estimé, photo."""
    if body.etat not in ETATS:
        raise HTTPException(400, "État invalide.")
    with cursor() as cur:
        cur.execute("SELECT etat, numero FROM dech.points WHERE id = %s FOR UPDATE", (pid,))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "Point introuvable.")
        photo = decode_photo(body.photo)
        cur.execute("""UPDATE dech.points SET etat = %s, volume_m3 = COALESCE(%s, CASE WHEN %s IN ('Résorbé', 'Fermé') THEN 0 ELSE volume_m3 END),
                              dernier_constat = now(), modifie_le = now(), photo = COALESCE(%s, photo) WHERE id = %s""",
                    (body.etat, body.volume_m3, body.etat, photo, pid))
        constater(cur, pid, u, "constat", p["etat"], body.etat, body.volume_m3, body.commentaire, photo)
        if body.etat != p["etat"]:
            changer_etat(cur, pid, u, body.etat)
        journal(cur, u["id"], "constat sur un point de collecte", f"point {p['numero']}", f"{p['etat']} → {body.etat}")
        return un_point(cur, pid)


@router.post("/points/{pid}/verifier")
def verifier_point(pid: int, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("""UPDATE dech.points SET verifie = true, verifie_le = now(), verifie_par = %s
                       WHERE id = %s AND NOT verifie RETURNING numero, etat""", (u["id"], pid))
        r = cur.fetchone()
        if not r:
            raise HTTPException(409, "Point introuvable ou déjà vérifié.")
        constater(cur, pid, u, "vérification (publié sur la carte publique)", r["etat"], r["etat"])
        journal(cur, u["id"], "vérification d'un point de collecte", f"point {r['numero']}")
        return un_point(cur, pid)


@router.delete("/points/{pid}")
def supprimer_point(pid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT cree_par, verifie, numero, contribution FROM dech.points WHERE id = %s", (pid,))
        p = cur.fetchone()
        if not p:
            raise HTTPException(404, "Point introuvable.")
        if not peut_modifier_point(u, p):
            raise HTTPException(403, "Vous ne pouvez supprimer que vos propres points non vérifiés.")
        cur.execute("SELECT code FROM dech.tournees WHERE %s = ANY (points)", (pid,))
        codes = [r["code"] for r in cur.fetchall()]
        cur.execute("UPDATE dech.tournees SET points = array_remove(points, %s), modifie_le = now() WHERE %s = ANY (points)",
                    (pid, pid))
        cur.execute("UPDATE dech.passages SET points = array_remove(points, %s) WHERE %s = ANY (points)", (pid, pid))
        cur.execute("DELETE FROM dech.points WHERE id = %s", (pid,))
        journal(cur, u["id"], "suppression d'un point de collecte", f"point {p['numero']}",
                ("retiré des tournées " + ", ".join(codes)) if codes else None)
    return {"ok": True, "tournees": codes}


# ---------------------------------------------------------------- signalements « Dépôt d'ordures »
@router.get("/signalements")
def signalements(u: dict = Depends(current_user)):
    """Signalements de dépôts d'ordures validés, pas encore rattachés à un point."""
    with cursor() as cur:
        cur.execute("""SELECT c.id, c.nom, c.description, c.quartier, c.statut, c.cree_le, COALESCE(a.nom, c.auteur) AS auteur,
                              ST_AsGeoJSON(ST_PointOnSurface(c.geom), 7)::json AS geometry,
                              (SELECT p.numero FROM dech.points p
                               WHERE p.etat NOT IN ('Fermé', 'Résorbé')
                                 AND ST_DWithin(ST_Transform(p.geom, 32628), ST_Transform(ST_PointOnSurface(c.geom), 32628), 30)
                               ORDER BY ST_Distance(p.geom, c.geom) LIMIT 1) AS point_proche
                       FROM contrib.contributions c LEFT JOIN app.utilisateurs a ON a.id = c.cree_par
                       WHERE c.categorie = 'Signalement' AND c.type = 'Dépôt d''ordures'
                         AND c.statut IN ('Validé', 'Affecté', 'En cours')
                         AND NOT EXISTS (SELECT 1 FROM dech.points p WHERE p.contribution = c.id)
                       ORDER BY c.cree_le""")
        return [iso(r, "cree_le") for r in cur.fetchall()]


class Conversion(BaseModel):
    volume_m3: float | None = Field(None, ge=0, le=100000)
    rattacher: str | None = Field(None, max_length=20)   # numéro d'un point existant (au lieu d'en créer un)


@router.post("/signalements/{cid}/convertir")
def convertir(cid: int, body: Conversion, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("""SELECT id, nom, description, statut, photo, ST_AsGeoJSON(ST_PointOnSurface(geom), 7) AS g
                       FROM contrib.contributions WHERE id = %s AND type = 'Dépôt d''ordures' FOR UPDATE""", (cid,))
        c = cur.fetchone()
        if not c:
            raise HTTPException(404, "Signalement introuvable.")
        if body.rattacher:
            cur.execute("SELECT id, numero, contribution FROM dech.points WHERE numero = %s", (body.rattacher,))
            p = cur.fetchone()
            if not p:
                raise HTTPException(404, "Point à rattacher introuvable.")
            pid, numero = p["id"], p["numero"]
            if not p["contribution"]:
                cur.execute("UPDATE dech.points SET contribution = %s WHERE id = %s", (cid, pid))
            constater(cur, pid, u, "signalement rattaché", None, None, commentaire=f"signalement n° {cid}")
        else:
            numero = prochain_numero(cur, "Dépôt sauvage")
            cur.execute("""INSERT INTO dech.points (numero, type, nom, etat, volume_m3, description, quartier, photo, geom,
                                                    verifie, verifie_le, verifie_par, contribution, cree_par)
                           VALUES (%s, 'Dépôt sauvage', %s, 'Actif', %s, %s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326),
                                   true, now(), %s, %s, %s) RETURNING id""",
                        (numero, c["nom"], body.volume_m3, c["description"], quartier_de(cur, c["g"]), c["photo"], c["g"],
                         u["id"], cid, u["id"]))
            pid = cur.fetchone()["id"]
            constater(cur, pid, u, "recensement (signalement n° %d)" % cid, None, "Actif", body.volume_m3, c["description"])
        if c["statut"] != "En cours":
            cur.execute("""UPDATE contrib.contributions SET statut = 'En cours', service_affecte = COALESCE(service_affecte, %s),
                                  affecte_le = COALESCE(affecte_le, now()), modifie_le = now(), modifie_par = %s WHERE id = %s""",
                        (SERVICES_DECHETS[0], u["nom"], cid))
        historiser(cur, cid, u["id"], "prise en charge", c["statut"], "En cours", f"dépôt sauvage {numero} (gestion des déchets)")
        journal(cur, u["id"], "signalement converti en dépôt", f"contribution {cid}", numero)
        return un_point(cur, pid)


# ---------------------------------------------------------------- tournées
TOURNEE_COLS = """t.id, t.code, t.nom, t.jours, to_char(t.heure_depart, 'HH24:MI') AS heure_depart, t.moyen, t.vehicule,
    t.equipe, t.prestataire, t.points, t.longueur_m::float, t.duree_min::float, t.trace_manuel, t.active, t.observations,
    t.cree_le, t.modifie_le,
    (SELECT COALESCE(array_agg(DISTINCT q.nom ORDER BY q.nom), '{}') FROM ref.quartiers q
     WHERE t.geom IS NOT NULL AND ST_Intersects(q.geom, t.geom)) AS quartiers,
    (SELECT max(p.date) FROM dech.passages p WHERE p.tournee = t.id AND p.statut <> 'Annulé') AS dernier_passage,
    ST_AsGeoJSON(t.geom, 6)::json AS geometry"""


def feature_tournee(r: dict) -> dict:
    g = r.pop("geometry")
    iso(r, "cree_le", "modifie_le", "dernier_passage")
    r["jours_texte"] = texte_jours(r["jours"])
    return {"type": "Feature", "id": r["id"], "geometry": g, "properties": r}


def texte_jours(jours: list[int]) -> str:
    j = sorted(set(jours or []))
    if len(j) == 7:
        return "tous les jours"
    if j == [1, 2, 3, 4, 5, 6]:
        return "du lundi au samedi"
    if j == [1, 2, 3, 4, 5]:
        return "du lundi au vendredi"
    return ", ".join(JOURS[d - 1] for d in j) or "aucun jour fixé"


@router.get("/tournees")
def lister_tournees(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute(f"SELECT {TOURNEE_COLS} FROM dech.tournees t ORDER BY t.active DESC, t.code")
        return {"type": "FeatureCollection", "features": [feature_tournee(r) for r in cur.fetchall()]}


def une_tournee(cur, tid: int) -> dict:
    cur.execute(f"SELECT {TOURNEE_COLS} FROM dech.tournees t WHERE t.id = %s", (tid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Tournée introuvable.")
    return feature_tournee(r)


@router.get("/tournees/{tid}")
def lire_tournee(tid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        f = une_tournee(cur, tid)
        cur.execute("""SELECT p.id, p.numero, p.type, p.nom, p.etat, p.quartier, o.n AS ordre, ST_AsGeoJSON(p.geom, 7)::json AS geometry
                       FROM dech.tournees t, unnest(t.points) WITH ORDINALITY o(id, n) JOIN dech.points p ON p.id = o.id
                       WHERE t.id = %s ORDER BY o.n""", (tid,))
        f["points_detail"] = cur.fetchall()
        cur.execute("""SELECT pa.id, pa.uid, pa.date, pa.debut, pa.fin, pa.statut, pa.commentaire, u.nom AS agent,
                              cardinality(pa.points) AS prevus,
                              (SELECT count(*) FROM dech.passages_points pp WHERE pp.passage = pa.id AND pp.statut = 'Collecté')::int AS collectes,
                              (SELECT count(*) FROM dech.passages_points pp WHERE pp.passage = pa.id AND pp.statut <> 'Collecté')::int AS problemes
                       FROM dech.passages pa LEFT JOIN app.utilisateurs u ON u.id = pa.agent
                       WHERE pa.tournee = %s ORDER BY pa.date DESC, pa.debut DESC LIMIT 30""", (tid,))
        f["passages"] = [iso(r, "date", "debut", "fin") for r in cur.fetchall()]
        r_m = param(cur, "rayon_desserte_m")
        cur.execute("""SELECT count(*)::int AS n FROM dech.bati_quartier b, dech.tournees t
                       WHERE t.id = %s AND t.geom IS NOT NULL AND ST_DWithin(b.p, ST_Transform(t.geom, 32628), %s)""", (tid, r_m))
        f["batiments_desservis"] = cur.fetchone()["n"]
        f["rayon_m"] = r_m
    return f


class TourneeIn(BaseModel):
    nom: str | None = Field(None, min_length=2, max_length=120)
    jours: list[int] | None = None
    heure_depart: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$|^$")
    moyen: str | None = None
    vehicule: str | None = Field(None, max_length=80)
    equipe: str | None = Field(None, max_length=300)
    prestataire: str | None = Field(None, max_length=150)
    points: list[int] | None = None
    geometry: dict | None = None
    trace_manuel: bool | None = None
    active: bool | None = None
    observations: str | None = Field(None, max_length=2000)


def lire_tournee_body(cur, d: dict) -> tuple[list, list]:
    sets, vals = [], []
    if "jours" in d:
        if any(j not in range(1, 8) for j in d["jours"] or []):
            raise HTTPException(400, "Jours de passage invalides (1 = lundi … 7 = dimanche).")
        d["jours"] = sorted(set(d["jours"] or []))
    if "moyen" in d and d["moyen"] not in ACCES:
        raise HTTPException(400, "Moyen de collecte invalide.")
    if "heure_depart" in d:
        d["heure_depart"] = d["heure_depart"] or None
    if "points" in d:
        pts = d["points"] or []
        if len(pts) != len(set(pts)):
            raise HTTPException(400, "Un point figure deux fois dans la tournée.")
        if len(pts) > 150:
            raise HTTPException(400, "150 points au maximum par tournée.")
        cur.execute("SELECT count(*)::int AS n FROM dech.points WHERE id = ANY(%s)", (pts,))
        if cur.fetchone()["n"] != len(pts):
            raise HTTPException(400, "Un des points de la tournée n'existe plus.")
    for k in ("nom", "jours", "heure_depart", "moyen", "vehicule", "equipe", "prestataire", "points", "trace_manuel",
              "active", "observations"):
        if k in d:
            sets.append(f"{k} = %s")
            vals.append(d[k])
    if d.get("geometry"):
        g = d["geometry"]
        if g.get("type") != "LineString" or len(g.get("coordinates") or []) < 2:
            raise HTTPException(400, "Le trajet d'une tournée est une ligne.")
        gj = check_geometry(cur, g)
        sets.append("geom = ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)")
        vals.append(gj)
    elif "geometry" in d:
        sets.append("geom = NULL")
    return sets, vals


def recalculer_tournee(cur, tid: int):
    """Longueur du trajet et durée estimée (trajet à la vitesse moyenne du moyen de collecte + arrêts)."""
    arret = param(cur, "arret_min")
    cur.execute("SELECT moyen FROM dech.tournees WHERE id = %s", (tid,))
    v = VITESSE_KMH[cur.fetchone()["moyen"]]
    cur.execute("""UPDATE dech.tournees SET longueur_m = round(ST_Length(geom::geography)),
                          duree_min = round(COALESCE(ST_Length(geom::geography), 0) / %s + %s * cardinality(points))
                   WHERE id = %s""", (v * 1000 / 60, arret, tid))


@router.post("/tournees", status_code=201)
def creer_tournee(body: TourneeIn, u: dict = Depends(current_user)):
    exiger_gestion(u)
    if not body.nom:
        raise HTTPException(400, "Donnez un nom à la tournée.")
    d = body.model_dump(exclude_unset=True)
    with cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(hashtext('dech.tournee'))")
        cur.execute("SELECT COALESCE(max(substring(code FROM 3)::int), 0) + 1 AS n FROM dech.tournees WHERE code ~ '^T-[0-9]+$'")
        code = f"T-{cur.fetchone()['n']:02d}"
        cur.execute("INSERT INTO dech.tournees (code, nom, cree_par) VALUES (%s, %s, %s) RETURNING id", (code, body.nom, u["id"]))
        tid = cur.fetchone()["id"]
        sets, vals = lire_tournee_body(cur, d)
        if sets:
            cur.execute(f"UPDATE dech.tournees SET {', '.join(sets)} WHERE id = %s", vals + [tid])
        recalculer_tournee(cur, tid)
        journal(cur, u["id"], "création d'une tournée de collecte", f"tournée {code}", body.nom)
        return une_tournee(cur, tid)


@router.put("/tournees/{tid}")
def modifier_tournee(tid: int, body: TourneeIn, u: dict = Depends(current_user)):
    exiger_gestion(u)
    d = body.model_dump(exclude_unset=True)
    with cursor() as cur:
        cur.execute("SELECT code FROM dech.tournees WHERE id = %s FOR UPDATE", (tid,))
        t = cur.fetchone()
        if not t:
            raise HTTPException(404, "Tournée introuvable.")
        sets, vals = lire_tournee_body(cur, d)
        if not sets:
            raise HTTPException(400, "Rien à modifier.")
        sets.append("modifie_le = now()")
        cur.execute(f"UPDATE dech.tournees SET {', '.join(sets)} WHERE id = %s", vals + [tid])
        recalculer_tournee(cur, tid)
        journal(cur, u["id"], "modification d'une tournée de collecte", f"tournée {t['code']}", ", ".join(d.keys()))
        return une_tournee(cur, tid)


@router.delete("/tournees/{tid}")
def supprimer_tournee(tid: int, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("SELECT code, (SELECT count(*) FROM dech.passages p WHERE p.tournee = t.id)::int AS n FROM dech.tournees t WHERE id = %s",
                    (tid,))
        t = cur.fetchone()
        if not t:
            raise HTTPException(404, "Tournée introuvable.")
        if t["n"]:
            raise HTTPException(409, f"La tournée a déjà {t['n']} passage(s) enregistré(s) : désactivez-la plutôt (l'historique est gardé).")
        cur.execute("DELETE FROM dech.tournees WHERE id = %s", (tid,))
        journal(cur, u["id"], "suppression d'une tournée de collecte", f"tournée {t['code']}")
    return {"ok": True}


# ---------------------------------------------------------------- passages (terrain)
@router.get("/jour")
def programme_du_jour(date: dt.date | None = None, u: dict = Depends(current_user)):
    """Tournées prévues à une date (jours de passage) et passages déjà commencés ce jour-là."""
    d = date or dt.date.today()
    with cursor() as cur:
        cur.execute(f"""SELECT {TOURNEE_COLS} FROM dech.tournees t
                        WHERE t.active AND (%s = ANY (t.jours) OR EXISTS (SELECT 1 FROM dech.passages p WHERE p.tournee = t.id AND p.date = %s))
                        ORDER BY t.heure_depart NULLS LAST, t.code""", (d.isoweekday(), d))
        tournees = [feature_tournee(r) for r in cur.fetchall()]
        cur.execute("""SELECT pa.id, pa.uid, pa.tournee, pa.statut, pa.debut, pa.fin, u.nom AS agent, cardinality(pa.points) AS prevus,
                              (SELECT count(*) FROM dech.passages_points pp WHERE pp.passage = pa.id)::int AS faits
                       FROM dech.passages pa LEFT JOIN app.utilisateurs u ON u.id = pa.agent
                       WHERE pa.date = %s AND pa.statut <> 'Annulé'""", (d,))
        passages = [iso(r, "debut", "fin") for r in cur.fetchall()]
        for p in passages:
            p["uid"] = str(p["uid"])
    return {"date": d.isoformat(), "jour": JOURS[d.isoweekday() - 1], "tournees": tournees, "passages": passages}


class PassageIn(BaseModel):
    uid: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")
    tournee: int
    date: dt.date | None = None
    debut: dt.datetime | None = None


def un_passage(cur, uid: str) -> dict:
    cur.execute("""SELECT pa.id, pa.uid, pa.tournee, pa.date, pa.debut, pa.fin, pa.statut, pa.points, pa.commentaire,
                          u.nom AS agent, t.code, t.nom
                   FROM dech.passages pa JOIN dech.tournees t ON t.id = pa.tournee
                   LEFT JOIN app.utilisateurs u ON u.id = pa.agent WHERE pa.uid = %s""", (uid,))
    p = cur.fetchone()
    if not p:
        raise HTTPException(404, "Passage introuvable.")
    iso(p, "date", "debut", "fin")
    p["uid"] = str(p["uid"])
    cur.execute("""SELECT pp.point, pp.statut, pp.motif, pp.heure FROM dech.passages_points pp WHERE pp.passage = %s""", (p["id"],))
    p["releves"] = {r["point"]: iso(r, "heure") for r in cur.fetchall()}
    return p


@router.post("/passages")
def demarrer_passage(body: PassageIn, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT uid FROM dech.passages WHERE uid = %s", (body.uid,))
        if cur.fetchone():
            return un_passage(cur, body.uid)
        cur.execute("SELECT code, points, active FROM dech.tournees WHERE id = %s", (body.tournee,))
        t = cur.fetchone()
        if not t:
            raise HTTPException(404, "Tournée introuvable.")
        if not t["points"]:
            raise HTTPException(400, "La tournée n'a aucun point de collecte.")
        cur.execute("""INSERT INTO dech.passages (uid, tournee, date, debut, points, agent)
                       VALUES (%s, %s, COALESCE(%s, current_date), COALESCE(%s, now()), %s, %s)""",
                    (body.uid, body.tournee, body.date, body.debut, t["points"], u["id"]))
        journal(cur, u["id"], "début d'un passage de collecte", f"tournée {t['code']}")
        return un_passage(cur, body.uid)


@router.get("/passages/{uid}")
def lire_passage(uid: str, u: dict = Depends(current_user)):
    with cursor() as cur:
        return un_passage(cur, uid)


class ReleveIn(BaseModel):
    point: int
    statut: str = Field(pattern=r"^(Collecté|Non collecté|Saturé|)$")   # "" : annuler le relevé
    motif: str | None = Field(None, max_length=300)
    heure: dt.datetime | None = None


@router.post("/passages/{uid}/releve")
def releve(uid: str, body: ReleveIn, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT id, statut, points FROM dech.passages WHERE uid = %s FOR UPDATE", (uid,))
        pa = cur.fetchone()
        if not pa:
            raise HTTPException(404, "Passage introuvable.")
        if pa["statut"] == "Annulé":
            raise HTTPException(409, "Ce passage a été annulé.")
        if body.point not in pa["points"]:
            raise HTTPException(400, "Ce point ne fait pas partie du passage.")
        if not body.statut:
            cur.execute("DELETE FROM dech.passages_points WHERE passage = %s AND point = %s", (pa["id"], body.point))
            return un_passage(cur, uid)
        if body.statut == "Non collecté" and not (body.motif or "").strip():
            raise HTTPException(400, "Indiquez pourquoi le point n'a pas été collecté.")
        cur.execute("""INSERT INTO dech.passages_points (passage, point, statut, motif, heure, agent)
                       VALUES (%s, %s, %s, %s, COALESCE(%s, now()), %s)
                       ON CONFLICT (passage, point) DO UPDATE SET statut = EXCLUDED.statut, motif = EXCLUDED.motif,
                                                                 heure = EXCLUDED.heure, agent = EXCLUDED.agent""",
                    (pa["id"], body.point, body.statut, body.motif if body.statut != "Collecté" else None, body.heure, u["id"]))
        # l'état du point suit le relevé : vidé → actif, débordant → saturé
        cur.execute("SELECT etat FROM dech.points WHERE id = %s FOR UPDATE", (body.point,))
        etat = cur.fetchone()["etat"]
        nouveau = "Saturé" if body.statut == "Saturé" else "Actif" if body.statut == "Collecté" and etat == "Saturé" else etat
        cur.execute("UPDATE dech.points SET etat = %s, dernier_constat = now() WHERE id = %s", (nouveau, body.point))
        if nouveau != etat or body.statut != "Collecté":
            constater(cur, body.point, u, f"passage de collecte : {body.statut.lower()}", etat, nouveau, commentaire=body.motif)
        return un_passage(cur, uid)


class FinPassage(BaseModel):
    commentaire: str | None = Field(None, max_length=1000)
    fin: dt.datetime | None = None


@router.post("/passages/{uid}/terminer")
def terminer_passage(uid: str, body: FinPassage, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("""UPDATE dech.passages SET statut = 'Terminé', fin = COALESCE(%s, now()), commentaire = %s
                       WHERE uid = %s AND statut <> 'Annulé' RETURNING id""", (body.fin, body.commentaire, uid))
        if not cur.fetchone():
            raise HTTPException(404, "Passage introuvable ou annulé.")
        journal(cur, u["id"], "fin d'un passage de collecte", f"passage {uid}", body.commentaire)
        return un_passage(cur, uid)


@router.post("/passages/{uid}/annuler")
def annuler_passage(uid: str, body: FinPassage, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("UPDATE dech.passages SET statut = 'Annulé', commentaire = %s WHERE uid = %s RETURNING id",
                    (body.commentaire, uid))
        if not cur.fetchone():
            raise HTTPException(404, "Passage introuvable.")
        journal(cur, u["id"], "annulation d'un passage de collecte", f"passage {uid}", body.commentaire)
        return un_passage(cur, uid)


# ---------------------------------------------------------------- couverture et bilan
ZONE_DESSERTE = """
    WITH srv AS (
        SELECT ST_Transform(geom, 32628) AS g FROM dech.tournees WHERE active AND geom IS NOT NULL
        UNION ALL
        SELECT ST_Transform(geom, 32628) FROM dech.points
        WHERE type = ANY(%(desserte)s) AND etat NOT IN ('Fermé', 'Résorbé')
    ), zone AS (
        SELECT ST_Subdivide(ST_Union(ST_Buffer(g, %(r)s, 'quad_segs=4')), 64) AS g FROM srv
    )"""


@router.get("/couverture")
def couverture(u: dict = Depends(current_user)):
    with cursor() as cur:
        maj_bati_quartier(cur)
        r_m = param(cur, "rayon_desserte_m")
        cur.execute(ZONE_DESSERTE + """
            SELECT COALESCE(b.quartier, 'Hors quartier') AS quartier, count(*)::int AS batiments,
                   count(*) FILTER (WHERE EXISTS (SELECT 1 FROM zone z WHERE z.g && b.p AND ST_Intersects(z.g, b.p)))::int AS desservis
            FROM dech.bati_quartier b GROUP BY 1 ORDER BY 1""", {"desserte": list(DESSERTE), "r": r_m})
        q = cur.fetchall()
    tot = sum(x["batiments"] for x in q)
    ds = sum(x["desservis"] for x in q)
    return {"rayon_m": r_m, "batiments": tot, "desservis": ds, "quartiers": q}


@router.get("/couverture/non-desservis")
def non_desservis(quartier: str | None = None, u: dict = Depends(current_user)):
    with cursor() as cur:
        r_m = param(cur, "rayon_desserte_m")
        cur.execute(ZONE_DESSERTE + """
            SELECT round(ST_X(ST_Transform(b.p, 4326))::numeric, 6)::float AS lon, round(ST_Y(ST_Transform(b.p, 4326))::numeric, 6)::float AS lat
            FROM dech.bati_quartier b
            WHERE (%(q)s::text IS NULL OR b.quartier = %(q)s)
              AND NOT EXISTS (SELECT 1 FROM zone z WHERE z.g && b.p AND ST_Intersects(z.g, b.p))
            LIMIT 60000""", {"desserte": list(DESSERTE), "r": r_m, "q": quartier})
        return [[r["lon"], r["lat"]] for r in cur.fetchall()]


@router.get("/bilan")
def bilan(u: dict = Depends(current_user)):
    with cursor() as cur:
        ancien = param(cur, "constat_ancien_j")
        cur.execute("""SELECT type, etat, count(*)::int AS n, COALESCE(sum(volume_m3), 0)::float AS volume
                       FROM dech.points GROUP BY 1, 2 ORDER BY 1, 2""")
        par_type = cur.fetchall()
        cur.execute("""SELECT COALESCE(quartier, '—') AS quartier,
                              count(*) FILTER (WHERE etat NOT IN ('Fermé', 'Résorbé'))::int AS ouverts,
                              count(*) FILTER (WHERE etat = 'Résorbé')::int AS resorbes,
                              COALESCE(sum(volume_m3) FILTER (WHERE etat NOT IN ('Fermé', 'Résorbé')), 0)::float AS volume
                       FROM dech.points WHERE type = 'Dépôt sauvage' GROUP BY 1 ORDER BY 2 DESC, 1""")
        depots_quartier = cur.fetchall()
        cur.execute("""SELECT round(avg(EXTRACT(epoch FROM resorbe_le - cree_le) / 86400)::numeric, 1)::float AS j,
                              count(*)::int AS n
                       FROM dech.points WHERE type = 'Dépôt sauvage' AND resorbe_le IS NOT NULL""")
        resorption = cur.fetchone()
        cur.execute("""SELECT to_char(m, 'YYYY-MM') AS mois,
                              (SELECT count(*) FROM dech.points p WHERE p.type = 'Dépôt sauvage' AND date_trunc('month', p.cree_le) = m)::int AS signales,
                              (SELECT count(*) FROM dech.points p WHERE p.type = 'Dépôt sauvage' AND date_trunc('month', p.resorbe_le) = m)::int AS resorbes
                       FROM generate_series(date_trunc('month', current_date) - interval '11 months', date_trunc('month', current_date),
                                            interval '1 month') m ORDER BY m""")
        mois = cur.fetchall()
        cur.execute("""SELECT numero, type, etat, quartier, to_char(dernier_constat, 'YYYY-MM-DD') AS dernier_constat, id
                       FROM dech.points WHERE etat = 'Saturé' ORDER BY dernier_constat""")
        satures = cur.fetchall()
        cur.execute("""SELECT count(*)::int AS n FROM dech.points
                       WHERE etat NOT IN ('Fermé', 'Résorbé') AND dernier_constat < now() - make_interval(days => %s::int)""",
                    (ancien,))
        a_revoir = cur.fetchone()["n"]
        cur.execute("SELECT count(*)::int AS n FROM dech.points WHERE NOT verifie")
        a_verifier = cur.fetchone()["n"]
        # tournées : 30 derniers jours (jours prévus depuis la création de la tournée)
        cur.execute("""
            SELECT t.id, t.code, t.nom, t.jours,
              (SELECT count(*) FROM generate_series(GREATEST(current_date - 29, t.cree_le::date), current_date, interval '1 day') d
               WHERE EXTRACT(isodow FROM d)::int = ANY (t.jours))::int AS prevus,
              (SELECT count(DISTINCT p.date) FROM dech.passages p
               WHERE p.tournee = t.id AND p.statut <> 'Annulé' AND p.date >= current_date - 29)::int AS realises,
              (SELECT COALESCE(array_agg(to_char(d, 'YYYY-MM-DD') ORDER BY d DESC), '{}')
               FROM generate_series(GREATEST(current_date - 29, t.cree_le::date), current_date - 1, interval '1 day') d
               WHERE EXTRACT(isodow FROM d)::int = ANY (t.jours)
                 AND NOT EXISTS (SELECT 1 FROM dech.passages p WHERE p.tournee = t.id AND p.date = d::date AND p.statut <> 'Annulé')) AS manques,
              (SELECT COALESCE(sum(cardinality(p.points)), 0) FROM dech.passages p
               WHERE p.tournee = t.id AND p.statut = 'Terminé' AND p.date >= current_date - 29)::int AS points_prevus,
              (SELECT count(*) FROM dech.passages_points pp JOIN dech.passages p ON p.id = pp.passage
               WHERE p.tournee = t.id AND p.statut = 'Terminé' AND p.date >= current_date - 29 AND pp.statut = 'Collecté')::int AS points_collectes
            FROM dech.tournees t WHERE t.active ORDER BY t.code""")
        tournees = cur.fetchall()
        cur.execute("""SELECT pp.motif, count(*)::int AS n FROM dech.passages_points pp JOIN dech.passages p ON p.id = pp.passage
                       WHERE pp.statut = 'Non collecté' AND p.date >= current_date - 29 GROUP BY 1 ORDER BY 2 DESC""")
        motifs = cur.fetchall()
    return {"par_type": par_type, "depots_quartier": depots_quartier, "resorption": resorption, "mois": mois,
            "satures": satures, "a_revoir": a_revoir, "a_verifier": a_verifier, "constat_ancien_j": ancien,
            "tournees": tournees, "motifs": motifs}


class Parametre(BaseModel):
    valeur: float = Field(ge=0, le=100000)


@router.put("/parametres/{cle}")
def modifier_parametre(cle: str, body: Parametre, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("UPDATE dech.parametres SET valeur = %s WHERE cle = %s RETURNING cle", (body.valeur, cle))
        if not cur.fetchone():
            raise HTTPException(404, "Paramètre inconnu.")
        journal(cur, u["id"], "paramètre des déchets", cle, str(body.valeur))
    return {"ok": True}


# ---------------------------------------------------------------- exports
def csv_reponse(entetes: list[str], rows: list[dict], nom: str) -> Response:
    buf = io.StringIO()
    buf.write("﻿")
    w = csv.writer(buf, delimiter=";")
    w.writerow(entetes)
    for r in rows:
        w.writerow([("" if v is None else str(v).replace(".", ",") if isinstance(v, float) else
                     ", ".join(map(str, v)) if isinstance(v, list) else v) for v in r.values()])
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename={nom}"})


@router.get("/export/points.csv")
def export_points(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("""SELECT p.numero, p.type, p.nom, p.etat, p.volume_m3::float, p.capacite_m3::float, p.acces, p.quartier,
                              round(ST_X(p.geom)::numeric, 6)::float AS lon, round(ST_Y(p.geom)::numeric, 6)::float AS lat,
                              CASE WHEN p.verifie THEN 'oui' ELSE 'non' END AS verifie,
                              to_char(p.cree_le, 'YYYY-MM-DD') AS cree_le, to_char(p.dernier_constat, 'YYYY-MM-DD') AS constat,
                              to_char(p.resorbe_le, 'YYYY-MM-DD') AS resorbe_le,
                              (SELECT string_agg(t.code, ', ' ORDER BY t.code) FROM dech.tournees t WHERE p.id = ANY (t.points) AND t.active) AS tournees
                       FROM dech.points p ORDER BY p.numero""")
        rows = cur.fetchall()
    return csv_reponse(["Numéro", "Type", "Nom", "État", "Volume (m³)", "Capacité (m³)", "Accès", "Quartier", "Longitude",
                        "Latitude", "Vérifié", "Recensé le", "Dernier constat", "Résorbé / fermé le", "Tournées"],
                       rows, "points_collecte_dechets_labe.csv")


@router.get("/export/tournees.csv")
def export_tournees(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("""SELECT t.code, t.nom, t.jours, to_char(t.heure_depart, 'HH24:MI') AS heure, t.moyen, t.vehicule, t.equipe,
                              t.prestataire, cardinality(t.points) AS nb_points,
                              (SELECT string_agg(p.numero, ' > ' ORDER BY o.n) FROM unnest(t.points) WITH ORDINALITY o(id, n)
                               JOIN dech.points p ON p.id = o.id) AS ordre,
                              t.longueur_m::float, t.duree_min::float, CASE WHEN t.active THEN 'oui' ELSE 'non' END AS active
                       FROM dech.tournees t ORDER BY t.code""")
        rows = cur.fetchall()
    for r in rows:
        r["jours"] = texte_jours(r["jours"])
    return csv_reponse(["Code", "Nom", "Jours", "Départ", "Moyen", "Véhicule", "Équipe", "Prestataire", "Points",
                        "Ordre de passage", "Longueur (m)", "Durée estimée (min)", "Active"], rows, "tournees_collecte_labe.csv")


# ---------------------------------------------------------------- carte publique (sans compte)
def donnees_publiques(cur) -> dict:
    cur.execute("""SELECT json_build_object('type', 'FeatureCollection', 'features', COALESCE(json_agg(json_build_object(
                       'type', 'Feature', 'geometry', ST_AsGeoJSON(geom, 6)::json,
                       'properties', json_build_object('numero', numero, 'type', type, 'nom', nom, 'etat', etat, 'acces', acces,
                                                       'quartier', quartier, 'constat', to_char(dernier_constat, 'YYYY-MM-DD')))
                       ORDER BY id), '[]'::json)) AS fc
                   FROM dech.points WHERE verifie AND etat NOT IN ('Fermé', 'Résorbé')""")
    points = cur.fetchone()["fc"]
    cur.execute(f"SELECT {TOURNEE_COLS} FROM dech.tournees t WHERE t.active AND t.geom IS NOT NULL ORDER BY t.code")
    tournees = []
    for r in cur.fetchall():
        f = feature_tournee(r)
        p = f["properties"]
        f["properties"] = {"code": p["code"], "nom": p["nom"], "jours": p["jours_texte"], "heure_depart": p["heure_depart"],
                           "moyen": p["moyen"], "quartiers": ", ".join(p["quartiers"]), "points": len(p["points"])}
        tournees.append(f)
    return {"points": points, "tournees": {"type": "FeatureCollection", "features": tournees}}


@router.get("/public")
def publiques():
    with cursor() as cur:
        return donnees_publiques(cur)
