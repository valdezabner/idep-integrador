'use strict';

/**
 * auth.js
 * Authentication routes for IDE Nacional (IDEP).
 *
 * POST /api/v1/auth/login   – email + password → JWT + refresh token
 * POST /api/v1/auth/refresh – refresh token    → new JWT
 * POST /api/v1/auth/logout  – revoke refresh token
 */

const { Router } = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { query } = require('../../db/pool');
const config = require('../../config');

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Deterministic SHA-256 hash for refresh-token storage.
 * bcrypt is unsuitable for lookup because it uses a random salt on every call.
 * We use SHA-256 (constant-time lookup) for the index column and rely on the
 * high entropy of the raw token (48 random bytes) for security.
 */
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Return a user row with its roles as a JSON array.
 * Roles shape: [{ rol: string, entidad_id: number }]
 */
async function fetchUserWithRoles(field, value) {
  const col = field === 'id' ? 'u.id' : 'u.email';
  const res = await query(
    `SELECT u.id,
            u.nombre,
            u.email,
            u.password_hash,
            u.entidad_id,
            u.activo,
            COALESCE(
              json_agg(
                json_build_object('rol', r.nombre, 'entidad_id', ur.entidad_id)
              ) FILTER (WHERE r.id IS NOT NULL),
              '[]'::json
            ) AS roles
       FROM ide.usuarios u
       LEFT JOIN ide.usuario_roles ur ON ur.usuario_id = u.id
       LEFT JOIN ide.roles          r  ON r.id = ur.rol_id
      WHERE ${col} = $1
      GROUP BY u.id`,
    [value]
  );
  return res.rows[0] || null;
}

// ── POST /login ────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'El campo email es requerido' });
    }
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'El campo password es requerido' });
    }

    const user = await fetchUserWithRoles('email', email.toLowerCase().trim());

    // Use a constant-time comparison to avoid timing-based user enumeration
    if (!user) {
      // Still run bcrypt so timing is constant even when user doesn't exist
      await bcrypt.compare(password, '$2b$12$placeholderHashForTimingProtection_xxxx');
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    if (!user.activo) {
      return res.status(403).json({ error: 'Cuenta desactivada. Contacte al administrador.' });
    }

    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // ── Issue JWT ────────────────────────────────────────────────────────
    const jwtPayload = {
      id:         user.id,
      email:      user.email,
      entidad_id: user.entidad_id,
      roles:      user.roles,
    };
    const token = jwt.sign(jwtPayload, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRES,
      subject:   String(user.id),
    });

    // ── Issue refresh token ──────────────────────────────────────────────
    const rawRefreshToken = crypto.randomBytes(48).toString('hex');
    const tokenHash       = hashToken(rawRefreshToken);
    const expiresAt       = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await query(
      `INSERT INTO ide.refresh_tokens (usuario_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, tokenHash, expiresAt]
    );

    return res.status(200).json({
      token,
      refreshToken: rawRefreshToken,
      user: {
        id:         user.id,
        nombre:     user.nombre,
        email:      user.email,
        entidad_id: user.entidad_id,
        roles:      user.roles,
      },
    });
  } catch (err) {
    console.error('[auth] /login error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /refresh ──────────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};

    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(400).json({ error: 'refreshToken es requerido' });
    }

    const tokenHash = hashToken(refreshToken);

    const result = await query(
      `SELECT rt.id, rt.usuario_id, rt.expires_at, rt.revocado
         FROM ide.refresh_tokens rt
        WHERE rt.token_hash = $1`,
      [tokenHash]
    );

    const record = result.rows[0];

    if (!record) {
      return res.status(401).json({ error: 'Refresh token inválido' });
    }
    if (record.revocado) {
      return res.status(401).json({ error: 'Refresh token revocado' });
    }
    if (new Date(record.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Refresh token expirado' });
    }

    // Load fresh user data
    const user = await fetchUserWithRoles('id', record.usuario_id);
    if (!user || !user.activo) {
      return res.status(401).json({ error: 'Usuario inactivo o no encontrado' });
    }

    // Issue new JWT
    const jwtPayload = {
      id:         user.id,
      email:      user.email,
      entidad_id: user.entidad_id,
      roles:      user.roles,
    };
    const token = jwt.sign(jwtPayload, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRES,
      subject:   String(user.id),
    });

    return res.status(200).json({ token });
  } catch (err) {
    console.error('[auth] /refresh error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /logout ───────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};

    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(400).json({ error: 'refreshToken es requerido' });
    }

    const tokenHash = hashToken(refreshToken);

    const result = await query(
      `UPDATE ide.refresh_tokens
          SET revocado = true
        WHERE token_hash = $1
      RETURNING id`,
      [tokenHash]
    );

    if (result.rowCount === 0) {
      // Token not found – treat as already logged out (idempotent)
      return res.status(200).json({ message: 'Sesión cerrada' });
    }

    return res.status(200).json({ message: 'Sesión cerrada correctamente' });
  } catch (err) {
    console.error('[auth] /logout error:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
