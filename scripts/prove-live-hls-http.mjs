/**
 * PROVES the live HLS HTTP delivery path used by Discord Activities.
 * Run: node scripts/prove-live-hls-http.mjs
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const mediaDir = path.join(root, '.prove-media');
fs.mkdirSync(mediaDir, { recursive: true });
process.env.MEDIA_DIR = mediaDir;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'prove-live-hls-secret';

const { tmedia } = await import('../src/web/routes/tmedia.js');
const temp = await import('../src/media/temp.js');
const { signMediaToken } = await import('../src/media/token.js');
const { startLiveHls } = await import('../src/media/transcode.js');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHttp(base, urlPath) {
  const res = await fetch(base + urlPath);
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: buf,
    text: buf.toString('utf8'),
  };
}

const work = path.join(root, '.prove-hls');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const hevcSrc = path.join(work, 'movie-hevc.mp4');
console.log('encoding sample HEVC source (20s)…');
await new Promise((resolve, reject) => {
  const child = spawn(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=1280x720:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100',
      '-t',
      '20',
      '-c:v',
      'libx265',
      '-pix_fmt',
      'yuv420p',
      '-x265-params',
      'log-level=error',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      hevcSrc,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-400) || 'hevc encode failed'))));
});
assert(fs.existsSync(hevcSrc), 'HEVC source exists');
console.log('HEVC source ready', (fs.statSync(hevcSrc).size / 1024).toFixed(0), 'KB');

const session = temp.create({
  channelId: 'prove-channel',
  name: 'The Bay - MovieBoxPro.mp4',
  size: fs.statSync(hevcSrc).size,
  addedBy: 'prove',
});
fs.copyFileSync(hevcSrc, session.file);
session.receivedBytes = fs.statSync(session.file).size;
session.complete = true;
session.kind = 'hls';
session.hlsDir = path.join(work, `${session.id}.hls`);
fs.mkdirSync(session.hlsDir, { recursive: true });

const token = signMediaToken(session.id);
const badToken = '0.invalid';

const app = express();
app.use('/tmedia', tmedia);
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
console.log('tmedia listening on', base);

const results = [];

{
  const r = await fetchHttp(base, `/tmedia/${session.id}/index.m3u8?t=${badToken}`);
  assert(r.status === 403, 'bad token → 403 on playlist');
  results.push('token reject playlist');
}

{
  const r = await fetchHttp(base, `/tmedia/${session.id}/index.m3u8?t=${encodeURIComponent(token)}`);
  assert(r.status === 404, 'playlist not ready → 404');
  results.push('playlist not ready 404');
}

{
  const r = await fetchHttp(base, `/tmedia/${session.id}/seg00005.ts?t=${encodeURIComponent(token)}`);
  assert(r.status === 404, 'future segment → 404');
  results.push('future segment 404');
}

{
  const r = await fetchHttp(
    base,
    `/tmedia/${session.id}/${encodeURIComponent('../package.json')}?t=${encodeURIComponent(token)}`
  );
  assert(r.status === 404, 'path traversal → 404');
  results.push('path traversal blocked');
}

let readyCount = 0;
const started = Date.now();
const handle = startLiveHls(session.file, session.hlsDir, {
  maxHeight: 360,
  onReady: () => {
    readyCount += 1;
    console.log('onReady fired at', Date.now() - started, 'ms; count=', readyCount);
  },
  onDone: () => console.log('onDone fired at', Date.now() - started, 'ms'),
  onError: (e) => console.error('HLS error', e),
});
session.hlsStop = handle.stop;
session.hlsChild = handle.child;
assert(session.hlsChild?.pid, 'ffmpeg child started');
const ffmpegPid = session.hlsChild.pid;
console.log('ffmpeg pid', ffmpegPid);

let playlistText = '';
let playlistHeaders = null;
for (let i = 0; i < 100; i++) {
  const r = await fetchHttp(base, `/tmedia/${session.id}/index.m3u8?t=${encodeURIComponent(token)}`);
  if (r.status === 200) {
    playlistText = r.text;
    playlistHeaders = r.headers;
    break;
  }
  await sleep(250);
}
assert(playlistText, 'got playlist over HTTP');
const ct = playlistHeaders['content-type'] || '';
assert(ct.includes('application/vnd.apple.mpegurl') || ct.includes('mpegurl'), `playlist Content-Type (${ct})`);
assert((playlistHeaders['cache-control'] || '').includes('no-store'), 'playlist Cache-Control: no-store');
assert(playlistText.includes('#EXTM3U'), 'playlist body is M3U');
assert(playlistText.includes('#EXT-X-PLAYLIST-TYPE:EVENT'), 'EVENT playlist');
assert(playlistText.includes('?t='), 'playlist rewrite keeps media token on segments');
results.push('playlist headers + EVENT + token rewrite');

const listed = playlistText
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split('?')[0]);
assert(listed.length >= 1, 'playlist lists >=1 segment');
console.log('listed segments (first fetch):', listed);

async function waitSeg(name, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetchHttp(base, `/tmedia/${session.id}/${name}?t=${encodeURIComponent(token)}`);
    if (r.status === 200) return r;
    if (r.status !== 404) throw new Error(`${name} unexpected status ${r.status}`);
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${name}`);
}

const seg0 = await waitSeg('seg00000.ts');
assert((seg0.headers['content-type'] || '').includes('mp2t'), `seg0 Content-Type ${seg0.headers['content-type']}`);
assert((seg0.headers['cache-control'] || '').includes('no-store'), 'seg0 Cache-Control: no-store');
assert(seg0.body.length > 1000, 'seg0 payload');
results.push('seg00000.ts HTTP');

const seg1 = await waitSeg('seg00001.ts');
assert((seg1.headers['content-type'] || '').includes('mp2t'), 'seg1 Content-Type');
assert(seg1.body.length > 1000, 'seg1 payload');
results.push('seg00001.ts HTTP');

const existing = fs.readdirSync(session.hlsDir).filter((f) => f.endsWith('.ts')).sort();
const lastNum = existing.length
  ? Math.max(...existing.map((f) => Number((/seg(\d+)\.ts/.exec(f) || [])[1] || 0)))
  : 0;
const futureName = `seg${String(lastNum + 3).padStart(5, '0')}.ts`;
{
  const early = await fetchHttp(base, `/tmedia/${session.id}/${futureName}?t=${encodeURIComponent(token)}`);
  assert(early.status === 404, `${futureName} not generated yet → 404`);
  results.push(`early ${futureName} 404`);
  const later = await waitSeg(futureName, 120000);
  assert(later.status === 200 && later.body.length > 1000, `${futureName} eventually 200`);
  results.push(`later ${futureName} 200`);
}

{
  const alive = session.hlsChild.exitCode == null && !session.hlsChild.killed;
  const r2 = await fetchHttp(base, `/tmedia/${session.id}/index.m3u8?t=${encodeURIComponent(token)}`);
  assert(r2.status === 200, 'growing playlist still readable');
  const listed2 = r2.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  assert(listed2.length >= listed.length, 'playlist did not shrink');
  if (alive) {
    assert(!r2.text.includes('#EXT-X-ENDLIST'), 'no ENDLIST while ffmpeg alive');
    results.push('EVENT playlist readable while appending');
  } else {
    results.push('ffmpeg finished before growth check (ok for short clip)');
  }
  console.log('playlist segments now:', listed2.length, 'ffmpeg alive:', alive);
}

await sleep(800);
assert(readyCount === 1, `onReady once (got ${readyCount})`);
assert(session.hlsChild.pid === ffmpegPid, 'same ffmpeg pid');
results.push('single onReady + single ffmpeg');

{
  const r = await fetchHttp(base, `/tmedia/${session.id}/seg00000.ts?t=${badToken}`);
  assert(r.status === 403, 'bad token on segment → 403');
  results.push('token reject segment');
}

const hlsDirBefore = session.hlsDir;
temp.scrub(session.id);
await sleep(400);
let dead = false;
try {
  process.kill(ffmpegPid, 0);
} catch {
  dead = true;
}
assert(dead, 'ffmpeg killed after scrub');
assert(!fs.existsSync(hlsDirBefore), 'HLS directory deleted after scrub');
{
  const r = await fetchHttp(base, `/tmedia/${session.id}/index.m3u8?t=${encodeURIComponent(token)}`);
  assert(r.status === 404, 'after scrub playlist → 404');
}
results.push('scrub kills ffmpeg + deletes HLS dir');

const session2 = temp.create({
  channelId: 'prove-channel',
  name: 'other-movie.mp4',
  size: 100,
  addedBy: 'prove',
});
assert(session2.id !== session.id, 'new session id');
assert(!session2.hlsChild, 'new session has no old ffmpeg');
temp.scrub(session2.id);
results.push('session switch isolation');

server.close();
fs.rmSync(work, { recursive: true, force: true });

console.log('\n=== LIVE HLS HTTP PROOF ===');
for (const line of results) console.log(' ✓', line);
console.log('OK: PR #6 live HLS HTTP delivery path verified');
