"""
API — WebSIG Commune urbaine de Labé.

Rôles :
  - public       : pas de compte, lecture seule (carte publique, via GeoServer ou GitHub Pages)
  - agent        : saisit des contributions, modifie les siennes tant qu'elles ne sont pas validées
  - superviseur  : valide / rejette / modifie toutes les contributions
  - admin        : superviseur + gestion des comptes et journal d'activité

Les agents créent leur compte eux-mêmes ; un administrateur l'active.
"""
import base64
import hashlib
import json
import os
import secrets
import time
from contextlib import contextmanager
from pathlib import Path

import psycopg
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field

DSN = (f"host=db port=5432 dbname={os.environ['POSTGRES_DB']} "
       f"user={os.environ['POSTGRES_USER']} password={os.environ['POSTGRES_PASSWORD']}")

SERVICES = [
    "Secrétariat général", "Services techniques", "Urbanisme et domaines", "Voirie et assainissement",
    "Hygiène et salubrité", "État civil", "Finances et recettes", "Développement local",
    "Affaires sociales", "Police municipale", "Autre",
]
ROLES = ("agent", "superviseur", "admin")
STATUTS = {"À valider", "Validé", "Rejeté", "Traité"}
GEOM_TYPES = {"Point", "LineString", "Polygon"}
MAX_PHOTO = 1_000_000
SESSION_HOURS = 12
PBKDF2_ITER = 390_000

pool = ConnectionPool(DSN, min_size=1, max_size=8, open=False, kwargs={"row_factory": dict_row})
app = FastAPI(title="API WebSIG Labé", root_path="/api")


@contextmanager
def cursor():
    with pool.connection() as con, con.cursor() as cur:
        yield cur


# ---------------------------------------------------------------- mots de passe
def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, PBKDF2_ITER)
    return f"pbkdf2_sha256${PBKDF2_ITER}${base64.b64encode(salt).decode()}${base64.b64encode(h).decode()}"


def check_password(pw: str, stored: str) -> bool:
    try:
        _, it, salt, h = stored.split("$")
        calc = hashlib.pbkdf2_hmac("sha256", pw.encode(), base64.b64decode(salt), int(it))
        return secrets.compare_digest(calc, base64.b64decode(h))
    except (ValueError, TypeError):
        return False


def check_strength(pw: str):
    if len(pw) < 8 or pw.isdigit() or pw.isalpha():
        raise HTTPException(400, "Mot de passe trop faible : 8 caractères minimum, avec lettres et chiffres.")


# ---------------------------------------------------------------- démarrage
@app.on_event("startup")
def startup():
    pool.open(wait=True, timeout=60)
    with cursor() as cur:
        cur.execute((Path(__file__).parent / "schema.sql").read_text(encoding="utf-8"))
        adressage.apply_schema(cur)
        # Premier administrateur, défini dans .env
        cur.execute("SELECT 1 FROM app.utilisateurs WHERE role = 'admin' LIMIT 1")
        if not cur.fetchone():
            cur.execute("""
                INSERT INTO app.utilisateurs (nom, email, service, fonction, mot_de_passe, role, statut, active_le)
                VALUES ('Administrateur', %s, 'Secrétariat général', 'Administrateur SIG', %s, 'admin', 'actif', now())
                ON CONFLICT DO NOTHING""",
                (os.environ["APP_ADMIN_EMAIL"].strip().lower(), hash_password(os.environ["APP_ADMIN_PASSWORD"])))


def journal(cur, user_id, action, objet=None, detail=None):
    cur.execute("INSERT INTO app.journal (utilisateur, action, objet, detail) VALUES (%s, %s, %s, %s)",
                (user_id, action, objet, detail))


# ---------------------------------------------------------------- authentification
USER_COLS = "u.id, u.nom, u.email, u.service, u.fonction, u.telephone, u.role, u.statut, u.cree_le, u.derniere_connexion"


def current_user(authorization: str | None = Header(None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Connexion requise.")
    h = hashlib.sha256(authorization[7:].encode()).hexdigest()
    with cursor() as cur:
        cur.execute(f"""SELECT {USER_COLS} FROM app.sessions s JOIN app.utilisateurs u ON u.id = s.utilisateur
                        WHERE s.jeton_hash = %s AND s.expire_le > now() AND u.statut = 'actif'""", (h,))
        u = cur.fetchone()
    if not u:
        raise HTTPException(401, "Session expirée : reconnectez-vous.")
    return u


def superviseur(u: dict = Depends(current_user)) -> dict:
    if u["role"] not in ("superviseur", "admin"):
        raise HTTPException(403, "Réservé aux superviseurs et administrateurs.")
    return u


def admin(u: dict = Depends(current_user)) -> dict:
    if u["role"] != "admin":
        raise HTTPException(403, "Réservé aux administrateurs.")
    return u


def public_user(u: dict) -> dict:
    out = dict(u)
    for k in ("cree_le", "derniere_connexion"):
        if out.get(k):
            out[k] = out[k].isoformat(timespec="seconds")
    return out


class Inscription(BaseModel):
    nom: str = Field(min_length=3, max_length=100)
    email: str = Field(min_length=5, max_length=120, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    service: str
    fonction: str | None = Field(None, max_length=100)
    telephone: str | None = Field(None, max_length=30)
    mot_de_passe: str = Field(max_length=200)


class Connexion(BaseModel):
    email: str = Field(max_length=120)
    mot_de_passe: str = Field(max_length=200)


class ChangementMdp(BaseModel):
    ancien: str = Field(max_length=200)
    nouveau: str = Field(max_length=200)


# Limitation des tentatives de connexion (par adresse e-mail)
_echecs: dict[str, list[float]] = {}


def _trop_de_tentatives(email: str) -> bool:
    now = time.time()
    _echecs[email] = [t for t in _echecs.get(email, []) if now - t < 600]
    return len(_echecs[email]) >= 5


@app.get("/services")
def services():
    return SERVICES


@app.post("/auth/inscription", status_code=201)
def inscription(body: Inscription):
    if body.service not in SERVICES:
        raise HTTPException(400, "Service inconnu.")
    check_strength(body.mot_de_passe)
    email = body.email.strip().lower()
    with cursor() as cur:
        try:
            cur.execute("""INSERT INTO app.utilisateurs (nom, email, service, fonction, telephone, mot_de_passe)
                           VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
                        (body.nom.strip(), email, body.service, body.fonction, body.telephone,
                         hash_password(body.mot_de_passe)))
        except psycopg.errors.UniqueViolation:
            raise HTTPException(409, "Un compte existe déjà avec cette adresse e-mail.")
        uid = cur.fetchone()["id"]
        journal(cur, uid, "inscription", f"utilisateur {uid}", f"{body.nom} — {body.service}")
    return {"ok": True, "message": "Compte créé. Il sera utilisable après activation par un administrateur."}


@app.post("/auth/connexion")
def connexion(body: Connexion):
    email = body.email.strip().lower()
    if _trop_de_tentatives(email):
        raise HTTPException(429, "Trop de tentatives. Réessayez dans 10 minutes.")
    with cursor() as cur:
        cur.execute("SELECT * FROM app.utilisateurs WHERE lower(email) = %s", (email,))
        u = cur.fetchone()
        if not u or not check_password(body.mot_de_passe, u["mot_de_passe"]):
            _echecs[email].append(time.time())
            raise HTTPException(401, "E-mail ou mot de passe incorrect.")
        if u["statut"] == "en_attente":
            raise HTTPException(403, "Votre compte est en attente d'activation par un administrateur.")
        if u["statut"] != "actif":
            raise HTTPException(403, "Votre compte est désactivé. Contactez l'administrateur.")
        _echecs.pop(email, None)
        token = secrets.token_urlsafe(32)
        cur.execute("DELETE FROM app.sessions WHERE expire_le < now()")
        cur.execute("""INSERT INTO app.sessions (jeton_hash, utilisateur, expire_le)
                       VALUES (%s, %s, now() + make_interval(hours => %s))""",
                    (hashlib.sha256(token.encode()).hexdigest(), u["id"], SESSION_HOURS))
        cur.execute("UPDATE app.utilisateurs SET derniere_connexion = now() WHERE id = %s", (u["id"],))
        journal(cur, u["id"], "connexion")
        cur.execute(f"SELECT {USER_COLS} FROM app.utilisateurs u WHERE id = %s", (u["id"],))
        return {"jeton": token, "utilisateur": public_user(cur.fetchone())}


@app.post("/auth/deconnexion")
def deconnexion(authorization: str | None = Header(None)):
    if authorization and authorization.startswith("Bearer "):
        with cursor() as cur:
            cur.execute("DELETE FROM app.sessions WHERE jeton_hash = %s",
                        (hashlib.sha256(authorization[7:].encode()).hexdigest(),))
    return {"ok": True}


@app.get("/auth/moi")
def moi(u: dict = Depends(current_user)):
    return public_user(u)


@app.put("/auth/mot-de-passe")
def changer_mdp(body: ChangementMdp, u: dict = Depends(current_user)):
    check_strength(body.nouveau)
    with cursor() as cur:
        cur.execute("SELECT mot_de_passe FROM app.utilisateurs WHERE id = %s", (u["id"],))
        if not check_password(body.ancien, cur.fetchone()["mot_de_passe"]):
            raise HTTPException(400, "Mot de passe actuel incorrect.")
        cur.execute("UPDATE app.utilisateurs SET mot_de_passe = %s WHERE id = %s", (hash_password(body.nouveau), u["id"]))
        journal(cur, u["id"], "changement de mot de passe")
    return {"ok": True}


# ---------------------------------------------------------------- administration des comptes
class MajUtilisateur(BaseModel):
    role: str | None = None
    statut: str | None = None
    service: str | None = None
    fonction: str | None = Field(None, max_length=100)


@app.get("/admin/utilisateurs")
def lister_utilisateurs(u: dict = Depends(admin)):
    with cursor() as cur:
        cur.execute(f"""SELECT {USER_COLS},
                          (SELECT count(*) FROM contrib.contributions c WHERE c.cree_par = u.id)::int AS nb_contributions
                        FROM app.utilisateurs u
                        ORDER BY (u.statut = 'en_attente') DESC, u.nom""")
        return [public_user(r) for r in cur.fetchall()]


@app.put("/admin/utilisateurs/{uid}")
def maj_utilisateur(uid: int, body: MajUtilisateur, u: dict = Depends(admin)):
    d = body.model_dump(exclude_unset=True)
    if uid == u["id"] and ("role" in d or "statut" in d):
        raise HTTPException(400, "Vous ne pouvez pas modifier votre propre rôle ou statut.")
    if "role" in d and d["role"] not in ROLES:
        raise HTTPException(400, "Rôle invalide.")
    if "statut" in d and d["statut"] not in ("en_attente", "actif", "desactive"):
        raise HTTPException(400, "Statut invalide.")
    if "service" in d and d["service"] not in SERVICES:
        raise HTTPException(400, "Service inconnu.")
    if not d:
        raise HTTPException(400, "Rien à modifier.")
    sets = [f"{k} = %s" for k in d]
    vals = list(d.values())
    if d.get("statut") == "actif":
        sets += ["active_le = COALESCE(active_le, now())", "active_par = COALESCE(active_par, %s)"]
        vals.append(u["id"])
    with cursor() as cur:
        cur.execute(f"UPDATE app.utilisateurs SET {', '.join(sets)} WHERE id = %s RETURNING nom", vals + [uid])
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Utilisateur introuvable.")
        if d.get("statut") == "desactive":
            cur.execute("DELETE FROM app.sessions WHERE utilisateur = %s", (uid,))
        journal(cur, u["id"], "modification du compte", f"utilisateur {uid}",
                f"{r['nom']} : " + ", ".join(f"{k} = {v}" for k, v in d.items()))
    return {"ok": True}


@app.post("/admin/utilisateurs/{uid}/reinitialiser")
def reinitialiser_mdp(uid: int, u: dict = Depends(admin)):
    temp = secrets.token_urlsafe(6) + "7a"
    with cursor() as cur:
        cur.execute("UPDATE app.utilisateurs SET mot_de_passe = %s WHERE id = %s RETURNING nom", (hash_password(temp), uid))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Utilisateur introuvable.")
        cur.execute("DELETE FROM app.sessions WHERE utilisateur = %s", (uid,))
        journal(cur, u["id"], "réinitialisation du mot de passe", f"utilisateur {uid}", r["nom"])
    return {"mot_de_passe_temporaire": temp}


@app.get("/admin/journal")
def lire_journal(limite: int = 200, u: dict = Depends(admin)):
    with cursor() as cur:
        cur.execute("""SELECT j.id, j.date, j.action, j.objet, j.detail, u.nom AS utilisateur
                       FROM app.journal j LEFT JOIN app.utilisateurs u ON u.id = j.utilisateur
                       ORDER BY j.date DESC LIMIT %s""", (min(max(limite, 1), 1000),))
        rows = cur.fetchall()
    for r in rows:
        r["date"] = r["date"].isoformat(timespec="seconds")
    return rows


@app.get("/admin/tableau-de-bord")
def tableau_de_bord(u: dict = Depends(superviseur)):
    with cursor() as cur:
        cur.execute("SELECT statut, count(*)::int AS n FROM app.utilisateurs GROUP BY statut")
        comptes = {r["statut"]: r["n"] for r in cur.fetchall()}
        cur.execute("SELECT statut, count(*)::int AS n FROM contrib.contributions GROUP BY statut")
        contrib = {r["statut"]: r["n"] for r in cur.fetchall()}
        cur.execute("""SELECT COALESCE(service, '—') AS service, count(*)::int AS n FROM contrib.contributions
                       GROUP BY 1 ORDER BY n DESC""")
        par_service = cur.fetchall()
        cur.execute("""SELECT categorie, count(*)::int AS n FROM contrib.contributions
                       GROUP BY 1 ORDER BY n DESC""")
        par_categorie = cur.fetchall()
        cur.execute("""SELECT to_char(d, 'YYYY-MM-DD') AS jour, count(c.id)::int AS n
                       FROM generate_series(current_date - 29, current_date, interval '1 day') d
                       LEFT JOIN contrib.contributions c ON c.cree_le::date = d::date
                       GROUP BY d ORDER BY d""")
        par_jour = cur.fetchall()
    return {"comptes": comptes, "contributions": contrib, "par_service": par_service,
            "par_categorie": par_categorie, "par_jour": par_jour}


# ---------------------------------------------------------------- contributions
class Props(BaseModel):
    categorie: str | None = Field(None, max_length=60)
    type: str | None = Field(None, max_length=80)
    nom: str | None = Field(None, max_length=150)
    description: str | None = Field(None, max_length=2000)
    quartier: str | None = Field(None, max_length=80)
    statut: str | None = None
    motif_rejet: str | None = Field(None, max_length=500)
    photo: str | None = None  # data:image/jpeg;base64,...  ("" pour supprimer)


class FeatureIn(BaseModel):
    geometry: dict | None = None
    properties: Props


def decode_photo(data: str | None) -> bytes | None:
    if not data:
        return None
    prefix = "data:image/jpeg;base64,"
    if not data.startswith(prefix):
        raise HTTPException(400, "Photo invalide (JPEG attendu).")
    try:
        raw = base64.b64decode(data[len(prefix):], validate=True)
    except ValueError:
        raise HTTPException(400, "Photo illisible.")
    if len(raw) > MAX_PHOTO or not raw.startswith(b"\xff\xd8"):
        raise HTTPException(400, "Photo invalide ou trop lourde (1 Mo maximum).")
    return raw


def check_geometry(cur, geometry: dict | None) -> str:
    if not isinstance(geometry, dict) or geometry.get("type") not in GEOM_TYPES:
        raise HTTPException(400, "Géométrie invalide : Point, LineString ou Polygon attendu.")
    gj = json.dumps({"type": geometry["type"], "coordinates": geometry.get("coordinates")})
    try:
        cur.execute("""
            SELECT ST_IsValid(g) AS valide, ST_NPoints(g) AS n,
                   EXISTS (SELECT 1 FROM ref.limite_commune c
                           WHERE ST_DWithin(c.geom::geography, g::geography, 2000)) AS dans_commune
            FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326) AS g) t""", (gj,))
    except psycopg.Error:
        cur.connection.rollback()
        raise HTTPException(400, "Géométrie illisible.")
    r = cur.fetchone()
    if not r["valide"]:
        raise HTTPException(400, "Géométrie invalide (surface qui se recoupe ?).")
    if r["n"] > 5000:
        raise HTTPException(400, "Géométrie trop complexe (5000 sommets maximum).")
    if not r["dans_commune"]:
        raise HTTPException(400, "L'objet est en dehors de la commune de Labé.")
    return gj


SELECT_FEATURE = """
    SELECT c.id, c.categorie, c.type, c.nom, c.description, c.quartier, c.statut, c.motif_rejet, c.service,
           c.cree_le, c.modifie_le, c.valide_le, c.cree_par,
           COALESCE(a.nom, c.auteur) AS auteur, v.nom AS valide_par_nom,
           (c.photo IS NOT NULL) AS a_photo,
           ST_AsGeoJSON(c.geom, 7)::json AS geometry
    FROM contrib.contributions c
    LEFT JOIN app.utilisateurs a ON a.id = c.cree_par
    LEFT JOIN app.utilisateurs v ON v.id = c.valide_par
"""


def to_feature(r: dict) -> dict:
    geom = r.pop("geometry")
    for k in ("cree_le", "modifie_le", "valide_le"):
        if r.get(k):
            r[k] = r[k].isoformat(timespec="seconds")
    r["photo_url"] = f"/api/contributions/{r['id']}/photo" if r.pop("a_photo") else None
    return {"type": "Feature", "id": r["id"], "geometry": geom, "properties": r}


def fetch_one(cur, cid: int) -> dict:
    cur.execute(SELECT_FEATURE + " WHERE c.id = %s", (cid,))
    r = cur.fetchone()
    if not r:
        raise HTTPException(404, "Contribution introuvable.")
    return to_feature(r)


def can_edit(u: dict, row: dict) -> bool:
    """Superviseur/admin : tout. Agent : ses propres saisies non encore validées."""
    if u["role"] in ("superviseur", "admin"):
        return True
    return row["cree_par"] == u["id"] and row["statut"] in ("À valider", "Rejeté")


@app.get("/contributions")
def lister(u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute(SELECT_FEATURE + " ORDER BY c.id DESC")
        return {"type": "FeatureCollection", "features": [to_feature(r) for r in cur.fetchall()]}


@app.get("/contributions/{cid}/photo")
def photo(cid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT photo FROM contrib.contributions WHERE id = %s", (cid,))
        r = cur.fetchone()
    if not r or not r["photo"]:
        raise HTTPException(404, "Pas de photo.")
    return Response(bytes(r["photo"]), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


@app.post("/contributions", status_code=201)
def creer(body: FeatureIn, u: dict = Depends(current_user)):
    p = body.properties
    if not p.categorie:
        raise HTTPException(400, "La catégorie est obligatoire.")
    validateur = u["role"] in ("superviseur", "admin")
    statut = p.statut if validateur and p.statut in STATUTS else "À valider"
    with cursor() as cur:
        gj = check_geometry(cur, body.geometry)
        cur.execute("""
            INSERT INTO contrib.contributions
                (categorie, type, nom, description, quartier, statut, photo, geom, cree_par, service, auteur,
                 valide_par, valide_le)
            VALUES (%s, %s, %s, %s, NULLIF(%s, ''), %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s, %s, %s,
                    %s, CASE WHEN %s THEN now() END)
            RETURNING id""",
            (p.categorie, p.type, p.nom, p.description, p.quartier, statut, decode_photo(p.photo), gj,
             u["id"], u["service"], u["nom"],
             u["id"] if statut != "À valider" else None, statut != "À valider"))
        cid = cur.fetchone()["id"]
        journal(cur, u["id"], "ajout", f"contribution {cid}", f"{p.categorie} / {p.type or ''} {p.nom or ''}".strip())
        return fetch_one(cur, cid)


@app.put("/contributions/{cid}")
def modifier(cid: int, body: FeatureIn, u: dict = Depends(current_user)):
    p = body.properties.model_dump(exclude_unset=True)
    validateur = u["role"] in ("superviseur", "admin")
    with cursor() as cur:
        cur.execute("SELECT cree_par, statut FROM contrib.contributions WHERE id = %s FOR UPDATE", (cid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Contribution introuvable.")
        if not can_edit(u, row):
            raise HTTPException(403, "Vous ne pouvez modifier que vos propres saisies non validées.")
        sets, vals = [], []
        for k in ("categorie", "type", "nom", "description", "quartier"):
            if k in p:
                sets.append(f"{k} = %s")
                vals.append(p[k])
        if "photo" in p:
            sets.append("photo = %s")
            vals.append(decode_photo(p["photo"]))
        if body.geometry:
            sets.append("geom = ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326)")
            vals.append(check_geometry(cur, body.geometry))
        action = "modification"
        if "statut" in p and p["statut"] != row["statut"]:
            if not validateur:
                raise HTTPException(403, "Seul un superviseur peut changer le statut.")
            if p["statut"] not in STATUTS:
                raise HTTPException(400, "Statut invalide.")
            sets += ["statut = %s", "valide_par = %s", "valide_le = now()", "motif_rejet = %s"]
            vals += [p["statut"], u["id"], p.get("motif_rejet") if p["statut"] == "Rejeté" else None]
            action = {"Validé": "validation", "Rejeté": "rejet", "Traité": "traitement", "À valider": "remise en attente"}[p["statut"]]
        elif not validateur and row["statut"] == "Rejeté" and sets:
            # un agent corrige une saisie rejetée : elle repart en validation
            sets += ["statut = 'À valider'", "motif_rejet = NULL"]
        if not sets:
            raise HTTPException(400, "Rien à modifier.")
        sets += ["modifie_le = now()", "modifie_par = %s"]
        vals.append(u["nom"])
        cur.execute(f"UPDATE contrib.contributions SET {', '.join(sets)} WHERE id = %s", vals + [cid])
        journal(cur, u["id"], action, f"contribution {cid}", p.get("motif_rejet") if action == "rejet" else None)
        return fetch_one(cur, cid)


@app.delete("/contributions/{cid}")
def supprimer(cid: int, u: dict = Depends(current_user)):
    with cursor() as cur:
        cur.execute("SELECT cree_par, statut, categorie, nom FROM contrib.contributions WHERE id = %s", (cid,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(404, "Contribution introuvable.")
        if not can_edit(u, row):
            raise HTTPException(403, "Vous ne pouvez supprimer que vos propres saisies non validées.")
        cur.execute("DELETE FROM contrib.contributions WHERE id = %s", (cid,))
        journal(cur, u["id"], "suppression", f"contribution {cid}", f"{row['categorie']} {row['nom'] or ''}".strip())
    return {"ok": True}


# ---------------------------------------------------------------- public
@app.get("/sante")
def sante():
    with cursor() as cur:
        cur.execute("SELECT to_regclass('ref.quartiers') IS NOT NULL AS ok")
        return {"base": "ok", "donnees_reference": cur.fetchone()["ok"]}


def compute_stats(cur) -> dict:
    cur.execute("SELECT nature, count(*)::int AS n FROM ref.batiments GROUP BY nature ORDER BY n DESC")
    bati = {r["nature"]: r["n"] for r in cur.fetchall()}
    cur.execute("""SELECT nature, round(sum(ST_Length(geom::geography))::numeric / 1000, 2)::float AS km
                   FROM ref.routes GROUP BY nature""")
    routes = {r["nature"]: r["km"] for r in cur.fetchall()}
    cur.execute("SELECT round((ST_Area(geom::geography) / 1e6)::numeric, 2)::float AS km2 FROM ref.limite_commune LIMIT 1")
    superficie = cur.fetchone()["km2"]
    cur.execute("""SELECT categorie, count(*)::int AS n FROM contrib.contributions
                   WHERE statut IN ('Validé', 'Traité') GROUP BY categorie ORDER BY n DESC""")
    contrib = {r["categorie"]: r["n"] for r in cur.fetchall()}
    return {"superficie_km2": superficie, "batiments": bati, "routes_km": routes, "contributions_publiees": contrib}


@app.get("/stats")
def stats():
    with cursor() as cur:
        return compute_stats(cur)


# ---------------------------------------------------------------- modules
import adressage  # noqa: E402  (importé après les définitions partagées ci-dessus)

app.include_router(adressage.router)
