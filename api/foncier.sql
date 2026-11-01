-- Module foncier — registre des parcelles, dossiers fonciers, contrôles géométriques.
-- Idempotent : appliqué à chaque démarrage de l'API. Calculs métriques en UTM 28N (EPSG:32628).
-- Le registre communal est un outil de recensement et de suivi : il ne remplace pas le titre foncier
-- délivré par les services de l'État (Conservation foncière).

CREATE SCHEMA IF NOT EXISTS fon;

-- ---------------------------------------------------------------- paramètres des contrôles
CREATE TABLE IF NOT EXISTS fon.parametres (
    cle      text PRIMARY KEY,
    valeur   numeric NOT NULL,
    libelle  text NOT NULL
);
INSERT INTO fon.parametres VALUES
    ('tolerance_chevauchement_m2', 2,  'Chevauchement toléré entre deux parcelles (m², imprécision des levés)'),
    ('alerte_emprise_m2',          5,  'Empiètement sur l''emprise d''une voie à partir duquel une alerte est émise (m²)'),
    ('berge_cours_eau_m',          10, 'Bande de protection de part et d''autre des cours d''eau (m)'),
    ('emprise_Voie rapide',            30, 'Emprise totale d''une voie rapide (m)'),
    ('emprise_Route primaire',         20, 'Emprise totale d''une route primaire (m)'),
    ('emprise_Route secondaire',       15, 'Emprise totale d''une route secondaire (m)'),
    ('emprise_Route tertiaire',        12, 'Emprise totale d''une route tertiaire (m)'),
    ('emprise_Route résidentielle',    10, 'Emprise totale d''une rue résidentielle (m)'),
    ('emprise_Route non classifiée',   10, 'Emprise totale d''une route non classifiée (m)'),
    ('emprise_Route d accès',           8, 'Emprise totale d''une voie d''accès (m)'),
    ('emprise_Chemin carrossable',      6, 'Emprise totale d''un chemin carrossable (m)'),
    ('emprise_Chemin non carrossable',  4, 'Emprise totale d''un chemin non carrossable (m)')
ON CONFLICT (cle) DO NOTHING;

CREATE OR REPLACE FUNCTION fon.param(k text, defaut numeric DEFAULT 0) RETURNS numeric AS $$
    SELECT COALESCE((SELECT valeur FROM fon.parametres WHERE cle = k), defaut)
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------- registre des parcelles
CREATE TABLE IF NOT EXISTS fon.parcelles (
    id                serial PRIMARY KEY,
    numero            text NOT NULL UNIQUE,                 -- ex. LAB-KRL-00012
    quartier          text,
    usage             text NOT NULL DEFAULT 'Habitation'
                      CHECK (usage IN ('Habitation', 'Commerce', 'Mixte', 'Équipement public', 'Culte', 'Agricole',
                                       'Espace vert', 'Réserve', 'Non bâti', 'Autre')),
    statut_juridique  text NOT NULL DEFAULT 'Non documenté'
                      CHECK (statut_juridique IN ('Titre foncier', 'Permis d''habiter', 'Attestation de cession',
                                                  'Acte coutumier', 'Domaine public', 'Réserve communale', 'Non documenté')),
    reference_acte    text,                                  -- n° du titre, du permis, de l'attestation…
    date_acte         date,
    lotissement       text,
    lot               text,
    etat              text NOT NULL DEFAULT 'Provisoire' CHECK (etat IN ('Provisoire', 'Enregistrée', 'Archivée')),
    source_geom       text NOT NULL DEFAULT 'Digitalisation'
                      CHECK (source_geom IN ('Digitalisation', 'Levé GPS', 'Levé topographique', 'Plan de lotissement')),
    precision_m       numeric(5, 1),
    observations      text,
    geom              geometry(Polygon, 4326) NOT NULL,
    geom_m            geometry(Polygon, 32628),
    superficie_m2     numeric(12, 1),
    perimetre_m       numeric(10, 1),
    meres             integer[] NOT NULL DEFAULT '{}',      -- parcelles d'origine (morcellement, fusion)
    dossier_origine   integer,
    alertes           jsonb NOT NULL DEFAULT '[]',          -- résultat du dernier contrôle
    cree_le           timestamptz NOT NULL DEFAULT now(),
    cree_par          integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    modifie_le        timestamptz,
    modifie_par       integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    valide_le         timestamptz,
    valide_par        integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    archive_le        timestamptz,
    archive_motif     text
);
CREATE INDEX IF NOT EXISTS parcelles_geom_idx ON fon.parcelles USING gist (geom);
CREATE INDEX IF NOT EXISTS parcelles_geom_m_idx ON fon.parcelles USING gist (geom_m);
CREATE INDEX IF NOT EXISTS parcelles_quartier_idx ON fon.parcelles (quartier);

CREATE OR REPLACE FUNCTION fon.parcelles_maj_geom() RETURNS trigger AS $$
BEGIN
    NEW.geom_m := ST_Transform(NEW.geom, 32628);
    NEW.superficie_m2 := round(ST_Area(NEW.geom_m)::numeric, 1);
    NEW.perimetre_m := round(ST_Perimeter(NEW.geom_m)::numeric, 1);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS parcelles_geom ON fon.parcelles;
CREATE TRIGGER parcelles_geom BEFORE INSERT OR UPDATE OF geom ON fon.parcelles
    FOR EACH ROW EXECUTE FUNCTION fon.parcelles_maj_geom();

-- Versions successives : attributs et limites avant chaque changement
CREATE TABLE IF NOT EXISTS fon.parcelles_historique (
    id           bigserial PRIMARY KEY,
    parcelle     integer NOT NULL REFERENCES fon.parcelles(id) ON DELETE CASCADE,
    date         timestamptz NOT NULL DEFAULT now(),
    utilisateur  integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    action       text NOT NULL,
    dossier      integer,
    commentaire  text,
    attributs    jsonb,                                       -- état des attributs avant le changement
    geom         geometry(Polygon, 4326)                      -- limites avant le changement (si elles changent)
);
CREATE INDEX IF NOT EXISTS parcelles_historique_idx ON fon.parcelles_historique (parcelle, date);

-- ---------------------------------------------------------------- dossiers fonciers
-- Circuit : Déposé → En instruction → Visite effectuée → Avis favorable / défavorable → Approuvé / Rejeté
--           (Abandonné à tout moment avant la décision)
CREATE TABLE IF NOT EXISTS fon.dossiers (
    id                   serial PRIMARY KEY,
    numero               text NOT NULL UNIQUE,              -- ex. DF-2026-0007
    type                 text NOT NULL
                         CHECK (type IN ('Attribution', 'Régularisation', 'Morcellement', 'Fusion', 'Mutation (vente)',
                                         'Mutation (succession)', 'Mutation (donation)', 'Bornage', 'Changement d''usage')),
    statut               text NOT NULL DEFAULT 'Déposé'
                         CHECK (statut IN ('Déposé', 'En instruction', 'Visite effectuée', 'Avis favorable',
                                           'Avis défavorable', 'Approuvé', 'Rejeté', 'Abandonné')),
    parcelles            integer[] NOT NULL DEFAULT '{}',   -- parcelles concernées
    geom_proposee        geometry(MultiPolygon, 4326),      -- nouvelles limites (attribution, bornage, morcellement)
    quartier             text,
    objet                text,
    demandeur_nom        text NOT NULL,
    demandeur_telephone  text,
    demandeur_piece      text,                               -- n° de la pièce d'identité
    usage_demande        text,
    statut_juridique     text,                               -- statut après décision (mutation, régularisation)
    reference_acte       text,
    service              text NOT NULL DEFAULT 'Urbanisme et domaines',
    instructeur          integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    echeance             date,
    visite_le            date,
    compte_rendu         text,
    avis_motif           text,
    decision_ref         text,                               -- n° de la décision / de l'arrêté
    decide_le            timestamptz,
    decide_par           integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    motif_rejet          text,
    parcelles_creees     integer[] NOT NULL DEFAULT '{}',
    alertes              jsonb NOT NULL DEFAULT '[]',
    depose_le            timestamptz NOT NULL DEFAULT now(),
    depose_par           integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    modifie_le           timestamptz
);
CREATE INDEX IF NOT EXISTS dossiers_statut_idx ON fon.dossiers (statut);
CREATE INDEX IF NOT EXISTS dossiers_parcelles_idx ON fon.dossiers USING gin (parcelles);

CREATE TABLE IF NOT EXISTS fon.dossiers_historique (
    id            bigserial PRIMARY KEY,
    dossier       integer NOT NULL REFERENCES fon.dossiers(id) ON DELETE CASCADE,
    date          timestamptz NOT NULL DEFAULT now(),
    utilisateur   integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    action        text NOT NULL,
    statut_avant  text,
    statut_apres  text,
    commentaire   text
);
CREATE INDEX IF NOT EXISTS dossiers_historique_idx ON fon.dossiers_historique (dossier, date);

-- ---------------------------------------------------------------- contrôles
-- Zones inondables découpées en petits morceaux (intersections rapides)
CREATE MATERIALIZED VIEW IF NOT EXISTS fon.zones_inondables_m AS
    SELECT alea, ST_Subdivide(ST_Transform(geom, 32628), 128) AS geom FROM ref.zones_inondables;
CREATE INDEX IF NOT EXISTS zones_inondables_m_idx ON fon.zones_inondables_m USING gist (geom);

-- Contrôle d'une forme de parcelle. exclure : parcelles à ignorer (la parcelle elle-même, les parcelles mères).
-- Retourne une liste d'alertes { type, niveau (bloquant | alerte | info), message, m2, … }.
CREATE OR REPLACE FUNCTION fon.controler(g geometry, exclure integer[] DEFAULT '{}') RETURNS jsonb AS $$
DECLARE
    gm   geometry := ST_Transform(g, 32628);
    res  jsonb := '[]';
    r    record;
    a    numeric;
    tol  numeric := fon.param('tolerance_chevauchement_m2', 2);
BEGIN
    -- hors de la commune
    IF NOT EXISTS (SELECT 1 FROM ref.limite_commune c WHERE ST_Covers(ST_Buffer(ST_Transform(c.geom, 32628), 20), gm)) THEN
        res := res || jsonb_build_object('type', 'commune', 'niveau', 'bloquant',
                                         'message', 'La parcelle sort des limites de la commune.');
    END IF;

    -- chevauchement avec d'autres parcelles du registre
    FOR r IN
        SELECT p.id, p.numero, ST_Area(ST_Intersection(p.geom_m, gm)) AS s
        FROM fon.parcelles p
        WHERE p.etat <> 'Archivée' AND NOT (p.id = ANY (exclure)) AND p.geom_m && gm AND ST_Intersects(p.geom_m, gm)
    LOOP
        IF r.s > tol THEN
            res := res || jsonb_build_object('type', 'chevauchement', 'niveau', 'bloquant', 'parcelle', r.id,
                'numero', r.numero, 'm2', round(r.s::numeric, 1),
                'message', format('Chevauche la parcelle %s sur %s m².', r.numero, round(r.s::numeric)));
        END IF;
    END LOOP;

    -- emprise des voies (largeur selon la classe de la voie)
    SELECT ST_Area(ST_Intersection(gm, ST_Union(ST_Buffer(ST_Transform(v.geom, 32628),
                                    fon.param('emprise_' || v.nature, 8) / 2, 'endcap=flat')))) AS s,
           string_agg(DISTINCT COALESCE(v.nom, v.nature), ', ') AS voies
    INTO r
    FROM ref.routes v
    WHERE v.geom && ST_Transform(ST_Expand(gm, 30), 4326)
      AND ST_DWithin(ST_Transform(v.geom, 32628), gm, fon.param('emprise_' || v.nature, 8) / 2);
    IF r.s IS NOT NULL AND r.s > fon.param('alerte_emprise_m2', 5) THEN
        res := res || jsonb_build_object('type', 'emprise', 'niveau', 'alerte', 'm2', round(r.s::numeric, 1),
            'message', format('Empiète de %s m² sur l''emprise de la voie (%s).', round(r.s::numeric), r.voies));
    END IF;

    -- berges des cours d'eau, plans d'eau
    SELECT ST_Area(ST_Intersection(gm, ST_Union(ST_Buffer(ST_Transform(c.geom, 32628), fon.param('berge_cours_eau_m', 10))))) AS s,
           string_agg(DISTINCT COALESCE(c.nom, 'cours d''eau'), ', ') AS noms
    INTO r
    FROM ref.cours_eau c
    WHERE ST_DWithin(ST_Transform(c.geom, 32628), gm, fon.param('berge_cours_eau_m', 10));
    IF r.s IS NOT NULL AND r.s > 1 THEN
        res := res || jsonb_build_object('type', 'berge', 'niveau', 'alerte', 'm2', round(r.s::numeric, 1),
            'message', format('%s m² dans la bande de protection de %s m du cours d''eau (%s) : domaine public.',
                              round(r.s::numeric), fon.param('berge_cours_eau_m', 10), r.noms));
    END IF;
    SELECT sum(ST_Area(ST_Intersection(gm, ST_Transform(s.geom, 32628)))) INTO a
    FROM ref.surface_eau s WHERE ST_Intersects(ST_Transform(s.geom, 32628), gm);
    IF a > 1 THEN
        res := res || jsonb_build_object('type', 'eau', 'niveau', 'alerte', 'm2', round(a, 1),
            'message', format('%s m² sur un plan d''eau (domaine public).', round(a)));
    END IF;
    SELECT sum(ST_Area(ST_Intersection(gm, ST_Transform(s.geom, 32628)))) INTO a
    FROM ref.cimetieres s WHERE ST_Intersects(ST_Transform(s.geom, 32628), gm);
    IF a > 1 THEN
        res := res || jsonb_build_object('type', 'cimetiere', 'niveau', 'alerte', 'm2', round(a, 1),
            'message', format('%s m² sur l''emprise d''un cimetière.', round(a)));
    END IF;

    -- zones inondables (modèle numérique de terrain)
    FOR r IN
        SELECT z.alea, sum(ST_Area(ST_Intersection(z.geom, gm))) AS s
        FROM fon.zones_inondables_m z WHERE z.geom && gm AND ST_Intersects(z.geom, gm)
        GROUP BY z.alea ORDER BY z.alea = 'Fort' DESC
    LOOP
        IF r.s > 1 THEN
            res := res || jsonb_build_object('type', 'inondation', 'niveau', CASE WHEN r.alea = 'Fort' THEN 'alerte' ELSE 'info' END,
                'alea', r.alea, 'm2', round(r.s::numeric, 1),
                'part', round((100 * r.s / NULLIF(ST_Area(gm), 0))::numeric),
                'message', format('%s %% de la parcelle en zone inondable d''aléa %s.',
                                  round((100 * r.s / NULLIF(ST_Area(gm), 0))::numeric), lower(r.alea)));
        END IF;
    END LOOP;
    RETURN res;
END;
$$ LANGUAGE plpgsql STABLE;

-- Prochain numéro de parcelle d'un quartier : LAB-<code du quartier>-00001
CREATE OR REPLACE FUNCTION fon.prochain_numero(q text) RETURNS text AS $$
    SELECT 'LAB-' || c.code || '-' || lpad((COALESCE(max(substring(p.numero FROM '(\d+)$')::int), 0) + 1)::text, 5, '0')
    FROM (SELECT COALESCE((SELECT code FROM adr.quartiers WHERE nom = q), 'XXX') AS code) c
    LEFT JOIN fon.parcelles p ON p.numero LIKE 'LAB-' || c.code || '-%'
    GROUP BY c.code
$$ LANGUAGE sql STABLE;
