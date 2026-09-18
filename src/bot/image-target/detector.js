import { log } from '../../logger.js';
import {
  IMAGE_TARGET_ANALYSIS_TIMEOUT_MS,
  IMAGE_TARGET_EMBEDDING_THRESHOLD,
  IMAGE_TARGET_MAX_STORED_FINGERPRINTS,
  IMAGE_TARGET_MAX_VARIANTS,
  LOCAL_MATCH_WITHOUT_EMBEDDING,
  LOCAL_OBVIOUS_SIMILARITY,
  LOCAL_SKIP_SIMILARITY,
} from './constants.js';
import {
  contentHash,
  fingerprintImage,
  localSimilarity,
} from './fingerprints.js';
import { getJinaProvider } from './providers/jina.js';
import { cosineSimilarity } from './providers/types.js';
import { sampleMediaFrames } from './sampler.js';
import {
  classifyLocalEvidence,
  combineScores,
  describeMethod,
  formatTestResult,
  pickStrongest,
  scoreFingerprintPair,
} from './scoring.js';
import {
  effectiveThreshold,
  listTargetFingerprints,
  listTargets,
  replaceTargetFingerprints,
} from './store.js';
import { generateVariants } from './variants.js';

/**
 * Image Target V2 detector.
 *
 * MEDIA → normalize/sample frames → variants → multi-fingerprint
 *      → local ensemble ranking → optional Jina → aggregate → decision
 *
 * Local hashes rank and soft-filter; they are NOT an absolute rejection gate
 * for uncertain / edited candidates (those still go to Jina when available).
 */

function withTimeout(promise, ms, label = 'analysis_timeout') {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

/** Synthesize a V1-compatible fingerprint list from the primary target row. */
function legacyFingerprintsFromTarget(target) {
  return [
    {
      fingerprintId: null,
      guildId: target.guildId,
      targetId: target.targetId,
      frameIndex: 0,
      variantKey: 'original',
      dHash: target.perceptualHash || null,
      aHash: null,
      pHash: null,
      blockHash: target.blockHash || null,
      edgeHash: null,
      embedding: target.embedding || null,
      contentHash: target.contentHash || null,
      timestampMs: 0,
    },
  ];
}

async function fingerprintsForTarget(guildId, target) {
  const stored = await listTargetFingerprints(guildId, target.targetId);
  if (stored.length) return stored;
  return legacyFingerprintsFromTarget(target);
}

/**
 * Build analysis units (frame × variant × fingerprint) for a media buffer.
 * Embeddings are optional and computed later only for top candidates.
 */
async function analyzeMediaUnits(buffer, meta = {}, {
  maxVariants = IMAGE_TARGET_MAX_VARIANTS,
  forStorage = false,
} = {}) {
  const { frames, mediaKind } = await sampleMediaFrames(buffer, meta);
  const units = [];
  const sourceContentHash = contentHash(buffer);

  // For storage, keep fewer variants per frame to bound Postgres size.
  const variantCap = forStorage
    ? Math.min(maxVariants, 4)
    : maxVariants;

  for (const frame of frames) {
    const variants = await generateVariants(frame.buffer, {
      maxVariants: variantCap,
    });
    for (const variant of variants) {
      const fp = await fingerprintImage(variant.buffer);
      units.push({
        mediaKind,
        frameIndex: frame.frameIndex,
        timestampSec: frame.timestampSec,
        variantKey: variant.key,
        buffer: variant.buffer,
        fingerprint: fp,
        sourceContentHash,
      });
    }
  }

  return { units, mediaKind, sourceContentHash, frameCount: frames.length };
}

/**
 * Select a compact set of fingerprint rows to persist for a target.
 * Prefer original + grayscale + center-crop variants across sampled frames.
 */
function selectStorageFingerprints(units) {
  const prefer = [
    'original',
    'grayscale-normalized',
    'center-crop-90',
    'center-crop-80',
    'center-crop-70',
    'crop-bottom-20',
    'flip-h',
  ];
  const scored = units.map((u) => {
    const pref = prefer.indexOf(u.variantKey);
    return { u, rank: pref === -1 ? 50 : pref };
  });
  scored.sort((a, b) => a.rank - b.rank || a.u.frameIndex - b.u.frameIndex);
  return scored.slice(0, IMAGE_TARGET_MAX_STORED_FINGERPRINTS).map((s) => s.u);
}

/**
 * Build fingerprints (+ optional embeddings) for a newly uploaded target.
 * Returns V1-compatible primary fields PLUS a `fingerprints` array for storage.
 */
export async function analyzeTargetBuffer(buffer, {
  withEmbedding = true,
  meta = {},
} = {}) {
  const { units, mediaKind, sourceContentHash } = await withTimeout(
    analyzeMediaUnits(buffer, meta, { forStorage: true }),
    IMAGE_TARGET_ANALYSIS_TIMEOUT_MS,
  );

  const selected = selectStorageFingerprints(units);
  const primary =
    selected.find((u) => u.variantKey === 'original' && u.frameIndex === 0) ||
    selected[0];

  const jina = getJinaProvider();
  let embedding = null;
  let embeddingModel = null;

  // Embed a small subset of storage units (original frames) to keep API use low.
  if (withEmbedding && jina.available) {
    const embedUnits = selected.filter(
      (u) => u.variantKey === 'original',
    ).slice(0, Math.min(4, selected.length));
    if (!embedUnits.length && selected[0]) embedUnits.push(selected[0]);

    for (const u of embedUnits) {
      try {
        const emb = await jina.generateEmbedding(u.buffer, {
          cacheKey: u.fingerprint.contentHash,
        });
        u.embedding = emb;
        u.embeddingModel = jina.name;
        if (!embedding) {
          embedding = emb;
          embeddingModel = jina.name;
        }
      } catch (err) {
        log.warn('[image-target] embedding on add failed:', err.message);
      }
    }
  }

  const fingerprints = selected.map((u) => ({
    frameIndex: u.frameIndex,
    variantKey: u.variantKey,
    dHash: u.fingerprint.dHash,
    aHash: u.fingerprint.aHash,
    pHash: u.fingerprint.pHash,
    blockHash: u.fingerprint.blockHash,
    edgeHash: u.fingerprint.edgeHash,
    embedding: u.embedding || null,
    contentHash: u.fingerprint.contentHash,
    timestampMs: Math.round((u.timestampSec || 0) * 1000),
  }));

  return {
    // V1 primary fields (first/primary representation)
    dHash: primary.fingerprint.dHash,
    blockHash: primary.fingerprint.blockHash,
    aHash: primary.fingerprint.aHash,
    pHash: primary.fingerprint.pHash,
    edgeHash: primary.fingerprint.edgeHash,
    contentHash: sourceContentHash || primary.fingerprint.contentHash,
    width: primary.fingerprint.width,
    height: primary.fingerprint.height,
    format: primary.fingerprint.format,
    embedding,
    embeddingModel,
    mediaKind,
    fingerprints,
  };
}

/**
 * Persist V2 fingerprint set after addTarget (hub/commands call this).
 */
export async function persistTargetFingerprints(guildId, targetId, fingerprints) {
  if (!fingerprints?.length) return [];
  return replaceTargetFingerprints(guildId, targetId, fingerprints);
}

function buildEvidenceRow({
  target,
  unit,
  targetFp,
  local,
  embeddingScore = null,
  exact = false,
  threshold,
}) {
  const combined = combineScores({
    localScore: local.localScore,
    embeddingScore,
    exact,
  });
  return {
    target,
    finalScore: combined.finalScore,
    method: combined.method,
    methodLabel: null,
    localScore: local.localScore,
    localScores: local.localScores,
    dHashDistance: local.dHashDistance,
    blockHashDistance: local.blockHashDistance,
    embeddingScore,
    usedJina: embeddingScore != null,
    matched: combined.finalScore >= threshold,
    frameIndex: unit.frameIndex,
    timestampSec: unit.timestampSec,
    variantKey: unit.variantKey,
    mediaKind: unit.mediaKind,
    threshold,
  };
}

async function scoreMediaAgainstTargets(guildId, buffer, {
  meta = {},
  dryRun = false,
} = {}) {
  const targets = await listTargets(guildId, { includeDisabled: false });
  if (!targets.length) {
    return {
      match: null,
      results: [],
      message: 'No enabled targets in this server.',
      mediaKind: null,
    };
  }

  const { units, mediaKind, sourceContentHash } = await analyzeMediaUnits(
    buffer,
    meta,
  );

  // Exact byte match against any target content hash.
  for (const t of targets) {
    if (t.contentHash && t.contentHash === sourceContentHash) {
      const threshold = await effectiveThreshold(guildId, t);
      const row = {
        target: t,
        finalScore: 1,
        score: 1,
        method: 'exact',
        localScore: 1,
        localScores: {},
        embeddingScore: null,
        usedJina: false,
        matched: true,
        frameIndex: 0,
        timestampSec: 0,
        variantKey: 'original',
        mediaKind,
        threshold,
        dHashDistance: 0,
        blockHashDistance: 0,
      };
      row.methodLabel = describeMethod(row);
      return {
        match: row,
        results: [row],
        mediaKind,
        sourceContentHash,
      };
    }
  }

  // Load fingerprint sets (V2 rows or V1 legacy synthesis).
  const targetFps = new Map();
  for (const t of targets) {
    targetFps.set(t.targetId, await fingerprintsForTarget(guildId, t));
  }

  // Stage 1: local ensemble across all units × target fingerprints.
  /** @type {Map<string, object[]>} */
  const perTargetEvidence = new Map();
  for (const t of targets) perTargetEvidence.set(t.targetId, []);

  for (const unit of units) {
    for (const t of targets) {
      const fps = targetFps.get(t.targetId) || [];
      let bestLocal = null;
      for (const tfp of fps) {
        const local = scoreFingerprintPair(unit.fingerprint, tfp);
        if (!bestLocal || local.localScore > bestLocal.local.localScore) {
          bestLocal = { local, tfp };
        }
      }
      if (!bestLocal) continue;
      perTargetEvidence.get(t.targetId).push({
        unit,
        tfp: bestLocal.tfp,
        local: bestLocal.local,
      });
    }
  }

  // Rank targets by best local score.
  const ranked = targets
    .map((t) => {
      const rows = perTargetEvidence.get(t.targetId) || [];
      const best = rows.reduce(
        (a, b) => (!a || b.local.localScore > a.local.localScore ? b : a),
        null,
      );
      return { target: t, best, rows };
    })
    .filter((r) => r.best)
    .sort((a, b) => b.best.local.localScore - a.best.local.localScore);

  const jina = getJinaProvider();
  /** cacheKey → embedding */
  const embeddingCache = new Map();

  async function embedUnit(unit) {
    const key = unit.fingerprint.contentHash;
    if (embeddingCache.has(key)) return embeddingCache.get(key);
    const emb = await jina.generateEmbedding(unit.buffer, { cacheKey: key });
    embeddingCache.set(key, emb);
    return emb;
  }

  const results = [];

  for (const entry of ranked) {
    const threshold =
      IMAGE_TARGET_EMBEDDING_THRESHOLD ??
      (await effectiveThreshold(guildId, entry.target));

    const bestLocalScore = entry.best.local.localScore;
    const band = classifyLocalEvidence(bestLocalScore);

    // Soft skip: clearly unrelated AND not dry-run → omit from match path.
    // Dry-run still reports scores.
    if (band === 'skip' && !dryRun) {
      continue;
    }

    // Obvious local match — no Jina required.
    if (band === 'obvious') {
      const row = buildEvidenceRow({
        target: entry.target,
        unit: entry.best.unit,
        targetFp: entry.best.tfp,
        local: entry.best.local,
        threshold,
      });
      row.matched = true;
      row.methodLabel = describeMethod(row);
      results.push(row);
      continue;
    }

    // Uncertain / candidate → try Jina when available.
    let embeddingScore = null;
    const targetEmb =
      entry.best.tfp.embedding ||
      entry.target.embedding ||
      null;

    const shouldJina =
      jina.available &&
      targetEmb?.length &&
      (band === 'candidate' || band === 'uncertain' || dryRun);

    if (shouldJina) {
      // Embed top-N units for this target (best local first), not every variant.
      const topUnits = [...entry.rows]
        .sort((a, b) => b.local.localScore - a.local.localScore)
        .slice(0, 3);

      // Also compare against all target embeddings in the fingerprint set.
      const targetEmbeddings = (targetFps.get(entry.target.targetId) || [])
        .map((fp) => fp.embedding)
        .filter((e) => e?.length);
      if (!targetEmbeddings.length && entry.target.embedding?.length) {
        targetEmbeddings.push(entry.target.embedding);
      }

      try {
        for (const cand of topUnits) {
          // Skip embedding for units that are clearly unrelated locally
          // unless dry-run wants more detail.
          if (
            !dryRun &&
            cand.local.localScore < LOCAL_SKIP_SIMILARITY * 0.85
          ) {
            continue;
          }
          const candEmb = await embedUnit(cand.unit);
          for (const tEmb of targetEmbeddings) {
            const sim = cosineSimilarity(tEmb, candEmb);
            if (embeddingScore == null || sim > embeddingScore) {
              embeddingScore = sim;
              entry.best = cand; // strongest embedding evidence unit
            }
          }
        }
      } catch (err) {
        log.warn('[image-target] Jina embed failed:', err.message);
      }
    }

    const row = buildEvidenceRow({
      target: entry.target,
      unit: entry.best.unit,
      targetFp: entry.best.tfp,
      local: entry.best.local,
      embeddingScore,
      threshold,
    });

    if (embeddingScore != null) {
      row.matched = row.finalScore >= threshold;
    } else if (bestLocalScore >= LOCAL_OBVIOUS_SIMILARITY) {
      row.matched = true;
    } else if (
      // No embedding available: still accept strong local ensemble hits so
      // edited near-duplicates work without Jina.
      bestLocalScore >= LOCAL_MATCH_WITHOUT_EMBEDDING &&
      band !== 'skip'
    ) {
      const ls = entry.best.local.localScores || {};
      // Require at least one core perceptual hash to agree — blocks
      // edgeHash-only false positives on unrelated patterned media.
      const coreOk = (ls.pHash ?? 0) >= 0.7 || (ls.dHash ?? 0) >= 0.75;
      if (coreOk) {
        row.matched = true;
        row.method = 'phash';
        row.finalScore = Math.max(row.finalScore, bestLocalScore);
        row.score = row.finalScore;
      } else {
        row.matched = false;
      }
    } else {
      row.matched = false;
    }

    row.methodLabel = describeMethod(row);
    results.push(row);
  }

  results.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
  for (const row of results) {
    // Backward-compatible alias used by actions / older callers.
    row.score = row.finalScore;
  }
  const top = pickStrongest(results.filter((r) => r.matched)) || null;

  return {
    match: top,
    results,
    mediaKind,
    sourceContentHash,
    jinaAvailable: jina.available,
  };
}

/**
 * Compare a candidate media buffer against all enabled targets in a guild.
 * @returns {null | object} strongest match above threshold, or null
 */
export async function matchAgainstTargets(guildId, buffer, opts = {}) {
  try {
    const report = await withTimeout(
      scoreMediaAgainstTargets(guildId, buffer, {
        meta: opts.meta || {},
        dryRun: false,
      }),
      IMAGE_TARGET_ANALYSIS_TIMEOUT_MS,
    );
    return report.match || null;
  } catch (err) {
    if (String(err.message).includes('timeout')) {
      log.warn('[image-target] analysis timeout');
      return null;
    }
    throw err;
  }
}

/**
 * Dry-run compare for /image-target test — returns strongest scores even
 * when below threshold (so admins can tune).
 */
export async function testAgainstTargets(guildId, buffer, opts = {}) {
  try {
    const report = await withTimeout(
      scoreMediaAgainstTargets(guildId, buffer, {
        meta: opts.meta || {},
        dryRun: true,
      }),
      IMAGE_TARGET_ANALYSIS_TIMEOUT_MS,
    );

    if (!report.results?.length && report.message) {
      return { match: false, results: [], message: report.message };
    }

    const top = report.results[0] || null;
    return {
      match: Boolean(report.match),
      results: report.results,
      top: report.match || top,
      jinaAvailable: report.jinaAvailable,
      jinaError: null,
      mediaKind: report.mediaKind,
      reportText: formatTestResult(report.match || top),
      fingerprint: top
        ? {
            localScore: top.localScore,
            localScores: top.localScores,
            embeddingScore: top.embeddingScore,
          }
        : null,
    };
  } catch (err) {
    if (String(err.message).includes('timeout')) {
      return {
        match: false,
        results: [],
        message: 'Analysis timed out — try a smaller file.',
        jinaAvailable: getJinaProvider().available,
      };
    }
    throw err;
  }
}

// Re-export helpers useful for tests / debugging.
export {
  classifyLocalEvidence,
  describeMethod,
  formatTestResult,
  localSimilarity,
};
