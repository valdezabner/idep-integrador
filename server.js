'use strict';

// ── Bootstrap ────────────────────────────────────────────────────────────────
require('dotenv').config();

const express = require('express');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./src/config');
const { pool, query, testConnection } = require('./src/db/pool');

// ── Route imports ─────────────────────────────────────────────────────────────
const authRoutes           = require('./src/routes/v1/auth');
const usuariosRoutes       = require('./src/routes/v1/usuarios');
const entidadesRoutes      = require('./src/routes/v1/entidades');
const responsablesRoutes   = require('./src/routes/v1/responsables');
const clasificacionRoutes  = require('./src/routes/v1/clasificacion');
const uploadsRoutes        = require('./src/routes/v1/uploads');
const datasetsRoutes       = require('./src/routes/v1/datasets');
const calidadRoutes        = require('./src/routes/v1/calidad');
const metadatosRoutes      = require('./src/routes/v1/metadatos');
const catalogoObjetosRoutes = require('./src/routes/v1/catalogoObjetos');
const serviciosRoutes      = require('./src/routes/v1/servicios');
const replicasRoutes       = require('./src/routes/v1/replicas');
const estilosRoutes        = require('./src/routes/v1/estilos');
const monitoreoRoutes      = require('./src/routes/v1/monitoreo');
const publicoRoutes        = require('./src/routes/v1/publico');
const notificacionesRoutes = require('./src/routes/v1/notificaciones');
const auditoriaRoutes      = require('./src/routes/v1/auditoria');
const recursosRoutes       = require('./src/routes/v1/recursos');

// ── Job imports ───────────────────────────────────────────────────────────────
const healthCheckJob = require('./src/jobs/healthCheckJob');
const syncQueueJob   = require('./src/jobs/syncQueueJob');
const backupJob      = require('./src/jobs/backupJob');
const cleanupJob     = require('./src/jobs/cleanupJob');

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();

// Trust the nginx reverse proxy
app.set('trust proxy', 1);

// ── Security & parsing middleware ─────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // relaxed for admin SPA; tighten per-route as needed
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(cors({
  origin: config.isProd ? false : true,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan(config.isDev ? 'dev' : 'combined'));

// ── Static files ─────────────────────────────────────────────────────────────
// Served BEFORE the API routes so /admin and /catalogo are not intercepted.
app.use('/admin',   express.static(path.join(__dirname, 'public', 'admin'),   { index: 'index.html' }));
app.use('/catalogo', express.static(path.join(__dirname, 'public', 'catalogo'), { index: 'index.html' }));

// SPA fallback — send index.html for unknown paths under /admin and /catalogo
app.get('/admin/*',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin',    'index.html')));
app.get('/catalogo/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'catalogo', 'index.html')));

// ── Health check (unauthenticated) ────────────────────────────────────────────
app.get('/api/v1/health', async (req, res) => {
  const status = { status: 'ok', timestamp: new Date().toISOString(), services: {} };
  let httpStatus = 200;

  // Database
  try {
    await testConnection();
    status.services.database = { status: 'ok' };
  } catch (err) {
    status.services.database = { status: 'error', message: err.message };
    status.status = 'degraded';
    httpStatus = 503;
  }

  // GeoServer
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(`${config.GEOSERVER_URL}/`, { signal: controller.signal });
    clearTimeout(timer);
    status.services.geoserver = { status: r.ok ? 'ok' : 'degraded', httpStatus: r.status };
    if (!r.ok) status.status = 'degraded';
  } catch (err) {
    status.services.geoserver = { status: 'error', message: err.message };
    status.status = 'degraded';
  }

  // GeoNetwork (optional)
  if (config.geonetworkEnabled) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(`${config.GEONETWORK_URL}/srv/api/0.1/me`, {
        signal: controller.signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.GEONETWORK_USER}:${config.GEONETWORK_PASS}`).toString('base64')}`,
        },
      });
      clearTimeout(timer);
      status.services.geonetwork = { status: r.ok ? 'ok' : 'degraded', httpStatus: r.status };
      if (!r.ok) status.status = 'degraded';
    } catch (err) {
      status.services.geonetwork = { status: 'error', message: err.message };
      status.status = 'degraded';
    }
  } else {
    status.services.geonetwork = { status: 'disabled' };
  }

  res.status(httpStatus).json(status);
});

// ── API v1 routes ─────────────────────────────────────────────────────────────
const API = '/api/v1';

app.use(`${API}/auth`,            authRoutes);
app.use(`${API}/usuarios`,        usuariosRoutes);
app.use(`${API}/entidades`,       entidadesRoutes);
app.use(`${API}/responsables`,    responsablesRoutes);
app.use(`${API}/clasificacion`,   clasificacionRoutes);
app.use(`${API}/uploads`,         uploadsRoutes);
app.use(`${API}/datasets`,        datasetsRoutes);
app.use(`${API}/calidad`,         calidadRoutes);
app.use(`${API}/metadatos`,       metadatosRoutes);
app.use(`${API}/catalogo-objetos`, catalogoObjetosRoutes);
app.use(`${API}/servicios`,       serviciosRoutes);
app.use(`${API}/replicas`,        replicasRoutes);
app.use(`${API}/estilos`,         estilosRoutes);
app.use(`${API}/monitoreo`,       monitoreoRoutes);
app.use(`${API}/publico`,         publicoRoutes);
app.use(`${API}/notificaciones`,  notificacionesRoutes);
app.use(`${API}/auditoria`,       auditoriaRoutes);
app.use(`${API}/recursos`,        recursosRoutes);

// ── 404 for unknown API routes ────────────────────────────────────────────────
app.use(`${API}/*`, (req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado', path: req.path });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `El archivo supera el límite de ${config.UPLOAD_MAX_MB} MB` });
  }

  // JWT errors
  if (err.name === 'UnauthorizedError' || err.name === 'JsonWebTokenError') {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  // Zod validation errors
  if (err.name === 'ZodError') {
    return res.status(400).json({ error: 'Datos inválidos', details: err.errors });
  }

  // PostgreSQL unique violations
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Registro duplicado', detail: err.detail });
  }

  // PostgreSQL foreign key violations
  if (err.code === '23503') {
    return res.status(409).json({ error: 'Referencia inválida', detail: err.detail });
  }

  const statusCode = err.statusCode || err.status || 500;
  if (statusCode >= 500) {
    console.error('[server] Unhandled error:', err);
  }

  res.status(statusCode).json({
    error: config.isProd && statusCode === 500
      ? 'Error interno del servidor'
      : (err.message || 'Error desconocido'),
  });
});

// ── Migrations ────────────────────────────────────────────────────────────────
async function runMigrations() {
  console.log('[server] Running database migrations…');
  try {
    // node-pg-migrate is invoked as a CLI in production; here we run it
    // programmatically so the app self-migrates on startup.
    const { default: migrate } = await import('node-pg-migrate');
    await migrate({
      databaseUrl: config.DATABASE_URL,
      dir: path.join(__dirname, 'src', 'db', 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: config.isDev,
    });
    console.log('[server] Migrations complete');
  } catch (err) {
    // If the migrations directory doesn't exist yet, skip silently
    if (err.code === 'ENOENT') {
      console.warn('[server] No migrations directory found — skipping');
      return;
    }
    throw err;
  }
}

// ── Seed admin user ───────────────────────────────────────────────────────────
async function seedAdminUser() {
  try {
    const { rows } = await query(
      'SELECT id FROM ide.usuarios WHERE email = $1 LIMIT 1',
      [config.ADMIN_EMAIL]
    );
    if (rows.length) return; // already exists

    let password = config.ADMIN_PASSWORD;
    let generated = false;
    if (!password) {
      password = crypto.randomBytes(16).toString('hex');
      generated = true;
    }

    const hash = await bcrypt.hash(password, 12);

    // Ensure at least one entidad exists so the admin_ide role can be scoped to it
    // (ide.usuario_roles.entidad_id is NOT NULL).
    let entidadId;
    const entidadRes = await query('SELECT id FROM ide.entidades ORDER BY id LIMIT 1');
    if (entidadRes.rows.length) {
      entidadId = entidadRes.rows[0].id;
    } else {
      const ins = await query(
        `INSERT INTO ide.entidades (nombre, codigo, sigla, activo)
         VALUES ($1, $2, $3, true) RETURNING id`,
        ['IDE Nacional del Perú', 'IDE', 'IDE']
      );
      entidadId = ins.rows[0].id;
    }

    const userRes = await query(
      `INSERT INTO ide.usuarios (nombre, email, password_hash, activo, created_at, updated_at)
       VALUES ($1, $2, $3, true, NOW(), NOW()) RETURNING id`,
      ['Administrador IDE', config.ADMIN_EMAIL, hash]
    );
    const userId = userRes.rows[0].id;

    const roleRes = await query(
      `SELECT id FROM ide.roles WHERE nombre = 'admin_ide' LIMIT 1`
    );
    if (roleRes.rows.length) {
      await query(
        `INSERT INTO ide.usuario_roles (usuario_id, rol_id, entidad_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userId, roleRes.rows[0].id, entidadId]
      );
    }

    if (generated) {
      console.warn('╔══════════════════════════════════════════════════╗');
      console.warn('║  ADMIN USER CREATED — CHANGE PASSWORD NOW        ║');
      console.warn(`║  Email:    ${config.ADMIN_EMAIL.padEnd(38)}║`);
      console.warn(`║  Password: ${password.padEnd(38)}║`);
      console.warn('╚══════════════════════════════════════════════════╝');
    } else {
      console.log(`[server] Admin user seeded: ${config.ADMIN_EMAIL}`);
    }
  } catch (err) {
    // Table may not exist during very first boot before migrations
    if (err.code !== '42P01') {
      console.error('[server] seedAdminUser error:', err.message);
    }
  }
}


// ── Start jobs ────────────────────────────────────────────────────────────────
function startJobs() {
  healthCheckJob.start();
  syncQueueJob.start();
  backupJob.start();
  cleanupJob.start();
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[server] ${signal} received — shutting down gracefully…`);
  healthCheckJob.stop();
  syncQueueJob.stop();
  backupJob.stop();
  cleanupJob.stop();

  server.close(async () => {
    try {
      await pool.end();
      console.log('[server] Database pool closed. Goodbye.');
    } catch (err) {
      console.error('[server] Error closing pool:', err.message);
    }
    process.exit(0);
  });

  // Force exit after 15 s if graceful shutdown stalls
  setTimeout(() => {
    console.error('[server] Forced exit after timeout');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason);
  // Do not exit — log and continue; monitor carefully
});

// ── Bootstrap sequence ────────────────────────────────────────────────────────
const server = http.createServer(app);

(async () => {
  try {
    // 1. Verify DB is reachable
    console.log('[server] Testing database connection…');
    await testConnection();
    console.log('[server] Database connection OK');

    // 2. Run migrations
    await runMigrations();

    // 3. Seed default admin
    await seedAdminUser();

    // 4. Start background jobs
    startJobs();

    // 5. Listen
    server.listen(config.PORT, () => {
      console.log(`[server] IDE Nacional listening on port ${config.PORT} (${config.NODE_ENV})`);
    });
  } catch (err) {
    console.error('[server] Fatal startup error:', err);
    process.exit(1);
  }
})();

module.exports = app; // exported for testing
