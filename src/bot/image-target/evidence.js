/**
 * Evidence fusion for Image Target V3 Forensic Engine.
 *
 * Combines independent signals: hash ensemble, PDQ, color, local features,
 * video hash, sequence match, region/partial overlap, mirror, Jina.
 */

import { LOCAL_OBVIOUS_SIMILARITY } from './constants.js';

/**
 * Fuse multi-signal evidence into a final score + method label.
 */
export function fuseEvidence({
  localScore = 0,
  localScores = {},
  featureScore = 0,
  featureMatches = 0,
  pdqScore = 0,
  colorScore = 0,
  videoHashScore = 0,
  sequenceScore = 0,
  sequenceMatches = 0,
  regionScore = 0,
  contentOverlap = 0,
  mirrorScore = 0,
  embeddingScore = null,
  exact = false,
} = {}) {
  if (exact) {
    return {
      finalScore: 1,
      method: 'exact',
      signals: { exact: 1 },
    };
  }

  const signals = {
    local: localScore,
    pdq: pdqScore,
    color: colorScore,
    features: featureScore,
    videoHash: videoHashScore,
    sequence: sequenceScore,
    region: regionScore,
    overlap: contentOverlap,
    mirror: mirrorScore,
    jina: embeddingScore,
  };

  // Structural core (ignore color alone — grayscale attacks).
  const structural = Math.max(
    localScore,
    pdqScore * 0.98,
    featureScore,
    regionScore,
    sequenceScore,
    videoHashScore * 0.95,
    mirrorScore,
  );

  let finalScore = structural;
  const parts = [];

  if (featureScore >= 0.55 && featureMatches >= 8) {
    finalScore = Math.max(finalScore, featureScore);
    parts.push('ORB');
  }
  if (sequenceScore >= 0.55 && sequenceMatches >= 2) {
    finalScore = Math.max(finalScore, sequenceScore);
    parts.push('sequence');
  }
  if (videoHashScore >= 0.75) {
    finalScore = Math.max(finalScore, videoHashScore);
    parts.push('videoHash');
  }
  if (regionScore >= 0.7 || contentOverlap >= 0.65) {
    finalScore = Math.max(finalScore, Math.max(regionScore, contentOverlap * 0.95));
    parts.push('partial');
  }
  if (pdqScore >= 0.8) {
    finalScore = Math.max(finalScore, pdqScore);
    parts.push('PDQ');
  }
  if (mirrorScore > localScore + 0.05) {
    finalScore = Math.max(finalScore, mirrorScore);
    parts.push('mirror');
  }

  if (embeddingScore != null && Number.isFinite(embeddingScore)) {
    finalScore = Math.max(
      embeddingScore,
      localScore >= LOCAL_OBVIOUS_SIMILARITY
        ? Math.max(finalScore, 0.95)
        : embeddingScore * 0.8 + finalScore * 0.2,
    );
    parts.push('Jina');
  } else if (localScore >= LOCAL_OBVIOUS_SIMILARITY) {
    finalScore = Math.max(finalScore, localScore, 0.95);
    parts.push('local');
  } else if (parts.length === 0 && localScore > 0) {
    parts.push('local');
  }

  // Mild color agreement boost when structural already plausible.
  if (colorScore >= 0.7 && finalScore >= 0.55) {
    finalScore = Math.min(1, finalScore + 0.02);
  }

  // Content-overlap annotation for partial matches.
  const overlap =
    contentOverlap > 0
      ? contentOverlap
      : regionScore > localScore
        ? regionScore
        : null;

  return {
    finalScore: Math.min(1, finalScore),
    method: parts.join('+') || 'local',
    signals,
    contentOverlap: overlap,
    structural,
  };
}

/**
 * Explicit mirror signal: compare normal vs flip-h best.
 */
export function mirrorSignal({ normalScore = 0, mirrorScore = 0 } = {}) {
  const best = Math.max(normalScore, mirrorScore);
  return {
    normalScore,
    mirrorScore,
    bestSimilarity: best,
    mirroredBetter: mirrorScore > normalScore + 0.03,
  };
}
