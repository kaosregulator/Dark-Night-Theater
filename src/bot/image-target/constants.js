// Image Target Watcher — defaults and limits.
// Keep this feature lightweight: local pHash first, Jina only when needed.

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
 * pHash Hamming-distance gates (64-bit / 16-hex-char hashes).
 * - <= OBVIOUS_MATCH_HAMMING → treat as match without calling Jina
 * - <= CANDIDATE_HAMMING → potentially similar → call Jina if available
 * - > CANDIDATE_HAMMING → ignore (save API quota)
 */
export const OBVIOUS_MATCH_HAMMING = 6;
export const CANDIDATE_HAMMING = 18;

/** Blockhash bits (16 → 256-bit hex). We also store a 64-bit dHash. */
export const BLOCKHASH_BITS = 16;

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

/** Video extensions we attempt to sample a still frame from (requires ffmpeg). */
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
