'use strict';

/**
 * auth.js
 * JWT authentication middleware for IDE Nacional (IDEP).
 *
 * Extracts the Bearer token from the Authorization header, verifies it
 * against JWT_SECRET, and attaches the decoded payload to req.user:
 *
 *   req.user = {
 *     id:         number,
 *     email:      string,
 *     entidad_id: number | null,
 *     roles:      Array<{ rol: string, entidad_id: number | null }>
 *   }
 *
 * Returns 401 JSON when the token is missing, malformed, expired, or invalid.
 */

const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Express middleware – authenticate a request via JWT Bearer token.
 *
 * @type {import('express').RequestHandler}
 */
function authenticate(req, res, next) {
  const authHeader =
    req.headers['authorization'] ||
    req.headers['Authorization'] ||
    '';

  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'No autorizado',
      detalle: 'Se requiere un token de acceso (Authorization: Bearer <token>)',
    });
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return res.status(401).json({
      error: 'No autorizado',
      detalle: 'Token vacío',
    });
  }

  try {
    const payload = jwt.verify(token, config.JWT_SECRET);

    // Normalise the roles array: support both legacy flat strings and the
    // current { rol, entidad_id } shape.
    const rawRoles = Array.isArray(payload.roles) ? payload.roles : [];
    const roles = rawRoles.map((r) => {
      if (typeof r === 'string') return { rol: r, entidad_id: null };
      return { rol: r.rol, entidad_id: r.entidad_id ?? null };
    });

    req.user = {
      id:         payload.sub ?? payload.id,
      email:      payload.email,
      entidad_id: payload.entidad_id ?? null,
      roles,
    };

    return next();
  } catch (err) {
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

    // Unexpected error – bubble up to the global error handler
    return next(err);
  }
}

module.exports = { authenticate };
