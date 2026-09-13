import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { BLOCKHASH_BITS } from './constants.js';

/**
 * Local perceptual hashing (two hashes):
 * 1) dHash  — 64-bit difference hash (fast, good for near-duplicates)
 * 2) blockHash — 256-bit block mean hash (inspired by discord-image-dupe / blockhash)
 *
 * Hamming distance on these is the cheap stage-1 filter before Jina.
 */

/** Decode image bytes to raw RGBA (first frame for GIF/animated). */
export async function decodeRgba(buffer, { maxEdge = 1024 } = {}) {
  const img = sharp(buffer, { animated: false, failOn: 'none' });
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

/**
 * 64-bit difference hash.
 * Resize to 9×8 greyscale, compare each pixel to its right neighbour → 64 bits.
 */
export async function computeDHash(buffer) {
  const { data, info } = await sharp(buffer, { animated: false, failOn: 'none' })
    .rotate()
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * 9 + x];
      const right = data[y * 9 + x + 1];
      bits += left < right ? '1' : '0';
    }
  }
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
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
  const bits = hexA.length * 4;
  const dist = hammingDistance(hexA, hexB);
  if (!Number.isFinite(dist)) return 0;
  return Math.max(0, 1 - dist / bits);
}

/**
 * Compute both hashes for a buffer. Returns { dHash, blockHash, contentHash, width, height, format }.
 */
export async function fingerprintImage(buffer) {
  const rgba = await decodeRgba(buffer, { maxEdge: 512 });
  const dHash = await computeDHash(buffer);
  const blockHash = computeBlockHashFromRgba(rgba.data, rgba.width, rgba.height, BLOCKHASH_BITS);
  return {
    dHash,
    blockHash,
    contentHash: contentHash(buffer),
    width: rgba.width,
    height: rgba.height,
    format: rgba.format,
  };
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
