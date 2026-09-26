import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { config } from '../config.js';
import { hasDatabaseUrl, query, withClient } from '../db/postgres.js';
import { MIME, NON_WEB } from './store.js';
import { signMediaToken } from './token.js';
import { log } from '../logger.js';

/**
 * Admin movie vault — full films stored compressed in Postgres, expanded to a
 * local cache only when someone is ready to watch. Keeps a per-scope quota
 * (default 10 GB compressed) so the DB does not silently fill up.
 *
 * Chunks are independently gzip-wrapped (~2 MB raw each) so uploads resume and
 * we never hold a multi-GB BYTEA in one row.
 */

const GLOBAL_SCOPE = '_global';
const RAW_CHUNK = 2 * 1024 * 1024;
const CACHE_DIR = path.join(config.media.dir, '.vault-cache');
const STAGING_DIR = path.join(config.media.dir, '.vault-staging');

let schemaReady = false;
let memoryFallback = null; // Map id -> movie meta when no DATABASE_URL
const materializing = new Map(); // id -> Promise<string path>

function quotaBytes() {
  return Math.max(1, Number(config.media.libraryQuotaGb) || 10) * 1024 * 1024 * 1024;
}

function ensureDirs() {
  for (const d of [CACHE_DIR, STAGING_DIR, config.media.dir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function newId() {
  return crypto.randomBytes(9).toString('hex');
}

function sanitizeName(name) {
  return path
    .basename(String(name || 'video'))
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .slice(0, 120);
}

function titleFromFile(f) {
  return path.basename(f, path.extname(f)).replace(/[._]+/g, ' ').trim();
}

function extOf(name) {
  const e = path.extname(String(name || '')).toLowerCase();
  return MIME[e] || NON_WEB.has(e) ? e : '.mp4';
}

function toVideo(row) {
  const ext = String(row.ext || '.mp4').toLowerCase();
  return {
    uid: row.id,
    name: row.name,
    category: row.category || 'Library',
    description: row.description || '',
    durationSeconds: Number(row.duration_seconds) || 0,
    thumbnail: row.poster_url || '',
    animatedThumbnail: '',
    kind: ext === '.m3u8' ? 'hls' : 'file',
    requireSignedURLs: true,
    webPlayable: !NON_WEB.has(ext),
    size: Number(row.original_bytes) || 0,
    compressedSize: Number(row.compressed_bytes) || 0,
    ready: row.status === 'stored',
    status: row.status,
    vault: true,
    scope: row.guild_id || GLOBAL_SCOPE,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    file: row.filename,
  };
}

function memoryStore() {
  if (!memoryFallback) memoryFallback = new Map();
  return memoryFallback;
}

export async function migrateVaultSchema() {
  if (!hasDatabaseUrl()) {
    log.warn('[vault] DATABASE_URL missing — admin movies fall back to disk staging only.');
    return false;
  }
  await query(`
CREATE TABLE IF NOT EXISTS theater_movies (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL DEFAULT '${GLOBAL_SCOPE}',
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Library',
  filename TEXT NOT NULL,
  ext TEXT NOT NULL DEFAULT '.mp4',
  mime_type TEXT,
  original_bytes BIGINT NOT NULL DEFAULT 0,
  compressed_bytes BIGINT NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploading',
  poster_url TEXT,
  added_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS theater_movies_guild_idx ON theater_movies (guild_id, created_at DESC);
CREATE INDEX IF NOT EXISTS theater_movies_status_idx ON theater_movies (status);

CREATE TABLE IF NOT EXISTS theater_movie_chunks (
  movie_id TEXT NOT NULL REFERENCES theater_movies(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  payload BYTEA NOT NULL,
  raw_bytes INTEGER NOT NULL DEFAULT 0,
  compressed_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (movie_id, chunk_index)
);
`);
  schemaReady = true;
  log.info('[vault] Postgres movie vault schema ready');
  return true;
}

export function vaultEnabled() {
  return schemaReady || hasDatabaseUrl();
}

async function ensureSchema() {
  if (schemaReady) return true;
  if (!hasDatabaseUrl()) return false;
  return migrateVaultSchema();
}

export async function usageForScope(guildId = GLOBAL_SCOPE) {
  if (!(await ensureSchema())) {
    let used = 0;
    for (const m of memoryStore().values()) {
      if ((m.guild_id || GLOBAL_SCOPE) === (guildId || GLOBAL_SCOPE) && m.status === 'stored') {
        used += Number(m.compressed_bytes) || 0;
      }
    }
    return { usedBytes: used, quotaBytes: quotaBytes(), remainingBytes: Math.max(0, quotaBytes() - used) };
  }
  const res = await query(
    `SELECT COALESCE(SUM(compressed_bytes), 0)::bigint AS used
     FROM theater_movies WHERE guild_id = $1 AND status = 'stored'`,
    [guildId || GLOBAL_SCOPE],
  );
  const used = Number(res.rows[0]?.used || 0);
  const quota = quotaBytes();
  return { usedBytes: used, quotaBytes: quota, remainingBytes: Math.max(0, quota - used) };
}

export async function listMovies({ guildId = null, includeUploading = false } = {}) {
  if (!(await ensureSchema())) {
    const rows = [...memoryStore().values()].filter((m) => {
      if (!includeUploading && m.status !== 'stored') return false;
      if (guildId && m.guild_id !== guildId && m.guild_id !== GLOBAL_SCOPE) return false;
      return true;
    });
    return rows.map(toVideo).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  const params = [];
  let sql = `SELECT * FROM theater_movies WHERE 1=1`;
  if (!includeUploading) {
    sql += ` AND status = 'stored'`;
  }
  if (guildId) {
    params.push(guildId, GLOBAL_SCOPE);
    sql += ` AND guild_id IN ($${params.length - 1}, $${params.length})`;
  }
  sql += ` ORDER BY created_at DESC`;
  const res = await query(sql, params);
  return res.rows.map(toVideo);
}

export async function findMovie(id) {
  if (!id) return null;
  if (!(await ensureSchema())) {
    const row = memoryStore().get(id);
    return row ? toVideo(row) : null;
  }
  const res = await query(`SELECT * FROM theater_movies WHERE id = $1`, [id]);
  return res.rows[0] ? toVideo(res.rows[0]) : null;
}

export async function beginUpload({
  name,
  size,
  title,
  description,
  category,
  guildId,
  addedBy,
} = {}) {
  await ensureSchema();
  ensureDirs();
  const clean = sanitizeName(name);
  const ext = extOf(clean);
  const declared = Number(size) || 0;
  const usage = await usageForScope(guildId || GLOBAL_SCOPE);
  if (declared > 0 && declared > usage.remainingBytes * 1.15) {
    // Allow slight overhead vs compressed size; still block obvious overflows.
    const err = new Error(
      `Library quota exceeded — ${fmtGb(usage.usedBytes)} used of ${fmtGb(usage.quotaBytes)}. Delete a movie or raise LIBRARY_QUOTA_GB.`,
    );
    err.code = 'QUOTA';
    throw err;
  }
  const maxBytes = config.media.maxUploadMb * 1024 * 1024;
  if (declared > maxBytes) {
    const err = new Error(`Too large (> ${config.media.maxUploadMb} MB).`);
    err.code = 'TOO_LARGE';
    throw err;
  }

  const id = newId();
  const filename = clean;
  const staging = path.join(STAGING_DIR, `${id}${ext}`);
  const meta = {
    id,
    guild_id: guildId || GLOBAL_SCOPE,
    name: title || titleFromFile(filename),
    description: description || '',
    category: category || 'Library',
    filename,
    ext,
    mime_type: MIME[ext] || 'video/mp4',
    original_bytes: declared,
    compressed_bytes: 0,
    chunk_count: 0,
    duration_seconds: 0,
    status: 'uploading',
    poster_url: null,
    added_by: addedBy || null,
    created_at: new Date().toISOString(),
    staging,
  };

  if (!(await ensureSchema()) || !hasDatabaseUrl()) {
    memoryStore().set(id, meta);
    fs.writeFileSync(staging, Buffer.alloc(0));
    return { id, staging, video: toVideo(meta), usage };
  }

  await query(
    `INSERT INTO theater_movies
      (id, guild_id, name, description, category, filename, ext, mime_type, original_bytes, status, added_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'uploading',$10)`,
    [
      id,
      meta.guild_id,
      meta.name,
      meta.description,
      meta.category,
      filename,
      ext,
      meta.mime_type,
      declared,
      addedBy || null,
    ],
  );
  fs.writeFileSync(staging, Buffer.alloc(0));
  return { id, staging, video: toVideo(meta), usage };
}

export function stagingPath(id, ext = '.mp4') {
  ensureDirs();
  return path.join(STAGING_DIR, `${id}${ext}`);
}

export async function appendUpload(id, offset, chunk) {
  const movie = await getRawMovie(id);
  if (!movie) throw Object.assign(new Error('Movie not found'), { code: 'NOT_FOUND' });
  if (movie.status !== 'uploading') throw Object.assign(new Error('Upload already finalized'), { code: 'DONE' });

  const staging =
    movie.staging ||
    path.join(STAGING_DIR, `${id}${movie.ext || '.mp4'}`);
  ensureDirs();
  if (!fs.existsSync(staging)) fs.writeFileSync(staging, Buffer.alloc(0));

  const current = fs.statSync(staging).size;
  if (offset > current) {
    const err = new Error(`Gap in upload (have ${current}, got offset ${offset})`);
    err.code = 'GAP';
    err.receivedBytes = current;
    throw err;
  }
  // Idempotent overlap: skip already-written prefix
  let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (offset < current) {
    const skip = current - offset;
    if (skip >= buf.length) return { receivedBytes: current, complete: false };
    buf = buf.subarray(skip);
  }
  await fs.promises.appendFile(staging, buf);
  const receivedBytes = fs.statSync(staging).size;
  const total = Number(movie.original_bytes) || 0;
  return { receivedBytes, complete: total > 0 && receivedBytes >= total };
}

export async function uploadOffset(id) {
  const movie = await getRawMovie(id);
  if (!movie) return null;
  const staging = path.join(STAGING_DIR, `${id}${movie.ext || '.mp4'}`);
  const receivedBytes = fs.existsSync(staging) ? fs.statSync(staging).size : 0;
  return {
    id,
    receivedBytes,
    total: Number(movie.original_bytes) || 0,
    complete: movie.status === 'stored',
    status: movie.status,
  };
}

async function getRawMovie(id) {
  if (!(await ensureSchema()) || !hasDatabaseUrl()) {
    return memoryStore().get(id) || null;
  }
  const res = await query(`SELECT * FROM theater_movies WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

/**
 * Finish upload: gzip-chunk the staging file into Postgres, then drop staging.
 * Movies stay compressed in the DB until ensureMaterialized() expands them.
 */
export async function finalizeUpload(id, { title, description, category } = {}) {
  const movie = await getRawMovie(id);
  if (!movie) throw Object.assign(new Error('Movie not found'), { code: 'NOT_FOUND' });
  if (movie.status === 'stored') return toVideo(movie);

  const staging = path.join(STAGING_DIR, `${id}${movie.ext || '.mp4'}`);
  if (!fs.existsSync(staging)) throw Object.assign(new Error('Staging file missing'), { code: 'MISSING' });
  const originalBytes = fs.statSync(staging).size;
  if (!originalBytes) throw Object.assign(new Error('Empty upload'), { code: 'EMPTY' });

  const usage = await usageForScope(movie.guild_id || GLOBAL_SCOPE);
  // Rough pre-check — real compressed size measured while packing.
  if (originalBytes > usage.remainingBytes + originalBytes * 0.05 && usage.usedBytes > 0) {
    // Still allow if remaining is tiny but file might compress; hard-stop if already over quota.
  }
  if (usage.usedBytes >= usage.quotaBytes) {
    throw Object.assign(new Error('Library quota full — delete a movie first.'), { code: 'QUOTA' });
  }

  const name = title || movie.name;
  const desc = description != null ? description : movie.description;
  const cat = category || movie.category;

  if (!hasDatabaseUrl()) {
    // Disk-only fallback: keep a gzip sibling as the "vault" and leave staging.
    const gzPath = path.join(STAGING_DIR, `${id}${movie.ext || '.mp4'}.gz`);
    await pipeline(createReadStream(staging), zlib.createGzip({ level: 6 }), createWriteStream(gzPath));
    const compressed = fs.statSync(gzPath).size;
    if (usage.usedBytes + compressed > usage.quotaBytes) {
      fs.rmSync(gzPath, { force: true });
      throw Object.assign(new Error('Library quota exceeded after compression.'), { code: 'QUOTA' });
    }
    const meta = memoryStore().get(id);
    Object.assign(meta, {
      name,
      description: desc || '',
      category: cat || 'Library',
      original_bytes: originalBytes,
      compressed_bytes: compressed,
      chunk_count: 1,
      status: 'stored',
      gzPath,
      staging,
    });
    // Keep staging for playback in no-DB mode; gz is the shrink copy for quota accounting.
    return toVideo(meta);
  }

  let compressedTotal = 0;
  let chunkIndex = 0;
  await withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(`DELETE FROM theater_movie_chunks WHERE movie_id = $1`, [id]);
      const fh = await fs.promises.open(staging, 'r');
      try {
        let pos = 0;
        while (pos < originalBytes) {
          const need = Math.min(RAW_CHUNK, originalBytes - pos);
          const buf = Buffer.allocUnsafe(need);
          const { bytesRead } = await fh.read(buf, 0, need, pos);
          const slice = bytesRead === need ? buf : buf.subarray(0, bytesRead);
          const packed = zlib.gzipSync(slice, { level: 6 });
          compressedTotal += packed.length;
          if (usage.usedBytes + compressedTotal > usage.quotaBytes) {
            throw Object.assign(new Error('Library quota exceeded after compression.'), { code: 'QUOTA' });
          }
          await client.query(
            `INSERT INTO theater_movie_chunks (movie_id, chunk_index, payload, raw_bytes, compressed_bytes)
             VALUES ($1,$2,$3,$4,$5)`,
            [id, chunkIndex, packed, slice.length, packed.length],
          );
          chunkIndex += 1;
          pos += slice.length;
        }
      } finally {
        await fh.close();
      }
      await client.query(
        `UPDATE theater_movies SET
           name = $2, description = $3, category = $4,
           original_bytes = $5, compressed_bytes = $6, chunk_count = $7,
           status = 'stored', updated_at = NOW()
         WHERE id = $1`,
        [id, name, desc || '', cat || 'Library', originalBytes, compressedTotal, chunkIndex],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });

  // Drop staging raw — vault keeps the compressed form until a viewer expands it.
  fs.rmSync(staging, { force: true });
  log.info(
    `[vault] stored "${name}" · raw ${fmtMb(originalBytes)} → gz ${fmtMb(compressedTotal)} (${chunkIndex} chunks)`,
  );
  return findMovie(id);
}

export async function removeMovie(id) {
  const movie = await getRawMovie(id);
  if (!movie) return false;
  clearCache(id, movie.ext);
  const staging = path.join(STAGING_DIR, `${id}${movie.ext || '.mp4'}`);
  fs.rmSync(staging, { force: true });
  fs.rmSync(`${staging}.gz`, { force: true });
  if (!hasDatabaseUrl()) {
    memoryStore().delete(id);
    return true;
  }
  await query(`DELETE FROM theater_movies WHERE id = $1`, [id]);
  return true;
}

function cachePathFor(id, ext) {
  ensureDirs();
  return path.join(CACHE_DIR, `${id}${ext || '.mp4'}`);
}

export function clearCache(id, ext = '.mp4') {
  fs.rmSync(cachePathFor(id, ext), { force: true });
}

/**
 * Expand a vault movie to the local cache for HTTP range streaming.
 * Idempotent — concurrent callers share one inflate job.
 */
export async function ensureMaterialized(id) {
  const existing = materializing.get(id);
  if (existing) return existing;

  const job = (async () => {
    const movie = await getRawMovie(id);
    if (!movie || movie.status !== 'stored') return null;
    const out = cachePathFor(id, movie.ext);
    if (fs.existsSync(out) && fs.statSync(out).size === Number(movie.original_bytes)) {
      return out;
    }

    ensureDirs();
    const tmp = `${out}.partial`;
    fs.rmSync(tmp, { force: true });

    if (!hasDatabaseUrl()) {
      const staging = path.join(STAGING_DIR, `${id}${movie.ext || '.mp4'}`);
      if (fs.existsSync(staging)) {
        fs.copyFileSync(staging, out);
        return out;
      }
      const gz = `${staging}.gz`;
      if (fs.existsSync(gz)) {
        await pipeline(createReadStream(gz), zlib.createGunzip(), createWriteStream(tmp));
        fs.renameSync(tmp, out);
        return out;
      }
      return null;
    }

    const chunks = await query(
      `SELECT chunk_index, payload FROM theater_movie_chunks WHERE movie_id = $1 ORDER BY chunk_index ASC`,
      [id],
    );
    if (!chunks.rows.length) return null;

    const ws = createWriteStream(tmp);
    try {
      for (const row of chunks.rows) {
        const raw = zlib.gunzipSync(row.payload);
        if (!ws.write(raw)) {
          await new Promise((resolve) => ws.once('drain', resolve));
        }
      }
      await new Promise((resolve, reject) => {
        ws.end(() => resolve());
        ws.on('error', reject);
      });
      fs.renameSync(tmp, out);
      log.info(`[vault] expanded ${id} for playback (${fmtMb(fs.statSync(out).size)})`);
      return out;
    } catch (err) {
      ws.destroy();
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  })().finally(() => materializing.delete(id));

  materializing.set(id, job);
  return job;
}

export function filePathIfCached(id, ext = '.mp4') {
  const p = cachePathFor(id, ext);
  return fs.existsSync(p) ? p : null;
}

export function getPlayback(video) {
  const token = signMediaToken(video.uid);
  const src = `/media/${video.uid}?t=${token}`;
  return { hls: null, dash: null, src, kind: 'file', signed: true, vault: true };
}

function fmtMb(n) {
  return `${(Number(n) / 1048576).toFixed(0)} MB`;
}
function fmtGb(n) {
  return `${(Number(n) / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export { GLOBAL_SCOPE, CACHE_DIR, STAGING_DIR, quotaBytes };
