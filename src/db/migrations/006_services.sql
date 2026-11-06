-- ============================================================
-- 006_services.sql
-- IDE Nacional (IDEP) – OGC services, health monitoring, uptime tracking
-- ============================================================

BEGIN;

-- ── ide.services ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.services (
    id                       SERIAL PRIMARY KEY,
    entidad_id               INT           NOT NULL REFERENCES ide.entidades(id) ON DELETE RESTRICT,
    dataset_id               INT           REFERENCES ide.datasets(id) ON DELETE SET NULL,
    nombre                   VARCHAR(300)  NOT NULL,
    tipo                     VARCHAR(20)   NOT NULL
                                 CHECK (tipo IN ('WMS', 'WFS', 'WCS')),
    url_base                 VARCHAR(1000) NOT NULL,
    workspace                VARCHAR(100),
    layer_name               VARCHAR(200),
    version_ogc              VARCHAR(20)   NOT NULL DEFAULT '1.1.0',
    intervalo_chequeo_min    INT           NOT NULL DEFAULT 60,
    estado                   VARCHAR(20)   NOT NULL DEFAULT 'activo'
                                 CHECK (estado IN ('activo', 'caido', 'degradado', 'inactivo')),
    fallos_consecutivos      INT           NOT NULL DEFAULT 0,
    ultimo_chequeo           TIMESTAMPTZ,
    tiene_replica            BOOL          NOT NULL DEFAULT false,
    replica_tabla            VARCHAR(200),
    replica_ultima_sync      TIMESTAMPTZ,
    replica_intervalo_horas  INT           NOT NULL DEFAULT 24,
    tema_codigo              VARCHAR(10),
    subtema_codigo           VARCHAR(10),
    codigo_unico             VARCHAR(50),
    created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_services_entidad       ON ide.services(entidad_id);
CREATE INDEX IF NOT EXISTS idx_services_estado        ON ide.services(estado);
CREATE INDEX IF NOT EXISTS idx_services_dataset       ON ide.services(dataset_id);
CREATE INDEX IF NOT EXISTS idx_services_codigo_unico  ON ide.services(codigo_unico);

-- ── ide.service_config_backups ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.service_config_backups (
    id          SERIAL PRIMARY KEY,
    service_id  INT         NOT NULL REFERENCES ide.services(id) ON DELETE CASCADE,
    snapshot    JSONB       NOT NULL,
    motivo      VARCHAR(50) NOT NULL DEFAULT 'publicacion'
                    CHECK (motivo IN ('publicacion', 'programado', 'manual', 'pre_restore')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_config_backups_service ON ide.service_config_backups(service_id);

-- ── ide.service_health_checks ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.service_health_checks (
    id             SERIAL PRIMARY KEY,
    service_id     INT         NOT NULL REFERENCES ide.services(id) ON DELETE CASCADE,
    ok             BOOL        NOT NULL,
    latencia_ms    INT,
    estado_http    INT,
    error_mensaje  TEXT,
    tipo_sonda     VARCHAR(20) NOT NULL DEFAULT 'capabilities',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_health_checks_service    ON ide.service_health_checks(service_id);
CREATE INDEX IF NOT EXISTS idx_service_health_checks_created_at ON ide.service_health_checks(created_at DESC);

-- ── ide.service_uptime_daily ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.service_uptime_daily (
    id           SERIAL PRIMARY KEY,
    service_id   INT           NOT NULL REFERENCES ide.services(id) ON DELETE CASCADE,
    fecha        DATE          NOT NULL,
    total_checks INT           NOT NULL DEFAULT 0,
    checks_ok    INT           NOT NULL DEFAULT 0,
    uptime_pct   NUMERIC(5,2),
    UNIQUE (service_id, fecha)
);

CREATE INDEX IF NOT EXISTS idx_service_uptime_daily_service ON ide.service_uptime_daily(service_id);
CREATE INDEX IF NOT EXISTS idx_service_uptime_daily_fecha   ON ide.service_uptime_daily(fecha DESC);

-- ── Back-fill FKs that reference ide.services ─────────────────────────────
-- quality_reports.servicio_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_quality_reports_servicio'
    ) THEN
        ALTER TABLE ide.quality_reports
            ADD CONSTRAINT fk_quality_reports_servicio
                FOREIGN KEY (servicio_id) REFERENCES ide.services(id) ON DELETE SET NULL;
    END IF;
END
$$;

-- metadata_records.servicio_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_metadata_records_servicio'
    ) THEN
        ALTER TABLE ide.metadata_records
            ADD CONSTRAINT fk_metadata_records_servicio
                FOREIGN KEY (servicio_id) REFERENCES ide.services(id) ON DELETE SET NULL;
    END IF;
END
$$;

-- feature_catalogues.servicio_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_feature_catalogues_servicio'
    ) THEN
        ALTER TABLE ide.feature_catalogues
            ADD CONSTRAINT fk_feature_catalogues_servicio
                FOREIGN KEY (servicio_id) REFERENCES ide.services(id) ON DELETE SET NULL;
    END IF;
END
$$;

COMMIT;
