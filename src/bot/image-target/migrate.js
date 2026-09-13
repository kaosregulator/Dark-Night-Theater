import { query, hasDatabaseUrl } from '../../db/postgres.js';
import { log } from '../../logger.js';

/**
 * Idempotent schema for the Image Target Watcher.
 * Safe to run on every boot.
 */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS image_target_guild_settings (
  guild_id TEXT PRIMARY KEY,
  channels TEXT[] NOT NULL DEFAULT '{}',
  action TEXT NOT NULL DEFAULT 'delete_log',
  threshold DOUBLE PRECISION NOT NULL DEFAULT 0.9,
  escalation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  escalation TEXT[] NOT NULL DEFAULT ARRAY['delete_warn','delete_timeout','delete_kick','delete_ban'],
  timeout_ms INTEGER NOT NULL DEFAULT 600000,
  log_channel_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS image_targets (
  target_id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  perceptual_hash TEXT NOT NULL,
  block_hash TEXT,
  embedding JSONB,
  embedding_model TEXT,
  content_hash TEXT,
  mime_type TEXT,
  media_kind TEXT NOT NULL DEFAULT 'image',
  similarity_threshold DOUBLE PRECISION,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT image_targets_guild_fk
    FOREIGN KEY (guild_id) REFERENCES image_target_guild_settings(guild_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS image_targets_guild_idx
  ON image_targets (guild_id);
CREATE INDEX IF NOT EXISTS image_targets_guild_enabled_idx
  ON image_targets (guild_id, enabled);
CREATE INDEX IF NOT EXISTS image_targets_content_hash_idx
  ON image_targets (guild_id, content_hash);

CREATE TABLE IF NOT EXISTS image_target_detections (
  id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  target_id UUID,
  target_name TEXT,
  similarity DOUBLE PRECISION,
  method TEXT,
  action TEXT,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS image_target_detections_guild_idx
  ON image_target_detections (guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS image_target_strikes (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (guild_id, user_id)
);
`;

export async function migrateImageTargetSchema() {
  if (!hasDatabaseUrl()) {
    throw new Error('DATABASE_URL missing — cannot migrate image-target schema');
  }
  await query(SCHEMA_SQL);
  log.info('[image-target] Postgres schema ready');
  return true;
}
