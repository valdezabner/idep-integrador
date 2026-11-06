'use strict';

/**
 * qualityService.js
 * ISO 19157 inspired quality control battery for datasets, OGC services and
 * documentation (metadata + feature catalogue), backed by PostGIS queries.
 */

const { query } = require('../db/pool');

const SRID_VALIDOS = [4326, 32717, 32718, 32719];
const PERU_BBOX = { oeste: -81.36, sur: -18.35, este: -68.67, norte: -0.03 };
const UMBRAL_NULOS_PCT = 20;
const UMBRAL_LATENCIA_MS = 5000;
const UMBRAL_UPTIME_PCT = 95;

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function assertSafeIdent(name, label) {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new Error(`Identificador inválido para ${label}: ${name}`);
  }
  return name;
}

/**
 * Run a single check function, catching any error so it never aborts the
 * whole battery. On failure, returns a synthetic 'advertencia' check result.
 */
async function runCheck(definicion, fn) {
  try {
    return await fn();
  } catch (err) {
    return {
      chequeo: definicion.chequeo,
      elemento_iso19157: definicion.elemento_iso19157 || null,
      resultado: 'advertencia',
      valor_obtenido: null,
      umbral: definicion.umbral || null,
      es_bloqueante: definicion.es_bloqueante || false,
      detalles: { error: err.message },
    };
  }
}

// ── Checks individuales para validarUpload ──────────────────────────────────

async function checkGeometriasInvalidas(schema, table) {
  return runCheck(
    { chequeo: 'Geometrías inválidas', umbral: '0', es_bloqueante: true, elemento_iso19157: 'DQ_TopologicalConsistency' },
    async () => {
      const r = await query(`SELECT gid FROM ${schema}.${table} WHERE NOT ST_IsValid(geom)`);
      const n = r.rowCount;
      return {
        chequeo: 'Geometrías inválidas',
        elemento_iso19157: 'DQ_TopologicalConsistency',
        resultado: n > 0 ? 'falla' : 'pasa',
        valor_obtenido: String(n),
        umbral: '0',
        es_bloqueante: true,
        detalles: n > 0 ? { total: n, gids_afectados: r.rows.slice(0, 50).map((row) => row.gid) } : null,
      };
    }
  );
}

async function checkGeometriasVacias(schema, table) {
  return runCheck(
    { chequeo: 'Geometrías vacías o nulas', umbral: '0', es_bloqueante: true, elemento_iso19157: 'DQ_CompletenessCommission' },
    async () => {
      const r = await query(`SELECT COUNT(*)::INT AS n FROM ${schema}.${table} WHERE geom IS NULL OR ST_IsEmpty(geom)`);
      const n = r.rows[0].n;
      return {
        chequeo: 'Geometrías vacías o nulas',
        elemento_iso19157: 'DQ_CompletenessCommission',
        resultado: n > 0 ? 'falla' : 'pasa',
        valor_obtenido: String(n),
        umbral: '0',
        es_bloqueante: true,
        detalles: n > 0 ? { total: n } : null,
      };
    }
  );
}

async function checkDuplicadosExactos(schema, table) {
  return runCheck(
    { chequeo: 'Duplicados geométricos exactos', umbral: '0', es_bloqueante: false, elemento_iso19157: 'DQ_ConceptualConsistency' },
    async () => {
      const r = await query(`SELECT (COUNT(*) - COUNT(DISTINCT geom))::INT AS n FROM ${schema}.${table}`);
      const n = r.rows[0].n;
      return {
        chequeo: 'Duplicados geométricos exactos',
        elemento_iso19157: 'DQ_ConceptualConsistency',
        resultado: n > 0 ? 'advertencia' : 'pasa',
        valor_obtenido: String(n),
        umbral: '0',
        es_bloqueante: false,
        detalles: n > 0 ? { duplicados: n } : null,
      };
    }
  );
}

async function checkSrid(schema, table) {
  return runCheck(
    {
      chequeo: 'SRID declarado válido',
      umbral: SRID_VALIDOS.join(','),
      es_bloqueante: false,
      elemento_iso19157: 'DQ_AbsoluteExternalPositionalAccuracy',
    },
    async () => {
      const r = await query(`SELECT ST_SRID(geom) AS srid FROM ${schema}.${table} WHERE geom IS NOT NULL LIMIT 1`);
      if (r.rowCount === 0) {
        return {
          chequeo: 'SRID declarado válido',
          elemento_iso19157: 'DQ_AbsoluteExternalPositionalAccuracy',
          resultado: 'advertencia',
          valor_obtenido: 'sin geometrías',
          umbral: SRID_VALIDOS.join(','),
          es_bloqueante: false,
          detalles: null,
        };
      }
      const srid = Number(r.rows[0].srid);
      const valido = SRID_VALIDOS.includes(srid);
      return {
        chequeo: 'SRID declarado válido',
        elemento_iso19157: 'DQ_AbsoluteExternalPositionalAccuracy',
        resultado: valido ? 'pasa' : 'advertencia',
        valor_obtenido: String(srid),
        umbral: SRID_VALIDOS.join(','),
        es_bloqueante: false,
        detalles: valido ? null : { srid_detectado: srid },
      };
    }
  );
}

async function checkBboxPeru(schema, table) {
  return runCheck(
    {
      chequeo: 'Geometrías dentro del bbox de Perú',
      umbral: '0',
      es_bloqueante: false,
      elemento_iso19157: 'DQ_AbsoluteExternalPositionalAccuracy',
    },
    async () => {
      const r = await query(
        `SELECT COUNT(*)::INT AS n
           FROM ${schema}.${table}
          WHERE geom IS NOT NULL
            AND NOT ST_Within(
                  ST_Transform(geom, 4326),
                  ST_MakeEnvelope($1, $2, $3, $4, 4326)
                )`,
        [PERU_BBOX.oeste, PERU_BBOX.sur, PERU_BBOX.este, PERU_BBOX.norte]
      );
      const n = r.rows[0].n;
      return {
        chequeo: 'Geometrías dentro del bbox de Perú',
        elemento_iso19157: 'DQ_AbsoluteExternalPositionalAccuracy',
        resultado: n > 0 ? 'advertencia' : 'pasa',
        valor_obtenido: String(n),
        umbral: '0',
        es_bloqueante: false,
        detalles: n > 0 ? { fuera_de_bbox: n, bbox_peru: PERU_BBOX } : null,
      };
    }
  );
}

async function checksCamposNulos(schema, table) {
  const definicion = {
    chequeo: 'Completitud de campos',
    umbral: `${UMBRAL_NULOS_PCT}%`,
    es_bloqueante: false,
    elemento_iso19157: 'DQ_CompletenessCommission',
  };
  return runCheck(definicion, async () => {
    const colsRes = await query(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
          AND column_name NOT IN ('geom', 'gid')
          AND data_type <> 'USER-DEFINED'
        ORDER BY ordinal_position`,
      [schema, table]
    );

    const resultados = [];
    for (const col of colsRes.rows) {
      if (!IDENT_RE.test(col.column_name)) continue;
      try {
        const r = await query(
          `SELECT COUNT(*)::INT AS total,
                  COUNT(*) FILTER (WHERE "${col.column_name}" IS NULL)::INT AS nulos
             FROM ${schema}.${table}`
        );
        const { total, nulos } = r.rows[0];
        const pct = total > 0 ? Math.round((nulos / total) * 10000) / 100 : 0;
        resultados.push({
          chequeo: `Completitud de campo: ${col.column_name}`,
          elemento_iso19157: 'DQ_CompletenessCommission',
          resultado: pct > UMBRAL_NULOS_PCT ? 'advertencia' : 'pasa',
          valor_obtenido: `${pct}%`,
          umbral: `${UMBRAL_NULOS_PCT}%`,
          es_bloqueante: false,
          detalles: pct > UMBRAL_NULOS_PCT ? { nulos, total } : null,
        });
      } catch (err) {
        resultados.push({
          chequeo: `Completitud de campo: ${col.column_name}`,
          elemento_iso19157: 'DQ_CompletenessCommission',
          resultado: 'advertencia',
          valor_obtenido: null,
          umbral: `${UMBRAL_NULOS_PCT}%`,
          es_bloqueante: false,
          detalles: { error: err.message },
        });
      }
    }
    return resultados;
  });
}

async function checkTiposGeometriaMixtos(schema, table) {
  return runCheck(
    { chequeo: 'Tipos de geometría homogéneos', umbral: '1', es_bloqueante: true, elemento_iso19157: 'DQ_ConceptualConsistency' },
    async () => {
      const r = await query(`SELECT COUNT(DISTINCT GeometryType(geom))::INT AS n FROM ${schema}.${table} WHERE geom IS NOT NULL`);
      const n = r.rows[0].n;
      return {
        chequeo: 'Tipos de geometría homogéneos',
        elemento_iso19157: 'DQ_ConceptualConsistency',
        resultado: n > 1 ? 'falla' : 'pasa',
        valor_obtenido: String(n),
        umbral: '1',
        es_bloqueante: true,
        detalles: n > 1 ? { tipos_distintos: n } : null,
      };
    }
  );
}

// ── Scoring & persistence ────────────────────────────────────────────────────

function calcularScore(checks) {
  const total = checks.length;
  const checksOk = checks.filter((c) => c.resultado === 'pasa').length;
  const checksAdvertencia = checks.filter((c) => c.resultado === 'advertencia').length;
  const checksFalla = checks.filter((c) => c.resultado === 'falla').length;
  const score = total > 0 ? Math.round(((checksOk * 1 + checksAdvertencia * 0.5) / total) * 100) : 0;

  const hayBloqueanteFallado = checks.some((c) => c.resultado === 'falla' && c.es_bloqueante);
  const hayAdvertencia = checks.some((c) => c.resultado === 'advertencia' || (c.resultado === 'falla' && !c.es_bloqueante));

  let resultado_global;
  if (hayBloqueanteFallado) resultado_global = 'rechazado';
  else if (hayAdvertencia) resultado_global = 'aprobado_con_advertencias';
  else resultado_global = 'aprobado';

  return { total, checksOk, checksAdvertencia, checksFalla, score, resultado_global };
}

async function guardarReporte({ uploadId, datasetId, servicioId, tipoRecurso, checks }) {
  const { total, checksOk, checksAdvertencia, checksFalla, score, resultado_global } = calcularScore(checks);

  const reportRes = await query(
    `INSERT INTO ide.quality_reports
        (upload_id, dataset_id, servicio_id, tipo_recurso, resultado_global, score, total_checks, checks_ok, checks_advertencia, checks_falla)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      uploadId || null,
      datasetId || null,
      servicioId || null,
      tipoRecurso,
      resultado_global,
      score,
      total,
      checksOk,
      checksAdvertencia,
      checksFalla,
    ]
  );
  const reportId = reportRes.rows[0].id;

  for (const c of checks) {
    await query(
      `INSERT INTO ide.quality_check_results
          (report_id, elemento_iso19157, chequeo, resultado, valor_obtenido, umbral, es_bloqueante, detalles)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        reportId,
        c.elemento_iso19157 || null,
        c.chequeo,
        c.resultado,
        c.valor_obtenido != null ? String(c.valor_obtenido) : null,
        c.umbral != null ? String(c.umbral) : null,
        !!c.es_bloqueante,
        c.detalles ? JSON.stringify(c.detalles) : null,
      ]
    );
  }

  return {
    reportId,
    resultado_global,
    score,
    total_checks: total,
    checks_ok: checksOk,
    checks_advertencia: checksAdvertencia,
    checks_falla: checksFalla,
    checks,
  };
}

// ── validarUpload ─────────────────────────────────────────────────────────

/**
 * Run the ISO 19157 inspired quality battery for a freshly loaded PostGIS
 * table and persist the results.
 *
 * @param {number} uploadId
 * @param {string} tableName  table name (no schema prefix)
 * @param {string} [schema='datos']
 * @returns {Promise<{reportId:number, resultado_global:string, score:number, checks:Array}>}
 */
async function validarUpload(uploadId, tableName, schema = 'datos') {
  assertSafeIdent(schema, 'schema');
  assertSafeIdent(tableName, 'tableName');

  const checks = [];
  checks.push(await checkGeometriasInvalidas(schema, tableName));
  checks.push(await checkGeometriasVacias(schema, tableName));
  checks.push(await checkDuplicadosExactos(schema, tableName));
  checks.push(await checkSrid(schema, tableName));
  checks.push(await checkBboxPeru(schema, tableName));

  const nulosResult = await checksCamposNulos(schema, tableName);
  if (Array.isArray(nulosResult)) checks.push(...nulosResult);
  else checks.push(nulosResult);

  checks.push(await checkTiposGeometriaMixtos(schema, tableName));

  return guardarReporte({ uploadId, tipoRecurso: 'dato', checks });
}

// ── evaluarServicio ───────────────────────────────────────────────────────

/**
 * Run an OGC compliance + QoS battery against a published service's
 * GetCapabilities endpoint and persist the results.
 *
 * @param {number} servicioId
 */
async function evaluarServicio(servicioId) {
  const svcRes = await query('SELECT * FROM ide.services WHERE id = $1', [servicioId]);
  if (svcRes.rowCount === 0) {
    throw new Error(`Servicio ${servicioId} no existe`);
  }
  const service = svcRes.rows[0];

  const checks = [];
  let xmlText = null;
  let latencia_ms = null;
  let parsed = null;
  let httpOk = false;

  const sep = service.url_base.includes('?') ? '&' : '?';
  const url = `${service.url_base}${sep}SERVICE=${service.tipo}&REQUEST=GetCapabilities&VERSION=${service.version_ogc}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const start = Date.now();
  try {
    const resp = await fetch(url, { signal: controller.signal });
    latencia_ms = Date.now() - start;
    httpOk = resp.ok;
    xmlText = await resp.text();
  } catch (err) {
    latencia_ms = Date.now() - start;
    checks.push({
      chequeo: 'GetCapabilities accesible',
      elemento_iso19157: 'DQ_UsabilityElement',
      resultado: 'falla',
      valor_obtenido: err.name === 'AbortError' ? 'timeout (10s)' : err.message,
      umbral: 'HTTP 200 en ≤10s',
      es_bloqueante: false,
      detalles: { error: err.message },
    });
  } finally {
    clearTimeout(timeout);
  }

  if (xmlText !== null) {
    checks.push({
      chequeo: 'GetCapabilities accesible',
      elemento_iso19157: 'DQ_UsabilityElement',
      resultado: httpOk ? 'pasa' : 'falla',
      valor_obtenido: `${latencia_ms}ms`,
      umbral: 'HTTP 200',
      es_bloqueante: false,
      detalles: null,
    });

    try {
      const { XMLParser } = require('fast-xml-parser');
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
      parsed = parser.parse(xmlText);
      checks.push({
        chequeo: 'XML válido y parseable',
        elemento_iso19157: 'DQ_FormatConsistency',
        resultado: 'pasa',
        valor_obtenido: 'ok',
        umbral: 'XML bien formado',
        es_bloqueante: false,
        detalles: null,
      });
    } catch (err) {
      checks.push({
        chequeo: 'XML válido y parseable',
        elemento_iso19157: 'DQ_FormatConsistency',
        resultado: 'falla',
        valor_obtenido: err.message,
        umbral: 'XML bien formado',
        es_bloqueante: false,
        detalles: { error: err.message },
      });
    }
  }

  const rootKey = parsed ? Object.keys(parsed).find((k) => !k.startsWith('?')) : null;
  const rootNode = rootKey ? parsed[rootKey] : null;

  checks.push({
    chequeo: 'Tipo de servicio coincide',
    elemento_iso19157: 'DQ_ConceptualConsistency',
    resultado: rootKey && rootKey.toLowerCase().includes(service.tipo.toLowerCase()) ? 'pasa' : 'advertencia',
    valor_obtenido: rootKey || 'sin respuesta',
    umbral: service.tipo,
    es_bloqueante: false,
    detalles: null,
  });

  const versionDeclarada = rootNode && rootNode['@_version'];
  checks.push({
    chequeo: 'Versión OGC declarada',
    elemento_iso19157: 'DQ_ConceptualConsistency',
    resultado: versionDeclarada ? (versionDeclarada === service.version_ogc ? 'pasa' : 'advertencia') : 'advertencia',
    valor_obtenido: versionDeclarada || 'no declarada',
    umbral: service.version_ogc,
    es_bloqueante: false,
    detalles: null,
  });

  const textoXml = (xmlText || '').toLowerCase();

  const opsRequeridas = service.tipo === 'WFS' ? ['getfeature', 'describefeaturetype'] : ['getmap', 'getfeatureinfo'];
  const opsPresentes = opsRequeridas.filter((op) => textoXml.includes(op));
  checks.push({
    chequeo: 'Operaciones mínimas presentes',
    elemento_iso19157: 'DQ_ConceptualConsistency',
    resultado: opsPresentes.length === opsRequeridas.length ? 'pasa' : 'advertencia',
    valor_obtenido: opsPresentes.join(', ') || 'ninguna',
    umbral: opsRequeridas.join(', '),
    es_bloqueante: false,
    detalles: opsPresentes.length < opsRequeridas.length ? { faltantes: opsRequeridas.filter((op) => !opsPresentes.includes(op)) } : null,
  });

  const tieneCrs4326 = /epsg[:\s]*4326/.test(textoXml);
  checks.push({
    chequeo: 'CRS incluye EPSG:4326',
    elemento_iso19157: 'DQ_AbsoluteExternalPositionalAccuracy',
    resultado: tieneCrs4326 ? 'pasa' : 'advertencia',
    valor_obtenido: tieneCrs4326 ? 'presente' : 'ausente',
    umbral: 'EPSG:4326',
    es_bloqueante: false,
    detalles: null,
  });

  const tieneFormatos = textoXml.includes('<format') || textoXml.includes('outputformat') || textoXml.includes('<ows:format');
  checks.push({
    chequeo: 'Formatos de salida declarados',
    elemento_iso19157: 'DQ_FormatConsistency',
    resultado: tieneFormatos ? 'pasa' : 'advertencia',
    valor_obtenido: tieneFormatos ? 'presente' : 'ausente',
    umbral: 'al menos 1 formato',
    es_bloqueante: false,
    detalles: null,
  });

  const tieneMetadataUrl = textoXml.includes('metadataurl');
  checks.push({
    chequeo: 'MetadataURL presente',
    elemento_iso19157: 'DQ_CompletenessCommission',
    resultado: tieneMetadataUrl ? 'pasa' : 'advertencia',
    valor_obtenido: tieneMetadataUrl ? 'presente' : 'ausente',
    umbral: 'presente',
    es_bloqueante: false,
    detalles: null,
  });

  const tieneAbstract = /<(\w+:)?abstract>[^<]+<\/(\w+:)?abstract>/i.test(xmlText || '');
  checks.push({
    chequeo: 'Resumen / abstract presente',
    elemento_iso19157: 'DQ_CompletenessCommission',
    resultado: tieneAbstract ? 'pasa' : 'advertencia',
    valor_obtenido: tieneAbstract ? 'presente' : 'ausente',
    umbral: 'presente',
    es_bloqueante: false,
    detalles: null,
  });

  const tieneBbox = textoXml.includes('boundingbox');
  checks.push({
    chequeo: 'Bbox declarado',
    elemento_iso19157: 'DQ_CompletenessCommission',
    resultado: tieneBbox ? 'pasa' : 'advertencia',
    valor_obtenido: tieneBbox ? 'presente' : 'ausente',
    umbral: 'presente',
    es_bloqueante: false,
    detalles: null,
  });

  if (latencia_ms != null) {
    checks.push({
      chequeo: 'Latencia de GetCapabilities',
      elemento_iso19157: 'DQ_UsabilityElement',
      resultado: latencia_ms <= UMBRAL_LATENCIA_MS ? 'pasa' : 'advertencia',
      valor_obtenido: `${latencia_ms}ms`,
      umbral: `${UMBRAL_LATENCIA_MS}ms`,
      es_bloqueante: false,
      detalles: null,
    });
  }

  try {
    const uptimeRes = await query(
      `SELECT COALESCE(SUM(checks_ok), 0)::INT AS ok, COALESCE(SUM(total_checks), 0)::INT AS total
         FROM ide.service_uptime_daily
        WHERE service_id = $1 AND fecha >= (CURRENT_DATE - 7)`,
      [servicioId]
    );
    const { ok, total } = uptimeRes.rows[0];
    if (total > 0) {
      const uptimePct = Math.round((ok / total) * 10000) / 100;
      checks.push({
        chequeo: 'Disponibilidad (uptime 7 días)',
        elemento_iso19157: 'DQ_UsabilityElement',
        resultado: uptimePct >= UMBRAL_UPTIME_PCT ? 'pasa' : 'advertencia',
        valor_obtenido: `${uptimePct}%`,
        umbral: `${UMBRAL_UPTIME_PCT}%`,
        es_bloqueante: false,
        detalles: { checks_ok: ok, total_checks: total },
      });
    } else {
      checks.push({
        chequeo: 'Disponibilidad (uptime 7 días)',
        elemento_iso19157: 'DQ_UsabilityElement',
        resultado: 'advertencia',
        valor_obtenido: 'sin datos históricos',
        umbral: `${UMBRAL_UPTIME_PCT}%`,
        es_bloqueante: false,
        detalles: null,
      });
    }
  } catch (err) {
    checks.push({
      chequeo: 'Disponibilidad (uptime 7 días)',
      elemento_iso19157: 'DQ_UsabilityElement',
      resultado: 'advertencia',
      valor_obtenido: null,
      umbral: `${UMBRAL_UPTIME_PCT}%`,
      es_bloqueante: false,
      detalles: { error: err.message },
    });
  }

  return guardarReporte({ servicioId, tipoRecurso: 'servicio', checks });
}

// ── evaluarDocumentacion ─────────────────────────────────────────────────

/**
 * Evaluate the documentation completeness (ISO 19139 metadata + ISO 19110
 * feature catalogue) for a dataset and persist the results.
 *
 * @param {number} datasetId
 */
async function evaluarDocumentacion(datasetId) {
  const dsRes = await query('SELECT * FROM ide.datasets WHERE id = $1', [datasetId]);
  if (dsRes.rowCount === 0) {
    throw new Error(`Dataset ${datasetId} no existe`);
  }

  const checks = [];

  const mrRes = await query(
    'SELECT * FROM ide.metadata_records WHERE dataset_id = $1 ORDER BY created_at DESC LIMIT 1',
    [datasetId]
  );
  const metadata = mrRes.rows[0] || null;

  checks.push({
    chequeo: 'Registro de metadatos existe',
    elemento_iso19157: 'DQ_CompletenessCommission',
    resultado: metadata ? 'pasa' : 'advertencia',
    valor_obtenido: metadata ? 'presente' : 'ausente',
    umbral: 'presente',
    es_bloqueante: false,
    detalles: null,
  });

  const contenido = (metadata && metadata.contenido) || {};
  const camposObligatorios = ['titulo', 'resumen', 'fecha', 'palabras_clave', 'bbox', 'escala_denominador'];
  for (const campo of camposObligatorios) {
    const valor = contenido[campo];
    const presente = Array.isArray(valor)
      ? valor.length > 0
      : valor !== null && valor !== undefined && valor !== '' && !(typeof valor === 'object' && Object.keys(valor).length === 0);
    checks.push({
      chequeo: `Campo CCIDEP obligatorio: ${campo}`,
      elemento_iso19157: 'DQ_CompletenessCommission',
      resultado: presente ? 'pasa' : 'advertencia',
      valor_obtenido: presente ? 'presente' : 'ausente',
      umbral: 'presente',
      es_bloqueante: false,
      detalles: null,
    });
  }

  const tieneOrganizacion = !!(contenido.contacto && contenido.contacto.organizacion);
  checks.push({
    chequeo: 'Campo opcional: organización de contacto',
    elemento_iso19157: 'DQ_CompletenessCommission',
    resultado: tieneOrganizacion ? 'pasa' : 'advertencia',
    valor_obtenido: tieneOrganizacion ? 'presente' : 'ausente',
    umbral: 'presente',
    es_bloqueante: false,
    detalles: null,
  });

  const tieneContacto = !!(contenido.contacto && (contenido.contacto.email || contenido.contacto.rol));
  checks.push({
    chequeo: 'Campo opcional: contacto',
    elemento_iso19157: 'DQ_CompletenessCommission',
    resultado: tieneContacto ? 'pasa' : 'advertencia',
    valor_obtenido: tieneContacto ? 'presente' : 'ausente',
    umbral: 'presente',
    es_bloqueante: false,
    detalles: null,
  });

  checks.push({
    chequeo: 'Sincronizado con GeoNetwork',
    elemento_iso19157: 'DQ_UsabilityElement',
    resultado: metadata && metadata.gn_sync_estado === 'sincronizado' ? 'pasa' : 'advertencia',
    valor_obtenido: metadata ? metadata.gn_sync_estado : 'sin registro',
    umbral: 'sincronizado',
    es_bloqueante: false,
    detalles: null,
  });

  const catRes = await query(
    'SELECT * FROM ide.feature_catalogues WHERE dataset_id = $1 ORDER BY created_at DESC LIMIT 1',
    [datasetId]
  );
  const catalogue = catRes.rows[0] || null;

  checks.push({
    chequeo: 'Catálogo de objetos (ISO 19110) existe',
    elemento_iso19157: 'DQ_CompletenessCommission',
    resultado: catalogue ? 'pasa' : 'advertencia',
    valor_obtenido: catalogue ? 'presente' : 'ausente',
    umbral: 'presente',
    es_bloqueante: false,
    detalles: null,
  });

  if (catalogue) {
    const attrsRes = await query(
      `SELECT fa.*
         FROM ide.feature_attributes fa
         JOIN ide.feature_types ft ON ft.id = fa.feature_type_id
        WHERE ft.catalogue_id = $1`,
      [catalogue.id]
    );
    const atributos = attrsRes.rows;

    const sinDefinicion = atributos.filter((a) => !a.definicion || !a.definicion.trim());
    const definicionResultado = atributos.length === 0 ? 'advertencia' : sinDefinicion.length === 0 ? 'pasa' : 'advertencia';
    checks.push({
      chequeo: 'Definición de atributos completa',
      elemento_iso19157: 'DQ_CompletenessCommission',
      resultado: definicionResultado,
      valor_obtenido: atributos.length === 0 ? 'sin atributos registrados' : `${atributos.length - sinDefinicion.length}/${atributos.length} con definición`,
      umbral: `${atributos.length}/${atributos.length}`,
      es_bloqueante: false,
      detalles: sinDefinicion.length > 0 ? { atributos_sin_definicion: sinDefinicion.map((a) => a.nombre) } : null,
    });

    const enumerados = atributos.filter((a) => a.tipo_dominio === 'enumerado');
    if (enumerados.length > 0) {
      const sinValores = [];
      for (const attr of enumerados) {
        const domRes = await query(
          'SELECT COUNT(*)::INT AS n FROM ide.attribute_domain_values WHERE attribute_id = $1',
          [attr.id]
        );
        if (domRes.rows[0].n === 0) sinValores.push(attr.nombre);
      }
      checks.push({
        chequeo: 'Valores de dominio declarados (atributos enumerados)',
        elemento_iso19157: 'DQ_ConceptualConsistency',
        resultado: sinValores.length === 0 ? 'pasa' : 'advertencia',
        valor_obtenido: `${enumerados.length - sinValores.length}/${enumerados.length} con dominio declarado`,
        umbral: `${enumerados.length}/${enumerados.length}`,
        es_bloqueante: false,
        detalles: sinValores.length > 0 ? { atributos_sin_dominio: sinValores } : null,
      });

      const ftRes = await query('SELECT * FROM ide.feature_types WHERE catalogue_id = $1', [catalogue.id]);
      const featureTypesById = new Map(ftRes.rows.map((ft) => [ft.id, ft]));

      for (const attr of enumerados) {
        const ft = featureTypesById.get(attr.feature_type_id);
        if (!ft || !ft.tabla_postgis) continue;
        if (!IDENT_RE.test(ft.tabla_postgis) || !IDENT_RE.test(attr.nombre)) continue;

        try {
          const valoresRes = await query(
            `SELECT DISTINCT "${attr.nombre}" AS valor FROM datos.${ft.tabla_postgis} WHERE "${attr.nombre}" IS NOT NULL`
          );
          const codigosRes = await query('SELECT codigo FROM ide.attribute_domain_values WHERE attribute_id = $1', [attr.id]);
          const codigosValidos = new Set(codigosRes.rows.map((r) => String(r.codigo)));
          const inconsistentes = valoresRes.rows.map((r) => String(r.valor)).filter((v) => !codigosValidos.has(v));

          checks.push({
            chequeo: `Coherencia dominio-datos: ${ft.nombre}.${attr.nombre}`,
            elemento_iso19157: 'DQ_ConceptualConsistency',
            resultado: inconsistentes.length === 0 ? 'pasa' : 'advertencia',
            valor_obtenido: inconsistentes.length === 0 ? 'coherente' : `${inconsistentes.length} valor(es) no declarados`,
            umbral: '0 inconsistencias',
            es_bloqueante: false,
            detalles: inconsistentes.length > 0 ? { valores_no_declarados: inconsistentes.slice(0, 20) } : null,
          });
        } catch (err) {
          checks.push({
            chequeo: `Coherencia dominio-datos: ${ft.nombre}.${attr.nombre}`,
            elemento_iso19157: 'DQ_ConceptualConsistency',
            resultado: 'advertencia',
            valor_obtenido: null,
            umbral: '0 inconsistencias',
            es_bloqueante: false,
            detalles: { error: err.message },
          });
        }
      }
    }
  }

  return guardarReporte({ datasetId, tipoRecurso: 'documentacion', checks });
}

module.exports = { validarUpload, evaluarServicio, evaluarDocumentacion };
