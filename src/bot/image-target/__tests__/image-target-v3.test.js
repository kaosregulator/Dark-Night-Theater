/**
 * Image Target V3 Forensic Engine — regression tests.
 */
process.env.IMAGE_TARGET_MEMORY = '1';
process.env.NODE_ENV = 'test';
process.env.IMAGE_TARGET_MAX_FRAMES = '6';
process.env.IMAGE_TARGET_DEEP_MAX_FRAMES = '12';
process.env.IMAGE_TARGET_MAX_VARIANTS = '6';
process.env.IMAGE_TARGET_DEEP_MAX_VARIANTS = '14';
process.env.IMAGE_TARGET_MAX_JINA_CALLS = '2';
process.env.IMAGE_TARGET_FEATURES = '1';
process.env.IMAGE_TARGET_MAX_REGIONS = '10';
process.env.IMAGE_TARGET_MAX_ADAPTIVE_CROPS = '8';

import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import sharp from 'sharp';

import { computeColorHash } from '../color-hash.js';
import {
  IMAGE_TARGET_DEEP_MAX_VARIANTS,
  IMAGE_TARGET_MAX_REGIONS,
} from '../constants.js';
import {
  analyzeTargetBuffer,
  matchAgainstTargets,
  testAgainstTargets,
} from '../detector.js';
import { fuseEvidence, mirrorSignal } from '../evidence.js';
import {
  extractLocalFeatures,
  matchLocalFeatures,
  serializeFeatures,
  deserializeFeatures,
} from '../features.js';
import { fingerprintImage, hammingSimilarity } from '../fingerprints.js';
import { generateLabAttacks, runImageTargetLab, formatLabReport } from '../lab.js';
import { computePdqHash } from '../pdq.js';
import { generateAdaptiveCrops, generateCollageRegions } from '../regions.js';
import { stripScreenshotChrome } from '../screenshot.js';
import { addTarget, listTargets } from '../store.js';
import { generateVariants } from '../variants.js';
import {
  foldVideoHash,
  matchFrameSequence,
} from '../videohash.js';

async function solidJpeg(color, w = 160, h = 160) {
  return sharp({
    create: { width: w, height: h, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();
}

async function patternTarget() {
  // Distinctive non-flat image so hashes/features have structure.
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240">
    <rect width="240" height="240" fill="#1a5fb4"/>
    <circle cx="80" cy="90" r="40" fill="#f6d32d"/>
    <rect x="130" y="40" width="70" height="120" fill="#e01b24"/>
    <polygon points="40,200 120,140 200,200" fill="#33d17a"/>
  </svg>`);
  return sharp(svg).jpeg({ quality: 90 }).toBuffer();
}

async function addAnalyzed(guildId, buffer, name = 't') {
  const analyzed = await analyzeTargetBuffer(buffer, { withEmbedding: false });
  return addTarget(guildId, {
    name,
    perceptualHash: analyzed.dHash,
    blockHash: analyzed.blockHash,
    contentHash: analyzed.contentHash,
    createdBy: 'test',
    mediaKind: analyzed.mediaKind || 'image',
    fingerprintVersion: 3,
    fingerprints: analyzed.fingerprints,
    previewJpeg: buffer,
  });
}

describe('V3 fingerprint suite', () => {
  it('computes PDQ and colorHash', async () => {
    const buf = await patternTarget();
    const pdq = await computePdqHash(buf);
    const color = await computeColorHash(buf);
    assert.equal(pdq.length, 64);
    assert.equal(color.length, 16);
    const fp = await fingerprintImage(buf);
    assert.ok(fp.pdqHash);
    assert.ok(fp.colorHash);
    assert.ok(hammingSimilarity(fp.pdqHash, pdq) > 0.9);
  });

  it('extracts and matches local ORB-style features', async () => {
    const buf = await patternTarget();
    const a = await extractLocalFeatures(buf);
    assert.ok(a.count >= 4, `expected keypoints, got ${a.count}`);
    const ser = serializeFeatures(a);
    const b = deserializeFeatures(ser);
    const m = matchLocalFeatures(a, b);
    assert.ok(m.matches >= 4, `self-match matches=${m.matches}`);
    assert.ok(m.score >= 0.45);

    // Cropped still shares features.
    const cropped = await sharp(buf)
      .extract({ left: 40, top: 40, width: 140, height: 140 })
      .jpeg()
      .toBuffer();
    const c = await extractLocalFeatures(cropped);
    const partial = matchLocalFeatures(a, c);
    assert.ok(partial.matches >= 2, `partial matches=${partial.matches}`);
  });
});

describe('V3 video sequence + videoHash', () => {
  it('folds video hash and matches ordered sequences', () => {
    const hashes = [
      'aaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbb',
      'cccccccccccccccc',
      'dddddddddddddddd',
      'eeeeeeeeeeeeeeee',
    ];
    const vh = foldVideoHash(hashes);
    assert.equal(vh.length, 16);
    const clip = hashes.slice(1, 4);
    const seq = matchFrameSequence(hashes, clip, { maxHamming: 0 });
    assert.ok(seq.matchedPairs >= 3);
    assert.ok(seq.score >= 0.5);
  });
});

describe('V3 screenshot / collage / crops', () => {
  it('strips discord-like borders', async () => {
    const inner = await patternTarget();
    const framed = await sharp({
      create: {
        width: 400,
        height: 440,
        channels: 3,
        background: { r: 32, g: 34, b: 37 },
      },
    })
      .composite([{ input: await sharp(inner).resize(300, 300).jpeg().toBuffer(), top: 50, left: 50 }])
      .jpeg()
      .toBuffer();
    const { candidates } = await stripScreenshotChrome(framed);
    assert.ok(candidates.length >= 1);
  });

  it('generates collage tiles and adaptive crops', async () => {
    const buf = await patternTarget();
    const regions = await generateCollageRegions(buf, { maxRegions: 12 });
    assert.ok(regions.some((r) => r.key.startsWith('tile-2x2')));
    assert.ok(regions.some((r) => r.key.startsWith('tile-3x3')));
    const crops = await generateAdaptiveCrops(buf, { maxCrops: 10 });
    assert.ok(crops.length >= 5);
    assert.ok(crops.length <= 10);
  });
});

describe('V3 deep forensic variants', () => {
  it('includes rotation/color/blur transforms under deep cap', async () => {
    const buf = await patternTarget();
    const deep = await generateVariants(buf, {
      maxVariants: IMAGE_TARGET_DEEP_MAX_VARIANTS,
      deep: true,
    });
    const keys = deep.map((v) => v.key);
    assert.ok(keys.includes('original'));
    assert.ok(
      keys.some((k) => k.startsWith('rotate-')) || keys.includes('negate') || keys.includes('jpeg-heavy'),
      `keys=${keys.join(',')}`,
    );
    assert.ok(deep.length <= IMAGE_TARGET_DEEP_MAX_VARIANTS);
  });
});

describe('V3 evidence fusion', () => {
  it('fuses ORB / partial / sequence signals', () => {
    const fused = fuseEvidence({
      localScore: 0.4,
      featureScore: 0.7,
      featureMatches: 18,
      regionScore: 0.75,
      contentOverlap: 0.73,
      sequenceScore: 0.6,
      sequenceMatches: 3,
    });
    assert.ok(fused.finalScore >= 0.7);
    assert.ok(fused.method.includes('ORB') || fused.method.includes('partial'));
    const mir = mirrorSignal({ normalScore: 0.5, mirrorScore: 0.82 });
    assert.ok(mir.mirroredBetter);
    assert.equal(mir.bestSimilarity, 0.82);
  });
});

describe('V3 detection scenarios', () => {
  const guildId = `v3-${Date.now()}`;
  let targetBuf;

  before(async () => {
    targetBuf = await patternTarget();
    await addAnalyzed(guildId, targetBuf, 'Batman');
  });

  it('detects horizontally mirrored target', async () => {
    const probe = await sharp(targetBuf).flop().jpeg().toBuffer();
    const match = await matchAgainstTargets(guildId, probe, {
      meta: { contentType: 'image/jpeg', filename: 'm.jpg' },
    });
    assert.ok(match?.matched, 'mirror should match');
  });

  it('detects grayscale + brightness edit', async () => {
    const probe = await sharp(targetBuf)
      .greyscale()
      .modulate({ brightness: 1.25 })
      .jpeg()
      .toBuffer();
    const match = await matchAgainstTargets(guildId, probe, {
      meta: { contentType: 'image/jpeg', filename: 'g.jpg' },
    });
    assert.ok(match?.matched, 'grayscale/brightness should match');
  });

  it('detects heavily JPEG recompressed target', async () => {
    const probe = await sharp(targetBuf)
      .resize(320, 320)
      .jpeg({ quality: 12 })
      .toBuffer();
    const match = await matchAgainstTargets(guildId, probe, {
      meta: { contentType: 'image/jpeg', filename: 'q.jpg' },
    });
    assert.ok(match?.matched, 'jpeg-12 should match');
  });

  it('detects cropped partial target via regions/features', async () => {
    const probe = await sharp(targetBuf)
      .extract({ left: 20, top: 20, width: 140, height: 140 })
      .jpeg()
      .toBuffer();
    const match = await matchAgainstTargets(guildId, probe, {
      meta: { contentType: 'image/jpeg', filename: 'c.jpg' },
    });
    assert.ok(match?.matched, 'crop should match');
  });

  it('detects discord-like screenshot of target', async () => {
    const inner = await sharp(targetBuf).resize(280, 280).jpeg().toBuffer();
    const probe = await sharp({
      create: {
        width: 400,
        height: 460,
        channels: 3,
        background: { r: 54, g: 57, b: 63 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 400,
              height: 40,
              channels: 3,
              background: { r: 88, g: 101, b: 242 },
            },
          })
            .png()
            .toBuffer(),
          top: 0,
          left: 0,
        },
        { input: inner, top: 60, left: 60 },
      ])
      .jpeg()
      .toBuffer();
    const match = await matchAgainstTargets(guildId, probe, {
      meta: { contentType: 'image/jpeg', filename: 'shot.jpg' },
    });
    assert.ok(match?.matched, 'screenshot should match');
  });

  it('detects collage containing the target', async () => {
    const tile = await sharp(targetBuf).resize(200, 200, { fit: 'cover' }).jpeg().toBuffer();
    const other = await solidJpeg({ r: 200, g: 40, b: 80 }, 200, 200);
    const probe = await sharp({
      create: {
        width: 400,
        height: 400,
        channels: 3,
        background: { r: 10, g: 10, b: 10 },
      },
    })
      .composite([
        { input: other, top: 0, left: 0 },
        { input: tile, top: 0, left: 200 },
        { input: other, top: 200, left: 0 },
        { input: tile, top: 200, left: 200 },
      ])
      .jpeg()
      .toBuffer();
    const match = await matchAgainstTargets(guildId, probe, {
      meta: { contentType: 'image/jpeg', filename: 'collage.jpg' },
    });
    assert.ok(match?.matched, 'collage should match');
  });

  it('detects 90° rotated target', async () => {
    const probe = await sharp(targetBuf).rotate(90).jpeg().toBuffer();
    const match = await matchAgainstTargets(guildId, probe, {
      meta: { contentType: 'image/jpeg', filename: 'rot.jpg' },
    });
    assert.ok(match?.matched, 'rotate-90 should match');
  });

  it('rejects unrelated solid image', async () => {
    const probe = await solidJpeg({ r: 10, g: 200, b: 10 }, 200, 200);
    const match = await matchAgainstTargets(guildId, probe, {
      meta: { contentType: 'image/jpeg', filename: 'x.jpg' },
    });
    assert.ok(!match?.matched);
  });

  it('test diagnostics include V3 fields', async () => {
    const probe = await sharp(targetBuf).flop().modulate({ brightness: 0.85 }).jpeg().toBuffer();
    const result = await testAgainstTargets(guildId, probe, {
      meta: { contentType: 'image/jpeg', filename: 'diag.jpg' },
    });
    assert.ok(result.results?.length);
    const top = result.top || result.results[0];
    assert.ok(top.localScores);
    // PDQ should be present on V3 fingerprints
    assert.ok(
      top.localScores.pdqHash != null || top.diagnostics?.deepScan != null,
    );
  });
});

describe('V3 lab', () => {
  it('runs self-attack lab and reports detected/missed', async () => {
    const guildId = `lab-${Date.now()}`;
    const buf = await patternTarget();
    await addAnalyzed(guildId, buf, 'LabTarget');
    const lab = await runImageTargetLab(guildId, {
      targetName: 'LabTarget',
      sourceBuffer: buf,
    });
    assert.ok(lab.ok);
    assert.ok(lab.tests >= 20, `tests=${lab.tests}`);
    assert.ok(lab.detected >= 15, `detected=${lab.detected}/${lab.tests}`);
    assert.ok(lab.reportText.includes('IMAGE TARGET LAB'));
    const formatted = formatLabReport(lab);
    assert.ok(formatted.includes('DETECTED'));
  });

  it('generateLabAttacks stays bounded', async () => {
    const buf = await patternTarget();
    const attacks = await generateLabAttacks(buf);
    assert.ok(attacks.length >= 20);
    assert.ok(attacks.length <= 40);
    assert.ok(IMAGE_TARGET_MAX_REGIONS <= 24);
  });
});

describe('V3 guild isolation + V1 compat', () => {
  it('keeps guild isolation', async () => {
    const a = `iso-a-${Date.now()}`;
    const b = `iso-b-${Date.now()}`;
    const buf = await patternTarget();
    await addAnalyzed(a, buf, 'A');
    const matchB = await matchAgainstTargets(b, buf, {
      meta: { contentType: 'image/jpeg', filename: 'x.jpg' },
    });
    assert.equal(matchB, null);
    const matchA = await matchAgainstTargets(a, buf, {
      meta: { contentType: 'image/jpeg', filename: 'x.jpg' },
    });
    assert.ok(matchA?.matched);
  });

  it('still matches V1-style single-hash targets', async () => {
    const guildId = `v1-${Date.now()}`;
    const buf = await patternTarget();
    const fp = await fingerprintImage(buf);
    await addTarget(guildId, {
      name: 'legacy',
      perceptualHash: fp.dHash,
      blockHash: fp.blockHash,
      contentHash: fp.contentHash,
      createdBy: 'test',
      fingerprintVersion: 1,
    });
    const match = await matchAgainstTargets(guildId, buf, {
      meta: { contentType: 'image/jpeg', filename: 'x.jpg' },
    });
    assert.ok(match?.matched);
  });
});
