import { randomUUID } from 'node:crypto';
import {
  DEFAULT_ACTION,
  DEFAULT_ESCALATION,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_TIMEOUT_MS,
  MAX_DETECTION_LOG,
} from './constants.js';

/**
 * In-memory Image Target store — used only for unit tests when DATABASE_URL
 * is not available. Production always uses Postgres (store.js).
 */

const guilds = new Map();

export const DEFAULT_GUILD = {
  channels: [],
  action: DEFAULT_ACTION,
  threshold: DEFAULT_SIMILARITY_THRESHOLD,
  escalationEnabled: false,
  escalation: [...DEFAULT_ESCALATION],
  timeoutMs: DEFAULT_TIMEOUT_MS,
  logChannelId: null,
};

function ensure(guildId) {
  if (!guilds.has(guildId)) {
    guilds.set(guildId, {
      ...structuredClone(DEFAULT_GUILD),
      targets: new Map(),
      detections: [],
      strikes: new Map(),
    });
  }
  return guilds.get(guildId);
}

export function __resetMemoryStore() {
  guilds.clear();
}

export async function getGuildConfig(guildId) {
  const g = ensure(guildId);
  return {
    channels: [...g.channels],
    action: g.action,
    threshold: g.threshold,
    escalationEnabled: g.escalationEnabled,
    escalation: [...g.escalation],
    timeoutMs: g.timeoutMs,
    logChannelId: g.logChannelId,
  };
}

export async function patchGuildConfig(guildId, patch) {
  const g = ensure(guildId);
  const allowed = [
    'channels', 'action', 'threshold', 'escalationEnabled',
    'escalation', 'timeoutMs', 'logChannelId',
  ];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      g[key] = patch[key];
    }
  }
  return getGuildConfig(guildId);
}

export async function listTargets(guildId, { includeDisabled = true } = {}) {
  const g = ensure(guildId);
  const list = [...g.targets.values()];
  return includeDisabled ? list.map((t) => ({ ...t })) : list.filter((t) => t.enabled).map((t) => ({ ...t }));
}

export async function getTarget(guildId, targetId) {
  const t = ensure(guildId).targets.get(targetId);
  return t ? { ...t } : null;
}

export async function findTargetByName(guildId, name) {
  const needle = String(name || '').trim().toLowerCase();
  const list = await listTargets(guildId);
  return list.find((t) => t.name.toLowerCase() === needle) || null;
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
  previewJpeg = null,
  sourceUrl = null,
}) {
  const g = ensure(guildId);
  const targetId = randomUUID();
  const target = {
    guildId,
    targetId,
    name: name || `Target ${g.targets.size + 1}`,
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
    previewJpeg,
    sourceUrl,
  };
  g.targets.set(targetId, target);
  return { ...target };
}

export async function updateTarget(guildId, targetId, patch) {
  const g = ensure(guildId);
  const t = g.targets.get(targetId);
  if (!t) return null;
  Object.assign(t, patch);
  return { ...t };
}

export async function removeTarget(guildId, targetId) {
  return ensure(guildId).targets.delete(targetId);
}

export async function setChannels(guildId, channelIds) {
  return patchGuildConfig(guildId, {
    channels: [...new Set(channelIds.map(String))],
  });
}

export async function addChannel(guildId, channelId) {
  const g = ensure(guildId);
  if (!g.channels.includes(channelId)) g.channels.push(channelId);
  return [...g.channels];
}

export async function removeChannel(guildId, channelId) {
  const g = ensure(guildId);
  g.channels = g.channels.filter((id) => id !== channelId);
  return [...g.channels];
}

export async function isChannelWatched(guildId, channelId) {
  return ensure(guildId).channels.includes(channelId);
}

export async function recordDetection(guildId, entry) {
  const g = ensure(guildId);
  const row = {
    id: randomUUID(),
    guildId,
    timestamp: new Date().toISOString(),
    ...entry,
  };
  g.detections.unshift(row);
  if (g.detections.length > MAX_DETECTION_LOG) g.detections.length = MAX_DETECTION_LOG;
  return { ...row };
}

export async function getStrikes(guildId, userId) {
  return ensure(guildId).strikes.get(userId) || 0;
}

export async function incrementStrike(guildId, userId) {
  const g = ensure(guildId);
  const next = (g.strikes.get(userId) || 0) + 1;
  g.strikes.set(userId, next);
  return next;
}

export async function resetStrikes(guildId, userId) {
  ensure(guildId).strikes.delete(userId);
}

export async function effectiveThreshold(guildId, target) {
  const g = await getGuildConfig(guildId);
  if (target?.similarityThreshold != null) return target.similarityThreshold;
  return g.threshold;
}
