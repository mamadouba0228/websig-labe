-- Marchés et gares routières : sites, emplacements (boutiques, étals, places), occupants, recettes (droits de place).
-- Idempotent : appliqué à chaque démarrage de l'API.
CREATE SCHEMA IF NOT EXISTS mar;

CREATE TABLE IF NOT EXISTS mar.parametres (
    cle          text PRIMARY KEY,
    valeur       numeric NOT NULL,
    description  text NOT NULL
);
INSERT INTO mar.parametres VALUES
    ('jour_echeance', 10, 'Jour du mois jusqu''auquel le loyer du mois peut être payé sans être compté impayé'),
    ('mois_impayes_max', 12, 'Nombre de mois passés examinés pour les impayés')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION mar.param(k text) RETURNS numeric LANGUAGE sql STABLE AS
    $$ SELECT valeur FROM mar.parametres WHERE cle = k $$;

-- ---------------------------------------------------------------- sites
CREATE TABLE IF NOT EXISTS mar.sites (
    id            serial PRIMARY KEY,
    numero        text NOT NULL UNIQUE,                       -- MA-0001 (marché), GR-0001 (gare routière)
    uid           uuid UNIQUE,                                -- saisie hors connexion
    type          text NOT NULL CHECK (type IN ('Marché quotidien', 'Marché hebdomadaire', 'Marché à bétail', 'Gare routière')),
    nom           text NOT NULL,
    etat          text NOT NULL DEFAULT 'En activité' CHECK (etat IN ('En activité', 'En travaux', 'Fermé')),
    gestion       text NOT NULL DEFAULT 'Régie communale'
                  CHECK (gestion IN ('Régie communale', 'Concession', 'Syndicat ou association', 'Autre')),
    jours         text,                                       -- jours de marché ou d'affluence
    horaires      text,
    responsable   text,                                       -- régisseur, chef de gare
    telephone     text,
    destinations  text,                                       -- gares : villes desservies
    capacite      integer CHECK (capacite >= 0),              -- gares : véhicules en stationnement
    tarif_ticket_gnf numeric(12, 0) CHECK (tarif_ticket_gnf >= 0), -- ticket journalier ou droit de stationnement par véhicule
    quartier      text,
    observations  text,
    photo         bytea,
    geom          geometry(Geometry, 4326) NOT NULL,          -- point ou emprise (surface)
    equipement    integer UNIQUE,                             -- ref.equipements.gid d'origine
    contribution  integer REFERENCES contrib.contributions(id) ON DELETE SET NULL,
    cree_le       timestamptz NOT NULL DEFAULT now(),
    cree_par      integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    modifie_le    timestamptz
);
CREATE INDEX IF NOT EXISTS sites_geom_idx ON mar.sites USING gist (geom);

-- ---------------------------------------------------------------- emplacements
CREATE TABLE IF NOT EXISTS mar.places (
    id            serial PRIMARY KEY,
    numero        text NOT NULL UNIQUE,                       -- MA-0001-001
    uid           uuid UNIQUE,
    site          integer NOT NULL REFERENCES mar.sites(id) ON DELETE CASCADE,
    type          text NOT NULL DEFAULT 'Boutique'
                  CHECK (type IN ('Boutique', 'Magasin', 'Hangar ou étal', 'Table', 'Place au sol', 'Kiosque',
                                  'Bureau de ligne', 'Stationnement', 'Autre')),
    surface_m2    numeric(8, 1) CHECK (surface_m2 > 0),
    loyer_gnf     numeric(12, 0) CHECK (loyer_gnf >= 0),     -- loyer mensuel
    statut        text NOT NULL DEFAULT 'Libre' CHECK (statut IN ('Libre', 'Occupée', 'Hors service')),
    occupant      text,                                       -- données personnelles : service seulement
    telephone     text,
    activite      text,                                       -- tissus, condiments, ligne Labé – Conakry…
    depuis        date,                                       -- début de l'occupation (loyers dus à partir de ce mois)
    observations  text,
    geom          geometry(Point, 4326),                      -- facultatif
    cree_le       timestamptz NOT NULL DEFAULT now(),
    cree_par      integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    modifie_le    timestamptz
);
CREATE INDEX IF NOT EXISTS places_site_idx ON mar.places (site);
CREATE INDEX IF NOT EXISTS places_geom_idx ON mar.places USING gist (geom);

-- ---------------------------------------------------------------- recettes (droits de place)
CREATE TABLE IF NOT EXISTS mar.perceptions (
    id            serial PRIMARY KEY,
    numero        text NOT NULL UNIQUE,                       -- quittance QM-2026-00001
    uid           uuid UNIQUE,
    site          integer NOT NULL REFERENCES mar.sites(id) ON DELETE RESTRICT,
    place         integer REFERENCES mar.places(id) ON DELETE RESTRICT,
    nature        text NOT NULL CHECK (nature IN ('Loyer mensuel', 'Tickets journaliers', 'Droits de stationnement', 'Autre droit')),
    mois          date,                                       -- loyer : premier jour du mois payé
    nombre        integer CHECK (nombre > 0),                 -- tickets vendus ou véhicules
    montant_gnf   numeric(14, 0) NOT NULL CHECK (montant_gnf > 0),
    mode          text NOT NULL DEFAULT 'Espèces' CHECK (mode IN ('Espèces', 'Mobile money', 'Chèque ou virement')),
    payeur        text,
    observation   text,
    date_perception date NOT NULL DEFAULT current_date,
    statut        text NOT NULL DEFAULT 'Valide' CHECK (statut IN ('Valide', 'Annulée')),
    motif_annulation text,
    annulee_par   integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    annulee_le    timestamptz,
    cree_le       timestamptz NOT NULL DEFAULT now(),
    cree_par      integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    CHECK (nature <> 'Loyer mensuel' OR (place IS NOT NULL AND mois IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS perceptions_site_idx ON mar.perceptions (site, date_perception);
CREATE INDEX IF NOT EXISTS perceptions_place_idx ON mar.perceptions (place, mois);
-- un seul loyer valide par place et par mois
CREATE UNIQUE INDEX IF NOT EXISTS perceptions_loyer_unique ON mar.perceptions (place, mois)
    WHERE nature = 'Loyer mensuel' AND statut = 'Valide';
