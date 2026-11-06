-- ============================================================
-- 002_uploads_datasets.sql
-- IDE Nacional (IDEP) – File uploads and spatial datasets
-- ============================================================

BEGIN;

-- ── ide.uploads ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.uploads (
    id                  SERIAL PRIMARY KEY,
    entidad_id          INT          NOT NULL REFERENCES ide.entidades(id) ON DELETE RESTRICT,
    usuario_id          INT          REFERENCES ide.usuarios(id) ON DELETE SET NULL,
    nombre_original     VARCHAR(500) NOT NULL,
    formato_detectado   VARCHAR(50),
    ruta_archivo        VARCHAR(1000),
    capas_detectadas    JSONB,
    estado              VARCHAR(30)  NOT NULL DEFAULT 'recibido'
                            CHECK (estado IN (
                                'recibido', 'inspeccionado', 'convertido',
                                'validado', 'en_revision', 'publicado', 'rechazado'
                            )),
    log_proceso         JSONB        NOT NULL DEFAULT '[]',
    error_mensaje       TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uploads_entidad  ON ide.uploads(entidad_id);
CREATE INDEX IF NOT EXISTS idx_uploads_usuario  ON ide.uploads(usuario_id);
CREATE INDEX IF NOT EXISTS idx_uploads_estado   ON ide.uploads(estado);

-- ── ide.datasets ──────────────────────────────────────────────────────────
-- version_actual_id FK is deferred; added after dataset_versions is created.
CREATE TABLE IF NOT EXISTS ide.datasets (
    id                   SERIAL PRIMARY KEY,
    entidad_id           INT          NOT NULL REFERENCES ide.entidades(id) ON DELETE RESTRICT,
    usuario_id           INT          REFERENCES ide.usuarios(id) ON DELETE SET NULL,
    nombre               VARCHAR(300) NOT NULL,
    descripcion          TEXT,
    upload_id            INT          REFERENCES ide.uploads(id) ON DELETE SET NULL,
    version_actual_id    INT,                        -- FK added below (deferred)
    estado               VARCHAR(30)  NOT NULL DEFAULT 'borrador'
                            CHECK (estado IN ('borrador', 'en_revision', 'publicado', 'archivado')),
    geoserver_workspace  VARCHAR(100),
    geoserver_layer      VARCHAR(200),
    tema_codigo          VARCHAR(10),
    subtema_codigo       VARCHAR(10),
    codigo_unico         VARCHAR(50),
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_datasets_entidad        ON ide.datasets(entidad_id);
CREATE INDEX IF NOT EXISTS idx_datasets_estado         ON ide.datasets(estado);
CREATE INDEX IF NOT EXISTS idx_datasets_codigo_unico   ON ide.datasets(codigo_unico);

-- ── ide.dataset_versions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.dataset_versions (
    id                SERIAL PRIMARY KEY,
    dataset_id        INT          NOT NULL REFERENCES ide.datasets(id) ON DELETE CASCADE,
    numero_version    INT          NOT NULL,
    tabla_postgis     VARCHAR(200) NOT NULL,
    schema_postgis    VARCHAR(50)  NOT NULL DEFAULT 'datos',
    bbox              JSONB,
    srid              INT,
    conteo_registros  INT,
    hash_contenido    VARCHAR(64),
    estado            VARCHAR(20)  NOT NULL DEFAULT 'activa'
                          CHECK (estado IN ('activa', 'historica', 'rollback')),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (dataset_id, numero_version)
);

CREATE INDEX IF NOT EXISTS idx_dataset_versions_dataset ON ide.dataset_versions(dataset_id);

-- ── Deferred FK: datasets.version_actual_id → dataset_versions(id) ────────
ALTER TABLE ide.datasets
    ADD CONSTRAINT fk_datasets_version_actual
        FOREIGN KEY (version_actual_id)
        REFERENCES ide.dataset_versions(id)
        DEFERRABLE INITIALLY DEFERRED;

COMMIT;
