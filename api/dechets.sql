-- Gestion des déchets — points de collecte et dépotoirs, tournées, passages, constats.
-- Idempotent : appliqué à chaque démarrage de l'API.
-- La couche des points est remplie par les agents sur le terrain ; un point est publié sur la carte publique
-- une fois vérifié par le service Hygiène et salubrité (ou un superviseur).
CREATE SCHEMA IF NOT EXISTS dech;

CREATE TABLE IF NOT EXISTS dech.parametres (
    cle          text PRIMARY KEY,
    valeur       numeric NOT NULL,
    description  text NOT NULL
);
INSERT INTO dech.parametres VALUES
    ('rayon_desserte_m', 200, 'Distance maximale (m) entre un bâtiment et une tournée ou un point de collecte pour qu''il soit desservi'),
    ('arret_min', 5, 'Durée moyenne d''un arrêt de collecte (minutes), ajoutée au temps de trajet d''une tournée'),
    ('constat_ancien_j', 30, 'Un point sans constat depuis plus de ce nombre de jours est signalé « à revoir »')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION dech.param(k text) RETURNS numeric LANGUAGE sql STABLE AS
    $$ SELECT valeur FROM dech.parametres WHERE cle = k $$;

-- ---------------------------------------------------------------- points de collecte et dépotoirs
CREATE TABLE IF NOT EXISTS dech.points (
    id               serial PRIMARY KEY,
    numero           text NOT NULL UNIQUE,                  -- ex. DS-00012 (dépôt sauvage), PC-00003…
    uid              uuid UNIQUE,                           -- saisie hors connexion : évite les doublons
    type             text NOT NULL
                     CHECK (type IN ('Dépôt sauvage', 'Dépotoir autorisé', 'Bac / conteneur', 'Point de regroupement',
                                     'Centre de transfert', 'Décharge finale')),
    nom              text,
    etat             text NOT NULL DEFAULT 'Actif'
                     CHECK (etat IN ('Actif', 'Saturé', 'Fermé', 'Résorbé')),
    volume_m3        numeric(8, 1) CHECK (volume_m3 >= 0),       -- volume estimé des déchets présents
    capacite_m3      numeric(8, 1) CHECK (capacite_m3 >= 0),     -- capacité (bac, conteneur, dépotoir)
    acces            text NOT NULL DEFAULT 'Camion'
                     CHECK (acces IN ('Camion', 'Tricycle', 'Charrette / à pied')),
    description      text,
    quartier         text,
    photo            bytea,
    geom             geometry(Point, 4326) NOT NULL,
    verifie          boolean NOT NULL DEFAULT false,              -- vérifié par le service : publié sur la carte publique
    verifie_le       timestamptz,
    verifie_par      integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    dernier_constat  timestamptz NOT NULL DEFAULT now(),
    resorbe_le       timestamptz,                                -- dépôt sauvage nettoyé, ou point fermé
    contribution     integer REFERENCES contrib.contributions(id) ON DELETE SET NULL,   -- signalement d'origine
    cree_le          timestamptz NOT NULL DEFAULT now(),
    cree_par         integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    modifie_le       timestamptz
);
CREATE INDEX IF NOT EXISTS points_geom_idx ON dech.points USING gist (geom);
CREATE INDEX IF NOT EXISTS points_geom_m_idx ON dech.points USING gist (ST_Transform(geom, 32628));

-- Constats successifs (état, volume, photo) : historique de chaque point
CREATE TABLE IF NOT EXISTS dech.constats (
    id           bigserial PRIMARY KEY,
    point        integer NOT NULL REFERENCES dech.points(id) ON DELETE CASCADE,
    date         timestamptz NOT NULL DEFAULT now(),
    utilisateur  integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    action       text NOT NULL,
    etat_avant   text,
    etat_apres   text,
    volume_m3    numeric(8, 1),
    commentaire  text,
    photo        bytea
);
CREATE INDEX IF NOT EXISTS constats_point_idx ON dech.constats (point, date);

-- ---------------------------------------------------------------- tournées de collecte
CREATE TABLE IF NOT EXISTS dech.tournees (
    id            serial PRIMARY KEY,
    code          text NOT NULL UNIQUE,                       -- ex. T-03
    nom           text NOT NULL,
    jours         smallint[] NOT NULL DEFAULT '{}',           -- 1 = lundi … 7 = dimanche
    heure_depart  time,
    moyen         text NOT NULL DEFAULT 'Camion'
                  CHECK (moyen IN ('Camion', 'Tricycle', 'Charrette / à pied')),
    vehicule      text,                                       -- immatriculation, numéro du tricycle…
    equipe        text,                                       -- chauffeur, ripeurs
    prestataire   text,                                       -- régie communale, GIE, PME de collecte…
    points        integer[] NOT NULL DEFAULT '{}',            -- ordre de passage
    geom          geometry(LineString, 4326),                 -- trajet (calculé sur la voirie ou tracé à la main)
    longueur_m    numeric(10, 0),
    duree_min     numeric(6, 0),                              -- trajet + arrêts
    trace_manuel  boolean NOT NULL DEFAULT false,
    active        boolean NOT NULL DEFAULT true,
    observations  text,
    cree_le       timestamptz NOT NULL DEFAULT now(),
    cree_par      integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    modifie_le    timestamptz
);
CREATE INDEX IF NOT EXISTS tournees_geom_idx ON dech.tournees USING gist (geom);

-- ---------------------------------------------------------------- passages (suivi sur le terrain)
CREATE TABLE IF NOT EXISTS dech.passages (
    id           serial PRIMARY KEY,
    uid          uuid NOT NULL UNIQUE,                        -- créé par le téléphone : envoi hors connexion sans doublon
    tournee      integer NOT NULL REFERENCES dech.tournees(id) ON DELETE CASCADE,
    date         date NOT NULL DEFAULT current_date,
    debut        timestamptz NOT NULL DEFAULT now(),
    fin          timestamptz,
    statut       text NOT NULL DEFAULT 'En cours' CHECK (statut IN ('En cours', 'Terminé', 'Annulé')),
    points       integer[] NOT NULL DEFAULT '{}',             -- points prévus (copie de la tournée au départ)
    agent        integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    commentaire  text
);
CREATE INDEX IF NOT EXISTS passages_tournee_idx ON dech.passages (tournee, date);

CREATE TABLE IF NOT EXISTS dech.passages_points (
    passage      integer NOT NULL REFERENCES dech.passages(id) ON DELETE CASCADE,
    point        integer NOT NULL REFERENCES dech.points(id) ON DELETE CASCADE,
    statut       text NOT NULL CHECK (statut IN ('Collecté', 'Non collecté', 'Saturé')),
    motif        text,
    heure        timestamptz NOT NULL DEFAULT now(),
    agent        integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    PRIMARY KEY (passage, point)
);

-- ---------------------------------------------------------------- couverture du service
-- Centre de chaque bâtiment et son quartier (recalculé quand le bâti de référence change)
CREATE TABLE IF NOT EXISTS dech.bati_quartier (
    gid       integer PRIMARY KEY,
    quartier  text,
    p         geometry(Point, 32628) NOT NULL
);
CREATE INDEX IF NOT EXISTS bati_quartier_p_idx ON dech.bati_quartier USING gist (p);
