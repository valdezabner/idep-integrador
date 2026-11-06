'use strict';

/**
 * clasificacionService.js
 * Thematic classification catalogue (ide.temas / ide.subtemas) and
 * assignment of a unique classification code to datasets/services.
 */

const { query } = require('../db/pool');

/**
 * List all temas with their subtemas nested under `subtemas`.
 * @returns {Promise<Array>}
 */
async function listarTemas() {
  const temasRes = await query('SELECT * FROM ide.temas ORDER BY orden, codigo');
  const temas = temasRes.rows;

  const result = [];
  for (const tema of temas) {
    const subRes = await query('SELECT * FROM ide.subtemas WHERE tema_codigo = $1 ORDER BY orden, codigo', [
      tema.codigo,
    ]);
    result.push({ ...tema, subtemas: subRes.rows });
  }
  return result;
}

function tablaParaTipo(tipoRecurso) {
  const t = String(tipoRecurso || '').toLowerCase();
  if (t === 'dataset' || t === 'dato' || t === 'datasets') return 'datasets';
  if (t === 'servicio' || t === 'service' || t === 'services') return 'services';
  return null;
}

/**
 * Assign a tema/subtema classification to a dataset or service and compute
 * its CCIDEP unique code: {temaCodigo}{subtemaCodigo}-{sigla}-{correlativo}.
 *
 * @param {string} tipoRecurso  'dataset' | 'servicio'
 * @param {number} recursoId
 * @param {string} temaCodigo
 * @param {string} subtemaCodigo
 * @returns {Promise<object>} the updated dataset/service row
 */
async function asignar(tipoRecurso, recursoId, temaCodigo, subtemaCodigo) {
  const tabla = tablaParaTipo(tipoRecurso);
  if (!tabla) {
    throw new Error(`tipoRecurso inválido: ${tipoRecurso} (use 'dataset' o 'servicio')`);
  }

  const temaRes = await query('SELECT * FROM ide.temas WHERE codigo = $1', [temaCodigo]);
  if (temaRes.rowCount === 0) {
    throw new Error(`Tema ${temaCodigo} no existe`);
  }

  const subtemaRes = await query('SELECT * FROM ide.subtemas WHERE codigo = $1', [subtemaCodigo]);
  if (subtemaRes.rowCount === 0) {
    throw new Error(`Subtema ${subtemaCodigo} no existe`);
  }
  if (subtemaRes.rows[0].tema_codigo !== temaCodigo) {
    throw new Error(`El subtema ${subtemaCodigo} no pertenece al tema ${temaCodigo}`);
  }

  const recursoRes = await query(
    `SELECT r.id, e.sigla, e.codigo AS entidad_codigo
       FROM ide.${tabla} r
       JOIN ide.entidades e ON e.id = r.entidad_id
      WHERE r.id = $1`,
    [recursoId]
  );
  if (recursoRes.rowCount === 0) {
    throw new Error(`${tabla === 'datasets' ? 'Dataset' : 'Servicio'} ${recursoId} no existe`);
  }
  const sigla = recursoRes.rows[0].sigla || recursoRes.rows[0].entidad_codigo || 'ENT';

  const prefix = `${temaCodigo}${subtemaCodigo}-${sigla}-`;
  const countRes = await query(`SELECT COUNT(*)::INT AS n FROM ide.${tabla} WHERE codigo_unico LIKE $1`, [
    `${prefix}%`,
  ]);
  const correlativo = countRes.rows[0].n + 1;
  const codigoUnico = `${prefix}${String(correlativo).padStart(4, '0')}`;

  const updateRes = await query(
    `UPDATE ide.${tabla}
        SET tema_codigo = $2, subtema_codigo = $3, codigo_unico = $4, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [recursoId, temaCodigo, subtemaCodigo, codigoUnico]
  );
  return updateRes.rows[0];
}

module.exports = { listarTemas, asignar };
