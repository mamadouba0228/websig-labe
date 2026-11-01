-- Mises à jour automatiques après une modification des couches de référence (QGIS, pgAdmin, corrections validées).
-- Idempotent : appliqué à chaque démarrage de l'API, après les schémas des modules.
--
-- Bâti (ref.batiments) : à chaque ajout, modification de forme ou suppression, on met à jour
--   - le centre du bâtiment en mètres (adr.batiments_points : adressage, foncier) ;
--   - son quartier (dech.bati_quartier : couverture de la collecte des déchets) ;
--   - les adresses d'un bâtiment supprimé (détachées du bâtiment, gardées) ;
--   - le nombre de bâtiments des quartiers concernés (ref.quartiers.nb_batiments).
-- Triggers « par instruction » : un import de milliers de bâtiments reste rapide.

CREATE OR REPLACE FUNCTION ref.bati_points_maj(gids integer[]) RETURNS void LANGUAGE sql AS $$
    DELETE FROM adr.batiments_points b WHERE b.gid = ANY (gids)
        AND NOT EXISTS (SELECT 1 FROM ref.batiments r WHERE r.gid = b.gid AND r.geom IS NOT NULL AND NOT ST_IsEmpty(r.geom));
    INSERT INTO adr.batiments_points (gid, p)
        SELECT gid, ST_Transform(ST_PointOnSurface(geom), 32628) FROM ref.batiments
        WHERE gid = ANY (gids) AND geom IS NOT NULL AND NOT ST_IsEmpty(geom)
    ON CONFLICT (gid) DO UPDATE SET p = EXCLUDED.p;
    DELETE FROM dech.bati_quartier q WHERE q.gid = ANY (gids) AND NOT EXISTS (SELECT 1 FROM adr.batiments_points b WHERE b.gid = q.gid);
    INSERT INTO dech.bati_quartier (gid, quartier, p)
        SELECT b.gid, q.nom, b.p FROM adr.batiments_points b
        LEFT JOIN LATERAL (SELECT nom FROM ref.quartiers q WHERE ST_Contains(q.geom, ST_Transform(b.p, 4326)) LIMIT 1) q ON true
        WHERE b.gid = ANY (gids)
    ON CONFLICT (gid) DO UPDATE SET quartier = EXCLUDED.quartier, p = EXCLUDED.p;
    UPDATE adr.adresses SET batiment_gid = NULL
        WHERE batiment_gid = ANY (gids) AND NOT EXISTS (SELECT 1 FROM ref.batiments r WHERE r.gid = batiment_gid);
$$;

-- Nombre de bâtiments des quartiers qui touchent une emprise (formes avant et après la modification)
CREATE OR REPLACE FUNCTION ref.quartiers_compter(zone geometry) RETURNS void LANGUAGE sql AS $$
    UPDATE ref.quartiers q SET nb_batiments = (
        SELECT count(*) FROM adr.batiments_points b WHERE ST_Contains(ST_Transform(q.geom, 32628), b.p))
    WHERE zone IS NOT NULL AND q.geom && zone;
$$;

CREATE OR REPLACE FUNCTION ref.bati_apres_ajout() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM ref.bati_points_maj((SELECT array_agg(gid) FROM nouveaux));
    PERFORM ref.quartiers_compter((SELECT ST_Extent(geom)::geometry FROM nouveaux));
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION ref.bati_apres_modif() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- seulement si une forme a changé (une modification de « nature » ne touche à rien)
    IF NOT EXISTS (SELECT 1 FROM nouveaux n JOIN anciens a USING (gid) WHERE NOT ST_OrderingEquals(n.geom, a.geom)
                   UNION ALL SELECT 1 FROM nouveaux n WHERE NOT EXISTS (SELECT 1 FROM anciens a WHERE a.gid = n.gid)) THEN
        RETURN NULL;
    END IF;
    PERFORM ref.bati_points_maj((SELECT array_agg(gid) FROM (SELECT gid FROM nouveaux UNION SELECT gid FROM anciens) t));
    PERFORM ref.quartiers_compter((SELECT ST_Extent(geom)::geometry FROM (SELECT geom FROM nouveaux UNION ALL SELECT geom FROM anciens) t));
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION ref.bati_apres_suppression() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM ref.bati_points_maj((SELECT array_agg(gid) FROM anciens));
    PERFORM ref.quartiers_compter((SELECT ST_Extent(geom)::geometry FROM anciens));
    RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER batiments_ajout AFTER INSERT ON ref.batiments
    REFERENCING NEW TABLE AS nouveaux FOR EACH STATEMENT EXECUTE FUNCTION ref.bati_apres_ajout();
CREATE OR REPLACE TRIGGER batiments_modif AFTER UPDATE ON ref.batiments
    REFERENCING OLD TABLE AS anciens NEW TABLE AS nouveaux FOR EACH STATEMENT EXECUTE FUNCTION ref.bati_apres_modif();
CREATE OR REPLACE TRIGGER batiments_suppression AFTER DELETE ON ref.batiments
    REFERENCING OLD TABLE AS anciens FOR EACH STATEMENT EXECUTE FUNCTION ref.bati_apres_suppression();
