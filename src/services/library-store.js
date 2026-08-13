// The "library" is now backed by the local media host (src/media/store.js).
// This thin wrapper keeps the same interface the bot handlers already use, so
// swapping the movie source from Cloudflare to local files needed no changes in
// /watch, the pre-show, settings, or the Activity.
import * as media from '../media/store.js';
import { log } from '../logger.js';

export function getCachedLibrary() {
  return media.list();
}
export function lastSyncedAt() {
  return media.lastSyncedAt();
}
export function findVideo(uid) {
  return media.find(uid);
}
export function categories() {
  return media.categories();
}
export function search(opts) {
  return media.search(opts);
}

// Re-scan the media folder for newly added / removed files.
export async function syncLibrary() {
  const videos = media.scan();
  log.info(`Library scanned: ${videos.length} local videos.`);
  return videos;
}
