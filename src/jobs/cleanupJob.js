'use strict';

const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { query } = require('../db/pool');
const config = require('../config');

let task = null;

/**
 * Remove upload files that are no longer referenced by any ide.uploads row.
 */
async function cleanOrphanFiles() {
  try {
    const uploadDir = config.UPLOAD_DIR;
    if (!fs.existsSync(uploadDir)) return;

    const files = fs.readdirSync(uploadDir);
    for (const file of files) {
      const fullPath = path.join(uploadDir, file);
      if (fs.statSync(fullPath).isDirectory()) continue;

      const { rows } = await query('SELECT 1 FROM ide.uploads WHERE ruta_archivo = $1 LIMIT 1', [fullPath]);
      if (!rows.length) {
        try {
          fs.unlinkSync(fullPath);
          console.log(`[cleanup] Archivo huérfano eliminado: ${file}`);
        } catch (e) {
          console.warn(`[cleanup] No se pudo eliminar ${file}: ${e.message}`);
        }
      }
    }
  } catch (err) {
    console.error('[cleanup] cleanOrphanFiles error:', err.message);
  }
}

/**
 * ide.audit_log is intentionally append-only (UPDATE/DELETE revoked from
 * PUBLIC in migration 001) as a compliance record — it is never pruned here.
 */

/**
 * Purge service_health_checks probes older than 90 days (only the daily
 * aggregate in service_uptime_daily is kept long-term).
 */
async function pruneHealthChecks() {
  try {
    const { rowCount } = await query(
      `DELETE FROM ide.service_health_checks WHERE created_at < NOW() - INTERVAL '90 days'`
    );
    if (rowCount) console.log(`[cleanup] ${rowCount} sondas de monitoreo purgadas (>90 días)`);
  } catch (err) {
    console.error('[cleanup] pruneHealthChecks error:', err.message);
  }
}

/**
 * Expire read notifications older than 30 days.
 */
async function pruneNotifications() {
  try {
    const { rowCount } = await query(
      `DELETE FROM ide.notifications WHERE leido = true AND created_at < NOW() - INTERVAL '30 days'`
    );
    if (rowCount) console.log(`[cleanup] ${rowCount} notificaciones leídas purgadas (>30 días)`);
  } catch (err) {
    console.error('[cleanup] pruneNotifications error:', err.message);
  }
}

/**
 * Drop sync_queue rows that exhausted their retry budget (syncQueueJob stops
 * picking up rows once intentos reaches its MAX_INTENTOS) — the underlying
 * metadata_records.gn_sync_estado already records the failure permanently.
 */
async function pruneExhaustedSyncTasks() {
  try {
    const { rowCount } = await query(
      `DELETE FROM ide.sync_queue WHERE intentos >= 10 AND created_at < NOW() - INTERVAL '7 days'`
    );
    if (rowCount) console.log(`[cleanup] ${rowCount} tareas de sincronización agotadas purgadas`);
  } catch (err) {
    console.error('[cleanup] pruneExhaustedSyncTasks error:', err.message);
  }
}

async function runAll() {
  console.log('[cleanup] Iniciando limpieza…');
  await cleanOrphanFiles();
  await pruneHealthChecks();
  await pruneNotifications();
  await pruneExhaustedSyncTasks();
  console.log('[cleanup] Completado');
}

function start() {
  // Daily at 03:30 Lima time (UTC-5 → 08:30 UTC)
  task = cron.schedule('30 8 * * *', runAll, { timezone: 'America/Lima' });
  console.log('[cleanup] Programado — diario a las 03:30 America/Lima');
}

function stop() {
  if (task) task.stop();
}

module.exports = { start, stop, runAll };
