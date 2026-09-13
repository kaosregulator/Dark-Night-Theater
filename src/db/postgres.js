import pg from 'pg';
import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * Shared PostgreSQL pool for Railway (and local) Postgres.
 * Uses DATABASE_URL. Railway typically needs SSL with rejectUnauthorized:false.
 */

const { Pool } = pg;

let pool = null;
let initError = null;

function buildPoolConfig() {
  const url = config.database?.url || process.env.DATABASE_URL || '';
  if (!url) return null;

  const cfg = {
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };

  // Railway / most hosted Postgres require TLS. Allow opt-out for local docker.
  const forceSsl = process.env.PG_SSL === 'true';
  const disableSsl = process.env.PG_SSL === 'false';
  const looksLocal =
    /localhost|127\.0\.0\.1/i.test(url) ||
    url.includes('@postgres:') ||
    url.includes('@db:');

  if (!disableSsl && (forceSsl || !looksLocal)) {
    cfg.ssl = { rejectUnauthorized: false };
  }

  return cfg;
}

export function hasDatabaseUrl() {
  return Boolean(config.database?.url || process.env.DATABASE_URL);
}

export function getPool() {
  if (pool) return pool;
  if (initError) throw initError;

  const cfg = buildPoolConfig();
  if (!cfg) {
    initError = new Error(
      'DATABASE_URL is not set. Share Postgres.DATABASE_URL into the Dark-Night-Theater Railway service.',
    );
    throw initError;
  }

  pool = new Pool(cfg);
  pool.on('error', (err) => {
    log.error('[postgres] idle client error:', err.message);
  });
  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function withClient(fn) {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Quick connectivity check used at boot. */
export async function pingDatabase() {
  const res = await query('SELECT 1 AS ok');
  return res.rows[0]?.ok === 1;
}
