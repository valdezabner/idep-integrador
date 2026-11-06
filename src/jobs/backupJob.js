'use strict';

const cron = require('node-cron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const KEEP_DAYS = parseInt(process.env.BACKUP_KEEP_DAYS || '14', 10);

let task = null;

function formatDate(d) {
  return d.toISOString().replace(/[T:]/g, '-').replace(/\..+/, '');
}

/**
 * Run pg_dump inside the postgis container (or locally) and save a compressed
 * SQL dump to BACKUP_DIR.
 */
async function runBackup() {
  const filename = `ide-backup-${formatDate(new Date())}.sql.gz`;
  const dest = path.join(BACKUP_DIR, filename);

  // Ensure destination exists
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const url = new URL(config.DATABASE_URL);
  const env = {
    ...process.env,
    PGPASSWORD: url.password,
  };
  const args = [
    '-h', url.hostname,
    '-p', url.port || '5432',
    '-U', url.username,
    '-d', url.pathname.replace(/^\//, ''),
    '-Fc',          // custom format (compressed)
    '-f', dest,
  ];

  return new Promise((resolve, reject) => {
    execFile('pg_dump', args, { env, timeout: 300_000 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[backup] pg_dump failed:', err.message, stderr);
        return reject(err);
      }
      console.log(`[backup] Dump written to ${dest}`);
      resolve(dest);
    });
  });
}

/**
 * Delete backup files older than KEEP_DAYS.
 */
function pruneOldBackups() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    const files = fs.readdirSync(BACKUP_DIR);
    let pruned = 0;
    for (const f of files) {
      if (!f.startsWith('ide-backup-')) continue;
      const full = path.join(BACKUP_DIR, f);
      const { mtimeMs } = fs.statSync(full);
      if (mtimeMs < cutoff) {
        fs.unlinkSync(full);
        pruned++;
      }
    }
    if (pruned) console.log(`[backup] Pruned ${pruned} old backup(s)`);
  } catch (err) {
    console.error('[backup] Prune error:', err.message);
  }
}

async function runAll() {
  try {
    await runBackup();
    pruneOldBackups();
  } catch (err) {
    console.error('[backup] Backup job error:', err.message);
  }
}

function start() {
  // Daily at 02:00 Lima time (UTC-5 → 07:00 UTC)
  task = cron.schedule('0 7 * * *', runAll, { timezone: 'America/Lima' });
  console.log('[backup] Scheduled — daily at 02:00 America/Lima');
}

function stop() {
  if (task) task.stop();
}

module.exports = { start, stop, runBackup, pruneOldBackups };
