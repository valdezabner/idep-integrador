-- ============================================================
-- 001_initial.sql
-- IDE Nacional (IDEP) – Core schema: users, roles, audit, notifications
-- ============================================================

BEGIN;

-- ── Schema ────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS ide;

-- ── ide.entidades ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.entidades (
    id                       SERIAL PRIMARY KEY,
    nombre                   VARCHAR(200) NOT NULL,
    codigo                   VARCHAR(20)  UNIQUE NOT NULL,
    sigla                    VARCHAR(10),
    descripcion              TEXT,
    cuota_almacenamiento_mb  INT          NOT NULL DEFAULT 10240,
    activo                   BOOL         NOT NULL DEFAULT true,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── ide.usuarios ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.usuarios (
    id             SERIAL PRIMARY KEY,
    entidad_id     INT REFERENCES ide.entidades(id) ON DELETE SET NULL,
    nombre         VARCHAR(200) NOT NULL,
    email          VARCHAR(200) UNIQUE NOT NULL,
    password_hash  VARCHAR(200) NOT NULL,
    activo         BOOL        NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usuarios_entidad ON ide.usuarios(entidad_id);
CREATE INDEX IF NOT EXISTS idx_usuarios_email   ON ide.usuarios(email);

-- ── ide.roles ─────────────────────────────────────────────────────────────
-- Valid values: admin_ide, admin_entidad, publicador, revisor_qa, consulta
CREATE TABLE IF NOT EXISTS ide.roles (
    id     SERIAL PRIMARY KEY,
    nombre VARCHAR(50) UNIQUE NOT NULL
);

-- ── ide.usuario_roles ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.usuario_roles (
    usuario_id  INT NOT NULL REFERENCES ide.usuarios(id)   ON DELETE CASCADE,
    rol_id      INT NOT NULL REFERENCES ide.roles(id)      ON DELETE CASCADE,
    entidad_id  INT NOT NULL REFERENCES ide.entidades(id)  ON DELETE CASCADE,
    PRIMARY KEY (usuario_id, rol_id, entidad_id)
);

CREATE INDEX IF NOT EXISTS idx_usuario_roles_usuario   ON ide.usuario_roles(usuario_id);
CREATE INDEX IF NOT EXISTS idx_usuario_roles_entidad   ON ide.usuario_roles(entidad_id);

-- ── ide.refresh_tokens ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.refresh_tokens (
    id          SERIAL PRIMARY KEY,
    usuario_id  INT         NOT NULL REFERENCES ide.usuarios(id) ON DELETE CASCADE,
    token_hash  VARCHAR(200) UNIQUE NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    revocado    BOOL        NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_usuario  ON ide.refresh_tokens(usuario_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash     ON ide.refresh_tokens(token_hash);

-- ── ide.audit_log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.audit_log (
    id              BIGSERIAL PRIMARY KEY,
    usuario_id      INT,
    entidad_id      INT,
    accion          VARCHAR(100) NOT NULL,
    tabla_afectada  VARCHAR(100),
    registro_id     INT,
    ip              VARCHAR(50),
    detalle         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit log is append-only: revoke mutating privileges from PUBLIC
REVOKE UPDATE, DELETE ON ide.audit_log FROM PUBLIC;

CREATE INDEX IF NOT EXISTS idx_audit_log_usuario    ON ide.audit_log(usuario_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entidad    ON ide.audit_log(entidad_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON ide.audit_log(created_at DESC);

-- ── ide.notifications ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.notifications (
    id            SERIAL PRIMARY KEY,
    usuario_id    INT         NOT NULL REFERENCES ide.usuarios(id) ON DELETE CASCADE,
    tipo          VARCHAR(50),
    canal         VARCHAR(20)  NOT NULL DEFAULT 'panel',
    mensaje       TEXT         NOT NULL,
    url           VARCHAR(500),
    leido         BOOL         NOT NULL DEFAULT false,
    estado_envio  VARCHAR(20)  NOT NULL DEFAULT 'pendiente',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_usuario ON ide.notifications(usuario_id);
CREATE INDEX IF NOT EXISTS idx_notifications_leido   ON ide.notifications(usuario_id, leido);

-- ── Seed: default roles ───────────────────────────────────────────────────
INSERT INTO ide.roles (nombre) VALUES
    ('admin_ide'),
    ('admin_entidad'),
    ('publicador'),
    ('revisor_qa'),
    ('consulta')
ON CONFLICT (nombre) DO NOTHING;

COMMIT;
