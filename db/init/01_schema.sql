-- WebSIG Commune urbaine de Labé — schéma initial
-- Exécuté une seule fois, à la création du volume de la base.

CREATE EXTENSION IF NOT EXISTS postgis;

-- Données de référence (chargées par le service « import »)
CREATE SCHEMA IF NOT EXISTS ref;

-- Données ajoutées par les utilisateurs
CREATE SCHEMA IF NOT EXISTS contrib;

CREATE TABLE IF NOT EXISTS contrib.contributions (
    id           serial PRIMARY KEY,
    categorie    text NOT NULL,
    type         text,
    nom          text,
    description  text,
    quartier     text,
    auteur       text,
    contact      text,                 -- jamais publié (ni API publique, ni GeoServer)
    statut       text NOT NULL DEFAULT 'À valider'
                 CHECK (statut IN ('À valider', 'Validé', 'Rejeté', 'Traité')),
    photo        bytea,
    geom         geometry(Geometry, 4326) NOT NULL
                 CHECK (GeometryType(geom) IN ('POINT', 'LINESTRING', 'POLYGON')),
    cree_le      timestamptz NOT NULL DEFAULT now(),
    modifie_le   timestamptz,
    modifie_par  text
);
CREATE INDEX IF NOT EXISTS contributions_geom_idx ON contrib.contributions USING gist (geom);
CREATE INDEX IF NOT EXISTS contributions_statut_idx ON contrib.contributions (statut);

-- Quartier renseigné automatiquement s'il est vide
CREATE OR REPLACE FUNCTION contrib.set_quartier() RETURNS trigger AS $$
BEGIN
    IF (NEW.quartier IS NULL OR NEW.quartier = '') AND to_regclass('ref.quartiers') IS NOT NULL THEN
        SELECT q.nom INTO NEW.quartier
        FROM ref.quartiers q
        WHERE ST_Intersects(q.geom, ST_PointOnSurface(NEW.geom))
        LIMIT 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contributions_quartier ON contrib.contributions;
CREATE TRIGGER contributions_quartier
    BEFORE INSERT OR UPDATE OF geom, quartier ON contrib.contributions
    FOR EACH ROW EXECUTE FUNCTION contrib.set_quartier();

-- Vues publiées par GeoServer : uniquement les contributions validées, sans données personnelles
CREATE OR REPLACE VIEW contrib.contributions_points AS
    SELECT id, categorie, type, nom, description, quartier, statut, cree_le, geom::geometry(Point, 4326) AS geom
    FROM contrib.contributions
    WHERE statut IN ('Validé', 'Traité') AND GeometryType(geom) = 'POINT';
CREATE OR REPLACE VIEW contrib.contributions_lignes AS
    SELECT id, categorie, type, nom, description, quartier, statut, cree_le, geom::geometry(LineString, 4326) AS geom
    FROM contrib.contributions
    WHERE statut IN ('Validé', 'Traité') AND GeometryType(geom) = 'LINESTRING';
CREATE OR REPLACE VIEW contrib.contributions_surfaces AS
    SELECT id, categorie, type, nom, description, quartier, statut, cree_le, geom::geometry(Polygon, 4326) AS geom
    FROM contrib.contributions
    WHERE statut IN ('Validé', 'Traité') AND GeometryType(geom) = 'POLYGON';
