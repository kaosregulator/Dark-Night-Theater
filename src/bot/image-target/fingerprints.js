import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { BLOCKHASH_BITS, IMAGE_TARGET_HASH_EDGE } from './constants.js';

/**
 * Multi-fingerprint module (Image Target V2).
 *
 * Ensemble:
 *   - dHash  (64-bit difference hash)
 *   - aHash  (64-bit average hash)
 *   - pHash  (64-bit DCT perceptual hash)
 *   - blockHash (256-bit block mean hash)
 *   - edgeHash (64-bit gradient/edge fingerprint)
 *
 * No single hash is authoritative — localSimilarity() blends them.
 */

/** Decode image bytes to raw RGBA (first frame for GIF/animated unless pages set). */
export async function decodeRgba(buffer, { maxEdge = IMAGE_TARGET_HASH_EDGE, page } = {}) {
  const opts = { animated: false, failOn: 'none' };
  if (page != null) opts.page = page;
  const img = sharp(buffer, opts);
  const meta = await img.metadata();
  if (!meta.width || !meta.height) {
    throw new Error('not_an_image');
  }
  if (meta.width > 8192 || meta.height > 8192) {
    throw new Error('image_too_large');
  }

  const { data, info } = await img
    .rotate() // honour EXIF orientation
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels,
    format: meta.format || null,
  };
}

/** SHA-256 of raw bytes — exact-duplicate short-circuit / cache key. */
export function contentHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function bitsToHex(bits) {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nibble =
      ((bits[i] ? 1 : 0) << 3) |
      ((bits[i + 1] ? 1 : 0) << 2) |
      ((bits[i + 2] ? 1 : 0) << 1) |
      (bits[i + 3] ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

/**
 * 64-bit difference hash.
 * Resize to 9×8 greyscale, compare each pixel to its right neighbour → 64 bits.
 */
export async function computeDHash(buffer) {
  const { data } = await sharp(buffer, { animated: false, failOn: 'none' })
    .rotate()
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bits = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * 9 + x];
      const right = data[y * 9 + x + 1];
      bits.push(left < right);
    }
  }
  return bitsToHex(bits);
}

/**
 * 64-bit average hash.
 * Resize to 8×8 greyscale, bit = pixel > mean.
 */
export async function computeAHash(buffer) {
  const { data } = await sharp(buffer, { animated: false, failOn: 'none' })
    .rotate()
    .greyscale()
    .resize(8, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const mean = sum / data.length;
  const bits = [];
  for (let i = 0; i < data.length; i++) bits.push(data[i] > mean);
  return bitsToHex(bits);
}

/**
 * Minimal 2D DCT-II for an 8×8 (or 32×32) block.
 */
function dct2d(input, size) {
  const out = new Float64Array(size * size);
  for (let u = 0; u < size; u++) {
    for (let v = 0; v < size; v++) {
      let sum = 0;
      for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
          sum +=
            input[y * size + x] *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
        }
      }
      const cu = u === 0 ? 1 / Math.SQRT2 : 1;
      const cv = v === 0 ? 1 / Math.SQRT2 : 1;
      out[u * size + v] = 0.25 * cu * cv * sum;
    }
  }
  return out;
}

/**
 * 64-bit pHash (DCT low-frequency).
 * Resize to 32×32 greyscale → DCT → take 8×8 low-freq (skip DC) → median bit.
 */
export async function computePHash(buffer) {
  const size = 32;
  const { data } = await sharp(buffer, { animated: false, failOn: 'none' })
    .rotate()
    .greyscale()
    .resize(size, size, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Float64Array(size * size);
  for (let i = 0; i < pixels.length; i++) pixels[i] = data[i];
  const dct = dct2d(pixels, size);

  // Low-frequency 8×8, excluding DC at (0,0).
  const coeffs = [];
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      if (u === 0 && v === 0) continue;
      coeffs.push(dct[u * size + v]);
    }
  }
  // Need 64 bits — include one more from row 0 col 8 area by duplicating median fill.
  while (coeffs.length < 64) coeffs.push(coeffs[coeffs.length - 1] ?? 0);

  const sample = coeffs.slice(0, 64);
  const sorted = [...sample].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const bits = sample.map((c) => c > median);
  return bitsToHex(bits);
}

/**
 * Block mean hash (even grid), ported from commonsmachinery/blockhash ideas.
 * bits=16 → 256-bit hex string (64 hex chars).
 */
export function computeBlockHashFromRgba(rgba, width, height, bits = BLOCKHASH_BITS) {
  const blockW = Math.floor(width / bits);
  const blockH = Math.floor(height / bits);
  if (blockW < 1 || blockH < 1) {
    throw new Error('image_too_small');
  }

  const blocks = new Array(bits * bits).fill(0);
  for (let by = 0; by < bits; by++) {
    for (let bx = 0; bx < bits; bx++) {
      let total = 0;
      for (let iy = 0; iy < blockH; iy++) {
        for (let ix = 0; ix < blockW; ix++) {
          const x = bx * blockW + ix;
          const y = by * blockH + iy;
          const i = (y * width + x) * 4;
          const a = rgba[i + 3];
          // Transparent pixels count as white (same as blockhash-js).
          total += a === 0 ? 765 : rgba[i] + rgba[i + 1] + rgba[i + 2];
        }
      }
      blocks[by * bits + bx] = total;
    }
  }

  const pixelsPerBlock = blockW * blockH;
  const half = (pixelsPerBlock * 256 * 3) / 2;
  const band = blocks.length / 4;

  // Compare each band against its own median (robust to vignette / gradients).
  for (let b = 0; b < 4; b++) {
    const slice = blocks.slice(b * band, (b + 1) * band);
    const sorted = [...slice].sort((a, c) => a - c);
    const mid = sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
    for (let j = b * band; j < (b + 1) * band; j++) {
      const v = blocks[j];
      blocks[j] = Number(v > mid || (Math.abs(v - mid) < 1 && mid > half));
    }
  }

  let hex = '';
  for (let i = 0; i < blocks.length; i += 4) {
    const nibble =
      (blocks[i] << 3) | (blocks[i + 1] << 2) | (blocks[i + 2] << 1) | blocks[i + 3];
    hex += nibble.toString(16);
  }
  return hex;
}

/**
 * 64-bit edge/gradient fingerprint.
 * Sobel-ish magnitude on 9×8 greyscale, then dHash-style neighbour compare.
 */
export async function computeEdgeHash(buffer) {
  const { data, info } = await sharp(buffer, { animated: false, failOn: 'none' })
    .rotate()
    .greyscale()
    .resize(10, 9, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const mag = new Float64Array((w - 2) * (h - 2));
  let mi = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -data[i - w - 1] +
        data[i - w + 1] -
        2 * data[i - 1] +
        2 * data[i + 1] -
        data[i + w - 1] +
        data[i + w + 1];
      const gy =
        -data[i - w - 1] -
        2 * data[i - w] -
        data[i - w + 1] +
        data[i + w - 1] +
        2 * data[i + w] +
        data[i + w + 1];
      mag[mi++] = Math.abs(gx) + Math.abs(gy);
    }
  }

  // Reduce to 8×8 by averaging 8×7? We have 8×7 from 10×9. Pad/resample.
  const ew = w - 2; // 8
  const eh = h - 2; // 7
  const grid = new Float64Array(64);
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const sy = Math.min(eh - 1, Math.floor((gy * eh) / 8));
      const sx = Math.min(ew - 1, gx);
      grid[gy * 8 + gx] = mag[sy * ew + sx];
    }
  }

  let sum = 0;
  for (let i = 0; i < 64; i++) sum += grid[i];
  const mean = sum / 64;
  const bits = [];
  for (let i = 0; i < 64; i++) bits.push(grid[i] > mean);
  return bitsToHex(bits);
}

/** Hamming distance between two equal-length hex hashes. */
export function hammingDistance(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) {
    return Number.POSITIVE_INFINITY;
  }
  const popcount = [
    0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4,
  ];
  let d = 0;
  for (let i = 0; i < hexA.length; i++) {
    const x = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    d += popcount[x];
  }
  return d;
}

/** Similarity in [0,1] derived from Hamming distance (1 = identical). */
export function hammingSimilarity(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return 0;
  const bits = hexA.length * 4;
  const dist = hammingDistance(hexA, hexB);
  if (!Number.isFinite(dist)) return 0;
  return Math.max(0, 1 - dist / bits);
}

/**
 * Compute the full fingerprint suite for an image buffer.
 * Returns hashes + dimensions + contentHash.
 */
export async function fingerprintImage(buffer) {
  const rgba = await decodeRgba(buffer, { maxEdge: IMAGE_TARGET_HASH_EDGE });
  const [dHash, aHash, pHash, edgeHash] = await Promise.all([
    computeDHash(buffer),
    computeAHash(buffer),
    computePHash(buffer),
    computeEdgeHash(buffer),
  ]);
  const blockHash = computeBlockHashFromRgba(
    rgba.data,
    rgba.width,
    rgba.height,
    BLOCKHASH_BITS,
  );
  return {
    dHash,
    aHash,
    pHash,
    blockHash,
    edgeHash,
    contentHash: contentHash(buffer),
    width: rgba.width,
    height: rgba.height,
    format: rgba.format,
  };
}

/**
 * Local ensemble similarity between two fingerprint objects.
 * Returns { score, scores: { dHash, aHash, pHash, blockHash, edgeHash } }.
 */
export function localSimilarity(a, b) {
  const scores = {
    dHash: hammingSimilarity(a?.dHash || a?.perceptualHash, b?.dHash || b?.perceptualHash),
    aHash: hammingSimilarity(a?.aHash, b?.aHash),
    pHash: hammingSimilarity(a?.pHash, b?.pHash),
    blockHash: hammingSimilarity(a?.blockHash, b?.blockHash),
    edgeHash: hammingSimilarity(a?.edgeHash, b?.edgeHash),
  };

  // Weight available hashes. Missing hashes (V1 targets without aHash/pHash/edge)
  // simply drop out of the average.
  const weights = {
    dHash: 1.0,
    aHash: 0.85,
    pHash: 1.1,
    blockHash: 1.0,
    edgeHash: 0.75,
  };

  let total = 0;
  let wsum = 0;
  const present = [];
  for (const [k, w] of Object.entries(weights)) {
    const s = scores[k];
    const aHas =
      k === 'dHash'
        ? Boolean(a?.dHash || a?.perceptualHash)
        : Boolean(a?.[k]);
    const bHas =
      k === 'dHash'
        ? Boolean(b?.dHash || b?.perceptualHash)
        : Boolean(b?.[k]);
    if (!aHas || !bHas) continue;
    total += s * w;
    wsum += w;
    present.push(s);
  }

  const weighted = wsum > 0 ? total / wsum : 0;
  // Robust fallback only when several channels agree — avoids false positives
  // from a single noisy hash (e.g. edgeHash on unrelated patterned images).
  present.sort((x, y) => y - x);
  const strongCount = present.filter((s) => s >= 0.75).length;
  const top2 =
    present.length >= 2
      ? (present[0] + present[1]) / 2
      : present[0] || 0;
  const score =
    strongCount >= 3
      ? Math.max(weighted, top2 * 0.98)
      : weighted;
  return { score, scores, weighted, top2, strongCount };
}

/**
 * Prepare a compact JPEG for embedding APIs (smaller → fewer Jina tokens).
 * Resizes longest edge to 512 and encodes JPEG q80.
 */
export async function prepareForEmbedding(buffer) {
  return sharp(buffer, { animated: false, failOn: 'none' })
    .rotate()
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
}
