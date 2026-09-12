import fs from 'node:fs';
import express from 'express';
import * as temp from '../../media/temp.js';
import { MIME } from '../../media/store.js';
import { verifyMediaToken } from '../../media/token.js';

// Streams a TEMPORARY per-party session file with HTTP range support — and does
// so *while the file is still uploading*. Seeking ahead of the uploaded position
// waits (briefly) for bytes to arrive; seeking behind is instant.
// After a Discord-safe transcode finishes, prefer session.webFile (H.264/AAC).
export const tmedia = express.Router();

const MAX_CHUNK = 4 * 1024 * 1024;
const typeFor = (ext) => MIME[ext] || 'application/octet-stream';

function openFile(session) {
  // Prefer the Discord-safe transcode when ready.
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

async function handle(req, res, isHead) {
  const { id } = req.params;
  if (!verifyMediaToken(id, req.query.t)) return res.status(403).end('Forbidden');
  const session = temp.find(id);
  if (!session || !fs.existsSync(session.file)) return res.status(404).end('Not found');
  temp.touch(session);

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
