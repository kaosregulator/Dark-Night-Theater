/**
 * Proves the MovieBox / large-file black-screen fixes:
 *  1) Suspect heuristics hold playback for MovieBox/large names
 *  2) Small YouTube converts stay progressive (play-while-upload)
 *  3) Chunked uploads only finish (probe/HLS) when declared size is complete
 *  4) HEVC probe → live HLS unlocks Discord-safe playback
 *
 * Run: node scripts/test-large-moviebox.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { looksLikeNeedsConvert, suspectReason, LARGE_HOLD_BYTES } from '../src/media/suspect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const work = path.join(root, '.prove-moviebox');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('1) suspect heuristics');
assert(looksLikeNeedsConvert('The Bay - MovieBoxPro.mp4', 50e6), 'MovieBoxPro name is suspect');
assert(looksLikeNeedsConvert('film.hevc.mp4', 10e6), 'hevc name is suspect');
assert(looksLikeNeedsConvert('big-movie.mp4', LARGE_HOLD_BYTES), '>=700MB is suspect');
assert(!looksLikeNeedsConvert('youtube-clip-30min.mp4', 80e6), 'small YouTube convert is NOT suspect');
assert(suspectReason('MovieBoxPro rip.mp4', 1e9), 'reason for MovieBox');
console.log('   ok');

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
process.env.MEDIA_DIR = work;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'prove-moviebox-secret';

const temp = await import('../src/media/temp.js');
const { probeFile } = await import('../src/media/probe.js');
const { startLiveHls } = await import('../src/media/transcode.js');

console.log('2) create() holds MovieBox / large, leaves YouTube progressive');
const mb = temp.create({
  channelId: 'ch-moviebox',
  name: 'The Bay - MovieBoxPro.mp4',
  size: 2_500_000_000,
  addedBy: 'host',
});
assert(mb.converting === true, 'MovieBox session starts converting');
assert(mb.webPlayable === false, 'MovieBox not webPlayable yet');
assert(mb.suspectConvert === true, 'suspectConvert set');
assert(mb.codecTip, 'codec tip present');

const yt = temp.create({
  channelId: 'ch-youtube',
  name: 'my-youtube-convert.mp4',
  size: 90_000_000,
  addedBy: 'host',
});
assert(yt.converting === false, 'YouTube convert not held');
assert(yt.webPlayable === true, 'YouTube progressive allowed');
assert(yt.suspectConvert === false, 'YouTube not suspect');
console.log('   ok');

console.log('3) chunked upload finish gate');
const chunked = temp.create({
  channelId: 'ch-chunk',
  name: 'MovieBoxPro-chunk.mp4',
  size: 24,
  addedBy: 'host',
});
fs.writeFileSync(chunked.file, Buffer.alloc(0));
for (const n of [8, 8, 8]) {
  fs.appendFileSync(chunked.file, Buffer.alloc(n));
  temp.advance(chunked, n);
  const done = chunked.total > 0 ? chunked.receivedBytes >= chunked.total : true;
  if (!done) {
    assert(chunked.complete === false, 'must not be complete mid-upload');
    assert(!chunked.prepareStarted, 'must not prepare mid-upload');
  } else {
    temp.finish(chunked);
  }
}
assert(chunked.complete === true, 'complete after full size');
assert(chunked.receivedBytes === 24, 'all bytes counted');
await sleep(50);
console.log('   ok');

console.log('4) HEVC → live HLS ready');
const hevc = path.join(work, 'sample-hevc.mp4');
await new Promise((resolve, reject) => {
  const child = spawn(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=640x360:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100',
      '-t',
      '6',
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
      hevc,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-400) || 'hevc encode failed'))));
});
const info = await probeFile(hevc, { failClosed: true });
assert(info.ok, 'probe ok');
assert(info.webPlayable === false, 'HEVC not webPlayable');
assert(/hevc|h265/.test(String(info.videoCodec || '')), `video codec is hevc (got ${info.videoCodec})`);

const hlsDir = path.join(work, 'hls-out');
fs.mkdirSync(hlsDir, { recursive: true });
const handle = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('HLS ready timeout')), 90000);
  const h = startLiveHls(hevc, hlsDir, {
    maxHeight: 360,
    onReady: () => {
      clearTimeout(t);
      resolve(h);
    },
    onError: (e) => {
      clearTimeout(t);
      reject(e);
    },
  });
});
assert(fs.existsSync(path.join(hlsDir, 'index.m3u8')), 'playlist exists');
const segs = fs.readdirSync(hlsDir).filter((f) => f.endsWith('.ts'));
assert(segs.length >= 1, 'at least one segment');
handle.stop?.();
console.log('   ok —', segs.length, 'segments');

temp.scrub(mb.id);
temp.scrub(yt.id);
temp.scrub(chunked.id);
fs.rmSync(work, { recursive: true, force: true });
console.log('\nALL PASSED — MovieBox/large-file black-screen fixes look good.');
