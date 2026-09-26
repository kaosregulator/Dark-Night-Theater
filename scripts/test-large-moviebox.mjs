/**
 * Proves large / MovieBox host uploads play like short clips:
 *  1) Size alone is NOT suspect (900MB H.264 plays like 30min)
 *  2) Name hints (MovieBox/HEVC) still flag silent background convert
 *  3) create() never holds — always webPlayable, no codecTip UI
 *  4) Chunked uploads only finish when declared size is complete
 *  5) HEVC → live HLS can still build when probe needs it
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

console.log('1) suspect heuristics (name only — not size)');
assert(looksLikeNeedsConvert('The Bay - MovieBoxPro.mp4', 50e6), 'MovieBoxPro name is suspect');
assert(looksLikeNeedsConvert('film.hevc.mp4', 10e6), 'hevc name is suspect');
assert(!looksLikeNeedsConvert('big-movie.mp4', LARGE_HOLD_BYTES), 'size alone is NOT suspect');
assert(!looksLikeNeedsConvert('toy story.mp4', 908e6), '908MB toy story NOT suspect by size');
assert(!looksLikeNeedsConvert('youtube-clip-30min.mp4', 80e6), 'small YouTube convert is NOT suspect');
assert(suspectReason('MovieBoxPro rip.mp4', 1e9), 'reason for MovieBox');
assert(!/hold/i.test(String(suspectReason('MovieBoxPro rip.mp4', 1e9) || '')), 'reason must not say hold');
console.log('   ok');

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
process.env.MEDIA_DIR = work;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'prove-moviebox-secret';

const temp = await import('../src/media/temp.js');
const { probeFile } = await import('../src/media/probe.js');
const { startLiveHls } = await import('../src/media/transcode.js');

console.log('2) create() plays large files immediately with no tips');
const big = temp.create({
  channelId: 'ch-big',
  name: 'toy-story.mp4',
  size: 908_000_000,
  addedBy: 'host',
});
assert(big.converting === false, 'large session must NOT start converting');
assert(big.webPlayable === true, 'large must be webPlayable');
assert(big.suspectConvert === false, 'size-only not suspect');
assert(big.codecTip == null, 'no codec tip for UI');

const mb = temp.create({
  channelId: 'ch-moviebox',
  name: 'The Bay - MovieBoxPro.mp4',
  size: 2_500_000_000,
  addedBy: 'host',
});
assert(mb.converting === false, 'MovieBox session must NOT start held/converting');
assert(mb.webPlayable === true, 'MovieBox must be webPlayable for immediate play');
assert(mb.suspectConvert === true, 'suspectConvert set for silent convert later');
assert(mb.codecTip == null, 'no codec tip surfaced');

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
  name: 'clip.mp4',
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

temp.scrub(big.id);
temp.scrub(mb.id);
temp.scrub(yt.id);
temp.scrub(chunked.id);
fs.rmSync(work, { recursive: true, force: true });
console.log('\nALL PASSED — large files play like short clips; no hold UI.');
