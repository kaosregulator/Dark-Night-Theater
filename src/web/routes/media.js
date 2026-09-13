import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import * as store from '../../media/store.js';
import { MIME } from '../../media/store.js';
import { verifyMediaToken } from '../../media/token.js';
import { libraryHlsDir } from '../../media/party-convert.js';

const MIME_TYPE = (ext) => MIME[String(ext).toLowerCase()] || 'application/octet-stream';

export const media = express.Router();

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

// Library live-HLS playlist (conversion-first watch-party / background convert).
media.get('/:id/index.m3u8', (req, res) => {
  const { id } = req.params;
  if (!verifyMediaToken(id, req.query.t)) return res.status(403).end('Forbidden');
  const playlist = path.join(libraryHlsDir(id), 'index.m3u8');
  if (!fs.existsSync(playlist)) return res.status(404).end('Not ready');
  const body = rewritePlaylist(fs.readFileSync(playlist, 'utf8'), req.query.t);
  res.status(200);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(body);
});

media.get('/:id/:seg', (req, res, next) => {
  const { id, seg } = req.params;
  // Only HLS segments — fall through to progressive /:id for anything else.
  if (!/^seg\d+\.ts$/i.test(seg) && !/\.ts$/i.test(seg)) return next('route');
  if (!verifyMediaToken(id, req.query.t)) return res.status(403).end('Forbidden');
  const file = path.join(libraryHlsDir(id), path.basename(seg));
  if (!fs.existsSync(file)) return res.status(404).end('Not found');
  res.status(200);
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  fs.createReadStream(file).pipe(res);
});

// Stream a local video with HTTP range support. This is what makes seeking,
// late joiners, and 1hr+ playback work: the browser's <video> element requests
// byte ranges and we answer with 206 Partial Content.
function handle(req, res, isHead) {
  const { id } = req.params;
  if (!verifyMediaToken(id, req.query.t)) {
    return res.status(403).end('Forbidden');
  }
  const file = store.filePath(id);
  if (!file || !fs.existsSync(file)) return res.status(404).end('Not found');

  const stat = fs.statSync(file);
  const total = stat.size;
  const type = MIME_TYPE(path.extname(file));

  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', total);
    res.status(200);
    if (isHead) return res.end();
    return fs.createReadStream(file).pipe(res);
  }

  // Parse "bytes=start-end"
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
    res.setHeader('Content-Range', `bytes */${total}`);
    return res.status(416).end(); // Range Not Satisfiable
  }
  // Cap chunk size so a single request can't pin the whole file in memory.
  const MAX_CHUNK = 4 * 1024 * 1024;
  if (end - start + 1 > MAX_CHUNK) end = start + MAX_CHUNK - 1;

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Content-Length', end - start + 1);
  if (isHead) return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

media.get('/:id', (req, res) => handle(req, res, false));
media.head('/:id', (req, res) => handle(req, res, true));
