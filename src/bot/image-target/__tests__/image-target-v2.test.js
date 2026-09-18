/**
 * Image Target V2 — comprehensive detection tests.
 * Run: npm run test:image-target
 */
process.env.IMAGE_TARGET_MEMORY = '1';
process.env.NODE_ENV = 'test';
process.env.IMAGE_TARGET_MAX_FRAMES = '6';
process.env.IMAGE_TARGET_MAX_VARIANTS = '9';
process.env.IMAGE_TARGET_VIDEO_SAMPLE_COUNT = '5';
process.env.IMAGE_TARGET_MAX_MEDIA_PER_MESSAGE = '8';

import { describe, it, afterEach, before } from 'node:test';
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
  // Seed-dependent structure so unrelated seeds stay visually distinct.
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
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r, g, b },
    },
  })
    .png()
    .toBuffer();
}

async function makeGifWithTargetAtFrame(targetPng, { totalFrames = 6, matchIndex = 0, size = 120 } = {}) {
  const encoder = new GIFEncoder(size, size);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(100);
  encoder.setQuality(10);

  const targetRgba = await sharp(targetPng)
    .resize(size, size, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();

  for (let i = 0; i < totalFrames; i++) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (i === matchIndex) {
      const imgData = ctx.createImageData(size, size);
      imgData.data.set(targetRgba);
      ctx.putImageData(imgData, 0, 0);
    } else {
      ctx.fillStyle = `rgb(${(i * 40) % 255}, ${(i * 70) % 255}, 90)`;
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#fff';
      ctx.fillRect(10, 10, 30, 30);
    }
    encoder.addFrame(ctx);
  }
  encoder.finish();
  return Buffer.from(encoder.out.getData());
}

async function makeVideoWithTargetAt({
  targetPng,
  matchAtSec = 1,
  durationSec = 3,
  size = 160,
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'it-v2-vid-'));
  try {
    const other = await solidPng(20, 180, 40, size);
    const targetFrame = await sharp(targetPng)
      .resize(size, size, { fit: 'fill' })
      .png()
      .toBuffer();

    // Build a concat demuxer list of stills at 1fps.
    const listLines = [];
    for (let t = 0; t < durationSec; t++) {
      const framePath = path.join(dir, `f${t}.png`);
      const useTarget = Math.abs(t - matchAtSec) < 0.01;
      await writeFile(framePath, useTarget ? targetFrame : other);
      listLines.push(`file '${framePath}'`);
      listLines.push('duration 1');
    }
    // Last file must be repeated for concat demuxer.
    listLines.push(`file '${path.join(dir, `f${durationSec - 1}.png`)}'`);
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

describe('V2 fingerprints ensemble', async () => {
  const {
    fingerprintImage,
    computeAHash,
    computePHash,
    computeEdgeHash,
    localSimilarity,
    hammingSimilarity,
  } = await import('../fingerprints.js');

  it('computes aHash, pHash, and edgeHash', async () => {
    const img = await makePatternPng({ seed: 11 });
    const fp = await fingerprintImage(img);
    assert.equal(fp.dHash.length, 16);
    assert.equal(fp.aHash.length, 16);
    assert.equal(fp.pHash.length, 16);
    assert.equal(fp.edgeHash.length, 16);
    assert.equal(fp.blockHash.length, 64);
    assert.equal(await computeAHash(img), fp.aHash);
    assert.equal(await computePHash(img), fp.pHash);
    assert.equal(await computeEdgeHash(img), fp.edgeHash);
  });

  it('localSimilarity is high for jpeg re-encode', async () => {
    const png = await makePatternPng({ seed: 22 });
    const jpg = await sharp(png).jpeg({ quality: 60 }).toBuffer();
    const a = await fingerprintImage(png);
    const b = await fingerprintImage(jpg);
    const { score } = localSimilarity(a, b);
    assert.ok(score >= 0.85, `expected high local sim, got ${score}`);
    assert.ok(hammingSimilarity(a.pHash, b.pHash) >= 0.8);
  });
});

describe('V2 sampler', async () => {
  const {
    pickSampleIndices,
    pickSampleTimestamps,
    sampleGifFrames,
    sampleMediaFrames,
  } = await import('../sampler.js');

  it('pickSampleIndices always includes first and last', () => {
    const idx = pickSampleIndices(20, 6);
    assert.equal(idx[0], 0);
    assert.equal(idx[idx.length - 1], 19);
    // Soft cap allows denser sampling on mid-sized animations (≤ ceil(max*1.5)).
    assert.ok(idx.length <= Math.ceil(6 * 1.5));
  });

  it('pickSampleTimestamps covers begin/mid/end', () => {
    const ts = pickSampleTimestamps(10, 5);
    assert.equal(ts[0], 0);
    assert.ok(ts[ts.length - 1] > 8);
    assert.equal(ts.length, 5);
  });

  it('samples multiple GIF frames including non-zero indices', async () => {
    const target = await makePatternPng({ seed: 33, size: 100 });
    const gif = await makeGifWithTargetAtFrame(target, {
      totalFrames: 8,
      matchIndex: 5,
      size: 100,
    });
    const frames = await sampleGifFrames(gif, { maxFrames: 6 });
    assert.ok(frames);
    assert.ok(frames.length >= 2);
    assert.equal(frames[0].frameIndex, 0);
    assert.ok(frames.some((f) => f.frameIndex > 0));
    assert.ok(frames.length <= Math.ceil(6 * 1.5));
  });

  it('bounds frame count', async () => {
    const target = await makePatternPng({ seed: 34, size: 80 });
    const gif = await makeGifWithTargetAtFrame(target, {
      totalFrames: 30,
      matchIndex: 29,
      size: 80,
    });
    const { frames } = await sampleMediaFrames(gif, {
      contentType: 'image/gif',
      filename: 'x.gif',
    });
    assert.ok(frames.length <= Math.ceil(6 * 1.5));
  });
});

describe('V2 variants', async () => {
  const { generateVariants } = await import('../variants.js');

  it('generates a bounded set of variants', async () => {
    const img = await makePatternPng({ seed: 44 });
    const variants = await generateVariants(img, { maxVariants: 6 });
    assert.ok(variants.length >= 3);
    assert.ok(variants.length <= 6);
    assert.ok(variants.some((v) => v.key === 'original'));
    assert.ok(variants.some((v) => v.key.includes('crop') || v.key.includes('grayscale')));
  });
});

describe('V2 edited-image resistance (local)', async () => {
  const store = await import('../store.js');
  const { analyzeTargetBuffer, matchAgainstTargets } = await import('../detector.js');

  afterEach(() => store.__resetMemoryStore());

  async function addAnalyzed(guildId, name, buffer) {
    const analyzed = await analyzeTargetBuffer(buffer, { withEmbedding: false });
    return store.addTarget(guildId, {
      name,
      perceptualHash: analyzed.dHash,
      blockHash: analyzed.blockHash,
      contentHash: analyzed.contentHash,
      createdBy: 'tester',
      fingerprints: analyzed.fingerprints,
    });
  }

  it('matches common edits: jpeg/webp/resize/brightness/contrast/grayscale/crop/border/caption/watermark/rotate/flip', async () => {
    const guildId = 'guild-edits';
    const src = await makePatternPng({ seed: 1001, size: 200 });
    await addAnalyzed(guildId, 'EditTarget', src);

    const cases = {
      jpeg: await sharp(src).jpeg({ quality: 40 }).toBuffer(),
      webp: await sharp(src).webp({ quality: 50 }).toBuffer(),
      resized: await sharp(src).resize(96).png().toBuffer(),
      brightness: await sharp(src).modulate({ brightness: 1.25 }).png().toBuffer(),
      contrast: await sharp(src).linear(1.3, -(128 * 0.3)).png().toBuffer(),
      grayscale: await sharp(src).greyscale().png().toBuffer(),
      crop: await sharp(src)
        .extract({ left: 20, top: 20, width: 160, height: 160 })
        .png()
        .toBuffer(),
      border: await sharp(src)
        .extend({
          top: 30,
          bottom: 30,
          left: 30,
          right: 30,
          background: { r: 255, g: 255, b: 0, alpha: 1 },
        })
        .png()
        .toBuffer(),
      caption: await sharp(src)
        .extend({
          top: 0,
          bottom: 40,
          left: 0,
          right: 0,
          background: { r: 0, g: 0, b: 0, alpha: 1 },
        })
        .composite([
          {
            input: await sharp({
              create: {
                width: 200,
                height: 36,
                channels: 3,
                background: { r: 0, g: 0, b: 0 },
              },
            })
              .png()
              .toBuffer(),
            top: 200,
            left: 0,
          },
        ])
        .png()
        .toBuffer(),
      watermark: await sharp(src)
        .composite([
          {
            input: Buffer.from(
              `<svg width="200" height="200"><text x="20" y="100" font-size="28" fill="white" opacity="0.7">WM</text></svg>`,
            ),
            top: 0,
            left: 0,
          },
        ])
        .png()
        .toBuffer(),
      rotate: await sharp(src).rotate(6, { background: '#000' }).png().toBuffer(),
      flip: await sharp(src).flop().png().toBuffer(),
    };

    const failures = [];
    for (const [name, buf] of Object.entries(cases)) {
      const match = await matchAgainstTargets(guildId, buf);
      if (!match || (match.score ?? 0) < 0.85) {
        failures.push(`${name}=${match ? match.score?.toFixed(3) : 'null'}`);
      }
    }
    assert.equal(
      failures.length,
      0,
      `expected edits to match locally, failures: ${failures.join(', ')}`,
    );
  });

  it('rejects visually unrelated images', async () => {
    const guildId = 'guild-neg';
    const src = await makePatternPng({ seed: 2002, size: 180 });
    await addAnalyzed(guildId, 'NegTarget', src);
    const other = await solidPng(10, 200, 30, 180);
    const miss = await matchAgainstTargets(guildId, other);
    assert.equal(miss, null);
  });
});

describe('V2 GIF mid/late frame detection', async () => {
  const store = await import('../store.js');
  const { analyzeTargetBuffer, matchAgainstTargets, testAgainstTargets } =
    await import('../detector.js');

  afterEach(() => store.__resetMemoryStore());

  it('matches when target is GIF frame 1, frame 5, and final frame', async () => {
    const guildId = 'guild-gif';
    const target = await makePatternPng({ seed: 3003, size: 120 });
    const analyzed = await analyzeTargetBuffer(target, { withEmbedding: false });
    await store.addTarget(guildId, {
      name: 'GifTarget',
      perceptualHash: analyzed.dHash,
      blockHash: analyzed.blockHash,
      contentHash: analyzed.contentHash,
      createdBy: 'tester',
      fingerprints: analyzed.fingerprints,
      mediaKind: 'image',
    });

    for (const matchIndex of [1, 5, 7]) {
      const gif = await makeGifWithTargetAtFrame(target, {
        totalFrames: 8,
        matchIndex,
        size: 120,
      });
      const match = await matchAgainstTargets(guildId, gif, {
        meta: { contentType: 'image/gif', filename: 'x.gif' },
      });
      assert.ok(match, `expected match at frame ${matchIndex}`);
      assert.ok(match.score >= 0.85, `score ${match.score} at frame ${matchIndex}`);
    }

    const report = await testAgainstTargets(
      guildId,
      await makeGifWithTargetAtFrame(target, { totalFrames: 8, matchIndex: 5, size: 120 }),
      { meta: { contentType: 'image/gif', filename: 'x.gif' } },
    );
    assert.ok(report.match);
    assert.ok(report.reportText?.includes('MATCH') || report.top?.matched);
  });
});

describe('V2 video multi-frame detection', async () => {
  const store = await import('../store.js');
  const { analyzeTargetBuffer, matchAgainstTargets } = await import('../detector.js');

  afterEach(() => store.__resetMemoryStore());

  it('matches target at first, middle, and near-end frames', async () => {
    const guildId = 'guild-vid';
    const target = await makePatternPng({ seed: 4004, size: 160 });
    const analyzed = await analyzeTargetBuffer(target, { withEmbedding: false });
    await store.addTarget(guildId, {
      name: 'VidTarget',
      perceptualHash: analyzed.dHash,
      blockHash: analyzed.blockHash,
      contentHash: analyzed.contentHash,
      createdBy: 'tester',
      fingerprints: analyzed.fingerprints,
    });

    for (const matchAtSec of [0, 1, 2]) {
      const video = await makeVideoWithTargetAt({
        targetPng: target,
        matchAtSec,
        durationSec: 3,
        size: 160,
      });
      const match = await matchAgainstTargets(guildId, video, {
        meta: { contentType: 'video/mp4', filename: 'x.mp4' },
      });
      assert.ok(match, `expected video match at t=${matchAtSec}`);
      assert.ok(match.score >= 0.85, `score ${match.score} at t=${matchAtSec}`);
    }
  });

  it('does not match unrelated video', async () => {
    const guildId = 'guild-vid-neg';
    const target = await makePatternPng({ seed: 4005, size: 160 });
    const analyzed = await analyzeTargetBuffer(target, { withEmbedding: false });
    await store.addTarget(guildId, {
      name: 'VidNeg',
      perceptualHash: analyzed.dHash,
      blockHash: analyzed.blockHash,
      contentHash: analyzed.contentHash,
      createdBy: 'tester',
      fingerprints: analyzed.fingerprints,
    });
    // Solid green frames — visually unrelated to the patterned target.
    const other = await solidPng(20, 200, 40, 160);
    const video = await makeVideoWithTargetAt({
      targetPng: other,
      matchAtSec: 1,
      durationSec: 3,
    });
    const miss = await matchAgainstTargets(guildId, video, {
      meta: { contentType: 'video/mp4', filename: 'x.mp4' },
    });
    assert.equal(miss, null);
  });
});

describe('V2 watcher media budget + edits', async () => {
  const store = await import('../store.js');
  const { collectCandidates } = await import('../watcher.js');

  afterEach(() => store.__resetMemoryStore());

  function fakeMessage({ attachments = [], embeds = [], content = '', stickers = [] } = {}) {
    return {
      attachments: {
        values: () => attachments[Symbol.iterator](),
        size: attachments.length,
      },
      embeds,
      content,
      stickers: {
        values: () => stickers[Symbol.iterator](),
        size: stickers.length,
      },
    };
  }

  it('collects attachments, embeds, urls, emoji, stickers without silent 4-cap', () => {
    const attachments = Array.from({ length: 6 }, (_, i) => ({
      contentType: 'image/png',
      name: `a${i}.png`,
      url: `https://cdn.discordapp.com/attachments/1/2/a${i}.png`,
      proxyURL: `https://media.discordapp.net/attachments/1/2/a${i}.png`,
      size: 1000,
    }));
    const msg = fakeMessage({
      attachments,
      embeds: [
        { image: { url: 'https://cdn.discordapp.com/embed.png' } },
        { thumbnail: { url: 'https://cdn.discordapp.com/thumb.jpg' } },
      ],
      content: 'see https://cdn.discordapp.com/x.webp and <:cat:123456789012345678>',
      stickers: [{ id: '999', name: 'wave', format: 1 }],
    });
    const cands = collectCandidates(msg);
    assert.ok(cands.length >= 6, `expected many candidates, got ${cands.length}`);
    assert.ok(cands.some((c) => c.source === 'attachment'));
    assert.ok(cands.some((c) => c.source === 'embed'));
    assert.ok(cands.some((c) => c.source === 'url'));
    assert.ok(cands.some((c) => c.source === 'emoji'));
    assert.ok(cands.some((c) => c.source === 'sticker'));
  });
});

describe('V2 database fingerprints + guild isolation + V1 compat', async () => {
  const store = await import('../store.js');
  const { analyzeTargetBuffer, matchAgainstTargets } = await import('../detector.js');

  afterEach(() => store.__resetMemoryStore());

  it('stores multiple fingerprints per target and isolates guilds', async () => {
    const src = await makePatternPng({ seed: 5005 });
    const analyzed = await analyzeTargetBuffer(src, { withEmbedding: false });
    assert.ok(analyzed.fingerprints.length >= 2);

    const a = await store.addTarget('guild-fp-a', {
      name: 'A',
      perceptualHash: analyzed.dHash,
      blockHash: analyzed.blockHash,
      contentHash: analyzed.contentHash,
      createdBy: 'u',
      fingerprints: analyzed.fingerprints,
    });
    await store.addTarget('guild-fp-b', {
      name: 'B',
      perceptualHash: 'aaaaaaaaaaaaaaaa',
      blockHash: 'b'.repeat(64),
      createdBy: 'u',
    });

    const fps = await store.listTargetFingerprints('guild-fp-a', a.targetId);
    assert.ok(fps.length >= 2);
    assert.ok(fps.every((fp) => fp.guildId === 'guild-fp-a'));

    const cross = await store.listTargetFingerprints('guild-fp-b', a.targetId);
    assert.equal(cross.length, 0);
  });

  it('still matches V1 targets that only have primary hashes', async () => {
    const guildId = 'guild-v1';
    const src = await makePatternPng({ seed: 6006, size: 160 });
    const analyzed = await analyzeTargetBuffer(src, { withEmbedding: false });
    // Simulate V1 row: no fingerprints array.
    await store.addTarget(guildId, {
      name: 'Legacy',
      perceptualHash: analyzed.dHash,
      blockHash: analyzed.blockHash,
      contentHash: analyzed.contentHash,
      createdBy: 'u',
      fingerprintVersion: 1,
    });
    const fps = await store.listTargetFingerprints(guildId, (await store.listTargets(guildId))[0].targetId);
    assert.equal(fps.length, 0);

    const match = await matchAgainstTargets(guildId, src);
    assert.ok(match);
    assert.ok(match.score >= 0.95);
  });
});

describe('V2 performance bounds', async () => {
  const { IMAGE_TARGET_MAX_FRAMES, IMAGE_TARGET_MAX_MEDIA_PER_MESSAGE, IMAGE_TARGET_FFMPEG_TIMEOUT_MS } =
    await import('../constants.js');
  const { pickSampleIndices } = await import('../sampler.js');
  const { isBlockedHost, assertPublicHttpUrl } = await import('../download.js');

  it('keeps frame and media budgets finite', () => {
    assert.ok(IMAGE_TARGET_MAX_FRAMES <= 24);
    assert.ok(IMAGE_TARGET_MAX_MEDIA_PER_MESSAGE <= 32);
    assert.ok(IMAGE_TARGET_FFMPEG_TIMEOUT_MS <= 60_000);
    const idx = pickSampleIndices(1000, IMAGE_TARGET_MAX_FRAMES);
    assert.ok(idx.length <= Math.ceil(IMAGE_TARGET_MAX_FRAMES * 1.5));
    assert.ok(idx.length >= IMAGE_TARGET_MAX_FRAMES);
  });

  it('rejects SSRF / oversized patterns still', () => {
    assert.equal(isBlockedHost('127.0.0.1'), true);
    assert.equal(isBlockedHost('169.254.169.254'), true);
    assert.throws(() => assertPublicHttpUrl('http://localhost/x'), /ssrf_blocked|bad_url/);
  });
});

describe('V2 scoring report', async () => {
  const { formatTestResult, describeMethod, classifyLocalEvidence } = await import('../scoring.js');

  it('formats admin-facing test detail', () => {
    const text = formatTestResult({
      target: { name: 'Funny Meme' },
      finalScore: 0.94,
      method: 'jina',
      mediaKind: 'gif',
      frameIndex: 7,
      timestampSec: 2.3,
      variantKey: 'center-crop-90',
      localScores: { pHash: 0.81, dHash: 0.87, blockHash: 0.79 },
      embeddingScore: 0.94,
      matched: true,
    });
    assert.match(text, /Funny Meme/);
    assert.match(text, /0\.94/);
    assert.match(text, /Matching Frame: 7/);
    assert.match(text, /MATCH/);
    assert.ok(describeMethod({ method: 'jina', embeddingScore: 0.9, localScores: { pHash: 0.8 } }).includes('Jina'));
    assert.equal(classifyLocalEvidence(0.95), 'obvious');
    assert.equal(classifyLocalEvidence(0.2), 'skip');
  });
});
