import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import * as temp from '../../media/temp.js';
import { MIME } from '../../media/store.js';
import { verifyMediaToken } from '../../media/token.js';

// Streams a TEMPORARY per-party session file with HTTP range support — and does
// so *while the file is still uploading*. Seeking ahead of the uploaded position
// waits (briefly) for bytes to arrive; seeking behind is instant.
//
// After a Discord-safe convert starts, prefer live HLS under
// /tmedia/:id/index.m3u8 + /tmedia/:id/segXXXXX.ts (small full-file GETs —
// Discord's Activity proxy is much happier with those than giant range MP4s).
export const tmedia = express.Router();

const MAX_CHUNK = 4 * 1024 * 1024;
const typeFor = (ext) => MIME[ext] || 'application/octet-stream';

function openFile(session) {
  // Prefer a finished progressive web MP4 when present (library-style path).
  if (session.webFile && fs.existsSync(session.webFile)) {
    const size = fs.statSync(session.webFile).size;
    return { path: session.webFile, ext: '.mp4', size, complete: true };
  }
  const size = session.complete
    ? session.total || session.receivedBytes
    : Math.max(session.total || 0, session.receivedBytes);
  const available = session.complete ? size : session.receivedBytes;
  return {
    path: session.file,
    ext: session.ext,
    size,
    available,
    complete: session.complete,
  };
}

function sendWhole(res, filePath, contentType, isHead) {
  const size = fs.statSync(filePath).size;
  res.status(200);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', size);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (isHead) return res.end();
  return fs.createReadStream(filePath).pipe(res);
}

// Rewrite playlist segment lines so Discord/hls.js keep the media token.
function rewritePlaylist(raw, token) {
  return String(raw)
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      if (/\.ts($|\?)/i.test(t) || t.endsWith('.m4s')) {
        const base = t.split('?')[0];
        return `${base}?t=${encodeURIComponent(token)}`;
      }
      return line;
    })
    .join('\n');
}

// ---- HLS: playlist ---------------------------------------------------------
tmedia.get('/:id/index.m3u8', (req, res) => {
  const { id } = req.params;
  if (!verifyMediaToken(id, req.query.t)) return res.status(403).end('Forbidden');
  const session = temp.find(id);
  if (!session?.hlsDir) return res.status(404).end('Not found');
  const playlist = path.join(session.hlsDir, 'index.m3u8');
  if (!fs.existsSync(playlist)) return res.status(404).end('Not ready');
  temp.touch(session);
  const raw = fs.readFileSync(playlist, 'utf8');
  const body = rewritePlaylist(raw, req.query.t);
  res.status(200);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(body);
});

// Optional multiplex poster (no media token — small public image for light-boxes).
tmedia.get('/:id/poster', (req, res) => {
  const { id } = req.params;
  const session = temp.find(id);
  if (!session?.posterFile || !fs.existsSync(session.posterFile)) {
    return res.status(404).end('Not found');
  }
  temp.touch(session);
  const ext = path.extname(session.posterFile).toLowerCase();
  const type =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  return sendWhole(res, session.posterFile, type, req.method === 'HEAD');
});

// ---- HLS: segments ---------------------------------------------------------
tmedia.get('/:id/:seg', (req, res) => {
  const { id, seg } = req.params;
  // Don't steal the bare /:id progressive route — only real segment names.
  if (!/^(seg\d+\.ts|index\.m3u8)$/i.test(seg) && !/\.ts$/i.test(seg)) {
    return res.status(404).end('Not found');
  }
  if (!verifyMediaToken(id, req.query.t)) return res.status(403).end('Forbidden');
  const session = temp.find(id);
  if (!session?.hlsDir) return res.status(404).end('Not found');
  const safe = path.basename(seg);
  // Resolve + containment check so ../ or weird encodings cannot escape hlsDir.
  const root = path.resolve(session.hlsDir);
  const filePath = path.resolve(root, safe);
  if (filePath !== path.join(root, safe) || !fs.existsSync(filePath)) {
    return res.status(404).end('Not found');
  }
  temp.touch(session);
  const ext = path.extname(safe).toLowerCase();
  return sendWhole(res, filePath, typeFor(ext), req.method === 'HEAD');
});

async function handle(req, res, isHead) {
  const { id } = req.params;
  if (!verifyMediaToken(id, req.query.t)) return res.status(403).end('Forbidden');
  const session = temp.find(id);
  if (!session || !fs.existsSync(session.file)) return res.status(404).end('Not found');
  temp.touch(session);

  // If live HLS is already published, nudge clients toward the playlist instead
  // of serving the incompatible original progressive file.
  if (session.kind === 'hls' && session.hlsDir && fs.existsSync(path.join(session.hlsDir, 'index.m3u8'))) {
    const token = req.query.t;
    return res.redirect(302, `/tmedia/${id}/index.m3u8?t=${encodeURIComponent(token)}`);
  }

  const f = openFile(session);
  const total = f.complete ? f.size : Math.max(f.size || 0, f.available || 0);
  const available = f.complete ? total : f.available || 0;

  res.setHeader('Content-Type', typeFor(f.ext));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const range = req.headers.range;

  // No Range: complete files → 200 (Discord's proxy mishandles always-206).
  // While uploading, serve a 206 prefix so the player can start buffering.
  if (!range) {
    if (f.complete && available > 0) {
      res.status(200);
      res.setHeader('Content-Length', available);
      if (isHead) return res.end();
      return fs.createReadStream(f.path, { start: 0, end: available - 1 }).pipe(res);
    }
    if (available <= 0) {
      res.setHeader('Retry-After', '1');
      return res.status(503).end();
    }
    const end = Math.min(available - 1, MAX_CHUNK - 1);
    res.status(206);
    res.setHeader('Content-Range', `bytes 0-${end}/${total || available}`);
    res.setHeader('Content-Length', end + 1);
    if (isHead) return res.end();
    return fs.createReadStream(f.path, { start: 0, end }).pipe(res);
  }

  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let reqEnd = m && m[2] ? parseInt(m[2], 10) : (total || available) - 1;
  if (Number.isNaN(start) || start < 0 || (total && start >= total)) {
    res.setHeader('Content-Range', `bytes */${total || '*'}`);
    return res.status(416).end();
  }

  // Only wait for bytes on the original upload file (webFile is always complete).
  if (!session.webFile) {
    await temp.waitForBytes(session, start + 1, 30000);
  }
  const liveAvailable = session.webFile
    ? available
    : session.complete
      ? session.total || session.receivedBytes
      : session.receivedBytes;
  const availableEnd = liveAvailable - 1;
  if (availableEnd < start) {
    res.setHeader('Retry-After', '1');
    return res.status(503).end();
  }
  const end = Math.min(reqEnd, availableEnd, start + MAX_CHUNK - 1);

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total || liveAvailable}`);
  res.setHeader('Content-Length', end - start + 1);
  if (isHead) return res.end();
  fs.createReadStream(f.path, { start, end }).pipe(res);
}

tmedia.get('/:id', (req, res) => handle(req, res, false));
tmedia.head('/:id', (req, res) => handle(req, res, true));
