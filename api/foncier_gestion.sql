-- Module foncier (suite) — titulaires, pièces, litiges, fiches parcellaires, fiscalité.
-- Idempotent : appliqué à chaque démarrage de l'API, après foncier.sql.
-- Données personnelles (titulaires, pièces, parties d'un litige) : réservées au service Urbanisme et domaines
-- et aux superviseurs ; jamais publiées.

-- ---------------------------------------------------------------- titulaires des droits
CREATE TABLE IF NOT EXISTS fon.titulaires (
    id              serial PRIMARY KEY,
    parcelle        integer NOT NULL REFERENCES fon.parcelles(id) ON DELETE CASCADE,
    nom             text NOT NULL,
    type_personne   text NOT NULL DEFAULT 'Personne physique'
                    CHECK (type_personne IN ('Personne physique', 'Personne morale', 'Famille (indivision)', 'Commune', 'État')),
    qualite         text NOT NULL DEFAULT 'Propriétaire'
                    CHECK (qualite IN ('Propriétaire', 'Copropriétaire', 'Héritier', 'Usufruitier', 'Occupant', 'Locataire')),
    part            text,                                   -- ex. 1/2, 25 %
    telephone       text,
    piece_identite  text,
    adresse         text,
    debut           date,
    fin             date,
    actif           boolean NOT NULL DEFAULT true,
    dossier         integer REFERENCES fon.dossiers(id) ON DELETE SET NULL,   -- dossier qui a créé ou clos le droit
    observations    text,
    cree_le         timestamptz NOT NULL DEFAULT now(),
    cree_par        integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    modifie_le      timestamptz
);
CREATE INDEX IF NOT EXISTS titulaires_parcelle_idx ON fon.titulaires (parcelle);
CREATE INDEX IF NOT EXISTS titulaires_nom_idx ON fon.titulaires (lower(nom));

-- ---------------------------------------------------------------- litiges fonciers
-- Signalé → En médiation → Résolu à l'amiable | Transmis au tribunal → Clos
CREATE TABLE IF NOT EXISTS fon.litiges (
    id               serial PRIMARY KEY,
    numero           text NOT NULL UNIQUE,                 -- ex. LF-2026-0003
    type             text NOT NULL
                     CHECK (type IN ('Limites', 'Double attribution', 'Occupation sans droit', 'Succession',
                                     'Empiètement sur le domaine public', 'Vente contestée', 'Autre')),
    statut           text NOT NULL DEFAULT 'Signalé'
                     CHECK (statut IN ('Signalé', 'En médiation', 'Résolu à l''amiable', 'Transmis au tribunal', 'Clos')),
    parcelles        integer[] NOT NULL DEFAULT '{}',
    geom             geometry(Point, 4326) NOT NULL,
    quartier         text,
    parties          text,                                  -- personnes en conflit (données personnelles)
    description      text NOT NULL,
    mediateur        integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    prochaine_etape  date,                                  -- prochaine réunion de médiation ou audience
    resolution       text,
    declare_le       timestamptz NOT NULL DEFAULT now(),
    declare_par      integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    clos_le          timestamptz,
    modifie_le       timestamptz
);
CREATE INDEX IF NOT EXISTS litiges_parcelles_idx ON fon.litiges USING gin (parcelles);
CREATE INDEX IF NOT EXISTS litiges_geom_idx ON fon.litiges USING gist (geom);

CREATE TABLE IF NOT EXISTS fon.litiges_historique (
    id            bigserial PRIMARY KEY,
    litige        integer NOT NULL REFERENCES fon.litiges(id) ON DELETE CASCADE,
    date          timestamptz NOT NULL DEFAULT now(),
    utilisateur   integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    action        text NOT NULL,
    statut_avant  text,
    statut_apres  text,
    commentaire   text
);
CREATE INDEX IF NOT EXISTS litiges_historique_idx ON fon.litiges_historique (litige, date);

-- ---------------------------------------------------------------- pièces (actes scannés, plans, quittances…)
CREATE TABLE IF NOT EXISTS fon.pieces (
    id           bigserial PRIMARY KEY,
    parcelle     integer REFERENCES fon.parcelles(id) ON DELETE CASCADE,
    dossier      integer REFERENCES fon.dossiers(id) ON DELETE CASCADE,
    litige       integer REFERENCES fon.litiges(id) ON DELETE CASCADE,
    type         text NOT NULL
                 CHECK (type IN ('Titre foncier', 'Permis d''habiter', 'Attestation de cession', 'Acte de vente',
                                 'Acte de succession', 'Plan de bornage', 'Plan de lotissement', 'Procès-verbal',
                                 'Pièce d''identité', 'Quittance', 'Décision', 'Photo', 'Autre')),
    description  text,
    nom_fichier  text NOT NULL,
    mime         text NOT NULL CHECK (mime IN ('application/pdf', 'image/jpeg', 'image/png')),
    taille       integer NOT NULL,
    contenu      bytea NOT NULL,
    ajoute_le    timestamptz NOT NULL DEFAULT now(),
    ajoute_par   integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL,
    CHECK (parcelle IS NOT NULL OR dossier IS NOT NULL OR litige IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS pieces_parcelle_idx ON fon.pieces (parcelle);
CREATE INDEX IF NOT EXISTS pieces_dossier_idx ON fon.pieces (dossier);
CREATE INDEX IF NOT EXISTS pieces_litige_idx ON fon.pieces (litige);

-- ---------------------------------------------------------------- fiches parcellaires délivrées
CREATE TABLE IF NOT EXISTS fon.fiches (
    id           serial PRIMARY KEY,
    numero       text NOT NULL UNIQUE,                     -- ex. FP-2026-00012
    code         text NOT NULL,                            -- code de vérification imprimé sur la fiche
    parcelle     integer NOT NULL REFERENCES fon.parcelles(id) ON DELETE CASCADE,
    demandeur    text,
    motif        text,
    empreinte    text NOT NULL,                            -- empreinte des limites au moment de la délivrance
    resume       jsonb NOT NULL,                           -- ce que la vérification publique peut montrer
    delivre_le   timestamptz NOT NULL DEFAULT now(),
    delivre_par  integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS fiches_parcelle_idx ON fon.fiches (parcelle);

-- ---------------------------------------------------------------- fiscalité locale (estimation)
-- Barème indicatif, à fixer par le service des finances selon la loi de finances en vigueur.
CREATE TABLE IF NOT EXISTS fon.zones_fiscales (
    quartier  text PRIMARY KEY,
    zone      text NOT NULL DEFAULT 'B' CHECK (zone IN ('A', 'B', 'C'))
);
INSERT INTO fon.zones_fiscales (quartier) SELECT nom FROM ref.quartiers ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS fon.bareme (
    zone        text PRIMARY KEY CHECK (zone IN ('A', 'B', 'C')),
    libelle     text NOT NULL,
    terrain_m2  numeric NOT NULL,     -- GNF par m² de terrain
    bati_m2     numeric NOT NULL,     -- GNF par m² d'emprise bâtie
    minimum     numeric NOT NULL      -- montant minimal (GNF)
);
INSERT INTO fon.bareme VALUES
    ('A', 'Centre-ville, axes commerçants', 100, 1000, 50000),
    ('B', 'Quartiers urbains', 60, 600, 30000),
    ('C', 'Quartiers périphériques', 30, 300, 20000)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS fon.coef_usage (
    usage    text PRIMARY KEY,
    coef     numeric NOT NULL,
    exonere  boolean NOT NULL DEFAULT false
);
INSERT INTO fon.coef_usage VALUES
    ('Habitation', 1, false), ('Commerce', 2, false), ('Mixte', 1.5, false), ('Équipement public', 0, true),
    ('Culte', 0, true), ('Agricole', 0.3, false), ('Espace vert', 0, true), ('Réserve', 0, true),
    ('Non bâti', 1, false), ('Autre', 1, false)
ON CONFLICT DO NOTHING;
INSERT INTO fon.parametres VALUES ('bareme_a_valider', 1, 'Barème fiscal d''exemple, encore à valider par le service des finances (1 = oui)')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS fon.paiements (
    id            serial PRIMARY KEY,
    parcelle      integer NOT NULL REFERENCES fon.parcelles(id),
    annee         integer NOT NULL CHECK (annee BETWEEN 2000 AND 2100),
    montant       numeric(14, 0) NOT NULL CHECK (montant > 0),
    paye_le       date NOT NULL DEFAULT current_date,
    quittance     text,
    mode          text NOT NULL DEFAULT 'Espèces' CHECK (mode IN ('Espèces', 'Mobile money', 'Virement', 'Chèque')),
    observations  text,
    saisi_le      timestamptz NOT NULL DEFAULT now(),
    saisi_par     integer REFERENCES app.utilisateurs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS paiements_parcelle_idx ON fon.paiements (parcelle, annee);

-- Assiette et montant estimés de chaque parcelle active (emprise bâtie calculée avec le bâti de référence)
CREATE OR REPLACE VIEW fon.assiette AS
    SELECT p.id, p.numero, p.quartier, p.usage, p.statut_juridique, p.superficie_m2::float AS superficie_m2,
           round(COALESCE(b.s, 0)::numeric, 1)::float AS bati_m2, z.zone, cu.coef::float AS coef,
           (cu.exonere OR p.statut_juridique IN ('Domaine public', 'Réserve communale')) AS exonere,
           CASE WHEN cu.exonere OR p.statut_juridique IN ('Domaine public', 'Réserve communale') THEN 0
                ELSE round(GREATEST(br.minimum, (p.superficie_m2 * br.terrain_m2 + COALESCE(b.s, 0) * br.bati_m2) * cu.coef) / 100) * 100
           END::float AS montant
    FROM fon.parcelles p
    LEFT JOIN LATERAL (
        SELECT sum(ST_Area(ST_Intersection(ST_MakeValid(ST_Transform(r.geom, 32628)), p.geom_m))) AS s
        FROM ref.batiments r WHERE r.geom && p.geom AND ST_Intersects(r.geom, p.geom)
    ) b ON true
    CROSS JOIN LATERAL (SELECT COALESCE((SELECT zone FROM fon.zones_fiscales WHERE quartier = p.quartier), 'B') AS zone) z
    JOIN fon.bareme br ON br.zone = z.zone
    JOIN fon.coef_usage cu ON cu.usage = p.usage
    WHERE p.etat <> 'Archivée';
