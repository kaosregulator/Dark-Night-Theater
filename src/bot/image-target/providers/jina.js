import { log } from '../../../logger.js';
import { config } from '../../../config.js';
import {
  EMBEDDING_CACHE_MAX,
  EMBEDDING_CACHE_TTL_MS,
} from '../constants.js';
import {
  ImageSimilarityProvider,
  cosineSimilarity,
  l2Normalize,
} from './types.js';
import { prepareForEmbedding } from '../phash.js';

/**
 * Jina AI jina-clip-v2 image embeddings.
 * Free API key: https://jina.ai/?sui=apikey  → env JINA_API_KEY
 *
 * Similarity = cosine similarity of L2-normalized embeddings, clamped to [0,1].
 * With `normalized: true` this equals the dot product.
 * A score of 0.90 means the vectors are very close — not an absolute
 * "90% same pixels" guarantee.
 */

const JINA_URL = 'https://api.jina.ai/v1/embeddings';
const MODEL = 'jina-clip-v2';
const REQUEST_TIMEOUT_MS = 15_000;

export class JinaClipProvider extends ImageSimilarityProvider {
  constructor({ apiKey = process.env.JINA_API_KEY || config.jina?.apiKey, model = MODEL } = {}) {
    super();
    this.apiKey = (apiKey || '').trim();
    this.model = model;
    /** @type {Map<string, { embedding: number[], expires: number }>} */
    this._cache = new Map();
    /** @type {Map<string, Promise<number[]>>} */
    this._inflight = new Map();
    this._rateLimitedUntil = 0;
  }

  get name() {
    return 'jina-clip-v2';
  }

  get available() {
    return Boolean(this.apiKey) && Date.now() >= this._rateLimitedUntil;
  }

  getSimilarityScore(a, b) {
    return cosineSimilarity(a, b);
  }

  compareEmbeddings(a, b) {
    return cosineSimilarity(a, b);
  }

  _cacheGet(key) {
    const hit = this._cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) {
      this._cache.delete(key);
      return null;
    }
    this._cache.delete(key);
    this._cache.set(key, hit);
    return hit.embedding;
  }

  _cacheSet(key, embedding) {
    if (this._cache.size >= EMBEDDING_CACHE_MAX) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    this._cache.set(key, {
      embedding,
      expires: Date.now() + EMBEDDING_CACHE_TTL_MS,
    });
  }

  /**
   * @param {Buffer} imageBuffer
   * @param {{ cacheKey?: string }} [opts]
   * @returns {Promise<number[]>}
   */
  async generateEmbedding(imageBuffer, opts = {}) {
    if (!this.apiKey) throw new Error('jina_no_api_key');
    if (Date.now() < this._rateLimitedUntil) throw new Error('jina_rate_limited');

    const cacheKey = opts.cacheKey || null;
    if (cacheKey) {
      const cached = this._cacheGet(cacheKey);
      if (cached) return cached;
      if (this._inflight.has(cacheKey)) return this._inflight.get(cacheKey);
    }

    const work = this._embed(imageBuffer);
    if (cacheKey) this._inflight.set(cacheKey, work);
    try {
      const embedding = await work;
      if (cacheKey) this._cacheSet(cacheKey, embedding);
      return embedding;
    } finally {
      if (cacheKey) this._inflight.delete(cacheKey);
    }
  }

  async _embed(imageBuffer) {
    // Shrink before upload — fewer Jina image tiles / tokens.
    const jpeg = await prepareForEmbedding(imageBuffer);
    const b64 = jpeg.toString('base64');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(JINA_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: [{ image: b64 }],
          normalized: true,
          embedding_type: 'float',
        }),
      });

      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after') || 30);
        this._rateLimitedUntil = Date.now() + Math.min(Math.max(retry, 5), 300) * 1000;
        log.warn('[image-target] Jina rate-limited; falling back to local pHash');
        throw new Error('jina_rate_limited');
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log.warn(`[image-target] Jina HTTP ${res.status}: ${text.slice(0, 200)}`);
        throw new Error(`jina_http_${res.status}`);
      }

      const json = await res.json();
      const vec = json?.data?.[0]?.embedding;
      if (!Array.isArray(vec) || !vec.length) {
        throw new Error('jina_empty_embedding');
      }
      return Array.from(l2Normalize(vec));
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('jina_timeout');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

let singleton = null;

export function getJinaProvider() {
  if (!singleton) singleton = new JinaClipProvider();
  singleton.apiKey = (process.env.JINA_API_KEY || config.jina?.apiKey || '').trim();
  return singleton;
}
