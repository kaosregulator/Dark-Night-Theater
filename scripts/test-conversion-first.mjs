/**
 * Conversion-first media pipeline checks:
 *  1) Every temp session converts (H.264 and MovieBox/HEVC names alike)
 *  2) Conversion manager queues + coalesces duplicates + respects priority
 *  3) Live HLS unlocks playable before encode finishes
 *  4) Failure messaging has no manual HandBrake / HEVC scare tips
 *
 * Run: node scripts/test-conversion-first.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const work = path.join(root, '.prove-conversion-first');

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
process.env.MEDIA_DIR = work;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'prove-conversion-secret';
process.env.MEDIA_CONVERSION_WORKERS = '2';

const temp = await import('../src/media/temp.js');
const { enqueueLiveHls, conversionManager, PRIORITY, cleanupConversion } = await import(
  '../src/media/conversion-manager.js'
);
const { codecTip } = await import('../src/media/probe.js');
const { suspectReason } = await import('../src/media/suspect.js');

console.log('1) every create() enters conversion (H.264 name AND MovieBox/HEVC name)');
const safe = temp.create({
  channelId: 'ch-safe',
  name: 'my-youtube-convert.mp4',
  size: 90_000_000,
  addedBy: 'host',
});
const mb = temp.create({
  channelId: 'ch-moviebox',
  name: 'The Bay - MovieBoxPro.mp4',
  size: 2_500_000_000,
  addedBy: 'host',
});
assert(safe.converting === true, 'H.264-named session still converts');
assert(safe.webPlayable === false, 'not playable until HLS');
assert(mb.converting === true, 'MovieBox session converts');
assert(mb.webPlayable === false, 'MovieBox not playable yet');
assert(
  !/HandBrake|re-export|can’t paint HEVC|can't paint HEVC/i.test(String(safe.codecTip || '')),
  'no manual tip on create'
);
assert(
  !/HandBrake|re-export|can’t paint HEVC|can't paint HEVC/i.test(String(mb.codecTip || '')),
  'no HEVC scare tip'
);
assert(
  !/can’t paint HEVC|can't paint HEVC|HandBrake/i.test(String(suspectReason('MovieBoxPro.mp4', 1e9) || '')),
  'suspectReason soft'
);
assert(
  !/HandBrake|Re-export/i.test(
    String(codecTip({ webPlayable: false, videoCodec: 'hevc', oddSize: false }) || '')
  ),
  'codecTip soft'
);
console.log('   ok');
temp.scrub(safe.id);
temp.scrub(mb.id);

console.log('2) conversion manager: queue, duplicate coalesce, priority');
assert(conversionManager.concurrency === 2, `MEDIA_CONVERSION_WORKERS honored (got ${conversionManager.concurrency})`);

function makeLongMp4(dest) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-t',
        '16',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        dest,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-300) || 'encode failed'))));
  });
}

const longA = path.join(work, 'long-a.mp4');
const longB = path.join(work, 'long-b.mp4');
const longC = path.join(work, 'long-c.mp4');
await makeLongMp4(longA);
await makeLongMp4(longB);
await makeLongMp4(longC);

const j1 = enqueueLiveHls({
  id: 'slow-1',
  filePath: longA,
  outDir: path.join(work, 'slow-1.hls'),
  priority: PRIORITY.LIBRARY,
  maxHeight: 240,
});
const j2 = enqueueLiveHls({
  id: 'slow-2',
  filePath: longB,
  outDir: path.join(work, 'slow-2.hls'),
  priority: PRIORITY.LIBRARY,
  maxHeight: 240,
});
const j3 = enqueueLiveHls({
  id: 'slow-3',
  filePath: longC,
  outDir: path.join(work, 'slow-3.hls'),
  priority: PRIORITY.LIBRARY,
  maxHeight: 240,
});
await sleep(40);
assert(['running', 'playable', 'complete'].includes(j1.state), `job1 started (got ${j1.state})`);
assert(['running', 'playable', 'complete'].includes(j2.state), `job2 started (got ${j2.state})`);
assert(j3.state === 'queued', `job3 waiting concurrency 2 (got ${j3.state})`);

const j3b = enqueueLiveHls({
  id: 'slow-3',
  filePath: longC,
  outDir: path.join(work, 'slow-3.hls'),
  priority: PRIORITY.ACTIVE_PARTY,
  maxHeight: 240,
});
assert(j3b === j3, 'duplicate id coalesced while queued');
assert(j3.priority === PRIORITY.ACTIVE_PARTY, 'priority bumped to active party');

for (const id of ['slow-1', 'slow-2', 'slow-3']) cleanupConversion(id);
console.log('   ok');

console.log('3) live HLS: HEVC source becomes playable before encode completes');
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
      '10',
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

const hlsDir = path.join(work, 'live.hls');
let playableAt = 0;
let completeAt = 0;
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('HLS timeout')), 120000);
  enqueueLiveHls({
    id: 'hevc-live',
    filePath: hevc,
    outDir: hlsDir,
    priority: PRIORITY.ACTIVE_PARTY,
    maxHeight: 360,
    onPlayable: ({ segments }) => {
      playableAt = Date.now();
      assert(segments >= 1, 'segments on playable');
      assert(fs.existsSync(path.join(hlsDir, 'index.m3u8')), 'playlist exists at playable');
    },
    onComplete: () => {
      completeAt = Date.now();
      clearTimeout(t);
      resolve();
    },
    onFailed: (e) => {
      clearTimeout(t);
      reject(e);
    },
  });
});
assert(playableAt > 0, 'became playable');
assert(completeAt >= playableAt, 'complete after or at playable');
cleanupConversion('hevc-live');
console.log('   ok — playable unlocked without waiting for full encode gate');

console.log('4) temp finish → always conversion path');
const sess = temp.create({
  channelId: 'ch-finish',
  name: 'plain-h264.mp4',
  size: fs.statSync(hevc).size,
  addedBy: 'host',
});
fs.copyFileSync(hevc, sess.file);
temp.advance(sess, fs.statSync(sess.file).size);
temp.finish(sess);
assert(sess.prepareStarted === true || sess.converting === true, 'prepare/convert started after finish');

let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  await sleep(500);
  if (sess.hlsReady || sess.kind === 'hls' || sess.webPlayable) ready = true;
}
assert(ready, 'temp session became HLS-playable');
assert(sess.kind === 'hls', 'kind is hls');
assert(
  !/HandBrake|re-export|can't paint HEVC|can’t paint HEVC/i.test(String(sess.codecTip || '')),
  'no manual tip'
);
temp.scrub(sess.id);

fs.rmSync(work, { recursive: true, force: true });
console.log('   ok');

console.log('\nALL PASSED — conversion-first pipeline looks good.');
console.log('Regression note: previously a “safe” H.264 file could skip convert while a');
console.log('MovieBox/HEVC upload was held/refused before trying. Now both enter the same');
console.log('live HLS queue, and playback unlocks on first segments.');
