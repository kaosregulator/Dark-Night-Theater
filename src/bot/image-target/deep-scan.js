import {
  DEEP_RELEVANCE_CHANNEL_MIN,
  FRAME_DEDUP_HAMMING,
  LOCAL_CANDIDATE_SIMILARITY,
  LOCAL_OBVIOUS_SIMILARITY,
  LOCAL_SKIP_SIMILARITY,
} from './constants.js';
import { hammingDistance } from './fingerprints.js';

/**
 * Image Target V2.1 — adaptive deep-scan helpers.
 *
 * Quick scan stays cheap. Deep scan escalates only for uncertain / suspicious
 * media (edited, screenshot-like, mid-animation hits the sampler missed).
 */

/**
 * Cheap preliminary relevance: distinguish "clearly unrelated" from
 * "heavily edited but still weakly related on one channel".
 */
export function preliminaryRelevance(localScores = {}, localScore = 0) {
  if (localScore >= LOCAL_SKIP_SIMILARITY) return true;
  const vals = Object.values(localScores).filter((v) => Number.isFinite(v));
  if (!vals.length) return false;
  return Math.max(...vals) >= DEEP_RELEVANCE_CHANNEL_MIN;
}

/**
 * Multi-signal deep-scan trigger.
 * @returns {{ escalate: boolean, reason: string|null }}
 */
export function shouldEscalateToDeepScan({
  band,
  localScore = 0,
  localScores = {},
  matched = false,
  mediaKind = 'image',
  jinaAvailable = false,
  embeddingScore = null,
  threshold = 0.9,
} = {}) {
  if (matched) return { escalate: false, reason: null };
  if (band === 'obvious' || localScore >= LOCAL_OBVIOUS_SIMILARITY) {
    return { escalate: false, reason: null };
  }

  // Near-miss on embedding during quick pass → deepen sampling/variants.
  if (
    embeddingScore != null &&
    embeddingScore >= threshold * 0.85 &&
    embeddingScore < threshold
  ) {
    return { escalate: true, reason: 'jina_near_miss' };
  }

  if (band === 'candidate') {
    return { escalate: true, reason: 'local_candidate_band' };
  }

  if (band === 'uncertain') {
    return { escalate: true, reason: 'local_uncertain_band' };
  }

  // Soft-skip with a weak channel hint → likely heavily edited, not unrelated.
  if (band === 'skip' && preliminaryRelevance(localScores, localScore)) {
    return { escalate: true, reason: 'edited_relevance_hint' };
  }

  // Animated / video with middling local evidence always worth a denser pass
  // when Jina can verify (or dry-run diagnostics).
  if (
    (mediaKind === 'gif' || mediaKind === 'apng' || mediaKind === 'video' || mediaKind === 'animated') &&
    localScore >= LOCAL_SKIP_SIMILARITY * 0.75 &&
    localScore < LOCAL_CANDIDATE_SIMILARITY
  ) {
    return {
      escalate: true,
      reason: jinaAvailable ? 'animated_sparse_sample' : 'animated_sparse_sample_local',
    };
  }

  return { escalate: false, reason: null };
}

/**
 * Collapse near-duplicate frames using a cheap hash (typically dHash).
 * Keeps the first occurrence of each visual cluster.
 */
export function collapseNearDuplicateFrames(frames, {
  hammingThreshold = FRAME_DEDUP_HAMMING,
  hashKey = 'cheapHash',
} = {}) {
  if (!frames?.length) return [];
  const kept = [];
  for (const frame of frames) {
    const hash = frame[hashKey];
    if (!hash) {
      kept.push(frame);
      continue;
    }
    const dup = kept.some((k) => {
      const kh = k[hashKey];
      if (!kh) return false;
      return hammingDistance(kh, hash) <= hammingThreshold;
    });
    if (!dup) kept.push(frame);
  }
  return kept;
}

/**
 * Subdivide intervals between existing timestamps for a denser second pass.
 * Always includes midpoints; for short videos also adds quarter points.
 */
export function pickDeepTimestamps(durationSec, alreadySampled = [], maxAdditional = 8) {
  const dur = Math.max(0, Number(durationSec) || 0);
  if (dur <= 0 || maxAdditional <= 0) return [];

  const end = Math.max(0, dur * 0.98);
  const existing = [...new Set(
    (alreadySampled || [])
      .map(Number)
      .filter((t) => Number.isFinite(t) && t >= 0),
  )].sort((a, b) => a - b);

  if (!existing.length) {
    existing.push(0, end / 2, end);
  } else {
    if (existing[0] > 0.05) existing.unshift(0);
    if (existing[existing.length - 1] < end - 0.05) existing.push(end);
  }

  const short = dur <= 8;
  const candidates = [];
  for (let i = 0; i < existing.length - 1; i++) {
    const a = existing[i];
    const b = existing[i + 1];
    const mid = (a + b) / 2;
    candidates.push(mid);
    if (short) {
      candidates.push(a + (b - a) * 0.25);
      candidates.push(a + (b - a) * 0.75);
    }
  }

  const taken = new Set(existing.map((t) => t.toFixed(3)));
  const out = [];
  for (const t of candidates.sort((a, b) => a - b)) {
    const key = t.toFixed(3);
    if (taken.has(key)) continue;
    // Skip if too close to an existing sample (< 120ms).
    if (existing.some((e) => Math.abs(e - t) < 0.12)) continue;
    taken.add(key);
    out.push(Math.min(end, Math.max(0, t)));
    if (out.length >= maxAdditional) break;
  }
  return out;
}

/**
 * Prefer frame indices not already sampled; denser for short GIFs.
 */
export function pickDeepFrameIndices(total, already = [], maxAdditional = 8) {
  const n = Math.max(0, Math.floor(total));
  if (n <= 0 || maxAdditional <= 0) return [];
  const have = new Set(already.map((i) => Number(i)).filter((i) => Number.isFinite(i)));

  // Short animations: fill every missing frame.
  if (n <= maxAdditional + have.size) {
    const missing = [];
    for (let i = 0; i < n; i++) {
      if (!have.has(i)) missing.push(i);
    }
    return missing.slice(0, maxAdditional);
  }

  // Midpoint subdivision of gaps between sampled indices.
  const sorted = [...have].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  if (!sorted.includes(0)) sorted.unshift(0);
  if (!sorted.includes(n - 1)) sorted.push(n - 1);

  const candidates = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b - a <= 1) continue;
    candidates.push(Math.floor((a + b) / 2));
    if (b - a >= 4) {
      candidates.push(Math.floor(a + (b - a) / 4));
      candidates.push(Math.floor(a + (3 * (b - a)) / 4));
    }
  }

  const out = [];
  const seen = new Set(have);
  for (const idx of candidates.sort((a, b) => a - b)) {
    if (seen.has(idx) || idx < 0 || idx >= n) continue;
    seen.add(idx);
    out.push(idx);
    if (out.length >= maxAdditional) break;
  }
  return out;
}

/**
 * Build a diagnostics object for /image-target test output.
 */
export function buildDeepScanDiagnostics({
  deepScan = false,
  reason = null,
  framesSampled = 0,
  framesDeepAnalyzed = 0,
  variantsAnalyzed = 0,
  jinaCalls = 0,
  framesDeduped = 0,
} = {}) {
  return {
    deepScan: Boolean(deepScan),
    reason: reason || null,
    framesSampled,
    framesDeepAnalyzed,
    variantsAnalyzed,
    jinaCalls,
    framesDeduped,
  };
}
