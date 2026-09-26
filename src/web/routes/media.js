import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import * as store from '../../media/store.js';
import { MIME } from '../../media/store.js';
import * as vault from '../../media/vault.js';
import { verifyMediaToken } from '../../media/token.js';

const MIME_TYPE = (ext) => MIME[String(ext).toLowerCase()] || 'application/octet-stream';

export const media = express.Router();

// Stream a local (or vault-expanded) video with HTTP range support. Vault movies
// stay gzip-chunked in Postgres until the first authenticated play request.
async function handle(req, res, isHead) {
  const { id } = req.params;
  if (!verifyMediaToken(id, req.query.t)) {
    return res.status(403).end('Forbidden');
  }

  let file = store.filePath(id);
  let type = file ? MIME_TYPE(path.extname(file)) : null;

  if (!file || !fs.existsSync(file)) {
    const movie = await vault.findMovie(id);
    if (!movie || !movie.ready) return res.status(404).end('Not found');
    try {
      file = await vault.ensureMaterialized(id);
    } catch (err) {
      return res.status(503).end(`Vault expand failed: ${err.message}`);
    }
    if (!file || !fs.existsSync(file)) return res.status(404).end('Not found');
    type = MIME_TYPE(path.extname(file)) || movie.mime_type || 'video/mp4';
  }

  const stat = fs.statSync(file);
  const total = stat.size;

  res.setHeader('Content-Type', type || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', total);
    res.status(200);
    if (isHead) return res.end();
    return fs.createReadStream(file).pipe(res);
  }

  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end();
  }
  const MAX_CHUNK = 4 * 1024 * 1024;
  if (end - start + 1 > MAX_CHUNK) end = start + MAX_CHUNK - 1;

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', end - start + 1);
  if (isHead) return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

media.get('/:id', (req, res) => {
  handle(req, res, false).catch((err) => {
    if (!res.headersSent) res.status(500).end(err.message);
  });
});
media.head('/:id', (req, res) => {
  handle(req, res, true).catch((err) => {
    if (!res.headersSent) res.status(500).end(err.message);
  });
});
