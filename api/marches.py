"""
Marchés et gares routières : sites, emplacements, occupants et recettes (droits de place).

- Sites : marchés quotidiens, hebdomadaires, à bétail, gares routières (point ou emprise), recensés par les agents,
  importés des équipements de la carte ou venus d'une saisie « Marché » / « Gare routière » de l'onglet Saisie.
- Emplacements : boutiques, magasins, étals, tables, places au sol, bureaux de ligne, stationnements ; statut
  (libre, occupée, hors service), loyer mensuel, occupant (données personnelles : service seulement).
- Recettes : loyers mensuels, tickets journaliers, droits de stationnement ; quittance numérotée QM-AAAA-00001,
  saisie possible sans réseau ; une quittance ne se supprime pas, elle s'annule (superviseur, avec motif).
- Impayés : emplacements occupés dont le loyer d'un mois échu n'a pas été encaissé.
"""
import datetime as dt
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from dechets import csv_reponse, iso, quartier_de
from environnement import lire_geom, numero_suivant, photo_reponse
from main import current_user, cursor, decode_photo, historiser, journal

router = APIRouter(prefix="/marches")

SERVICES_MAR = ("Développement local", "Finances et recettes")
TYPES_SITE = ["Marché quotidien", "Marché hebdomadaire", "Marché à bétail", "Gare routière"]
ETATS_SITE = ["En activité", "En travaux", "Fermé"]
GESTIONS = ["Régie communale", "Concession", "Syndicat ou association", "Autre"]
TYPES_PLACE = ["Boutique", "Magasin", "Hangar ou étal", "Table", "Place au sol", "Kiosque", "Bureau de ligne", "Stationnement", "Autre"]
STATUTS_PLACE = ["Libre", "Occupée", "Hors service"]
NATURES = ["Loyer mensuel", "Tickets journaliers", "Droits de stationnement", "Autre droit"]
MODES = ["Espèces", "Mobile money", "Chèque ou virement"]
# saisies de l'onglet Saisie (Équipement public) que le service peut transformer en site
SAISIES = {"Marché": "Marché quotidien", "Gare routière": "Gare routière"}
SEUIL_DOUBLON = 50   # m : un site du même genre aussi près demande confirmation


def apply_schema(cur):
    cur.execute((Path(__file__).parent / "marches.sql").read_text(encoding="utf-8"))


# ---------------------------------------------------------------- droits et outils
def peut_gerer(u: dict) -> bool:
    return u["role"] in ("superviseur", "admin") or u["service"] in SERVICES_MAR


def exiger_gestion(u: dict):
    if not peut_gerer(u):
        raise HTTPException(403, "Réservé au Développement local, aux Finances et recettes et aux superviseurs.")


def prefixe_site(type_: str) -> str:
    return "GR" if type_ == "Gare routière" else "MA"


def gnf(v) -> str:
    return f"{v:,.0f} GNF".replace(",", " ")


def premier_du_mois(d: dt.date | None = None) -> dt.date:
    d = d or dt.date.today()
    return d.replace(day=1)


@router.get("/listes")
def listes(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT cle, valeur::float, description FROM mar.parametres ORDER BY cle")
        parametres = cur.fetchall()
    return {"types_site": TYPES_SITE, "etats_site": ETATS_SITE, "gestions": GESTIONS, "types_place": TYPES_PLACE,
            "statuts_place": STATUTS_PLACE, "natures": NATURES, "modes": MODES, "peut_gerer": peut_gerer(u),
            "peut_annuler": u["role"] in ("superviseur", "admin"), "parametres": parametres}


# ---------------------------------------------------------------- sites
SITE_COLS = """s.id, s.numero, s.type, s.nom, s.etat, s.gestion, s.jours, s.horaires, s.responsable, s.telephone, s.destinations,
    s.capacite, s.tarif_ticket_gnf::float, s.quartier, s.observations, s.equipement, s.contribution, s.cree_le, s.cree_par,
    (s.photo IS NOT NULL) AS a_photo,
    (SELECT count(*) FROM mar.places p WHERE p.site = s.id)::int AS places,
    (SELECT count(*) FROM mar.places p WHERE p.site = s.id AND p.statut = 'Occupée')::int AS occupees,
    (SELECT count(*) FROM mar.places p WHERE p.site = s.id AND p.statut = 'Libre')::int AS libres,
    ST_AsGeoJSON(s.geom, 7)::json AS geometry, ST_AsGeoJSON(ST_PointOnSurface(s.geom), 7)::json AS centre,
    CASE WHEN GeometryType(s.geom) LIKE '%%POLYGON' THEN round(ST_Area(ST_Transform(s.geom, 32628)))::int END AS surface_m2"""


def feature_site(r: dict, gestion: bool) -> dict:
    g = r.pop("geometry")
    iso(r, "cree_le")
    r["photo_url"] = f"/api/marches/sites/{r['id']}/photo" if r.pop("a_photo") else None
    if not gestion:
        r.pop("telephone", None)
    return {"type": "Feature", "id": r["id"], "geometry": g, "properties": r}


def un_site(cur, sid: int, gestion: bool) -> dict:
    cur.execute(f"SELECT {SITE_COLS}, c.nom AS cree_par_nom FROM mar.sites s LEFT JOIN app.utilisateurs c ON c.id = s.cree_par WHERE s.id = %s",
                (sid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Site introuvable.")
    return feature_site(r, gestion)


@router.get("/sites")
def lister_sites(u: dict = Depends(current_user)):
    g = peut_gerer(u)
    with cursor() as cur:
        cur.execute(f"SELECT {SITE_COLS}, NULL AS cree_par_nom FROM mar.sites s ORDER BY s.type, s.nom")
        return {"type": "FeatureCollection", "features": [feature_site(r, g) for r in cur.fetchall()]}


@router.get("/sites/{sid}")
def lire_site(sid: int, u: dict = Depends(current_user)):
    g = peut_gerer(u)
    with cursor() as cur:
        f = un_site(cur, sid, g)
        f["places"] = places_du_site(cur, sid, g)
        if g:
            cur.execute("""SELECT COALESCE(sum(montant_gnf) FILTER (WHERE date_perception >= date_trunc('month', current_date)), 0)::float AS mois,
                                  COALESCE(sum(montant_gnf) FILTER (WHERE date_perception >= current_date - 364), 0)::float AS annee,
                                  COALESCE(sum(nombre) FILTER (WHERE nature = 'Droits de stationnement'
                                                               AND date_perception >= current_date - 29), 0)::int AS vehicules_30j
                           FROM mar.perceptions WHERE site = %s AND statut = 'Valide'""", (sid,))
            f["recettes"] = cur.fetchone()
            cur.execute("""SELECT COALESCE(sum(loyer_gnf), 0)::float AS v FROM mar.places WHERE site = %s AND statut = 'Occupée'""", (sid,))
            f["recettes"]["loyers_attendus"] = cur.fetchone()["v"]
            f["impayes"] = [x for x in impayes(cur) if x["site"] == sid]
        f["peut_modifier"] = g or f["properties"]["cree_par"] == u["id"]
        f["peut_gerer"] = g
    return f


@router.get("/sites/{sid}/photo")
def photo_site(sid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        return photo_reponse(cur, "SELECT photo FROM mar.sites WHERE id = %s", sid)


class SiteIn(BaseModel):
    geometry: dict | None = None
    type: str | None = None
    nom: str | None = Field(None, min_length=2, max_length=150)
    etat: str | None = None
    gestion: str | None = None
    jours: str | None = Field(None, max_length=150)
    horaires: str | None = Field(None, max_length=150)
    responsable: str | None = Field(None, max_length=150)
    telephone: str | None = Field(None, max_length=40)
    destinations: str | None = Field(None, max_length=500)
    capacite: int | None = Field(None, ge=0, le=10000)
    tarif_ticket_gnf: float | None = Field(None, ge=0, le=1e8)
    observations: str | None = Field(None, max_length=2000)
    photo: str | None = None
    uid: str | None = Field(None, pattern=r"^[0-9a-fA-F-]{36}$")
    forcer: bool = False


CHAMPS_SITE = ("type", "nom", "etat", "gestion", "jours", "horaires", "responsable", "telephone", "destinations", "capacite",
               "tarif_ticket_gnf", "observations")


def verifier_site(d: dict):
    for k, ok in (("type", TYPES_SITE), ("etat", ETATS_SITE), ("gestion", GESTIONS)):
        if k in d and d[k] is not None and d[k] not in ok:
            raise HTTPException(400, f"Valeur invalide : {k}.")


def site_proche(cur, gj: str, type_: str, sauf: int | None = None) -> dict | None:
    gare = type_ == "Gare routière"
    cur.execute("""SELECT numero, nom, round(ST_Distance(ST_Transform(geom, 32628), t.p))::int AS d FROM mar.sites,
                          (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), 32628) AS p) t
                   WHERE ST_DWithin(ST_Transform(geom, 32628), t.p, %s) AND (type = 'Gare routière') = %s AND id IS DISTINCT FROM %s
                   ORDER BY 3 LIMIT 1""", (gj, SEUIL_DOUBLON, gare, sauf))
    return cur.fetchone()


def inserer_site(cur, u: dict, d: dict, gj: str, photo: bytes | None, uid: str | None = None,
                 equipement: int | None = None, contribution: int | None = None) -> int:
    numero = numero_suivant(cur, "mar.sites", prefixe_site(d["type"]))
    cols = [k for k in CHAMPS_SITE if d.get(k) is not None]
    cur.execute(f"""INSERT INTO mar.sites (numero, uid, quartier, photo, geom, equipement, contribution, cree_par{''.join(', ' + c for c in cols)})
                    VALUES (%s, %s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s, %s, %s{', %s' * len(cols)}) RETURNING id""",
                [numero, uid, quartier_de(cur, gj), photo, gj, equipement, contribution, u["id"]] + [d[k] for k in cols])
    sid = cur.fetchone()["id"]
    journal(cur, u["id"], "site recensé (marchés)", f"site {numero}", f"{d['type']} — {d['nom']}")
    return sid


@router.post("/sites", status_code=201)
def creer_site(body: SiteIn, u: dict = Depends(current_user)):
    d = body.model_dump(exclude_unset=True)
    if not d.get("type") or not d.get("nom"):
        raise HTTPException(400, "Type et nom obligatoires.")
    verifier_site(d)
    with cursor() as cur:
        if body.uid:
            cur.execute("SELECT id FROM mar.sites WHERE uid = %s", (body.uid,))
            deja = cur.fetchone()
            if deja:
                return un_site(cur, deja["id"], peut_gerer(u))
        gj = lire_geom(cur, body.geometry, ("Point", "Polygon"))
        v = site_proche(cur, gj, d["type"])
        if v and not body.forcer:
            raise HTTPException(409, {"message": f"Un site existe déjà à {v['d']} m : {v['numero']} ({v['nom']}).", "proche": v})
        sid = inserer_site(cur, u, d, gj, decode_photo(body.photo), body.uid)
        return un_site(cur, sid, peut_gerer(u))


@router.put("/sites/{sid}")
def modifier_site(sid: int, body: SiteIn, u: dict = Depends(current_user)):
    d = body.model_dump(exclude_unset=True)
    d.pop("uid", None)
    forcer = d.pop("forcer", False)
    verifier_site(d)
    with cursor() as cur:
        cur.execute("SELECT numero, type, cree_par FROM mar.sites WHERE id = %s FOR UPDATE", (sid,))
        x = cur.fetchone()
        if not x:
            raise HTTPException(404, "Site introuvable.")
        if not (peut_gerer(u) or x["cree_par"] == u["id"]):
            raise HTTPException(403, "Vous ne pouvez modifier que vos propres saisies.")
        if d.get("type") and prefixe_site(d["type"]) != prefixe_site(x["type"]):
            raise HTTPException(400, "Un marché ne peut pas devenir une gare routière (ni l'inverse) : créez un autre site.")
        sets, vals = [], []
        for k in CHAMPS_SITE:
            if k in d and not (k in ("type", "nom", "etat", "gestion") and d[k] is None):
                sets.append(f"{k} = %s")
                vals.append(d[k])
        if "photo" in d:
            sets.append("photo = %s")
            vals.append(decode_photo(d["photo"]))
        if body.geometry:
            gj = lire_geom(cur, body.geometry, ("Point", "Polygon"))
            v = site_proche(cur, gj, d.get("type") or x["type"], sid)
            if v and not forcer:
                raise HTTPException(409, {"message": f"Un autre site existe à {v['d']} m : {v['numero']} ({v['nom']}).", "proche": v})
            sets += ["geom = ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)", "quartier = %s"]
            vals += [gj, quartier_de(cur, gj)]
        if not sets:
            raise HTTPException(400, "Rien à modifier.")
        sets.append("modifie_le = now()")
        cur.execute(f"UPDATE mar.sites SET {', '.join(sets)} WHERE id = %s", vals + [sid])
        journal(cur, u["id"], "site modifié (marchés)", f"site {x['numero']}", ", ".join(d.keys()))
        return un_site(cur, sid, peut_gerer(u))


@router.delete("/sites/{sid}")
def supprimer_site(sid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("""SELECT numero, cree_par, (SELECT count(*) FROM mar.perceptions x WHERE x.site = s.id)::int AS n,
                              (SELECT count(*) FROM mar.places p WHERE p.site = s.id)::int AS np FROM mar.sites s WHERE id = %s""", (sid,))
        x = cur.fetchone()
        if not x:
            raise HTTPException(404, "Site introuvable.")
        if not (peut_gerer(u) or (x["cree_par"] == u["id"] and not x["np"])):
            raise HTTPException(403, "Suppression réservée au service (ou à l'auteur, avant l'ajout d'emplacements).")
        if x["n"]:
            raise HTTPException(400, f"{x['n']} recette(s) enregistrée(s) sur ce site : passez-le plutôt « Fermé ».")
        cur.execute("DELETE FROM mar.sites WHERE id = %s", (sid,))
        journal(cur, u["id"], "site supprimé (marchés)", f"site {x['numero']}")
    return {"ok": True}


@router.post("/sites/importer")
def importer_equipements(u: dict = Depends(current_user)):
    """Marchés et gares routières déjà présents sur la carte (équipements) : un site chacun, une seule fois."""
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("""SELECT e.gid, e.nom, e.nature, ST_AsGeoJSON(e.geom, 7) AS g FROM ref.equipements e
                       WHERE e.nature IN ('Marché', 'Gare routière') AND NOT EXISTS (SELECT 1 FROM mar.sites s WHERE s.equipement = e.gid)
                       ORDER BY e.gid""")
        crees = []
        for e in cur.fetchall():
            type_ = "Gare routière" if e["nature"] == "Gare routière" else "Marché quotidien"
            nom = e["nom"] or (("Gare routière" if type_ == "Gare routière" else "Marché") + (f" de {quartier_de(cur, e['g'])}" if quartier_de(cur, e["g"]) else ""))
            sid = inserer_site(cur, u, {"type": type_, "nom": nom}, e["g"], None, equipement=e["gid"])
            crees.append(sid)
        return {"crees": len(crees)}


@router.get("/saisies")
def saisies(u: dict = Depends(current_user)):
    """Saisies validées « Marché » ou « Gare routière » de l'onglet Saisie, pas encore devenues des sites."""
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("""SELECT c.id, c.type, c.nom, c.description, c.quartier, c.cree_le, COALESCE(a.nom, c.auteur) AS auteur,
                              ST_AsGeoJSON(ST_PointOnSurface(c.geom), 7)::json AS geometry
                       FROM contrib.contributions c LEFT JOIN app.utilisateurs a ON a.id = c.cree_par
                       WHERE c.categorie = 'Équipement public' AND c.type = ANY(%s) AND c.statut = 'Validé'
                         AND NOT EXISTS (SELECT 1 FROM mar.sites s WHERE s.contribution = c.id)
                       ORDER BY c.cree_le""", (list(SAISIES),))
        return [iso(r, "cree_le") for r in cur.fetchall()]


@router.post("/saisies/{cid}/convertir")
def convertir(cid: int, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("""SELECT id, type, nom, description, photo, ST_AsGeoJSON(geom, 7) AS g, GeometryType(geom) AS gt
                       FROM contrib.contributions WHERE id = %s AND categorie = 'Équipement public' AND type = ANY(%s) FOR UPDATE""",
                    (cid, list(SAISIES)))
        c = cur.fetchone()
        if not c:
            raise HTTPException(404, "Saisie introuvable.")
        cur.execute("SELECT numero FROM mar.sites WHERE contribution = %s", (cid,))
        deja = cur.fetchone()
        if deja:
            raise HTTPException(409, f"Déjà enregistrée : {deja['numero']}.")
        if c["gt"] not in ("POINT", "POLYGON"):
            cur.execute("SELECT ST_AsGeoJSON(ST_PointOnSurface(ST_GeomFromGeoJSON(%s)), 7) AS g", (c["g"],))
            c["g"] = cur.fetchone()["g"]
        type_ = SAISIES[c["type"]]
        sid = inserer_site(cur, u, {"type": type_, "nom": c["nom"] or c["type"], "observations": c["description"]}, c["g"], c["photo"],
                           contribution=cid)
        numero = cur.execute("SELECT numero FROM mar.sites WHERE id = %s", (sid,)).fetchone()["numero"]
        historiser(cur, cid, u["id"], "intégration", "Validé", "Validé", f"site {numero} (marchés et gares routières)")
        return un_site(cur, sid, True)


# ---------------------------------------------------------------- emplacements
def places_du_site(cur, sid: int, gestion: bool) -> list[dict]:
    cur.execute("""SELECT p.id, p.numero, p.type, p.surface_m2::float, p.loyer_gnf::float, p.statut, p.occupant, p.telephone, p.activite,
                          p.depuis, p.observations, ST_AsGeoJSON(p.geom, 7)::json AS geometry,
                          (SELECT max(x.mois) FROM mar.perceptions x WHERE x.place = p.id AND x.nature = 'Loyer mensuel'
                                                                         AND x.statut = 'Valide') AS dernier_mois_paye
                   FROM mar.places p WHERE p.site = %s ORDER BY p.numero""", (sid,))
    rows = cur.fetchall()
    for r in rows:
        iso(r, "depuis", "dernier_mois_paye")
        if not gestion:
            for k in ("occupant", "telephone", "depuis", "dernier_mois_paye"):
                r.pop(k)
    return rows


class PlaceIn(BaseModel):
    geometry: dict | None = None
    type: str | None = None
    surface_m2: float | None = Field(None, gt=0, le=100000)
    loyer_gnf: float | None = Field(None, ge=0, le=1e9)
    statut: str | None = None
    occupant: str | None = Field(None, max_length=150)
    telephone: str | None = Field(None, max_length=40)
    activite: str | None = Field(None, max_length=150)
    depuis: dt.date | None = None
    observations: str | None = Field(None, max_length=2000)
    nombre: int = Field(1, ge=1, le=300)        # création en série (places identiques)
    uid: str | None = Field(None, pattern=r"^[0-9a-fA-F-]{36}$")


CHAMPS_PLACE = ("type", "surface_m2", "loyer_gnf", "statut", "occupant", "telephone", "activite", "depuis", "observations")


def verifier_place(d: dict):
    if d.get("type") is not None and d["type"] not in TYPES_PLACE:
        raise HTTPException(400, "Type d'emplacement invalide.")
    if d.get("statut") is not None and d["statut"] not in STATUTS_PLACE:
        raise HTTPException(400, "Statut invalide.")


def une_place(cur, pid: int) -> dict:
    cur.execute("""SELECT p.id, p.numero, p.site, s.numero AS site_numero, s.nom AS site_nom, s.type AS site_type, p.type, p.surface_m2::float,
                          p.loyer_gnf::float, p.statut, p.occupant, p.telephone, p.activite, p.depuis, p.observations, p.cree_le,
                          ST_AsGeoJSON(COALESCE(p.geom, ST_PointOnSurface(s.geom)), 7)::json AS geometry, (p.geom IS NOT NULL) AS placee
                   FROM mar.places p JOIN mar.sites s ON s.id = p.site WHERE p.id = %s""", (pid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Emplacement introuvable.")
    g = r.pop("geometry")
    return {"type": "Feature", "id": r["id"], "geometry": g, "properties": iso(r, "depuis", "cree_le")}


@router.get("/places/{pid}")
def lire_place(pid: int, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        f = une_place(cur, pid)
        cur.execute("""SELECT x.id, x.numero, x.nature, x.mois, x.montant_gnf::float, x.mode, x.date_perception, x.statut, a.nom AS collecteur
                       FROM mar.perceptions x LEFT JOIN app.utilisateurs a ON a.id = x.cree_par
                       WHERE x.place = %s ORDER BY x.date_perception DESC, x.id DESC LIMIT 60""", (pid,))
        f["perceptions"] = [iso(r, "mois", "date_perception") for r in cur.fetchall()]
        f["impayes"] = [x for x in impayes(cur) if x["id"] == pid]
    return f


@router.post("/sites/{sid}/places", status_code=201)
def creer_places(sid: int, body: PlaceIn, u: dict = Depends(current_user)):
    exiger_gestion(u)
    d = body.model_dump(exclude_unset=True)
    verifier_place(d)
    if body.nombre > 1 and (body.occupant or body.geometry):
        raise HTTPException(400, "Une création en série ne porte ni occupant ni position : complétez chaque emplacement ensuite.")
    if d.get("statut") == "Occupée" and not (body.occupant or "").strip():
        raise HTTPException(400, "Indiquez l'occupant.")
    if d.get("statut") == "Occupée" and not d.get("depuis"):
        d["depuis"] = dt.date.today()               # loyers dus à partir de ce mois
    with cursor() as cur:
        if body.uid:
            cur.execute("SELECT id FROM mar.places WHERE uid = %s", (body.uid,))
            deja = cur.fetchone()
            if deja:
                return {"ids": [deja["id"]], "numeros": []}
        cur.execute("SELECT numero FROM mar.sites WHERE id = %s", (sid,))
        s = cur.fetchone()
        if not s:
            raise HTTPException(404, "Site introuvable.")
        gj = lire_geom(cur, body.geometry, ("Point",)) if body.geometry else None
        cols = [k for k in CHAMPS_PLACE if d.get(k) is not None]
        ids, numeros = [], []
        for i in range(body.nombre):
            numero = numero_suivant(cur, "mar.places", s["numero"], 3)
            cur.execute(f"""INSERT INTO mar.places (numero, uid, site, geom, cree_par{''.join(', ' + c for c in cols)})
                            VALUES (%s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s{', %s' * len(cols)}) RETURNING id""",
                        [numero, body.uid if i == 0 else None, sid, gj, u["id"]] + [d[k] for k in cols])
            ids.append(cur.fetchone()["id"])
            numeros.append(numero)
        journal(cur, u["id"], "emplacements créés (marchés)", f"site {s['numero']}",
                numeros[0] + (f" à {numeros[-1]}" if len(numeros) > 1 else ""))
        return {"ids": ids, "numeros": numeros}


@router.put("/places/{pid}")
def modifier_place(pid: int, body: PlaceIn, u: dict = Depends(current_user)):
    exiger_gestion(u)
    d = body.model_dump(exclude_unset=True)
    d.pop("uid", None)
    d.pop("nombre", None)
    verifier_place(d)
    with cursor() as cur:
        cur.execute("SELECT numero, statut, occupant FROM mar.places WHERE id = %s FOR UPDATE", (pid,))
        x = cur.fetchone()
        if not x:
            raise HTTPException(404, "Emplacement introuvable.")
        statut = d.get("statut") or x["statut"]
        occupant = d["occupant"] if "occupant" in d else x["occupant"]
        if statut == "Occupée" and not (occupant or "").strip():
            raise HTTPException(400, "Indiquez l'occupant.")
        if statut != "Occupée":                     # emplacement libéré : on efface l'occupant
            d.update({"occupant": None, "telephone": None, "activite": None, "depuis": None})
        elif x["statut"] != "Occupée" and not d.get("depuis"):
            d["depuis"] = dt.date.today()           # nouvel occupant : loyers dus à partir de ce mois
        sets, vals = [], []
        for k in CHAMPS_PLACE:
            if k in d and not (k in ("type", "statut") and d[k] is None):
                sets.append(f"{k} = %s")
                vals.append(d[k])
        if body.geometry:
            sets.append("geom = ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)")
            vals.append(lire_geom(cur, body.geometry, ("Point",)))
        if not sets:
            raise HTTPException(400, "Rien à modifier.")
        sets.append("modifie_le = now()")
        cur.execute(f"UPDATE mar.places SET {', '.join(sets)} WHERE id = %s", vals + [pid])
        detail = ", ".join(k for k in d if k not in ("occupant", "telephone"))
        if statut != x["statut"]:
            detail = f"{x['statut']} → {statut}" + (f" ({detail})" if detail else "")
        journal(cur, u["id"], "emplacement modifié (marchés)", f"emplacement {x['numero']}", detail)
        return une_place(cur, pid)


@router.delete("/places/{pid}")
def supprimer_place(pid: int, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        cur.execute("SELECT numero, (SELECT count(*) FROM mar.perceptions x WHERE x.place = p.id)::int AS n FROM mar.places p WHERE id = %s", (pid,))
        x = cur.fetchone()
        if not x:
            raise HTTPException(404, "Emplacement introuvable.")
        if x["n"]:
            raise HTTPException(400, f"{x['n']} recette(s) sur cet emplacement : passez-le plutôt « Hors service ».")
        cur.execute("DELETE FROM mar.places WHERE id = %s", (pid,))
        journal(cur, u["id"], "emplacement supprimé (marchés)", f"emplacement {x['numero']}")
    return {"ok": True}


# ---------------------------------------------------------------- recettes
PERC_COLS = """x.id, x.numero, x.site, s.numero AS site_numero, s.nom AS site_nom, x.place, p.numero AS place_numero, x.nature, x.mois,
    x.nombre, x.montant_gnf::float, x.mode, x.payeur, x.observation, x.date_perception, x.statut, x.motif_annulation, x.annulee_le,
    x.cree_le, x.cree_par, a.nom AS collecteur, b.nom AS annulee_par_nom"""
PERC_FROM = """ FROM mar.perceptions x JOIN mar.sites s ON s.id = x.site LEFT JOIN mar.places p ON p.id = x.place
    LEFT JOIN app.utilisateurs a ON a.id = x.cree_par LEFT JOIN app.utilisateurs b ON b.id = x.annulee_par """


def une_perception(cur, xid: int) -> dict:
    cur.execute(f"SELECT {PERC_COLS} {PERC_FROM} WHERE x.id = %s", (xid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Quittance introuvable.")
    return iso(r, "mois", "date_perception", "annulee_le", "cree_le")


@router.get("/perceptions")
def lister_perceptions(site: int | None = None, du: dt.date | None = None, au: dt.date | None = None, u: dict = Depends(current_user)):
    exiger_gestion(u)
    du = du or dt.date.today() - dt.timedelta(days=30)
    au = au or dt.date.today()
    with cursor() as cur:
        cur.execute(f"""SELECT {PERC_COLS} {PERC_FROM}
                        WHERE x.date_perception BETWEEN %s AND %s AND (%s::int IS NULL OR x.site = %s)
                        ORDER BY x.date_perception DESC, x.id DESC LIMIT 2000""", (du, au, site, site))
        return [iso(r, "mois", "date_perception", "annulee_le", "cree_le") for r in cur.fetchall()]


@router.get("/perceptions/{xid}")
def lire_perception(xid: int, u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        return une_perception(cur, xid)


class PerceptionIn(BaseModel):
    site: int | None = None                     # sinon : site de l'emplacement
    place: int | None = None
    nature: str
    mois: str | None = Field(None, pattern=r"^\d{4}-\d{2}$")   # loyer : mois payé (AAAA-MM), mois en cours par défaut
    nombre: int | None = Field(None, gt=0, le=100000)
    montant_gnf: float | None = Field(None, gt=0, le=1e12)    # sinon : loyer de l'emplacement, ou nombre × tarif du site
    mode: str = "Espèces"
    payeur: str | None = Field(None, max_length=150)
    observation: str | None = Field(None, max_length=500)
    date_perception: dt.date | None = None
    uid: str | None = Field(None, pattern=r"^[0-9a-fA-F-]{36}$")


@router.post("/perceptions", status_code=201)
def encaisser(body: PerceptionIn, u: dict = Depends(current_user)):
    exiger_gestion(u)
    if body.nature not in NATURES or body.mode not in MODES:
        raise HTTPException(400, "Nature ou mode de paiement invalide.")
    jour = body.date_perception or dt.date.today()
    if jour > dt.date.today() or jour < dt.date.today() - dt.timedelta(days=62):
        raise HTTPException(400, "Date de perception : aujourd'hui ou dans les deux derniers mois.")
    with cursor() as cur:
        if body.uid:
            cur.execute("SELECT id FROM mar.perceptions WHERE uid = %s", (body.uid,))
            deja = cur.fetchone()
            if deja:
                return une_perception(cur, deja["id"])
        place = None
        if body.place:
            cur.execute("""SELECT p.id, p.numero, p.site, p.statut, p.loyer_gnf::float, p.occupant FROM mar.places p WHERE p.id = %s FOR UPDATE""",
                        (body.place,))
            place = cur.fetchone()
            if not place:
                raise HTTPException(404, "Emplacement introuvable.")
            if body.site and body.site != place["site"]:
                raise HTTPException(400, "L'emplacement n'est pas dans ce site.")
        site = place["site"] if place else body.site
        if not site:
            raise HTTPException(400, "Indiquez le site.")
        cur.execute("SELECT numero, nom, type, tarif_ticket_gnf::float AS tarif FROM mar.sites WHERE id = %s", (site,))
        s = cur.fetchone()
        if not s:
            raise HTTPException(404, "Site introuvable.")
        mois, montant, payeur = None, body.montant_gnf, body.payeur
        if body.nature == "Loyer mensuel":
            if not place:
                raise HTTPException(400, "Un loyer se rattache à un emplacement.")
            if place["statut"] != "Occupée":
                raise HTTPException(400, f"L'emplacement {place['numero']} n'est pas occupé.")
            mois = dt.date.fromisoformat(body.mois + "-01") if body.mois else premier_du_mois(jour)
            if mois > premier_du_mois() + dt.timedelta(days=366):
                raise HTTPException(400, "Mois trop éloigné.")
            cur.execute("""SELECT numero FROM mar.perceptions WHERE place = %s AND mois = %s AND nature = 'Loyer mensuel' AND statut = 'Valide'""",
                        (place["id"], mois))
            deja = cur.fetchone()
            if deja:
                raise HTTPException(409, f"Loyer de {mois:%m/%Y} déjà encaissé pour {place['numero']} : quittance {deja['numero']}.")
            montant = montant or place["loyer_gnf"]
            payeur = payeur or place["occupant"]
        elif body.nature in ("Tickets journaliers", "Droits de stationnement") and not montant:
            if not body.nombre or not s["tarif"]:
                raise HTTPException(400, "Indiquez le montant (ou le nombre, si le site a un tarif).")
            montant = body.nombre * s["tarif"]
        if not montant:
            raise HTTPException(400, "Indiquez le montant.")
        numero = numero_suivant(cur, "mar.perceptions", f"QM-{jour.year}", 5)
        cur.execute("""INSERT INTO mar.perceptions (numero, uid, site, place, nature, mois, nombre, montant_gnf, mode, payeur, observation,
                                                     date_perception, cree_par)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                    (numero, body.uid, site, place["id"] if place else None, body.nature, mois, body.nombre, montant, body.mode, payeur,
                     body.observation, jour, u["id"]))
        xid = cur.fetchone()["id"]
        journal(cur, u["id"], "recette encaissée (marchés)", f"quittance {numero}",
                f"{body.nature} — {gnf(montant)} — {s['numero']}" + (f" {place['numero']}" if place else "") + (f" ({mois:%m/%Y})" if mois else ""))
        return une_perception(cur, xid)


class Annulation(BaseModel):
    motif: str = Field(min_length=3, max_length=500)


@router.post("/perceptions/{xid}/annuler")
def annuler(xid: int, body: Annulation, u: dict = Depends(current_user)):
    """Une quittance ne se supprime pas : un superviseur l'annule en donnant le motif (erreur de saisie, double encaissement…)."""
    if u["role"] not in ("superviseur", "admin"):
        raise HTTPException(403, "Annulation réservée aux superviseurs.")
    with cursor() as cur:
        cur.execute("SELECT numero, statut, montant_gnf::float AS m FROM mar.perceptions WHERE id = %s FOR UPDATE", (xid,))
        x = cur.fetchone()
        if not x:
            raise HTTPException(404, "Quittance introuvable.")
        if x["statut"] == "Annulée":
            raise HTTPException(409, "Quittance déjà annulée.")
        cur.execute("""UPDATE mar.perceptions SET statut = 'Annulée', motif_annulation = %s, annulee_par = %s, annulee_le = now()
                       WHERE id = %s""", (body.motif.strip(), u["id"], xid))
        journal(cur, u["id"], "quittance annulée (marchés)", f"quittance {x['numero']}", f"{gnf(x['m'])} — {body.motif.strip()}")
        return une_perception(cur, xid)


# ---------------------------------------------------------------- impayés
def impayes(cur) -> list[dict]:
    """Emplacements occupés dont le loyer d'un mois échu n'est pas encaissé (mois en cours compté après le jour d'échéance)."""
    cur.execute("""
        WITH p AS (
            SELECT pl.id, pl.numero, pl.site, s.numero AS site_numero, s.nom AS site_nom, pl.type, pl.occupant, pl.telephone, pl.activite,
                   pl.loyer_gnf, date_trunc('month', COALESCE(pl.depuis, pl.cree_le::date))::timestamp AS debut
            FROM mar.places pl JOIN mar.sites s ON s.id = pl.site
            WHERE pl.statut = 'Occupée' AND pl.loyer_gnf > 0 AND s.etat <> 'Fermé'
        ), m AS (
            SELECT p.*, gs::date AS mois FROM p, generate_series(
                GREATEST(p.debut, date_trunc('month', now())::timestamp - make_interval(months => mar.param('mois_impayes_max')::int - 1)),
                date_trunc('month', now())::timestamp - CASE WHEN extract(day FROM now()) <= mar.param('jour_echeance')
                                                             THEN interval '1 month' ELSE interval '0' END,
                interval '1 month') gs
        )
        SELECT id, numero, site, site_numero, site_nom, type, occupant, telephone, activite, loyer_gnf::float,
               count(*)::int AS nb_mois, sum(loyer_gnf)::float AS du, array_agg(to_char(mois, 'YYYY-MM') ORDER BY mois) AS mois
        FROM m
        WHERE NOT EXISTS (SELECT 1 FROM mar.perceptions x WHERE x.place = m.id AND x.mois = m.mois
                                                            AND x.nature = 'Loyer mensuel' AND x.statut = 'Valide')
        GROUP BY id, numero, site, site_numero, site_nom, type, occupant, telephone, activite, loyer_gnf
        ORDER BY sum(loyer_gnf) DESC, numero""")
    return cur.fetchall()


@router.get("/impayes")
def lister_impayes(u: dict = Depends(current_user)):
    exiger_gestion(u)
    with cursor() as cur:
        return impayes(cur)


# ---------------------------------------------------------------- bilan
@router.get("/bilan")
def bilan(u: dict = Depends(current_user)):
    g = peut_gerer(u)
    with cursor() as cur:
        cur.execute("""SELECT s.id, s.numero, s.nom, s.type, s.etat, s.quartier,
                              count(p.id)::int AS places, count(p.id) FILTER (WHERE p.statut = 'Occupée')::int AS occupees,
                              count(p.id) FILTER (WHERE p.statut = 'Libre')::int AS libres,
                              count(p.id) FILTER (WHERE p.statut = 'Hors service')::int AS hors_service,
                              COALESCE(sum(p.loyer_gnf) FILTER (WHERE p.statut = 'Occupée'), 0)::float AS loyers_attendus
                       FROM mar.sites s LEFT JOIN mar.places p ON p.site = s.id GROUP BY s.id ORDER BY s.type, s.nom""")
        sites = cur.fetchall()
        cur.execute("SELECT type, count(*)::int AS n FROM mar.places GROUP BY 1 ORDER BY 2 DESC")
        types_place = cur.fetchall()
        res = {"sites": sites, "types_place": types_place, "peut_gerer": g}
        if not g:
            for s in sites:
                s.pop("loyers_attendus")
            return res
        cur.execute("""SELECT site, COALESCE(sum(montant_gnf) FILTER (WHERE date_perception >= date_trunc('month', current_date)), 0)::float AS mois,
                              COALESCE(sum(montant_gnf) FILTER (WHERE date_perception >= current_date - 364), 0)::float AS annee,
                              COALESCE(sum(nombre) FILTER (WHERE nature = 'Droits de stationnement' AND date_perception >= current_date - 29), 0)::int
                                  AS vehicules_30j
                       FROM mar.perceptions WHERE statut = 'Valide' GROUP BY site""")
        rec = {r["site"]: r for r in cur.fetchall()}
        imp = impayes(cur)
        du = {}
        for x in imp:
            du[x["site"]] = du.get(x["site"], 0) + x["du"]
        for s in sites:
            r = rec.get(s["id"], {})
            s.update({"recettes_mois": r.get("mois", 0), "recettes_annee": r.get("annee", 0), "vehicules_30j": r.get("vehicules_30j", 0),
                      "impayes": du.get(s["id"], 0)})
        cur.execute("""SELECT to_char(m, 'YYYY-MM') AS mois,
                              COALESCE((SELECT sum(montant_gnf) FROM mar.perceptions x WHERE x.statut = 'Valide'
                                        AND date_trunc('month', x.date_perception) = m), 0)::float AS n
                       FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m
                       ORDER BY m""")
        res["mois"] = cur.fetchall()
        cur.execute("""SELECT nature, count(*)::int AS n, sum(montant_gnf)::float AS montant FROM mar.perceptions
                       WHERE statut = 'Valide' AND date_perception >= current_date - 364 GROUP BY 1 ORDER BY 3 DESC""")
        res["natures"] = cur.fetchall()
        cur.execute("""SELECT COALESCE(a.nom, '—') AS collecteur, count(*)::int AS n, sum(x.montant_gnf)::float AS montant
                       FROM mar.perceptions x LEFT JOIN app.utilisateurs a ON a.id = x.cree_par
                       WHERE x.statut = 'Valide' AND x.date_perception >= date_trunc('month', current_date) GROUP BY 1 ORDER BY 3 DESC""")
        res["collecteurs"] = cur.fetchall()
        cur.execute("""SELECT COALESCE(sum(p.loyer_gnf), 0)::float AS attendus,
                              COALESCE((SELECT sum(x.montant_gnf) FROM mar.perceptions x WHERE x.nature = 'Loyer mensuel' AND x.statut = 'Valide'
                                        AND x.mois = date_trunc('month', current_date)::date), 0)::float AS payes
                       FROM mar.places p JOIN mar.sites s ON s.id = p.site WHERE p.statut = 'Occupée' AND s.etat <> 'Fermé'""")
        res["loyers_mois"] = cur.fetchone()
        cur.execute("SELECT count(*)::int AS n, COALESCE(sum(montant_gnf), 0)::float AS m FROM mar.perceptions WHERE statut = 'Annulée' "
                    "AND annulee_le >= now() - interval '30 days'")
        res["annulees_30j"] = cur.fetchone()
        res["impayes"] = {"places": len(imp), "montant": sum(x["du"] for x in imp)}
    return res


class Parametre(BaseModel):
    valeur: float = Field(ge=0, le=1000)


@router.put("/parametres/{cle}")
def modifier_parametre(cle: str, body: Parametre, u: dict = Depends(current_user)):
    exiger_gestion(u)
    if cle == "jour_echeance" and not 1 <= body.valeur <= 28:
        raise HTTPException(400, "Jour d'échéance : de 1 à 28.")
    if cle == "mois_impayes_max" and not 1 <= body.valeur <= 60:
        raise HTTPException(400, "De 1 à 60 mois.")
    with cursor() as cur:
        cur.execute("UPDATE mar.parametres SET valeur = %s WHERE cle = %s RETURNING cle", (body.valeur, cle))
        if not cur.fetchone():
            raise HTTPException(404, "Paramètre inconnu.")
        journal(cur, u["id"], "paramètre des marchés", cle, str(body.valeur))
    return {"ok": True}


# ---------------------------------------------------------------- exports
@router.get("/export/{quoi}.csv")
def exporter(quoi: str, du: dt.date | None = None, au: dt.date | None = None, u: dict = Depends(current_user)):
    with cursor() as cur:
        if quoi == "sites":
            cur.execute("""SELECT s.numero, s.type, s.nom, s.etat, s.gestion, s.jours, s.horaires, s.responsable, s.destinations, s.capacite,
                                  s.tarif_ticket_gnf::float AS tarif, s.quartier,
                                  (SELECT count(*) FROM mar.places p WHERE p.site = s.id)::int AS places,
                                  (SELECT count(*) FROM mar.places p WHERE p.site = s.id AND p.statut = 'Occupée')::int AS occupees,
                                  round(ST_X(ST_PointOnSurface(s.geom))::numeric, 6)::float AS lon,
                                  round(ST_Y(ST_PointOnSurface(s.geom))::numeric, 6)::float AS lat,
                                  s.observations FROM mar.sites s ORDER BY s.numero""")
            return csv_reponse(["Numéro", "Type", "Nom", "État", "Gestion", "Jours", "Horaires", "Responsable", "Destinations", "Capacité (véhicules)",
                                "Tarif ticket / stationnement (GNF)", "Quartier", "Emplacements", "Occupés", "Longitude", "Latitude", "Observations"],
                               cur.fetchall(), "marches_gares_labe.csv")
        exiger_gestion(u)
        if quoi == "places":
            cur.execute("""SELECT p.numero, s.nom AS site, p.type, p.surface_m2::float AS surface, p.loyer_gnf::float AS loyer, p.statut,
                                  p.occupant, p.telephone, p.activite, to_char(p.depuis, 'YYYY-MM-DD') AS depuis,
                                  (SELECT to_char(max(x.mois), 'YYYY-MM') FROM mar.perceptions x WHERE x.place = p.id AND x.nature = 'Loyer mensuel'
                                                                                                     AND x.statut = 'Valide') AS dernier,
                                  p.observations FROM mar.places p JOIN mar.sites s ON s.id = p.site ORDER BY p.numero""")
            return csv_reponse(["Numéro", "Site", "Type", "Surface (m²)", "Loyer mensuel (GNF)", "Statut", "Occupant", "Téléphone", "Activité",
                                "Depuis", "Dernier mois payé", "Observations"], cur.fetchall(), "emplacements_marches_labe.csv")
        if quoi == "perceptions":
            du = du or dt.date.today().replace(day=1)
            au = au or dt.date.today()
            cur.execute("""SELECT x.numero, to_char(x.date_perception, 'YYYY-MM-DD') AS jour, s.nom AS site, p.numero AS place, x.nature,
                                  to_char(x.mois, 'YYYY-MM') AS mois, x.nombre, x.montant_gnf::float AS montant, x.mode, x.payeur,
                                  a.nom AS collecteur, x.statut, x.motif_annulation, x.observation
                           FROM mar.perceptions x JOIN mar.sites s ON s.id = x.site LEFT JOIN mar.places p ON p.id = x.place
                           LEFT JOIN app.utilisateurs a ON a.id = x.cree_par
                           WHERE x.date_perception BETWEEN %s AND %s ORDER BY x.date_perception, x.numero""", (du, au))
            return csv_reponse(["Quittance", "Date", "Site", "Emplacement", "Nature", "Mois payé", "Nombre", "Montant (GNF)", "Mode", "Payeur",
                                "Collecteur", "Statut", "Motif d'annulation", "Observation"], cur.fetchall(),
                               f"recettes_marches_{du:%Y%m%d}_{au:%Y%m%d}.csv")
        if quoi == "impayes":
            rows = [{"n": x["numero"], "s": x["site_nom"], "o": x["occupant"], "t": x["telephone"], "a": x["activite"], "l": x["loyer_gnf"],
                     "m": x["nb_mois"], "d": x["du"], "ms": ", ".join(x["mois"])} for x in impayes(cur)]
            return csv_reponse(["Emplacement", "Site", "Occupant", "Téléphone", "Activité", "Loyer mensuel (GNF)", "Mois impayés", "Montant dû (GNF)",
                                "Mois"], rows, "impayes_marches_labe.csv")
    raise HTTPException(404, "Export inconnu.")


# ---------------------------------------------------------------- carte publique (sans compte)
def donnees_publiques(cur) -> dict:
    """Sites avec leurs jours, destinations et emplacements libres ; ni occupants, ni recettes, ni téléphones."""
    cur.execute("""SELECT json_build_object('type', 'FeatureCollection', 'features', COALESCE(json_agg(json_build_object(
                        'type', 'Feature', 'geometry', ST_AsGeoJSON(t.geom, 6)::json, 'properties', to_jsonb(t) - 'geom')), '[]'::json)) AS fc
                   FROM (SELECT s.numero, s.type, s.nom, s.etat, s.gestion, s.jours, s.horaires, s.destinations, s.capacite, s.quartier,
                                (SELECT count(*) FROM mar.places p WHERE p.site = s.id)::int AS places,
                                (SELECT count(*) FROM mar.places p WHERE p.site = s.id AND p.statut = 'Libre')::int AS libres, s.geom
                         FROM mar.sites s ORDER BY s.id) t""")
    return {"sites": cur.fetchone()["fc"]}


@router.get("/public")
def publiques():
    with cursor() as cur:
        return donnees_publiques(cur)
