/**
 * Video perceptual hash + ordered frame sequence matching (Image Target V3).
 *
 * VideoHash: folded temporal fingerprint from sampled frame pHashes.
 * Sequence match: detect ordered subsequences (trimmed / clipped / speed-changed).
 */

import { computePHash, hammingDistance, hammingSimilarity } from './fingerprints.js';

/**
 * Fold ordered frame hashes into a 64-bit video hash (16 hex).
 * Robust-ish to minor frame drops via majority-ish XOR/rotate mix.
 */
export function foldVideoHash(frameHashHexList) {
  if (!frameHashHexList?.length) return null;
  const bits = new Array(64).fill(0);
  for (let fi = 0; fi < frameHashHexList.length; fi++) {
    const hex = frameHashHexList[fi];
    if (!hex || hex.length < 16) continue;
    for (let i = 0; i < 16; i++) {
      const nibble = parseInt(hex[i], 16);
      for (let b = 0; b < 4; b++) {
        const bit = (nibble >> (3 - b)) & 1;
        const idx = (i * 4 + b + fi * 7) % 64;
        bits[idx] += bit ? 1 : -1;
      }
    }
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    const nibble =
      ((bits[i] > 0 ? 1 : 0) << 3) |
      ((bits[i + 1] > 0 ? 1 : 0) << 2) |
      ((bits[i + 2] > 0 ? 1 : 0) << 1) |
      (bits[i + 3] > 0 ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

export async function computeVideoHashFromFrames(frameBuffers) {
  const hashes = [];
  for (const buf of frameBuffers) {
    try {
      hashes.push(await computePHash(buf));
    } catch {
      // skip bad frame
    }
  }
  return {
    videoHash: foldVideoHash(hashes),
    frameHashes: hashes,
  };
}

/**
 * Longest ordered matching subsequence between target and candidate frame hashes.
 * Allows small Hamming gaps (transcode / compression).
 *
 * @returns {{ score, overlap, matchedPairs, length }}
 */
export function matchFrameSequence(targetHashes, candidateHashes, {
  maxHamming = 12,
} = {}) {
  const T = (targetHashes || []).filter(Boolean);
  const C = (candidateHashes || []).filter(Boolean);
  if (T.length < 2 || C.length < 2) {
    return { score: 0, overlap: 0, matchedPairs: 0, length: 0 };
  }

  // DP for longest nearly-matching increasing subsequence length.
  const dp = Array.from({ length: T.length }, () => new Array(C.length).fill(0));
  let best = 0;
  for (let i = 0; i < T.length; i++) {
    for (let j = 0; j < C.length; j++) {
      const dist = hammingDistance(T[i], C[j]);
      const hit = Number.isFinite(dist) && dist <= maxHamming ? 1 : 0;
      let prev = 0;
      if (i > 0 && j > 0) prev = dp[i - 1][j - 1];
      // Allow skipping one frame on either side.
      if (i > 1 && j > 0) prev = Math.max(prev, dp[i - 2][j - 1]);
      if (i > 0 && j > 1) prev = Math.max(prev, dp[i - 1][j - 2]);
      dp[i][j] = hit ? prev + 1 : Math.max(i > 0 ? dp[i - 1][j] : 0, j > 0 ? dp[i][j - 1] : 0);
      if (dp[i][j] > best) best = dp[i][j];
    }
  }

  const denom = Math.min(T.length, C.length);
  const overlap = denom > 0 ? best / denom : 0;
  // Sequence evidence is strong when ≥3 ordered hits or ≥50% overlap.
  let score = overlap;
  if (best >= 3) score = Math.min(1, 0.5 + overlap * 0.5);
  else if (best === 2) score = Math.min(0.75, overlap * 0.85);

  return { score, overlap, matchedPairs: best, length: denom };
}

export function videoHashSimilarity(a, b) {
  return hammingSimilarity(a, b);
}
