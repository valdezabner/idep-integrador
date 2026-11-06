'use strict';

/**
 * mailService.js
 * Thin nodemailer wrapper (no-op / console-log fallback when SMTP is not
 * configured) plus the two alert emails used by monitorService.
 */

const nodemailer = require('nodemailer');
const config = require('../config');
const { query } = require('../db/pool');

let transporter = null;

function getTransporter() {
  if (!config.smtpEnabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

/**
 * Send an email, or log-and-skip when SMTP is not configured.
 * @param {object} opts
 * @param {string} opts.to       comma-separated recipient list
 * @param {string} opts.subject
 * @param {string} opts.html
 */
async function send({ to, subject, html }) {
  const t = getTransporter();
  if (!t) {
    console.log('[mail:skip]', subject, to);
    return { skipped: true };
  }
  try {
    const info = await t.sendMail({ from: config.SMTP_FROM, to, subject, html });
    return { skipped: false, messageId: info.messageId };
  } catch (err) {
    console.error('[mailService] Error al enviar correo:', err.message);
    throw err;
  }
}

// In-memory per-service rate limiter for "servicio caído" alerts.
const lastAlertSent = new Map(); // service.id -> timestamp (ms)
const SEIS_HORAS_MS = 6 * 60 * 60 * 1000;

/**
 * Send a "servicio caído" alert to the entity's designated officials
 * (ide.responsables) and the platform admin, rate-limited to one every 6h
 * per service.
 *
 * @param {object} service  ide.services row
 * @param {object|null} entidad  ide.entidades row
 */
async function alertaCaida(service, entidad) {
  const last = lastAlertSent.get(service.id);
  if (last && Date.now() - last < SEIS_HORAS_MS) {
    return { skipped: true, reason: 'rate_limited' };
  }

  const destinatarios = new Set();
  if (config.ADMIN_EMAIL) destinatarios.add(config.ADMIN_EMAIL);

  if (entidad) {
    if (entidad.email) destinatarios.add(entidad.email);
    try {
      const r = await query(
        `SELECT email FROM ide.responsables
          WHERE entidad_id = $1 AND activo = true AND email IS NOT NULL AND email <> ''
          ORDER BY id LIMIT 3`,
        [entidad.id]
      );
      r.rows.forEach((row) => destinatarios.add(row.email));
    } catch (err) {
      console.error('[mailService] No se pudo obtener responsables de la entidad:', err.message);
    }
  }

  const to = [...destinatarios].join(', ');
  if (!to) return { skipped: true, reason: 'no_recipients' };

  const html = `
    <div style="font-family: Arial, sans-serif; color:#111;">
      <h2 style="color:#b91c1c;">Servicio caído — IDE Nacional</h2>
      <p>El servicio <strong>${service.nombre}</strong> (${service.tipo}) de la entidad
      <strong>${entidad ? entidad.nombre : `#${service.entidad_id}`}</strong> ha dejado de responder
      correctamente tras ${service.fallos_consecutivos} intentos consecutivos.</p>
      <p><strong>URL:</strong> ${service.url_base}</p>
      <p>Por favor verifique la disponibilidad del servicio a la brevedad.</p>
      <hr/>
      <p style="font-size:12px;color:#666;">Notificación automática generada por la Plataforma IDE Nacional (IDEP).</p>
    </div>`;

  const result = await send({ to, subject: `Servicio ${service.nombre} caído — IDE Nacional`, html });
  lastAlertSent.set(service.id, Date.now());
  return result;
}

/**
 * Send a "servicio recuperado" notification to the platform admin.
 * @param {object} service  ide.services row
 */
async function alertaRecuperacion(service) {
  const to = config.ADMIN_EMAIL;
  if (!to) return { skipped: true, reason: 'no_recipients' };

  const html = `
    <div style="font-family: Arial, sans-serif; color:#111;">
      <h2 style="color:#15803d;">Servicio recuperado — IDE Nacional</h2>
      <p>El servicio <strong>${service.nombre}</strong> (${service.tipo}) ha vuelto a responder correctamente.</p>
      <p><strong>URL:</strong> ${service.url_base}</p>
      <hr/>
      <p style="font-size:12px;color:#666;">Notificación automática generada por la Plataforma IDE Nacional (IDEP).</p>
    </div>`;

  return send({ to, subject: `Servicio ${service.nombre} recuperado — IDE Nacional`, html });
}

module.exports = { send, alertaCaida, alertaRecuperacion };
