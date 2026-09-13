/**
 * Hybrid playback checks:
 *  1) Normal H.264 titles (e.g. Ed Edd n Eddy) → progressive play-while-upload
 *  2) MovieBox/large titles → hold progressive, live HLS after upload
 *  3) Never refuse before trying conversion on suspects
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

console.log('1) Ed Edd n Eddy–style title → progressive (no convert hold)');
const eddy = temp.create({
  channelId: 'ch-eddy',
  name: 'Ed Edd n Eddy S01E01.mp4',
  size: 99_000_000,
  addedBy: 'host',
});
assert(eddy.converting === false, 'Eddy must NOT start converting');
assert(eddy.webPlayable === true, 'Eddy must be progressive-playable during upload');
assert(!eddy.codecTip, 'Eddy must not show converting tip');
console.log('   ok');
temp.scrub(eddy.id);

console.log('2) MovieBox / large title → hold + convert path');
const mb = temp.create({
  channelId: 'ch-moviebox',
  name: 'The Bay - MovieBoxPro.mp4',
  size: 2_500_000_000,
  addedBy: 'host',
});
assert(mb.converting === true, 'MovieBox starts converting');
assert(mb.webPlayable === false, 'MovieBox held until HLS');
console.log('   ok');
temp.scrub(mb.id);

console.log('3) Safe H.264 finish stays progressive (no forced HLS)');
function makeH264(dest, seconds = 2) {
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
        String(seconds),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
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

const sess = temp.create({
  channelId: 'ch-safe',
  name: 'cartoon-episode.mp4',
  size: 1,
  addedBy: 'host',
});
await makeH264(sess.file, 2);
const size = fs.statSync(sess.file).size;
temp.advance(sess, size);
temp.finish(sess);
for (let i = 0; i < 40; i++) {
  await sleep(100);
  if (sess.prepareStarted && sess.converting === false) break;
}
assert(sess.webPlayable === true, 'safe finish stays webPlayable');
assert(sess.kind === 'file', `safe finish stays progressive file (got ${sess.kind})`);
assert(sess.converting === false, 'safe finish not converting');
console.log('   ok');
temp.scrub(sess.id);

console.log('4) HEVC / MovieBox-named finish → live HLS playable');
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
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-400) || 'hevc failed'))));
});

const bad = temp.create({
  channelId: 'ch-hevc',
  name: 'MovieBoxPro-rip.mp4',
  size: fs.statSync(hevc).size,
  addedBy: 'host',
});
fs.copyFileSync(hevc, bad.file);
temp.advance(bad, fs.statSync(bad.file).size);
temp.finish(bad);

let ready = false;
for (let i = 0; i < 120 && !ready; i++) {
  await sleep(500);
  if (bad.hlsReady || bad.kind === 'hls' || (bad.webPlayable && !bad.converting)) ready = true;
}
assert(ready, 'MovieBox/HEVC became playable via HLS');
assert(bad.kind === 'hls', 'kind is hls');
assert(!/HandBrake|re-export/i.test(String(bad.codecTip || '')), 'no manual tip');
cleanupConversion(bad.id);
temp.scrub(bad.id);
console.log('   ok');

console.log('5) conversion manager still coalesces + prioritizes');
assert(conversionManager.concurrency === 2, `worker env honored (got ${conversionManager.concurrency})`);
const a = enqueueLiveHls({
  id: 'dup',
  filePath: hevc,
  outDir: path.join(work, 'dup.hls'),
  priority: PRIORITY.LIBRARY,
  maxHeight: 240,
});
const b = enqueueLiveHls({
  id: 'dup',
  filePath: hevc,
  outDir: path.join(work, 'dup.hls'),
  priority: PRIORITY.ACTIVE_PARTY,
  maxHeight: 240,
});
assert(a === b, 'duplicate coalesced');
cleanupConversion('dup');
console.log('   ok');

fs.rmSync(work, { recursive: true, force: true });
console.log('\nALL PASSED — progressive for safe files; live HLS for MovieBox/large.');
