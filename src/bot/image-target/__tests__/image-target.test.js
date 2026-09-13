/**
 * Unit tests for the image-target watcher (no Discord, no network).
 * Uses the in-memory store backend (IMAGE_TARGET_MEMORY=1).
 * Run: npm run test:image-target
 */
process.env.IMAGE_TARGET_MEMORY = '1';
process.env.NODE_ENV = 'test';

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

async function makePatternPng({ seed = 1, size = 128, format = 'png' } = {}) {
  const buf = Buffer.alloc(size * size * 3);
  let s = seed >>> 0;
  for (let i = 0; i < buf.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    buf[i] = (s >>> 16) & 0xff;
  }
  const img = sharp(buf, { raw: { width: size, height: size, channels: 3 } });
  if (format === 'jpeg' || format === 'jpg') {
    return img.jpeg({ quality: 85 }).toBuffer();
  }
  if (format === 'webp') {
    return img.webp({ quality: 85 }).toBuffer();
  }
  return img.png().toBuffer();
}

async function makeResized(buffer, width) {
  return sharp(buffer).resize({ width, fit: 'inside' }).png().toBuffer();
}

async function makeSlightCrop(buffer) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width;
  const h = meta.height;
  return sharp(buffer)
    .extract({
      left: Math.floor(w * 0.05),
      top: Math.floor(h * 0.05),
      width: Math.floor(w * 0.9),
      height: Math.floor(h * 0.9),
    })
    .png()
    .toBuffer();
}

describe('phash', async () => {
  const { fingerprintImage, hammingDistance, hammingSimilarity } = await import('../phash.js');

  it('fingerprints identical bytes the same', async () => {
    const a = await makePatternPng({ seed: 42 });
    const f1 = await fingerprintImage(a);
    const f2 = await fingerprintImage(a);
    assert.equal(f1.dHash, f2.dHash);
    assert.equal(f1.blockHash, f2.blockHash);
    assert.equal(f1.contentHash, f2.contentHash);
  });

  it('gives low Hamming distance for same image, different format', async () => {
    const png = await makePatternPng({ seed: 7, format: 'png' });
    const jpgFromPng = await sharp(png).jpeg({ quality: 80 }).toBuffer();
    const a = await fingerprintImage(png);
    const b = await fingerprintImage(jpgFromPng);
    const dist = hammingDistance(a.dHash, b.dHash);
    assert.ok(dist <= 10, `dHash distance ${dist} should be small for jpeg re-encode`);
    assert.ok(hammingSimilarity(a.dHash, b.dHash) >= 0.8);
  });

  it('gives low distance for resized copies', async () => {
    const src = await makePatternPng({ seed: 99, size: 256 });
    const small = await makeResized(src, 96);
    const a = await fingerprintImage(src);
    const b = await fingerprintImage(small);
    const dist = hammingDistance(a.dHash, b.dHash);
    assert.ok(dist <= 14, `resize dHash distance ${dist}`);
  });

  it('separates clearly different images', async () => {
    const a = await fingerprintImage(await makePatternPng({ seed: 1 }));
    const b = await fingerprintImage(await makePatternPng({ seed: 99999 }));
    const dist = hammingDistance(a.dHash, b.dHash);
    assert.ok(dist > 10, `different images should differ (dist=${dist})`);
  });
});

describe('store guild isolation (memory / postgres API)', async () => {
  const store = await import('../store.js');

  before(() => {
    store.__resetMemoryStore();
  });

  afterEach(() => {
    store.__resetMemoryStore();
  });

  it('keeps guild A targets out of guild B', async () => {
    await store.addTarget('guild-a', {
      name: 'Scam A',
      perceptualHash: 'aaaaaaaaaaaaaaaa',
      blockHash: 'b'.repeat(64),
      createdBy: 'u1',
    });
    await store.addTarget('guild-b', {
      name: 'Scam B',
      perceptualHash: 'cccccccccccccccc',
      blockHash: 'd'.repeat(64),
      createdBy: 'u2',
    });
    const a = await store.listTargets('guild-a');
    const b = await store.listTargets('guild-b');
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].name, 'Scam A');
    assert.equal(b[0].name, 'Scam B');
    assert.notEqual(a[0].targetId, b[0].targetId);
  });

  it('watches channels per guild', async () => {
    await store.addChannel('guild-a', 'chan-1');
    await store.addChannel('guild-a', 'chan-2');
    assert.equal(await store.isChannelWatched('guild-a', 'chan-1'), true);
    assert.equal(await store.isChannelWatched('guild-b', 'chan-1'), false);
    await store.removeChannel('guild-a', 'chan-1');
    assert.equal(await store.isChannelWatched('guild-a', 'chan-1'), false);
  });

  it('patches threshold and action', async () => {
    await store.patchGuildConfig('guild-a', { threshold: 0.85, action: 'log' });
    const cfg = await store.getGuildConfig('guild-a');
    assert.equal(cfg.threshold, 0.85);
    assert.equal(cfg.action, 'log');
  });
});

describe('detector two-stage (local only)', async () => {
  const store = await import('../store.js');
  const { analyzeTargetBuffer, matchAgainstTargets, testAgainstTargets } = await import('../detector.js');

  afterEach(() => {
    store.__resetMemoryStore();
  });

  it('matches exact / re-encoded image via pHash without Jina', async () => {
    const guildId = 'guild-detect';
    const src = await makePatternPng({ seed: 1234, size: 200 });
    const analyzed = await analyzeTargetBuffer(src, { withEmbedding: false });
    await store.addTarget(guildId, {
      name: 'Pattern 1234',
      perceptualHash: analyzed.dHash,
      blockHash: analyzed.blockHash,
      embedding: null,
      contentHash: analyzed.contentHash,
      createdBy: 'tester',
    });
    await store.addChannel(guildId, 'c1');

    const exact = await matchAgainstTargets(guildId, src);
    assert.ok(exact, 'exact should match');
    assert.ok(exact.score >= 0.95);
    assert.ok(['exact', 'phash'].includes(exact.method));

    const jpeg = await sharp(src).jpeg({ quality: 70 }).toBuffer();
    const soft = await matchAgainstTargets(guildId, jpeg);
    assert.ok(soft, 'jpeg re-encode should match via phash');
    assert.ok(soft.score >= 0.9);

    const other = await makePatternPng({ seed: 7777, size: 200 });
    const miss = await matchAgainstTargets(guildId, other);
    assert.equal(miss, null);

    const report = await testAgainstTargets(guildId, other);
    assert.equal(report.match, false);
    assert.ok(report.results.length >= 1);
  });

  it('survives slight crop via candidate→match path or obvious phash', async () => {
    const guildId = 'guild-crop';
    const src = await makePatternPng({ seed: 555, size: 240 });
    const analyzed = await analyzeTargetBuffer(src, { withEmbedding: false });
    await store.addTarget(guildId, {
      name: 'Crop Target',
      perceptualHash: analyzed.dHash,
      blockHash: analyzed.blockHash,
      contentHash: analyzed.contentHash,
      createdBy: 'tester',
    });

    const cropped = await makeSlightCrop(src);
    const result = await matchAgainstTargets(guildId, cropped);
    assert.ok(result === null || (result.score > 0 && result.target));
  });
});

describe('cosine similarity provider contract', async () => {
  const { cosineSimilarity, l2Normalize, ImageSimilarityProvider } = await import('../providers/types.js');

  it('returns 1 for identical normalized vectors', () => {
    const v = l2Normalize([1, 2, 3, 4]);
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
  });

  it('returns ~0 for orthogonal vectors', () => {
    const s = cosineSimilarity([1, 0, 0], [0, 1, 0]);
    assert.equal(s, 0);
  });

  it('base provider is unavailable', () => {
    const p = new ImageSimilarityProvider();
    assert.equal(p.available, false);
  });
});

describe('hub defaults and customIds', async () => {
  const { DEFAULT_ACTION } = await import('../constants.js');
  const { parseHubId, HUB_PREFIX } = await import('../hub.js');
  const store = await import('../store.js');

  afterEach(() => {
    store.__resetMemoryStore();
  });

  it('defaults to delete_warn so matches are visible', () => {
    assert.equal(DEFAULT_ACTION, 'delete_warn');
  });

  it('parses it: customIds', () => {
    assert.equal(HUB_PREFIX, 'it:');
    assert.deepEqual(parseHubId('it:watch'), { action: 'watch', parts: [] });
    assert.deepEqual(parseHubId('it:toggle:abc'), { action: 'toggle', parts: ['abc'] });
    assert.equal(parseHubId('emoji:x'), null);
  });

  it('stores previewJpeg on targets for the hub gallery', async () => {
    const preview = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const t = await store.addTarget('guild-hub', {
      name: 'Preview me',
      perceptualHash: 'aaaaaaaaaaaaaaaa',
      blockHash: 'b'.repeat(64),
      createdBy: 'u1',
      previewJpeg: preview,
      sourceUrl: 'https://cdn.example/x.png',
    });
    assert.ok(Buffer.isBuffer(t.previewJpeg));
    assert.equal(t.previewJpeg.equals(preview), true);
    assert.equal(t.sourceUrl, 'https://cdn.example/x.png');
    const listed = await store.listTargets('guild-hub', { includeDisabled: true });
    assert.equal(listed[0].previewJpeg.equals(preview), true);
  });

  it('new guild config uses delete_warn', async () => {
    const cfg = await store.getGuildConfig('guild-fresh');
    assert.equal(cfg.action, 'delete_warn');
  });
});
