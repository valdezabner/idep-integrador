-- ============================================================
-- 008_resources_view.sql
-- IDE Nacional (IDEP) – Unified view of datasets and services
-- ============================================================

BEGIN;

-- Drop and recreate so re-running the migration is idempotent
DROP VIEW IF EXISTS ide.recursos;

CREATE VIEW ide.recursos AS
-- ── Datasets ─────────────────────────────────────────────────────────────
SELECT
    d.id                                                    AS id,
    'dataset'::VARCHAR(10)                                  AS tipo_recurso,
    d.nombre                                                AS titulo,
    d.descripcion                                           AS descripcion,
    d.entidad_id                                            AS entidad_id,
    e.nombre                                                AS entidad_nombre,
    e.codigo                                                AS entidad_codigo,
    d.estado                                                AS estado,
    d.codigo_unico                                          AS codigo_unico,

    -- score from the latest quality report (may be NULL)
    qr.score                                                AS quality_score,

    -- tema / subtema classification
    d.tema_codigo                                           AS tema_codigo,
    d.subtema_codigo                                        AS subtema_codigo,

    -- derived booleans
    (EXISTS (
        SELECT 1 FROM ide.metadata_records mr
        WHERE mr.dataset_id = d.id
    ))::BOOL                                                AS tiene_metadatos,

    (EXISTS (
        SELECT 1 FROM ide.feature_catalogues fc
        WHERE fc.dataset_id = d.id
    ))::BOOL                                                AS tiene_catalogo,

    d.created_at                                            AS created_at,
    d.updated_at                                            AS updated_at

FROM ide.datasets d
JOIN ide.entidades e ON e.id = d.entidad_id
LEFT JOIN LATERAL (
    SELECT score
    FROM ide.quality_reports
    WHERE dataset_id = d.id
    ORDER BY created_at DESC
    LIMIT 1
) qr ON true

UNION ALL

-- ── Services ──────────────────────────────────────────────────────────────
SELECT
    s.id                                                    AS id,
    'servicio'::VARCHAR(10)                                 AS tipo_recurso,
    s.nombre                                                AS titulo,
    NULL::TEXT                                              AS descripcion,
    s.entidad_id                                            AS entidad_id,
    e.nombre                                                AS entidad_nombre,
    e.codigo                                                AS entidad_codigo,
    s.estado                                                AS estado,
    s.codigo_unico                                          AS codigo_unico,

    qr.score                                                AS quality_score,

    s.tema_codigo                                           AS tema_codigo,
    s.subtema_codigo                                        AS subtema_codigo,

    (EXISTS (
        SELECT 1 FROM ide.metadata_records mr
        WHERE mr.servicio_id = s.id
    ))::BOOL                                                AS tiene_metadatos,

    (EXISTS (
        SELECT 1 FROM ide.feature_catalogues fc
        WHERE fc.servicio_id = s.id
    ))::BOOL                                                AS tiene_catalogo,

    s.created_at                                            AS created_at,
    s.updated_at                                            AS updated_at

FROM ide.services s
JOIN ide.entidades e ON e.id = s.entidad_id
LEFT JOIN LATERAL (
    SELECT score
    FROM ide.quality_reports
    WHERE servicio_id = s.id
    ORDER BY created_at DESC
    LIMIT 1
) qr ON true;

COMMENT ON VIEW ide.recursos IS
    'Unified catalogue view joining datasets and services with entity info, '
    'quality scores, classification codes, and derived metadata/catalogue flags.';

COMMIT;
