-- ============================================================
-- 009_responsables_clasificacion.sql
-- IDE Nacional (IDEP) – Designated officials (responsables) and
--                        thematic classification catalogue (temas / subtemas)
-- ============================================================

BEGIN;

-- ── ide.responsables ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.responsables (
    id                    SERIAL PRIMARY KEY,
    entidad_id            INT          NOT NULL REFERENCES ide.entidades(id) ON DELETE RESTRICT,
    nombre                VARCHAR(200) NOT NULL,
    cargo                 VARCHAR(200),
    email                 VARCHAR(200),
    telefono              VARCHAR(50),
    resolucion_numero     VARCHAR(100),
    resolucion_fecha      DATE,
    resolucion_pdf_ruta   VARCHAR(1000),
    activo                BOOL         NOT NULL DEFAULT true,
    fecha_cese            DATE,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_responsables_entidad ON ide.responsables(entidad_id);
CREATE INDEX IF NOT EXISTS idx_responsables_activo  ON ide.responsables(entidad_id, activo);

-- ── ide.temas ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.temas (
    codigo      VARCHAR(10)  PRIMARY KEY,
    nombre      VARCHAR(200) NOT NULL,
    descripcion TEXT,
    orden       INT          NOT NULL DEFAULT 0
);

-- ── ide.subtemas ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ide.subtemas (
    codigo      VARCHAR(10)  PRIMARY KEY,
    tema_codigo VARCHAR(10)  NOT NULL REFERENCES ide.temas(codigo) ON DELETE RESTRICT,
    nombre      VARCHAR(200) NOT NULL,
    descripcion TEXT,
    orden       INT          NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_subtemas_tema ON ide.subtemas(tema_codigo);

-- ── Add tema/subtema columns to datasets if missing ──────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ide' AND table_name = 'datasets' AND column_name = 'tema_codigo'
    ) THEN
        ALTER TABLE ide.datasets ADD COLUMN tema_codigo     VARCHAR(10);
        ALTER TABLE ide.datasets ADD COLUMN subtema_codigo  VARCHAR(10);
    END IF;
END
$$;

-- ── Add tema/subtema columns to services if missing ───────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'ide' AND table_name = 'services' AND column_name = 'tema_codigo'
    ) THEN
        ALTER TABLE ide.services ADD COLUMN tema_codigo     VARCHAR(10);
        ALTER TABLE ide.services ADD COLUMN subtema_codigo  VARCHAR(10);
    END IF;
END
$$;

-- ── Add FK constraints for tema/subtema on datasets ──────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_datasets_tema'
    ) THEN
        ALTER TABLE ide.datasets
            ADD CONSTRAINT fk_datasets_tema
                FOREIGN KEY (tema_codigo) REFERENCES ide.temas(codigo) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_datasets_subtema'
    ) THEN
        ALTER TABLE ide.datasets
            ADD CONSTRAINT fk_datasets_subtema
                FOREIGN KEY (subtema_codigo) REFERENCES ide.subtemas(codigo) ON DELETE SET NULL;
    END IF;
END
$$;

-- ── Add FK constraints for tema/subtema on services ──────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_services_tema'
    ) THEN
        ALTER TABLE ide.services
            ADD CONSTRAINT fk_services_tema
                FOREIGN KEY (tema_codigo) REFERENCES ide.temas(codigo) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_services_subtema'
    ) THEN
        ALTER TABLE ide.services
            ADD CONSTRAINT fk_services_subtema
                FOREIGN KEY (subtema_codigo) REFERENCES ide.subtemas(codigo) ON DELETE SET NULL;
    END IF;
END
$$;

-- ── Seed: 14 temas ────────────────────────────────────────────────────────
INSERT INTO ide.temas (codigo, nombre, orden) VALUES
    ('01', 'Geodesia',                  1),
    ('02', 'Cartografía base',          2),
    ('03', 'Límites',                   3),
    ('04', 'Transporte',                4),
    ('05', 'Hidrografía',               5),
    ('06', 'Uso del suelo',             6),
    ('07', 'Recursos naturales',        7),
    ('08', 'Medio ambiente',            8),
    ('09', 'Infraestructura',           9),
    ('10', 'Catastro',                  10),
    ('11', 'Demografía',                11),
    ('12', 'Economía',                  12),
    ('13', 'Riesgos y desastres',       13),
    ('14', 'Administración pública',    14)
ON CONFLICT (codigo) DO NOTHING;

-- ── Seed: 53 subtemas (3-4 per tema) ─────────────────────────────────────
INSERT INTO ide.subtemas (codigo, tema_codigo, nombre, orden) VALUES
    -- 01 Geodesia
    ('0101', '01', 'Redes geodésicas',                  1),
    ('0102', '01', 'Datum y sistemas de referencia',    2),
    ('0103', '01', 'Modelos de geoide',                 3),
    ('0104', '01', 'Puntos de control',                 4),
    -- 02 Cartografía base
    ('0201', '02', 'Cartas nacionales',                 1),
    ('0202', '02', 'Modelos digitales de elevación',    2),
    ('0203', '02', 'Ortofotos y ortoimágenes',          3),
    ('0204', '02', 'Nomenclatura y topónimos',          4),
    -- 03 Límites
    ('0301', '03', 'Límites internacionales',           1),
    ('0302', '03', 'Límites administrativos',           2),
    ('0303', '03', 'Circunscripciones electorales',     3),
    -- 04 Transporte
    ('0401', '04', 'Red vial',                          1),
    ('0402', '04', 'Infraestructura aeroportuaria',     2),
    ('0403', '04', 'Infraestructura portuaria',         3),
    ('0404', '04', 'Red ferroviaria',                   4),
    -- 05 Hidrografía
    ('0501', '05', 'Cuencas hidrográficas',             1),
    ('0502', '05', 'Ríos y cuerpos de agua',            2),
    ('0503', '05', 'Recursos hídricos subterráneos',    3),
    ('0504', '05', 'Calidad del agua',                  4),
    -- 06 Uso del suelo
    ('0601', '06', 'Cobertura vegetal',                 1),
    ('0602', '06', 'Zonificación urbana',               2),
    ('0603', '06', 'Uso agrícola',                      3),
    ('0604', '06', 'Cambio de uso de suelo',            4),
    -- 07 Recursos naturales
    ('0701', '07', 'Áreas naturales protegidas',        1),
    ('0702', '07', 'Recursos minerales',                2),
    ('0703', '07', 'Recursos forestales',               3),
    ('0704', '07', 'Recursos hidrocarburíferos',        4),
    -- 08 Medio ambiente
    ('0801', '08', 'Ecosistemas',                       1),
    ('0802', '08', 'Biodiversidad',                     2),
    ('0803', '08', 'Contaminación ambiental',           3),
    ('0804', '08', 'Áreas de conservación',             4),
    -- 09 Infraestructura
    ('0901', '09', 'Saneamiento y agua potable',        1),
    ('0902', '09', 'Energía eléctrica',                 2),
    ('0903', '09', 'Telecomunicaciones',                3),
    ('0904', '09', 'Equipamiento urbano',               4),
    -- 10 Catastro
    ('1001', '10', 'Predios urbanos',                   1),
    ('1002', '10', 'Predios rurales',                   2),
    ('1003', '10', 'Titulación y registro',             3),
    -- 11 Demografía
    ('1101', '11', 'Población y vivienda',              1),
    ('1102', '11', 'Censos y estadísticas',             2),
    ('1103', '11', 'Migración',                         3),
    ('1104', '11', 'Densidad poblacional',              4),
    -- 12 Economía
    ('1201', '12', 'Zonas económicas',                  1),
    ('1202', '12', 'Actividades productivas',           2),
    ('1203', '12', 'Comercio y servicios',              3),
    ('1204', '12', 'Inversión y proyectos',             4),
    -- 13 Riesgos y desastres
    ('1301', '13', 'Amenazas naturales',                1),
    ('1302', '13', 'Vulnerabilidad y exposición',       2),
    ('1303', '13', 'Zonas de riesgo',                   3),
    ('1304', '13', 'Eventos históricos',                4),
    -- 14 Administración pública
    ('1401', '14', 'Entidades del Estado',              1),
    ('1402', '14', 'Servicios públicos',                2),
    ('1403', '14', 'Planes de ordenamiento',            3)
ON CONFLICT (codigo) DO NOTHING;

COMMIT;
