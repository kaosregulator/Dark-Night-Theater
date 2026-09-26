import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from '../../config.js';
import * as store from '../../media/store.js';
import { VIDEO_EXTS, NON_WEB, ensureDir } from '../../media/store.js';
import * as library from '../../services/library-store.js';
import * as vault from '../../media/vault.js';
import * as temp from '../../media/temp.js';
import { verifyHostSession } from '../../media/token.js';
import * as sessions from '../../services/sessions.js';
import { getDiscordClient } from '../../bot/clientRef.js';
import { publishPanel, createActivityInvite } from '../../bot/handlers/theater.js';
import { log } from '../../logger.js';

// The /host page + API: how a host adds a video from their device. Two ways in:
//   • operator opens /host and types the admin key (manage the library), or
//   • a host taps "Host a Movie" inside /watch, which opens /host?s=<token> —
//     a one-time, pre-authorised session (no key) that also knows their voice +
//     text channel, so after upload it can START THE WATCH PARTY for them.

export const host = express.Router();

function keyOk(req) {
  const provided = req.get('x-admin-key') || req.query.key || '';
  return provided && provided === config.media.adminKey;
}
function sessionFrom(req) {
  return verifyHostSession(req.query.s || req.get('x-host-session') || (req.body && req.body.s));
}
function requireKey(req, res, next) {
  if (!keyOk(req)) return res.status(401).json({ error: 'Bad admin key' });
  next();
}
function sanitize(name) {
  return path.basename(String(name || 'video'))
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .slice(0, 120);
}

// List / delete stay admin-only (library management). Vault movies stay until
// the admin deletes them — users only see/play them.
host.get('/api/host/list', requireKey, async (req, res) => {
  try {
    await library.refreshVaultCache();
    const usage = await vault.usageForScope(vault.GLOBAL_SCOPE);
    res.json({
      videos: library.getCachedLibrary(),
      dir: config.media.dir,
      vault: true,
      quota: {
        usedBytes: usage.usedBytes,
        quotaBytes: usage.quotaBytes,
        remainingBytes: usage.remainingBytes,
        quotaGb: config.media.libraryQuotaGb,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
host.delete('/api/host/media/:id', requireKey, async (req, res) => {
  const id = req.params.id;
  let ok = false;
  try {
    ok = (await vault.removeMovie(id)) || store.remove(id);
    await library.refreshVaultCache();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.json({ ok });
});

// ---- Admin vault: chunked full-movie upload into compressed Postgres --------
host.post('/api/host/vault/begin', requireKey, express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const started = await vault.beginUpload({
      name: body.name,
      size: body.size,
      title: body.title,
      description: body.description,
      category: body.category || 'Library',
      guildId: body.guildId || vault.GLOBAL_SCOPE,
      addedBy: 'admin',
    });
    res.json({
      ok: true,
      id: started.id,
      video: started.video,
      quota: started.usage,
      maxUploadMb: config.media.maxUploadMb,
    });
  } catch (err) {
    const status = err.code === 'QUOTA' || err.code === 'TOO_LARGE' ? 413 : 400;
    res.status(status).json({ error: err.message, code: err.code || 'ERROR' });
  }
});

host.put('/api/host/vault/:id/data', requireKey, async (req, res) => {
  const id = req.params.id;
  const offset = Number(req.query.offset || 0);
  const chunks = [];
  let aborted = false;
  const maxBytes = config.media.maxUploadMb * 1024 * 1024;
  req.on('data', (c) => {
    chunks.push(c);
    const n = chunks.reduce((a, b) => a + b.length, 0);
    if (n > 16 * 1024 * 1024 && !aborted) {
      aborted = true;
      req.destroy();
      res.status(413).json({ error: 'Chunk too large' });
    }
  });
  req.on('end', async () => {
    if (aborted) return;
    try {
      const buf = Buffer.concat(chunks);
      if (offset + buf.length > maxBytes) {
        return res.status(413).json({ error: `Too large (> ${config.media.maxUploadMb} MB).` });
      }
      const result = await vault.appendUpload(id, offset, buf);
      res.json({ ok: true, ...result });
    } catch (err) {
      const status = err.code === 'GAP' ? 409 : err.code === 'NOT_FOUND' ? 404 : 500;
      res.status(status).json({
        error: err.message,
        code: err.code,
        receivedBytes: err.receivedBytes,
      });
    }
  });
  req.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'Upload aborted' });
  });
});

host.get('/api/host/vault/:id/offset', requireKey, async (req, res) => {
  const info = await vault.uploadOffset(req.params.id);
  if (!info) return res.status(404).json({ error: 'Not found', exists: false });
  res.json({ ok: true, exists: true, ...info });
});

host.post('/api/host/vault/:id/finalize', requireKey, express.json(), async (req, res) => {
  try {
    const video = await vault.finalizeUpload(req.params.id, {
      title: req.body?.title,
      description: req.body?.description,
      category: req.body?.category,
    });
    await library.refreshVaultCache();
    const usage = await vault.usageForScope(video.scope || vault.GLOBAL_SCOPE);
    res.json({ ok: true, video, quota: usage });
  } catch (err) {
    const status = err.code === 'QUOTA' ? 413 : 500;
    res.status(status).json({ error: err.message, code: err.code || 'ERROR' });
  }
});

// Legacy single-PUT upload (small files) — still works, now routes into vault.
host.put('/api/host/upload', (req, res) => {
  if (!keyOk(req) && !sessionFrom(req)) return res.status(401).json({ error: 'Not authorised' });
  // Prefer vault for admin-key uploads so full movies land in Postgres compressed.
  if (keyOk(req)) {
    const chunks = [];
    let bytes = 0;
    let aborted = false;
    const maxBytes = config.media.maxUploadMb * 1024 * 1024;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes && !aborted) {
        aborted = true;
        req.destroy();
        return res.status(413).json({ error: `Too large (> ${config.media.maxUploadMb} MB).` });
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (aborted) return;
      try {
        const buf = Buffer.concat(chunks);
        const started = await vault.beginUpload({
          name: req.query.name,
          size: buf.length,
          title: req.query.title ? String(req.query.title) : undefined,
          category: req.query.category ? String(req.query.category) : 'Library',
          guildId: vault.GLOBAL_SCOPE,
          addedBy: 'admin',
        });
        await vault.appendUpload(started.id, 0, buf);
        const video = await vault.finalizeUpload(started.id, {
          title: req.query.title ? String(req.query.title) : undefined,
          category: req.query.category ? String(req.query.category) : 'Library',
        });
        await library.refreshVaultCache();
        log.info(`Vault uploaded "${video.name}" (${(buf.length / 1048576).toFixed(0)} MB raw)`);
        res.json({ ok: true, video, vault: true });
      } catch (err) {
        const status = err.code === 'QUOTA' || err.code === 'TOO_LARGE' ? 413 : 500;
        res.status(status).json({ error: err.message });
      }
    });
    return;
  }
  // Session tokens still use the classic disk library path for one-off adds.
  ensureDir();
  const clean = sanitize(req.query.name);
  const ext = path.extname(clean).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) {
    return res.status(400).json({ error: `Unsupported type "${ext}". Use MP4/WebM (MKV/AVI won't play in browsers).` });
  }
  const maxBytes = config.media.maxUploadMb * 1024 * 1024;
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > maxBytes) {
    return res.status(413).json({ error: `Too large (> ${config.media.maxUploadMb} MB).` });
  }

  let file = clean;
  let n = 1;
  while (fs.existsSync(path.join(config.media.dir, file))) {
    file = `${path.basename(clean, ext)} (${n++})${ext}`;
  }
  const dest = path.join(config.media.dir, file);
  const out = fs.createWriteStream(dest);
  let bytes = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes && !aborted) {
      aborted = true;
      req.destroy();
      out.destroy();
      fs.rm(dest, { force: true }, () => {});
      res.status(413).json({ error: `Too large (> ${config.media.maxUploadMb} MB).` });
    }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) return;
    const video = store.register({
      file,
      name: req.query.title ? String(req.query.title) : undefined,
      category: req.query.category ? String(req.query.category) : 'Library',
      size: bytes,
    });
    log.info(`Host uploaded "${video.name}" (${(bytes / 1048576).toFixed(0)} MB)`);
    res.json({ ok: true, video });
  });
  out.on('error', (err) => {
    if (aborted) return;
    log.warn('upload write error:', err.message);
    res.status(500).json({ error: 'Write failed' });
  });
});

// Start the watch party from the host page (uses the one-time session token's
// Discord context — no admin key, no manual channel wiring).
host.post('/api/host/start', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Session expired — re-open “Host a Movie” from /watch.' });
  const video = library.findVideo(req.body?.uid) || store.find(req.body?.uid);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  if (!s.voiceChannelId) {
    return res.status(400).json({ error: 'no-voice', message: 'Join a voice channel, then re-open “Host a Movie” from /watch to start a party.' });
  }
  const client = getDiscordClient();
  if (!client) return res.status(503).json({ error: 'Bot is offline — try again in a moment.' });

  try {
    const playback = library.getPlaybackFor(video);
    sessions.startClanMovie(s.voiceChannelId, { hostId: s.userId, guildId: s.guildId, video, playback });
    const voice = await client.channels.fetch(s.voiceChannelId).catch(() => null);
    const text = s.textChannelId ? await client.channels.fetch(s.textChannelId).catch(() => null) : null;
    const activityUrl = voice ? await createActivityInvite(voice) : null;
    if (text) await publishPanel(text, s.voiceChannelId, activityUrl);
    res.json({ ok: true, name: video.name, activityUrl });
  } catch (err) {
    log.warn('host start:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---- Temporary per-party session (hybrid host) -----------------------------
// Step 1: create a temp session for this voice channel and START the party
// immediately (pointing playback at the temp file), so viewers can join before
// the upload finishes. Returns the session id to stream into.
host.post('/api/host/session', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Session expired — re-open “Host a Movie” from /watch.' });
  if (!s.voiceChannelId) {
    return res.status(400).json({ error: 'no-voice', message: 'Join a voice channel, then re-open “Host a Movie” from /watch.' });
  }
  const client = getDiscordClient();
  if (!client) return res.status(503).json({ error: 'Bot is offline — try again in a moment.' });

  const session = temp.create({ channelId: s.voiceChannelId, name: req.body?.name, size: req.body?.size, addedBy: s.userId });
  try {
    const playback = {
      ...temp.getPlayback(session),
      webPlayable: session.webPlayable !== false,
      converting: Boolean(session.converting),
      codecTip: session.codecTip || null,
      posterUrl: req.body?.posterUrl ? String(req.body.posterUrl).slice(0, 800) : null,
      description: req.body?.description ? String(req.body.description).slice(0, 800) : null,
    };
    const title = req.body?.title ? String(req.body.title).slice(0, 160) : null;
    const video = {
      uid: session.id,
      name: title || session.name,
      category: req.body?.category || 'Now Playing',
      description: playback.description || '',
      posterUrl: playback.posterUrl,
      thumbnail: playback.posterUrl || '',
    };
    sessions.startClanMovie(s.voiceChannelId, { hostId: s.userId, guildId: s.guildId, video, playback });
    const voice = await client.channels.fetch(s.voiceChannelId).catch(() => null);
    const text = s.textChannelId ? await client.channels.fetch(s.textChannelId).catch(() => null) : null;
    const activityUrl = voice ? await createActivityInvite(voice) : null;
    if (text) await publishPanel(text, s.voiceChannelId, activityUrl);
    res.json({
      ok: true,
      sessionId: session.id,
      name: video.name,
      activityUrl,
      webPlayable: session.webPlayable !== false,
      converting: Boolean(session.converting),
      codecTip: session.codecTip || null,
      suspectConvert: Boolean(session.suspectConvert),
      size: session.total,
    });
  } catch (err) {
    temp.scrub(session.id);
    log.warn('host session start:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Optional now-playing poster image for the multiplex light-boxes.
host.put('/api/host/session/:id/poster', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Not authorised' });
  const session = temp.find(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.channelId && s.voiceChannelId && session.channelId !== s.voiceChannelId) {
    return res.status(403).json({ error: 'Wrong channel' });
  }
  const ext = String(req.query.ext || '.jpg').toLowerCase();
  const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.jpg';
  const dest = path.join(path.dirname(session.file), `${session.id}.poster${safeExt}`);
  const out = fs.createWriteStream(dest);
  let bytes = 0;
  let aborted = false;
  const maxBytes = 8 * 1024 * 1024;
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes && !aborted) {
      aborted = true;
      req.destroy();
      out.destroy();
      fs.rm(dest, { force: true }, () => {});
      res.status(413).json({ error: 'Poster too large (> 8 MB).' });
    }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) return;
    session.posterFile = dest;
    const posterUrl = `/tmedia/${session.id}/poster`;
    if (session.channelId) {
      sessions.setPlaybackMeta(session.channelId, { posterUrl });
    }
    res.json({ ok: true, posterUrl });
  });
  out.on('error', (err) => {
    if (aborted) return;
    log.warn('poster write error:', err.message);
    res.status(500).json({ error: 'Write failed' });
  });
});

// Update title / description / poster URL after the party has started.
host.post('/api/host/session/:id/meta', express.json(), (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Not authorised' });
  const session = temp.find(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.channelId && s.voiceChannelId && session.channelId !== s.voiceChannelId) {
    return res.status(403).json({ error: 'Wrong channel' });
  }
  if (req.body?.title) session.name = String(req.body.title).slice(0, 160);
  if ('description' in (req.body || {})) session.description = req.body.description ? String(req.body.description).slice(0, 800) : '';
  if (session.channelId) {
    const patch = {};
    if (req.body?.title) patch.videoName = req.body.title;
    if ('description' in (req.body || {})) patch.description = req.body.description;
    if (req.body?.posterUrl) patch.posterUrl = req.body.posterUrl;
    if (Object.keys(patch).length) sessions.setPlaybackMeta(session.channelId, patch);
  }
  res.json({ ok: true });
});

// Where a resumable upload should continue from (the host page polls this after
// a connection hiccup, then re-PUTs the remainder with ?offset=).
host.get('/api/host/session/:id/offset', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Not authorised' });
  const session = temp.find(req.params.id);
  if (!session) return res.json({ exists: false });
  res.json({ exists: true, receivedBytes: session.receivedBytes, complete: session.complete });
});

// After upload finishes, host page polls this for codec probe / remux status.
host.get('/api/host/session/:id/probe', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Not authorised' });
  const session = temp.find(req.params.id);
  if (!session) return res.json({ exists: false });
  res.json({
    exists: true,
    complete: session.complete,
    webPlayable: session.webPlayable !== false,
    converting: Boolean(session.converting),
    codecTip: session.codecTip || null,
    webReady: Boolean(session.webFile) || Boolean(session.kind === 'hls' && session.hlsDir),
    streamKind: session.kind || 'file',
    probe: session.probe
      ? {
          videoCodec: session.probe.videoCodec,
          audioCodec: session.probe.audioCodec,
          width: session.probe.width,
          height: session.probe.height,
          webPlayable: session.probe.webPlayable,
        }
      : null,
  });
});

// Step 2: stream the file bytes into the temp session (long-running). The range
// route serves what has arrived so far while this is in flight. Supports resume:
// ?offset=<bytes> appends from that point (must equal what we already have).
host.put('/api/host/session/:id/data', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Not authorised' });
  const session = temp.find(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.channelId && s.voiceChannelId && session.channelId !== s.voiceChannelId) {
    return res.status(403).json({ error: 'Wrong channel' });
  }

  const offset = parseInt(req.query.offset, 10) || 0;
  if (offset !== session.receivedBytes) {
    // Client is out of sync — tell it where we actually are so it can resume.
    return res.status(409).json({ error: 'offset-mismatch', receivedBytes: session.receivedBytes });
  }
  const append = offset > 0;
  if (!append) session.receivedBytes = 0;

  const maxBytes = config.media.maxUploadMb * 1024 * 1024;
  const ws = temp.openWrite(session, { append });
  temp.markConnected(session);
  let aborted = false;
  let ended = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    if (session.receivedBytes + chunk.length > maxBytes) {
      aborted = true;
      req.destroy();
      ws.destroy();
      temp.scrub(session.id);
      if (!res.headersSent) res.status(413).json({ error: `Too large (> ${config.media.maxUploadMb} MB).` });
      return;
    }
    // Pause until the chunk is durably written, so the reader never sees bytes
    // that aren't on disk yet, and we get natural backpressure.
    req.pause();
    ws.write(chunk, () => {
      temp.advance(session, chunk.length);
      req.resume();
    });
  });
  req.on('end', () => {
    if (aborted) return;
    ended = true;
    ws.end(() => {
      // Chunked uploads: only finish (probe/HLS) when the declared size is fully
      // on disk. A mid-file chunk end must NOT mark the movie complete.
      const done =
        session.total > 0 ? session.receivedBytes >= session.total : true;
      if (done) temp.finish(session);
      if (!res.headersSent) {
        res.json({
          ok: true,
          bytes: session.receivedBytes,
          complete: Boolean(session.complete || done),
        });
      }
    });
  });
  // Host tab closed / network dropped before finishing — preserve everything,
  // just flag the feed so viewers see a notice and the host can resume.
  req.on('close', () => {
    if (ended || aborted) return;
    ws.end(() => {});
    temp.markDisconnected(session);
  });
  req.on('error', () => {
    if (!aborted && !ended) {
      ws.destroy();
      temp.markDisconnected(session);
    }
  });
  ws.on('error', (err) => {
    if (aborted || ended) return;
    aborted = true;
    log.warn('temp write:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Write failed' });
  });
});

// The uploader page — dependency-free. Works in two modes:
//   admin mode  (no ?s)  : type key, manage library.
//   session mode (?s=..) : opened from /watch; no key; auto-starts the party.
export function hostPage() {
  const nonWeb = [...NON_WEB].join(', ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DarkNight — Host a Movie</title><style>
  body{font-family:system-ui,sans-serif;background:#0b0b12;color:#e7e7f0;margin:0;padding:1.5rem}
  .card{max-width:720px;margin:1rem auto;background:#15151f;border:1px solid #2a2a3a;border-radius:16px;padding:1.5rem}
  h1{margin:.2rem 0;color:#c9a227}code{background:#20202c;padding:.1rem .4rem;border-radius:6px;color:#ffd66b}
  input[type=text],input[type=password]{width:100%;padding:.6rem;margin:.3rem 0 .8rem;background:#20202c;border:1px solid #2a2a3a;border-radius:8px;color:#fff}
  .drop{border:2px dashed #3a3a52;border-radius:14px;padding:2rem;text-align:center;color:#9a97b5;cursor:pointer;transition:.2s}
  .drop.hover{border-color:#c9a227;background:#191922}
  .bar{height:10px;background:#20202c;border-radius:6px;overflow:hidden;margin:.6rem 0;display:none}.bar>i{display:block;height:100%;width:0;background:#37c871;transition:.2s}
  a.open{display:inline-block;margin-top:.6rem;background:#5865f2;color:#fff;text-decoration:none;padding:.55rem 1rem;border-radius:10px;font-weight:700}
  ul{list-style:none;padding:0}li{display:flex;justify-content:space-between;align-items:center;background:#1c1c2b;border:1px solid #2a2a3a;border-radius:10px;padding:.5rem .8rem;margin:.3rem 0}
  li button{background:#3a1c22;color:#ff9ea6;border:1px solid #5a2630;border-radius:8px;padding:.3rem .6rem;cursor:pointer}
  small{color:#9a97b5}
</style></head><body><div class="card">
  <h1>🎬 Host a Movie</h1>
  <p id="mode">Add a video from this device. Best format: <b>MP4 (H.264 video + AAC audio)</b> or WebM. Even resolution (e.g. 1920×1080). Won’t play in browsers: <code>${nonWeb}</code>. MovieBox / “Pro” rips are often <b>H.265</b> — those show a black screen in Discord.</p>
  <div id="keywrap"><label>Admin key</label><input type="password" id="key" placeholder="HOST_ADMIN_KEY (or SESSION_SECRET)"/></div>
  <p id="quota" style="display:none"><small></small></p>
  <label>Movie title (optional)</label>
  <input type="text" id="title" placeholder="Now Playing title"/>
  <label>Short description (optional)</label>
  <input type="text" id="desc" placeholder="One-line blurb for the marquee / multiplex"/>
  <label>Category (optional)</label>
  <input type="text" id="cat" placeholder="Library" value="Library"/>
  <label>Poster image (optional — shows in the 3D multiplex)</label>
  <input type="file" id="poster" accept="image/*"/>
  <div class="drop" id="drop">📁 Click or drop a video file here</div>
  <input type="file" id="file" accept="video/*" style="display:none"/>
  <div class="bar" id="barwrap"><i id="bar"></i></div>
  <p id="status"><small>Choose a file to begin.</small></p>
  <div id="listwrap"><h3>Admin movie vault</h3><ul id="list"></ul></div>
</div>
<script>
const $=s=>document.querySelector(s);
const S=new URLSearchParams(location.search).get('s');
const keyEl=$('#key');
const CHUNK=8*1024*1024;
if(S){ // session mode: opened from /watch — no key, auto-start the party
  $('#keywrap').style.display='none';
  $('#listwrap').style.display='none';
  $('#mode').innerHTML='Pick a movie from this device — the party <b>starts right away</b> and it streams while it uploads. Your file stays on your device; the server copy is temporary and deleted when the party ends. <b>Keep this tab open</b> while watching.<br><br><b>Must be Discord-safe:</b> MP4 with <b>H.264 + AAC</b> (or WebM). Even width/height (1920×1080). <b>.mp4 alone is not enough</b> — MovieBox/HEVC/H.265 used to play black — the server now auto-builds a Discord HLS stream after upload so playback can start before the whole movie finishes converting. HandBrake “Fast 1080p30” is still the fastest path.';
} else {
  keyEl.value=localStorage.getItem('dnkey')||'';
  keyEl.onchange=()=>{localStorage.setItem('dnkey',keyEl.value);refresh();};
  $('#mode').innerHTML='Upload <b>full movies</b> (no more 30‑min clips). Files are <b>gzip‑chunked into Postgres</b> and only expanded when someone presses play — stays until you delete them. Quota defaults to <b>10 GB</b> compressed (~2–3 films). Users who browse Movies / Host still see <b>your</b> vault titles.<br><br><b>Must be Discord-safe:</b> MP4 H.264 + AAC (or WebM). Even width/height.';
  refresh();
}
const drop=$('#drop'),file=$('#file');
drop.onclick=()=>file.click();
['dragover','dragenter'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('hover');}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('hover');}));
drop.addEventListener('drop',ev=>{if(ev.dataTransfer.files[0])upload(ev.dataTransfer.files[0]);});
file.onchange=()=>{if(file.files[0])upload(file.files[0]);};
function auth(){ return S ? ('s='+encodeURIComponent(S)) : ('key='+encodeURIComponent((keyEl.value||'').trim())); }
function setStatus(html){ $('#status').innerHTML='<small>'+html+'</small>'; }
function upload(f){
  if(S) return hostSession(f); // temporary per-party session (streams while it plays)
  if(!(keyEl.value||'').trim()){ setStatus('Enter your admin key first.'); return; }
  adminVaultUpload(f);
}
function fmtGb(n){ return (Number(n||0)/(1024*1024*1024)).toFixed(2)+' GB'; }
function fmtMb(n){ return Math.floor(Number(n||0)/1048576)+' MB'; }
// Admin vault: chunked upload → compress into Postgres (resumable for multi‑GB films).
async function adminVaultUpload(f){
  const key=(keyEl.value||'').trim();
  const title=($('#title').value||'').trim();
  const description=($('#desc').value||'').trim();
  const category=$('#cat').value||'Library';
  setStatus('Reserving vault space for “'+(title||f.name)+'”…');
  $('#barwrap').style.display='block'; $('#bar').style.width='0';
  let begin;
  try{
    begin=await fetch('/api/host/vault/begin?key='+encodeURIComponent(key),{
      method:'POST', headers:{'Content-Type':'application/json','x-admin-key':key},
      body:JSON.stringify({name:f.name,size:f.size,title:title||undefined,description:description||undefined,category})
    }).then(r=>r.json());
  }catch{ setStatus('⚠️ Could not reach the vault.'); return; }
  if(!begin.ok){ setStatus('⚠️ '+(begin.error||'Could not start upload')); return; }
  const id=begin.id;
  let offset=0; let retries=0;
  async function putChunk(){
    const end=Math.min(offset+CHUNK, f.size);
    const blob=f.slice(offset,end);
    try{
      const r=await fetch('/api/host/vault/'+id+'/data?key='+encodeURIComponent(key)+'&offset='+offset,{
        method:'PUT', headers:{'x-admin-key':key,'Content-Type':'application/octet-stream'}, body:blob
      }).then(x=>x.json().then(j=>({status:x.status,j})));
      if(r.status===409 && r.j.receivedBytes!=null){ offset=r.j.receivedBytes; return putChunk(); }
      if(r.status<200||r.status>=300||!r.j.ok){
        if(++retries>40){ setStatus('⚠️ Upload stopped. Pick the file again to resume.'); return; }
        setStatus('⚠️ Connection hiccup — resuming…');
        await new Promise(res=>setTimeout(res,1500));
        const off=await fetch('/api/host/vault/'+id+'/offset?key='+encodeURIComponent(key)).then(x=>x.json());
        offset=off.receivedBytes||offset;
        return putChunk();
      }
      retries=0;
      offset=r.j.receivedBytes!=null?r.j.receivedBytes:end;
      $('#bar').style.width=(offset/f.size*100)+'%';
      setStatus('📡 Uploading full movie… '+Math.floor(offset/f.size*100)+'% ('+fmtMb(offset)+' / '+fmtMb(f.size)+'). Keep this tab open.');
      if(offset<f.size) return putChunk();
      setStatus('📦 Compressing into Postgres vault…');
      const fin=await fetch('/api/host/vault/'+id+'/finalize?key='+encodeURIComponent(key),{
        method:'POST', headers:{'Content-Type':'application/json','x-admin-key':key},
        body:JSON.stringify({title:title||undefined,description:description||undefined,category})
      }).then(x=>x.json());
      if(!fin.ok){ setStatus('⚠️ '+(fin.error||'Finalize failed')); return; }
      $('#bar').style.width='100%';
      const q=fin.quota;
      setStatus('✅ Vaulted “'+fin.video.name+'” — stays until you delete it. Compressed '+fmtMb(fin.video.compressedSize)+' (raw '+fmtMb(fin.video.size)+').'+(q?' Quota '+fmtGb(q.usedBytes)+' / '+fmtGb(q.quotaBytes)+'.':''));
      refresh();
    }catch(e){
      if(++retries>40){ setStatus('⚠️ Upload stopped.'); return; }
      setStatus('⚠️ Network error — retrying…');
      await new Promise(res=>setTimeout(res,1500));
      return putChunk();
    }
  }
  return putChunk();
}
// Session mode: create a TEMPORARY party file, start the party immediately, then
// stream the file up in the background so viewers watch as it uploads. The upload
// is resumable — a network hiccup auto-continues from the server's offset without
// restarting the movie.
var SID=null, FILE=null, hostMsg='', retries=0;
async function hostSession(f){
  setStatus('Setting up your theater…');
  let meta={};
  const title=($('#title').value||'').trim();
  const description=($('#desc').value||'').trim();
  try{
    meta=await fetch('/api/host/session',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({s:S,name:f.name,size:f.size,category:$('#cat').value||'Now Playing',title:title||undefined,description:description||undefined})}).then(r=>r.json());
  }catch{ setStatus('⚠️ Could not reach the bot.'); return; }
  if(!meta.ok){ setStatus('⚠️ '+(meta.message||meta.error||'Could not start the party')); return; }
  SID=meta.sessionId; FILE=f; retries=0;
  // Upload poster (if any) so multiplex light-boxes show the art.
  const poster=$('#poster').files&&$('#poster').files[0];
  if(poster){
    try{
      const ext=(poster.name.match(/\\.[a-z0-9]+$/i)||['.jpg'])[0].toLowerCase();
      await fetch('/api/host/session/'+SID+'/poster?s='+encodeURIComponent(S)+'&ext='+encodeURIComponent(ext),{method:'PUT',body:poster,headers:{'Content-Type':poster.type||'application/octet-stream'}});
    }catch{}
  } else if(title||description){
    try{
      await fetch('/api/host/session/'+SID+'/meta?s='+encodeURIComponent(S),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({s:S,title:title||undefined,description:description||undefined})});
    }catch{}
  }
  hostMsg='🎉 <b>Party started</b> — “'+(title||meta.name)+'”! Prefer launching from Discord: voice channel → <b>Activities</b> → DarkNight (same window). <b>Keep this tab open</b> while it streams.';
  if(meta.activityUrl) hostMsg+='<br><a class="open" href="'+meta.activityUrl+'" target="_blank" rel="noopener">▶ Open Theater invite</a> <small>(invite links may open another Discord window — that’s Discord, not a bug)</small>';
  if(meta.converting || meta.suspectConvert){
    hostMsg+='<br><small>🛡️ MovieBox/large file detected — Discord playback is <b>held</b> until a safe HLS stream is ready (avoids the black screen). Upload finishes first, then the first segments unlock the Theater.</small>';
    if(meta.codecTip) hostMsg+='<br><small>'+esc(meta.codecTip)+'</small>';
  } else if(meta.webPlayable===false){
    hostMsg+='<br><small>⚠️ This container may not play in browsers — use MP4 H.264/AAC.</small>';
  }
  setStatus(hostMsg);
  $('#barwrap').style.display='block';
  streamFrom(0);
}
function streamFrom(offset){
  const end=Math.min(offset+CHUNK, FILE.size);
  const blob=FILE.slice(offset, end);
  const xhr=new XMLHttpRequest();
  xhr.open('PUT','/api/host/session/'+SID+'/data?s='+encodeURIComponent(S)+'&offset='+offset);
  xhr.upload.onprogress=e=>{ if(e.lengthComputable){ retries=0; $('#bar').style.width=((offset+e.loaded)/FILE.size*100)+'%'; } };
  xhr.onload=()=>{
    if(xhr.status<200 || xhr.status>=300){ resumeSoon(); return; }
    let r={}; try{r=JSON.parse(xhr.responseText);}catch{}
    const next=(r.bytes!=null)?r.bytes:end;
    $('#bar').style.width=(next/FILE.size*100)+'%';
    retries=0;
    if(r.complete || next>=FILE.size){
      $('#bar').style.width='100%';
      setStatus(hostMsg+'<br><small>✅ Fully uploaded — optimizing for Discord…</small>');
      pollProbe(0);
      return;
    }
    setStatus(hostMsg+'<br><small>📡 Uploading… '+Math.floor(next/FILE.size*100)+'% ('+Math.floor(next/1048576)+' / '+Math.floor(FILE.size/1048576)+' MB). Keep this tab open.</small>');
    streamFrom(next);
  };
  xhr.onerror=()=>resumeSoon();
  xhr.onabort=()=>resumeSoon();
  xhr.send(blob);
}
async function pollProbe(n){
  if(n>480){ setStatus(hostMsg+'<br><small>✅ Uploaded. Open the Theater and press ▶. If still black, re-encode to H.264+AAC.</small>'); return; }
  try{
    const r=await fetch('/api/host/session/'+SID+'/probe?s='+encodeURIComponent(S)).then(x=>x.json());
    if(!r.exists){ setStatus('The party has ended.'); return; }
    if(r.converting && !r.webReady){
      setStatus(hostMsg+'<br><small>⚙️ Building Discord HLS stream… first segments unlock the Theater soon (full-movie encode continues in background). Keep this tab open.</small>');
      setTimeout(()=>pollProbe(n+1),2500);
      return;
    }
    if(r.webReady || r.probe){
      let msg=hostMsg+'<br><small>✅ '+(r.streamKind==='hls'?'Discord stream ready (HLS)':'Ready')+''+(r.probe?(' · '+esc(r.probe.videoCodec||'?')+' / '+esc(r.probe.audioCodec||'?')+' · '+(r.probe.width||'?')+'×'+(r.probe.height||'?')):'')+'</small>';
      if(r.codecTip) msg+='<br><small style="color:#ffb0b0">⚠️ '+esc(r.codecTip)+'</small>';
      else if(r.webPlayable===false) msg+='<br><small style="color:#ffb0b0">⚠️ This file likely won’t paint in Discord — re-encode to H.264 + AAC.</small>';
      else msg+='<br><small>Open the Theater and press ▶ if it isn’t already playing.</small>';
      setStatus(msg);
      return;
    }
  }catch{}
  setTimeout(()=>pollProbe(n+1),1500);
}
function esc(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function resumeSoon(){
  if(++retries>30){ setStatus(hostMsg+'<br><small>⚠️ Upload stopped. Pick the file again to resume.</small>'); return; }
  setStatus(hostMsg+'<br><small>⚠️ Connection hiccup — resuming upload…</small>');
  setTimeout(async ()=>{
    try{
      const r=await fetch('/api/host/session/'+SID+'/offset?s='+encodeURIComponent(S)).then(x=>x.json());
      if(!r.exists){ setStatus('The party has ended.'); return; }
      if(r.complete){ $('#bar').style.width='100%'; setStatus(hostMsg+'<br><small>✅ Fully uploaded — optimizing for Discord…</small>'); pollProbe(0); return; }
      streamFrom(r.receivedBytes);
    }catch{ resumeSoon(); }
  }, 1500);
}
async function refresh(){
  const key=(keyEl.value||'').trim(); if(!key)return;
  const r=await fetch('/api/host/list?key='+encodeURIComponent(key)); if(!r.ok){$('#list').innerHTML='';$('#quota').style.display='none';return;}
  const data=await r.json();
  const videos=data.videos||[];
  const q=data.quota;
  if(q){
    $('#quota').style.display='block';
    $('#quota').innerHTML='<small>🗄️ Vault quota: <b>'+fmtGb(q.usedBytes)+'</b> / '+fmtGb(q.quotaBytes)+' compressed · '+videos.filter(v=>v.vault).length+' vault film(s). Movies stay until you delete them.</small>';
  }
  $('#list').innerHTML=videos.map(v=>{
    const tag=v.vault?' · vault '+fmtMb(v.compressedSize||v.size):'';
    const warn=v.webPlayable?'':'⚠️ not web-playable';
    return '<li><span>🎬 '+esc(v.name)+' <small>'+warn+tag+'</small></span><button onclick="del(\\''+v.uid+'\\')">Delete</button></li>';
  }).join('')||'<li><small>No videos yet — drop a full movie above.</small></li>';
}
async function del(id){const key=(keyEl.value||'').trim();await fetch('/api/host/media/'+id+'?key='+encodeURIComponent(key),{method:'DELETE'});refresh();}
</script></body></html>`;
}
