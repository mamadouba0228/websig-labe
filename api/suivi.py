"""
Suivi des saisies : historique, circuit de traitement des signalements, corrections de la carte de référence.

Circuit d'un signalement :
  À valider ─(superviseur : valider)→ Validé ─(affecter à un service)→ Affecté
  ─(agent du service : prendre en charge)→ En cours ─(traiter, avec compte rendu et photo)→ Traité
  Un superviseur peut rejeter (avec motif) ou rouvrir un signalement traité. Tout le monde peut commenter.

Corrections de la carte (catégorie « Correction de la carte ») : la forme proposée par l'agent est appliquée
au bâti ou à la voirie de référence quand un superviseur la valide ; l'ancienne forme est gardée dans l'historique.
"""
import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from main import SERVICES, current_user, cursor, decode_photo, fetch_one, historiser, journal, superviseur

router = APIRouter()

PRIORITES = ("Basse", "Normale", "Haute", "Urgente")
VALIDATEURS = ("superviseur", "admin")


# ---------------------------------------------------------------- historique
@router.get("/contributions/{cid}/historique")
def historique(cid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("""SELECT h.id, h.date, h.action, h.statut_avant, h.statut_apres, h.commentaire,
                              (h.photo IS NOT NULL) AS a_photo, (h.geom_avant IS NOT NULL) AS a_forme,
                              u.nom AS utilisateur, u.service
                       FROM contrib.historique h LEFT JOIN app.utilisateurs u ON u.id = h.utilisateur
                       WHERE h.contribution = %s ORDER BY h.date, h.id""", (cid,))
        rows = cur.fetchall()
    for r in rows:
        r["date"] = r["date"].isoformat(timespec="seconds")
        r["photo_url"] = f"/api/contributions/{cid}/historique/{r['id']}/photo" if r.pop("a_photo") else None
    return rows


@router.get("/contributions/{cid}/historique/{hid}/photo")
def photo_historique(cid: int, hid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT photo FROM contrib.historique WHERE id = %s AND contribution = %s", (hid, cid))
        r = cur.fetchone()
    if not r or not r["photo"]:
        raise HTTPException(404, "Pas de photo.")
    return Response(bytes(r["photo"]), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@router.post("/contributions/{cid}/historique/{hid}/restaurer")
def restaurer_forme(cid: int, hid: int, u: dict = Depends(superviseur)):
    """Remet la forme d'avant une modification (la forme actuelle est elle-même gardée dans l'historique)."""
    with cursor() as cur:
        cur.execute("SELECT geom_avant FROM contrib.historique WHERE id = %s AND contribution = %s", (hid, cid))
        r = cur.fetchone()
        if not r or r["geom_avant"] is None:
            raise HTTPException(404, "Pas de forme à restaurer pour cette étape.")
        cur.execute("SELECT statut FROM contrib.contributions WHERE id = %s", (cid,))
        statut = cur.fetchone()["statut"]
        historiser(cur, cid, u["id"], "restauration d'une forme précédente", statut, statut,
                   f"forme de l'étape n° {hid}", geom_avant=True)
        cur.execute("""UPDATE contrib.contributions SET geom = (SELECT geom_avant FROM contrib.historique WHERE id = %s),
                              modifie_le = now(), modifie_par = %s WHERE id = %s""", (hid, u["nom"], cid))
        journal(cur, u["id"], "restauration de forme", f"contribution {cid}", f"étape {hid}")
        return fetch_one(cur, cid)


# ---------------------------------------------------------------- circuit de traitement
class Action(BaseModel):
    action: str = Field(pattern=r"^(valider|rejeter|affecter|prendre|traiter|rouvrir|commenter)$")
    service: str | None = None
    priorite: str | None = None
    echeance: dt.date | None = None
    commentaire: str | None = Field(None, max_length=1000)
    photo: str | None = None


@router.post("/contributions/{cid}/action")
def action(cid: int, body: Action, u: dict = Depends(current_user)):
    validateur = u["role"] in VALIDATEURS
    with cursor() as cur:
        cur.execute("SELECT statut, service_affecte, ref_couche FROM contrib.contributions WHERE id = %s FOR UPDATE", (cid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Saisie introuvable.")
        avant, a = row["statut"], body.action
        du_service = validateur or (row["service_affecte"] is not None and u["service"] == row["service_affecte"])
        photo = decode_photo(body.photo)
        sets, vals, apres = [], [], avant

        if a == "commenter":
            if not (body.commentaire or "").strip() and not photo:
                raise HTTPException(400, "Écrivez un commentaire ou joignez une photo.")
        elif a in ("valider", "rejeter", "affecter", "rouvrir") and not validateur:
            raise HTTPException(403, "Réservé aux superviseurs.")
        elif a in ("prendre", "traiter") and not du_service:
            raise HTTPException(403, "Seul le service chargé du signalement (ou un superviseur) peut le traiter.")

        if a == "valider":
            if avant not in ("À valider", "Rejeté"):
                raise HTTPException(409, f"Saisie déjà « {avant} ».")
            apres = "Validé"
            sets += ["valide_par = %s", "valide_le = now()", "motif_rejet = NULL"]
            vals += [u["id"]]
        elif a == "rejeter":
            if not (body.commentaire or "").strip():
                raise HTTPException(400, "Indiquez le motif du rejet.")
            apres = "Rejeté"
            sets += ["valide_par = %s", "valide_le = now()", "motif_rejet = %s"]
            vals += [u["id"], body.commentaire.strip()]
        elif a == "affecter":
            if body.service not in SERVICES:
                raise HTTPException(400, "Choisissez le service chargé du traitement.")
            if body.priorite and body.priorite not in PRIORITES:
                raise HTTPException(400, "Priorité invalide.")
            if avant in ("Traité", "Rejeté"):
                raise HTTPException(409, f"Saisie « {avant} » : rouvrez-la d'abord.")
            apres = "Affecté"
            sets += ["service_affecte = %s", "priorite = %s", "echeance = %s", "affecte_le = now()",
                     "valide_par = COALESCE(valide_par, %s)", "valide_le = COALESCE(valide_le, now())"]
            vals += [body.service, body.priorite or "Normale", body.echeance, u["id"]]
        elif a == "prendre":
            if avant != "Affecté":
                raise HTTPException(409, "Seul un signalement affecté peut être pris en charge.")
            apres = "En cours"
        elif a == "traiter":
            if avant not in ("Validé", "Affecté", "En cours"):
                raise HTTPException(409, f"Saisie « {avant} » : impossible de la marquer traitée.")
            apres = "Traité"
            sets.append("traite_le = now()")
        elif a == "rouvrir":
            if avant != "Traité":
                raise HTTPException(409, "Seul un signalement traité peut être rouvert.")
            apres = "En cours" if row["service_affecte"] else "Validé"
            sets.append("traite_le = NULL")

        if apres != avant:
            sets.append("statut = %s")
            vals.append(apres)
        if sets:
            sets += ["modifie_le = now()", "modifie_par = %s"]
            vals.append(u["nom"])
            cur.execute(f"UPDATE contrib.contributions SET {', '.join(sets)} WHERE id = %s", vals + [cid])
        libelle = {"valider": "validation", "rejeter": "rejet", "affecter": "affectation", "prendre": "prise en charge",
                   "traiter": "traitement", "rouvrir": "réouverture", "commenter": "commentaire"}[a]
        detail = body.commentaire
        if a == "affecter":
            detail = f"{body.service} · priorité {body.priorite or 'Normale'}" + \
                     (f" · échéance {body.echeance.strftime('%d/%m/%Y')}" if body.echeance else "") + \
                     (f" — {body.commentaire}" if body.commentaire else "")
        historiser(cur, cid, u["id"], libelle, avant, apres, detail, photo)
        journal(cur, u["id"], libelle, f"contribution {cid}", detail)
        if apres == "Validé" and row["ref_couche"]:
            appliquer_correction(cur, cid, u)
        return fetch_one(cur, cid)


# ---------------------------------------------------------------- corrections de la carte de référence
def appliquer_correction(cur, cid: int, u: dict):
    """Applique une correction validée au bâti ou à la voirie de référence, puis la marque « Traité »."""
    cur.execute("""SELECT type, nom, ref_couche, ref_gid, ST_AsEWKB(geom) AS g, GeometryType(geom) AS gt
                   FROM contrib.contributions WHERE id = %s""", (cid,))
    c = cur.fetchone()
    couche, gid, t = c["ref_couche"], c["ref_gid"], (c["type"] or "").lower()
    attendu = "POLYGON" if couche == "batiments" else "LINESTRING"
    table = f"ref.{couche}"
    if any(m in t for m in ("démoli", "disparu", "supprimer")):
        cur.execute(f"DELETE FROM {table} WHERE gid = %s RETURNING gid", (gid,))
        if not cur.fetchone():
            raise HTTPException(409, f"L'objet n° {gid} n'existe plus dans la carte de référence.")
        if couche == "batiments":
            cur.execute("DELETE FROM adr.batiments_points WHERE gid = %s", (gid,))
            cur.execute("UPDATE adr.adresses SET batiment_gid = NULL WHERE batiment_gid = %s", (gid,))
        texte = f"{'bâtiment' if couche == 'batiments' else 'tronçon'} n° {gid} retiré de la carte de référence"
    else:
        if c["gt"] != attendu:
            raise HTTPException(400, "La forme proposée ne correspond pas à la couche (surface pour un bâtiment, ligne pour une voie).")
        if "ajout" in t:
            if couche == "batiments":
                cur.execute("INSERT INTO ref.batiments (geom, nature) VALUES (%s::geometry, 'Bâtiment') RETURNING gid", (c["g"],))
            else:
                cur.execute("INSERT INTO ref.routes (geom, nature, nom) VALUES (%s::geometry, 'Route résidentielle', %s) RETURNING gid",
                            (c["g"], c["nom"]))
            gid = cur.fetchone()["gid"]
            cur.execute("UPDATE contrib.contributions SET ref_gid = %s WHERE id = %s", (gid, cid))
            texte = f"{'bâtiment' if couche == 'batiments' else 'tronçon'} n° {gid} ajouté à la carte de référence"
        else:
            # l'ancienne forme est gardée dans l'historique de la correction
            cur.execute(f"""INSERT INTO contrib.historique (contribution, utilisateur, action, commentaire, geom_avant)
                            SELECT %s, %s, 'forme de référence remplacée', %s, geom FROM {table} WHERE gid = %s""",
                        (cid, u["id"], f"{couche} n° {gid}", gid))
            cur.execute(f"UPDATE {table} SET geom = %s::geometry WHERE gid = %s RETURNING gid", (c["g"], gid))
            if not cur.fetchone():
                raise HTTPException(409, f"L'objet n° {gid} n'existe plus dans la carte de référence.")
            texte = f"{'bâtiment' if couche == 'batiments' else 'tronçon'} n° {gid} redessiné"
        if couche == "batiments":
            cur.execute("""INSERT INTO adr.batiments_points (gid, p)
                           SELECT gid, ST_Transform(ST_PointOnSurface(geom), 32628) FROM ref.batiments WHERE gid = %s
                           ON CONFLICT (gid) DO UPDATE SET p = EXCLUDED.p""", (gid,))
    cur.execute("""UPDATE contrib.contributions SET statut = 'Traité', traite_le = now(), modifie_le = now(), modifie_par = %s
                   WHERE id = %s""", (u["nom"], cid))
    historiser(cur, cid, u["id"], "application à la carte de référence", "Validé", "Traité", texte)
    journal(cur, u["id"], "correction de la carte", f"contribution {cid}", texte)
