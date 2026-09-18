/**
 * Optional pgvector ANN prefilter (Image Target V3).
 *
 * When the `vector` extension is available, embeddings are mirrored into a
 * vector column for TOP-K retrieval. Otherwise falls back to in-memory cosine
 * over JSONB embeddings (existing V2 behavior).
 */

import { log } from '../../logger.js';
import { hasDatabaseUrl, query } from '../../db/postgres.js';
import { cosineSimilarity } from './providers/types.js';

let pgvectorReady = null; // null=unknown, true/false

export async function ensurePgvector() {
  if (!hasDatabaseUrl()) {
    pgvectorReady = false;
    return false;
  }
  if (pgvectorReady != null) return pgvectorReady;
  try {
    await query('CREATE EXTENSION IF NOT EXISTS vector');
    await query(`
      ALTER TABLE image_targets
        ADD COLUMN IF NOT EXISTS embedding_vec vector(1024);
    `);
    // Soft index — may fail on tiny tables / missing rows; ignore.
    try {
      await query(`
        CREATE INDEX IF NOT EXISTS image_targets_embedding_vec_idx
          ON image_targets
          USING ivfflat (embedding_vec vector_cosine_ops)
          WITH (lists = 100);
      `);
    } catch {
      // ivfflat needs data; skip until targets exist.
    }
    pgvectorReady = true;
    log.info('[image-target] pgvector ready');
  } catch (err) {
    pgvectorReady = false;
    log.info('[image-target] pgvector unavailable — JSONB cosine fallback:', err.message);
  }
  return pgvectorReady;
}

export function vectorLiteral(embedding) {
  if (!embedding?.length) return null;
  return `[${embedding.map((n) => Number(n) || 0).join(',')}]`;
}

export async function upsertTargetEmbeddingVec(targetId, embedding) {
  if (!(await ensurePgvector())) return false;
  const lit = vectorLiteral(embedding);
  if (!lit) return false;
  try {
    // Cast via text to avoid needing a specific pgvector JS type.
    await query(
      `UPDATE image_targets
       SET embedding_vec = $2::vector
       WHERE target_id = $1`,
      [targetId, lit],
    );
    return true;
  } catch (err) {
    log.warn('[image-target] embedding_vec upsert failed:', err.message);
    return false;
  }
}

/**
 * Rank guild targets by embedding proximity.
 * Returns topK targetIds (best first). Falls back to all IDs if no vectors.
 */
export async function topKTargetIdsByEmbedding(guildId, embedding, {
  topK = 10,
  targets = [],
} = {}) {
  if (!embedding?.length) {
    return targets.map((t) => t.targetId).slice(0, topK);
  }

  if (await ensurePgvector()) {
    try {
      const lit = vectorLiteral(embedding);
      const res = await query(
        `SELECT target_id
         FROM image_targets
         WHERE guild_id = $1
           AND enabled = TRUE
           AND embedding_vec IS NOT NULL
         ORDER BY embedding_vec <=> $2::vector
         LIMIT $3`,
        [guildId, lit, topK],
      );
      if (res.rows.length) {
        return res.rows.map((r) => r.target_id);
      }
    } catch (err) {
      log.warn('[image-target] pgvector search failed:', err.message);
    }
  }

  // JSONB / memory fallback — brute-force cosine.
  const scored = [];
  for (const t of targets) {
    if (!t.embedding?.length) continue;
    scored.push({
      id: t.targetId,
      sim: cosineSimilarity(embedding, t.embedding),
    });
  }
  scored.sort((a, b) => b.sim - a.sim);
  if (scored.length) return scored.slice(0, topK).map((s) => s.id);
  return targets.map((t) => t.targetId).slice(0, topK);
}
