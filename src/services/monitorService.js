'use strict';

/**
 * monitorService.js
 * Probes published OGC services (GetCapabilities), tracks consecutive
 * failures with a threshold before flagging a service as 'caido', records
 * health checks + daily uptime, and exposes uptime summaries.
 */

const config = require('../config');
const { query } = require('../db/pool');

/**
 * Probe a single service's GetCapabilities endpoint, update its health
 * state, and record the check + daily uptime.
 *
 * @param {number} serviceId
 * @returns {Promise<{ok:boolean, latencia_ms:number|null, estado:string}>}
 */
async function sondarServicio(serviceId) {
  const svcRes = await query('SELECT * FROM ide.services WHERE id = $1', [serviceId]);
  if (svcRes.rowCount === 0) {
    throw new Error(`Servicio ${serviceId} no existe`);
  }
  const service = svcRes.rows[0];

  const sep = service.url_base.includes('?') ? '&' : '?';
  const url = `${service.url_base}${sep}SERVICE=${service.tipo}&REQUEST=GetCapabilities&VERSION=${service.version_ogc}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let ok = false;
  let latencia_ms = null;
  let estado_http = null;
  let error_mensaje = null;
  const start = Date.now();

  try {
    const resp = await fetch(url, { signal: controller.signal });
    latencia_ms = Date.now() - start;
    estado_http = resp.status;
    const contentType = resp.headers.get('content-type') || '';
    ok = resp.ok && (contentType === '' || contentType.includes('xml') || resp.status === 200);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      error_mensaje = `HTTP ${resp.status}: ${text.slice(0, 300)}`;
    }
  } catch (err) {
    latencia_ms = Date.now() - start;
    ok = false;
    error_mensaje = err.name === 'AbortError' ? 'Timeout (10s) al consultar GetCapabilities' : err.message;
  } finally {
    clearTimeout(timeout);
  }

  const previousEstado = service.estado;
  let fallosConsecutivos = service.fallos_consecutivos || 0;
  let nuevoEstado = previousEstado;

  if (ok) {
    fallosConsecutivos = 0;
    nuevoEstado = 'activo';
    if (previousEstado === 'caido') {
      try {
        const mailService = require('./mailService');
        await mailService.alertaRecuperacion(service);
      } catch (err) {
        console.error(`[monitorService] Error al enviar alerta de recuperación (servicio ${serviceId}):`, err.message);
      }
    }
  } else {
    fallosConsecutivos += 1;
    const threshold = config.MONITOR_FAIL_THRESHOLD || 3;
    if (fallosConsecutivos >= threshold && previousEstado !== 'caido') {
      nuevoEstado = 'caido';
      try {
        const mailService = require('./mailService');
        const entidadRes = await query('SELECT * FROM ide.entidades WHERE id = $1', [service.entidad_id]);
        const entidad = entidadRes.rows[0] || null;
        await mailService.alertaCaida(service, entidad);
      } catch (err) {
        console.error(`[monitorService] Error al enviar alerta de caída (servicio ${serviceId}):`, err.message);
      }
    }
    // Si aún no se alcanza el umbral, o el servicio ya estaba 'caido', el
    // estado permanece sin cambios hasta la próxima ronda de sondeo.
  }

  await query(
    `UPDATE ide.services
        SET estado = $2, fallos_consecutivos = $3, ultimo_chequeo = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [serviceId, nuevoEstado, fallosConsecutivos]
  );

  await query(
    `INSERT INTO ide.service_health_checks
        (service_id, ok, latencia_ms, estado_http, error_mensaje, tipo_sonda)
     VALUES ($1, $2, $3, $4, $5, 'capabilities')`,
    [serviceId, ok, latencia_ms, estado_http, error_mensaje]
  );

  const today = new Date().toISOString().slice(0, 10);
  await agregarUptime(serviceId, today, ok);

  return { ok, latencia_ms, estado: nuevoEstado };
}

/**
 * Upsert a service's daily uptime counters.
 *
 * @param {number} serviceId
 * @param {string} fecha  YYYY-MM-DD
 * @param {boolean} ok
 */
async function agregarUptime(serviceId, fecha, ok) {
  const okInc = ok ? 1 : 0;
  await query(
    `INSERT INTO ide.service_uptime_daily (service_id, fecha, total_checks, checks_ok, uptime_pct)
     VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (service_id, fecha) DO UPDATE
        SET total_checks = ide.service_uptime_daily.total_checks + 1,
            checks_ok     = ide.service_uptime_daily.checks_ok + $3,
            uptime_pct    = ROUND(
                (ide.service_uptime_daily.checks_ok + $3)::NUMERIC
                / (ide.service_uptime_daily.total_checks + 1) * 100, 2
            )`,
    [serviceId, fecha, okInc, okInc === 1 ? 100 : 0]
  );
}

async function windowUptime(serviceId, days) {
  const r = await query(
    `SELECT COALESCE(SUM(checks_ok), 0)::INT AS ok, COALESCE(SUM(total_checks), 0)::INT AS total
       FROM ide.service_uptime_daily
      WHERE service_id = $1 AND fecha >= (CURRENT_DATE - $2::INT)`,
    [serviceId, days - 1]
  );
  const { ok, total } = r.rows[0];
  if (!total) return null;
  return Math.round((ok / total) * 10000) / 100;
}

/**
 * Weighted uptime percentage over the last 1/7/30 days.
 * @param {number} serviceId
 * @returns {Promise<{uptime_24h:number|null, uptime_7d:number|null, uptime_30d:number|null}>}
 */
async function getUptimeSummary(serviceId) {
  const [uptime_24h, uptime_7d, uptime_30d] = await Promise.all([
    windowUptime(serviceId, 1),
    windowUptime(serviceId, 7),
    windowUptime(serviceId, 30),
  ]);
  return { uptime_24h, uptime_7d, uptime_30d };
}

module.exports = { sondarServicio, agregarUptime, getUptimeSummary };
