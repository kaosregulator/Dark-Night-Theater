import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';

// Probe / lightly remux uploaded movies so Discord's Activity Chromium can
// actually paint frames. MovieBox / rip MP4s often look fine as ".mp4" but use
// H.265 (HEVC), AC-3 audio, or a trailing moov atom — all of which show up as a
// silent black screen in the Theater.

const WEB_VIDEO = new Set(['h264', 'avc1', 'vp8', 'vp9', 'av1']);
const WEB_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

function run(bin, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, out, err: err || 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, err, code });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out, err: e.message });
    });
  });
}

export async function probeFile(filePath, opts = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, webPlayable: false, reason: 'File missing' };
  }
  const args = [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    filePath,
  ];
  const res = await run('ffprobe', args, 25000);
  if (!res.ok) {
    // Fail closed for host MovieBox/large flows (opts.failClosed) — otherwise a
    // probe timeout would skip convert and leave Discord on a black HEVC MP4.
    const failClosed = Boolean(opts?.failClosed);
    return {
      ok: false,
      webPlayable: !failClosed,
      reason: res.err?.includes('ENOENT') ? 'ffprobe not installed' : 'Could not probe file',
      raw: res.err?.slice(0, 200),
    };
  }
  let data;
  try {
    data = JSON.parse(res.out || '{}');
  } catch {
    const failClosed = Boolean(opts?.failClosed);
    return { ok: false, webPlayable: !failClosed, reason: 'Bad ffprobe output' };
  }
  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const vCodec = String(video?.codec_name || '').toLowerCase();
  const aCodec = String(audio?.codec_name || '').toLowerCase();
  const width = Number(video?.width) || 0;
  const height = Number(video?.height) || 0;
  const oddSize = Boolean(width && height && (width % 2 || height % 2));
  const videoOk = !vCodec || WEB_VIDEO.has(vCodec);
  const audioOk = !aCodec || WEB_AUDIO.has(aCodec);
  const webPlayable = videoOk && audioOk;

  const reasons = [];
  if (!videoOk) reasons.push(`video codec ${vCodec || 'unknown'} (Discord needs H.264 / VP9 / AV1)`);
  if (!audioOk) reasons.push(`audio codec ${aCodec || 'unknown'} (use AAC / Opus)`);
  if (oddSize) reasons.push(`odd resolution ${width}×${height} (some GPUs fail — prefer even sizes like 1920×1080)`);

  return {
    ok: true,
    webPlayable,
    videoCodec: vCodec || null,
    audioCodec: aCodec || null,
    width,
    height,
    duration: Number(data.format?.duration) || 0,
    oddSize,
    reason: reasons.join('; ') || null,
  };
}

// Remux in place with +faststart (moov at front). Copy streams — no re-encode.
// Helps progressive /tmedia playback when the uploader's MP4 had moov at the end.
export async function faststartRemux(filePath, { timeoutMs = 120000, maxBytes = 0 } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: 'missing' };
  try {
    const size = fs.statSync(filePath).size;
    // Full-file copy remux on multi‑GB MovieBox rips often hits the timeout and
    // burns ephemeral disk — callers that already know they need HLS should skip.
    if (maxBytes > 0 && size > maxBytes) {
      return { ok: false, reason: `file too large for faststart (${(size / 1048576).toFixed(0)} MB)` };
    }
  } catch {
    /* continue */
  }
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.faststart-${path.basename(filePath)}`);
  const args = [
    '-y',
    '-i',
    filePath,
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    tmp,
  ];
  const res = await run('ffmpeg', args, timeoutMs);
  if (!res.ok || !fs.existsSync(tmp)) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, reason: res.err?.slice(0, 240) || 'ffmpeg failed' };
  }
  try {
    fs.renameSync(tmp, filePath);
    return { ok: true };
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, reason: err.message };
  }
}

// Soft tip shown in the Activity / host page when a file won't decode.
export function codecTip(info) {
  // Conversion-first: never tell the user to manually re-encode.
  // Probe stays available for diagnostics / ffmpeg parameter choice only.
  if (!info) return null;
  if (info.webPlayable && !info.oddSize) return null;
  return 'Preparing a Discord-safe stream… playback starts after the first segments.';
}

export function logProbe(label, info) {
  if (!info) return;
  log.info(
    `probe ${label}: video=${info.videoCodec || '?'} audio=${info.audioCodec || '?'} ${info.width || 0}x${info.height || 0} web=${info.webPlayable}`
  );
}
