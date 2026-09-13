import { log } from '../../logger.js';
import {
  CANDIDATE_HAMMING,
  OBVIOUS_MATCH_HAMMING,
} from './constants.js';
import { fingerprintImage, hammingDistance } from './phash.js';
import { getJinaProvider } from './providers/jina.js';
import { cosineSimilarity } from './providers/types.js';
import { effectiveThreshold, listTargets } from './store.js';

/**
 * Two-stage image target detector:
 *
 *   IMAGE → pHash / blockHash
 *            ├─ Hamming ≤ OBVIOUS  → MATCH (no API call)
 *            ├─ Hamming ≤ CANDIDATE → Jina embedding cosine similarity
 *            └─ else → NO MATCH
 *
 * If Jina is missing/rate-limited/failing, an obvious pHash hit still matches;
 * a merely-candidate hit without Jina does NOT match (avoids false positives).
 */

/**
 * Build fingerprints (+ optional embedding) for a newly uploaded target.
 */
export async function analyzeTargetBuffer(buffer, { withEmbedding = true } = {}) {
  const fp = await fingerprintImage(buffer);
  let embedding = null;
  let embeddingModel = null;

  if (withEmbedding) {
    const jina = getJinaProvider();
    if (jina.available) {
      try {
        embedding = await jina.generateEmbedding(buffer, { cacheKey: fp.contentHash });
        embeddingModel = jina.name;
      } catch (err) {
        log.warn('[image-target] embedding on add failed:', err.message);
      }
    }
  }

  return { ...fp, embedding, embeddingModel };
}

function localDistances(fp, target) {
  const dDist = target.perceptualHash
    ? hammingDistance(fp.dHash, target.perceptualHash)
    : Number.POSITIVE_INFINITY;
  const bDist = target.blockHash
    ? hammingDistance(fp.blockHash, target.blockHash)
    : Number.POSITIVE_INFINITY;
  // Scale 256-bit block distance into a 64-bit-ish range for shared thresholds.
  const scaledBlock = Number.isFinite(bDist) ? bDist / 4 : Number.POSITIVE_INFINITY;
  const bestLocal = Math.min(dDist, scaledBlock);
  return { dDist, bDist, bestLocal };
}

/**
 * Compare a candidate image buffer against all enabled targets in a guild.
 * @returns {null | object} strongest match above threshold, or null
 */
export async function matchAgainstTargets(guildId, buffer) {
  const targets = await listTargets(guildId, { includeDisabled: false });
  if (!targets.length) return null;

  const fp = await fingerprintImage(buffer);

  // Exact byte match short-circuit.
  for (const t of targets) {
    if (t.contentHash && t.contentHash === fp.contentHash) {
      return {
        target: t,
        score: 1,
        method: 'exact',
        dHashDistance: 0,
        blockHashDistance: 0,
        usedJina: false,
      };
    }
  }

  const scored = targets.map((target) => ({ target, ...localDistances(fp, target) }));
  scored.sort((a, b) => a.bestLocal - b.bestLocal);
  const best = scored[0];
  if (!best || !Number.isFinite(best.bestLocal)) return null;

  // Obvious local match — skip Jina.
  if (best.bestLocal <= OBVIOUS_MATCH_HAMMING) {
    const score = Math.max(0.95, 1 - best.bestLocal / 64);
    return {
      target: best.target,
      score,
      method: 'phash',
      dHashDistance: best.dDist,
      blockHashDistance: best.bDist,
      usedJina: false,
    };
  }

  // Clearly unrelated — stop. Do not burn API quota.
  if (best.bestLocal > CANDIDATE_HAMMING) {
    return null;
  }

  // Stage 2: Jina for the ambiguous band.
  const candidates = scored.filter((s) => s.bestLocal <= CANDIDATE_HAMMING);
  const jina = getJinaProvider();
  if (!jina.available) {
    return null;
  }

  let candidateEmbedding;
  try {
    candidateEmbedding = await jina.generateEmbedding(buffer, {
      cacheKey: fp.contentHash,
    });
  } catch (err) {
    log.warn('[image-target] Jina embed failed:', err.message);
    return null;
  }

  let bestEmb = null;
  for (const c of candidates) {
    const targetEmb = c.target.embedding;
    if (!targetEmb?.length) continue;
    const sim = cosineSimilarity(targetEmb, candidateEmbedding);
    if (!bestEmb || sim > bestEmb.score) {
      bestEmb = {
        target: c.target,
        score: sim,
        method: 'embedding',
        dHashDistance: c.dDist,
        blockHashDistance: c.bDist,
        usedJina: true,
      };
    }
  }

  if (!bestEmb) return null;
  const threshold = await effectiveThreshold(guildId, bestEmb.target);
  if (bestEmb.score >= threshold) return bestEmb;
  return null;
}

/**
 * Dry-run compare for /image-target test — returns strongest scores even
 * when below threshold (so admins can tune).
 */
export async function testAgainstTargets(guildId, buffer) {
  const targets = await listTargets(guildId, { includeDisabled: false });
  if (!targets.length) {
    return { match: false, results: [], message: 'No enabled targets in this server.' };
  }

  const fp = await fingerprintImage(buffer);
  const jina = getJinaProvider();
  let candidateEmbedding = null;
  let jinaError = null;

  const results = targets.map((t) => {
    const { dDist, bDist, bestLocal } = localDistances(fp, t);
    return {
      target: t,
      dHashDistance: Number.isFinite(dDist) ? dDist : null,
      blockHashDistance: Number.isFinite(bDist) ? bDist : null,
      localScore: Number.isFinite(bestLocal) ? Math.max(0, 1 - bestLocal / 64) : 0,
      bestLocal,
      embeddingScore: null,
      finalScore: null,
      method: null,
      matched: false,
    };
  });

  const needsJina = results.some(
    (r) => r.bestLocal <= CANDIDATE_HAMMING && r.target.embedding?.length,
  );

  if (needsJina && jina.available) {
    try {
      candidateEmbedding = await jina.generateEmbedding(buffer, {
        cacheKey: fp.contentHash,
      });
    } catch (err) {
      jinaError = err.message;
    }
  }

  for (const r of results) {
    const threshold = await effectiveThreshold(guildId, r.target);

    if (r.target.contentHash && r.target.contentHash === fp.contentHash) {
      r.finalScore = 1;
      r.method = 'exact';
      r.matched = true;
      continue;
    }

    if (r.bestLocal <= OBVIOUS_MATCH_HAMMING) {
      r.finalScore = Math.max(r.localScore, 0.95);
      r.method = 'phash';
      r.matched = r.finalScore >= threshold;
      continue;
    }

    if (
      candidateEmbedding &&
      r.target.embedding?.length &&
      r.bestLocal <= CANDIDATE_HAMMING
    ) {
      r.embeddingScore = cosineSimilarity(r.target.embedding, candidateEmbedding);
      r.finalScore = r.embeddingScore;
      r.method = 'embedding';
      r.matched = r.finalScore >= threshold;
      continue;
    }

    r.finalScore = r.localScore;
    r.method = 'phash';
    r.matched = false;
  }

  results.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
  const top = results[0] || null;
  return {
    match: Boolean(top?.matched),
    results,
    top,
    jinaAvailable: jina.available,
    jinaError,
    fingerprint: {
      dHash: fp.dHash,
      blockHash: fp.blockHash,
      contentHash: fp.contentHash,
    },
  };
}
