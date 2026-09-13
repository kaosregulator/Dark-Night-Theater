import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { MIME, NON_WEB } from './store.js';
import { signMediaToken } from './token.js';
import { looksLikeNeedsConvert, suspectReason, LARGE_HOLD_BYTES } from './suspect.js';
import { enqueueLiveHls, cleanupConversion, PRIORITY } from './conversion-manager.js';
import { bus as sessionBus, setFeedStatus } from '../services/sessions.js';
import { log } from '../logger.js';

// ============================================================================
//  Temporary per-watch-party movie sessions.
//
//  The host's browser streams their chosen file to the server into a temp file
//  keyed to their voice channel. The Theater serves that temp file with range
//  support *while it is still uploading* (progressive), so viewers start almost
//  immediately. The original never leaves the host's device, and the server copy
//  is scrubbed when the party ends, on inactivity, on TTL, or on boot.
//
//  NOTHING here is a permanent library — these files are ephemeral by design.
// ============================================================================

const TMP_DIR = path.join(config.media.dir, '.sessions');
const IDLE_MS = 30 * 60 * 1000; // scrub after 30 min with no activity
const STALL_MS = 6000; // no new bytes for this long (and not done) => "stalled"
const MAX_CHUNK = 4 * 1024 * 1024;

const byId = new Map(); // id -> session
const byChannel = new Map(); // voiceChannelId -> id

function ensureDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}
const now = () => Date.now();
const extOf = (name) => {
  const e = path.extname(String(name || '')).toLowerCase();
  return MIME[e] ? e : '.mp4';
};

// Wipe any leftover temp files from a previous run.
export function scrubAllOnBoot() {
  try {
    ensureDir();
    for (const f of fs.readdirSync(TMP_DIR)) fs.rmSync(path.join(TMP_DIR, f), { force: true });
    log.info('Temp session files cleared.');
  } catch (err) {
    log.warn('temp boot scrub:', err.message);
  }
}

export function create({ channelId, name, size, addedBy }) {
  ensureDir();
  if (channelId && byChannel.has(channelId)) scrub(byChannel.get(channelId)); // one party per channel
  const id = crypto.randomBytes(9).toString('hex');
  const ext = extOf(name);
  const file = path.join(TMP_DIR, `${id}${ext}`);
  const declaredSize = Number(size) || 0;
  const displayName =
    (name ? path.basename(String(name), path.extname(String(name))) : 'Movie').replace(/[._]+/g, ' ').trim() ||
    'Movie';
  // Safe progressive files (e.g. H.264 episode rips) play while uploading.
  // MovieBox / large / non-web: hold progressive until live HLS is ready —
  // but we always *attempt* conversion (never refuse before trying).
  const suspect = looksLikeNeedsConvert(String(name || displayName), declaredSize) || NON_WEB.has(ext);
  const tip = suspect
    ? suspectReason(String(name || displayName), declaredSize) ||
      'Preparing a Discord-safe stream… playback starts after the first segments.'
    : null;
  const session = {
    id,
    channelId: channelId || null,
    name: displayName,
    ext,
    file,
    total: declaredSize, // declared final size (from the browser's File.size)
    receivedBytes: 0,
    complete: false,
    connected: false, // is a host upload actively feeding right now?
    everConnected: false,
    feedStatus: 'streaming',
    webPlayable: suspect ? false : !NON_WEB.has(ext),
    suspectConvert: suspect,
    converting: Boolean(suspect),
    conversionState: suspect ? 'queued' : null,
    codecTip: tip,
    kind: ext === '.m3u8' ? 'hls' : 'file',
    createdAt: now(),
    lastActivity: now(),
    emitter: new EventEmitter(),
  };
  session.emitter.setMaxListeners(0);
  byId.set(id, session);
  if (channelId) byChannel.set(channelId, id);
  if (suspect) {
    log.info(
      `temp ${id}: hold progressive until live HLS (MovieBox/large/non-web · ${(declaredSize / 1048576).toFixed(0)} MB)`
    );
  } else {
    log.info(`temp ${id}: progressive play-while-upload (${(declaredSize / 1048576).toFixed(0)} MB)`);
  }
  return session;
}

export function find(id) {
  return byId.get(id) || null;
}

// Open the write stream the upload route pipes into. `append` resumes an
// interrupted upload from where it left off (flags 'a') instead of truncating.
export function openWrite(session, { append = false } = {}) {
  return fs.createWriteStream(session.file, { flags: append ? 'a' : 'w' });
}

// A host upload is actively feeding this session.
export function markConnected(session) {
  session.connected = true;
  session.everConnected = true;
  session.lastActivity = now();
  if (!session.complete) setStatus(session, 'streaming');
}

// The host upload dropped (tab closed / network lost) before completing. Keep
// the file + buffered bytes + room state intact so viewers keep their position
// and can resume when the host reconnects.
export function markDisconnected(session) {
  session.connected = false;
  if (!session.complete) setStatus(session, 'disconnected');
}

// Push a feed status to the party's viewers (only when it changes).
function setStatus(session, status) {
  if (session.feedStatus === status) return;
  session.feedStatus = status;
  if (session.channelId) setFeedStatus(session.channelId, status);
}

// Advance the durably-written byte count (called from the write callback so we
// never advertise bytes a reader can't yet see).
export function advance(session, n) {
  session.receivedBytes += n;
  session.lastActivity = now();
  if (!session.complete) setStatus(session, 'streaming');
  session.emitter.emit('progress');
}

export function finish(session) {
  // Idempotent: a second finish must not spawn another ffmpeg/HLS job.
  if (session.complete && (session.prepareStarted || session.hlsChild || session.kind === 'hls')) {
    session.lastActivity = now();
    return;
  }
  session.complete = true;
  try {
    session.total = fs.statSync(session.file).size;
  } catch {
    /* keep declared total */
  }
  session.lastActivity = now();
  setStatus(session, 'complete');
  session.emitter.emit('progress');
  // Probe + faststart in the background so Discord Chromium can actually paint.
  prepareForWeb(session).catch((err) => log.warn('temp prepare:', err.message));
}

async function prepareForWeb(session) {
  if (session.prepareStarted) return;
  session.prepareStarted = true;

  const { probeFile, faststartRemux, codecTip, logProbe } = await import('./probe.js');

  // Probe first. Suspect uploads fail-closed so we convert instead of serving HEVC progressive.
  const failClosed = Boolean(session.suspectConvert);
  let info = await probeFile(session.file, { failClosed });
  logProbe(session.id, info);
  session.probe = info;

  // Probe failure must never fail-open to progressive — Discord black-screens HEVC.
  if (!info?.ok) {
    info = {
      ok: false,
      webPlayable: false,
      videoCodec: info?.videoCodec || null,
      audioCodec: info?.audioCodec || null,
      oddSize: false,
      reason: info?.reason || 'Probe failed — converting to be safe',
    };
    session.probe = info;
  }

  if (info?.ok) {
    session.webPlayable = Boolean(info.webPlayable);
    // Soft tip only while converting — never HandBrake/manual advice.
    session.codecTip = info.webPlayable && !info.oddSize ? null : codecTip(info);
  }

  // Convert when probe says unplayable/odd, OR probe failed.
  // Safe H.264 episodes (probe ok + webPlayable) skip HLS and keep progressive.
  const needsConvert = Boolean(!info?.ok || !info.webPlayable || info.oddSize);
  session.converting = needsConvert;
  session.conversionState = needsConvert ? 'converting' : null;

  if (!needsConvert) {
    const remux = await faststartRemux(session.file, {
      timeoutMs: 120000,
      maxBytes: LARGE_HOLD_BYTES,
    });
    if (remux.ok) log.info(`temp ${session.id}: faststart remux ok`);
    else if (remux.reason) log.warn(`temp ${session.id}: faststart skipped — ${remux.reason}`);

    session.converting = false;
    session.webPlayable = true;
    session.codecTip = null;
    if (session.channelId) {
      const { setPlaybackMeta } = await import('../services/sessions.js');
      setPlaybackMeta(session.channelId, {
        webPlayable: true,
        codecTip: null,
        videoCodec: info?.videoCodec || null,
        audioCodec: info?.audioCodec || null,
        converting: false,
        bumpRevision: true,
      });
    }
    return;
  }

  session.webPlayable = false;
  session.codecTip =
    'Preparing a Discord-safe stream… playback starts after the first segments.';

  if (session.channelId) {
    const { setPlaybackMeta } = await import('../services/sessions.js');
    setPlaybackMeta(session.channelId, {
      webPlayable: false,
      codecTip: session.codecTip,
      videoCodec: info?.videoCodec || null,
      audioCodec: info?.audioCodec || null,
      converting: true,
      bumpRevision: true,
    });
  }

  const FAIL_TIP = '❌ This movie could not be prepared for playback.';
  const hlsDir = path.join(TMP_DIR, `${session.id}.hls`);
  session.hlsDir = hlsDir;

  const markFailed = (err) => {
    log.warn(`temp ${session.id}: conversion failed — ${err?.message || err}`);
    session.converting = false;
    session.conversionState = 'failed';
    session.convertFailed = true;
    session.webPlayable = false;
    session.codecTip = FAIL_TIP;
    // Keep kind/file but never advertise a playable progressive after failure —
    // client must show the fail tip instead of re-attaching a black HEVC src.
    if (session.channelId) {
      import('../services/sessions.js')
        .then(({ setPlaybackMeta }) => {
          setPlaybackMeta(session.channelId, {
            converting: false,
            webPlayable: false,
            convertFailed: true,
            codecTip: FAIL_TIP,
            bumpRevision: true,
          });
        })
        .catch(() => {});
    }
  };

  try {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const job = enqueueLiveHls({
        id: session.id,
        filePath: session.file,
        outDir: hlsDir,
        priority: PRIORITY.ACTIVE_PARTY,
        maxHeight: 720,
        onPlayable: ({ playlist, segments }) => {
          if (session.hlsReady) {
            done();
            return;
          }
          session.hlsReady = true;
          session.hlsPlaylist = playlist || path.join(hlsDir, 'index.m3u8');
          session.webPlayable = true;
          session.codecTip = null;
          session.converting = false;
          session.conversionState = 'playable';
          session.kind = 'hls';
          log.info(
            `temp ${session.id}: HLS playable (${segments || '?'} segments) — encode continues in background`
          );
          if (session.channelId) {
            import('../services/sessions.js')
              .then(({ setPlaybackSource }) => {
                const playback = getPlayback(session);
                setPlaybackSource(session.channelId, {
                  src: playback.src,
                  kind: 'hls',
                  hls: playback.hls,
                  dash: null,
                  webPlayable: true,
                  codecTip: null,
                });
              })
              .catch((e) => log.warn('temp media-ready broadcast:', e.message));
          }
          done();
        },
        onComplete: () => {
          session.hlsComplete = true;
          session.conversionState = 'complete';
          done();
        },
        onFailed: (err) => {
          markFailed(err);
          done();
        },
      });

      session.hlsStop = () => cleanupConversion(session.id);
      const pollChild = setInterval(() => {
        if (job.child) {
          session.hlsChild = job.child;
          clearInterval(pollChild);
        }
        if (['complete', 'failed', 'cancelled'].includes(job.state)) clearInterval(pollChild);
      }, 250);
      if (pollChild.unref) pollChild.unref();
    });
  } catch (err) {
    markFailed(err);
  }
}

// Resolve once at least `need` bytes are on disk (or the upload completed), or
// the timeout elapses. Enables seeking ahead of the current upload position.
export function waitForBytes(session, need, timeoutMs = 30000) {
  return new Promise((resolve) => {
    if (session.complete || session.receivedBytes >= need) return resolve(true);
    let done = false;
    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      session.emitter.off('progress', onProg);
    };
    const onProg = () => {
      if (!done && (session.complete || session.receivedBytes >= need)) {
        cleanup();
        resolve(true);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(session.complete || session.receivedBytes >= need);
    }, timeoutMs);
    session.emitter.on('progress', onProg);
  });
}

export function touch(session) {
  session.lastActivity = now();
}

// Short-lived, signed, same-origin playback URL for a temp session.
export function getPlayback(session) {
  const token = signMediaToken(session.id);
  if (session.kind === 'hls' && session.hlsDir) {
    const src = `/tmedia/${session.id}/index.m3u8?t=${token}`;
    return { src, kind: 'hls', hls: src, dash: null, signed: true };
  }
  const src = `/tmedia/${session.id}?t=${token}`;
  return { src, kind: session.kind || 'file', hls: null, dash: null, signed: true };
}

export function scrub(id) {
  const session = byId.get(id);
  if (!session) return false;
  try {
    session.hlsStop?.();
  } catch {
    /* ignore */
  }
  try {
    cleanupConversion(session.id);
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(session.file, { force: true });
  } catch (err) {
    log.warn('temp scrub:', err.message);
  }
  if (session.webFile) {
    try {
      fs.rmSync(session.webFile, { force: true });
    } catch {
      /* ignore */
    }
  }
  if (session.hlsDir) {
    try {
      fs.rmSync(session.hlsDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  byId.delete(id);
  if (session.channelId && byChannel.get(session.channelId) === id) byChannel.delete(session.channelId);
  session.emitter.emit('progress'); // release any waiters
  log.info(`Temp session scrubbed (${id}).`);
  return true;
}

export function scrubByChannel(channelId) {
  const id = byChannel.get(channelId);
  if (id) scrub(id);
}

// Auto-scrub when a party ends (control 'end' emits an 'ended' event).
sessionBus.on('update', (payload) => {
  if (payload?.event?.type === 'ended' && payload.channelId) scrubByChannel(payload.channelId);
});

// Feed watcher: distinguish a dropped host connection from a soft stall.
//  • not connected (and it either connected before or has waited past STALL) => disconnected
//  • connected but no new bytes for STALL_MS                                   => stalled
setInterval(() => {
  const t = now();
  for (const s of byId.values()) {
    if (s.complete) continue;
    if (!s.connected) {
      if (s.everConnected || t - s.createdAt > STALL_MS) setStatus(s, 'disconnected');
    } else if (t - s.lastActivity > STALL_MS) {
      setStatus(s, 'stalled');
    }
  }
}, 2000).unref?.();

// Idle / TTL sweeper.
const ttlMs = () => config.media.sessionTtl * 1000;
setInterval(() => {
  const t = now();
  for (const [id, s] of byId) {
    const expired = t - s.createdAt > ttlMs();
    const idle = t - s.lastActivity > IDLE_MS;
    if (expired || idle) scrub(id);
  }
}, 60_000).unref?.();

process.on('exit', () => {
  for (const id of [...byId.keys()]) scrub(id);
});
