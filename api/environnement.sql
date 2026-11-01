-- Protection de l'environnement : zones protégées, atteintes, plantations, points d'eau, feux de brousse.
-- Idempotent : appliqué à chaque démarrage de l'API.
-- Données personnelles (personne mise en cause dans une atteinte) : réservées au service de l'environnement
-- et aux superviseurs ; jamais publiées.
CREATE SCHEMA IF NOT EXISTS env;

CREATE TABLE IF NOT EXISTS env.parametres (
    cle          text PRIMARY KEY,
    valeur       numeric NOT NULL,
    description  text NOT NULL
);
INSERT INTO env.parametres VALUES
    ('perimetre_source_m', 50, 'Rayon du périmètre de protection autour d''une source, d''un puits ou d''un forage (m)'),
    ('pente_forte_pct', 30, 'Pente à partir de laquelle une zone est protégée (%)'),
    ('surface_min_ha', 0.5, 'Surface minimale d''une zone calculée (pentes, bas-fonds), en hectares'),
    ('mois_debut_saison_feux', 11, 'Mois de début de la saison des feux (11 = novembre)')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION env.param(k text) RETURNS numeric LANGUAGE sql STABLE AS
    $$ SELECT valeur FROM env.parametres WHERE cle = k $$;

-- ---------------------------------------------------------------- zones protégées
CREATE TABLE IF NOT EXISTS env.zones (
    id            serial PRIMARY KEY,
    code          text NOT NULL UNIQUE,                       -- ex. ZP-0004
    type          text NOT NULL
                  CHECK (type IN ('Berge de cours d''eau', 'Périmètre de source', 'Bas-fond / zone humide', 'Pente forte',
                                  'Forêt classée', 'Boisement', 'Espace vert', 'Zone de reboisement', 'Autre')),
    nom           text NOT NULL,
    regle         text NOT NULL DEFAULT 'Inconstructible'
                  CHECK (regle IN ('Protection intégrale', 'Inconstructible', 'Constructible sous conditions')),
    reference     text,                                       -- arrêté, plan d'urbanisme…
    calcul        text CHECK (calcul IN ('berges', 'pentes', 'basfonds', 'forets', 'source')),  -- zone recalculable
    point_eau     integer,                                    -- périmètre d'un point d'eau (env.points_eau)
    geom          geometry(MultiPolygon, 4326) NOT NULL,
    geom_m        geometry(MultiPolygon, 32628),
    superficie_ha numeric(12, 2),
    active        boolean NOT NULL DEFAULT true,
    observations  text,
    cree_le       timestamptz NOT NULL DEFAULT now(),
    cree_par      integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    modifie_le    timestamptz
);
CREATE INDEX IF NOT EXISTS zones_geom_idx ON env.zones USING gist (geom);
CREATE INDEX IF NOT EXISTS zones_geom_m_idx ON env.zones USING gist (geom_m);

CREATE OR REPLACE FUNCTION env.zones_maj_geom() RETURNS trigger AS $$
BEGIN
    NEW.geom := ST_Multi(ST_CollectionExtract(ST_MakeValid(NEW.geom), 3));
    NEW.geom_m := ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Transform(NEW.geom, 32628)), 3));
    NEW.superficie_ha := round((ST_Area(NEW.geom_m) / 10000)::numeric, 2);
    RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER zones_geom BEFORE INSERT OR UPDATE OF geom ON env.zones
    FOR EACH ROW EXECUTE FUNCTION env.zones_maj_geom();

-- Zones protégées découpées (contrôles rapides)
CREATE OR REPLACE VIEW env.zones_actives AS
    SELECT id, code, type, nom, regle, geom_m FROM env.zones WHERE active;

-- ---------------------------------------------------------------- atteintes à l'environnement
-- Signalée → Constatée → Mise en demeure → Sanctionnée | Remise en état → Close ; ou Classée sans suite
CREATE TABLE IF NOT EXISTS env.atteintes (
    id            serial PRIMARY KEY,
    numero        text NOT NULL UNIQUE,                       -- ex. AE-2026-0012
    uid           uuid UNIQUE,                                -- saisie hors connexion
    type          text NOT NULL
                  CHECK (type IN ('Coupe abusive d''arbres', 'Feu de brousse', 'Extraction de sable ou de gravier',
                                  'Construction ou occupation de berge', 'Rejet d''eaux usées',
                                  'Pollution d''une source ou d''un cours d''eau', 'Érosion / ravinement',
                                  'Carrière sauvage', 'Autre')),
    statut        text NOT NULL DEFAULT 'Signalée'
                  CHECK (statut IN ('Signalée', 'Constatée', 'Mise en demeure', 'Sanctionnée', 'Remise en état',
                                    'Close', 'Classée sans suite')),
    gravite       text NOT NULL DEFAULT 'Moyenne' CHECK (gravite IN ('Faible', 'Moyenne', 'Grave')),
    description   text NOT NULL,
    surface_m2    numeric(12, 0),
    responsable   text,                                       -- personne ou entreprise mise en cause (donnée personnelle)
    echeance      date,                                       -- délai de la mise en demeure
    amende_gnf    numeric(14, 0),
    quartier      text,
    zones         text[] NOT NULL DEFAULT '{}',               -- zones protégées touchées (codes)
    photo         bytea,
    geom          geometry(Geometry, 4326) NOT NULL,
    contribution  integer REFERENCES contrib.contributions(id) ON DELETE SET NULL,
    cree_le       timestamptz NOT NULL DEFAULT now(),
    cree_par      integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    clos_le       timestamptz,
    modifie_le    timestamptz
);
CREATE INDEX IF NOT EXISTS atteintes_geom_idx ON env.atteintes USING gist (geom);

CREATE TABLE IF NOT EXISTS env.atteintes_historique (
    id            bigserial PRIMARY KEY,
    atteinte      integer NOT NULL REFERENCES env.atteintes(id) ON DELETE CASCADE,
    date          timestamptz NOT NULL DEFAULT now(),
    utilisateur   integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    action        text NOT NULL,
    statut_avant  text,
    statut_apres  text,
    commentaire   text,
    photo         bytea
);
CREATE INDEX IF NOT EXISTS atteintes_historique_idx ON env.atteintes_historique (atteinte, date);

-- ---------------------------------------------------------------- arbres et reboisement
CREATE TABLE IF NOT EXISTS env.plantations (
    id              serial PRIMARY KEY,
    numero          text NOT NULL UNIQUE,                     -- ex. PL-0007
    uid             uuid UNIQUE,
    type            text NOT NULL
                    CHECK (type IN ('Arbres d''alignement', 'Reboisement', 'Haie vive', 'Verger communautaire',
                                    'Arbre isolé', 'Espace vert')),
    espece          text,
    nombre_plants   integer NOT NULL CHECK (nombre_plants > 0),
    date_plantation date NOT NULL DEFAULT current_date,
    campagne        text,                                     -- ex. « Campagne 2026 »
    organisme       text,                                     -- mairie, école, ONG, association…
    quartier        text,
    observations    text,
    photo           bytea,
    geom            geometry(Geometry, 4326) NOT NULL,
    cree_le         timestamptz NOT NULL DEFAULT now(),
    cree_par        integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    modifie_le      timestamptz
);
CREATE INDEX IF NOT EXISTS plantations_geom_idx ON env.plantations USING gist (geom);

CREATE TABLE IF NOT EXISTS env.plantations_suivis (
    id           bigserial PRIMARY KEY,
    plantation   integer NOT NULL REFERENCES env.plantations(id) ON DELETE CASCADE,
    date         date NOT NULL DEFAULT current_date,
    vivants      integer NOT NULL CHECK (vivants >= 0),
    etat         text NOT NULL DEFAULT 'Bon' CHECK (etat IN ('Bon', 'Moyen', 'Mauvais')),
    commentaire  text,
    photo        bytea,
    utilisateur  integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    saisi_le     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plantations_suivis_idx ON env.plantations_suivis (plantation, date);

-- ---------------------------------------------------------------- sources et points d'eau
CREATE TABLE IF NOT EXISTS env.points_eau (
    id            serial PRIMARY KEY,
    numero        text NOT NULL UNIQUE,                       -- ex. SO-0003 (source), PU-, FO-, RE-
    uid           uuid UNIQUE,
    type          text NOT NULL CHECK (type IN ('Source', 'Puits', 'Forage', 'Mare / retenue')),
    nom           text,
    etat          text NOT NULL DEFAULT 'Permanent'
                  CHECK (etat IN ('Permanent', 'Tarit en saison sèche', 'Tari', 'Pollué')),
    usage         text,                                       -- boisson, lessive, maraîchage, bétail…
    amenage       boolean NOT NULL DEFAULT false,             -- captage, margelle, pompe…
    perimetre_m   numeric(6, 0),                              -- périmètre de protection (vide = valeur par défaut)
    quartier      text,
    observations  text,
    photo         bytea,
    geom          geometry(Point, 4326) NOT NULL,
    dernier_constat timestamptz NOT NULL DEFAULT now(),
    cree_le       timestamptz NOT NULL DEFAULT now(),
    cree_par      integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    modifie_le    timestamptz
);
CREATE INDEX IF NOT EXISTS points_eau_geom_idx ON env.points_eau USING gist (geom);

CREATE TABLE IF NOT EXISTS env.points_eau_constats (
    id           bigserial PRIMARY KEY,
    point_eau    integer NOT NULL REFERENCES env.points_eau(id) ON DELETE CASCADE,
    date         timestamptz NOT NULL DEFAULT now(),
    etat         text NOT NULL,
    debit        text,                                        -- ex. « 2 l/s », « faible »
    qualite      text,                                        -- claire, trouble, odeur…
    commentaire  text,
    photo        bytea,
    utilisateur  integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS points_eau_constats_idx ON env.points_eau_constats (point_eau, date);

-- ---------------------------------------------------------------- feux de brousse
CREATE TABLE IF NOT EXISTS env.feux (
    id           serial PRIMARY KEY,
    date_feu     date NOT NULL,
    origine      text NOT NULL DEFAULT 'Terrain' CHECK (origine IN ('Terrain', 'Satellite (FIRMS)')),
    cause        text NOT NULL DEFAULT 'Inconnue'
                 CHECK (cause IN ('Défrichement agricole', 'Chasse', 'Accident', 'Malveillance', 'Inconnue')),
    surface_ha   numeric(10, 2),
    confiance    text,                                        -- satellite : faible, nominale, haute
    cle_firms    text UNIQUE,                                 -- évite les doublons à l'import satellite
    description  text,
    quartier     text,
    geom         geometry(Geometry, 4326) NOT NULL,
    cree_le      timestamptz NOT NULL DEFAULT now(),
    cree_par     integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS feux_geom_idx ON env.feux USING gist (geom);
CREATE INDEX IF NOT EXISTS feux_date_idx ON env.feux (date_feu);

-- Saison des feux (ex. « 2025-2026 » de novembre 2025 à octobre 2026)
CREATE OR REPLACE FUNCTION env.saison(d date) RETURNS text LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN EXTRACT(month FROM d) >= env.param('mois_debut_saison_feux')
                THEN EXTRACT(year FROM d)::int || '-' || (EXTRACT(year FROM d)::int + 1)
                ELSE (EXTRACT(year FROM d)::int - 1) || '-' || EXTRACT(year FROM d)::int END
$$;
