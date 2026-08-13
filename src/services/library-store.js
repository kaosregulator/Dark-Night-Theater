import { JsonStore } from './json-store.js';
import { listLibrary, getVideo } from '../cloudflare/stream.js';
import { readiness } from '../config.js';
import { log } from '../logger.js';

// Cached view of the Cloudflare Stream library so /watch and the theater UI are
// fast and don't hammer the CF API. Admins refresh it with the sync command.

const store = new JsonStore('library.json', { videos: [], syncedAt: null });

export function getCachedLibrary() {
  return store.data.videos || [];
}
export function lastSyncedAt() {
  return store.data.syncedAt;
}

export function findVideo(uid) {
  return getCachedLibrary().find((v) => v.uid === uid) || null;
}

export function categories() {
  const set = new Map();
  for (const v of getCachedLibrary()) {
    set.set(v.category, (set.get(v.category) || 0) + 1);
  }
  return [...set.entries()].map(([name, count]) => ({ name, count }));
}

export function search({ query = '', category = '' } = {}) {
  const q = query.trim().toLowerCase();
  const c = category.trim().toLowerCase();
  return getCachedLibrary().filter((v) => {
    const matchQ =
      !q ||
      v.name.toLowerCase().includes(q) ||
      v.description.toLowerCase().includes(q) ||
      v.category.toLowerCase().includes(q);
    const matchC = !c || v.category.toLowerCase() === c;
    return matchQ && matchC;
  });
}

// Pull the whole library from Cloudflare and cache it.
export async function syncLibrary() {
  if (!readiness.cloudflare) throw new Error('Cloudflare is not configured yet.');
  const videos = await listLibrary();
  store.data.videos = videos;
  store.data.syncedAt = new Date().toISOString();
  store.save();
  log.info(`Library synced: ${videos.length} videos.`);
  return videos;
}

// Refresh a single video (e.g. after changing its metadata).
export async function syncOne(uid) {
  const fresh = await getVideo(uid);
  const list = getCachedLibrary().filter((v) => v.uid !== uid);
  list.push(fresh);
  store.data.videos = list;
  store.save();
  return fresh;
}
