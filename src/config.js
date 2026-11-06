'use strict';

require('dotenv').config();

function requireEnv(key, defaultValue) {
  const val = process.env[key];
  if (val !== undefined && val !== '') return val;
  if (defaultValue !== undefined) return defaultValue;
  throw new Error(`Missing required environment variable: ${key}`);
}

function envInt(key, defaultValue) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new Error(`Environment variable ${key} must be an integer, got: "${raw}"`);
  return n;
}

function envBool(key, defaultValue) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  return raw.toLowerCase() === 'true' || raw === '1';
}

const config = {
  // ── Node / Server ─────────────────────────────────────────────────────────
  NODE_ENV: process.env.NODE_ENV || 'production',
  PORT: envInt('PORT', 3000),
  get isDev() {
    return this.NODE_ENV === 'development';
  },
  get isProd() {
    return this.NODE_ENV === 'production';
  },

  // ── Database ──────────────────────────────────────────────────────────────
  DATABASE_URL: requireEnv('DATABASE_URL', 'postgresql://postgres:postgres123@ide-postgis:5432/ide'),

  // ── Authentication ────────────────────────────────────────────────────────
  JWT_SECRET: requireEnv('JWT_SECRET', 'change_me_in_production_long_random_string'),
  JWT_EXPIRES: process.env.JWT_EXPIRES || '8h',

  // ── Admin seed ────────────────────────────────────────────────────────────
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@ide.pe',
  // Empty string means "auto-generate on first boot"
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',

  // ── GeoServer ─────────────────────────────────────────────────────────────
  GEOSERVER_URL: process.env.GEOSERVER_URL || 'http://ide-geoserver:8080/geoserver',
  GEOSERVER_ADMIN_USER: process.env.GEOSERVER_ADMIN_USER || 'admin',
  GEOSERVER_ADMIN_PASSWORD: process.env.GEOSERVER_ADMIN_PASSWORD || 'geoserver',

  // ── GeoNetwork (optional external instance) ───────────────────────────────
  GEONETWORK_URL: process.env.GEONETWORK_URL || '',
  GEONETWORK_USER: process.env.GEONETWORK_USER || '',
  GEONETWORK_PASS: process.env.GEONETWORK_PASS || '',
  get geonetworkEnabled() {
    return Boolean(this.GEONETWORK_URL);
  },

  // ── File uploads ──────────────────────────────────────────────────────────
  UPLOAD_DIR: process.env.UPLOAD_DIR || '/uploads',
  UPLOAD_MAX_MB: envInt('UPLOAD_MAX_MB', 500),
  get UPLOAD_MAX_BYTES() {
    return this.UPLOAD_MAX_MB * 1024 * 1024;
  },

  // ── SMTP / Email ──────────────────────────────────────────────────────────
  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: envInt('SMTP_PORT', 587),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || 'noreply@ide.pe',
  get smtpEnabled() {
    return Boolean(this.SMTP_HOST);
  },

  // ── Monitoring ────────────────────────────────────────────────────────────
  MONITOR_DEFAULT_INTERVAL_MIN: envInt('MONITOR_DEFAULT_INTERVAL_MIN', 60),
  MONITOR_FAIL_THRESHOLD: envInt('MONITOR_FAIL_THRESHOLD', 3),

  // ── GDAL processing ───────────────────────────────────────────────────────
  // "docker" → exec into GDAL_CONTAINER  |  "local" → binaries on PATH
  GDAL_MODE: process.env.GDAL_MODE || 'docker',
  GDAL_CONTAINER: process.env.GDAL_CONTAINER || 'ide-gdal',
  get gdalIsDocker() {
    return this.GDAL_MODE === 'docker';
  },
};

module.exports = config;
