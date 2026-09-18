// Image Target Watcher — defaults and limits (V2).
// Local multi-hash ensemble ranks candidates; Jina is used for uncertain/edited matches.

function envInt(name, fallback, { min = 1, max = 10_000 } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function envFloat(name, fallback, { min = 0, max = 1 } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Max download / attachment size for analysis (bytes). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Reject absurdly huge dimensions even if file size is small. */
export const MAX_IMAGE_EDGE = 8192;

/** Fetch timeout for Discord CDN + external image URLs. */
export const FETCH_TIMEOUT_MS = 10_000;

/** Max redirects when downloading external URLs. */
export const MAX_REDIRECTS = 3;

/**
 * Default cosine similarity threshold for Jina embeddings.
 * Score is cosine similarity in [0, 1] after L2-normalizing vectors
 * (or using Jina's `normalized: true` response). A match is reported when
 * similarity >= threshold.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.9;

/**
 * Legacy pHash Hamming-distance gates (64-bit / 16-hex-char hashes).
 * Kept for backward-compatible helpers; V2 prefers similarity scores.
 * - <= OBVIOUS_MATCH_HAMMING → treat as match without calling Jina
 * - <= CANDIDATE_HAMMING → potentially similar → call Jina if available
 * - > CANDIDATE_HAMMING → ignore (save API quota)
 */
export const OBVIOUS_MATCH_HAMMING = 6;
export const CANDIDATE_HAMMING = 18;

/** Blockhash bits (16 → 256-bit hex). We also store a 64-bit dHash. */
export const BLOCKHASH_BITS = 16;

// ---- Image Target V2 budgets / thresholds ---------------------------------

/** Max frames sampled from a GIF/APNG/video. */
export const IMAGE_TARGET_MAX_FRAMES = envInt('IMAGE_TARGET_MAX_FRAMES', 10, {
  min: 2,
  max: 24,
});

/** Preferred video sample count (still bounded by MAX_FRAMES). */
export const IMAGE_TARGET_VIDEO_SAMPLE_COUNT = envInt(
  'IMAGE_TARGET_VIDEO_SAMPLE_COUNT',
  8,
  { min: 3, max: 24 },
);

/** Max media items analyzed per message (attachments+embeds+urls+…). */
export const IMAGE_TARGET_MAX_MEDIA_PER_MESSAGE = envInt(
  'IMAGE_TARGET_MAX_MEDIA_PER_MESSAGE',
  12,
  { min: 1, max: 32 },
);

/** Max comparison variants generated per sampled frame. */
export const IMAGE_TARGET_MAX_VARIANTS = envInt('IMAGE_TARGET_MAX_VARIANTS', 9, {
  min: 1,
  max: 16,
});

/** Hard wall-clock budget for analyzing one media buffer. */
export const IMAGE_TARGET_ANALYSIS_TIMEOUT_MS = envInt(
  'IMAGE_TARGET_ANALYSIS_TIMEOUT_MS',
  25_000,
  { min: 3_000, max: 120_000 },
);

/** FFmpeg per-invocation timeout (ms). */
export const IMAGE_TARGET_FFMPEG_TIMEOUT_MS = envInt(
  'IMAGE_TARGET_FFMPEG_TIMEOUT_MS',
  15_000,
  { min: 2_000, max: 60_000 },
);

/** Concurrent media analyses across the process. */
export const IMAGE_TARGET_CONCURRENCY = envInt('IMAGE_TARGET_CONCURRENCY', 2, {
  min: 1,
  max: 8,
});

/** Longest edge when normalizing frames for hashing. */
export const IMAGE_TARGET_HASH_EDGE = envInt('IMAGE_TARGET_HASH_EDGE', 512, {
  min: 128,
  max: 1024,
});

/**
 * Local ensemble similarity above which we treat as an obvious match
 * without calling Jina (when embeddings are unavailable or unnecessary).
 */
export const LOCAL_OBVIOUS_SIMILARITY = envFloat(
  'IMAGE_TARGET_LOCAL_OBVIOUS',
  0.88,
);

/**
 * Below this local similarity, skip expensive embedding (clearly unrelated).
 * Soft gate — not an absolute rejection for borderline edited targets.
 */
export const LOCAL_SKIP_SIMILARITY = envFloat('IMAGE_TARGET_LOCAL_SKIP', 0.32);

/**
 * Local similarity at/above which we always request Jina when available
 * (uncertain / potentially modified target band).
 */
export const LOCAL_CANDIDATE_SIMILARITY = envFloat(
  'IMAGE_TARGET_LOCAL_CANDIDATE',
  0.52,
);

/**
 * When Jina is unavailable, accept a local ensemble match at/above this floor.
 * Keeps edited near-duplicates actionable without embeddings.
 */
export const LOCAL_MATCH_WITHOUT_EMBEDDING = envFloat(
  'IMAGE_TARGET_LOCAL_MATCH',
  0.82,
);

/**
 * During deep scan only: slightly lower local floor for heavily edited media
 * when core hashes still agree (pHash/dHash). Does not apply to quick scan.
 */
export const DEEP_LOCAL_MATCH_WITHOUT_EMBEDDING = envFloat(
  'IMAGE_TARGET_DEEP_LOCAL_MATCH',
  0.60,
);

/**
 * Override embedding match threshold (falls back to guild/target threshold).
 * Env IMAGE_TARGET_EMBEDDING_THRESHOLD.
 */
export const IMAGE_TARGET_EMBEDDING_THRESHOLD = (() => {
  const raw = process.env.IMAGE_TARGET_EMBEDDING_THRESHOLD;
  if (raw == null || raw === '') return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
})();

/** Max fingerprints stored per target (frames × variants, capped). */
export const IMAGE_TARGET_MAX_STORED_FINGERPRINTS = envInt(
  'IMAGE_TARGET_MAX_STORED_FINGERPRINTS',
  40,
  { min: 4, max: 120 },
);

// ---- Image Target V2.1 adaptive deep-scan budgets ------------------------

/** Deep-scan frame cap (GIF/video second pass). */
export const IMAGE_TARGET_DEEP_MAX_FRAMES = envInt(
  'IMAGE_TARGET_DEEP_MAX_FRAMES',
  18,
  { min: 4, max: 36 },
);

/** Deep-scan variant cap per frame (extra crop/color/screenshot transforms). */
export const IMAGE_TARGET_DEEP_MAX_VARIANTS = envInt(
  'IMAGE_TARGET_DEEP_MAX_VARIANTS',
  20,
  { min: 4, max: 32 },
);

/** Max Jina embedding calls per media item (quick + deep combined). */
export const IMAGE_TARGET_MAX_JINA_CALLS = envInt(
  'IMAGE_TARGET_MAX_JINA_CALLS',
  6,
  { min: 1, max: 16 },
);

/** Extra wall-clock budget when deep scan escalates (ms, additive soft cap). */
export const IMAGE_TARGET_DEEP_ANALYSIS_TIMEOUT_MS = envInt(
  'IMAGE_TARGET_DEEP_ANALYSIS_TIMEOUT_MS',
  35_000,
  { min: 5_000, max: 120_000 },
);

/**
 * Single-channel hash hint used as a cheap "preliminary relevance" test when
 * the ensemble score looks like a hard skip (heavily edited targets).
 */
export const DEEP_RELEVANCE_CHANNEL_MIN = envFloat(
  'IMAGE_TARGET_DEEP_RELEVANCE',
  0.45,
);

/** Hamming distance at/below which two frames are treated as near-duplicates. */
export const FRAME_DEDUP_HAMMING = envInt('IMAGE_TARGET_FRAME_DEDUP_HAMMING', 4, {
  min: 0,
  max: 16,
});

// ---- Image Target V3 forensic budgets ------------------------------------

/** Enable ORB-style local features during deep scan / storage (1=on). */
export const IMAGE_TARGET_FEATURES_ENABLED = envInt('IMAGE_TARGET_FEATURES', 1, {
  min: 0,
  max: 1,
}) === 1;

/** Max collage/region tiles analyzed during deep scan. */
export const IMAGE_TARGET_MAX_REGIONS = envInt('IMAGE_TARGET_MAX_REGIONS', 14, {
  min: 4,
  max: 24,
});

/** Max adaptive crops during deep recursive crop search. */
export const IMAGE_TARGET_MAX_ADAPTIVE_CROPS = envInt(
  'IMAGE_TARGET_MAX_ADAPTIVE_CROPS',
  12,
  { min: 4, max: 24 },
);

/** Top-K targets from embedding ANN before expensive forensic matching. */
export const IMAGE_TARGET_VECTOR_TOP_K = envInt('IMAGE_TARGET_VECTOR_TOP_K', 10, {
  min: 3,
  max: 50,
});

/** Min ORB matches to treat local features as strong evidence. */
export const IMAGE_TARGET_FEATURE_MIN_MATCHES = envInt(
  'IMAGE_TARGET_FEATURE_MIN_MATCHES',
  12,
  { min: 4, max: 48 },
);

/** Partial-overlap score floor for "likely target match" reporting. */
export const IMAGE_TARGET_PARTIAL_OVERLAP_FLOOR = envFloat(
  'IMAGE_TARGET_PARTIAL_OVERLAP',
  0.62,
);

/** Supported still-image MIME / extensions. */
export const IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/apng',
]);

export const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'apng',
]);

/** Video extensions we attempt to sample still frames from (requires ffmpeg). */
export const VIDEO_EXT = new Set([
  'mp4', 'webm', 'mov', 'mkv', 'avi',
]);

/** Default moderation action when a target matches. */
export const DEFAULT_ACTION = 'delete_warn';

export const ACTIONS = [
  'log',
  'delete_log',
  'delete_warn',
  'delete_timeout',
  'delete_kick',
  'delete_ban',
];

/** Escalation ladder (optional). Index = prior strike count for this user+guild. */
export const DEFAULT_ESCALATION = ['delete_warn', 'delete_timeout', 'delete_kick', 'delete_ban'];

/** Default timeout duration for delete_timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** How many recent detections to keep per guild in the JSON log. */
export const MAX_DETECTION_LOG = 500;

/** In-memory embedding cache TTL (ms) keyed by content hash. */
export const EMBEDDING_CACHE_TTL_MS = 30 * 60 * 1000;
export const EMBEDDING_CACHE_MAX = 256;
