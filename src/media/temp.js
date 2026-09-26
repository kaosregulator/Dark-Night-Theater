import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { MIME, NON_WEB } from './store.js';
import { signMediaToken } from './token.js';
import { looksLikeNeedsConvert, suspectReason, LARGE_HOLD_BYTES } from './suspect.js';
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

export function create({ channelId, name, size, addedBy, guildId, title, description, category } = {}) {
  ensureDir();
  if (channelId && byChannel.has(channelId)) scrub(byChannel.get(channelId)); // one party per channel
  const id = crypto.randomBytes(9).toString('hex');
  const ext = extOf(name);
  const file = path.join(TMP_DIR, `${id}${ext}`);
  const declaredSize = Number(size) || 0;
  const displayName =
    (title || (name ? path.basename(String(name), path.extname(String(name))) : 'Movie'))
      .replace(/[._]+/g, ' ')
      .trim() || 'Movie';
  // May need a background Discord-safe convert later — NEVER hold playback for that.
  // Progressive /tmedia starts immediately for long and short films alike.
  const suspect = looksLikeNeedsConvert(String(name || displayName), declaredSize) || NON_WEB.has(ext);
  const tip = suspectReason(String(name || displayName), declaredSize);
  const session = {
    id,
    channelId: channelId || null,
    guildId: guildId || null,
    name: displayName,
    description: description || '',
    category: category || 'Now Playing',
    ext,
    file,
    total: declaredSize, // declared final size (from the browser's File.size)
    receivedBytes: 0,
    complete: false,
    connected: false, // is a host upload actively feeding right now?
    everConnected: false,
    feedStatus: 'streaming',
    // Play immediately — even for MovieBox/large. Convert runs after upload.
    webPlayable: !NON_WEB.has(ext),
    suspectConvert: suspect,
    converting: false,
    codecTip: tip,
    kind: ext === '.m3u8' ? 'hls' : 'file',
    createdAt: now(),
    lastActivity: now(),
    emitter: new EventEmitter(),
    addedBy: addedBy || null,
  };
  session.emitter.setMaxListeners(0);
  byId.set(id, session);
  if (channelId) byChannel.set(channelId, id);
  if (suspect) {
    log.info(
      `temp ${id}: playing immediately · will optimize in background if needed (suspect MovieBox/large · ${(declaredSize / 1048576).toFixed(0)} MB)`
    );
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

  // Probe FIRST. Skipping an upfront full-file faststart remux on multi‑GB
  // MovieBox files avoids the 120s timeout + 2× disk copy before HLS can start.
  let info = await probeFile(session.file, { failClosed: false });
  logProbe(session.id, info);
  session.probe = info;

  if (info?.ok) {
    session.webPlayable = Boolean(info.webPlayable);
    session.codecTip = codecTip(info);
  } else if (session.suspectConvert) {
    // Probe unclear but filename/size looked rip-like — convert in background;
    // keep progressive URL attached so playback never goes idle.
    session.webPlayable = true;
    session.codecTip =
      'Playing now — optimizing a Discord-safe stream in the background…';
  }

  const needsConvert = Boolean(
    session.suspectConvert || (info?.ok && (!info.webPlayable || info.oddSize))
  );

  if (!needsConvert) {
    // Safe progressive MP4/WebM — optional moov reloc for faster start.
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
    await persistSessionToVault(session).catch((e) => log.warn('vault persist:', e.message));
    return;
  }

  // Needs convert — keep progressive playing; mark converting as background work.
  session.converting = true;
  if (session.channelId) {
    const { setPlaybackMeta } = await import('../services/sessions.js');
    setPlaybackMeta(session.channelId, {
      // Keep playable so clients do NOT enter the old "hold until HLS" path.
      webPlayable: true,
      codecTip:
        'Playing now — building a smoother Discord stream in the background (no pause).',
      videoCodec: info?.videoCodec || null,
      audioCodec: info?.audioCodec || null,
      converting: true,
      // Do NOT bump revision here — that would reload and skip. Progressive stays.
      bumpRevision: false,
    });
  }

  try {
    const { startLiveHls } = await import('./transcode.js');
    const hlsDir = path.join(TMP_DIR, `${session.id}.hls`);
    session.hlsDir = hlsDir;

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const handle = startLiveHls(session.file, hlsDir, {
        maxHeight: 720,
        onReady: () => {
          // First segments exist — wait until HLS has caught up to the party's
          // live position so swapping does not yank viewers back to 0:00.
          scheduleHlsSwapWhenCaughtUp(session).finally(finish);
        },
        onDone: () => {
          session.hlsComplete = true;
          scheduleHlsSwapWhenCaughtUp(session, { force: true }).finally(finish);
        },
        onError: (err) => {
          log.warn(`temp ${session.id}: live HLS failed — ${err.message}`);
          session.converting = false;
          // Progressive keeps playing — don't mark unplayable.
          if (session.channelId) {
            import('../services/sessions.js')
              .then(({ setPlaybackMeta }) => {
                setPlaybackMeta(session.channelId, {
                  converting: false,
                  webPlayable: true,
                  codecTip:
                    session.codecTip ||
                    'Background convert failed — staying on the live upload stream.',
                  bumpRevision: false,
                });
              })
              .catch(() => {});
          }
          finish();
        },
      });
      session.hlsStop = handle.stop;
      session.hlsChild = handle.child;
    });
  } catch (err) {
    log.warn(`temp ${session.id}: transcode error — ${err.message}`);
    session.converting = false;
  }

  await persistSessionToVault(session).catch((e) => log.warn('vault persist:', e.message));
}

/** Sum #EXTINF durations from an HLS playlist (EVENT list grows over time). */
function hlsPlaylistDurationSec(playlistPath) {
  try {
    const text = fs.readFileSync(playlistPath, 'utf8');
    let total = 0;
    for (const line of text.split('\n')) {
      if (line.startsWith('#EXTINF:')) {
        const n = parseFloat(line.slice(8));
        if (Number.isFinite(n)) total += n;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Swap party playback to HLS only once the playlist covers the live playhead
 * (plus a small cushion). Prevents the classic "jump back / skip a chunk" when
 * converting a long movie that viewers are already watching.
 */
async function scheduleHlsSwapWhenCaughtUp(session, { force = false } = {}) {
  if (!session?.channelId || !session.hlsDir) return;
  if (session.hlsSwapped) return;
  if (force) session.hlsForceSwap = true;
  if (session._hlsSwapPromise) return session._hlsSwapPromise;

  session._hlsSwapPromise = (async () => {
    const playlist = path.join(session.hlsDir, 'index.m3u8');
    const { livePosition, getRoom, setPlaybackSource, setPlaybackMeta } = await import(
      '../services/sessions.js'
    );

    const trySwap = () => {
      if (session.hlsSwapped) return true;
      if (!fs.existsSync(playlist)) return false;
      const room = getRoom(session.channelId);
      const live = room ? livePosition(room) : 0;
      const available = hlsPlaylistDurationSec(playlist);
      const cushion = 8;
      const forceNow = Boolean(session.hlsForceSwap || session.hlsComplete);
      if (!forceNow && available < live + cushion) {
        return false;
      }
      session.hlsReady = true;
      session.hlsPlaylist = playlist;
      session.webPlayable = true;
      session.codecTip = null;
      session.converting = false;
      session.kind = 'hls';
      session.hlsSwapped = true;
      const playback = getPlayback(session);
      if (room) {
        const nowMs = Date.now();
        const cur = livePosition(room, nowMs);
        room.playback.positionAtUpdate = Math.max(0, cur);
        room.playback.updatedAt = nowMs;
      }
      setPlaybackSource(session.channelId, {
        src: playback.src,
        kind: 'hls',
        hls: playback.hls,
        dash: null,
        webPlayable: true,
        codecTip: null,
      });
      log.info(
        `temp ${session.id}: swapped to HLS at ~${live.toFixed(1)}s (playlist ${available.toFixed(1)}s)`
      );
      return true;
    };

    if (trySwap()) return;

    await new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (trySwap() || Date.now() - started > 6 * 60 * 60 * 1000) {
          clearInterval(timer);
          if (!session.hlsSwapped) {
            setPlaybackMeta(session.channelId, { converting: false, bumpRevision: false });
          }
          resolve();
        }
      }, 1500);
    });
  })();

  return session._hlsSwapPromise;
}

/** Keep a permanent compressed copy in the admin vault after a full upload. */
async function persistSessionToVault(session) {
  if (!session?.complete || !session.file || !fs.existsSync(session.file)) return;
  if (session.vaultId) return;
  try {
    const vault = await import('./vault.js');
    const size = fs.statSync(session.file).size;
    const started = await vault.beginUpload({
      name: `${session.name}${session.ext || '.mp4'}`,
      size,
      title: session.name,
      description: session.description || '',
      category: session.category || 'Library',
      guildId: session.guildId || vault.GLOBAL_SCOPE,
      addedBy: session.addedBy || 'host',
    });
    // Copy the finished temp file into vault staging (chunked append).
    const fh = await fs.promises.open(session.file, 'r');
    try {
      const chunk = Buffer.alloc(2 * 1024 * 1024);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) break;
        await vault.appendUpload(started.id, offset, chunk.subarray(0, bytesRead));
        offset += bytesRead;
      }
    } finally {
      await fh.close();
    }
    const video = await vault.finalizeUpload(started.id, {
      title: session.name,
      description: session.description || '',
      category: session.category || 'Library',
    });
    session.vaultId = video?.uid || started.id;
    try {
      const library = await import('../services/library-store.js');
      await library.refreshVaultCache();
    } catch {
      /* ignore */
    }
    log.info(`temp ${session.id}: stored in vault as ${session.vaultId}`);
  } catch (err) {
    // Quota / no DATABASE_URL — party playback still works from temp.
    if (err.code === 'QUOTA') log.warn(`temp ${session.id}: vault full — skipped persist`);
    else log.warn(`temp ${session.id}: vault persist skipped — ${err.message}`);
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
  if (session.posterFile) {
    try {
      fs.rmSync(session.posterFile, { force: true });
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
