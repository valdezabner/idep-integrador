'use strict';

/**
 * authorize.js
 * Role-based access control middleware factory for IDE Nacional (IDEP).
 *
 * Usage:
 *   router.get('/resource', authenticate, authorize(['admin_ide', 'publicador']), handler);
 *
 *   // Scope check: user must hold the role for the entidad in req.params.entidadId
 *   router.put('/entidades/:entidadId/datasets/:id',
 *     authenticate,
 *     authorize(['admin_entidad', 'publicador'], { entidadParam: 'entidadId' }),
 *     handler
 *   );
 *
 * Rules:
 *   - admin_ide bypasses all entidad-scoping checks.
 *   - When entidadParam is set, the authenticated user must hold at least one
 *     of the required roles scoped to the entidad identified by req.params[entidadParam]
 *     (or req.body[entidadParam] as fallback).
 *   - Returns 403 JSON when the user lacks the necessary role.
 *
 * Requires authenticate to run first (req.user must be set).
 */

/**
 * @typedef {Object} AuthorizeOptions
 * @property {string} [entidadParam]  - req.params key whose value is the entidad_id to scope against.
 * @property {boolean} [allowOwn]     - (reserved) allow access when the resource belongs to req.user.id.
 */

/**
 * Middleware factory – check that the authenticated user holds at least one
 * of the listed roles, optionally scoped to a specific entidad.
 *
 * @param {string|string[]} roles   - required role name(s)
 * @param {AuthorizeOptions} [options]
 * @returns {import('express').RequestHandler}
 */
function authorize(roles, options = {}) {
  const requiredRoles = Array.isArray(roles) ? roles : [roles];

  return function authorizeMiddleware(req, res, next) {
    if (!req.user) {
      return res.status(401).json({
        error: 'No autenticado',
        detalle: 'El middleware authenticate debe ejecutarse antes que authorize.',
      });
    }

    const userRoles = Array.isArray(req.user.roles) ? req.user.roles : [];

    // admin_ide has super-admin privileges – skip all further checks
    const isSuperAdmin = userRoles.some((r) => r.rol === 'admin_ide');
    if (isSuperAdmin) return next();

    // Determine if entidad-scoping is required
    const { entidadParam } = options;
    let targetEntidadId = null;

    if (entidadParam) {
      const raw =
        req.params[entidadParam] ??
        req.body?.[entidadParam] ??
        req.query?.[entidadParam];

      if (raw != null && raw !== '') {
        targetEntidadId = parseInt(raw, 10);
        if (isNaN(targetEntidadId)) {
          return res.status(400).json({
            error: 'Parámetro inválido',
            detalle: `El parámetro de entidad "${entidadParam}" no es un número válido.`,
          });
        }
      }
    }

    // Check whether the user holds any of the required roles,
    // optionally scoped to the target entidad.
    const hasAccess = userRoles.some((userRole) => {
      const roleMatches = requiredRoles.includes(userRole.rol);
      if (!roleMatches) return false;

      if (targetEntidadId !== null) {
        // Role must be scoped to the target entidad (or be global: entidad_id === null)
        return (
          userRole.entidad_id === null ||
          userRole.entidad_id === targetEntidadId
        );
      }

      return true;
    });

    if (!hasAccess) {
      return res.status(403).json({
        error: 'Acceso denegado',
        detalle: targetEntidadId
          ? `Se requiere uno de los roles [${requiredRoles.join(', ')}] para la entidad ${targetEntidadId}.`
          : `Se requiere uno de los roles: ${requiredRoles.join(', ')}.`,
      });
    }

    return next();
  };
}

module.exports = { authorize };
