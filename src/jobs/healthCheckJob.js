'use strict';

const cron = require('node-cron');
const config = require('../config');
const { query } = require('../db/pool');

let task = null;

/**
 * Probe every active service whose configured interval has elapsed.
 * The actual probe/threshold/alert/uptime logic lives in monitorService —
 * this job only decides which services are due and fans out to it.
 */
async function runChecks() {
  try {
    const { rows } = await query(
      `SELECT id FROM ide.services
        WHERE estado != 'inactivo'
          AND (
            ultimo_chequeo IS NULL
            OR ultimo_chequeo <= NOW() - (COALESCE(intervalo_chequeo_min, $1) || ' minutes')::interval
          )`,
      [config.MONITOR_DEFAULT_INTERVAL_MIN]
    );
    if (!rows.length) return;

    const monitorService = require('../services/monitorService');
    for (const svc of rows) {
      try {
        await monitorService.sondarServicio(svc.id);
      } catch (err) {
        console.error(`[healthCheck] Error sondando servicio ${svc.id}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[healthCheck] Error en el barrido:', err.message);
  }
}

function start() {
  // Tick every minute; runChecks() itself filters by each service's own interval.
  task = cron.schedule('* * * * *', runChecks, { timezone: 'America/Lima' });
  console.log('[healthCheck] Programado — cada 1 minuto (respeta intervalo_chequeo_min por servicio)');
  runChecks().catch((err) => console.error('[healthCheck] Error en la corrida inicial:', err.message));
}

function stop() {
  if (task) task.stop();
}

module.exports = { start, stop, runChecks };
