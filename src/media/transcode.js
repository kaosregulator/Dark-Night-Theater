import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';

// Convert Discord-hostile uploads (HEVC / AC-3 / odd sizes) into a progressive
// H.264 + AAC MP4 that Activity Chromium can actually paint. Uses the system
// ffmpeg (installed via nixpacks). Runs in the background; callers swap the
// playback URL when the output is ready.

function run(bin, args, timeoutMs = 0) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ ok: false, err: 'timeout' });
      }, timeoutMs);
    }
    child.stderr.on('data', (d) => {
      err += d;
      if (err.length > 8000) err = err.slice(-4000);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0, err, code });
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, err: e.message });
    });
  });
}

/**
 * Transcode to a Discord-safe progressive MP4 (H.264 + AAC, even dimensions).
 * Returns { ok, outPath } — outPath is written next to the source.
 */
export async function transcodeToWebMp4(filePath, { maxHeight = 1080 } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: 'missing' };
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const outPath = path.join(dir, `${base}.web.mp4`);
  // ultrafast + CRF 23 keeps Railway CPU time tolerable for multi‑GB rips.
  const args = [
    '-y',
    '-i',
    filePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-profile:v',
    'main',
    '-level',
    '4.0',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    `scale=-2:'min(${maxHeight},ih)',scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    outPath,
  ];
  log.info(`transcode start → ${path.basename(outPath)}`);
  // No hard timeout — long movies need time; caller should surface progress.
  const res = await run('ffmpeg', args, 0);
  if (!res.ok || !fs.existsSync(outPath) || fs.statSync(outPath).size < 1000) {
    try {
      fs.rmSync(outPath, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, reason: res.err?.slice(-300) || 'ffmpeg failed' };
  }
  log.info(`transcode done → ${path.basename(outPath)} (${(fs.statSync(outPath).size / 1048576).toFixed(0)} MB)`);
  return { ok: true, outPath };
}

/**
 * Also emit a short HLS ladder (single 720p rendition) for more reliable
 * playback through Discord's Activity proxy (range MP4s are flaky there).
 */
export async function transcodeToHls(filePath, outDir, { maxHeight = 720 } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: 'missing' };
  fs.mkdirSync(outDir, { recursive: true });
  const playlist = path.join(outDir, 'index.m3u8');
  const args = [
    '-y',
    '-i',
    filePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '24',
    '-pix_fmt',
    'yuv420p',
    '-vf',
    `scale=-2:'min(${maxHeight},ih)',scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    path.join(outDir, 'seg%05d.ts'),
    playlist,
  ];
  log.info(`hls transcode start → ${outDir}`);
  const res = await run('ffmpeg', args, 0);
  if (!res.ok || !fs.existsSync(playlist)) {
    return { ok: false, reason: res.err?.slice(-300) || 'hls ffmpeg failed' };
  }
  log.info(`hls transcode done → ${playlist}`);
  return { ok: true, playlist };
}

/**
 * Start an EVENT-playlist HLS encode and call onReady as soon as the first
 * segments exist — so Discord Activities can start watching a full movie
 * without waiting for the entire file to finish converting.
 *
 * Returns { child, playlist, stop } immediately.
 */
export function startLiveHls(
  filePath,
  outDir,
  { maxHeight = 720, onReady, onDone, onError } = {}
) {
  if (!filePath || !fs.existsSync(filePath)) {
    onError?.(new Error('missing source'));
    return { child: null, playlist: null, stop: () => {} };
  }
  fs.mkdirSync(outDir, { recursive: true });
  const playlist = path.join(outDir, 'index.m3u8');
  const args = [
    '-y',
    '-i',
    filePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'zerolatency',
    '-crf',
    '23',
    '-profile:v',
    'main',
    '-level',
    '4.0',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '48',
    '-keyint_min',
    '48',
    '-sc_threshold',
    '0',
    '-vf',
    `scale=-2:'min(${maxHeight},ih)',scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '0',
    '-hls_playlist_type',
    'event',
    '-hls_flags',
    'independent_segments+append_list+temp_file',
    '-hls_segment_filename',
    path.join(outDir, 'seg%05d.ts'),
    playlist,
  ];
  log.info(`live HLS start → ${outDir}`);
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  let ready = false;
  child.stderr.on('data', (d) => {
    err += d;
    if (err.length > 8000) err = err.slice(-4000);
  });
  const poll = setInterval(() => {
    if (ready) return;
    try {
      if (!fs.existsSync(playlist)) return;
      const segs = fs.readdirSync(outDir).filter((f) => f.endsWith('.ts'));
      // Wait for a couple segments so hls.js has something to buffer.
      if (segs.length >= 2) {
        ready = true;
        clearInterval(poll);
        log.info(`live HLS ready → ${segs.length} segments`);
        onReady?.({ playlist, segments: segs.length });
      }
    } catch {
      /* ignore poll races */
    }
  }, 400);
  const stop = () => {
    clearInterval(poll);
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };
  child.on('close', (code) => {
    clearInterval(poll);
    if (code === 0) {
      if (!ready) {
        ready = true;
        let n = 0;
        try {
          n = fs.readdirSync(outDir).filter((f) => f.endsWith('.ts')).length;
        } catch {
          /* ignore */
        }
        onReady?.({ playlist, segments: n });
      }
      log.info(`live HLS done → ${playlist}`);
      onDone?.({ playlist });
    } else {
      const reason = err.slice(-300) || `ffmpeg exit ${code}`;
      log.warn(`live HLS failed — ${reason}`);
      onError?.(new Error(reason));
    }
  });
  child.on('error', (e) => {
    clearInterval(poll);
    onError?.(e);
  });
  return { child, playlist, stop };
}

