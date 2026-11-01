"""
Foncier (suite) : tableau de bord du foncier et fiscalité locale.

Fiscalité : estimation indicative du montant dû par parcelle (terrain + emprise bâtie, selon la zone du quartier et
l'usage), rôle prévisionnel, saisie des paiements et taux de recouvrement. Le barème est un exemple à faire fixer par le
service des finances selon la loi de finances en vigueur : il ne vaut pas avis d'imposition.
"""
import csv
import datetime as dt
import io

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from foncier import est_superviseur, iso, lire_parcelle, peut_instruire
from main import admin, current_user, cursor, journal

router = APIRouter(prefix="/foncier")

SERVICE_FINANCES = "Finances et recettes"
MODES = ["Espèces", "Mobile money", "Virement", "Chèque"]


def acces_fiscal(u: dict) -> bool:
    return peut_instruire(u) or u["service"] == SERVICE_FINANCES


def exiger_fiscal(u: dict):
    if not acces_fiscal(u):
        raise HTTPException(403, f"Fiscalité : réservée aux services {SERVICE_FINANCES}, Urbanisme et domaines, et aux superviseurs.")


def peut_encaisser(u: dict) -> bool:
    return est_superviseur(u) or u["service"] == SERVICE_FINANCES


# ---------------------------------------------------------------- barème
@router.get("/fiscalite/bareme")
def bareme(u: dict = Depends(current_user)):
    exiger_fiscal(u)
    with cursor() as cur:
        cur.execute("SELECT zone, libelle, terrain_m2::float, bati_m2::float, minimum::float FROM fon.bareme ORDER BY zone")
        b = cur.fetchall()
        cur.execute("SELECT quartier, zone FROM fon.zones_fiscales ORDER BY quartier")
        z = cur.fetchall()
        cur.execute("SELECT usage, coef::float, exonere FROM fon.coef_usage ORDER BY usage")
        c = cur.fetchall()
        a_valider = cur.execute("SELECT fon.param('bareme_a_valider', 1) = 1 AS v").fetchone()["v"]
    return {"bareme": b, "zones": z, "coefs": c, "a_valider": a_valider, "peut_modifier": u["role"] == "admin",
            "peut_encaisser": peut_encaisser(u), "modes": MODES}


class BaremeIn(BaseModel):
    libelle: str | None = Field(None, max_length=100)
    terrain_m2: float | None = Field(None, ge=0, le=1e7)
    bati_m2: float | None = Field(None, ge=0, le=1e7)
    minimum: float | None = Field(None, ge=0, le=1e9)


@router.put("/fiscalite/bareme/{zone}")
def maj_bareme(zone: str, body: BaremeIn, u: dict = Depends(admin)):
    d = body.model_dump(exclude_unset=True)
    if not d:
        raise HTTPException(400, "Rien à modifier.")
    with cursor() as cur:
        cur.execute(f"UPDATE fon.bareme SET {', '.join(f'{k} = %s' for k in d)} WHERE zone = %s RETURNING zone",
                    list(d.values()) + [zone])
        if not cur.fetchone():
            raise HTTPException(404, "Zone inconnue.")
        journal(cur, u["id"], "barème fiscal", f"zone {zone}", ", ".join(f"{k} = {v}" for k, v in d.items()))
    return {"ok": True}


@router.put("/fiscalite/zones/{quartier}")
def maj_zone(quartier: str, body: dict, u: dict = Depends(admin)):
    if body.get("zone") not in ("A", "B", "C"):
        raise HTTPException(400, "Zone A, B ou C attendue.")
    with cursor() as cur:
        cur.execute("""INSERT INTO fon.zones_fiscales (quartier, zone) VALUES (%s, %s)
                       ON CONFLICT (quartier) DO UPDATE SET zone = EXCLUDED.zone""", (quartier, body["zone"]))
        journal(cur, u["id"], "zone fiscale", quartier, body["zone"])
    return {"ok": True}


@router.put("/fiscalite/coefs/{usage}")
def maj_coef(usage: str, body: dict, u: dict = Depends(admin)):
    try:
        coef = float(body.get("coef"))
    except (TypeError, ValueError):
        raise HTTPException(400, "Coefficient numérique attendu.")
    if not 0 <= coef <= 20:
        raise HTTPException(400, "Coefficient hors limites.")
    with cursor() as cur:
        cur.execute("UPDATE fon.coef_usage SET coef = %s, exonere = %s WHERE usage = %s RETURNING usage",
                    (coef, bool(body.get("exonere")), usage))
        if not cur.fetchone():
            raise HTTPException(404, "Usage inconnu.")
        journal(cur, u["id"], "coefficient fiscal", usage, f"{coef} exonéré={bool(body.get('exonere'))}")
    return {"ok": True}


@router.post("/fiscalite/valider-bareme")
def valider_bareme(body: dict, u: dict = Depends(admin)):
    with cursor() as cur:
        cur.execute("UPDATE fon.parametres SET valeur = %s WHERE cle = 'bareme_a_valider'", (0 if body.get("valide", True) else 1,))
        journal(cur, u["id"], "validation du barème fiscal", None, body.get("reference"))
    return {"ok": True}


# ---------------------------------------------------------------- rôle prévisionnel et recouvrement
ROLE_SQL = """
    SELECT a.id, a.numero, a.quartier, a.usage, a.statut_juridique, a.superficie_m2, a.bati_m2, a.zone, a.coef, a.exonere,
           a.montant, COALESCE(pa.paye, 0)::float AS paye, GREATEST(a.montant - COALESCE(pa.paye, 0), 0)::float AS reste
    FROM fon.assiette a
    LEFT JOIN (SELECT parcelle, sum(montant) AS paye FROM fon.paiements WHERE annee = %s GROUP BY parcelle) pa ON pa.parcelle = a.id
"""


def annee_ou_courante(annee: int | None) -> int:
    return annee or dt.date.today().year


@router.get("/fiscalite/role")
def role(annee: int | None = None, u: dict = Depends(current_user)):
    exiger_fiscal(u)
    annee = annee_ou_courante(annee)
    with cursor() as cur:
        cur.execute(ROLE_SQL + " ORDER BY a.numero", (annee,))
        rows = cur.fetchall()
        a_valider = cur.execute("SELECT fon.param('bareme_a_valider', 1) = 1 AS v").fetchone()["v"]
    q: dict[str, dict] = {}
    for r in rows:
        x = q.setdefault(r["quartier"] or "—", {"quartier": r["quartier"] or "—", "parcelles": 0, "imposables": 0, "emis": 0.0, "paye": 0.0})
        x["parcelles"] += 1
        x["imposables"] += 0 if r["exonere"] else 1
        x["emis"] += r["montant"]
        x["paye"] += min(r["paye"], r["montant"]) if r["montant"] else 0
    emis = sum(r["montant"] for r in rows)
    paye = sum(min(r["paye"], r["montant"]) for r in rows if r["montant"])
    return {"annee": annee, "a_valider": a_valider, "parcelles": rows, "quartiers": sorted(q.values(), key=lambda x: x["quartier"]),
            "total": {"parcelles": len(rows), "imposables": sum(1 for r in rows if not r["exonere"]), "emis": emis, "paye": paye,
                      "taux": round(100 * paye / emis, 1) if emis else None}}


@router.get("/fiscalite/role.csv")
def role_csv(annee: int | None = None, u: dict = Depends(current_user)):
    r = role(annee, u)
    buf = io.StringIO()
    buf.write("﻿")
    w = csv.writer(buf, delimiter=";")
    w.writerow([f"Rôle prévisionnel {r['annee']} — estimation indicative" + (" (barème d'exemple, non validé)" if r["a_valider"] else "")])
    w.writerow(["Numéro", "Quartier", "Zone", "Usage", "Statut juridique", "Superficie (m²)", "Emprise bâtie (m²)", "Coefficient",
                "Exonérée", "Montant estimé (GNF)", "Payé (GNF)", "Reste (GNF)"])
    for p in r["parcelles"]:
        w.writerow([p["numero"], p["quartier"], p["zone"], p["usage"], p["statut_juridique"], str(p["superficie_m2"]).replace(".", ","),
                    str(p["bati_m2"]).replace(".", ","), str(p["coef"]).replace(".", ","), "oui" if p["exonere"] else "non",
                    int(p["montant"]), int(p["paye"]), int(p["reste"])])
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename=role_foncier_{r['annee']}.csv"})


@router.get("/parcelles/{pid}/fiscalite")
def fiscalite_parcelle(pid: int, annee: int | None = None, u: dict = Depends(current_user)):
    exiger_fiscal(u)
    annee = annee_ou_courante(annee)
    with cursor() as cur:
        cur.execute(ROLE_SQL + " WHERE a.id = %s", (annee, pid))
        a = cur.fetchone()
        cur.execute("""SELECT p.id, p.annee, p.montant::float, p.paye_le, p.quittance, p.mode, p.observations, u.nom AS saisi_par
                       FROM fon.paiements p LEFT JOIN app.utilisateurs u ON u.id = p.saisi_par
                       WHERE p.parcelle = %s ORDER BY p.annee DESC, p.paye_le DESC""", (pid,))
        paiements = [iso(r, "paye_le") for r in cur.fetchall()]
        a_valider = cur.execute("SELECT fon.param('bareme_a_valider', 1) = 1 AS v").fetchone()["v"]
    return {"annee": annee, "assiette": a, "paiements": paiements, "a_valider": a_valider, "peut_encaisser": peut_encaisser(u),
            "modes": MODES}


class PaiementIn(BaseModel):
    parcelle: int
    annee: int = Field(ge=2000, le=2100)
    montant: float = Field(gt=0, le=1e11)
    paye_le: dt.date | None = None
    quittance: str | None = Field(None, max_length=60)
    mode: str = "Espèces"
    observations: str | None = Field(None, max_length=500)


@router.post("/paiements", status_code=201)
def enregistrer_paiement(body: PaiementIn, u: dict = Depends(current_user)):
    if not peut_encaisser(u):
        raise HTTPException(403, f"Enregistrement des paiements : service {SERVICE_FINANCES} et superviseurs.")
    if body.mode not in MODES:
        raise HTTPException(400, "Mode de paiement inconnu.")
    with cursor() as cur:
        p = lire_parcelle(cur, body.parcelle)
        if body.quittance:
            cur.execute("SELECT 1 FROM fon.paiements WHERE quittance = %s AND annee = %s", (body.quittance, body.annee))
            if cur.fetchone():
                raise HTTPException(409, f"La quittance {body.quittance} est déjà enregistrée pour {body.annee}.")
        cur.execute("""INSERT INTO fon.paiements (parcelle, annee, montant, paye_le, quittance, mode, observations, saisi_par)
                       VALUES (%s, %s, %s, COALESCE(%s, current_date), %s, %s, %s, %s) RETURNING id""",
                    (body.parcelle, body.annee, round(body.montant), body.paye_le, body.quittance, body.mode, body.observations, u["id"]))
        pid = cur.fetchone()["id"]
        journal(cur, u["id"], "paiement foncier", f"parcelle {body.parcelle}", f"{p['numero']} {body.annee} : {round(body.montant)} GNF")
    return {"id": pid}


@router.delete("/paiements/{pid}")
def annuler_paiement(pid: int, u: dict = Depends(current_user)):
    if not est_superviseur(u):
        raise HTTPException(403, "Annulation d'un paiement réservée aux superviseurs.")
    with cursor() as cur:
        cur.execute("DELETE FROM fon.paiements WHERE id = %s RETURNING parcelle, annee, montant", (pid,))
        r = cur.fetchone()
        if not r:
            raise HTTPException(404, "Paiement introuvable.")
        journal(cur, u["id"], "annulation de paiement foncier", f"parcelle {r['parcelle']}", f"{r['annee']} : {r['montant']} GNF")
    return {"ok": True}


# ---------------------------------------------------------------- tableau de bord du foncier
@router.get("/bilan")
def bilan(u: dict = Depends(current_user)):
    with cursor() as cur:
        def q(sql, *args):
            cur.execute(sql, args)
            return cur.fetchall()
        res = {
            "par_statut": q("""SELECT statut_juridique AS k, count(*)::int AS n, round(sum(superficie_m2) / 10000, 2)::float AS ha
                               FROM fon.parcelles WHERE etat <> 'Archivée' GROUP BY 1 ORDER BY n DESC"""),
            "par_usage": q("""SELECT usage AS k, count(*)::int AS n FROM fon.parcelles WHERE etat <> 'Archivée' GROUP BY 1 ORDER BY n DESC"""),
            "par_etat": q("""SELECT etat AS k, count(*)::int AS n FROM fon.parcelles GROUP BY 1"""),
            "dossiers_type": q("""SELECT type AS k, count(*)::int AS n,
                                         count(*) FILTER (WHERE statut NOT IN ('Approuvé', 'Rejeté', 'Abandonné'))::int AS ouverts,
                                         count(*) FILTER (WHERE statut = 'Approuvé')::int AS approuves,
                                         count(*) FILTER (WHERE statut = 'Rejeté')::int AS rejetes,
                                         round(avg(extract(epoch FROM decide_le - depose_le) / 86400)
                                               FILTER (WHERE decide_le IS NOT NULL)::numeric, 1)::float AS delai_j
                                  FROM fon.dossiers GROUP BY 1 ORDER BY n DESC"""),
            "mois": q("""SELECT to_char(m, 'YYYY-MM') AS mois,
                                (SELECT count(*) FROM fon.dossiers d WHERE date_trunc('month', d.depose_le) = m)::int AS deposes,
                                (SELECT count(*) FROM fon.dossiers d WHERE date_trunc('month', d.decide_le) = m
                                   AND d.statut IN ('Approuvé', 'Rejeté'))::int AS decides,
                                (SELECT count(*) FROM fon.parcelles p WHERE date_trunc('month', p.cree_le) = m)::int AS recensees,
                                (SELECT count(*) FROM fon.fiches f WHERE date_trunc('month', f.delivre_le) = m)::int AS fiches
                         FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()),
                                              interval '1 month') m ORDER BY m"""),
            "litiges_statut": q("""SELECT statut AS k, count(*)::int AS n FROM fon.litiges GROUP BY 1"""),
            "litiges_type": q("""SELECT type AS k, count(*)::int AS n,
                                        count(*) FILTER (WHERE statut IN ('Signalé', 'En médiation', 'Transmis au tribunal'))::int AS ouverts
                                 FROM fon.litiges GROUP BY 1 ORDER BY n DESC"""),
            "litiges_quartier": q("""SELECT COALESCE(quartier, '—') AS k, count(*)::int AS n FROM fon.litiges
                                     WHERE statut IN ('Signalé', 'En médiation', 'Transmis au tribunal') GROUP BY 1 ORDER BY n DESC"""),
            "fiches": q("""SELECT count(*)::int AS n, count(*) FILTER (WHERE delivre_le > now() - interval '30 days')::int AS n30
                           FROM fon.fiches""")[0],
            "couverture": q("""SELECT (SELECT count(*) FROM adr.batiments_points)::int AS batiments,
                                      (SELECT count(*) FROM adr.batiments_points b WHERE EXISTS (SELECT 1 FROM fon.parcelles p
                                          WHERE p.etat <> 'Archivée' AND ST_Contains(p.geom_m, b.p)))::int AS couverts""")[0],
        }
        res["acces_fiscal"] = acces_fiscal(u)
        if res["acces_fiscal"]:
            annee = dt.date.today().year
            cur.execute(f"""SELECT COALESCE(sum(montant), 0)::float AS emis, COALESCE(sum(LEAST(paye, montant)), 0)::float AS paye,
                                   count(*) FILTER (WHERE NOT exonere)::int AS imposables
                            FROM ({ROLE_SQL}) r""", (annee,))
            res["fiscal"] = dict(cur.fetchone(), annee=annee)
    return res
