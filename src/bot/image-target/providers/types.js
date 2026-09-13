/**
 * ImageSimilarityProvider — modular interface for visual embeddings.
 *
 * Implementations must:
 *   - generateEmbedding(imageBuffer) → number[] | Float32Array
 *   - compareEmbeddings(a, b) → cosine similarity in roughly [-1, 1]
 *   - getSimilarityScore(a, b) → same as compareEmbeddings (alias)
 *
 * Do NOT use chat/vision LLMs here — embeddings only.
 */

/** L2-normalize a vector in place-friendly copy. */
export function l2Normalize(vec) {
  const arr = Float64Array.from(vec);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < arr.length; i++) arr[i] /= norm;
  return arr;
}

/**
 * Cosine similarity of two vectors.
 * If already L2-normalized, this equals the dot product.
 * Result is clamped to [0, 1] for reporting (negative → 0) because
 * image-image matches for CLIP-style models live in the positive half.
 */
export function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!denom) return 0;
  const raw = dot / denom;
  // Map [-1,1] → [0,1] for a stable "percent match" display, OR clamp.
  // We clamp: negative similarity is "not similar" for this use-case.
  return Math.max(0, Math.min(1, raw));
}

export class ImageSimilarityProvider {
  get name() {
    return 'base';
  }

  get available() {
    return false;
  }

  async generateEmbedding(_imageBuffer) {
    throw new Error('not_implemented');
  }

  compareEmbeddings(a, b) {
    return cosineSimilarity(a, b);
  }

  getSimilarityScore(a, b) {
    return this.compareEmbeddings(a, b);
  }
}
