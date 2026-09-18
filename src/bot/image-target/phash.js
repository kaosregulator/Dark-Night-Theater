/**
 * Backward-compatible re-exports.
 * Canonical implementation lives in fingerprints.js (V2 multi-hash suite).
 */
export {
  decodeRgba,
  contentHash,
  computeDHash,
  computeBlockHashFromRgba,
  hammingDistance,
  hammingSimilarity,
  fingerprintImage,
  prepareForEmbedding,
} from './fingerprints.js';
