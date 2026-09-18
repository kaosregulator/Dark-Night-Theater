import {
  LOCAL_CANDIDATE_SIMILARITY,
  LOCAL_OBVIOUS_SIMILARITY,
  LOCAL_SKIP_SIMILARITY,
} from './constants.js';
import { localSimilarity } from './fingerprints.js';

/**
 * Score aggregation for Image Target V2 / V2.1.
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

export function classifyLocalEvidence(localScore) {
  if (localScore >= LOCAL_OBVIOUS_SIMILARITY) return 'obvious';
  if (localScore < LOCAL_SKIP_SIMILARITY) return 'skip';
  if (localScore >= LOCAL_CANDIDATE_SIMILARITY) return 'candidate';
  return 'uncertain';
}

export function combineScores({ localScore, embeddingScore = null, exact = false }) {
  if (exact) {
    return { finalScore: 1, method: 'exact' };
  }
  if (embeddingScore != null && Number.isFinite(embeddingScore)) {
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

export function pickStrongest(evidenceRows) {
  if (!evidenceRows?.length) return null;
  return evidenceRows.reduce((best, row) => {
    const b = best?.finalScore ?? -1;
    const r = row?.finalScore ?? -1;
    return r > b ? row : best;
  }, null);
}

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
  if (row.deepScan) parts.push('deep');
  return parts.join(' + ') || row.method || '—';
}

/**
 * Format a test/debug report block for one target result (V2.1 diagnostics).
 */
export function formatTestResult(row, diagnostics = null) {
  if (!row) return '';
  const diag = diagnostics || row.diagnostics || {};
  const lines = [
    `Target: ${row.target?.name || '—'}`,
    `Media: ${String(row.mediaKind || diag.mediaKind || '—').toUpperCase()}`,
    `Final Score: ${(row.finalScore ?? 0).toFixed(2)}`,
    `Decision: ${row.matched ? 'MATCH' : 'NO MATCH'}`,
    `Detection Method: ${describeMethod(row)}`,
  ];
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
  lines.push(`Deep Scan: ${diag.deepScan ? 'YES' : 'NO'}`);
  if (diag.reason) lines.push(`Reason for Escalation: ${diag.reason}`);
  if (diag.framesSampled != null) lines.push(`Frames Sampled: ${diag.framesSampled}`);
  if (diag.framesDeepAnalyzed != null) {
    lines.push(`Frames Deeply Analyzed: ${diag.framesDeepAnalyzed}`);
  }
  if (diag.variantsAnalyzed != null) {
    lines.push(`Variants Analyzed: ${diag.variantsAnalyzed}`);
  }
  if (diag.jinaCalls != null) lines.push(`Jina Calls: ${diag.jinaCalls}`);
  if (diag.framesDeduped) lines.push(`Frames Deduped: ${diag.framesDeduped}`);
  return lines.join('\n');
}
