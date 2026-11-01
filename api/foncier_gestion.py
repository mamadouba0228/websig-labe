"""
Foncier (suite) : titulaires des droits, pièces jointes, litiges fonciers, fiches parcellaires.

Les données personnelles (titulaires, pièces, parties d'un litige, demandeur d'un dossier) sont réservées au service
Urbanisme et domaines et aux superviseurs ; un agent voit aussi ce qu'il a lui-même saisi.
La fiche parcellaire porte un numéro et un code de vérification ; la vérification publique ne montre aucun nom.
"""
import base64
import datetime as dt
import json
import secrets
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from foncier import est_superviseur, historiser_parcelle, iso, lire_parcelle, peut_instruire, SERVICE_FONCIER
from main import current_user, cursor, journal

router = APIRouter(prefix="/foncier")

TYPES_PERSONNE = ["Personne physique", "Personne morale", "Famille (indivision)", "Commune", "État"]
QUALITES = ["Propriétaire", "Copropriétaire", "Héritier", "Usufruitier", "Occupant", "Locataire"]
TYPES_PIECE = ["Titre foncier", "Permis d'habiter", "Attestation de cession", "Acte de vente", "Acte de succession",
               "Plan de bornage", "Plan de lotissement", "Procès-verbal", "Pièce d'identité", "Quittance", "Décision",
               "Photo", "Autre"]
TYPES_LITIGE = ["Limites", "Double attribution", "Occupation sans droit", "Succession", "Empiètement sur le domaine public",
                "Vente contestée", "Autre"]
LITIGE_OUVERT = ("Signalé", "En médiation", "Transmis au tribunal")
MAX_PIECE = 5_000_000
SIGNATURES = {"application/pdf": b"%PDF", "image/jpeg": b"\xff\xd8", "image/png": b"\x89PNG"}


def acces(u: dict) -> bool:
    """Accès aux données personnelles du foncier."""
    return peut_instruire(u)


def exiger_acces(u: dict):
    if not acces(u):
        raise HTTPException(403, f"Données personnelles : réservées au service {SERVICE_FONCIER} et aux superviseurs.")


@router.get("/listes-gestion")
def listes_gestion(u: dict = Depends(current_user)):
    return {"types_personne": TYPES_PERSONNE, "qualites": QUALITES, "types_piece": TYPES_PIECE, "types_litige": TYPES_LITIGE,
            "acces": acces(u), "acces_fiscal": acces(u) or u["service"] == "Finances et recettes"}


# ---------------------------------------------------------------- titulaires
class TitulaireIn(BaseModel):
    nom: str | None = Field(None, min_length=2, max_length=150)
    type_personne: str | None = None
    qualite: str | None = None
    part: str | None = Field(None, max_length=30)
    telephone: str | None = Field(None, max_length=30)
    piece_identite: str | None = Field(None, max_length=60)
    adresse: str | None = Field(None, max_length=200)
    debut: dt.date | None = None
    fin: dt.date | None = None
    actif: bool | None = None
    observations: str | None = Field(None, max_length=1000)


def verifier_titulaire(d: dict):
    if d.get("type_personne") and d["type_personne"] not in TYPES_PERSONNE:
        raise HTTPException(400, "Type de personne inconnu.")
    if d.get("qualite") and d["qualite"] not in QUALITES:
        raise HTTPException(400, "Qualité inconnue.")


def titulaires_de(cur, pid: int) -> list[dict]:
    cur.execute("""SELECT t.id, t.nom, t.type_personne, t.qualite, t.part, t.telephone, t.piece_identite, t.adresse, t.debut,
                          t.fin, t.actif, t.observations, t.cree_le, d.numero AS dossier_numero
                   FROM fon.titulaires t LEFT JOIN fon.dossiers d ON d.id = t.dossier
                   WHERE t.parcelle = %s ORDER BY t.actif DESC, t.debut DESC NULLS LAST, t.id""", (pid,))
    return [iso(r, "debut", "fin", "cree_le") for r in cur.fetchall()]


@router.get("/parcelles/{pid}/titulaires")
def lister_titulaires(pid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        if not acces(u):
            cur.execute("SELECT count(*) FILTER (WHERE actif)::int AS n FROM fon.titulaires WHERE parcelle = %s", (pid,))
            return {"acces": False, "nb_actifs": cur.fetchone()["n"], "titulaires": []}
        return {"acces": True, "titulaires": titulaires_de(cur, pid)}


@router.post("/parcelles/{pid}/titulaires", status_code=201)
def ajouter_titulaire(pid: int, body: TitulaireIn, u: dict = Depends(current_user)):
    exiger_acces(u)
    d = body.model_dump()
    verifier_titulaire(d)
    if not d["nom"]:
        raise HTTPException(400, "Le nom est obligatoire.")
    with cursor() as cur:
        p = lire_parcelle(cur, pid)
        if p["etat"] == "Archivée":
            raise HTTPException(409, "Parcelle archivée.")
        cur.execute("""INSERT INTO fon.titulaires (parcelle, nom, type_personne, qualite, part, telephone, piece_identite, adresse,
                              debut, fin, actif, observations, cree_par)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                    (pid, d["nom"].strip(), d["type_personne"] or "Personne physique", d["qualite"] or "Propriétaire", d["part"],
                     d["telephone"], d["piece_identite"], d["adresse"], d["debut"], d["fin"],
                     True if d["actif"] is None else d["actif"], d["observations"], u["id"]))
        tid = cur.fetchone()["id"]
        historiser_parcelle(cur, pid, u["id"], "titulaire ajouté", f"{d['nom'].strip()} ({d['qualite'] or 'Propriétaire'})")
        journal(cur, u["id"], "ajout de titulaire", f"parcelle {pid}", p["numero"])
        return {"id": tid, "titulaires": titulaires_de(cur, pid)}


@router.put("/titulaires/{tid}")
def modifier_titulaire(tid: int, body: TitulaireIn, u: dict = Depends(current_user)):
    exiger_acces(u)
    d = body.model_dump(exclude_unset=True)
    verifier_titulaire(d)
    if not d:
        raise HTTPException(400, "Rien à modifier.")
    with cursor() as cur:
        cur.execute("SELECT parcelle, nom FROM fon.titulaires WHERE id = %s", (tid,))
        t = cur.fetchone()
        if not t:
            raise HTTPException(404, "Titulaire introuvable.")
        if d.get("actif") is False and "fin" not in d:
            d["fin"] = dt.date.today()
        cur.execute(f"UPDATE fon.titulaires SET {', '.join(f'{k} = %s' for k in d)}, modifie_le = now() WHERE id = %s",
                    list(d.values()) + [tid])
        historiser_parcelle(cur, t["parcelle"], u["id"], "titulaire modifié",
                            f"{t['nom']} : " + ", ".join(f"{k} = {v}" for k, v in d.items() if k not in ("telephone", "piece_identite")))
        journal(cur, u["id"], "modification de titulaire", f"titulaire {tid}", t["nom"])
        return {"titulaires": titulaires_de(cur, t["parcelle"])}


@router.delete("/titulaires/{tid}")
def supprimer_titulaire(tid: int, u: dict = Depends(current_user)):
    if not est_superviseur(u):
        raise HTTPException(403, "Suppression réservée aux superviseurs (pour une fin de droit, indiquez plutôt une date de fin).")
    with cursor() as cur:
        cur.execute("DELETE FROM fon.titulaires WHERE id = %s RETURNING parcelle, nom", (tid,))
        t = cur.fetchone()
        if not t:
            raise HTTPException(404, "Titulaire introuvable.")
        historiser_parcelle(cur, t["parcelle"], u["id"], "titulaire supprimé (erreur de saisie)", t["nom"])
        journal(cur, u["id"], "suppression de titulaire", f"titulaire {tid}", t["nom"])
    return {"ok": True}


@router.get("/titulaires")
def rechercher_titulaires(q: str, u: dict = Depends(current_user)):
    """Parcelles d'une personne (recherche par nom, téléphone ou pièce d'identité)."""
    exiger_acces(u)
    if len(q.strip()) < 2:
        raise HTTPException(400, "Au moins 2 caractères.")
    motif = "%" + q.strip().lower() + "%"
    with cursor() as cur:
        cur.execute("""SELECT t.id, t.nom, t.qualite, t.actif, t.part, p.id AS parcelle, p.numero, p.quartier, p.etat
                       FROM fon.titulaires t JOIN fon.parcelles p ON p.id = t.parcelle
                       WHERE lower(t.nom) LIKE %s OR t.telephone LIKE %s OR lower(t.piece_identite) LIKE %s
                       ORDER BY t.actif DESC, t.nom, p.numero LIMIT 100""", (motif, motif, motif))
        rows = cur.fetchall()
        journal(cur, u["id"], "recherche de titulaire", None, q.strip()[:60])
    return rows


def transferer_titulaires(cur, d: dict, u: dict, creees: list[int]):
    """Après une décision approuvée : les droits suivent le dossier (appelé par foncier.appliquer_decision)."""
    t, did = d["type"], d["id"]
    nouveau = (d["demandeur_nom"], d["demandeur_telephone"], d["demandeur_piece"])

    def ajouter(pid: int, qualite: str = "Propriétaire"):
        cur.execute("""INSERT INTO fon.titulaires (parcelle, nom, qualite, telephone, piece_identite, debut, dossier, cree_par)
                       VALUES (%s, %s, %s, %s, %s, current_date, %s, %s)""", (pid, *nouveau[:1], qualite, *nouveau[1:], did, u["id"]))

    def copier(depuis: list[int], vers: int):
        cur.execute("""INSERT INTO fon.titulaires (parcelle, nom, type_personne, qualite, part, telephone, piece_identite, adresse,
                              debut, dossier, observations, cree_par)
                       SELECT DISTINCT ON (lower(nom)) %s, nom, type_personne, qualite, part, telephone, piece_identite, adresse,
                              debut, %s, observations, %s
                       FROM fon.titulaires WHERE parcelle = ANY (%s) AND actif ORDER BY lower(nom), id""",
                    (vers, did, u["id"], depuis))

    if t in ("Attribution", "Régularisation") and creees:
        ajouter(creees[0])
    elif t == "Régularisation":
        cur.execute("SELECT 1 FROM fon.titulaires WHERE parcelle = %s AND actif", (d["parcelles"][0],))
        if not cur.fetchone():
            ajouter(d["parcelles"][0])
    elif t.startswith("Mutation"):
        pid = d["parcelles"][0]
        cur.execute("""UPDATE fon.titulaires SET actif = false, fin = current_date, modifie_le = now(),
                              observations = concat_ws(' — ', observations, %s::text)
                       WHERE parcelle = %s AND actif AND qualite IN ('Propriétaire', 'Copropriétaire', 'Héritier', 'Usufruitier')""",
                    (f"fin du droit : {t.lower()} (dossier {d['numero']})", pid))
        ajouter(pid, "Héritier" if t == "Mutation (succession)" else "Propriétaire")
    elif t == "Morcellement":
        for pid in creees:
            copier(d["parcelles"], pid)
    elif t == "Fusion" and creees:
        copier(d["parcelles"], creees[0])


# ---------------------------------------------------------------- pièces jointes
class PieceIn(BaseModel):
    parcelle: int | None = None
    dossier: int | None = None
    litige: int | None = None
    type: str
    description: str | None = Field(None, max_length=300)
    nom_fichier: str = Field(min_length=1, max_length=150)
    contenu: str                                     # data:application/pdf;base64,…


def decoder_piece(data: str) -> tuple[str, bytes]:
    if not data.startswith("data:") or ";base64," not in data:
        raise HTTPException(400, "Fichier illisible.")
    mime, b64 = data[5:].split(";base64,", 1)
    if mime not in SIGNATURES:
        raise HTTPException(400, "Format accepté : PDF, JPEG ou PNG.")
    try:
        raw = base64.b64decode(b64, validate=True)
    except ValueError:
        raise HTTPException(400, "Fichier illisible.")
    if len(raw) > MAX_PIECE:
        raise HTTPException(400, "Fichier trop lourd (5 Mo maximum).")
    if not raw.startswith(SIGNATURES[mime]):
        raise HTTPException(400, "Le contenu du fichier ne correspond pas à son format.")
    return mime, raw


def voir_piece(u: dict, r: dict) -> bool:
    return acces(u) or r["ajoute_par"] == u["id"]


@router.get("/pieces")
def lister_pieces(parcelle: int | None = None, dossier: int | None = None, litige: int | None = None,
                  u: dict = Depends(current_user)):
    if not any((parcelle, dossier, litige)):
        raise HTTPException(400, "Précisez la parcelle, le dossier ou le litige.")
    with cursor() as cur:
        cur.execute("""SELECT p.id, p.type, p.description, p.nom_fichier, p.mime, p.taille, p.ajoute_le, p.ajoute_par,
                              u.nom AS ajoute_par_nom, p.parcelle, p.dossier, p.litige
                       FROM fon.pieces p LEFT JOIN app.utilisateurs u ON u.id = p.ajoute_par
                       WHERE (%s::int IS NULL OR p.parcelle = %s) AND (%s::int IS NULL OR p.dossier = %s)
                         AND (%s::int IS NULL OR p.litige = %s)
                       ORDER BY p.ajoute_le DESC""", (parcelle, parcelle, dossier, dossier, litige, litige))
        rows = cur.fetchall()
    visibles = [iso(r, "ajoute_le") for r in rows if voir_piece(u, r)]
    return {"acces": acces(u), "pieces": visibles, "masquees": len(rows) - len(visibles)}


@router.post("/pieces", status_code=201)
def ajouter_piece(body: PieceIn, u: dict = Depends(current_user)):
    if sum(x is not None for x in (body.parcelle, body.dossier, body.litige)) != 1:
        raise HTTPException(400, "Une pièce se rattache à une parcelle, un dossier ou un litige.")
    if body.type not in TYPES_PIECE:
        raise HTTPException(400, "Type de pièce inconnu.")
    if body.parcelle and not acces(u):
        raise HTTPException(403, f"Pièces d'une parcelle : réservées au service {SERVICE_FONCIER} et aux superviseurs.")
    mime, raw = decoder_piece(body.contenu)
    with cursor() as cur:
        for table, val in (("parcelles", body.parcelle), ("dossiers", body.dossier), ("litiges", body.litige)):
            if val is not None:
                cur.execute(f"SELECT 1 FROM fon.{table} WHERE id = %s", (val,))
                if not cur.fetchone():
                    raise HTTPException(404, "Objet introuvable.")
        cur.execute("""INSERT INTO fon.pieces (parcelle, dossier, litige, type, description, nom_fichier, mime, taille, contenu, ajoute_par)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                    (body.parcelle, body.dossier, body.litige, body.type, body.description, body.nom_fichier.strip(), mime, len(raw),
                     raw, u["id"]))
        pid = cur.fetchone()["id"]
        if body.parcelle:
            historiser_parcelle(cur, body.parcelle, u["id"], "pièce ajoutée", f"{body.type} : {body.nom_fichier}")
        journal(cur, u["id"], "ajout de pièce", f"pièce {pid}", f"{body.type} — {body.nom_fichier}")
    return {"id": pid}


@router.get("/pieces/{pid}")
def telecharger_piece(pid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT nom_fichier, mime, contenu, ajoute_par FROM fon.pieces WHERE id = %s", (pid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Pièce introuvable.")
        if not voir_piece(u, r):
            raise HTTPException(403, f"Pièce réservée au service {SERVICE_FONCIER} et aux superviseurs.")
        journal(cur, u["id"], "consultation de pièce", f"pièce {pid}", r["nom_fichier"])   # traçabilité des consultations
    nom = r["nom_fichier"].replace('"', "")
    return Response(bytes(r["contenu"]), media_type=r["mime"],
                    headers={"Content-Disposition": f"inline; filename*=UTF-8''{_url(nom)}", "Cache-Control": "private, no-store"})


def _url(s: str) -> str:
    return quote(s)


@router.delete("/pieces/{pid}")
def supprimer_piece(pid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT ajoute_par, nom_fichier, parcelle FROM fon.pieces WHERE id = %s", (pid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Pièce introuvable.")
        if not (est_superviseur(u) or r["ajoute_par"] == u["id"]):
            raise HTTPException(403, "Seul l'agent qui a ajouté la pièce, ou un superviseur, peut la supprimer.")
        cur.execute("DELETE FROM fon.pieces WHERE id = %s", (pid,))
        if r["parcelle"]:
            historiser_parcelle(cur, r["parcelle"], u["id"], "pièce supprimée", r["nom_fichier"])
        journal(cur, u["id"], "suppression de pièce", f"pièce {pid}", r["nom_fichier"])
    return {"ok": True}


# ---------------------------------------------------------------- litiges
LITIGE_COLS = """l.id, l.numero, l.type, l.statut, l.parcelles, l.quartier, l.parties, l.description, l.mediateur, l.prochaine_etape,
    l.resolution, l.declare_le, l.declare_par, l.clos_le, l.modifie_le, m.nom AS mediateur_nom, dp.nom AS declare_par_nom,
    (SELECT array_agg(p.numero ORDER BY p.numero) FROM fon.parcelles p WHERE p.id = ANY (l.parcelles)) AS parcelles_numeros,
    ST_AsGeoJSON(l.geom, 7)::json AS geometry"""
LITIGE_FROM = """ FROM fon.litiges l LEFT JOIN app.utilisateurs m ON m.id = l.mediateur
    LEFT JOIN app.utilisateurs dp ON dp.id = l.declare_par """


def feature_litige(r: dict, u: dict) -> dict:
    geom = r.pop("geometry")
    iso(r, "prochaine_etape", "declare_le", "clos_le", "modifie_le")
    r["parcelles_numeros"] = r["parcelles_numeros"] or []
    if not (acces(u) or r["declare_par"] == u["id"]):
        r["parties"] = None          # noms des personnes en conflit : accès réservé
        r["parties_masquees"] = True
    return {"type": "Feature", "id": r["id"], "geometry": geom, "properties": r}


def un_litige(cur, lid: int, u: dict) -> dict:
    cur.execute(f"SELECT {LITIGE_COLS} {LITIGE_FROM} WHERE l.id = %s", (lid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Litige introuvable.")
    return feature_litige(r, u)


class LitigeIn(BaseModel):
    type: str
    parcelles: list[int] = []
    point: list[float] | None = None          # [lon, lat] si aucune parcelle du registre n'est concernée
    parties: str | None = Field(None, max_length=1000)
    description: str = Field(min_length=5, max_length=3000)


@router.get("/litiges")
def lister_litiges(parcelle: int | None = None, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute(f"SELECT {LITIGE_COLS} {LITIGE_FROM}" + (" WHERE %s = ANY (l.parcelles)" if parcelle else "") +
                    " ORDER BY l.declare_le DESC", (parcelle,) if parcelle else ())
        return {"type": "FeatureCollection", "features": [feature_litige(r, u) for r in cur.fetchall()]}


@router.get("/litiges/{lid}")
def fiche_litige(lid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        f = un_litige(cur, lid, u)
        cur.execute("""SELECT h.date, h.action, h.statut_avant, h.statut_apres, h.commentaire, u.nom AS utilisateur
                       FROM fon.litiges_historique h LEFT JOIN app.utilisateurs u ON u.id = h.utilisateur
                       WHERE h.litige = %s ORDER BY h.date, h.id""", (lid,))
        f["historique"] = [iso(r, "date") for r in cur.fetchall()]
        if acces(u):
            cur.execute("""SELECT id, nom FROM app.utilisateurs WHERE statut = 'actif'
                             AND (service = %s OR role IN ('superviseur', 'admin')) ORDER BY nom""", (SERVICE_FONCIER,))
            f["mediateurs"] = cur.fetchall()
        f["peut_gerer"] = acces(u)
    return f


@router.post("/litiges", status_code=201)
def declarer_litige(body: LitigeIn, u: dict = Depends(current_user)):
    if body.type not in TYPES_LITIGE:
        raise HTTPException(400, "Type de litige inconnu.")
    if not body.parcelles and not (body.point and len(body.point) == 2):
        raise HTTPException(400, "Choisissez la ou les parcelles concernées, ou un point sur la carte.")
    with cursor() as cur:
        for pid in body.parcelles:
            lire_parcelle(cur, pid)
        if body.parcelles:
            cur.execute("SELECT ST_PointOnSurface(geom) AS g FROM fon.parcelles WHERE id = %s", (body.parcelles[0],))
            point_sql, point_val = "%s::geometry", cur.fetchone()["g"]
        else:
            point_sql, point_val = "ST_SetSRID(ST_MakePoint(%s, %s), 4326)", None
        args = (point_val,) if point_val is not None else tuple(body.point)
        cur.execute(f"""SELECT (SELECT nom FROM ref.quartiers q WHERE ST_Contains(q.geom, g) LIMIT 1) AS quartier,
                               EXISTS (SELECT 1 FROM ref.limite_commune c WHERE ST_DWithin(c.geom::geography, g::geography, 500)) AS dedans,
                               g FROM (SELECT {point_sql} AS g) t""", args)
        r = cur.fetchone()
        if not r["dedans"]:
            raise HTTPException(400, "Le litige est en dehors de la commune.")
        annee = dt.date.today().year
        cur.execute("""SELECT %s || lpad((COALESCE(max(substring(numero FROM '(\\d+)$')::int), 0) + 1)::text, 4, '0') AS n
                       FROM fon.litiges WHERE numero LIKE %s""", (f"LF-{annee}-", f"LF-{annee}-%"))
        numero = cur.fetchone()["n"]
        cur.execute("""INSERT INTO fon.litiges (numero, type, parcelles, geom, quartier, parties, description, declare_par)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                    (numero, body.type, body.parcelles, r["g"], r["quartier"], body.parties, body.description, u["id"]))
        lid = cur.fetchone()["id"]
        cur.execute("""INSERT INTO fon.litiges_historique (litige, utilisateur, action, statut_apres, commentaire)
                       VALUES (%s, %s, 'signalement', 'Signalé', %s)""", (lid, u["id"], body.description[:300]))
        for pid in body.parcelles:
            historiser_parcelle(cur, pid, u["id"], "litige signalé", f"{numero} — {body.type}")
        journal(cur, u["id"], "signalement de litige foncier", f"litige {lid}", f"{numero} {body.type}")
        return un_litige(cur, lid, u)


class ActionLitige(BaseModel):
    action: str = Field(pattern=r"^(mediation|etape|resoudre|tribunal|clore|rouvrir|commenter)$")
    mediateur: int | None = None
    prochaine_etape: dt.date | None = None
    commentaire: str | None = Field(None, max_length=3000)


@router.post("/litiges/{lid}/action")
def action_litige(lid: int, body: ActionLitige, u: dict = Depends(current_user)):
    a = body.action
    with cursor() as cur:
        cur.execute("SELECT * FROM fon.litiges WHERE id = %s FOR UPDATE", (lid,))
        l = cur.fetchone()
        if not l:
            raise HTTPException(404, "Litige introuvable.")
        s, nouveau, sets, vals = l["statut"], l["statut"], [], []
        if a != "commenter" and not acces(u):
            raise HTTPException(403, f"Le traitement des litiges revient au service {SERVICE_FONCIER} et aux superviseurs.")
        if a in ("mediation", "etape", "resoudre", "tribunal") and s not in LITIGE_OUVERT:
            raise HTTPException(409, "Litige clos ou résolu.")
        if a == "commenter":
            if not body.commentaire:
                raise HTTPException(400, "Commentaire vide.")
            libelle = "commentaire"
        elif a == "mediation":
            med = body.mediateur or u["id"]
            cur.execute("SELECT nom FROM app.utilisateurs WHERE id = %s AND statut = 'actif'", (med,))
            m = cur.fetchone()
            if not m:
                raise HTTPException(400, "Médiateur inconnu.")
            nouveau, libelle = "En médiation", "médiation engagée"
            sets += ["mediateur = %s", "prochaine_etape = %s"]
            vals += [med, body.prochaine_etape]
            body.commentaire = f"médiateur : {m['nom']}" + (f" — {body.commentaire}" if body.commentaire else "")
        elif a == "etape":
            if not body.commentaire:
                raise HTTPException(400, "Indiquez le compte rendu de la réunion ou de l'audience.")
            libelle = "réunion / audience"
            sets.append("prochaine_etape = %s")
            vals.append(body.prochaine_etape)
        elif a == "resoudre":
            if not body.commentaire:
                raise HTTPException(400, "Décrivez l'accord trouvé.")
            nouveau, libelle = "Résolu à l'amiable", "résolution à l'amiable"
            sets += ["resolution = %s", "clos_le = now()", "prochaine_etape = NULL"]
            vals.append(body.commentaire)
        elif a == "tribunal":
            nouveau, libelle = "Transmis au tribunal", "transmission au tribunal"
            sets.append("prochaine_etape = %s")
            vals.append(body.prochaine_etape)
        elif a == "clore":
            if not body.commentaire:
                raise HTTPException(400, "Indiquez l'issue (décision de justice, retrait, sans suite…).")
            if s == "Clos":
                raise HTTPException(409, "Litige déjà clos.")
            nouveau, libelle = "Clos", "clôture"
            sets += ["resolution = COALESCE(resolution, %s)", "clos_le = now()", "prochaine_etape = NULL"]
            vals.append(body.commentaire)
        else:   # rouvrir
            if not est_superviseur(u):
                raise HTTPException(403, "Réouverture réservée aux superviseurs.")
            if s in LITIGE_OUVERT:
                raise HTTPException(409, "Le litige est déjà ouvert.")
            nouveau, libelle = "En médiation" if l["mediateur"] else "Signalé", "réouverture"
            sets.append("clos_le = NULL")
        sets += ["statut = %s", "modifie_le = now()"]
        vals.append(nouveau)
        cur.execute("""INSERT INTO fon.litiges_historique (litige, utilisateur, action, statut_avant, statut_apres, commentaire)
                       VALUES (%s, %s, %s, %s, %s, %s)""", (lid, u["id"], libelle, s, nouveau, body.commentaire))
        cur.execute(f"UPDATE fon.litiges SET {', '.join(sets)} WHERE id = %s", vals + [lid])
        if nouveau != s:
            for pid in l["parcelles"]:
                historiser_parcelle(cur, pid, u["id"], f"litige {l['numero']} : {nouveau.lower()}", body.commentaire)
        journal(cur, u["id"], f"litige foncier : {libelle}", f"litige {lid}", l["numero"])
        return un_litige(cur, lid, u)


def alertes_litiges(cur, parcelles: list[int]) -> list[dict]:
    """Litiges en cours sur des parcelles : bloquent la décision d'un dossier (appelé par foncier.verifier_dossier)."""
    if not parcelles:
        return []
    cur.execute("""SELECT numero, type, statut FROM fon.litiges WHERE parcelles && %s::int[] AND statut = ANY (%s) ORDER BY numero""",
                (parcelles, list(LITIGE_OUVERT)))
    return [{"type": "litige", "niveau": "bloquant", "litige": r["numero"],
             "message": f"Litige {r['numero']} en cours ({r['type'].lower()}, {r['statut'].lower()})."} for r in cur.fetchall()]


# ---------------------------------------------------------------- fiche parcellaire
def donnees_fiche(cur, pid: int, u: dict) -> dict:
    cur.execute("""SELECT p.id, p.numero, p.quartier, p.usage, p.statut_juridique, p.reference_acte, p.date_acte, p.lotissement,
                          p.lot, p.etat, p.source_geom, p.precision_m::float, p.superficie_m2::float, p.perimetre_m::float,
                          p.valide_le, ST_AsGeoJSON(p.geom, 7)::json AS geometry,
                          ST_X(ST_PointOnSurface(p.geom)) AS lon, ST_Y(ST_PointOnSurface(p.geom)) AS lat
                   FROM fon.parcelles p WHERE p.id = %s""", (pid,))
    p = cur.fetchone()
    if not p:
        raise HTTPException(404, "Parcelle introuvable.")
    if p["etat"] == "Archivée":
        raise HTTPException(409, "Parcelle archivée : la fiche ne peut pas être délivrée.")
    iso(p, "date_acte", "valide_le")
    # bornes (sommets) en UTM 28N et en WGS 84, dans le sens des aiguilles d'une montre depuis le nord-ouest
    cur.execute("""WITH g AS (SELECT ST_ForcePolygonCW(geom) AS g FROM fon.parcelles WHERE id = %s),
                        pts AS (SELECT (dp).path[2] AS i, (dp).geom AS pt FROM (SELECT ST_DumpPoints(ST_ExteriorRing(g)) AS dp FROM g) t)
                   SELECT i, round(ST_X(ST_Transform(pt, 32628))::numeric, 2)::float AS x, round(ST_Y(ST_Transform(pt, 32628))::numeric, 2)::float AS y,
                          ST_X(pt) AS lon, ST_Y(pt) AS lat FROM pts ORDER BY i""", (pid,))
    pts = cur.fetchall()[:-1]                     # le dernier sommet ferme l'anneau
    k0 = min(range(len(pts)), key=lambda k: (-pts[k]["y"] + pts[k]["x"]))    # sommet le plus au nord-ouest
    pts = pts[k0:] + pts[:k0]
    bornes = []
    for k, b in enumerate(pts):
        n = pts[(k + 1) % len(pts)]
        bornes.append({"nom": f"B{k + 1}", "x": b["x"], "y": b["y"], "lon": round(b["lon"], 7), "lat": round(b["lat"], 7),
                       "cote_vers": f"B{(k + 1) % len(pts) + 1}",
                       "longueur": round(((n["x"] - b["x"]) ** 2 + (n["y"] - b["y"]) ** 2) ** 0.5, 2)})
    cur.execute("""SELECT q.numero, ST_AsGeoJSON(q.geom, 7)::json AS geometry FROM fon.parcelles q, fon.parcelles p
                   WHERE p.id = %s AND q.id <> p.id AND q.etat <> 'Archivée' AND ST_DWithin(q.geom_m, p.geom_m, 1)
                   ORDER BY q.numero""", (pid,))
    voisins = cur.fetchall()
    cur.execute("""SELECT a.numero || a.suffixe || ', ' || v.type_voie || ' ' || COALESCE(v.nom, v.code) AS libelle
                   FROM adr.adresses a JOIN adr.voies v ON v.id = a.voie_id, fon.parcelles p
                   WHERE p.id = %s AND ST_Contains(p.geom, a.geom) AND a.statut <> 'Proposée' ORDER BY a.numero""", (pid,))
    adresses = [r["libelle"] for r in cur.fetchall()]
    cur.execute("""SELECT nom, type_personne, qualite, part FROM fon.titulaires WHERE parcelle = %s AND actif ORDER BY id""", (pid,))
    titulaires = cur.fetchall() if acces(u) else []
    cur.execute("""SELECT numero, type, statut FROM fon.litiges WHERE %s = ANY (parcelles) AND statut = ANY (%s)""", (pid, list(LITIGE_OUVERT)))
    litiges = cur.fetchall()
    cur.execute("SELECT alertes FROM fon.parcelles WHERE id = %s", (pid,))
    alertes = [a for a in cur.fetchone()["alertes"] if a.get("niveau") != "info" or a.get("type") == "inondation"]
    return {"parcelle": p, "bornes": bornes, "voisins": voisins, "adresses": adresses, "titulaires": titulaires,
            "litiges": litiges, "alertes": alertes, "acces": acces(u)}


@router.get("/parcelles/{pid}/fiche")
def apercu_fiche(pid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        return donnees_fiche(cur, pid, u)


class DelivranceIn(BaseModel):
    demandeur: str | None = Field(None, max_length=150)
    motif: str | None = Field(None, max_length=200)


@router.post("/parcelles/{pid}/fiche", status_code=201)
def delivrer_fiche(pid: int, body: DelivranceIn, u: dict = Depends(current_user)):
    exiger_acces(u)
    with cursor() as cur:
        d = donnees_fiche(cur, pid, u)
        p = d["parcelle"]
        if p["etat"] != "Enregistrée":
            raise HTTPException(409, "Seule une parcelle enregistrée (validée) donne lieu à une fiche parcellaire.")
        annee = dt.date.today().year
        cur.execute("""SELECT %s || lpad((COALESCE(max(substring(numero FROM '(\\d+)$')::int), 0) + 1)::text, 5, '0') AS n
                       FROM fon.fiches WHERE numero LIKE %s""", (f"FP-{annee}-", f"FP-{annee}-%"))
        numero = cur.fetchone()["n"]
        code = secrets.token_hex(4).upper()
        resume = {"parcelle": p["numero"], "quartier": p["quartier"], "superficie_m2": p["superficie_m2"],
                  "statut_juridique": p["statut_juridique"], "usage": p["usage"]}
        cur.execute("""INSERT INTO fon.fiches (numero, code, parcelle, demandeur, motif, empreinte, resume, delivre_par)
                       SELECT %s, %s, id, %s, %s, md5(ST_AsBinary(geom)), %s, %s FROM fon.parcelles WHERE id = %s
                       RETURNING delivre_le""",
                    (numero, code, body.demandeur, body.motif, json.dumps(resume), u["id"], pid))
        d["fiche"] = {"numero": numero, "code": code, "delivre_le": cur.fetchone()["delivre_le"].isoformat(timespec="seconds"),
                      "demandeur": body.demandeur, "motif": body.motif, "delivre_par": u["nom"]}
        historiser_parcelle(cur, pid, u["id"], "fiche parcellaire délivrée", f"{numero}" + (f" à {body.demandeur}" if body.demandeur else ""))
        journal(cur, u["id"], "délivrance de fiche parcellaire", f"parcelle {pid}", numero)
    return d


@router.get("/fiches/verifier")
def verifier_fiche(numero: str, code: str):
    """Vérification publique d'une fiche (QR code) : aucune donnée personnelle."""
    with cursor() as cur:
        cur.execute("""SELECT f.numero, f.delivre_le, f.resume, p.etat, p.statut_juridique, p.superficie_m2::float,
                              f.empreinte = md5(ST_AsBinary(p.geom)) AS limites_inchangees
                       FROM fon.fiches f JOIN fon.parcelles p ON p.id = f.parcelle
                       WHERE f.numero = %s AND f.code = %s""", (numero.strip().upper(), code.strip().upper()))
        r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Aucune fiche ne correspond à ce numéro et à ce code.")
    return iso(r, "delivre_le")
