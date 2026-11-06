-- ============================================================
-- 005_feature_catalogue.sql
-- IDE Nacional (IDEP) – ISO 19110 Feature catalogue
-- ============================================================

BEGIN;

-- ── ide.feature_catalogues ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.feature_catalogues (
    id                SERIAL PRIMARY KEY,
    dataset_id        INT          REFERENCES ide.datasets(id) ON DELETE SET NULL,
    servicio_id       INT,                                       -- FK added in 006_services
    nombre            VARCHAR(300) NOT NULL,
    scope             TEXT,
    version_catalogo  VARCHAR(50)  NOT NULL DEFAULT '1.0',
    productor         VARCHAR(200),
    xml_iso19110      TEXT,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feature_catalogues_dataset  ON ide.feature_catalogues(dataset_id);

-- ── ide.feature_types ────────────────────────────────────────────────────
-- style_id FK is deferred; added after ide.styles is created in 007_styles.sql
CREATE TABLE IF NOT EXISTS ide.feature_types (
    id             SERIAL PRIMARY KEY,
    catalogue_id   INT         NOT NULL REFERENCES ide.feature_catalogues(id) ON DELETE CASCADE,
    nombre         VARCHAR(200) NOT NULL,
    definicion     TEXT,
    alias          VARCHAR(200),
    tabla_postgis  VARCHAR(200),
    style_id       INT,                             -- FK added in 007_styles.sql
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feature_types_catalogue ON ide.feature_types(catalogue_id);

-- ── ide.feature_attributes ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.feature_attributes (
    id               SERIAL PRIMARY KEY,
    feature_type_id  INT          NOT NULL REFERENCES ide.feature_types(id) ON DELETE CASCADE,
    nombre           VARCHAR(200) NOT NULL,
    alias            VARCHAR(200),
    definicion       TEXT,
    tipo_dato        VARCHAR(100),
    tipo_dominio     VARCHAR(20)  NOT NULL DEFAULT 'libre'
                         CHECK (tipo_dominio IN ('libre', 'enumerado', 'rango', 'codelist')),
    obligatorio      BOOL         NOT NULL DEFAULT false,
    orden            INT          NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feature_attributes_type ON ide.feature_attributes(feature_type_id);

-- ── ide.attribute_domain_values ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.attribute_domain_values (
    id            SERIAL PRIMARY KEY,
    attribute_id  INT          NOT NULL REFERENCES ide.feature_attributes(id) ON DELETE CASCADE,
    codigo        VARCHAR(100) NOT NULL,
    descripcion   TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attr_domain_values_attr ON ide.attribute_domain_values(attribute_id);

COMMIT;
