'use strict';

/**
 * audit.js
 * Audit-log middleware for IDE Nacional (IDEP).
 *
 * After the response is sent, inserts one row into ide.audit_log for every
 * mutating request (POST, PUT, PATCH, DELETE).
 *
 * Logged fields:
 *   usuario_id      – req.user.id  (null when unauthenticated)
 *   entidad_id      – req.user.entidad_id (null when not set)
 *   accion          – "<METHOD> <normalised-path>"  e.g. "POST /v1/datasets"
 *   tabla_afectada  – derived from the first meaningful path segment
 *   registro_id     – numeric :id param from the route, if present
 *   ip              – X-Real-IP header, then X-Forwarded-For, then req.ip
 *   detalle         – req.body sanitised (passwords removed, binary omitted)
 *
 * The insert is fire-and-forget: errors are logged to console but never
 * propagate to the HTTP response.
 */

const { query } = require('../db/pool');

/** HTTP methods that represent state changes */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Keys to redact from req.body before storing */
const SENSITIVE_KEYS = new Set([
  'password', 'password_hash', 'contrasena', 'clave',
  'token', 'refresh_token', 'secret',
]);

/**
 * Derive a short table name from the request path.
 * E.g. "/api/v1/datasets/42/versions" → "datasets"
 *
 * @param {string} path
 * @returns {string}
 */
function tablaFromPath(path) {
  // Strip leading slash and split; skip common prefixes like "api", "v1"
  const skip = new Set(['api', 'v1', 'v2']);
  const segments = path.replace(/^\/+/, '').split('/');
  for (const seg of segments) {
    if (!skip.has(seg) && seg && !/^\d+$/.test(seg)) {
      // Return without any query string
      return seg.split('?')[0];
    }
  }
  return path.split('?')[0];
}

/**
 * Extract a numeric resource ID from express route params.
 *
 * @param {object} params - req.params
 * @returns {number|null}
 */
function registroIdFromParams(params) {
  if (!params) return null;
  // Common param names, ordered by specificity
  for (const key of ['id', 'datasetId', 'serviceId', 'uploadId', 'userId']) {
    if (params[key] != null) {
      const n = parseInt(params[key], 10);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}

/**
 * Deep-clone and redact sensitive keys from an object.
 *
 * @param {*} obj
 * @param {number} [depth=0]
 * @returns {*}
 */
function sanitise(obj, depth = 0) {
  if (depth > 5 || obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => sanitise(v, depth + 1));

  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else if (Buffer.isBuffer(val)) {
      result[key] = '[BINARY]';
    } else {
      result[key] = sanitise(val, depth + 1);
    }
  }
  return result;
}

/**
 * Extract the real client IP address from the request.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function clientIp(req) {
  const xRealIp = req.headers['x-real-ip'];
  if (xRealIp) return xRealIp.toString().trim();

  const xForwardedFor = req.headers['x-forwarded-for'];
  if (xForwardedFor) {
    return xForwardedFor.toString().split(',')[0].trim();
  }

  return req.ip || req.connection?.remoteAddress || 'unknown';
}

/**
 * Express middleware – fire-and-forget audit logger.
 *
 * @type {import('express').RequestHandler}
 */
function auditLog(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();

  // Capture the original end() so we can hook into it
  const originalEnd = res.end.bind(res);

  res.end = function auditedEnd(...args) {
    // Restore immediately so the response is not delayed
    res.end = originalEnd;
    res.end(...args);

    // Fire-and-forget: do not await, do not block the response
    setImmediate(async () => {
      try {
        const usuarioId  = req.user?.id  ?? null;
        const entidadId  = req.user?.entidad_id ?? null;
        const accion     = `${req.method} ${req.path}`;
        const tabla      = tablaFromPath(req.path);
        const registroId = registroIdFromParams(req.params);
        const ip         = clientIp(req);
        const detalle    = req.body && typeof req.body === 'object'
          ? sanitise(req.body)
          : null;

        await query(
          `INSERT INTO ide.audit_log
             (usuario_id, entidad_id, accion, tabla_afectada, registro_id, ip, detalle)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [usuarioId, entidadId, accion, tabla, registroId, ip,
           detalle ? JSON.stringify(detalle) : null],
        );
      } catch (err) {
        // Never crash the server because of an audit failure
        console.error('[audit] Error inserting audit_log row:', err.message);
      }
    });
  };

  return next();
}

module.exports = { auditLog };
