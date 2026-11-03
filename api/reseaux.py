"""
Réseaux : éclairage public, bornes-fontaines, suivi des pannes et des fuites.

- Lampadaires (solaires ou raccordés) et bornes-fontaines : recensés sur la carte ou au GPS, avec leur état.
- Interventions : une panne d'éclairage ou une fuite d'eau, signalée par un agent ou venue d'un signalement
  de l'onglet Saisie : Signalée → Transmise (EDG, SEG, entreprise) → En réparation → Réparée, ou Classée sans suite.
  L'état du lampadaire ou de la borne suit la panne (En panne, puis En service à la réparation).
- Couverture : rues éclairées (longueur de rue à portée d'un lampadaire en service) et bâtiments à plus d'une
  distance donnée d'une borne-fontaine en service, par quartier.
"""
import datetime as dt
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from dechets import csv_reponse, iso, maj_bati_quartier, quartier_de
from environnement import lire_geom, numero_suivant, photo_reponse
from main import current_user, cursor, decode_photo, historiser, journal

router = APIRouter(prefix="/reseaux")

SERVICES_RES = ("Services techniques", "Voirie et assainissement")
ALIMENTATIONS = ["Solaire", "Réseau électrique"]
LAMPES = ["LED", "Sodium", "Fluorescente", "Autre"]
ETATS_LAMPADAIRE = ["En service", "En panne", "Hors service", "Volé / détruit"]
TYPES_BORNE = ["Borne-fontaine", "Kiosque à eau", "Forage équipé (pompe)"]
ETATS_BORNE = ["En service", "Débit faible", "En panne", "Fermée"]
EAU_DISPONIBLE = ("En service", "Débit faible")
NATURES = {
    "Éclairage": ["Lampe éteinte", "Allumée en journée", "Panneau solaire ou batterie", "Câble ou raccordement",
                  "Poteau endommagé ou tombé", "Vol ou vandalisme", "Autre"],
    "Eau": ["Fuite sur conduite", "Fuite sur branchement", "Fuite à la borne", "Borne en panne ou sans eau",
            "Eau trouble ou de mauvaise qualité", "Coupure d'eau", "Autre"],
}
# natures qui mettent l'équipement « En panne » tant qu'elles ne sont pas réparées
EN_PANNE = {"Lampe éteinte", "Panneau solaire ou batterie", "Câble ou raccordement", "Poteau endommagé ou tombé",
            "Vol ou vandalisme", "Borne en panne ou sans eau"}
STATUTS = ["Signalée", "Transmise", "En réparation", "Réparée", "Classée sans suite"]
OUVERTS = ("Signalée", "Transmise", "En réparation")
URGENCES = ["Normale", "Urgente"]
PREFIXE = {"Éclairage": "PA", "Eau": "FU"}
# signalements de l'onglet Saisie que le service peut convertir en interventions
SIGNALEMENTS = {"Éclairage en panne": ("Éclairage", "Lampe éteinte"), "Fuite d'eau": ("Eau", "Fuite sur conduite")}
SEUIL_DOUBLON = {"res.lampadaires": 3, "res.bornes": 10}


def apply_schema(cur):
    cur.execute((Path(__file__).parent / "reseaux.sql").read_text(encoding="utf-8"))


# ---------------------------------------------------------------- droits et outils
def peut_gerer(u: dict) -> bool:
    return u["role"] in ("superviseur", "admin") or u["service"] in SERVICES_RES


def exiger_gestion(u: dict):
    if not peut_gerer(u):
        raise HTTPException(403, "Réservé aux Services techniques, à la Voirie et aux superviseurs.")


def param(cur, cle: str) -> float:
    cur.execute("SELECT res.param(%s)::float AS v", (cle,))
    return cur.fetchone()["v"]


def voie_proche(cur, gj: str) -> str | None:
    cur.execute("""SELECT COALESCE(v.nom, v.code) AS v FROM adr.voies v,
                          (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 32628) AS p) t
                   WHERE ST_DWithin(v.geom_m, t.p, 40) ORDER BY v.geom_m <-> t.p LIMIT 1""", (gj,))
    r = cur.fetchone()
    return r["v"] if r else None


def doublon(cur, table: str, gj: str, sauf: int | None = None) -> dict | None:
    cur.execute(f"""SELECT numero, round(ST_Distance(ST_Transform(geom, 32628), t.p))::int AS d FROM {table},
                           (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 32628) AS p) t
                    WHERE ST_DWithin(ST_Transform(geom, 32628), t.p, %s) AND id IS DISTINCT FROM %s
                    ORDER BY 2 LIMIT 1""", (gj, SEUIL_DOUBLON[table], sauf))
    return cur.fetchone()


def ouvertes(cur, col: str, eid: int) -> list[dict]:
    cur.execute(f"SELECT numero, nature FROM res.interventions WHERE {col} = %s AND statut = ANY(%s) ORDER BY id",
                (eid, list(OUVERTS)))
    return cur.fetchall()


def suivre_etat(cur, col: str, eid: int):
    """L'équipement est « En panne » tant qu'une panne ouverte le concerne, « En service » ensuite."""
    table = "res.lampadaires" if col == "lampadaire" else "res.bornes"
    panne = any(r["nature"] in EN_PANNE for r in ouvertes(cur, col, eid))
    cur.execute(f"""UPDATE {table} SET etat = CASE WHEN %s AND etat = 'En service' THEN 'En panne'
                                                  WHEN NOT %s AND etat = 'En panne' THEN 'En service' ELSE etat END,
                                       dernier_constat = now() WHERE id = %s""", (panne, panne, eid))


@router.get("/listes")
def listes(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT cle, valeur::float, description FROM res.parametres ORDER BY cle")
        parametres = cur.fetchall()
    return {"alimentations": ALIMENTATIONS, "lampes": LAMPES, "etats_lampadaire": ETATS_LAMPADAIRE, "types_borne": TYPES_BORNE,
            "etats_borne": ETATS_BORNE, "natures": NATURES, "statuts": STATUTS, "urgences": URGENCES,
            "peut_gerer": peut_gerer(u), "parametres": parametres}


# ---------------------------------------------------------------- pannes et fuites
INTER_COLS = """i.id, i.numero, i.reseau, i.nature, i.statut, i.urgence, i.description, i.lampadaire, i.borne, i.transmise_a,
    i.cout_gnf::float, i.quartier, i.contribution, i.cree_le, i.cree_par, i.repare_le, i.modifie_le,
    (i.photo IS NOT NULL) AS a_photo, c.nom AS cree_par_nom, COALESCE(l.numero, b.numero) AS equipement,
    (i.statut = ANY(%(ouverts)s) AND i.cree_le < now() - make_interval(days => res.param(
        CASE WHEN i.reseau = 'Éclairage' THEN 'delai_panne_j' ELSE 'delai_fuite_j' END)::int)) AS en_retard,
    ST_AsGeoJSON(i.geom, 7)::json AS geometry"""
INTER_FROM = """ FROM res.interventions i LEFT JOIN app.utilisateurs c ON c.id = i.cree_par
    LEFT JOIN res.lampadaires l ON l.id = i.lampadaire LEFT JOIN res.bornes b ON b.id = i.borne """


def feature_intervention(r: dict) -> dict:
    g = r.pop("geometry")
    iso(r, "cree_le", "repare_le", "modifie_le")
    r["photo_url"] = f"/api/reseaux/interventions/{r['id']}/photo" if r.pop("a_photo") else None
    return {"type": "Feature", "id": r["id"], "geometry": g, "properties": r}


def une_intervention(cur, iid: int) -> dict:
    cur.execute(f"SELECT {INTER_COLS} {INTER_FROM} WHERE i.id = %(id)s", {"ouverts": list(OUVERTS), "id": iid})
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Intervention introuvable.")
    return feature_intervention(r)


def histo(cur, iid: int, u: dict | None, action: str, avant, apres, commentaire=None, photo=None):
    cur.execute("""INSERT INTO res.interventions_historique (intervention, utilisateur, action, statut_avant, statut_apres, commentaire, photo)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""", (iid, u["id"] if u else None, action, avant, apres, commentaire, photo))


def creer_intervention(cur, u: dict, reseau: str, nature: str, urgence: str, description: str | None, gj: str, photo: bytes | None,
                       lampadaire: int | None = None, borne: int | None = None, uid: str | None = None,
                       contribution: int | None = None) -> int:
    numero = numero_suivant(cur, "res.interventions", f"{PREFIXE[reseau]}-{dt.date.today().year}")
    cur.execute("""INSERT INTO res.interventions (numero, uid, reseau, nature, urgence, description, lampadaire, borne, quartier, photo, geom,
                                                  contribution, cree_par)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s, %s) RETURNING id""",
                (numero, uid, reseau, nature, urgence, description, lampadaire, borne, quartier_de(cur, gj), photo, gj, contribution, u["id"]))
    iid = cur.fetchone()["id"]
    histo(cur, iid, u, "signalement", None, "Signalée", description, photo)
    journal(cur, u["id"], "panne d'éclairage signalée" if reseau == "Éclairage" else "fuite ou panne d'eau signalée",
            f"intervention {numero}", nature)
    if lampadaire:
        suivre_etat(cur, "lampadaire", lampadaire)
    if borne:
        suivre_etat(cur, "borne", borne)
    return iid


def equipement_proche(cur, table: str, gj: str, rayon: float = 30) -> int | None:
    cur.execute(f"""SELECT id FROM {table}, (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 32628) AS p) t
                    WHERE ST_DWithin(ST_Transform(geom, 32628), t.p, %s) ORDER BY ST_Transform(geom, 32628) <-> t.p LIMIT 1""", (gj, rayon))
    r = cur.fetchone()
    return r["id"] if r else None


@router.get("/interventions")
def lister_interventions(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute(f"SELECT {INTER_COLS} {INTER_FROM} ORDER BY i.id DESC", {"ouverts": list(OUVERTS)})
        return {"type": "FeatureCollection", "features": [feature_intervention(r) for r in cur.fetchall()]}


@router.get("/interventions/{iid}")
def lire_intervention(iid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        f = une_intervention(cur, iid)
        cur.execute("""SELECT h.id, h.date, h.action, h.statut_avant, h.statut_apres, h.commentaire, (h.photo IS NOT NULL) AS a_photo,
                              x.nom AS utilisateur FROM res.interventions_historique h LEFT JOIN app.utilisateurs x ON x.id = h.utilisateur
                       WHERE h.intervention = %s ORDER BY h.date DESC, h.id DESC""", (iid,))
        hist = cur.fetchall()
        for h in hist:
            iso(h, "date")
            h["photo_url"] = f"/api/reseaux/interventions/{iid}/historique/{h['id']}/photo" if h.pop("a_photo") else None
        f["historique"] = hist
        f["peut_gerer"] = peut_gerer(u)
    return f


@router.get("/interventions/{iid}/photo")
def photo_intervention(iid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        return photo_reponse(cur, "SELECT photo FROM res.interventions WHERE id = %s", iid)


@router.get("/interventions/{iid}/historique/{hid}/photo")
def photo_histo_intervention(iid: int, hid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        return photo_reponse(cur, "SELECT photo FROM res.interventions_historique WHERE intervention = %s AND id = %s", iid, hid)


class InterventionIn(BaseModel):
    geometry: dict | None = None                # sinon : position du lampadaire ou de la borne
    reseau: str
    nature: str
    urgence: str = "Normale"
    description: str | None = Field(None, max_length=2000)
    lampadaire: int | None = None
    borne: int | None = None
    photo: str | None = None
    uid: str | None = Field(None, pattern=r"^[0-9a-fA-F-]{36}$")


@router.post("/interventions", status_code=201)
def signaler(body: InterventionIn, u: dict = Depends(current_user)):
    if body.reseau not in NATURES or body.nature not in NATURES[body.reseau] or body.urgence not in URGENCES:
        raise HTTPException(400, "Réseau, nature ou urgence invalide.")
    if (body.lampadaire and body.reseau != "Éclairage") or (body.borne and body.reseau != "Eau"):
        raise HTTPException(400, "L'équipement ne correspond pas au réseau.")
    with cursor() as cur:
        if body.uid:
            cur.execute("SELECT id FROM res.interventions WHERE uid = %s", (body.uid,))
            deja = cur.fetchone()
            if deja:
                return une_intervention(cur, deja["id"])
        eq = ("res.lampadaires", body.lampadaire) if body.lampadaire else ("res.bornes", body.borne) if body.borne else None
        if eq:
            cur.execute(f"SELECT numero, ST_AsGeoJSON(geom, 7) AS g FROM {eq[0]} WHERE id = %s", (eq[1],))
            x = cur.fetchone()
            if not x:
                raise HTTPException(404, "Équipement introuvable.")
            col = "lampadaire" if body.lampadaire else "borne"
            deja = [r for r in ouvertes(cur, col, eq[1]) if r["nature"] == body.nature]
            if deja:
                raise HTTPException(409, f"Déjà signalé : {deja[0]['numero']} ({body.nature.lower()}) est en cours.")
            gj = x["g"] if not body.geometry else lire_geom(cur, body.geometry, ("Point",))
        else:
            gj = lire_geom(cur, body.geometry, ("Point",))
        iid = creer_intervention(cur, u, body.reseau, body.nature, body.urgence, body.description, gj, decode_photo(body.photo),
                                 lampadaire=body.lampadaire, borne=body.borne, uid=body.uid)
        return une_intervention(cur, iid)


class ActionIntervention(BaseModel):
    action: str = Field(pattern=r"^(transmettre|commencer|reparer|classer|rouvrir|commenter)$")
    commentaire: str | None = Field(None, max_length=2000)
    photo: str | None = None
    transmise_a: str | None = Field(None, max_length=150)
    cout_gnf: float | None = Field(None, ge=0, le=1e13)
    urgence: str | None = None


TRANSITIONS = {   # action : (statuts de départ, statut d'arrivée)
    "transmettre": (("Signalée", "En réparation"), "Transmise"),
    "commencer": (("Signalée", "Transmise"), "En réparation"),
    "reparer": (OUVERTS, "Réparée"),
    "classer": (OUVERTS, "Classée sans suite"),
    "rouvrir": (("Réparée", "Classée sans suite"), "Signalée"),
}
LIBELLES = {"transmettre": "transmission", "commencer": "début des travaux", "reparer": "réparation", "classer": "classement sans suite",
            "rouvrir": "réouverture", "commenter": "commentaire"}


@router.post("/interventions/{iid}/action")
def action_intervention(iid: int, body: ActionIntervention, u: dict = Depends(current_user)):
    a = body.action
    with cursor() as cur:
        cur.execute("SELECT statut, numero, contribution, lampadaire, borne FROM res.interventions WHERE id = %s FOR UPDATE", (iid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Intervention introuvable.")
        avant, apres = r["statut"], r["statut"]
        photo = decode_photo(body.photo)
        sets, vals = [], []
        if a == "commenter":
            if not (body.commentaire or "").strip() and not photo:
                raise HTTPException(400, "Écrivez un commentaire ou joignez une photo.")
        else:
            exiger_gestion(u)
            depart, apres = TRANSITIONS[a]
            if avant not in depart:
                raise HTTPException(409, f"Impossible depuis le statut « {avant} ».")
            if a == "transmettre" and not (body.transmise_a or "").strip():
                raise HTTPException(400, "Indiquez à qui la panne est transmise (EDG, SEG, entreprise…).")
            if a == "classer" and not (body.commentaire or "").strip():
                raise HTTPException(400, "Indiquez le motif.")
            sets.append("statut = %s")
            vals.append(apres)
            if apres == "Réparée":
                sets.append("repare_le = now()")
            if a == "rouvrir":
                sets.append("repare_le = NULL")
        if body.transmise_a is not None and a == "transmettre":
            sets.append("transmise_a = %s")
            vals.append(body.transmise_a.strip())
        if body.cout_gnf is not None:
            sets.append("cout_gnf = %s")
            vals.append(body.cout_gnf)
        if body.urgence:
            exiger_gestion(u)
            if body.urgence not in URGENCES:
                raise HTTPException(400, "Urgence invalide.")
            sets.append("urgence = %s")
            vals.append(body.urgence)
        if sets:
            sets.append("modifie_le = now()")
            cur.execute(f"UPDATE res.interventions SET {', '.join(sets)} WHERE id = %s", vals + [iid])
        detail = body.commentaire
        if a == "transmettre":
            detail = f"à {body.transmise_a.strip()}" + (f" — {body.commentaire}" if body.commentaire else "")
        if a == "reparer" and body.cout_gnf:
            detail = f"coût {body.cout_gnf:,.0f} GNF".replace(",", " ") + (f" — {body.commentaire}" if body.commentaire else "")
        histo(cur, iid, u, LIBELLES[a], avant, apres, detail, photo)
        journal(cur, u["id"], LIBELLES[a], f"intervention {r['numero']}", detail)
        if r["lampadaire"]:
            suivre_etat(cur, "lampadaire", r["lampadaire"])
        if r["borne"]:
            suivre_etat(cur, "borne", r["borne"])
        if r["contribution"] and apres != avant and apres in ("Réparée", "Classée sans suite"):
            cur.execute("""UPDATE contrib.contributions SET statut = 'Traité', traite_le = now(), modifie_le = now(), modifie_par = %s
                           WHERE id = %s AND statut <> 'Traité' RETURNING id""", (u["nom"], r["contribution"]))
            if cur.fetchone():
                historiser(cur, r["contribution"], u["id"], "traitement", "En cours", "Traité", f"intervention {r['numero']} : {apres.lower()}")
        return une_intervention(cur, iid)


@router.delete("/interventions/{iid}")
def supprimer_intervention(iid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT numero, cree_par, statut, contribution, lampadaire, borne FROM res.interventions WHERE id = %s", (iid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Intervention introuvable.")
        if not (peut_gerer(u) or (r["cree_par"] == u["id"] and r["statut"] == "Signalée")):
            raise HTTPException(403, "Suppression réservée au service (ou à l'auteur, tant que la panne n'est pas prise en charge).")
        if r["contribution"]:
            raise HTTPException(400, "Vient d'un signalement : classez-la sans suite plutôt.")
        cur.execute("DELETE FROM res.interventions WHERE id = %s", (iid,))
        if r["lampadaire"]:
            suivre_etat(cur, "lampadaire", r["lampadaire"])
        if r["borne"]:
            suivre_etat(cur, "borne", r["borne"])
        journal(cur, u["id"], "intervention supprimée", f"intervention {r['numero']}")
    return {"ok": True}


@router.get("/signalements")
def signalements(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("""SELECT c.id, c.type, c.nom, c.description, c.quartier, c.cree_le, COALESCE(a.nom, c.auteur) AS auteur,
                              ST_AsGeoJSON(ST_PointOnSurface(c.geom), 7)::json AS geometry
                       FROM contrib.contributions c LEFT JOIN app.utilisateurs a ON a.id = c.cree_par
                       WHERE c.categorie = 'Signalement' AND c.type = ANY(%s) AND c.statut IN ('Validé', 'Affecté', 'En cours')
                         AND NOT EXISTS (SELECT 1 FROM res.interventions x WHERE x.contribution = c.id)
                       ORDER BY c.cree_le""", (list(SIGNALEMENTS),))
        return [iso(r, "cree_le") for r in cur.fetchall()]


@router.post("/signalements/{cid}/convertir")
def convertir(cid: int, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("""SELECT id, type, nom, description, statut, photo, ST_AsGeoJSON(ST_PointOnSurface(geom), 7) AS g
                       FROM contrib.contributions WHERE id = %s AND categorie = 'Signalement' AND type = ANY(%s) FOR UPDATE""",
                    (cid, list(SIGNALEMENTS)))
        c = cur.fetchone()
        if not c:
            raise HTTPException(404, "Signalement introuvable.")
        cur.execute("SELECT 1 FROM res.interventions WHERE contribution = %s", (cid,))
        if cur.fetchone():
            raise HTTPException(409, "Signalement déjà pris en charge.")
        reseau, nature = SIGNALEMENTS[c["type"]]
        lamp = equipement_proche(cur, "res.lampadaires", c["g"]) if reseau == "Éclairage" else None
        borne = equipement_proche(cur, "res.bornes", c["g"], 15) if reseau == "Eau" else None
        if borne:
            nature = "Fuite à la borne"
        desc = " — ".join(x for x in (c["nom"], c["description"]) if x) or c["type"]
        iid = creer_intervention(cur, u, reseau, nature, "Normale", desc, c["g"], c["photo"], lampadaire=lamp, borne=borne, contribution=cid)
        numero = cur.execute("SELECT numero FROM res.interventions WHERE id = %s", (iid,)).fetchone()["numero"]
        if c["statut"] != "En cours":
            cur.execute("""UPDATE contrib.contributions SET statut = 'En cours', service_affecte = COALESCE(service_affecte, %s),
                                  affecte_le = COALESCE(affecte_le, now()), modifie_le = now(), modifie_par = %s WHERE id = %s""",
                        (SERVICES_RES[0], u["nom"], cid))
        historiser(cur, cid, u["id"], "prise en charge", c["statut"], "En cours", f"intervention {numero} (réseaux)")
        journal(cur, u["id"], "signalement converti en intervention", f"contribution {cid}", numero)
        return une_intervention(cur, iid)


# ---------------------------------------------------------------- couverture
ZONE_ECLAIREE = """
    WITH zone AS (
        SELECT ST_Subdivide(ST_Union(ST_Buffer(ST_Transform(geom, 32628), %(r)s, 'quad_segs=4')), 64) AS g
        FROM res.lampadaires WHERE etat = 'En service'
    ), v AS (
        SELECT v.id, v.code, v.nom, v.quartier, v.geom, v.geom_m, COALESCE(v.longueur_m, ST_Length(v.geom_m))::float AS longueur_m,
               COALESCE((SELECT sum(ST_Length(ST_Intersection(v.geom_m, z.g))) FROM zone z WHERE z.g && v.geom_m), 0)::float AS eclaire_m
        FROM adr.voies v
    )"""


@router.get("/eclairage/voies")
def voies_eclairees(u: dict = Depends(current_user)):
    """Rues avec la part de leur longueur à portée d'un lampadaire en service."""
    with cursor() as cur:
        cur.execute(ZONE_ECLAIREE + """
            SELECT json_build_object('type', 'FeatureCollection', 'features', COALESCE(json_agg(json_build_object(
                'type', 'Feature', 'geometry', ST_AsGeoJSON(ST_Simplify(geom, 0.00001), 6)::json,
                'properties', json_build_object('code', code, 'nom', nom, 'quartier', quartier, 'longueur_m', round(longueur_m),
                                                'eclaire_m', round(eclaire_m), 'pct', round((100 * eclaire_m / NULLIF(longueur_m, 0))::numeric)))), '[]'::json)) AS fc
            FROM v""", {"r": param(cur, "portee_lampadaire_m")})
        return cur.fetchone()["fc"]


ZONE_EAU = """
    WITH zone AS (
        SELECT ST_Subdivide(ST_Union(ST_Buffer(ST_Transform(geom, 32628), %(r)s, 'quad_segs=8')), 64) AS g
        FROM res.bornes WHERE etat = ANY(%(dispo)s)
    )"""


@router.get("/eau/non-desservis")
def non_desservis(quartier: str | None = None, u: dict = Depends(current_user)):
    """Bâtiments à plus de la distance maximale d'une borne-fontaine en service."""
    with cursor() as cur:
        cur.execute(ZONE_EAU + """
            SELECT round(ST_X(ST_Transform(b.p, 4326))::numeric, 6)::float AS lon, round(ST_Y(ST_Transform(b.p, 4326))::numeric, 6)::float AS lat
            FROM dech.bati_quartier b
            WHERE (%(q)s::text IS NULL OR b.quartier = %(q)s)
              AND NOT EXISTS (SELECT 1 FROM zone z WHERE z.g && b.p AND ST_Intersects(z.g, b.p))
            LIMIT 60000""", {"r": param(cur, "distance_borne_m"), "dispo": list(EAU_DISPONIBLE), "q": quartier})
        return [[r["lon"], r["lat"]] for r in cur.fetchall()]


def couverture_quartiers(cur) -> tuple[list[dict], list[dict]]:
    maj_bati_quartier(cur)
    cur.execute(ZONE_ECLAIREE + """
        SELECT COALESCE(quartier, '—') AS quartier, round(sum(longueur_m)::numeric / 1000, 1)::float AS km,
               round(sum(eclaire_m)::numeric / 1000, 2)::float AS km_eclaires FROM v GROUP BY 1""", {"r": param(cur, "portee_lampadaire_m")})
    ecl = {r["quartier"]: r for r in cur.fetchall()}
    cur.execute("""SELECT COALESCE(quartier, '—') AS quartier, count(*)::int AS n, count(*) FILTER (WHERE etat = 'En service')::int AS en_service,
                          count(*) FILTER (WHERE etat = 'En panne')::int AS en_panne FROM res.lampadaires GROUP BY 1""")
    for r in cur.fetchall():
        ecl.setdefault(r["quartier"], {"quartier": r["quartier"], "km": 0, "km_eclaires": 0}).update(r)
    eclairage = []
    for r in ecl.values():
        r.setdefault("n", 0), r.setdefault("en_service", 0), r.setdefault("en_panne", 0)
        r["pct"] = round(100 * r["km_eclaires"] / r["km"], 1) if r["km"] else 0
        eclairage.append(r)
    eclairage.sort(key=lambda r: (r["pct"], -r["km"]))
    cur.execute(ZONE_EAU + """
        SELECT COALESCE(b.quartier, 'Hors quartier') AS quartier, count(*)::int AS batiments,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM zone z WHERE z.g && b.p AND ST_Intersects(z.g, b.p)))::int AS desservis,
               (SELECT count(*) FROM res.bornes x WHERE x.quartier IS NOT DISTINCT FROM b.quartier AND x.etat = ANY(%(dispo)s))::int AS bornes
        FROM dech.bati_quartier b GROUP BY b.quartier""", {"r": param(cur, "distance_borne_m"), "dispo": list(EAU_DISPONIBLE)})
    eau = cur.fetchall()
    for r in eau:
        r["pct"] = round(100 * r["desservis"] / r["batiments"], 1) if r["batiments"] else 0
    eau.sort(key=lambda r: (r["pct"], -r["batiments"]))
    return eclairage, eau


@router.get("/bilan")
def bilan(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT alimentation, etat, count(*)::int AS n FROM res.lampadaires GROUP BY 1, 2 ORDER BY 1, 2")
        lampadaires = cur.fetchall()
        cur.execute("SELECT type, etat, count(*)::int AS n FROM res.bornes GROUP BY 1, 2 ORDER BY 1, 2")
        bornes = cur.fetchall()
        cur.execute("""SELECT reseau, nature, count(*) FILTER (WHERE statut = ANY(%s))::int AS ouvertes, count(*)::int AS total
                       FROM res.interventions GROUP BY 1, 2 ORDER BY 1, 4 DESC""", (list(OUVERTS),))
        natures = cur.fetchall()
        cur.execute("""SELECT reseau, count(*) FILTER (WHERE statut = ANY(%(o)s))::int AS ouvertes,
                              count(*) FILTER (WHERE statut = ANY(%(o)s) AND cree_le < now() - make_interval(days => res.param(
                                  CASE WHEN reseau = 'Éclairage' THEN 'delai_panne_j' ELSE 'delai_fuite_j' END)::int))::int AS en_retard,
                              round(avg(EXTRACT(epoch FROM repare_le - cree_le) / 86400) FILTER (WHERE statut = 'Réparée')::numeric, 1)::float AS delai_j,
                              count(*) FILTER (WHERE statut = 'Réparée')::int AS reparees,
                              COALESCE(sum(cout_gnf) FILTER (WHERE statut = 'Réparée'), 0)::float AS cout
                       FROM res.interventions GROUP BY 1""", {"o": list(OUVERTS)})
        reseaux = {r["reseau"]: r for r in cur.fetchall()}
        cur.execute("""SELECT COALESCE(quartier, '—') AS quartier, count(*)::int AS n FROM res.interventions
                       WHERE statut = ANY(%s) GROUP BY 1 ORDER BY 2 DESC""", (list(OUVERTS),))
        quartiers = cur.fetchall()
        cur.execute("""SELECT to_char(m, 'YYYY-MM') AS mois, (SELECT count(*) FROM res.interventions i WHERE date_trunc('month', i.cree_le) = m)::int AS n
                       FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m
                       ORDER BY m""")
        mois = cur.fetchall()
        eclairage, eau = couverture_quartiers(cur)
    return {"lampadaires": lampadaires, "bornes": bornes, "natures": natures, "reseaux": reseaux, "quartiers": quartiers, "mois": mois,
            "eclairage": eclairage, "eau": eau}


class Parametre(BaseModel):
    valeur: float = Field(ge=0, le=100000)


@router.put("/parametres/{cle}")
def modifier_parametre(cle: str, body: Parametre, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("UPDATE res.parametres SET valeur = %s WHERE cle = %s RETURNING cle", (body.valeur, cle))
        if not cur.fetchone():
            raise HTTPException(404, "Paramètre inconnu.")
        journal(cur, u["id"], "paramètre des réseaux", cle, str(body.valeur))
    return {"ok": True}


# ---------------------------------------------------------------- exports
@router.get("/export/{quoi}.csv")
def exporter(quoi: str, u: dict = Depends(current_user)):
    with cursor() as cur:
        if quoi == "lampadaires":
            cur.execute("""SELECT numero, alimentation, lampe, puissance_w, hauteur_m::float, etat, gestionnaire, to_char(date_pose, 'YYYY-MM-DD') AS pose_le,
                                  voie, quartier, round(ST_X(geom)::numeric, 6)::float AS lon, round(ST_Y(geom)::numeric, 6)::float AS lat,
                                  to_char(dernier_constat, 'YYYY-MM-DD') AS constat_le, observations FROM res.lampadaires ORDER BY numero""")
            return csv_reponse(["Numéro", "Alimentation", "Lampe", "Puissance (W)", "Hauteur (m)", "État", "Gestionnaire", "Posé le", "Rue",
                                "Quartier", "Longitude", "Latitude", "Dernier constat", "Observations"], cur.fetchall(), "lampadaires_labe.csv")
        if quoi == "bornes":
            cur.execute("""SELECT numero, type, nom, etat, gestionnaire, robinets, CASE WHEN payante THEN 'oui' ELSE 'non' END AS payante_txt, prix_gnf::float,
                                  horaires, quartier, round(ST_X(geom)::numeric, 6)::float AS lon, round(ST_Y(geom)::numeric, 6)::float AS lat,
                                  to_char(dernier_constat, 'YYYY-MM-DD') AS constat_le, observations FROM res.bornes ORDER BY numero""")
            return csv_reponse(["Numéro", "Type", "Nom", "État", "Gestionnaire", "Robinets", "Payante", "Prix du bidon (GNF)", "Horaires",
                                "Quartier", "Longitude", "Latitude", "Dernier constat", "Observations"], cur.fetchall(), "bornes_fontaines_labe.csv")
        if quoi == "interventions":
            cur.execute("""SELECT i.numero, i.reseau, i.nature, i.statut, i.urgence, COALESCE(l.numero, b.numero) AS equipement, i.description, i.transmise_a,
                                  i.cout_gnf::float, i.quartier, round(ST_X(i.geom)::numeric, 6)::float AS lon, round(ST_Y(i.geom)::numeric, 6)::float AS lat,
                                  to_char(i.cree_le, 'YYYY-MM-DD') AS signalee_le, to_char(i.repare_le, 'YYYY-MM-DD') AS reparee_le,
                                  CASE WHEN i.repare_le IS NOT NULL THEN round((EXTRACT(epoch FROM i.repare_le - i.cree_le) / 86400)::numeric, 1)::float END AS delai_j
                           FROM res.interventions i LEFT JOIN res.lampadaires l ON l.id = i.lampadaire LEFT JOIN res.bornes b ON b.id = i.borne
                           ORDER BY i.numero""")
            return csv_reponse(["Numéro", "Réseau", "Nature", "Statut", "Urgence", "Équipement", "Description", "Transmise à", "Coût (GNF)",
                                "Quartier", "Longitude", "Latitude", "Signalée le", "Réparée le", "Délai (jours)"], cur.fetchall(),
                               "pannes_fuites_labe.csv")
        if quoi == "quartiers":
            eclairage, eau = couverture_quartiers(cur)
            e = {r["quartier"]: r for r in eau}
            rows = [{"q": r["quartier"], "km": r["km"], "ke": r["km_eclaires"], "p": r["pct"], "n": r["n"], "s": r["en_service"], "pa": r["en_panne"],
                     "b": e.get(r["quartier"], {}).get("batiments"), "d": e.get(r["quartier"], {}).get("desservis"),
                     "pe": e.get(r["quartier"], {}).get("pct"), "bf": e.get(r["quartier"], {}).get("bornes")}
                    for r in sorted(eclairage, key=lambda r: r["quartier"])]
            return csv_reponse(["Quartier", "Rues (km)", "Rues éclairées (km)", "Rues éclairées (%)", "Lampadaires", "En service", "En panne",
                                "Bâtiments", "Bâtiments desservis en eau", "Desservis (%)", "Bornes en service"], rows, "reseaux_quartiers_labe.csv")
    raise HTTPException(404, "Export inconnu.")


# ---------------------------------------------------------------- carte publique (sans compte)
def fc(cur, sql: str) -> dict:
    cur.execute(f"""SELECT json_build_object('type', 'FeatureCollection', 'features', COALESCE(json_agg(json_build_object(
                        'type', 'Feature', 'geometry', ST_AsGeoJSON(t.geom, 6)::json, 'properties', to_jsonb(t) - 'geom')), '[]'::json)) AS fc
                    FROM ({sql}) t""")
    return cur.fetchone()["fc"]


def donnees_publiques(cur) -> dict:
    return {
        "lampadaires": fc(cur, """SELECT numero, alimentation, etat, voie, quartier, geom FROM res.lampadaires
                                  WHERE etat <> 'Volé / détruit' ORDER BY id"""),
        "bornes": fc(cur, """SELECT numero, type, nom, etat, gestionnaire, CASE WHEN payante THEN 'oui' ELSE 'non' END AS payante,
                                    prix_gnf::float AS prix_gnf, horaires, quartier, geom FROM res.bornes ORDER BY id"""),
    }


@router.get("/public")
def publiques():
    with cursor() as cur:
        return donnees_publiques(cur)


# ---------------------------------------------------------------- lampadaires et bornes
# En dernier : les routes /{quoi} ne doivent pas capter /interventions, /bilan, /public…
EQUIP = {
    "lampadaires": {"table": "res.lampadaires", "col": "lampadaire", "prefixe": "LP", "nom": "lampadaire",
                    "cols": "x.alimentation, x.lampe, x.puissance_w, x.hauteur_m::float, x.gestionnaire, x.date_pose, x.voie",
                    "champs": ("alimentation", "lampe", "puissance_w", "hauteur_m", "gestionnaire", "date_pose"),
                    "etats": ETATS_LAMPADAIRE},
    "bornes": {"table": "res.bornes", "col": "borne", "prefixe": "BF", "nom": "borne-fontaine",
               "cols": "x.type, x.nom, x.gestionnaire, x.robinets, x.payante, x.prix_gnf::float, x.horaires",
               "champs": ("type", "nom", "gestionnaire", "robinets", "payante", "prix_gnf", "horaires"),
               "etats": ETATS_BORNE},
}


def equip(quoi: str) -> dict:
    if quoi not in EQUIP:
        raise HTTPException(404, "Couche inconnue.")
    return EQUIP[quoi]


def un_equipement(cur, quoi: str, eid: int) -> dict:
    e = EQUIP[quoi]
    cur.execute(f"""SELECT x.id, x.numero, {e['cols']}, x.etat, x.quartier, x.observations, x.dernier_constat, x.cree_le, x.cree_par,
                           (x.photo IS NOT NULL) AS a_photo, c.nom AS cree_par_nom,
                           (SELECT count(*) FROM res.interventions i WHERE i.{e['col']} = x.id AND i.statut = ANY(%s))::int AS ouvertes,
                           ST_AsGeoJSON(x.geom, 7)::json AS geometry
                    FROM {e['table']} x LEFT JOIN app.utilisateurs c ON c.id = x.cree_par WHERE x.id = %s""", (list(OUVERTS), eid))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, f"{e['nom'].capitalize()} introuvable.")
    return feature_equipement(quoi, r)


def feature_equipement(quoi: str, r: dict) -> dict:
    g = r.pop("geometry")
    iso(r, "date_pose", "dernier_constat", "cree_le")
    r["photo_url"] = f"/api/reseaux/{quoi}/{r['id']}/photo" if r.pop("a_photo") else None
    return {"type": "Feature", "id": r["id"], "geometry": g, "properties": r}


@router.get("/{quoi}")
def lister_equipements(quoi: str, u: dict = Depends(current_user)):
    e = equip(quoi)
    with cursor() as cur:
        cur.execute(f"""SELECT x.id, x.numero, {e['cols']}, x.etat, x.quartier, x.observations, x.dernier_constat, x.cree_le, x.cree_par,
                               (x.photo IS NOT NULL) AS a_photo, NULL AS cree_par_nom,
                               (SELECT count(*) FROM res.interventions i WHERE i.{e['col']} = x.id AND i.statut = ANY(%s))::int AS ouvertes,
                               ST_AsGeoJSON(x.geom, 7)::json AS geometry
                        FROM {e['table']} x ORDER BY x.id DESC""", (list(OUVERTS),))
        return {"type": "FeatureCollection", "features": [feature_equipement(quoi, r) for r in cur.fetchall()]}


@router.get("/{quoi}/{eid}")
def lire_equipement(quoi: str, eid: int, u: dict = Depends(current_user)):
    e = equip(quoi)
    with cursor() as cur:
        f = un_equipement(cur, quoi, eid)
        cur.execute(f"""SELECT id, numero, nature, statut, urgence, cree_le, repare_le FROM res.interventions
                        WHERE {e['col']} = %s ORDER BY id DESC""", (eid,))
        f["interventions"] = [iso(r, "cree_le", "repare_le") for r in cur.fetchall()]
        f["peut_modifier"] = peut_gerer(u) or f["properties"]["cree_par"] == u["id"]
    return f


@router.get("/{quoi}/{eid}/photo")
def photo_equipement(quoi: str, eid: int, u: dict = Depends(current_user)):
    e = equip(quoi)
    with cursor() as cur:
        return photo_reponse(cur, f"SELECT photo FROM {e['table']} WHERE id = %s", eid)


class EquipementIn(BaseModel):
    geometry: dict | None = None
    etat: str | None = None
    # lampadaires
    alimentation: str | None = None
    lampe: str | None = None
    puissance_w: int | None = Field(None, gt=0, le=5000)
    hauteur_m: float | None = Field(None, gt=0, le=40)
    date_pose: dt.date | None = None
    # bornes
    type: str | None = None
    nom: str | None = Field(None, max_length=150)
    robinets: int | None = Field(None, ge=0, le=50)
    payante: bool | None = None
    prix_gnf: float | None = Field(None, ge=0, le=1e7)
    horaires: str | None = Field(None, max_length=150)
    # communs
    gestionnaire: str | None = Field(None, max_length=150)
    observations: str | None = Field(None, max_length=2000)
    photo: str | None = None
    uid: str | None = Field(None, pattern=r"^[0-9a-fA-F-]{36}$")
    forcer: bool = False                        # enregistrer malgré un équipement tout près


def verifier(quoi: str, d: dict):
    e = EQUIP[quoi]
    if "etat" in d and d["etat"] not in e["etats"]:
        raise HTTPException(400, "État invalide.")
    if quoi == "lampadaires":
        if "alimentation" in d and d["alimentation"] not in ALIMENTATIONS:
            raise HTTPException(400, "Alimentation invalide.")
        if d.get("lampe") and d["lampe"] not in LAMPES:
            raise HTTPException(400, "Type de lampe invalide.")
    elif "type" in d and d["type"] not in TYPES_BORNE:
        raise HTTPException(400, "Type de point d'eau invalide.")


def panne_au_recensement(cur, quoi: str, eid: int, u: dict):
    """Équipement trouvé en panne : une intervention est ouverte s'il n'y en a pas déjà une."""
    e = EQUIP[quoi]
    cur.execute(f"SELECT etat, numero, quartier, ST_AsGeoJSON(geom, 7) AS g FROM {e['table']} WHERE id = %s", (eid,))
    x = cur.fetchone()
    if x["etat"] != "En panne" or ouvertes(cur, e["col"], eid):
        return
    reseau = "Éclairage" if quoi == "lampadaires" else "Eau"
    nature = "Lampe éteinte" if quoi == "lampadaires" else "Borne en panne ou sans eau"
    creer_intervention(cur, u, reseau, nature, "Normale", f"constaté en panne ({x['numero']})", x["g"], None,
                       **{e["col"]: eid})


@router.post("/{quoi}", status_code=201)
def creer_equipement(quoi: str, body: EquipementIn, u: dict = Depends(current_user)):
    e = equip(quoi)
    d = body.model_dump(exclude_unset=True)
    verifier(quoi, d)
    with cursor() as cur:
        if body.uid:
            cur.execute(f"SELECT id FROM {e['table']} WHERE uid = %s", (body.uid,))
            deja = cur.fetchone()
            if deja:
                return un_equipement(cur, quoi, deja["id"])
        gj = lire_geom(cur, body.geometry, ("Point",))
        v = doublon(cur, e["table"], gj)
        if v and not body.forcer:
            raise HTTPException(409, {"message": f"Un {e['nom']} existe déjà à {v['d']} m : {v['numero']}.", "proche": v})
        numero = numero_suivant(cur, e["table"], e["prefixe"])
        cols = [k for k in e["champs"] if d.get(k) is not None]
        vals = [d[k] for k in cols]
        extra = {"voie": voie_proche(cur, gj)} if quoi == "lampadaires" else {}
        cols += list(extra)
        vals += list(extra.values())
        cur.execute(f"""INSERT INTO {e['table']} (numero, uid, etat, quartier, observations, photo, geom, cree_par
                                                  {''.join(', ' + c for c in cols)})
                        VALUES (%s, %s, %s, %s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s{', %s' * len(cols)}) RETURNING id""",
                    [numero, body.uid, body.etat or "En service", quartier_de(cur, gj), body.observations, decode_photo(body.photo),
                     gj, u["id"]] + vals)
        eid = cur.fetchone()["id"]
        journal(cur, u["id"], f"{e['nom']} recensé", f"{e['nom']} {numero}", body.etat or "En service")
        panne_au_recensement(cur, quoi, eid, u)
        return un_equipement(cur, quoi, eid)


@router.put("/{quoi}/{eid}")
def modifier_equipement(quoi: str, eid: int, body: EquipementIn, u: dict = Depends(current_user)):
    e = equip(quoi)
    d = body.model_dump(exclude_unset=True)
    d.pop("uid", None)
    forcer = d.pop("forcer", False)
    verifier(quoi, d)
    with cursor() as cur:
        cur.execute(f"SELECT numero, cree_par, etat FROM {e['table']} WHERE id = %s FOR UPDATE", (eid,))
        x = cur.fetchone()
        if not x:
            raise HTTPException(404, f"{e['nom'].capitalize()} introuvable.")
        if not (peut_gerer(u) or x["cree_par"] == u["id"]):
            raise HTTPException(403, "Vous ne pouvez modifier que vos propres saisies.")
        if d.get("etat") == "En service" and x["etat"] != "En service":
            ouv = [r for r in ouvertes(cur, e["col"], eid) if r["nature"] in EN_PANNE]
            if ouv:
                raise HTTPException(409, f"Panne en cours ({ouv[0]['numero']}) : indiquez « Réparée » dans sa fiche.")
        sets, vals = [], []
        for k in e["champs"] + ("etat", "observations"):
            if k in d and not (k in ("etat", "alimentation", "type", "payante") and d[k] is None):
                sets.append(f"{k} = %s")
                vals.append(d[k])
        if "etat" in d:
            sets.append("dernier_constat = now()")
        if "photo" in d:
            sets.append("photo = %s")
            vals.append(decode_photo(d["photo"]))
        if body.geometry:
            gj = lire_geom(cur, body.geometry, ("Point",))
            v = doublon(cur, e["table"], gj, eid)
            if v and not forcer:
                raise HTTPException(409, {"message": f"Un autre {e['nom']} existe à {v['d']} m : {v['numero']}.", "proche": v})
            sets += ["geom = ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)", "quartier = %s"]
            vals += [gj, quartier_de(cur, gj)]
            if quoi == "lampadaires":
                sets.append("voie = %s")
                vals.append(voie_proche(cur, gj))
        if not sets:
            raise HTTPException(400, "Rien à modifier.")
        sets.append("modifie_le = now()")
        cur.execute(f"UPDATE {e['table']} SET {', '.join(sets)} WHERE id = %s", vals + [eid])
        journal(cur, u["id"], f"{e['nom']} modifié", f"{e['nom']} {x['numero']}", ", ".join(d.keys()))
        panne_au_recensement(cur, quoi, eid, u)
        return un_equipement(cur, quoi, eid)


@router.delete("/{quoi}/{eid}")
def supprimer_equipement(quoi: str, eid: int, u: dict = Depends(current_user)):
    e = equip(quoi)
    with cursor() as cur:
        cur.execute(f"""SELECT numero, cree_par, (SELECT count(*) FROM res.interventions i WHERE i.{e['col']} = x.id)::int AS n
                        FROM {e['table']} x WHERE id = %s""", (eid,))
        x = cur.fetchone()
        if not x:
            raise HTTPException(404, f"{e['nom'].capitalize()} introuvable.")
        if not (peut_gerer(u) or (x["cree_par"] == u["id"] and not x["n"])):
            raise HTTPException(403, "Suppression réservée au service (ou à l'auteur, avant toute intervention).")
        cur.execute(f"DELETE FROM {e['table']} WHERE id = %s", (eid,))
        journal(cur, u["id"], f"{e['nom']} supprimé", f"{e['nom']} {x['numero']}")
    return {"ok": True}
