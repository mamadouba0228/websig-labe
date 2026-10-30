-- Module d'adressage — numérotation métrique (pair à droite, impair à gauche).
-- Idempotent : appliqué à chaque démarrage de l'API.
-- Calculs métriques en UTM 28N (EPSG:32628), zone de Labé.

CREATE SCHEMA IF NOT EXISTS adr;

-- Paramètres (centre-ville servant à orienter les voies, distance de rattachement…)
CREATE TABLE IF NOT EXISTS adr.parametres (
    cle    text PRIMARY KEY,
    valeur text NOT NULL
);
INSERT INTO adr.parametres VALUES ('distance_max_m', '50') ON CONFLICT DO NOTHING;

-- Code de chaque quartier (préfixe des codes de voies), modifiable par l'administrateur
CREATE TABLE IF NOT EXISTS adr.quartiers (
    nom   text PRIMARY KEY,
    code  text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{2,4}$')
);

CREATE TABLE IF NOT EXISTS adr.voies (
    id            serial PRIMARY KEY,
    code          text NOT NULL UNIQUE,                 -- ex. DK1-012
    type_voie     text NOT NULL DEFAULT 'Rue'
                  CHECK (type_voie IN ('Rue', 'Avenue', 'Boulevard', 'Route', 'Impasse', 'Allée', 'Place', 'Corniche')),
    nom           text,                                  -- ex. Karamoko Alfa
    statut_nom    text NOT NULL DEFAULT 'Sans nom'
                  CHECK (statut_nom IN ('Sans nom', 'Nom d''usage', 'Proposé', 'Officiel')),
    deliberation  text,                                  -- référence de la délibération du conseil
    quartier      text,
    source        text NOT NULL DEFAULT 'Saisie',
    geom          geometry(LineString, 4326) NOT NULL,
    geom_m        geometry(LineString, 32628),
    longueur_m    numeric(10, 1),
    cree_le       timestamptz NOT NULL DEFAULT now(),
    modifie_le    timestamptz,
    cree_par      integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS voies_geom_idx ON adr.voies USING gist (geom);
CREATE INDEX IF NOT EXISTS voies_geom_m_idx ON adr.voies USING gist (geom_m);

CREATE OR REPLACE FUNCTION adr.voies_maj_geom() RETURNS trigger AS $$
BEGIN
    NEW.geom_m := ST_Transform(NEW.geom, 32628);
    NEW.longueur_m := round(ST_Length(NEW.geom_m)::numeric, 1);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS voies_geom ON adr.voies;
CREATE TRIGGER voies_geom BEFORE INSERT OR UPDATE OF geom ON adr.voies
    FOR EACH ROW EXECUTE FUNCTION adr.voies_maj_geom();

CREATE TABLE IF NOT EXISTS adr.adresses (
    id            serial PRIMARY KEY,
    voie_id       integer NOT NULL REFERENCES adr.voies(id) ON DELETE CASCADE,
    numero        integer NOT NULL CHECK (numero > 0),
    suffixe       text NOT NULL DEFAULT '' CHECK (suffixe ~ '^[A-Z]?$'),
    cote          text NOT NULL CHECK (cote IN ('pair', 'impair')),
    batiment_gid  integer,                               -- ref.batiments.gid
    complement    text,                                  -- ex. « Concession Diallo », « 1er étage »
    quartier      text,
    statut        text NOT NULL DEFAULT 'Proposée' CHECK (statut IN ('Proposée', 'Validée', 'Plaque posée')),
    geom          geometry(Point, 4326) NOT NULL,
    cree_le       timestamptz NOT NULL DEFAULT now(),
    modifie_le    timestamptz,
    valide_par    integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    UNIQUE (voie_id, numero, suffixe)
);
-- Pose des plaques : qui et quand
ALTER TABLE adr.adresses ADD COLUMN IF NOT EXISTS pose_le  timestamptz;
ALTER TABLE adr.adresses ADD COLUMN IF NOT EXISTS pose_par integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL;
ALTER TABLE adr.adresses ADD COLUMN IF NOT EXISTS valide_le timestamptz;
CREATE INDEX IF NOT EXISTS adresses_geom_idx ON adr.adresses USING gist (geom);
CREATE INDEX IF NOT EXISTS adresses_voie_idx ON adr.adresses (voie_id);
CREATE UNIQUE INDEX IF NOT EXISTS adresses_batiment_idx ON adr.adresses (batiment_gid) WHERE batiment_gid IS NOT NULL;

-- Points des bâtiments en mètres (calculés une fois, rafraîchis si le bâti est réimporté)
CREATE TABLE IF NOT EXISTS adr.batiments_points (
    gid  integer PRIMARY KEY,
    p    geometry(Point, 32628) NOT NULL
);
CREATE INDEX IF NOT EXISTS batiments_points_p_idx ON adr.batiments_points USING gist (p);

CREATE OR REPLACE FUNCTION adr.rafraichir_batiments() RETURNS integer AS $$
DECLARE n integer;
BEGIN
    TRUNCATE adr.batiments_points;
    INSERT INTO adr.batiments_points (gid, p)
        SELECT gid, ST_Transform(ST_PointOnSurface(geom), 32628) FROM ref.batiments;
    GET DIAGNOSTICS n = ROW_COUNT;
    ANALYZE adr.batiments_points;
    RETURN n;
END;
$$ LANGUAGE plpgsql;

-- Adresse complète en une ligne
CREATE OR REPLACE FUNCTION adr.libelle(numero integer, suffixe text, type_voie text, nom text, code text)
RETURNS text AS $$
    SELECT numero || suffixe || ', ' || type_voie || ' ' ||
           CASE WHEN nom IS NOT NULL AND nom <> '' THEN nom || ' (' || code || ')' ELSE code END;
$$ LANGUAGE sql IMMUTABLE;

-- Numéro métrique d'un point le long d'une voie : distance depuis le début, parité selon le côté.
-- Renvoie (numero, cote, distance_m).
CREATE OR REPLACE FUNCTION adr.numero_metrique(v geometry, p geometry, OUT numero integer, OUT cote text, OUT distance_m numeric)
AS $$
DECLARE
    f   double precision := ST_LineLocatePoint(v, p);
    len double precision := ST_Length(v);
    eps double precision := least(0.5 / greatest(len, 1), 0.01);
    a   geometry := ST_LineInterpolatePoint(v, greatest(f - eps, 0));
    b   geometry := ST_LineInterpolatePoint(v, least(f + eps, 1));
    pv double precision;
BEGIN
    -- produit vectoriel : > 0 → point à gauche du sens de la voie
    pv := (ST_X(b) - ST_X(a)) * (ST_Y(p) - ST_Y(a)) - (ST_Y(b) - ST_Y(a)) * (ST_X(p) - ST_X(a));
    cote := CASE WHEN pv > 0 THEN 'impair' ELSE 'pair' END;
    distance_m := round((f * len)::numeric, 1);
    numero := greatest(round(f * len)::integer, 1);
    IF cote = 'pair' AND numero % 2 = 1 THEN numero := numero + 1; END IF;
    IF cote = 'impair' AND numero % 2 = 0 THEN numero := numero + 1; END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Calcule les adresses proposées d'une voie. Les adresses validées ou posées ne sont jamais modifiées.
CREATE OR REPLACE FUNCTION adr.numeroter_voie(v_id integer) RETURNS integer AS $$
DECLARE
    n integer;
    dmax double precision := (SELECT valeur::double precision FROM adr.parametres WHERE cle = 'distance_max_m');
BEGIN
    DELETE FROM adr.adresses WHERE voie_id = v_id AND statut = 'Proposée' AND batiment_gid IS NOT NULL;

    WITH v AS (SELECT id, geom_m FROM adr.voies WHERE id = v_id),
    cand AS (   -- bâtiments dont c'est la voie la plus proche, sans adresse existante
        SELECT bp.gid, bp.p, (adr.numero_metrique(v.geom_m, bp.p)).*
        FROM v JOIN adr.batiments_points bp ON ST_DWithin(bp.p, v.geom_m, dmax)
        WHERE NOT EXISTS (SELECT 1 FROM adr.adresses a WHERE a.batiment_gid = bp.gid)
          AND (SELECT w.id FROM adr.voies w ORDER BY w.geom_m <-> bp.p LIMIT 1) = v_id
    ),
    ranked AS (  -- doublons de numéro : 42, 42A, 42B… (en tenant compte des adresses existantes)
        SELECT c.*,
               (row_number() OVER (PARTITION BY numero ORDER BY distance_m, gid) - 1)::integer
               + (SELECT count(*) FROM adr.adresses a WHERE a.voie_id = v_id AND a.numero = c.numero)::integer AS rang
        FROM cand c
    )
    INSERT INTO adr.adresses (voie_id, numero, suffixe, cote, batiment_gid, quartier, statut, geom)
    SELECT v_id, r.numero, CASE WHEN r.rang = 0 THEN '' ELSE chr(64 + r.rang) END, r.cote, r.gid,
           (SELECT q.nom FROM ref.quartiers q WHERE ST_Intersects(q.geom, ST_Transform(r.p, 4326)) LIMIT 1),
           'Proposée', ST_Transform(r.p, 4326)
    FROM ranked r
    WHERE r.rang < 26;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$ LANGUAGE plpgsql;

-- Vues publiées (GeoServer, carte publique)
CREATE OR REPLACE VIEW adr.voies_publiques AS
    SELECT v.id, v.code, v.type_voie, v.nom, v.statut_nom, v.quartier, v.longueur_m,
           CASE WHEN v.nom IS NOT NULL AND v.nom <> '' THEN v.type_voie || ' ' || v.nom ELSE v.type_voie || ' ' || v.code END AS libelle,
           v.geom
    FROM adr.voies v;

CREATE OR REPLACE VIEW adr.adresses_publiques AS
    SELECT a.id, a.numero, a.suffixe, a.numero || a.suffixe AS num, a.cote, a.quartier, a.statut,
           v.code AS code_voie, v.nom AS nom_voie, v.type_voie,
           adr.libelle(a.numero, a.suffixe, v.type_voie, v.nom, v.code) AS libelle,
           a.geom
    FROM adr.adresses a JOIN adr.voies v ON v.id = a.voie_id
    WHERE a.statut IN ('Validée', 'Plaque posée');
