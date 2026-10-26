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
