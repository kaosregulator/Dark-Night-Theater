import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseGIF, decompressFrames } from 'gifuct-js';
import {
  IMAGE_TARGET_FFMPEG_TIMEOUT_MS,
  IMAGE_TARGET_HASH_EDGE,
  IMAGE_TARGET_MAX_FRAMES,
  IMAGE_TARGET_VIDEO_SAMPLE_COUNT,
  IMAGE_EXT,
  VIDEO_EXT,
} from './constants.js';
import { extensionOf, looksLikeImage, looksLikeVideo } from './download.js';

const execFileAsync = promisify(execFile);

/**
 * Media sampler (Image Target V2).
 *
 * Static images → 1 frame
 * GIF / APNG    → intelligently sampled frames (first + last + spaced)
 * Video         → FFmpeg multi-timestamp samples (begin / mid / end)
 *
 * Always bounded by IMAGE_TARGET_MAX_FRAMES.
 */

/** Pick evenly spaced indices including first and last. */
export function pickSampleIndices(total, maxSamples) {
  const n = Math.max(0, Math.floor(total));
  if (n <= 0) return [];
  // Short animations: denser coverage so a mid-frame target is not skipped.
  const softCap = Math.max(maxSamples, Math.min(n, Math.ceil(maxSamples * 1.5)));
  const cap = Math.max(1, Math.min(softCap, n));
  if (cap === 1) return [0];
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);

  const out = new Set([0, n - 1]);
  const inner = cap - 2;
  for (let i = 1; i <= inner; i++) {
    const idx = Math.round((i * (n - 1)) / (cap - 1));
    out.add(Math.min(n - 1, Math.max(0, idx)));
  }
  // If collisions shrunk the set, fill gaps.
  let probe = 1;
  while (out.size < cap && probe < n - 1) {
    out.add(probe);
    probe += 1;
  }
  return [...out].sort((a, b) => a - b);
}

/** Evenly spaced timestamps across [0, duration), always covering ends. */
export function pickSampleTimestamps(durationSec, maxSamples) {
  const dur = Math.max(0, Number(durationSec) || 0);
  const cap = Math.max(1, maxSamples);
  if (dur <= 0) return [0];
  if (cap === 1) return [0];

  // Stay slightly inside the end to avoid EOF decode failures.
  const end = Math.max(0, dur * 0.98);
  if (cap === 2) return [0, end];

  const out = [];
  for (let i = 0; i < cap; i++) {
    out.push((i / (cap - 1)) * end);
  }
  return out;
}

function sampleBudget(kind) {
  if (kind === 'video') {
    return Math.min(IMAGE_TARGET_MAX_FRAMES, IMAGE_TARGET_VIDEO_SAMPLE_COUNT);
  }
  return IMAGE_TARGET_MAX_FRAMES;
}

async function frameToJpeg(rawOrBuffer, { width, height } = {}) {
  let pipeline;
  if (Buffer.isBuffer(rawOrBuffer) && width && height) {
    pipeline = sharp(rawOrBuffer, {
      raw: { width, height, channels: 4 },
      failOn: 'none',
    });
  } else {
    pipeline = sharp(rawOrBuffer, { animated: false, failOn: 'none' });
  }
  return pipeline
    .rotate()
    .resize({
      width: IMAGE_TARGET_HASH_EDGE,
      height: IMAGE_TARGET_HASH_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

/**
 * Sample GIF frames via gifuct-js (full decode, then pick indices).
 */
export async function sampleGifFrames(buffer, { maxFrames = IMAGE_TARGET_MAX_FRAMES } = {}) {
  let parsed;
  try {
    parsed = parseGIF(buffer);
  } catch {
    return null;
  }
  const frames = decompressFrames(parsed, true);
  if (!frames?.length) return null;

  const indices = pickSampleIndices(frames.length, maxFrames);
  const out = [];
  const fullW = parsed.lsd?.width || frames[0].dims?.width;
  const fullH = parsed.lsd?.height || frames[0].dims?.height;
  if (!fullW || !fullH) return null;

  // Compose onto a canvas so disposal/offsets are respected enough for hashing.
  const canvas = Buffer.alloc(fullW * fullH * 4, 0);
  let frameCursor = 0;
  const wanted = new Set(indices);

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const { width: fw, height: fh, left, top } = f.dims;
    const patch = f.patch; // RGBA
    if (f.disposalType === 2) {
      // Clear previous frame area — approximate by clearing whole canvas mid-stream is heavy;
      // only clear the patch rect.
      for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
          const cx = left + x;
          const cy = top + y;
          if (cx < 0 || cy < 0 || cx >= fullW || cy >= fullH) continue;
          const ci = (cy * fullW + cx) * 4;
          canvas[ci] = 0;
          canvas[ci + 1] = 0;
          canvas[ci + 2] = 0;
          canvas[ci + 3] = 0;
        }
      }
    }
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const cx = left + x;
        const cy = top + y;
        if (cx < 0 || cy < 0 || cx >= fullW || cy >= fullH) continue;
        const pi = (y * fw + x) * 4;
        const a = patch[pi + 3];
        if (a === 0) continue;
        const ci = (cy * fullW + cx) * 4;
        canvas[ci] = patch[pi];
        canvas[ci + 1] = patch[pi + 1];
        canvas[ci + 2] = patch[pi + 2];
        canvas[ci + 3] = a;
      }
    }

    if (wanted.has(i)) {
      const jpeg = await frameToJpeg(Buffer.from(canvas), {
        width: fullW,
        height: fullH,
      });
      const delayCs = f.delay || 10; // gifuct delay in ms already? gifuct uses ms
      out.push({
        buffer: jpeg,
        frameIndex: i,
        timestampSec: frameCursor / 1000,
        kind: 'gif',
      });
    }
    frameCursor += typeof f.delay === 'number' ? f.delay : 10;
  }

  return out.length ? out : null;
}

/**
 * Sample animated WebP / APNG via sharp multi-page.
 */
export async function sampleSharpAnimated(buffer, { maxFrames = IMAGE_TARGET_MAX_FRAMES } = {}) {
  const meta = await sharp(buffer, { animated: true, failOn: 'none' }).metadata();
  const pages = meta.pages || 1;
  if (pages <= 1) {
    const jpeg = await frameToJpeg(buffer);
    return [
      {
        buffer: jpeg,
        frameIndex: 0,
        timestampSec: 0,
        kind: meta.format === 'gif' ? 'gif' : 'image',
      },
    ];
  }

  const indices = pickSampleIndices(pages, maxFrames);
  const delays = Array.isArray(meta.delay) ? meta.delay : [];
  const out = [];
  for (const idx of indices) {
    const jpeg = await sharp(buffer, { animated: true, page: idx, failOn: 'none' })
      .rotate()
      .resize({
        width: IMAGE_TARGET_HASH_EDGE,
        height: IMAGE_TARGET_HASH_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();

    let ts = 0;
    for (let i = 0; i < idx; i++) ts += delays[i] || 0;
    out.push({
      buffer: jpeg,
      frameIndex: idx,
      timestampSec: ts / 1000,
      kind: meta.format === 'gif' ? 'gif' : meta.format === 'png' ? 'apng' : 'animated',
    });
  }
  return out;
}

async function probeVideoDuration(inFile) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        inFile,
      ],
      { timeout: Math.min(IMAGE_TARGET_FFMPEG_TIMEOUT_MS, 8_000) },
    );
    const d = Number.parseFloat(String(stdout).trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

/**
 * Extract multiple JPEG frames from a video buffer via FFmpeg.
 */
export async function sampleVideoFrames(videoBuffer, {
  maxFrames = sampleBudget('video'),
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'img-target-v-'));
  const inFile = path.join(dir, 'in.bin');
  try {
    await writeFile(inFile, videoBuffer);
    const duration = await probeVideoDuration(inFile);
    const timestamps = duration
      ? pickSampleTimestamps(duration, maxFrames)
      : pickSampleTimestamps(Math.max(1, maxFrames * 0.4), maxFrames);

    const out = [];
    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i];
      const outFile = path.join(dir, `frame-${i}.jpg`);
      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-hide_banner', '-loglevel', 'error',
            '-y',
            '-ss', String(Math.max(0, t)),
            '-i', inFile,
            '-frames:v', '1',
            '-q:v', '3',
            outFile,
          ],
          { timeout: IMAGE_TARGET_FFMPEG_TIMEOUT_MS },
        );
        const buf = await readFile(outFile);
        out.push({
          buffer: buf,
          frameIndex: i,
          timestampSec: t,
          kind: 'video',
        });
      } catch {
        // Skip undecodable timestamps; continue others.
      }
    }

    // Fallback: single first-frame extract if seeking failed entirely.
    if (!out.length) {
      const outFile = path.join(dir, 'frame-fallback.jpg');
      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-hide_banner', '-loglevel', 'error',
            '-y',
            '-i', inFile,
            '-frames:v', '1',
            '-q:v', '3',
            outFile,
          ],
          { timeout: IMAGE_TARGET_FFMPEG_TIMEOUT_MS },
        );
        const buf = await readFile(outFile);
        out.push({
          buffer: buf,
          frameIndex: 0,
          timestampSec: 0,
          kind: 'video',
        });
      } catch {
        return null;
      }
    }

    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Sample media into an array of frame descriptors.
 * @returns {Promise<{ frames: Array, mediaKind: string }>}
 */
export async function sampleMediaFrames(buffer, meta = {}) {
  const isVideo = looksLikeVideo(meta) || meta.forceVideo;
  if (isVideo) {
    const frames = await sampleVideoFrames(buffer);
    if (!frames?.length) throw new Error('video_frame_failed');
    return { frames, mediaKind: 'video' };
  }

  const ext = extensionOf(meta.filename || meta.url || '');
  const ct = (meta.contentType || '').toLowerCase();
  const maybeGif =
    ext === 'gif' || ct === 'image/gif' || ct === 'image/apng' || ext === 'apng';

  if (maybeGif || ct.includes('webp')) {
    // Prefer gifuct for classic GIFs (reliable multi-frame).
    if (ext === 'gif' || ct === 'image/gif') {
      const gifFrames = await sampleGifFrames(buffer);
      if (gifFrames?.length) {
        return { frames: gifFrames, mediaKind: 'gif' };
      }
    }
    try {
      const animated = await sampleSharpAnimated(buffer);
      if (animated?.length) {
        const kind =
          animated[0].kind === 'image' && maybeGif
            ? ext === 'apng' || ct === 'image/apng'
              ? 'apng'
              : 'gif'
            : animated[0].kind === 'image'
              ? 'image'
              : animated[0].kind;
        return { frames: animated, mediaKind: kind };
      }
    } catch {
      // Fall through to static.
    }
  }

  // Static image (or undecoded animation → first frame via sharp).
  const jpeg = await frameToJpeg(buffer);
  const kind =
    looksLikeImage(meta) && (ext === 'gif' || ct === 'image/gif')
      ? 'gif'
      : 'image';
  return {
    frames: [{ buffer: jpeg, frameIndex: 0, timestampSec: 0, kind }],
    mediaKind: kind,
  };
}

// Re-export helpers used by tests without pulling download cycles awkwardly.
export { IMAGE_EXT, VIDEO_EXT };
