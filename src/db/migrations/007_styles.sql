-- ============================================================
-- 007_styles.sql
-- IDE Nacional (IDEP) – Cartographic styles (SLD / LYR) and FK back-fill
-- ============================================================

BEGIN;

-- ── ide.styles ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.styles (
    id                      SERIAL PRIMARY KEY,
    entidad_id              INT          REFERENCES ide.entidades(id) ON DELETE SET NULL,
    nombre                  VARCHAR(200) NOT NULL,
    descripcion             TEXT,
    tipo_geometria          VARCHAR(20)
                                CHECK (tipo_geometria IN ('Point', 'LineString', 'Polygon', 'Raster', 'Any')),
    sld_content             TEXT,
    lyr_nombre_original     VARCHAR(500),
    lyr_ruta                VARCHAR(1000),
    geoserver_style_name    VARCHAR(200),
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_styles_entidad ON ide.styles(entidad_id);

-- ── Back-fill FK: ide.feature_types.style_id → ide.styles(id) ─────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_feature_types_style'
    ) THEN
        ALTER TABLE ide.feature_types
            ADD CONSTRAINT fk_feature_types_style
                FOREIGN KEY (style_id) REFERENCES ide.styles(id) ON DELETE SET NULL;
    END IF;
END
$$;

COMMIT;
