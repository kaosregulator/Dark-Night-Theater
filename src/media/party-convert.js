import path from 'node:path';
import { config } from '../config.js';
import { signMediaToken } from './token.js';
import { enqueueLiveHls, conversionManager, PRIORITY } from './conversion-manager.js';
import { setPlaybackMeta, setPlaybackSource } from '../services/sessions.js';
import { log } from '../logger.js';

// ============================================================================
//  Watch-party conversion for library movies (permanent media/).
//  Temp sessions use temp.js → enqueueLiveHls directly; this helper covers
//  /library picks so they also go conversion-first via the shared manager.
// ============================================================================

const FAIL_TIP = '❌ This movie could not be prepared for playback.';

export function libraryHlsDir(uid) {
  return path.join(config.media.dir, '.hls', uid);
}

export function libraryHlsPlayback(uid) {
  const token = signMediaToken(uid);
  const src = `/media/${uid}/index.m3u8?t=${token}`;
  return { src, kind: 'hls', hls: src, dash: null, signed: true };
}

/** Background / library pre-convert (priority 3). Safe to call on upload. */
export function enqueueLibraryConvert(uid, filePath, { priority = PRIORITY.LIBRARY } = {}) {
  if (!uid || !filePath) return null;
  return enqueueLiveHls({
    id: uid,
    filePath,
    outDir: libraryHlsDir(uid),
    priority,
    maxHeight: 720,
  });
}

/**
 * Bind a library movie to an active watch party: bump priority, wire media-ready.
 * Call after startClanMovie so converting UI shows until first HLS segments exist.
 */
export function attachLibraryPartyConversion(
  channelId,
  uid,
  filePath,
  { priority = PRIORITY.ACTIVE_PARTY } = {}
) {
  if (!channelId || !uid || !filePath) return null;

  const FAIL = FAIL_TIP;
  const existing = conversionManager.get(uid);
  if (existing && (existing.state === 'playable' || existing.state === 'complete') && existing.playlist) {
    const playback = libraryHlsPlayback(uid);
    setPlaybackSource(channelId, {
      ...playback,
      webPlayable: true,
      codecTip: null,
    });
    return existing;
  }

  setPlaybackMeta(channelId, {
    converting: true,
    webPlayable: false,
    codecTip: 'Preparing a Discord-safe stream… playback starts after the first segments.',
    bumpRevision: true,
  });

  conversionManager.bumpPriority(uid, priority);

  return enqueueLiveHls({
    id: uid,
    filePath,
    outDir: libraryHlsDir(uid),
    priority,
    maxHeight: 720,
    onPlayable: () => {
      const playback = libraryHlsPlayback(uid);
      log.info(`library party ${uid}: HLS playable → media-ready`);
      setPlaybackSource(channelId, {
        ...playback,
        webPlayable: true,
        codecTip: null,
      });
    },
    onFailed: (err) => {
      log.warn(`library party ${uid}: conversion failed — ${err?.message || err}`);
      setPlaybackMeta(channelId, {
        converting: false,
        webPlayable: false,
        convertFailed: true,
        codecTip: FAIL,
        bumpRevision: true,
      });
    },
  });
}
