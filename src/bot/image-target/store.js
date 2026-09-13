import { randomUUID } from 'node:crypto';
import { query, withClient, hasDatabaseUrl } from '../../db/postgres.js';
import {
  DEFAULT_ACTION,
  DEFAULT_ESCALATION,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_TIMEOUT_MS,
  MAX_DETECTION_LOG,
} from './constants.js';
import * as memory from './store-memory.js';

/**
 * Image Target Watcher — Postgres-backed store (Railway DATABASE_URL).
 *
 * Falls back to an in-memory store only when:
 *   - IMAGE_TARGET_MEMORY=1, or
 *   - NODE_ENV=test / running under node:test without DATABASE_URL
 *
 * Production requires DATABASE_URL. JSON file storage has been removed.
 */

export const DEFAULT_GUILD = {
  channels: [],
  action: DEFAULT_ACTION,
  threshold: DEFAULT_SIMILARITY_THRESHOLD,
  escalationEnabled: false,
  escalation: [...DEFAULT_ESCALATION],
  timeoutMs: DEFAULT_TIMEOUT_MS,
  logChannelId: null,
};

function useMemory() {
  if (process.env.IMAGE_TARGET_MEMORY === '1') return true;
  if (hasDatabaseUrl()) return false;
  // Allow unit tests without a live DB.
  if (process.env.NODE_ENV === 'test' || process.env.npm_lifecycle_event?.includes('test')) {
    return true;
  }
  return false;
}

function mapSettingsRow(row) {
  if (!row) {
    return { ...DEFAULT_GUILD };
  }
  return {
    channels: row.channels || [],
    action: row.action || DEFAULT_ACTION,
    threshold: Number(row.threshold ?? DEFAULT_SIMILARITY_THRESHOLD),
    escalationEnabled: Boolean(row.escalation_enabled),
    escalation: row.escalation?.length ? row.escalation : [...DEFAULT_ESCALATION],
    timeoutMs: Number(row.timeout_ms ?? DEFAULT_TIMEOUT_MS),
    logChannelId: row.log_channel_id || null,
  };
}

function mapTargetRow(row) {
  if (!row) return null;
  let embedding = row.embedding;
  if (typeof embedding === 'string') {
    try { embedding = JSON.parse(embedding); } catch { embedding = null; }
  }
  return {
    guildId: row.guild_id,
    targetId: row.target_id,
    name: row.name,
    perceptualHash: row.perceptual_hash,
    blockHash: row.block_hash,
    embedding,
    embeddingModel: row.embedding_model,
    contentHash: row.content_hash,
    mimeType: row.mime_type,
    mediaKind: row.media_kind || 'image',
    similarityThreshold: row.similarity_threshold == null ? null : Number(row.similarity_threshold),
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    enabled: Boolean(row.enabled),
  };
}

async function ensureGuildRow(guildId, client = null) {
  const run = client ? client.query.bind(client) : query;
  await run(
    `INSERT INTO image_target_guild_settings (guild_id)
     VALUES ($1)
     ON CONFLICT (guild_id) DO NOTHING`,
    [guildId],
  );
}

export async function getGuildConfig(guildId) {
  if (useMemory()) return memory.getGuildConfig(guildId);

  await ensureGuildRow(guildId);
  const res = await query(
    `SELECT * FROM image_target_guild_settings WHERE guild_id = $1`,
    [guildId],
  );
  return mapSettingsRow(res.rows[0]);
}

export async function patchGuildConfig(guildId, patch) {
  if (useMemory()) return memory.patchGuildConfig(guildId, patch);

  await ensureGuildRow(guildId);
  const current = await getGuildConfig(guildId);
  const next = { ...current, ...patch };

  await query(
    `UPDATE image_target_guild_settings SET
       channels = $2,
       action = $3,
       threshold = $4,
       escalation_enabled = $5,
       escalation = $6,
       timeout_ms = $7,
       log_channel_id = $8,
       updated_at = NOW()
     WHERE guild_id = $1`,
    [
      guildId,
      next.channels || [],
      next.action || DEFAULT_ACTION,
      next.threshold ?? DEFAULT_SIMILARITY_THRESHOLD,
      Boolean(next.escalationEnabled),
      next.escalation?.length ? next.escalation : [...DEFAULT_ESCALATION],
      next.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      next.logChannelId || null,
    ],
  );
  return getGuildConfig(guildId);
}

export async function listTargets(guildId, { includeDisabled = true } = {}) {
  if (useMemory()) return memory.listTargets(guildId, { includeDisabled });

  await ensureGuildRow(guildId);
  const res = includeDisabled
    ? await query(
      `SELECT * FROM image_targets WHERE guild_id = $1 ORDER BY created_at ASC`,
      [guildId],
    )
    : await query(
      `SELECT * FROM image_targets WHERE guild_id = $1 AND enabled = TRUE ORDER BY created_at ASC`,
      [guildId],
    );
  return res.rows.map(mapTargetRow);
}

export async function getTarget(guildId, targetId) {
  if (useMemory()) return memory.getTarget(guildId, targetId);

  const res = await query(
    `SELECT * FROM image_targets WHERE guild_id = $1 AND target_id = $2`,
    [guildId, targetId],
  );
  return mapTargetRow(res.rows[0]);
}

export async function findTargetByName(guildId, name) {
  if (useMemory()) return memory.findTargetByName(guildId, name);

  const needle = String(name || '').trim().toLowerCase();
  const res = await query(
    `SELECT * FROM image_targets
     WHERE guild_id = $1 AND LOWER(name) = $2
     ORDER BY created_at ASC
     LIMIT 1`,
    [guildId, needle],
  );
  return mapTargetRow(res.rows[0]);
}

export async function addTarget(guildId, {
  name,
  perceptualHash,
  blockHash = null,
  embedding = null,
  embeddingModel = null,
  contentHash = null,
  mimeType = null,
  createdBy,
  threshold = null,
  mediaKind = 'image',
}) {
  if (useMemory()) {
    return memory.addTarget(guildId, {
      name, perceptualHash, blockHash, embedding, embeddingModel,
      contentHash, mimeType, createdBy, threshold, mediaKind,
    });
  }

  return withClient(async (client) => {
    await ensureGuildRow(guildId, client);
    const targetId = randomUUID();
    const displayName = name || `Target`;
    const res = await client.query(
      `INSERT INTO image_targets (
         target_id, guild_id, name, perceptual_hash, block_hash,
         embedding, embedding_model, content_hash, mime_type, media_kind,
         similarity_threshold, created_by, enabled
       ) VALUES (
         $1,$2,$3,$4,$5,
         $6::jsonb,$7,$8,$9,$10,
         $11,$12, TRUE
       )
       RETURNING *`,
      [
        targetId,
        guildId,
        displayName,
        perceptualHash,
        blockHash,
        embedding == null ? null : JSON.stringify(embedding),
        embeddingModel,
        contentHash,
        mimeType,
        mediaKind || 'image',
        threshold,
        createdBy,
      ],
    );
    return mapTargetRow(res.rows[0]);
  });
}

export async function updateTarget(guildId, targetId, patch) {
  if (useMemory()) return memory.updateTarget(guildId, targetId, patch);

  const current = await getTarget(guildId, targetId);
  if (!current) return null;

  const next = { ...current, ...patch };
  const res = await query(
    `UPDATE image_targets SET
       name = $3,
       perceptual_hash = $4,
       block_hash = $5,
       embedding = $6::jsonb,
       embedding_model = $7,
       content_hash = $8,
       mime_type = $9,
       media_kind = $10,
       similarity_threshold = $11,
       enabled = $12
     WHERE guild_id = $1 AND target_id = $2
     RETURNING *`,
    [
      guildId,
      targetId,
      next.name,
      next.perceptualHash,
      next.blockHash,
      next.embedding == null ? null : JSON.stringify(next.embedding),
      next.embeddingModel,
      next.contentHash,
      next.mimeType,
      next.mediaKind || 'image',
      next.similarityThreshold,
      Boolean(next.enabled),
    ],
  );
  return mapTargetRow(res.rows[0]);
}

export async function removeTarget(guildId, targetId) {
  if (useMemory()) return memory.removeTarget(guildId, targetId);

  const res = await query(
    `DELETE FROM image_targets WHERE guild_id = $1 AND target_id = $2`,
    [guildId, targetId],
  );
  return res.rowCount > 0;
}

export async function setChannels(guildId, channelIds) {
  return patchGuildConfig(guildId, {
    channels: [...new Set(channelIds.map(String))],
  });
}

export async function addChannel(guildId, channelId) {
  if (useMemory()) return memory.addChannel(guildId, channelId);

  const cfg = await getGuildConfig(guildId);
  if (!cfg.channels.includes(channelId)) {
    cfg.channels.push(channelId);
    await patchGuildConfig(guildId, { channels: cfg.channels });
  }
  return (await getGuildConfig(guildId)).channels;
}

export async function removeChannel(guildId, channelId) {
  if (useMemory()) return memory.removeChannel(guildId, channelId);

  const cfg = await getGuildConfig(guildId);
  await patchGuildConfig(guildId, {
    channels: cfg.channels.filter((id) => id !== channelId),
  });
  return (await getGuildConfig(guildId)).channels;
}

export async function isChannelWatched(guildId, channelId) {
  if (useMemory()) return memory.isChannelWatched(guildId, channelId);

  const res = await query(
    `SELECT 1 FROM image_target_guild_settings
     WHERE guild_id = $1 AND $2 = ANY(channels)
     LIMIT 1`,
    [guildId, channelId],
  );
  return res.rowCount > 0;
}

export async function recordDetection(guildId, entry) {
  if (useMemory()) return memory.recordDetection(guildId, entry);

  const id = randomUUID();
  const res = await query(
    `INSERT INTO image_target_detections (
       id, guild_id, user_id, channel_id, message_id,
       target_id, target_name, similarity, method, action, deleted
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      id,
      guildId,
      entry.userId,
      entry.channelId,
      entry.messageId,
      entry.targetId || null,
      entry.targetName || null,
      entry.similarity ?? null,
      entry.method || null,
      entry.action || null,
      Boolean(entry.deleted),
    ],
  );

  // Trim old rows per guild (best-effort).
  await query(
    `DELETE FROM image_target_detections
     WHERE guild_id = $1
       AND id NOT IN (
         SELECT id FROM image_target_detections
         WHERE guild_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       )`,
    [guildId, MAX_DETECTION_LOG],
  ).catch(() => {});

  const row = res.rows[0];
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    targetId: row.target_id,
    targetName: row.target_name,
    similarity: row.similarity == null ? null : Number(row.similarity),
    method: row.method,
    action: row.action,
    deleted: Boolean(row.deleted),
    timestamp: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

export async function getStrikes(guildId, userId) {
  if (useMemory()) return memory.getStrikes(guildId, userId);

  const res = await query(
    `SELECT count FROM image_target_strikes WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  );
  return res.rows[0]?.count || 0;
}

export async function incrementStrike(guildId, userId) {
  if (useMemory()) return memory.incrementStrike(guildId, userId);

  const res = await query(
    `INSERT INTO image_target_strikes (guild_id, user_id, count, updated_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (guild_id, user_id)
     DO UPDATE SET count = image_target_strikes.count + 1, updated_at = NOW()
     RETURNING count`,
    [guildId, userId],
  );
  return res.rows[0].count;
}

export async function resetStrikes(guildId, userId) {
  if (useMemory()) return memory.resetStrikes(guildId, userId);

  await query(
    `DELETE FROM image_target_strikes WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  );
}

export async function effectiveThreshold(guildId, target) {
  if (useMemory()) return memory.effectiveThreshold(guildId, target);

  if (target?.similarityThreshold != null) return target.similarityThreshold;
  const cfg = await getGuildConfig(guildId);
  return cfg.threshold;
}

/** Test helper — clears memory backend only. */
export function __resetMemoryStore() {
  return memory.__resetMemoryStore();
}
