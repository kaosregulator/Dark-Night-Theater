import { randomUUID } from 'node:crypto';
import { JsonStore } from '../../services/json-store.js';
import {
  DEFAULT_ACTION,
  DEFAULT_ESCALATION,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_TIMEOUT_MS,
  MAX_DETECTION_LOG,
} from './constants.js';

/**
 * Per-guild image-target configuration + target records + detection log.
 *
 * Shape:
 * {
 *   guilds: {
 *     [guildId]: {
 *       channels: string[],
 *       action: string,
 *       threshold: number,
 *       escalationEnabled: boolean,
 *       escalation: string[],
 *       timeoutMs: number,
 *       logChannelId: string | null,
 *       targets: { [targetId]: Target },
 *       detections: Detection[],
 *       strikes: { [userId]: number },
 *     }
 *   }
 * }
 */

const store = new JsonStore('image-targets.json', { guilds: {} });

export const DEFAULT_GUILD = {
  channels: [],
  action: DEFAULT_ACTION,
  threshold: DEFAULT_SIMILARITY_THRESHOLD,
  escalationEnabled: false,
  escalation: [...DEFAULT_ESCALATION],
  timeoutMs: DEFAULT_TIMEOUT_MS,
  logChannelId: null,
  targets: {},
  detections: [],
  strikes: {},
};

function ensureGuild(guildId) {
  if (!store.data.guilds[guildId]) {
    store.data.guilds[guildId] = structuredClone(DEFAULT_GUILD);
  } else {
    // Merge defaults for forward-compat when new fields are added.
    store.data.guilds[guildId] = {
      ...DEFAULT_GUILD,
      ...store.data.guilds[guildId],
      targets: store.data.guilds[guildId].targets || {},
      detections: store.data.guilds[guildId].detections || [],
      strikes: store.data.guilds[guildId].strikes || {},
      channels: store.data.guilds[guildId].channels || [],
      escalation: store.data.guilds[guildId].escalation || [...DEFAULT_ESCALATION],
    };
  }
  return store.data.guilds[guildId];
}

export function getGuildConfig(guildId) {
  return structuredClone(ensureGuild(guildId));
}

export function patchGuildConfig(guildId, patch) {
  const g = ensureGuild(guildId);
  Object.assign(g, patch);
  store.save();
  return structuredClone(g);
}

export function listTargets(guildId, { includeDisabled = true } = {}) {
  const g = ensureGuild(guildId);
  const list = Object.values(g.targets);
  return includeDisabled ? list : list.filter((t) => t.enabled);
}

export function getTarget(guildId, targetId) {
  return ensureGuild(guildId).targets[targetId] || null;
}

export function findTargetByName(guildId, name) {
  const needle = String(name || '').trim().toLowerCase();
  return listTargets(guildId).find((t) => t.name.toLowerCase() === needle) || null;
}

/**
 * Persist a new target image. Embedding may be null when Jina is unavailable —
 * local pHash still works as a fallback.
 */
export function addTarget(guildId, {
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
  const g = ensureGuild(guildId);
  const targetId = randomUUID();
  const target = {
    guildId,
    targetId,
    name: name || `Target ${Object.keys(g.targets).length + 1}`,
    perceptualHash,
    blockHash,
    embedding,
    embeddingModel,
    contentHash,
    mimeType,
    mediaKind,
    similarityThreshold: threshold,
    createdBy,
    createdAt: new Date().toISOString(),
    enabled: true,
  };
  g.targets[targetId] = target;
  store.save();
  return structuredClone(target);
}

export function updateTarget(guildId, targetId, patch) {
  const g = ensureGuild(guildId);
  const t = g.targets[targetId];
  if (!t) return null;
  Object.assign(t, patch);
  store.save();
  return structuredClone(t);
}

export function removeTarget(guildId, targetId) {
  const g = ensureGuild(guildId);
  if (!g.targets[targetId]) return false;
  delete g.targets[targetId];
  store.save();
  return true;
}

export function setChannels(guildId, channelIds) {
  return patchGuildConfig(guildId, {
    channels: [...new Set(channelIds.map(String))],
  });
}

export function addChannel(guildId, channelId) {
  const g = ensureGuild(guildId);
  if (!g.channels.includes(channelId)) {
    g.channels.push(channelId);
    store.save();
  }
  return structuredClone(g.channels);
}

export function removeChannel(guildId, channelId) {
  const g = ensureGuild(guildId);
  g.channels = g.channels.filter((id) => id !== channelId);
  store.save();
  return structuredClone(g.channels);
}

export function isChannelWatched(guildId, channelId) {
  const g = ensureGuild(guildId);
  return g.channels.includes(channelId);
}

export function recordDetection(guildId, entry) {
  const g = ensureGuild(guildId);
  const row = {
    id: randomUUID(),
    guildId,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  g.detections.unshift(row);
  if (g.detections.length > MAX_DETECTION_LOG) {
    g.detections.length = MAX_DETECTION_LOG;
  }
  store.save();
  return structuredClone(row);
}

export function getStrikes(guildId, userId) {
  return ensureGuild(guildId).strikes[userId] || 0;
}

export function incrementStrike(guildId, userId) {
  const g = ensureGuild(guildId);
  g.strikes[userId] = (g.strikes[userId] || 0) + 1;
  store.save();
  return g.strikes[userId];
}

export function resetStrikes(guildId, userId) {
  const g = ensureGuild(guildId);
  delete g.strikes[userId];
  store.save();
}

/** Resolve effective threshold for a target (per-target override or guild default). */
export function effectiveThreshold(guildId, target) {
  const g = ensureGuild(guildId);
  if (target?.similarityThreshold != null) return target.similarityThreshold;
  return g.threshold;
}
