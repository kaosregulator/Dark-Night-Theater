import fs from 'node:fs';
import express from 'express';
import * as temp from '../../media/temp.js';
import { MIME } from '../../media/store.js';
import { verifyMediaToken } from '../../media/token.js';

// Streams a TEMPORARY per-party session file with HTTP range support — and does
// so *while the file is still uploading*. Seeking ahead of the uploaded position
// waits (briefly) for bytes to arrive; seeking behind is instant.
export const tmedia = express.Router();

const MAX_CHUNK = 4 * 1024 * 1024;
const typeFor = (ext) => MIME[ext] || 'application/octet-stream';

async function handle(req, res, isHead) {
  const { id } = req.params;
  if (!verifyMediaToken(id, req.query.t)) return res.status(403).end('Forbidden');
  const session = temp.find(id);
  if (!session || !fs.existsSync(session.file)) return res.status(404).end('Not found');
  temp.touch(session);

  const total = session.complete
    ? session.total || session.receivedBytes
    : Math.max(session.total || 0, session.receivedBytes);
  const available = session.complete ? total : session.receivedBytes;
  res.setHeader('Content-Type', typeFor(session.ext));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  // Help Discord's Activity proxy / Chromium accept progressive MP4s.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const range = req.headers.range;

  // No Range header: if the upload is complete, return a normal 200 (proxies
  // and some players mishandle "always 206"). While uploading, serve whatever
  // prefix we already have as 206 so the player can start buffering.
  if (!range) {
    if (session.complete && available > 0) {
      res.status(200);
      res.setHeader('Content-Length', available);
      if (isHead) return res.end();
      return fs.createReadStream(session.file, { start: 0, end: available - 1 }).pipe(res);
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
    return fs.createReadStream(session.file, { start: 0, end }).pipe(res);
  }

  // Parse Range
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let reqEnd = m && m[2] ? parseInt(m[2], 10) : (total || available) - 1;
  if (Number.isNaN(start) || start < 0 || (total && start >= total)) {
    res.setHeader('Content-Range', `bytes */${total || '*'}`);
    return res.status(416).end();
  }

  // Make sure the first requested byte is actually on disk yet.
  await temp.waitForBytes(session, start + 1, 30000);
  const availableEnd = (session.complete ? total : session.receivedBytes) - 1;
  if (availableEnd < start) {
    // Upload hasn't reached here yet — ask the player to retry shortly.
    res.setHeader('Retry-After', '1');
    return res.status(503).end();
  }
  let end = Math.min(reqEnd, availableEnd, start + MAX_CHUNK - 1);

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total || session.receivedBytes}`);
  res.setHeader('Content-Length', end - start + 1);
  if (isHead) return res.end();
  fs.createReadStream(session.file, { start, end }).pipe(res);
}

tmedia.get('/:id', (req, res) => handle(req, res, false));
tmedia.head('/:id', (req, res) => handle(req, res, true));
