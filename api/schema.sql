-- Schéma applicatif (comptes, sessions, journal) — idempotent, appliqué au démarrage de l'API.

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.utilisateurs (
    id                 serial PRIMARY KEY,
    nom                text NOT NULL,
    email              text NOT NULL,
    service            text NOT NULL,
    fonction           text,
    telephone          text,
    mot_de_passe       text NOT NULL,           -- pbkdf2_sha256$iterations$sel$empreinte
    role               text NOT NULL DEFAULT 'agent' CHECK (role IN ('agent', 'superviseur', 'admin')),
    statut             text NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'actif', 'desactive')),
    cree_le            timestamptz NOT NULL DEFAULT now(),
    active_le          timestamptz,
    active_par         integer REFERENCES app.utilisateurs(id),
    derniere_connexion timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS utilisateurs_email_idx ON app.utilisateurs (lower(email));

CREATE TABLE IF NOT EXISTS app.sessions (
    jeton_hash   text PRIMARY KEY,                -- SHA-256 du jeton : le jeton lui-même n'est pas stocké
    utilisateur  integer NOT NULL REFERENCES app.utilisateurs(id) ON DELETE CASCADE,
    cree_le      timestamptz NOT NULL DEFAULT now(),
    expire_le    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app.journal (
    id           bigserial PRIMARY KEY,
    date         timestamptz NOT NULL DEFAULT now(),
    utilisateur  integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    action       text NOT NULL,
    objet        text,
    detail       text
);
CREATE INDEX IF NOT EXISTS journal_date_idx ON app.journal (date DESC);

-- Contributions : lien avec les comptes
ALTER TABLE contrib.contributions ADD COLUMN IF NOT EXISTS cree_par   integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL;
ALTER TABLE contrib.contributions ADD COLUMN IF NOT EXISTS service    text;
ALTER TABLE contrib.contributions ADD COLUMN IF NOT EXISTS valide_par integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL;
ALTER TABLE contrib.contributions ADD COLUMN IF NOT EXISTS valide_le  timestamptz;
ALTER TABLE contrib.contributions ADD COLUMN IF NOT EXISTS motif_rejet text;

-- ---------------------------------------------------------------- suivi des signalements et historique
-- Statuts : À valider → Validé → Affecté (à un service) → En cours → Traité ; ou Rejeté
ALTER TABLE contrib.contributions DROP CONSTRAINT IF EXISTS contributions_statut_check;
ALTER TABLE contrib.contributions ADD CONSTRAINT contributions_statut_check
    CHECK (statut IN ('À valider', 'Validé', 'Affecté', 'En cours', 'Traité', 'Rejeté'));
ALTER TABLE contrib.contributions ADD COLUMN IF NOT EXISTS uid            uuid UNIQUE;   -- identifiant créé par le téléphone (saisie hors connexion)
ALTER TABLE contrib.contributions ADD COLUMN IF NOT EXISTS service_affecte text;
ALTER TABLE contrib.contributions ADD COLUMN IF NOT EXISTS priorite       text CHECK (priorite IN ('Basse', 'Normale', 'Haute', 'Urgente'));
ALTER TABLE contrib.contributions ADD COLUMN IF NOT EXISTS echeance       date;
ALTER TABLE contrib.contributions ADD COLUMN IF NOT EXISTS affecte_le     timestamptz;
ALTER TABLE contrib.contributions ADD COLUMN IF NOT EXISTS traite_le      timestamptz;
-- Corrections de la carte de référence (bâti, voirie)
ALTER TABLE contrib.contributions ADD COLUMN IF NOT EXISTS ref_couche     text CHECK (ref_couche IN ('batiments', 'routes'));
ALTER TABLE contrib.contributions ADD COLUMN IF NOT EXISTS ref_gid        integer;

CREATE TABLE IF NOT EXISTS contrib.historique (
    id            bigserial PRIMARY KEY,
    contribution  integer NOT NULL REFERENCES contrib.contributions(id) ON DELETE CASCADE,
    date          timestamptz NOT NULL DEFAULT now(),
    utilisateur   integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    action        text NOT NULL,
    statut_avant  text,
    statut_apres  text,
    commentaire   text,
    photo         bytea,
    geom_avant    geometry(Geometry, 4326)          -- forme avant modification (retour arrière possible)
);
CREATE INDEX IF NOT EXISTS historique_contribution_idx ON contrib.historique (contribution, date);

-- Vues publiées : les signalements pris en charge restent visibles
CREATE OR REPLACE VIEW contrib.contributions_points AS
    SELECT id, categorie, type, nom, description, quartier, statut, cree_le, geom::geometry(Point, 4326) AS geom
    FROM contrib.contributions
    WHERE statut IN ('Validé', 'Affecté', 'En cours', 'Traité') AND categorie <> 'Correction de la carte' AND GeometryType(geom) = 'POINT';
CREATE OR REPLACE VIEW contrib.contributions_lignes AS
    SELECT id, categorie, type, nom, description, quartier, statut, cree_le, geom::geometry(LineString, 4326) AS geom
    FROM contrib.contributions
    WHERE statut IN ('Validé', 'Affecté', 'En cours', 'Traité') AND categorie <> 'Correction de la carte' AND GeometryType(geom) = 'LINESTRING';
CREATE OR REPLACE VIEW contrib.contributions_surfaces AS
    SELECT id, categorie, type, nom, description, quartier, statut, cree_le, geom::geometry(Polygon, 4326) AS geom
    FROM contrib.contributions
    WHERE statut IN ('Validé', 'Affecté', 'En cours', 'Traité') AND categorie <> 'Correction de la carte' AND GeometryType(geom) = 'POLYGON';
