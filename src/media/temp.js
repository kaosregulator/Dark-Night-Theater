import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { MIME, NON_WEB } from './store.js';
import { signMediaToken } from './token.js';
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
  const session = {
    id,
    channelId: channelId || null,
    name: (name ? path.basename(String(name), path.extname(String(name))) : 'Movie').replace(/[._]+/g, ' ').trim() || 'Movie',
    ext,
    file,
    total: Number(size) || 0, // declared final size (from the browser's File.size)
    receivedBytes: 0,
    complete: false,
    connected: false, // is a host upload actively feeding right now?
    everConnected: false,
    feedStatus: 'streaming',
    webPlayable: !NON_WEB.has(ext),
    kind: ext === '.m3u8' ? 'hls' : 'file',
    createdAt: now(),
    lastActivity: now(),
    emitter: new EventEmitter(),
  };
  session.emitter.setMaxListeners(0);
  byId.set(id, session);
  if (channelId) byChannel.set(channelId, id);
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
  const { probeFile, faststartRemux, codecTip, logProbe } = await import('./probe.js');
  // Relocate moov to the front when possible (copy remux — no quality loss).
  const remux = await faststartRemux(session.file);
  if (remux.ok) log.info(`temp ${session.id}: faststart remux ok`);
  else if (remux.reason) log.warn(`temp ${session.id}: faststart skipped — ${remux.reason}`);

  const info = await probeFile(session.file);
  logProbe(session.id, info);
  session.probe = info;
  if (info?.ok) {
    session.webPlayable = Boolean(info.webPlayable);
    session.codecTip = codecTip(info);
  }

  const needsConvert = info?.ok && (!info.webPlayable || info.oddSize);
  session.converting = needsConvert;
  if (session.channelId) {
    const { setPlaybackMeta } = await import('../services/sessions.js');
    setPlaybackMeta(session.channelId, {
      webPlayable: needsConvert ? false : session.webPlayable,
      codecTip: needsConvert
        ? 'Converting this file to Discord-safe H.264 + AAC… keep the host tab open. The Theater will reload when ready.'
        : session.codecTip || null,
      videoCodec: info?.videoCodec || null,
      audioCodec: info?.audioCodec || null,
      converting: needsConvert,
      // Remux rewrites the file on disk — force Activity players to reload.
      bumpRevision: true,
    });
  }

  if (!needsConvert) return;

  // MovieBox / rip MP4s often use HEVC or AC-3 — Discord paints black. Re-encode.
  try {
    const { transcodeToWebMp4 } = await import('./transcode.js');
    const result = await transcodeToWebMp4(session.file, { maxHeight: 1080 });
    if (!result.ok) {
      log.warn(`temp ${session.id}: transcode failed — ${result.reason}`);
      if (session.channelId) {
        const { setPlaybackMeta } = await import('../services/sessions.js');
        setPlaybackMeta(session.channelId, {
          converting: false,
          webPlayable: false,
          codecTip:
            session.codecTip ||
            'Could not auto-convert this file. Re-export as MP4 H.264 + AAC (HandBrake Fast 1080p30) and host again.',
        });
      }
      return;
    }
    // Point the session at the Discord-safe file (keep original for scrub cleanup).
    session.webFile = result.outPath;
    session.webPlayable = true;
    session.codecTip = null;
    session.converting = false;
    session.kind = 'file';
    if (session.channelId) {
      const { setPlaybackSource } = await import('../services/sessions.js');
      const playback = getPlayback(session);
      setPlaybackSource(session.channelId, {
        src: playback.src,
        kind: playback.kind,
        hls: playback.hls,
        dash: playback.dash,
        webPlayable: true,
        codecTip: null,
      });
    }
  } catch (err) {
    log.warn(`temp ${session.id}: transcode error — ${err.message}`);
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
  const src = `/tmedia/${session.id}?t=${signMediaToken(session.id)}`;
  return { src, kind: session.kind, hls: session.kind === 'hls' ? src : null, dash: null, signed: true };
}

export function scrub(id) {
  const session = byId.get(id);
  if (!session) return false;
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
