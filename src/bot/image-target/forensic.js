/**
 * V3 forensic deep extras — regions, screenshot strip, features, sequence.
 * Called only during deep scan to keep the quick path fast.
 */

import {
  IMAGE_TARGET_FEATURES_ENABLED,
  IMAGE_TARGET_MAX_ADAPTIVE_CROPS,
  IMAGE_TARGET_MAX_REGIONS,
} from './constants.js';
import { fingerprintImage } from './fingerprints.js';
import { generateAdaptiveCrops, generateCollageRegions, estimateContentOverlap } from './regions.js';
import { stripScreenshotChrome } from './screenshot.js';
import { matchFrameSequence, foldVideoHash, videoHashSimilarity } from './videohash.js';
import { scoreFingerprintPair } from './scoring.js';

/**
 * Build extra forensic analysis units (regions + screenshot strips).
 */
export async function buildForensicUnits(frameBuffer, {
  mediaKind = 'image',
  frameIndex = 0,
  timestampSec = 0,
  sourceContentHash = null,
} = {}) {
  const units = [];
  const maxRegions = IMAGE_TARGET_MAX_REGIONS;
  const maxCrops = IMAGE_TARGET_MAX_ADAPTIVE_CROPS;

  const [regions, crops, shot] = await Promise.all([
    generateCollageRegions(frameBuffer, { maxRegions: Math.min(10, maxRegions) }),
    generateAdaptiveCrops(frameBuffer, { maxCrops }),
    stripScreenshotChrome(frameBuffer, { maxCandidates: 3 }),
  ]);

  const extras = [
    ...regions,
    ...crops,
    ...(shot.candidates || []),
  ].slice(0, maxRegions + maxCrops);

  for (const extra of extras) {
    const withFeatures =
      IMAGE_TARGET_FEATURES_ENABLED &&
      (extra.key.startsWith('region-') ||
        extra.key.startsWith('screenshot-') ||
        extra.key.startsWith('crop-50') ||
        extra.key === 'tile-2x2-tl');
    try {
      const fp = await fingerprintImage(extra.buffer, { withFeatures });
      units.push({
        mediaKind,
        frameIndex,
        timestampSec,
        variantKey: extra.key,
        buffer: extra.buffer,
        fingerprint: fp,
        sourceContentHash,
        deep: true,
        forensic: true,
      });
    } catch {
      // skip bad region
    }
  }

  return units;
}

/**
 * Score sequence + videoHash signals for animated media.
 */
export function scoreTemporalEvidence(candidateUnits, targetFingerprints) {
  const candHashes = [];
  const seenFrames = new Set();
  for (const u of candidateUnits) {
    if (seenFrames.has(u.frameIndex)) continue;
    if (u.variantKey !== 'original' && u.variantKey !== 'grayscale-normalized') continue;
    seenFrames.add(u.frameIndex);
    if (u.fingerprint?.pHash) candHashes.push(u.fingerprint.pHash);
  }

  const tgtHashes = [];
  const seenT = new Set();
  for (const fp of targetFingerprints || []) {
    const key = `${fp.frameIndex}:${fp.variantKey}`;
    if (seenT.has(fp.frameIndex)) continue;
    if (fp.variantKey && fp.variantKey !== 'original') continue;
    seenT.add(fp.frameIndex);
    if (fp.pHash) tgtHashes.push(fp.pHash);
  }

  const sequence = matchFrameSequence(tgtHashes, candHashes);
  const candVideo = foldVideoHash(candHashes);
  const tgtVideo =
    targetFingerprints?.find((f) => f.videoHash)?.videoHash ||
    foldVideoHash(tgtHashes);
  const videoHashScore = videoHashSimilarity(candVideo, tgtVideo);

  return {
    sequenceScore: sequence.score,
    sequenceMatches: sequence.matchedPairs,
    sequenceOverlap: sequence.overlap,
    videoHashScore,
    candidateVideoHash: candVideo,
    targetVideoHash: tgtVideo,
  };
}

/**
 * Enrich a best local pair with mirror / PDQ / feature / region signals.
 */
export function enrichPairSignals(bestLocal, allPairsForTarget = []) {
  const ls = bestLocal?.localScores || {};
  const mirrorPairs = allPairsForTarget.filter((p) =>
    String(p.unit?.variantKey || '').includes('flip-h') ||
    String(p.unit?.variantKey || '') === 'mirror',
  );
  const normalPairs = allPairsForTarget.filter(
    (p) => !String(p.unit?.variantKey || '').includes('flip'),
  );
  const mirrorScore = mirrorPairs.reduce(
    (m, p) => Math.max(m, p.local?.localScore || 0),
    0,
  );
  const normalScore = normalPairs.reduce(
    (m, p) => Math.max(m, p.local?.localScore || 0),
    bestLocal?.localScore || 0,
  );

  const regionPairs = allPairsForTarget.filter((p) => {
    const k = String(p.unit?.variantKey || '');
    return (
      k.startsWith('tile-') ||
      k.startsWith('crop-') ||
      k.startsWith('region-') ||
      k.startsWith('screenshot-') ||
      k.startsWith('zoom-')
    );
  });
  let regionScore = 0;
  let regionKey = '';
  for (const p of regionPairs) {
    const s = p.local?.localScore || 0;
    if (s > regionScore) {
      regionScore = s;
      regionKey = p.unit?.variantKey || '';
    }
  }
  const fullScore = normalScore;
  const contentOverlap = estimateContentOverlap({
    bestRegionScore: regionScore,
    fullScore,
    regionKey,
  });

  return {
    pdqScore: ls.pdqHash || 0,
    colorScore: ls.colorHash || 0,
    featureScore: bestLocal?.featureScore || ls.features || 0,
    featureMatches: bestLocal?.featureMatches || 0,
    mirrorScore,
    normalScore,
    regionScore,
    regionKey,
    contentOverlap,
  };
}

/**
 * Re-score units; return flat list of { unit, tfp, local } for one target.
 */
export function pairUnitsToTarget(units, targetFingerprints) {
  const pairs = [];
  for (const unit of units) {
    for (const tfp of targetFingerprints) {
      const local = scoreFingerprintPair(unit.fingerprint, tfp);
      local.featureScore = local.localScores?.features;
      // Pull feature stats from localSimilarity via scores object if present.
      pairs.push({ unit, tfp, local });
    }
  }
  pairs.sort((a, b) => (b.local.localScore || 0) - (a.local.localScore || 0));
  return pairs;
}
