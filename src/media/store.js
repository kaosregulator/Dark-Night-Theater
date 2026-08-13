import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { JsonStore } from '../services/json-store.js';
import { signMediaToken } from './token.js';
import { log } from '../logger.js';

// ============================================================================
//  Local-device movie host.
//
//  Movies live on disk (config.media.dir). Two ways they get there:
//    1) drop files into the media folder (great when the bot runs on your PC),
//    2) upload from your device via the /host page (great on Replit/Railway).
//  Each movie is served by src/web/routes/media.js with HTTP range support, so
//  the existing Theater HTML5 player streams it — seeking, late joiners, and
//  1hr+ videos all work, and everything is same-origin (no URL mapping needed).
// ============================================================================

// Extensions browsers can actually play in an HTML5 <video>. mkv/avi are listed
// but flagged not-web-playable so the UI can warn instead of silently failing.
const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.ogv': 'video/ogg',
  '.m3u8': 'application/vnd.apple.mpegurl',
};
const NON_WEB = new Set(['.mkv', '.avi', '.wmv', '.flv', '.ts']);
const VIDEO_EXTS = new Set([...Object.keys(MIME), ...NON_WEB]);

const registry = new JsonStore('media.json', { items: {}, syncedAt: null });

function ensureDir() {
  if (!fs.existsSync(config.media.dir)) fs.mkdirSync(config.media.dir, { recursive: true });
}
const newId = () => crypto.randomBytes(9).toString('hex');
const titleFromFile = (f) => path.basename(f, path.extname(f)).replace(/[._]+/g, ' ').trim();

// Public shape used everywhere else in the app (mirrors the old video object so
// nothing downstream had to change).
function toVideo(item) {
  const ext = path.extname(item.file).toLowerCase();
  return {
    uid: item.id,
    name: item.name,
    category: item.category || 'Library',
    description: item.description || '',
    durationSeconds: item.durationSeconds || 0,
    thumbnail: '', // no thumbnails for local files (cards show a clean placeholder)
    animatedThumbnail: '',
    // playback fields — resolved on demand by getPlayback()
    kind: ext === '.m3u8' ? 'hls' : 'file',
    requireSignedURLs: true,
    webPlayable: !NON_WEB.has(ext),
    size: item.size || 0,
    ready: true,
    createdAt: item.createdAt,
    file: item.file,
  };
}

export function list() {
  return Object.values(registry.data.items)
    .map(toVideo)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
export function find(uid) {
  const item = registry.data.items[uid];
  return item ? toVideo(item) : null;
}
export function lastSyncedAt() {
  return registry.data.syncedAt;
}

// Absolute on-disk path for a registered video (used by the range route).
export function filePath(uid) {
  const item = registry.data.items[uid];
  if (!item) return null;
  return path.join(config.media.dir, item.file);
}

// Register a new file that already exists in the media dir.
export function register({ file, name, category, size, addedBy, durationSeconds }) {
  const id = newId();
  registry.data.items[id] = {
    id,
    file, // basename within media dir
    name: name || titleFromFile(file),
    category: category || 'Library',
    size: size || 0,
    durationSeconds: durationSeconds || 0,
    addedBy: addedBy || null,
    createdAt: new Date().toISOString(),
  };
  registry.save();
  return find(id);
}

export function remove(uid) {
  const item = registry.data.items[uid];
  if (!item) return false;
  try {
    fs.rmSync(path.join(config.media.dir, item.file), { force: true });
  } catch (err) {
    log.warn('media remove:', err.message);
  }
  delete registry.data.items[uid];
  registry.save();
  return true;
}

// Scan the media folder and register any files not already known (and drop
// entries whose files disappeared). This is what /library sync runs.
export function scan() {
  ensureDir();
  const onDisk = fs.readdirSync(config.media.dir).filter((f) => VIDEO_EXTS.has(path.extname(f).toLowerCase()));
  const known = new Set(Object.values(registry.data.items).map((i) => i.file));

  for (const f of onDisk) {
    if (known.has(f)) continue;
    let size = 0;
    try {
      size = fs.statSync(path.join(config.media.dir, f)).size;
    } catch {
      /* ignore */
    }
    register({ file: f, size });
  }
  // prune missing files
  for (const [id, item] of Object.entries(registry.data.items)) {
    if (!fs.existsSync(path.join(config.media.dir, item.file))) delete registry.data.items[id];
  }
  registry.data.syncedAt = new Date().toISOString();
  registry.save();
  return list();
}

// Build the short-lived, same-origin playback URL for a video.
export function getPlayback(video) {
  const token = signMediaToken(video.uid);
  const src = `/media/${video.uid}?t=${token}`;
  if (video.kind === 'hls') {
    return { hls: src, dash: null, src, kind: 'hls', signed: true };
  }
  return { hls: null, dash: null, src, kind: 'file', signed: true };
}

// ---- search / categories (kept here so library-store can delegate) ----------
export function search({ query = '', category = '' } = {}) {
  const q = query.trim().toLowerCase();
  const c = category.trim().toLowerCase();
  return list().filter((v) => {
    const matchQ =
      !q || v.name.toLowerCase().includes(q) || v.description.toLowerCase().includes(q) || v.category.toLowerCase().includes(q);
    const matchC = !c || v.category.toLowerCase() === c;
    return matchQ && matchC;
  });
}
export function categories() {
  const counts = new Map();
  for (const v of list()) counts.set(v.category, (counts.get(v.category) || 0) + 1);
  return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

export { MIME, NON_WEB, VIDEO_EXTS, ensureDir, titleFromFile };
