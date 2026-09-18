/**
 * Image Target V2.1 — Adaptive Deep Detection tests.
 * Run: npm run test:image-target
 */
process.env.IMAGE_TARGET_MEMORY = '1';
process.env.NODE_ENV = 'test';
process.env.IMAGE_TARGET_MAX_FRAMES = '4';
process.env.IMAGE_TARGET_DEEP_MAX_FRAMES = '12';
process.env.IMAGE_TARGET_MAX_VARIANTS = '6';
process.env.IMAGE_TARGET_DEEP_MAX_VARIANTS = '12';
process.env.IMAGE_TARGET_VIDEO_SAMPLE_COUNT = '3';
process.env.IMAGE_TARGET_MAX_JINA_CALLS = '4';
process.env.IMAGE_TARGET_MAX_MEDIA_PER_MESSAGE = '8';

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import GIFEncoder from 'gifencoder';
import { createCanvas } from '@napi-rs/canvas';

const execFileAsync = promisify(execFile);

async function makePatternPng({ seed = 1, size = 160, format = 'png' } = {}) {
  const buf = Buffer.alloc(size * size * 3);
  let s = seed >>> 0;
  for (let i = 0; i < buf.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    buf[i] = (s >>> 16) & 0xff;
  }
  const ox = (seed * 17) % Math.max(1, size - 60);
  const oy = (seed * 29) % Math.max(1, size - 60);
  const bw = 40 + (seed % 40);
  const bh = 40 + ((seed * 3) % 40);
  for (let y = oy; y < Math.min(size, oy + bh); y++) {
    for (let x = ox; x < Math.min(size, ox + bw); x++) {
      const i = (y * size + x) * 3;
      buf[i] = (seed * 13) & 0xff;
      buf[i + 1] = (seed * 37) & 0xff;
      buf[i + 2] = (seed * 59) & 0xff;
    }
  }
  const img = sharp(buf, { raw: { width: size, height: size, channels: 3 } });
  if (format === 'jpeg' || format === 'jpg') return img.jpeg({ quality: 85 }).toBuffer();
  if (format === 'webp') return img.webp({ quality: 85 }).toBuffer();
  return img.png().toBuffer();
}

async function solidPng(r, g, b, size = 128) {
  return sharp({
    create: { width: size, height: size, channels: 3, background: { r, g, b } },
  })
    .png()
    .toBuffer();
}

async function makeGifWithTargetAtFrame(targetPng, {
  totalFrames = 10,
  matchIndex = 0,
  size = 100,
  duplicateNeighbors = false,
} = {}) {
  const encoder = new GIFEncoder(size, size);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(80);
  encoder.setQuality(10);

  const targetRgba = await sharp(targetPng)
    .resize(size, size, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();

  for (let i = 0; i < totalFrames; i++) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const paintTarget =
      i === matchIndex ||
      (duplicateNeighbors && (i === matchIndex + 1 || i === matchIndex - 1));
    if (paintTarget) {
      const imgData = ctx.createImageData(size, size);
      imgData.data.set(targetRgba);
      ctx.putImageData(imgData, 0, 0);
    } else {
      ctx.fillStyle = `rgb(${(i * 37) % 255}, ${(i * 73) % 255}, 40)`;
      ctx.fillRect(0, 0, size, size);
    }
    encoder.addFrame(ctx);
  }
  encoder.finish();
  return Buffer.from(encoder.out.getData());
}

async function makeVideoSparseTarget({
  targetPng,
  matchAtSec = 1.5,
  durationSec = 4,
  size = 120,
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'it-v21-vid-'));
  try {
    const other = await solidPng(30, 160, 50, size);
    const targetFrame = await sharp(targetPng)
      .resize(size, size, { fit: 'fill' })
      .png()
      .toBuffer();

    // 0.5s frames so a mid-interval target can sit between coarse samples.
    const listLines = [];
    const step = 0.5;
    for (let t = 0; t < durationSec; t += step) {
      const framePath = path.join(dir, `f${t.toFixed(1)}.png`);
      const useTarget = Math.abs(t - matchAtSec) < 0.01;
      await writeFile(framePath, useTarget ? targetFrame : other);
      listLines.push(`file '${framePath}'`);
      listLines.push(`duration ${step}`);
    }
    listLines.push(`file '${path.join(dir, `f${(durationSec - step).toFixed(1)}.png`)}'`);
    const listPath = path.join(dir, 'list.txt');
    await writeFile(listPath, listLines.join('\n'));
    const outPath = path.join(dir, 'out.mp4');
    await execFileAsync(
      'ffmpeg',
      [
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-vf', `scale=${size}:${size}`,
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        outPath,
      ],
      { timeout: 20_000 },
    );
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function addAnalyzed(store, guildId, name, buffer, extra = {}) {
  const { analyzeTargetBuffer } = await import('../detector.js');
  const analyzed = await analyzeTargetBuffer(buffer, {
    withEmbedding: false,
    meta: extra.meta,
  });
  return store.addTarget(guildId, {
    name,
    perceptualHash: analyzed.dHash,
    blockHash: analyzed.blockHash,
    contentHash: analyzed.contentHash,
    createdBy: 'tester',
    fingerprints: analyzed.fingerprints,
    mediaKind: analyzed.mediaKind || 'image',
    ...extra.fields,
  });
}

describe('V2.1 deep-scan helpers', async () => {
  const {
    shouldEscalateToDeepScan,
    preliminaryRelevance,
    collapseNearDuplicateFrames,
    pickDeepTimestamps,
    pickDeepFrameIndices,
  } = await import('../deep-scan.js');

  it('escalates candidate/uncertain and edited relevance hints', () => {
    assert.equal(
      shouldEscalateToDeepScan({ band: 'candidate', localScore: 0.6 }).escalate,
      true,
    );
    assert.equal(
      shouldEscalateToDeepScan({ band: 'uncertain', localScore: 0.4 }).escalate,
      true,
    );
    assert.equal(
      shouldEscalateToDeepScan({
        band: 'skip',
        localScore: 0.2,
        localScores: { pHash: 0.5, dHash: 0.2 },
      }).escalate,
      true,
    );
    assert.equal(
      shouldEscalateToDeepScan({
        band: 'skip',
        localScore: 0.1,
        localScores: { pHash: 0.1, dHash: 0.1 },
      }).escalate,
      false,
    );
    assert.equal(
      shouldEscalateToDeepScan({ band: 'obvious', localScore: 0.95, matched: false })
        .escalate,
      false,
    );
  });

  it('preliminaryRelevance distinguishes edited from unrelated', () => {
    assert.equal(preliminaryRelevance({ pHash: 0.5 }, 0.2), true);
    assert.equal(preliminaryRelevance({ pHash: 0.1, dHash: 0.1 }, 0.1), false);
  });

  it('collapses near-duplicate frames', () => {
    const frames = [
      { frameIndex: 0, cheapHash: 'aaaaaaaaaaaaaaaa' },
      { frameIndex: 1, cheapHash: 'aaaaaaaaaaaaaaaa' },
      { frameIndex: 2, cheapHash: 'bbbbbbbbbbbbbbbb' },
    ];
    const kept = collapseNearDuplicateFrames(frames, { hammingThreshold: 0 });
    assert.equal(kept.length, 2);
    assert.equal(kept[0].frameIndex, 0);
    assert.equal(kept[1].frameIndex, 2);
  });

  it('pickDeepTimestamps subdivides intervals', () => {
    const ts = pickDeepTimestamps(4, [0, 2, 3.9], 4);
    assert.ok(ts.length >= 1);
    assert.ok(ts.every((t) => t > 0 && t < 4));
  });

  it('pickDeepFrameIndices fills gaps and skips duplicates', () => {
    const idx = pickDeepFrameIndices(20, [0, 5, 19], 6);
    assert.ok(idx.length >= 1);
    assert.ok(!idx.includes(0));
    assert.ok(!idx.includes(19));
  });
});

describe('V2.1 adaptive GIF / video detection', async () => {
  const store = await import('../store.js');
  const { matchAgainstTargets, testAgainstTargets } = await import('../detector.js');

  afterEach(() => store.__resetMemoryStore());

  it('matches GIF target only in middle frame via deep scan if needed', async () => {
    const guildId = 'g-gif-mid';
    const target = await makePatternPng({ seed: 7101, size: 100 });
    await addAnalyzed(store, guildId, 'MidGif', target);
    const gif = await makeGifWithTargetAtFrame(target, {
      totalFrames: 12,
      matchIndex: 6,
      size: 100,
    });
    const match = await matchAgainstTargets(guildId, gif, {
      meta: { contentType: 'image/gif', filename: 'x.gif' },
    });
    assert.ok(match, 'expected mid-frame GIF match');
    assert.ok(match.score >= 0.8);
  });

  it('matches GIF target only near last frame', async () => {
    const guildId = 'g-gif-last';
    const target = await makePatternPng({ seed: 7102, size: 100 });
    await addAnalyzed(store, guildId, 'LastGif', target);
    const gif = await makeGifWithTargetAtFrame(target, {
      totalFrames: 11,
      matchIndex: 9,
      size: 100,
    });
    const match = await matchAgainstTargets(guildId, gif, {
      meta: { contentType: 'image/gif', filename: 'x.gif' },
    });
    assert.ok(match, 'expected near-last GIF match');
  });

  it('dedupes identical/redundant GIF frames', async () => {
    const { sampleGifFrames } = await import('../sampler.js');
    const { collapseNearDuplicateFrames } = await import('../deep-scan.js');
    const target = await makePatternPng({ seed: 7103, size: 80 });
    const gif = await makeGifWithTargetAtFrame(target, {
      totalFrames: 6,
      matchIndex: 2,
      size: 80,
      duplicateNeighbors: true,
    });
    const frames = await sampleGifFrames(gif, {
      onlyIndices: [0, 1, 2, 3, 4, 5],
    });
    const deduped = collapseNearDuplicateFrames(frames, { hammingThreshold: 2 });
    assert.ok(deduped.length < frames.length || frames.length <= 4);
  });

  it('matches short video target between initial sample timestamps', async () => {
    const guildId = 'g-vid-gap';
    const target = await makePatternPng({ seed: 7201, size: 120 });
    await addAnalyzed(store, guildId, 'VidGap', target);
    // With VIDEO_SAMPLE_COUNT=3 on a 4s video, samples ~0, 2, 3.9 —
    // target at 1.5 sits between; deep scan should catch it.
    const video = await makeVideoSparseTarget({
      targetPng: target,
      matchAtSec: 1.5,
      durationSec: 4,
      size: 120,
    });
    const match = await matchAgainstTargets(guildId, video, {
      meta: { contentType: 'video/mp4', filename: 'x.mp4' },
    });
    assert.ok(match, 'expected between-sample video match via deep scan');
  });
});

describe('V2.1 screenshot / edit resistance (deep variants)', async () => {
  const store = await import('../store.js');
  const { matchAgainstTargets } = await import('../detector.js');

  afterEach(() => store.__resetMemoryStore());

  it('matches Discord-like bordered screenshot + caption + compress + mirror combo', async () => {
    const guildId = 'g-screenshot';
    const src = await makePatternPng({ seed: 7301, size: 200 });
    await addAnalyzed(store, guildId, 'Shot', src);

    let edited = await sharp(src)
      .extend({
        top: 40,
        bottom: 50,
        left: 36,
        right: 36,
        background: { r: 54, g: 57, b: 63, alpha: 1 },
      })
      .png()
      .toBuffer();
    edited = await sharp(edited)
      .composite([
        {
          input: Buffer.from(
            `<svg width="272" height="40"><rect width="272" height="40" fill="black"/><text x="12" y="26" font-size="16" fill="white">Discord caption</text></svg>`,
          ),
          top: 240,
          left: 0,
        },
      ])
      .flop()
      .jpeg({ quality: 45 })
      .toBuffer();

    const match = await matchAgainstTargets(guildId, edited);
    assert.ok(match, 'expected screenshot-like edited match');
    assert.ok(match.score >= 0.58);
  });

  it('matches common single edits: mirror, resize, jpeg, grayscale, brightness, crop, letterbox', async () => {
    const guildId = 'g-edits21';
    const src = await makePatternPng({ seed: 7302, size: 180 });
    await addAnalyzed(store, guildId, 'Edit21', src);

    const cases = {
      mirror: await sharp(src).flop().png().toBuffer(),
      resized: await sharp(src).resize(64).png().toBuffer(),
      jpeg: await sharp(src).jpeg({ quality: 35 }).toBuffer(),
      gray: await sharp(src).greyscale().png().toBuffer(),
      bright: await sharp(src).modulate({ brightness: 1.35 }).png().toBuffer(),
      crop: await sharp(src)
        .extract({ left: 20, top: 20, width: 140, height: 140 })
        .png()
        .toBuffer(),
      letterbox: await sharp(src)
        .resize({ width: 180, height: 100, fit: 'contain', background: '#000' })
        .png()
        .toBuffer(),
      caption: await sharp(src)
        .extend({ top: 0, bottom: 48, left: 0, right: 0, background: '#000' })
        .png()
        .toBuffer(),
    };

    const fails = [];
    for (const [name, buf] of Object.entries(cases)) {
      const m = await matchAgainstTargets(guildId, buf);
      if (!m || (m.score ?? 0) < 0.58) fails.push(`${name}=${m ? m.score : null}`);
    }
    assert.equal(fails.length, 0, `failures: ${fails.join(', ')}`);
  });
});

describe('V2.1 media type fallbacks + safety', async () => {
  const store = await import('../store.js');
  const { sniffMediaKind } = await import('../download.js');
  const { matchAgainstTargets, testAgainstTargets } = await import('../detector.js');
  const { collectCandidates } = await import('../watcher.js');
  const {
    IMAGE_TARGET_DEEP_MAX_FRAMES,
    IMAGE_TARGET_DEEP_MAX_VARIANTS,
    IMAGE_TARGET_MAX_JINA_CALLS,
  } = await import('../constants.js');

  afterEach(() => store.__resetMemoryStore());

  it('sniffs JPEG/PNG/GIF/MP4 magic bytes', async () => {
    const png = await makePatternPng({ seed: 1, size: 32 });
    const jpg = await sharp(png).jpeg().toBuffer();
    assert.equal(sniffMediaKind(png)?.format, 'png');
    assert.equal(sniffMediaKind(jpg)?.format, 'jpeg');

    const gif = await makeGifWithTargetAtFrame(png, { totalFrames: 2, size: 32 });
    assert.equal(sniffMediaKind(gif)?.format, 'gif');
  });

  it('matches when filename extension is missing but bytes are valid', async () => {
    const guildId = 'g-noext';
    const src = await makePatternPng({ seed: 7401, size: 120 });
    await addAnalyzed(store, guildId, 'NoExt', src);
    const match = await matchAgainstTargets(guildId, src, {
      meta: { contentType: 'application/octet-stream', filename: 'blob', url: 'https://cdn.discordapp.com/attachments/1/2/blob' },
    });
    assert.ok(match);
  });

  it('fails safely on corrupt media', async () => {
    const guildId = 'g-corrupt';
    const src = await makePatternPng({ seed: 7402, size: 80 });
    await addAnalyzed(store, guildId, 'C', src);
    await assert.rejects(
      () =>
        matchAgainstTargets(guildId, Buffer.from('not-an-image'), {
          meta: { contentType: 'image/png', filename: 'x.png' },
        }),
      /not_an_image|media_decode_failed|Input buffer/,
    );
  });

  it('collects multiple media items in one message', () => {
    const attachments = Array.from({ length: 5 }, (_, i) => ({
      contentType: 'image/png',
      name: `a${i}.png`,
      url: `https://cdn.discordapp.com/attachments/1/2/a${i}.png`,
      proxyURL: `https://media.discordapp.net/attachments/1/2/a${i}.png`,
      size: 1000,
    }));
    const cands = collectCandidates({
      attachments: { values: () => attachments[Symbol.iterator](), size: 5 },
      embeds: [{ image: { url: 'https://cdn.discordapp.com/e.png' } }],
      content: 'https://cdn.discordapp.com/x.webp',
      stickers: { values: () => [].values(), size: 0 },
    });
    assert.ok(cands.length >= 6);
  });

  it('reports deep-scan diagnostics in test output', async () => {
    const guildId = 'g-diag';
    const src = await makePatternPng({ seed: 7403, size: 140 });
    await addAnalyzed(store, guildId, 'Diag', src);
    const bordered = await sharp(src)
      .extend({
        top: 35,
        bottom: 45,
        left: 35,
        right: 35,
        background: { r: 40, g: 40, b: 40 },
      })
      .jpeg({ quality: 40 })
      .toBuffer();
    const report = await testAgainstTargets(guildId, bordered);
    assert.ok(report.reportText);
    assert.match(report.reportText, /Deep Scan:/);
    assert.match(report.reportText, /Frames Sampled:/);
    assert.ok(report.diagnostics);
  });

  it('keeps deep budgets finite (no runaway explosion)', () => {
    assert.ok(IMAGE_TARGET_DEEP_MAX_FRAMES <= 36);
    assert.ok(IMAGE_TARGET_DEEP_MAX_VARIANTS <= 24);
    assert.ok(IMAGE_TARGET_MAX_JINA_CALLS <= 16);
  });

  it('works without Jina (unavailable)', async () => {
    const guildId = 'g-nojina';
    const src = await makePatternPng({ seed: 7404, size: 120 });
    await addAnalyzed(store, guildId, 'NoJina', src);
    const jpeg = await sharp(src).jpeg({ quality: 50 }).toBuffer();
    const match = await matchAgainstTargets(guildId, jpeg);
    assert.ok(match);
    assert.equal(match.usedJina, false);
  });

  it('preserves V1 target compatibility and guild isolation', async () => {
    const src = await makePatternPng({ seed: 7405, size: 100 });
    const { analyzeTargetBuffer } = await import('../detector.js');
    const analyzed = await analyzeTargetBuffer(src, { withEmbedding: false });
    await store.addTarget('guild-v1-a', {
      name: 'Legacy',
      perceptualHash: analyzed.dHash,
      blockHash: analyzed.blockHash,
      contentHash: analyzed.contentHash,
      createdBy: 'u',
      fingerprintVersion: 1,
    });
    await store.addTarget('guild-v1-b', {
      name: 'Other',
      perceptualHash: 'aaaaaaaaaaaaaaaa',
      blockHash: 'b'.repeat(64),
      createdBy: 'u',
    });
    const match = await matchAgainstTargets('guild-v1-a', src);
    assert.ok(match);
    const cross = await matchAgainstTargets('guild-v1-b', src);
    assert.equal(cross, null);
  });
});

describe('V2.1 deep variants bounded', async () => {
  const { generateVariants } = await import('../variants.js');

  it('deep mode adds variants but stays under DEEP_MAX', async () => {
    const img = await makePatternPng({ seed: 99, size: 120 });
    const quick = await generateVariants(img, { maxVariants: 6, deep: false });
    const deep = await generateVariants(img, { maxVariants: 12, deep: true });
    assert.ok(deep.length >= quick.length);
    assert.ok(deep.length <= 12);
    assert.ok(deep.some((v) => v.key === 'border-trim-12' || v.key === 'recompress-jpeg'));
  });
});
