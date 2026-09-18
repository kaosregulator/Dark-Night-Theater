import {
  LOCAL_CANDIDATE_SIMILARITY,
  LOCAL_OBVIOUS_SIMILARITY,
  LOCAL_SKIP_SIMILARITY,
} from './constants.js';
import { localSimilarity } from './fingerprints.js';

/**
 * Score aggregation for Image Target V2.
 *
 * For each (target × frame × variant × fingerprint) comparison we compute
 * local ensemble similarity, optionally blend with Jina cosine similarity,
 * then take the strongest evidence across frames/variants as the media score.
 */

/**
 * Compare one candidate fingerprint against one target fingerprint record.
 */
export function scoreFingerprintPair(candidateFp, targetFp) {
  const local = localSimilarity(candidateFp, targetFp);
  return {
    localScore: local.score,
    localScores: local.scores,
    dHashDistance: local.scores.dHash > 0
      ? Math.round((1 - local.scores.dHash) * 64)
      : null,
    blockHashDistance: local.scores.blockHash > 0
      ? Math.round((1 - local.scores.blockHash) * 256)
      : null,
  };
}

/**
 * Decide whether local evidence is enough / needs embedding / should skip.
 */
export function classifyLocalEvidence(localScore) {
  if (localScore >= LOCAL_OBVIOUS_SIMILARITY) return 'obvious';
  if (localScore < LOCAL_SKIP_SIMILARITY) return 'skip';
  if (localScore >= LOCAL_CANDIDATE_SIMILARITY) return 'candidate';
  // Soft band: still allow Jina for edited images that hash poorly.
  return 'uncertain';
}

/**
 * Combine local + embedding into a final confidence.
 * Embedding dominates when present; local provides floor for obvious matches.
 */
export function combineScores({ localScore, embeddingScore = null, exact = false }) {
  if (exact) {
    return { finalScore: 1, method: 'exact' };
  }
  if (embeddingScore != null && Number.isFinite(embeddingScore)) {
    // Blend lightly so strong local evidence can still surface near Jina.
    const finalScore = Math.max(
      embeddingScore,
      localScore >= LOCAL_OBVIOUS_SIMILARITY
        ? Math.max(localScore, 0.95)
        : embeddingScore * 0.85 + localScore * 0.15,
    );
    return {
      finalScore: Math.min(1, finalScore),
      method: localScore >= LOCAL_OBVIOUS_SIMILARITY ? 'jina+local' : 'jina',
    };
  }
  if (localScore >= LOCAL_OBVIOUS_SIMILARITY) {
    return {
      finalScore: Math.max(localScore, 0.95),
      method: 'phash',
    };
  }
  return {
    finalScore: localScore,
    method: 'phash',
  };
}

/**
 * Keep the strongest evidence row for a target across frames/variants.
 */
export function pickStrongest(evidenceRows) {
  if (!evidenceRows?.length) return null;
  return evidenceRows.reduce((best, row) => {
    const b = best?.finalScore ?? -1;
    const r = row?.finalScore ?? -1;
    return r > b ? row : best;
  }, null);
}

/**
 * Build a human-readable detection method string for logs / test UI.
 */
export function describeMethod(row) {
  if (!row) return '—';
  if (row.method === 'exact') return 'exact';
  const parts = [];
  if (row.embeddingScore != null) parts.push('Jina');
  const locals = row.localScores || {};
  const topLocal = Object.entries(locals)
    .filter(([, v]) => v != null)
    .sort((a, b) => b[1] - a[1])[0];
  if (topLocal) parts.push(topLocal[0]);
  else if (row.method === 'phash') parts.push('pHash');
  return parts.join(' + ') || row.method || '—';
}

/**
 * Format a test/debug report block for one target result.
 */
export function formatTestResult(row) {
  if (!row) return '';
  const lines = [
    `Target: ${row.target?.name || '—'}`,
    `Final Score: ${(row.finalScore ?? 0).toFixed(2)}`,
    `Method: ${describeMethod(row)}`,
  ];
  if (row.mediaKind) lines.push(`Media: ${String(row.mediaKind).toUpperCase()}`);
  if (row.frameIndex != null) lines.push(`Matching Frame: ${row.frameIndex}`);
  if (row.timestampSec != null && Number.isFinite(row.timestampSec)) {
    lines.push(`Timestamp: ${row.timestampSec.toFixed(1)}s`);
  }
  if (row.variantKey) lines.push(`Variant: ${row.variantKey}`);
  lines.push('');
  lines.push('Local:');
  const ls = row.localScores || {};
  if (ls.pHash != null) lines.push(`pHash: ${ls.pHash.toFixed(2)}`);
  if (ls.dHash != null) lines.push(`dHash: ${ls.dHash.toFixed(2)}`);
  if (ls.aHash != null) lines.push(`aHash: ${ls.aHash.toFixed(2)}`);
  if (ls.blockHash != null) lines.push(`Block: ${ls.blockHash.toFixed(2)}`);
  if (ls.edgeHash != null) lines.push(`Edge: ${ls.edgeHash.toFixed(2)}`);
  lines.push('');
  lines.push('Jina:');
  lines.push(
    row.embeddingScore != null ? row.embeddingScore.toFixed(2) : 'n/a',
  );
  lines.push('');
  lines.push('Decision:');
  lines.push(row.matched ? 'MATCH' : 'NO MATCH');
  return lines.join('\n');
}
