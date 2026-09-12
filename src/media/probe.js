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

export async function probeFile(filePath) {
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
    // ffprobe missing or unreadable file — don't block; warn softly.
    return {
      ok: false,
      webPlayable: true,
      reason: res.err?.includes('ENOENT') ? 'ffprobe not installed' : 'Could not probe file',
      raw: res.err?.slice(0, 200),
    };
  }
  let data;
  try {
    data = JSON.parse(res.out || '{}');
  } catch {
    return { ok: false, webPlayable: true, reason: 'Bad ffprobe output' };
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
export async function faststartRemux(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: 'missing' };
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
  const res = await run('ffmpeg', args, 120000);
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
  if (!info) return null;
  if (info.webPlayable && !info.oddSize) return null;
  const bits = [];
  if (info.videoCodec && !WEB_VIDEO.has(info.videoCodec)) {
    bits.push(`This file’s video is ${info.videoCodec.toUpperCase()}, which Discord’s Activity browser can’t paint (black screen).`);
  }
  if (info.audioCodec && !WEB_AUDIO.has(info.audioCodec)) {
    bits.push(`Audio is ${info.audioCodec.toUpperCase()} — re-encode to AAC.`);
  }
  if (info.oddSize) {
    bits.push(`Resolution ${info.width}×${info.height} isn’t even — some devices show a black frame.`);
  }
  bits.push('Re-export as MP4 H.264 + AAC (even resolution, e.g. 1920×1080). HandBrake “Fast 1080p30” works well.');
  return bits.join(' ');
}

export function logProbe(label, info) {
  if (!info) return;
  log.info(
    `probe ${label}: video=${info.videoCodec || '?'} audio=${info.audioCodec || '?'} ${info.width || 0}x${info.height || 0} web=${info.webPlayable}`
  );
}
