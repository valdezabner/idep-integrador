'use strict';

const { Pool } = require('pg');
const config = require('../config');

// ── Pool singleton ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,                  // maximum pool size
  idleTimeoutMillis: 30000, // close idle clients after 30 s
  connectionTimeoutMillis: 5000, // fail fast if no connection in 5 s
  ssl: config.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : false,
});

// Log unexpected errors from idle clients so they don't crash the process
pool.on('error', (err) => {
  console.error('[pool] Unexpected error on idle client:', err.message);
});

// ── query helper ────────────────────────────────────────────────────────────
/**
 * Execute a parameterised query.
 *
 * @param {string} text   - SQL statement
 * @param {Array}  [params] - query parameters (positional $1, $2, …)
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    if (config.isDev) {
      console.debug(`[pool] query (${duration}ms) rows=${result.rowCount} — ${text.slice(0, 80)}`);
    }
    return result;
  } catch (err) {
    console.error(`[pool] query error — ${text.slice(0, 80)}\n`, err.message);
    throw err;
  }
}

// ── transaction helper ──────────────────────────────────────────────────────
/**
 * Execute a callback inside a serialisable transaction.
 * The callback receives a bound `query(text, params)` that uses the same client.
 *
 * @param {(query: Function) => Promise<*>} callback
 * @returns {Promise<*>} whatever the callback returns
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── connection test ─────────────────────────────────────────────────────────
/**
 * Verify the pool can reach the database.
 * Resolves to true on success, rejects with the underlying error on failure.
 */
async function testConnection() {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    return true;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction, testConnection };
