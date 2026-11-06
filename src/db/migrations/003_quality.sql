-- ============================================================
-- 003_quality.sql
-- IDE Nacional (IDEP) – Quality control reports and check results
-- ============================================================

BEGIN;

-- ── ide.quality_reports ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.quality_reports (
    id                    SERIAL PRIMARY KEY,
    upload_id             INT  REFERENCES ide.uploads(id)   ON DELETE SET NULL,
    dataset_id            INT  REFERENCES ide.datasets(id)  ON DELETE SET NULL,
    servicio_id           INT,                               -- FK added in 006_services
    tipo_recurso          VARCHAR(20) NOT NULL DEFAULT 'dato'
                              CHECK (tipo_recurso IN ('dato', 'servicio', 'documentacion')),
    resultado_global      VARCHAR(20)
                              CHECK (resultado_global IN (
                                  'aprobado', 'aprobado_con_advertencias', 'rechazado'
                              )),
    score                 INT          NOT NULL DEFAULT 0,
    total_checks          INT          NOT NULL DEFAULT 0,
    checks_ok             INT          NOT NULL DEFAULT 0,
    checks_advertencia    INT          NOT NULL DEFAULT 0,
    checks_falla          INT          NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quality_reports_upload   ON ide.quality_reports(upload_id);
CREATE INDEX IF NOT EXISTS idx_quality_reports_dataset  ON ide.quality_reports(dataset_id);
CREATE INDEX IF NOT EXISTS idx_quality_reports_servicio ON ide.quality_reports(servicio_id);

-- ── ide.quality_check_results ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.quality_check_results (
    id                  SERIAL PRIMARY KEY,
    report_id           INT         NOT NULL REFERENCES ide.quality_reports(id) ON DELETE CASCADE,
    elemento_iso19157   VARCHAR(200),
    chequeo             VARCHAR(200) NOT NULL,
    resultado           VARCHAR(20)
                            CHECK (resultado IN ('pasa', 'advertencia', 'falla')),
    valor_obtenido      TEXT,
    umbral              TEXT,
    es_bloqueante       BOOL         NOT NULL DEFAULT false,
    detalles            JSONB,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quality_check_results_report ON ide.quality_check_results(report_id);

COMMIT;
