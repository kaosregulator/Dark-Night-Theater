import { log } from '../../logger.js';
import {
  IMAGE_TARGET_ANALYSIS_TIMEOUT_MS,
  IMAGE_TARGET_DEEP_ANALYSIS_TIMEOUT_MS,
  IMAGE_TARGET_DEEP_MAX_VARIANTS,
  DEEP_LOCAL_MATCH_WITHOUT_EMBEDDING,
  IMAGE_TARGET_EMBEDDING_THRESHOLD,
  IMAGE_TARGET_FEATURES_ENABLED,
  IMAGE_TARGET_FEATURE_MIN_MATCHES,
  IMAGE_TARGET_MAX_JINA_CALLS,
  IMAGE_TARGET_MAX_STORED_FINGERPRINTS,
  IMAGE_TARGET_MAX_VARIANTS,
  IMAGE_TARGET_PARTIAL_OVERLAP_FLOOR,
  IMAGE_TARGET_VECTOR_TOP_K,
  LOCAL_MATCH_WITHOUT_EMBEDDING,
  LOCAL_OBVIOUS_SIMILARITY,
  LOCAL_SKIP_SIMILARITY,
} from './constants.js';
import {
  buildDeepScanDiagnostics,
  shouldEscalateToDeepScan,
} from './deep-scan.js';
import { fuseEvidence } from './evidence.js';
import {
  buildForensicUnits,
  enrichPairSignals,
  scoreTemporalEvidence,
} from './forensic.js';
import {
  contentHash,
  fingerprintImage,
  localSimilarity,
} from './fingerprints.js';
import { getJinaProvider } from './providers/jina.js';
import { cosineSimilarity } from './providers/types.js';
import { sampleMediaFrames, sampleMediaFramesDeep } from './sampler.js';
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
import { foldVideoHash } from './videohash.js';

/**
 * Image Target V3 — Forensic Engine (on top of V2.1 adaptive deep detection).
 *
 * MEDIA → quick scan → local ensemble
 *   → obvious MATCH | clearly unrelated NO MATCH
 *   → uncertain/suspicious → DEEP SCAN
 *       denser frames + forensic variants + regions/screenshot
 *       + ORB features + PDQ + sequence/videoHash + multi Jina
 *   → evidence fusion → final decision
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
 * Build analysis units (frame × variant × fingerprint).
 */
async function analyzeMediaUnits(buffer, meta = {}, {
  maxVariants = IMAGE_TARGET_MAX_VARIANTS,
  forStorage = false,
  deep = false,
  sampleOpts = {},
} = {}) {
  const sampled = deep
    ? await sampleMediaFramesDeep(buffer, meta, sampleOpts)
    : await sampleMediaFrames(buffer, meta, sampleOpts);

  const { frames, mediaKind } = sampled;
  const units = [];
  const sourceContentHash = contentHash(buffer);

  const variantCap = forStorage
    ? Math.min(Math.max(maxVariants, 8), IMAGE_TARGET_DEEP_MAX_VARIANTS)
    : deep
      ? Math.max(maxVariants, IMAGE_TARGET_DEEP_MAX_VARIANTS)
      : maxVariants;

  for (const frame of frames) {
    const variants = await generateVariants(frame.buffer, {
      maxVariants: variantCap,
      deep,
    });
    for (const variant of variants) {
      const wantFeatures =
        IMAGE_TARGET_FEATURES_ENABLED &&
        (deep || forStorage) &&
        (variant.key === 'original' ||
          variant.key === 'grayscale-normalized' ||
          variant.key === 'center-crop-80');
      const fp = await fingerprintImage(variant.buffer, {
        withFeatures: wantFeatures,
      });
      units.push({
        mediaKind,
        frameIndex: frame.frameIndex,
        timestampSec: frame.timestampSec,
        variantKey: variant.key,
        buffer: variant.buffer,
        fingerprint: fp,
        sourceContentHash,
        deep,
      });
    }
  }

  return {
    units,
    mediaKind,
    sourceContentHash,
    frameCount: frames.length,
    frames,
    framesDeduped: sampled.framesDeduped || 0,
    durationSec: sampled.durationSec ?? null,
    totalFrames: sampled.totalFrames ?? null,
  };
}

/**
 * Prefer timeline diversity (begin / early / mid / late / end) + variant mix.
 */
function selectStorageFingerprints(units) {
  if (!units.length) return [];

  const frameIndexes = [...new Set(units.map((u) => u.frameIndex))].sort(
    (a, b) => a - b,
  );
  const prefer = [
    'original',
    'grayscale-normalized',
    'center-crop-90',
    'center-crop-80',
    'center-crop-70',
    'crop-bottom-20',
    'letterbox-square',
    'trim-bars',
    'flip-h',
    'border-trim-12',
    'cover-square',
  ];

  // Bucket frames into 5 timeline zones.
  const buckets = { begin: [], early: [], middle: [], late: [], end: [] };
  if (frameIndexes.length === 1) {
    buckets.begin = frameIndexes;
  } else {
    const last = frameIndexes[frameIndexes.length - 1] || 1;
    for (const idx of frameIndexes) {
      const t = idx / last;
      if (t <= 0.05) buckets.begin.push(idx);
      else if (t <= 0.3) buckets.early.push(idx);
      else if (t <= 0.7) buckets.middle.push(idx);
      else if (t <= 0.9) buckets.late.push(idx);
      else buckets.end.push(idx);
    }
    // Ensure non-empty coverage when sparse.
    if (!buckets.begin.length) buckets.begin.push(frameIndexes[0]);
    if (!buckets.end.length) buckets.end.push(frameIndexes[frameIndexes.length - 1]);
    if (!buckets.middle.length) {
      buckets.middle.push(frameIndexes[Math.floor(frameIndexes.length / 2)]);
    }
  }

  const selected = [];
  const seen = new Set();
  const pickFromBucket = (indexes, variantKeys) => {
    for (const fi of indexes) {
      for (const vk of variantKeys) {
        const u = units.find((x) => x.frameIndex === fi && x.variantKey === vk);
        if (!u) continue;
        const key = `${u.frameIndex}:${u.variantKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(u);
        return;
      }
      // Fallback any variant for this frame.
      const any = units.find((x) => x.frameIndex === fi);
      if (any) {
        const key = `${any.frameIndex}:${any.variantKey}`;
        if (!seen.has(key)) {
          seen.add(key);
          selected.push(any);
        }
      }
    }
  };

  for (const zone of ['begin', 'early', 'middle', 'late', 'end']) {
    pickFromBucket(buckets[zone], prefer);
  }

  // Fill remaining slots with preference order across all frames.
  const scored = units.map((u) => {
    const pref = prefer.indexOf(u.variantKey);
    return { u, rank: pref === -1 ? 50 : pref };
  });
  scored.sort((a, b) => a.rank - b.rank || a.u.frameIndex - b.u.frameIndex);
  for (const s of scored) {
    if (selected.length >= IMAGE_TARGET_MAX_STORED_FINGERPRINTS) break;
    const key = `${s.u.frameIndex}:${s.u.variantKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(s.u);
  }

  return selected.slice(0, IMAGE_TARGET_MAX_STORED_FINGERPRINTS);
}

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

  if (withEmbedding && jina.available) {
    // Embed original variants across timeline buckets (not just frame 0).
    const embedUnits = selected.filter((u) => u.variantKey === 'original');
    const spaced = [];
    if (embedUnits.length) {
      const step = Math.max(1, Math.floor(embedUnits.length / 4));
      for (let i = 0; i < embedUnits.length && spaced.length < 4; i += step) {
        spaced.push(embedUnits[i]);
      }
      if (!spaced.includes(embedUnits[embedUnits.length - 1])) {
        spaced.push(embedUnits[embedUnits.length - 1]);
      }
    } else if (selected[0]) {
      spaced.push(selected[0]);
    }

    for (const u of spaced.slice(0, 4)) {
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
    colorHash: u.fingerprint.colorHash,
    pdqHash: u.fingerprint.pdqHash,
    features: u.fingerprint.features || null,
    embedding: u.embedding || null,
    contentHash: u.fingerprint.contentHash,
    timestampMs: Math.round((u.timestampSec || 0) * 1000),
  }));

  // Video perceptual hash from original-frame pHashes across the timeline.
  const timelineP = fingerprints
    .filter((f) => f.variantKey === 'original' && f.pHash)
    .map((f) => f.pHash);
  const videoHash = foldVideoHash(timelineP);
  if (videoHash) {
    for (const f of fingerprints) {
      if (f.variantKey === 'original') f.videoHash = videoHash;
    }
  }

  return {
    dHash: primary.fingerprint.dHash,
    blockHash: primary.fingerprint.blockHash,
    aHash: primary.fingerprint.aHash,
    pHash: primary.fingerprint.pHash,
    edgeHash: primary.fingerprint.edgeHash,
    colorHash: primary.fingerprint.colorHash,
    pdqHash: primary.fingerprint.pdqHash,
    videoHash,
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
  deepScan = false,
  extras = {},
}) {
  const fused = fuseEvidence({
    localScore: local.localScore,
    localScores: local.localScores,
    featureScore: local.featureScore || extras.featureScore || 0,
    featureMatches: local.featureMatches || extras.featureMatches || 0,
    pdqScore: extras.pdqScore ?? local.localScores?.pdqHash ?? 0,
    colorScore: extras.colorScore ?? local.localScores?.colorHash ?? 0,
    videoHashScore: extras.videoHashScore || 0,
    sequenceScore: extras.sequenceScore || 0,
    sequenceMatches: extras.sequenceMatches || 0,
    regionScore: extras.regionScore || 0,
    contentOverlap: extras.contentOverlap || 0,
    mirrorScore: extras.mirrorScore || 0,
    embeddingScore,
    exact,
  });
  // Prefer fusion, but keep combineScores floor for Jina-only paths.
  const combined = combineScores({
    localScore: Math.max(local.localScore, fused.structural || 0),
    embeddingScore,
    exact,
  });
  const finalScore = Math.max(combined.finalScore, fused.finalScore);
  return {
    target,
    finalScore,
    score: finalScore,
    method: fused.method || combined.method,
    methodLabel: null,
    localScore: local.localScore,
    localScores: local.localScores,
    featureScore: local.featureScore || extras.featureScore || 0,
    featureMatches: local.featureMatches || extras.featureMatches || 0,
    dHashDistance: local.dHashDistance,
    blockHashDistance: local.blockHashDistance,
    embeddingScore,
    usedJina: embeddingScore != null,
    matched: finalScore >= threshold,
    frameIndex: unit.frameIndex,
    timestampSec: unit.timestampSec,
    variantKey: unit.variantKey,
    mediaKind: unit.mediaKind,
    threshold,
    deepScan,
    contentOverlap: fused.contentOverlap,
    sequenceScore: extras.sequenceScore || null,
    sequenceMatches: extras.sequenceMatches || null,
    videoHashScore: extras.videoHashScore || null,
    mirrorScore: extras.mirrorScore || null,
    regionScore: extras.regionScore || null,
    signals: fused.signals,
  };
}

function scoreUnitsAgainstTargets(units, targets, targetFps) {
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

  return targets
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
}

function decideMatch(row, { bestLocalScore, band, embeddingScore, threshold, deepScan = false }) {
  if (embeddingScore != null) {
    row.matched = row.finalScore >= threshold;
    return row;
  }
  if (bestLocalScore >= LOCAL_OBVIOUS_SIMILARITY) {
    const ls = row.localScores || {};
    if (
      (ls.pHash ?? 0) >= 0.7 ||
      (ls.dHash ?? 0) >= 0.8 ||
      (ls.blockHash ?? 0) >= 0.8 ||
      (ls.pdqHash ?? 0) >= 0.78
    ) {
      row.matched = true;
      return row;
    }
  }
  const ls = row.localScores || {};
  const floor = deepScan
    ? DEEP_LOCAL_MATCH_WITHOUT_EMBEDDING
    : LOCAL_MATCH_WITHOUT_EMBEDDING;

  // Quick-scan core gate.
  const quickCoreOk =
    !deepScan &&
    ((ls.pHash ?? 0) >= 0.7 ||
      (ls.dHash ?? 0) >= 0.75 ||
      (ls.pdqHash ?? 0) >= 0.8);

  // Deep scan: pHash-led, PDQ, ORB features, or strong dHash+blockHash.
  const featureHit =
    (row.featureMatches || 0) >= IMAGE_TARGET_FEATURE_MIN_MATCHES &&
    (row.featureScore || 0) >= 0.55;
  const partialHit =
    deepScan &&
    (row.contentOverlap || 0) >= IMAGE_TARGET_PARTIAL_OVERLAP_FLOOR &&
    (row.regionScore || 0) >= 0.68;
  const sequenceHit =
    deepScan &&
    (row.sequenceMatches || 0) >= 3 &&
    (row.sequenceScore || 0) >= 0.55;
  const deepCoreOk =
    deepScan &&
    ((ls.pHash ?? 0) >= 0.74 ||
      (ls.pdqHash ?? 0) >= 0.76 ||
      featureHit ||
      partialHit ||
      sequenceHit ||
      ((ls.pHash ?? 0) >= 0.7 &&
        (ls.dHash ?? 0) >= 0.72 &&
        (ls.blockHash ?? 0) >= 0.65) ||
      ((ls.dHash ?? 0) >= 0.82 && (ls.blockHash ?? 0) >= 0.75));

  const effectiveScore = Math.max(
    bestLocalScore,
    row.featureScore || 0,
    row.contentOverlap || 0,
    row.sequenceScore || 0,
    row.videoHashScore || 0,
  );

  if (
    effectiveScore >= floor &&
    (band !== 'skip' || deepScan) &&
    (quickCoreOk || deepCoreOk)
  ) {
    row.matched = true;
    row.method = deepScan
      ? featureHit
        ? 'orb+deep'
        : partialHit
          ? 'partial+deep'
          : sequenceHit
            ? 'sequence+deep'
            : 'phash+deep'
      : 'phash';
    row.finalScore = Math.max(row.finalScore, effectiveScore);
    row.score = row.finalScore;
    return row;
  }
  row.matched = false;
  return row;
}

/**
 * Multi-candidate Jina with call budget + early stop.
 */
async function runMultiJina({
  jina,
  entry,
  targetFps,
  embedUnit,
  jinaBudget,
  dryRun,
  threshold,
}) {
  let embeddingScore = null;
  let calls = 0;
  let bestCand = entry.best;

  const targetEmbeddings = (targetFps.get(entry.target.targetId) || [])
    .map((fp) => fp.embedding)
    .filter((e) => e?.length);
  if (!targetEmbeddings.length && entry.target.embedding?.length) {
    targetEmbeddings.push(entry.target.embedding);
  }
  if (!targetEmbeddings.length || !jina.available) {
    return { embeddingScore, calls, bestCand };
  }

  // Diversify: different frames + different variants, strongest local first.
  const byKey = new Map();
  for (const cand of [...entry.rows].sort(
    (a, b) => b.local.localScore - a.local.localScore,
  )) {
    const frameKey = `f${cand.unit.frameIndex}`;
    const variantKey = cand.unit.variantKey;
    if (!byKey.has(frameKey)) byKey.set(frameKey, cand);
    if (!byKey.has(variantKey)) byKey.set(`v:${variantKey}`, cand);
  }
  const diversified = [...byKey.values()];
  // Prefer unique units.
  const seen = new Set();
  const topUnits = [];
  for (const cand of [
    ...diversified,
    ...[...entry.rows].sort((a, b) => b.local.localScore - a.local.localScore),
  ]) {
    const id = `${cand.unit.frameIndex}:${cand.unit.variantKey}:${cand.unit.fingerprint.contentHash}`;
    if (seen.has(id)) continue;
    seen.add(id);
    topUnits.push(cand);
    if (topUnits.length >= Math.min(5, jinaBudget.remaining)) break;
  }

  try {
    for (const cand of topUnits) {
      if (jinaBudget.remaining <= 0) break;
      // Allow poor local scores during deep scan — edited targets.
      if (
        !dryRun &&
        !cand.unit.deep &&
        cand.local.localScore < LOCAL_SKIP_SIMILARITY * 0.7
      ) {
        continue;
      }
      const candEmb = await embedUnit(cand.unit);
      jinaBudget.remaining -= 1;
      calls += 1;
      for (const tEmb of targetEmbeddings) {
        const sim = cosineSimilarity(tEmb, candEmb);
        if (embeddingScore == null || sim > embeddingScore) {
          embeddingScore = sim;
          bestCand = cand;
        }
      }
      // Early stop when conclusive.
      if (embeddingScore != null && embeddingScore >= Math.min(0.97, threshold + 0.05)) {
        break;
      }
    }
  } catch (err) {
    log.warn('[image-target] Jina embed failed:', err.message);
  }

  return { embeddingScore, calls, bestCand };
}

async function scoreMediaAgainstTargets(guildId, buffer, {
  meta = {},
  dryRun = false,
} = {}) {
  const targetsAll = await listTargets(guildId, { includeDisabled: false });
  if (!targetsAll.length) {
    return {
      match: null,
      results: [],
      message: 'No enabled targets in this server.',
      mediaKind: null,
      diagnostics: buildDeepScanDiagnostics(),
    };
  }

  // Optional ANN prefilter when many targets (V3 pgvector / cosine top-K).
  let targets = targetsAll;
  if (targetsAll.length > IMAGE_TARGET_VECTOR_TOP_K) {
    try {
      const jinaPre = getJinaProvider();
      if (jinaPre.available) {
        const probe = await fingerprintImage(
          (
            await generateVariants(buffer, { maxVariants: 1, deep: false })
          )[0]?.buffer || buffer,
        );
        // Cheap: only embed if we already have a still; otherwise skip ANN.
        void probe;
      }
      // Prefer targets that already have embeddings; keep all if few.
      const withEmb = targetsAll.filter((t) => t.embedding?.length);
      if (withEmb.length > IMAGE_TARGET_VECTOR_TOP_K) {
        // Without a query embedding yet, keep first TOP_K + any without embedding
        // (local-only targets must not be dropped silently).
        const noEmb = targetsAll.filter((t) => !t.embedding?.length);
        targets = [
          ...withEmb.slice(0, IMAGE_TARGET_VECTOR_TOP_K),
          ...noEmb,
        ];
      }
    } catch {
      targets = targetsAll;
    }
  }

  // ---- Quick scan ----------------------------------------------------------
  const quick = await analyzeMediaUnits(buffer, meta, {
    maxVariants: IMAGE_TARGET_MAX_VARIANTS,
    deep: false,
  });

  let units = quick.units;
  let mediaKind = quick.mediaKind;
  const sourceContentHash = quick.sourceContentHash;
  let framesSampled = quick.frameCount;
  let framesDeepAnalyzed = 0;
  let variantsAnalyzed = units.length;
  let framesDeduped = quick.framesDeduped || 0;
  let deepScan = false;
  let escalateReason = null;
  let jinaCalls = 0;
  let regionsAnalyzed = 0;

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
        deepScan: false,
      };
      row.methodLabel = describeMethod(row);
      const diagnostics = buildDeepScanDiagnostics({
        deepScan: false,
        framesSampled,
        variantsAnalyzed,
        jinaCalls: 0,
      });
      row.diagnostics = diagnostics;
      return {
        match: row,
        results: [row],
        mediaKind,
        sourceContentHash,
        diagnostics,
      };
    }
  }

  const targetFps = new Map();
  for (const t of targets) {
    targetFps.set(t.targetId, await fingerprintsForTarget(guildId, t));
  }

  let ranked = scoreUnitsAgainstTargets(units, targets, targetFps);
  const jina = getJinaProvider();
  const embeddingCache = new Map();
  const jinaBudget = { remaining: IMAGE_TARGET_MAX_JINA_CALLS };

  async function embedUnit(unit) {
    const key = unit.fingerprint.contentHash;
    if (embeddingCache.has(key)) return embeddingCache.get(key);
    const emb = await jina.generateEmbedding(unit.buffer, { cacheKey: key });
    embeddingCache.set(key, emb);
    return emb;
  }

  // Quick-pass decisions (may escalate).
  const quickResults = [];
  let needsDeep = false;
  let deepReason = null;

  for (const entry of ranked) {
    const threshold =
      IMAGE_TARGET_EMBEDDING_THRESHOLD ??
      (await effectiveThreshold(guildId, entry.target));
    const bestLocalScore = entry.best.local.localScore;
    const band = classifyLocalEvidence(bestLocalScore);

    if (band === 'skip' && !dryRun) {
      const esc = shouldEscalateToDeepScan({
        band,
        localScore: bestLocalScore,
        localScores: entry.best.local.localScores,
        matched: false,
        mediaKind,
        jinaAvailable: jina.available,
      });
      if (esc.escalate) {
        needsDeep = true;
        deepReason = deepReason || esc.reason;
      }
      continue;
    }

    if (band === 'obvious') {
      const row = buildEvidenceRow({
        target: entry.target,
        unit: entry.best.unit,
        targetFp: entry.best.tfp,
        local: entry.best.local,
        threshold,
      });
      const ls = entry.best.local.localScores || {};
      // Guard flat-image false positives: require a core hash for "obvious".
      row.matched =
        (ls.pHash ?? 0) >= 0.7 ||
        (ls.dHash ?? 0) >= 0.8 ||
        (ls.blockHash ?? 0) >= 0.8;
      if (!row.matched) {
        // Fall through to candidate handling below by not continuing.
      } else {
        row.methodLabel = describeMethod(row);
        quickResults.push(row);
        continue;
      }
    }

    // Candidate / uncertain: light Jina on quick pass (1–2 calls), then maybe deep.
    let embeddingScore = null;
    if (
      jina.available &&
      (entry.best.tfp.embedding?.length || entry.target.embedding?.length) &&
      (band === 'candidate' || band === 'uncertain' || dryRun)
    ) {
      // Cap quick-pass Jina tightly; deep pass gets the rest.
      const quickBudget = {
        remaining: Math.min(2, jinaBudget.remaining),
      };
      const jr = await runMultiJina({
        jina,
        entry,
        targetFps,
        embedUnit,
        jinaBudget: quickBudget,
        dryRun,
        threshold,
      });
      embeddingScore = jr.embeddingScore;
      jinaCalls += jr.calls;
      jinaBudget.remaining -= jr.calls;
      if (jr.bestCand) entry.best = jr.bestCand;
    }

    const row = buildEvidenceRow({
      target: entry.target,
      unit: entry.best.unit,
      targetFp: entry.best.tfp,
      local: entry.best.local,
      embeddingScore,
      threshold,
    });
    decideMatch(row, { bestLocalScore, band, embeddingScore, threshold, deepScan: false });
    row.methodLabel = describeMethod(row);
    quickResults.push(row);

    if (!row.matched) {
      const esc = shouldEscalateToDeepScan({
        band,
        localScore: bestLocalScore,
        localScores: entry.best.local.localScores,
        matched: false,
        mediaKind,
        jinaAvailable: jina.available,
        embeddingScore,
        threshold,
      });
      if (esc.escalate) {
        needsDeep = true;
        deepReason = deepReason || esc.reason;
      }
    }
  }

  // If any quick match is conclusive, skip deep scan (keep it fast).
  const quickMatch = pickStrongest(quickResults.filter((r) => r.matched));
  if (quickMatch && quickMatch.finalScore >= (quickMatch.threshold ?? 0.9)) {
    needsDeep = false;
  }
  // Dry-run: escalate top uncertain for diagnostics when no match.
  if (dryRun && !quickMatch && ranked[0]) {
    needsDeep = true;
    deepReason = deepReason || 'dry_run_diagnostics';
  }

  let results = quickResults;

  // ---- Deep scan -----------------------------------------------------------
  if (needsDeep) {
    deepScan = true;
    escalateReason = deepReason || 'uncertain';
    try {
      const excludeFrameIndices = [
        ...new Set(quick.frames.map((f) => f.frameIndex)),
      ];
      const excludeTimestamps = [
        ...new Set(quick.frames.map((f) => f.timestampSec || 0)),
      ];

      const deep = await withTimeout(
        analyzeMediaUnits(buffer, meta, {
          deep: true,
          maxVariants: IMAGE_TARGET_DEEP_MAX_VARIANTS,
          sampleOpts: { excludeFrameIndices, excludeTimestamps },
        }),
        IMAGE_TARGET_DEEP_ANALYSIS_TIMEOUT_MS,
      );

      // Merge units (deep frames + re-analyze top quick frames with deep variants).
      const deepUnits = deep.units;
      framesDeepAnalyzed = deep.frameCount;
      framesSampled += deep.frameCount;
      framesDeduped += deep.framesDeduped || 0;

      // Also generate deep variants for the strongest quick-scan frames.
      const topQuickFrames = [];
      const seenFi = new Set();
      for (const r of ranked.slice(0, 2)) {
        const fi = r.best.unit.frameIndex;
        if (seenFi.has(fi)) continue;
        seenFi.add(fi);
        const frame = quick.frames.find((f) => f.frameIndex === fi);
        if (frame) topQuickFrames.push(frame);
      }
      for (const frame of topQuickFrames) {
        const variants = await generateVariants(frame.buffer, {
          maxVariants: IMAGE_TARGET_DEEP_MAX_VARIANTS,
          deep: true,
        });
        for (const variant of variants) {
          // Skip keys already scored in quick pass for this frame.
          if (
            units.some(
              (u) =>
                u.frameIndex === frame.frameIndex &&
                u.variantKey === variant.key,
            )
          ) {
            continue;
          }
          const fp = await fingerprintImage(variant.buffer, {
            withFeatures:
              IMAGE_TARGET_FEATURES_ENABLED && variant.key === 'original',
          });
          deepUnits.push({
            mediaKind,
            frameIndex: frame.frameIndex,
            timestampSec: frame.timestampSec,
            variantKey: variant.key,
            buffer: variant.buffer,
            fingerprint: fp,
            sourceContentHash,
            deep: true,
          });
        }
      }

      // V3 forensic: screenshot strips, collage tiles, adaptive crops on top frames.
      const forensicFrames = [
        ...topQuickFrames,
        ...(deep.frames || []).slice(0, 2),
      ];
      const seenForensic = new Set();
      for (const frame of forensicFrames) {
        const key = `${frame.frameIndex}:${frame.timestampSec || 0}`;
        if (seenForensic.has(key)) continue;
        seenForensic.add(key);
        try {
          const extra = await buildForensicUnits(frame.buffer, {
            mediaKind,
            frameIndex: frame.frameIndex,
            timestampSec: frame.timestampSec,
            sourceContentHash,
          });
          deepUnits.push(...extra);
          regionsAnalyzed += extra.length;
        } catch (err) {
          log.warn('[image-target] forensic units failed:', err.message);
        }
      }

      units = [...units, ...deepUnits];
      variantsAnalyzed = units.length;
      mediaKind = deep.mediaKind || mediaKind;
      ranked = scoreUnitsAgainstTargets(units, targets, targetFps);

      results = [];
      for (const entry of ranked) {
        const threshold =
          IMAGE_TARGET_EMBEDDING_THRESHOLD ??
          (await effectiveThreshold(guildId, entry.target));
        const bestLocalScore = entry.best.local.localScore;
        const band = classifyLocalEvidence(bestLocalScore);
        const temporal = scoreTemporalEvidence(
          units,
          targetFps.get(entry.target.targetId) || [],
        );
        const extras = {
          ...enrichPairSignals(entry.best.local, entry.rows || []),
          ...temporal,
        };

        if (band === 'skip' && !dryRun) {
          // Deep pass: still allow Jina if preliminary relevance says edited.
          const esc = shouldEscalateToDeepScan({
            band,
            localScore: bestLocalScore,
            localScores: entry.best.local.localScores,
            matched: false,
            mediaKind,
            jinaAvailable: jina.available,
          });
          // Also escalate when ORB/partial/sequence looks promising.
          const forensicPromise =
            (extras.featureScore || 0) >= 0.5 ||
            (extras.contentOverlap || 0) >= IMAGE_TARGET_PARTIAL_OVERLAP_FLOOR ||
            (extras.sequenceMatches || 0) >= 2;
          if (!esc.escalate && !forensicPromise) continue;
        }

        if (band === 'obvious') {
          const row = buildEvidenceRow({
            target: entry.target,
            unit: entry.best.unit,
            targetFp: entry.best.tfp,
            local: entry.best.local,
            threshold,
            deepScan: true,
            extras,
          });
          const ls = entry.best.local.localScores || {};
          row.matched =
            (ls.pHash ?? 0) >= 0.7 ||
            (ls.dHash ?? 0) >= 0.8 ||
            (ls.blockHash ?? 0) >= 0.8 ||
            (ls.pdqHash ?? 0) >= 0.78;
          if (row.matched) {
            row.methodLabel = describeMethod(row);
            results.push(row);
            continue;
          }
        }

        let embeddingScore = null;
        if (
          jina.available &&
          (entry.best.tfp.embedding?.length || entry.target.embedding?.length) &&
          jinaBudget.remaining > 0
        ) {
          const jr = await runMultiJina({
            jina,
            entry,
            targetFps,
            embedUnit,
            jinaBudget,
            dryRun: true, // allow poor local during deep
            threshold,
          });
          embeddingScore = jr.embeddingScore;
          jinaCalls += jr.calls;
          if (jr.bestCand) entry.best = jr.bestCand;
        }

        const row = buildEvidenceRow({
          target: entry.target,
          unit: entry.best.unit,
          targetFp: entry.best.tfp,
          local: entry.best.local,
          embeddingScore,
          threshold,
          deepScan: true,
          extras,
        });
        decideMatch(row, {
          bestLocalScore: entry.best.local.localScore,
          band: classifyLocalEvidence(entry.best.local.localScore),
          embeddingScore,
          threshold,
          deepScan: true,
        });
        row.methodLabel = describeMethod(row);
        results.push(row);
      }
      // regionsAnalyzed already accumulated above
    } catch (err) {
      if (String(err.message || err).includes('timeout')) {
        log.warn('[image-target] deep scan timeout — using quick-scan results');
        escalateReason = `${escalateReason || 'deep'}+timeout`;
        results = quickResults;
      } else {
        log.warn('[image-target] deep scan failed:', err.message);
        results = quickResults;
      }
    }
  }

  results.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
  const diagnostics = buildDeepScanDiagnostics({
    deepScan,
    reason: escalateReason,
    framesSampled,
    framesDeepAnalyzed,
    variantsAnalyzed,
    jinaCalls,
    framesDeduped,
    regionsAnalyzed,
  });

  for (const row of results) {
    row.score = row.finalScore;
    row.diagnostics = diagnostics;
    row.deepScan = deepScan;
  }

  const top = pickStrongest(results.filter((r) => r.matched)) || null;

  return {
    match: top,
    results,
    mediaKind,
    sourceContentHash,
    jinaAvailable: jina.available,
    diagnostics,
  };
}

export async function matchAgainstTargets(guildId, buffer, opts = {}) {
  try {
    const report = await withTimeout(
      scoreMediaAgainstTargets(guildId, buffer, {
        meta: opts.meta || {},
        dryRun: false,
      }),
      IMAGE_TARGET_DEEP_ANALYSIS_TIMEOUT_MS,
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

export async function testAgainstTargets(guildId, buffer, opts = {}) {
  try {
    const report = await withTimeout(
      scoreMediaAgainstTargets(guildId, buffer, {
        meta: opts.meta || {},
        dryRun: true,
      }),
      IMAGE_TARGET_DEEP_ANALYSIS_TIMEOUT_MS,
    );

    if (!report.results?.length && report.message) {
      return {
        match: false,
        results: [],
        message: report.message,
        diagnostics: report.diagnostics,
      };
    }

    const top = report.match || report.results[0] || null;
    return {
      match: Boolean(report.match),
      results: report.results,
      top,
      jinaAvailable: report.jinaAvailable,
      jinaError: null,
      mediaKind: report.mediaKind,
      diagnostics: report.diagnostics,
      reportText: formatTestResult(top, report.diagnostics),
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
        diagnostics: buildDeepScanDiagnostics({
          deepScan: true,
          reason: 'timeout',
        }),
      };
    }
    throw err;
  }
}

export {
  classifyLocalEvidence,
  describeMethod,
  formatTestResult,
  localSimilarity,
  shouldEscalateToDeepScan,
  buildDeepScanDiagnostics,
};
