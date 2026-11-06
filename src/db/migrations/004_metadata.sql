-- ============================================================
-- 004_metadata.sql
-- IDE Nacional (IDEP) – ISO 19139 metadata records and GeoNetwork sync queue
-- ============================================================

BEGIN;

-- ── ide.metadata_records ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.metadata_records (
    id               SERIAL PRIMARY KEY,
    file_identifier  UUID         NOT NULL UNIQUE DEFAULT gen_random_uuid(),
    dataset_id       INT          REFERENCES ide.datasets(id)  ON DELETE SET NULL,
    servicio_id      INT,                                        -- FK added in 006_services
    tipo_recurso     VARCHAR(20)  NOT NULL DEFAULT 'dataset',
    contenido        JSONB        NOT NULL DEFAULT '{}',
    xml_iso19139     TEXT,
    gn_uuid          VARCHAR(200),
    gn_sync_estado   VARCHAR(20)  NOT NULL DEFAULT 'pendiente'
                         CHECK (gn_sync_estado IN ('pendiente', 'sincronizado', 'error')),
    gn_sync_error    TEXT,
    gn_sync_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_metadata_records_dataset    ON ide.metadata_records(dataset_id);
CREATE INDEX IF NOT EXISTS idx_metadata_records_servicio   ON ide.metadata_records(servicio_id);
CREATE INDEX IF NOT EXISTS idx_metadata_records_gn_estado  ON ide.metadata_records(gn_sync_estado);
CREATE INDEX IF NOT EXISTS idx_metadata_records_gn_uuid    ON ide.metadata_records(gn_uuid);

-- ── ide.sync_queue ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.sync_queue (
    id               SERIAL PRIMARY KEY,
    metadata_id      INT         NOT NULL REFERENCES ide.metadata_records(id) ON DELETE CASCADE,
    intentos         INT         NOT NULL DEFAULT 0,
    proximo_intento  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ultimo_error     TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_metadata        ON ide.sync_queue(metadata_id);
CREATE INDEX IF NOT EXISTS idx_sync_queue_proximo_intento ON ide.sync_queue(proximo_intento)
    WHERE intentos < 10;

COMMIT;
