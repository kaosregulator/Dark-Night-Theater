import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseGIF, decompressFrames } from 'gifuct-js';
import {
  IMAGE_TARGET_DEEP_MAX_FRAMES,
  IMAGE_TARGET_FFMPEG_TIMEOUT_MS,
  IMAGE_TARGET_HASH_EDGE,
  IMAGE_TARGET_MAX_FRAMES,
  IMAGE_TARGET_VIDEO_SAMPLE_COUNT,
  IMAGE_EXT,
  VIDEO_EXT,
} from './constants.js';
import { collapseNearDuplicateFrames, pickDeepFrameIndices, pickDeepTimestamps } from './deep-scan.js';
import { computeDHash } from './fingerprints.js';
import {
  extensionOf,
  looksLikeImage,
  looksLikeVideo,
  sniffMediaKind,
} from './download.js';

const execFileAsync = promisify(execFile);

/**
 * Media sampler (Image Target V2 / V2.1).
 *
 * Quick pass: bounded frames/timestamps.
 * Deep pass: denser sampling, skip already-seen frames, collapse near-dupes.
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
  // Always prioritize midpoint when we have room.
  if (cap >= 3) out.add(Math.floor((n - 1) / 2));
  const inner = cap - out.size;
  for (let i = 1; i <= Math.max(0, inner + 2) && out.size < cap; i++) {
    const idx = Math.round((i * (n - 1)) / (cap - 1));
    out.add(Math.min(n - 1, Math.max(0, idx)));
  }
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

  const end = Math.max(0, dur * 0.98);
  if (cap === 2) return [0, end];

  // Short videos: denser default sampling.
  const effectiveCap = dur <= 6 ? Math.min(cap + 2, Math.max(cap, Math.ceil(dur * 2))) : cap;

  const out = [];
  for (let i = 0; i < effectiveCap; i++) {
    out.push((i / (effectiveCap - 1)) * end);
  }
  return out;
}

function sampleBudget(kind, { deep = false } = {}) {
  if (deep) {
    return IMAGE_TARGET_DEEP_MAX_FRAMES;
  }
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

async function attachCheapHash(frame) {
  try {
    frame.cheapHash = await computeDHash(frame.buffer);
  } catch {
    frame.cheapHash = null;
  }
  return frame;
}

/**
 * Compose selected GIF frame indices into JPEG frames.
 */
async function extractGifIndices(buffer, indices) {
  let parsed;
  try {
    parsed = parseGIF(buffer);
  } catch {
    return null;
  }
  const frames = decompressFrames(parsed, true);
  if (!frames?.length) return null;

  const wanted = new Set(indices.filter((i) => i >= 0 && i < frames.length));
  if (!wanted.size) return [];

  const fullW = parsed.lsd?.width || frames[0].dims?.width;
  const fullH = parsed.lsd?.height || frames[0].dims?.height;
  if (!fullW || !fullH) return null;

  const canvas = Buffer.alloc(fullW * fullH * 4, 0);
  let frameCursor = 0;
  const out = [];

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const { width: fw, height: fh, left, top } = f.dims;
    const patch = f.patch;
    if (f.disposalType === 2) {
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
      out.push({
        buffer: jpeg,
        frameIndex: i,
        timestampSec: frameCursor / 1000,
        kind: 'gif',
        totalFrames: frames.length,
      });
    }
    frameCursor += typeof f.delay === 'number' ? f.delay : 10;
  }

  return out;
}

export async function sampleGifFrames(buffer, {
  maxFrames = IMAGE_TARGET_MAX_FRAMES,
  onlyIndices = null,
} = {}) {
  let parsed;
  try {
    parsed = parseGIF(buffer);
  } catch {
    return null;
  }
  const rawFrames = decompressFrames(parsed, true);
  if (!rawFrames?.length) return null;

  const indices = onlyIndices?.length
    ? onlyIndices
    : pickSampleIndices(rawFrames.length, maxFrames);

  const out = await extractGifIndices(buffer, indices);
  if (!out) return null;
  for (const f of out) await attachCheapHash(f);
  return out.length ? out : null;
}

/**
 * Sample animated WebP / APNG via sharp multi-page.
 */
export async function sampleSharpAnimated(buffer, {
  maxFrames = IMAGE_TARGET_MAX_FRAMES,
  onlyIndices = null,
} = {}) {
  const meta = await sharp(buffer, { animated: true, failOn: 'none' }).metadata();
  const pages = meta.pages || 1;
  if (pages <= 1) {
    const jpeg = await frameToJpeg(buffer);
    const frame = {
      buffer: jpeg,
      frameIndex: 0,
      timestampSec: 0,
      kind: meta.format === 'gif' ? 'gif' : 'image',
      totalFrames: 1,
    };
    await attachCheapHash(frame);
    return [frame];
  }

  const indices = onlyIndices?.length
    ? onlyIndices.filter((i) => i >= 0 && i < pages)
    : pickSampleIndices(pages, maxFrames);
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
    const frame = {
      buffer: jpeg,
      frameIndex: idx,
      timestampSec: ts / 1000,
      kind: meta.format === 'gif' ? 'gif' : meta.format === 'png' ? 'apng' : 'animated',
      totalFrames: pages,
    };
    await attachCheapHash(frame);
    out.push(frame);
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

/** Best-effort scene-change timestamps via ffmpeg showinfo (capped). */
async function detectSceneTimestamps(inFile, { maxScenes = 6, duration = null } = {}) {
  try {
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-i', inFile,
        '-vf', "select='gt(scene,0.35)',showinfo",
        '-frames:v', String(maxScenes),
        '-f', 'null',
        '-',
      ],
      { timeout: IMAGE_TARGET_FFMPEG_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 },
    );
    const text = String(stderr || '');
    const times = [];
    const re = /pts_time:([0-9.]+)/g;
    let m;
    while ((m = re.exec(text))) {
      const t = Number.parseFloat(m[1]);
      if (Number.isFinite(t) && t >= 0) times.push(t);
      if (times.length >= maxScenes) break;
    }
    if (duration != null) {
      return times.filter((t) => t < duration * 0.99);
    }
    return times;
  } catch {
    return [];
  }
}

async function extractVideoAtTimestamps(inFile, timestamps) {
  const out = [];
  for (let i = 0; i < timestamps.length; i++) {
    const t = timestamps[i];
    const outFile = path.join(path.dirname(inFile), `frame-${Date.now()}-${i}.jpg`);
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
      const frame = {
        buffer: buf,
        frameIndex: i,
        timestampSec: t,
        kind: 'video',
      };
      await attachCheapHash(frame);
      out.push(frame);
      await rm(outFile, { force: true }).catch(() => {});
    } catch {
      // Skip undecodable timestamps.
    }
  }
  return out;
}

/**
 * Extract multiple JPEG frames from a video buffer via FFmpeg.
 */
export async function sampleVideoFrames(videoBuffer, {
  maxFrames = sampleBudget('video'),
  onlyTimestamps = null,
  includeSceneChanges = false,
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'img-target-v-'));
  const inFile = path.join(dir, 'in.bin');
  try {
    await writeFile(inFile, videoBuffer);
    const duration = await probeVideoDuration(inFile);

    let timestamps;
    if (onlyTimestamps?.length) {
      timestamps = [...onlyTimestamps];
    } else {
      timestamps = duration
        ? pickSampleTimestamps(duration, maxFrames)
        : pickSampleTimestamps(Math.max(1, maxFrames * 0.4), maxFrames);
      if (includeSceneChanges && duration) {
        const scenes = await detectSceneTimestamps(inFile, {
          maxScenes: Math.min(4, maxFrames),
          duration,
        });
        for (const s of scenes) {
          if (!timestamps.some((t) => Math.abs(t - s) < 0.15)) {
            timestamps.push(s);
          }
        }
        timestamps = timestamps.sort((a, b) => a - b).slice(0, maxFrames + 2);
      }
    }

    let out = await extractVideoAtTimestamps(inFile, timestamps);

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
        const frame = {
          buffer: buf,
          frameIndex: 0,
          timestampSec: 0,
          kind: 'video',
        };
        await attachCheapHash(frame);
        out = [frame];
      } catch {
        return null;
      }
    }

    out.durationSec = duration;
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveMeta(buffer, meta = {}) {
  const sniffed = sniffMediaKind(buffer);
  const ext = extensionOf(meta.filename || meta.url || '');
  const ct = (meta.contentType || '').toLowerCase();

  let forceVideo = Boolean(meta.forceVideo) || looksLikeVideo(meta);
  let forceGif =
    ext === 'gif' ||
    ct === 'image/gif' ||
    ct === 'image/apng' ||
    ext === 'apng' ||
    sniffed?.format === 'gif';

  // Magic bytes win over misleading extensions / missing content-type.
  if (sniffed?.kind === 'video') forceVideo = true;
  if (sniffed?.kind === 'gif' || sniffed?.format === 'gif') {
    forceVideo = false;
    forceGif = true;
  }
  if (sniffed?.kind === 'image' && sniffed.format !== 'gif') {
    // Don't treat JPEG/PNG as video just because filename said .mp4 incorrectly
    // unless content-type also says video and sniff failed — sniff image wins.
    if (!looksLikeVideo({ contentType: ct }) || sniffed) {
      forceVideo = false;
    }
  }

  return { sniffed, ext, ct, forceVideo, forceGif };
}

/**
 * Sample media into an array of frame descriptors.
 * @returns {Promise<{ frames: Array, mediaKind: string, durationSec?: number|null, totalFrames?: number|null }>}
 */
export async function sampleMediaFrames(buffer, meta = {}, opts = {}) {
  const {
    deep = false,
    maxFrames = null,
    excludeFrameIndices = [],
    excludeTimestamps = [],
  } = opts;

  const { sniffed, ext, ct, forceVideo, forceGif } = resolveMeta(buffer, meta);
  const budget = maxFrames ?? sampleBudget(forceVideo ? 'video' : 'gif', { deep });

  try {
    if (forceVideo) {
      let frames;
      if (deep && excludeTimestamps.length) {
        // Second pass only: denser timestamps + scene cuts, skip already-seen.
        const dirProbe = await mkdtemp(path.join(tmpdir(), 'img-target-probe-'));
        const probeFile = path.join(dirProbe, 'in.bin');
        let duration = null;
        try {
          await writeFile(probeFile, buffer);
          duration = await probeVideoDuration(probeFile);
          const extraTs = pickDeepTimestamps(
            duration || Math.max(...excludeTimestamps, 1),
            excludeTimestamps,
            budget,
          );
          const sceneTs = duration
            ? await detectSceneTimestamps(probeFile, {
                maxScenes: Math.min(4, budget),
                duration,
              })
            : [];
          const mergedTs = [];
          for (const t of [...extraTs, ...sceneTs]) {
            if (excludeTimestamps.some((e) => Math.abs(e - t) < 0.12)) continue;
            if (mergedTs.some((e) => Math.abs(e - t) < 0.12)) continue;
            mergedTs.push(t);
            if (mergedTs.length >= budget) break;
          }
          frames = await sampleVideoFrames(buffer, {
            onlyTimestamps: mergedTs.length ? mergedTs : extraTs.slice(0, budget),
          });
          if (frames) frames.durationSec = duration;
        } finally {
          await rm(dirProbe, { recursive: true, force: true }).catch(() => {});
        }
      } else {
        frames = await sampleVideoFrames(buffer, {
          maxFrames: budget,
          includeSceneChanges: deep,
        });
      }
      if (!frames?.length) throw new Error('video_frame_failed');

      const before = frames.length;
      const deduped = collapseNearDuplicateFrames(frames);
      return {
        frames: deduped,
        mediaKind: 'video',
        durationSec: frames.durationSec ?? null,
        framesDeduped: Math.max(0, before - deduped.length),
      };
    }

    const maybeAnimated =
      forceGif ||
      ct.includes('webp') ||
      sniffed?.format === 'webp' ||
      sniffed?.format === 'gif' ||
      sniffed?.format === 'png';

    if (maybeAnimated || forceGif) {
      if (forceGif || sniffed?.format === 'gif' || ext === 'gif' || ct === 'image/gif') {
        let total = 0;
        try {
          total = decompressFrames(parseGIF(buffer), false).length || 0;
        } catch {
          total = 0;
        }

        let indices;
        if (deep && excludeFrameIndices.length && total > 0) {
          if (total <= IMAGE_TARGET_DEEP_MAX_FRAMES) {
            const ex = new Set(excludeFrameIndices);
            indices = Array.from({ length: total }, (_, i) => i).filter((i) => !ex.has(i));
          } else {
            indices = pickDeepFrameIndices(total, excludeFrameIndices, budget);
          }
        } else {
          indices = pickSampleIndices(total || budget, budget);
          if (total > 0 && total <= budget) {
            indices = Array.from({ length: total }, (_, i) => i);
          } else if (deep && total > 0 && total <= IMAGE_TARGET_DEEP_MAX_FRAMES) {
            indices = Array.from({ length: total }, (_, i) => i);
          }
          if (excludeFrameIndices.length) {
            const ex = new Set(excludeFrameIndices);
            indices = indices.filter((i) => !ex.has(i));
          }
        }

        const gifFrames = await sampleGifFrames(buffer, { onlyIndices: indices });
        if (gifFrames?.length) {
          const before = gifFrames.length;
          const deduped = collapseNearDuplicateFrames(gifFrames);
          return {
            frames: deduped,
            mediaKind: 'gif',
            totalFrames: gifFrames[0]?.totalFrames ?? total ?? null,
            framesDeduped: Math.max(0, before - deduped.length),
          };
        }
      }

      try {
        const animated = await sampleSharpAnimated(buffer, { maxFrames: budget });
        if (animated?.length) {
          const kind =
            animated[0].kind === 'image' && forceGif
              ? ext === 'apng' || ct === 'image/apng'
                ? 'apng'
                : 'gif'
              : animated[0].kind === 'image'
                ? 'image'
                : animated[0].kind;
          let frames = animated;
          if (excludeFrameIndices.length) {
            const ex = new Set(excludeFrameIndices);
            frames = frames.filter((f) => !ex.has(f.frameIndex));
          }
          const before = frames.length;
          const deduped = collapseNearDuplicateFrames(frames);
          return {
            frames: deduped,
            mediaKind: kind,
            totalFrames: animated[0]?.totalFrames ?? null,
            framesDeduped: Math.max(0, before - deduped.length),
          };
        }
      } catch (err) {
        if (String(err.message || err).includes('unsupported')) {
          throw err;
        }
      }
    }

    // Static image.
    const jpeg = await frameToJpeg(buffer);
    const kind =
      (forceGif || (looksLikeImage(meta) && (ext === 'gif' || ct === 'image/gif')))
        ? 'gif'
        : 'image';
    const frame = { buffer: jpeg, frameIndex: 0, timestampSec: 0, kind };
    await attachCheapHash(frame);
    return {
      frames: [frame],
      mediaKind: kind,
      totalFrames: 1,
      framesDeduped: 0,
    };
  } catch (err) {
    const msg = String(err.message || err);
    if (
      msg.includes('video_frame_failed') ||
      msg.includes('not_an_image') ||
      msg.includes('unsupported')
    ) {
      throw err;
    }
    throw new Error(`media_decode_failed:${msg.slice(0, 120)}`);
  }
}

/**
 * Deep second-pass sampling — additional frames only.
 */
export async function sampleMediaFramesDeep(buffer, meta = {}, {
  excludeFrameIndices = [],
  excludeTimestamps = [],
} = {}) {
  return sampleMediaFrames(buffer, meta, {
    deep: true,
    maxFrames: IMAGE_TARGET_DEEP_MAX_FRAMES,
    excludeFrameIndices,
    excludeTimestamps,
  });
}

export { IMAGE_EXT, VIDEO_EXT };
