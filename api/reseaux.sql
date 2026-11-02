-- Réseaux : éclairage public, bornes-fontaines, pannes et fuites (interventions).
-- Idempotent : appliqué à chaque démarrage de l'API.
-- Les grands réseaux (lignes EDG, conduites SEG) ne sont pas gérés ici : seulement ce que la commune gère ou reçoit.
CREATE SCHEMA IF NOT EXISTS res;

CREATE TABLE IF NOT EXISTS res.parametres (
    cle          text PRIMARY KEY,
    valeur       numeric NOT NULL,
    description  text NOT NULL
);
INSERT INTO res.parametres VALUES
    ('portee_lampadaire_m', 25, 'Longueur de rue éclairée de part et d''autre d''un lampadaire (m)'),
    ('distance_borne_m', 500, 'Distance maximale entre un bâtiment et une borne-fontaine en service (m)'),
    ('delai_panne_j', 7, 'Délai visé pour réparer une panne d''éclairage (jours)'),
    ('delai_fuite_j', 3, 'Délai visé pour réparer une fuite ou une borne (jours)')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION res.param(k text) RETURNS numeric LANGUAGE sql STABLE AS
    $$ SELECT valeur FROM res.parametres WHERE cle = k $$;

-- ---------------------------------------------------------------- éclairage public
CREATE TABLE IF NOT EXISTS res.lampadaires (
    id            serial PRIMARY KEY,
    numero        text NOT NULL UNIQUE,                       -- ex. LP-0042
    uid           uuid UNIQUE,                                -- saisie hors connexion
    alimentation  text NOT NULL DEFAULT 'Solaire' CHECK (alimentation IN ('Solaire', 'Réseau électrique')),
    lampe         text CHECK (lampe IN ('LED', 'Sodium', 'Fluorescente', 'Autre')),
    puissance_w   integer CHECK (puissance_w > 0),
    hauteur_m     numeric(4, 1),
    etat          text NOT NULL DEFAULT 'En service'
                  CHECK (etat IN ('En service', 'En panne', 'Hors service', 'Volé / détruit')),
    gestionnaire  text,                                       -- commune, projet, EDG…
    date_pose     date,
    voie          text,                                       -- rue la plus proche (calculée)
    quartier      text,
    observations  text,
    photo         bytea,
    geom          geometry(Point, 4326) NOT NULL,
    dernier_constat timestamptz NOT NULL DEFAULT now(),
    cree_le       timestamptz NOT NULL DEFAULT now(),
    cree_par      integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    modifie_le    timestamptz
);
CREATE INDEX IF NOT EXISTS lampadaires_geom_idx ON res.lampadaires USING gist (geom);

-- ---------------------------------------------------------------- bornes-fontaines et points d'eau potable
CREATE TABLE IF NOT EXISTS res.bornes (
    id            serial PRIMARY KEY,
    numero        text NOT NULL UNIQUE,                       -- ex. BF-0007
    uid           uuid UNIQUE,
    type          text NOT NULL DEFAULT 'Borne-fontaine'
                  CHECK (type IN ('Borne-fontaine', 'Kiosque à eau', 'Forage équipé (pompe)')),
    nom           text,
    etat          text NOT NULL DEFAULT 'En service'
                  CHECK (etat IN ('En service', 'Débit faible', 'En panne', 'Fermée')),
    gestionnaire  text,                                       -- SEG, commune, comité de gestion, privé
    robinets      integer CHECK (robinets >= 0),
    payante       boolean NOT NULL DEFAULT true,
    prix_gnf      numeric(10, 0),                             -- prix d'un bidon de 20 litres
    horaires      text,
    quartier      text,
    observations  text,
    photo         bytea,
    geom          geometry(Point, 4326) NOT NULL,
    dernier_constat timestamptz NOT NULL DEFAULT now(),
    cree_le       timestamptz NOT NULL DEFAULT now(),
    cree_par      integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    modifie_le    timestamptz
);
CREATE INDEX IF NOT EXISTS bornes_geom_idx ON res.bornes USING gist (geom);

-- ---------------------------------------------------------------- pannes et fuites
-- Signalée → Transmise (EDG, SEG, entreprise) → En réparation → Réparée ; ou Classée sans suite
CREATE TABLE IF NOT EXISTS res.interventions (
    id            serial PRIMARY KEY,
    numero        text NOT NULL UNIQUE,                       -- ex. PA-2026-0003 (panne), FU-2026-0011 (fuite)
    uid           uuid UNIQUE,
    reseau        text NOT NULL CHECK (reseau IN ('Éclairage', 'Eau')),
    nature        text NOT NULL,
    statut        text NOT NULL DEFAULT 'Signalée'
                  CHECK (statut IN ('Signalée', 'Transmise', 'En réparation', 'Réparée', 'Classée sans suite')),
    urgence       text NOT NULL DEFAULT 'Normale' CHECK (urgence IN ('Normale', 'Urgente')),
    description   text,
    lampadaire    integer REFERENCES res.lampadaires(id) ON DELETE SET NULL,
    borne         integer REFERENCES res.bornes(id) ON DELETE SET NULL,
    transmise_a   text,                                       -- EDG, SEG, entreprise, équipe municipale
    cout_gnf      numeric(14, 0),
    quartier      text,
    photo         bytea,
    geom          geometry(Point, 4326) NOT NULL,
    contribution  integer REFERENCES contrib.contributions(id) ON DELETE SET NULL,
    cree_le       timestamptz NOT NULL DEFAULT now(),
    cree_par      integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    repare_le     timestamptz,
    modifie_le    timestamptz
);
CREATE INDEX IF NOT EXISTS interventions_geom_idx ON res.interventions USING gist (geom);
CREATE INDEX IF NOT EXISTS interventions_statut_idx ON res.interventions (statut);

CREATE TABLE IF NOT EXISTS res.interventions_historique (
    id            bigserial PRIMARY KEY,
    intervention  integer NOT NULL REFERENCES res.interventions(id) ON DELETE CASCADE,
    date          timestamptz NOT NULL DEFAULT now(),
    utilisateur   integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    action        text NOT NULL,
    statut_avant  text,
    statut_apres  text,
    commentaire   text,
    photo         bytea
);
CREATE INDEX IF NOT EXISTS interventions_historique_idx ON res.interventions_historique (intervention, date);
