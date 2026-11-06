'use strict';

/**
 * errorHandler.js
 * Global Express error-handling middleware for IDE Nacional (IDEP).
 *
 * Must be registered last in the middleware chain:
 *   app.use(errorHandler);
 *
 * Handles:
 *   - Multer errors  (file too large, unexpected field / wrong type)
 *   - JWT errors     (JsonWebTokenError, TokenExpiredError, NotBeforeError)
 *   - Validation / constraint errors from pg (code 23*)
 *   - Generic 4xx/5xx errors with an explicit .status property
 *   - Unknown errors → 500
 *
 * All responses are JSON:
 *   { error: string, detalle?: string, campo?: string }
 */

const multer = require('multer');

/**
 * Central error handler.
 *
 * @param {Error} err
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next  – must be declared even if unused
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // ── Multer: payload too large ────────────────────────────────────────────
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'Archivo demasiado grande',
        detalle: `El tamaño máximo permitido es ${
          require('../config').UPLOAD_MAX_MB
        } MB.`,
      });
    }

    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(415).json({
        error: 'Tipo o campo de archivo no permitido',
        detalle: err.message,
        campo: err.field,
      });
    }

    // Other multer errors (LIMIT_FILE_COUNT, LIMIT_FIELD_KEY, etc.)
    return res.status(400).json({
      error: 'Error en la carga de archivo',
      detalle: err.message,
    });
  }

  // ── JWT errors ────────────────────────────────────────────────────────────
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      error: 'Token expirado',
      detalle: 'Su sesión ha caducado. Vuelva a iniciar sesión.',
    });
  }

  if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
    return res.status(401).json({
      error: 'Token inválido',
      detalle: 'El token de acceso no es válido.',
    });
  }

  // ── PostgreSQL constraint violations ─────────────────────────────────────
  if (err.code) {
    switch (err.code) {
      case '23505':  // unique_violation
        return res.status(409).json({
          error: 'Conflicto de datos',
          detalle: 'Ya existe un registro con ese valor único.',
          campo: err.constraint,
        });
      case '23503':  // foreign_key_violation
        return res.status(409).json({
          error: 'Referencia inválida',
          detalle: 'El registro referenciado no existe o no puede eliminarse.',
          campo: err.constraint,
        });
      case '23502':  // not_null_violation
        return res.status(400).json({
          error: 'Campo requerido',
          detalle: `El campo "${err.column}" es obligatorio.`,
          campo: err.column,
        });
      case '23514':  // check_violation
        return res.status(400).json({
          error: 'Valor fuera de rango',
          detalle: `El valor proporcionado no cumple la restricción "${err.constraint}".`,
          campo: err.constraint,
        });
      default:
        break;
    }
  }

  // ── Errors with an explicit HTTP status ──────────────────────────────────
  if (err.status && err.status >= 400 && err.status < 600) {
    return res.status(err.status).json({
      error: err.message || 'Error en la solicitud',
      detalle: err.detalle || undefined,
    });
  }

  // ── Unknown / unexpected errors → 500 ────────────────────────────────────
  // Log the full stack in development; only the message in production.
  const isDev = (process.env.NODE_ENV || 'production') === 'development';
  console.error('[errorHandler]', isDev ? err : err.message);

  return res.status(500).json({
    error: 'Error interno del servidor',
    detalle: isDev ? err.message : 'Contacte al administrador del sistema.',
  });
}

module.exports = { errorHandler };
