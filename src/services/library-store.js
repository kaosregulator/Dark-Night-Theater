// The "library" merges local disk media (MEDIA_DIR) with the admin Postgres
// vault (compressed full movies). Vault titles always surface for /watch and
// the Activity — even when "anyone can host" — so the admin stays the movie plug.
import * as media from '../media/store.js';
import * as vault from '../media/vault.js';
import { log } from '../logger.js';

let vaultCache = [];
let vaultSyncedAt = null;

function mergeLists(disk, vaultItems) {
  const byId = new Map();
  for (const v of disk) byId.set(v.uid, v);
  for (const v of vaultItems) byId.set(v.uid, { ...v, source: 'vault' });
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getCachedLibrary() {
  return mergeLists(media.list(), vaultCache);
}

export function lastSyncedAt() {
  return vaultSyncedAt || media.lastSyncedAt();
}

export function findVideo(uid) {
  return media.find(uid) || vaultCache.find((v) => v.uid === uid) || null;
}

export function categories() {
  const counts = new Map();
  for (const v of getCachedLibrary()) counts.set(v.category, (counts.get(v.category) || 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

export function search(opts = {}) {
  const q = String(opts.query || '')
    .trim()
    .toLowerCase();
  const c = String(opts.category || '')
    .trim()
    .toLowerCase();
  return getCachedLibrary().filter((v) => {
    const matchQ =
      !q ||
      v.name.toLowerCase().includes(q) ||
      (v.description || '').toLowerCase().includes(q) ||
      (v.category || '').toLowerCase().includes(q);
    const matchC = !c || (v.category || '').toLowerCase() === c;
    return matchQ && matchC;
  });
}

export async function refreshVaultCache(guildId = null) {
  try {
    vaultCache = await vault.listMovies({ guildId: guildId || null });
    vaultSyncedAt = new Date().toISOString();
  } catch (err) {
    log.warn('vault cache refresh:', err.message);
  }
  return vaultCache;
}

// Re-scan the media folder + refresh vault rows.
export async function syncLibrary() {
  const disk = media.scan();
  await refreshVaultCache();
  const all = getCachedLibrary();
  log.info(`Library scanned: ${disk.length} disk + ${vaultCache.length} vault = ${all.length} videos.`);
  return all;
}

export async function findVideoAsync(uid) {
  const local = findVideo(uid);
  if (local) return local;
  return vault.findMovie(uid);
}

export function getPlaybackFor(video) {
  if (!video) return null;
  if (video.vault) return vault.getPlayback(video);
  return media.getPlayback(video);
}
