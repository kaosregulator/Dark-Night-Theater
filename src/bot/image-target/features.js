/**
 * Lightweight ORB-style local feature matching (Image Target V3).
 *
 * Pure JS FAST-ish corners + BRIEF binary descriptors — no OpenCV.
 * Used to detect partial/cropped/overlaid/rotated targets when global
 * hashes disagree but recognizable keypoints still match.
 */

import sharp from 'sharp';
import { IMAGE_TARGET_HASH_EDGE } from './constants.js';

const DESCRIPTOR_BYTES = 32; // 256-bit BRIEF
const MAX_KEYPOINTS = 64;
const MATCH_HAMMING_MAX = 64; // of 256 bits
const MIN_MATCHES_FOR_HIT = 12;

function greyscaleFromRgba(data, width, height) {
  const g = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return g;
}

/** FAST-9 corner score at (x,y). Higher = stronger corner. */
function fastScore(gray, w, h, x, y) {
  const c = gray[y * w + x];
  const thr = 12;
  // 16 Bresenham circle offsets (radius 3).
  const offs = [
    [0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3],
    [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3],
  ];
  let brighter = 0;
  let darker = 0;
  let score = 0;
  for (const [dx, dy] of offs) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const v = gray[ny * w + nx];
    if (v > c + thr) {
      brighter += 1;
      score += v - c;
    } else if (v < c - thr) {
      darker += 1;
      score += c - v;
    }
  }
  if (brighter < 8 && darker < 8) return 0;
  return score;
}

/** Deterministic BRIEF sampling pattern (seeded). */
function briefPattern() {
  const pairs = [];
  let s = 0xC0FFEE;
  const rnd = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
  for (let i = 0; i < DESCRIPTOR_BYTES * 8; i++) {
    const ax = Math.floor((rnd() - 0.5) * 24);
    const ay = Math.floor((rnd() - 0.5) * 24);
    const bx = Math.floor((rnd() - 0.5) * 24);
    const by = Math.floor((rnd() - 0.5) * 24);
    pairs.push([ax, ay, bx, by]);
  }
  return pairs;
}

const BRIEF_PAIRS = briefPattern();

function describeKeypoint(gray, w, h, x, y) {
  const desc = Buffer.alloc(DESCRIPTOR_BYTES);
  for (let i = 0; i < BRIEF_PAIRS.length; i++) {
    const [ax, ay, bx, by] = BRIEF_PAIRS[i];
    const xa = Math.min(w - 1, Math.max(0, x + ax));
    const ya = Math.min(h - 1, Math.max(0, y + ay));
    const xb = Math.min(w - 1, Math.max(0, x + bx));
    const yb = Math.min(h - 1, Math.max(0, y + by));
    if (gray[ya * w + xa] < gray[yb * w + xb]) {
      desc[i >> 3] |= 1 << (i & 7);
    }
  }
  return desc;
}

function hammingBytes(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] ^ b[i];
    // popcount
    x = x - ((x >>> 1) & 0x55);
    x = (x & 0x33) + ((x >>> 2) & 0x33);
    d += (((x + (x >>> 4)) & 0x0f) * 0x01) & 0xff;
  }
  return d;
}

/**
 * Extract up to MAX_KEYPOINTS local features from an image buffer.
 * @returns {{ keypoints: {x,y,score}[], descriptors: Buffer, width: number, height: number }}
 */
export async function extractLocalFeatures(buffer, {
  maxEdge = Math.min(IMAGE_TARGET_HASH_EDGE, 384),
  maxKeypoints = MAX_KEYPOINTS,
} = {}) {
  const { data, info } = await sharp(buffer, { animated: false, failOn: 'none' })
    .rotate()
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const gray = greyscaleFromRgba(data, w, h);

  const candidates = [];
  const step = Math.max(2, Math.floor(Math.min(w, h) / 64));
  for (let y = 4; y < h - 4; y += step) {
    for (let x = 4; x < w - 4; x += step) {
      const score = fastScore(gray, w, h, x, y);
      if (score > 0) candidates.push({ x, y, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  // Non-max suppression
  const picked = [];
  const minDist2 = (step * 1.5) ** 2;
  for (const c of candidates) {
    if (picked.length >= maxKeypoints) break;
    let ok = true;
    for (const p of picked) {
      const dx = c.x - p.x;
      const dy = c.y - p.y;
      if (dx * dx + dy * dy < minDist2) {
        ok = false;
        break;
      }
    }
    if (ok) picked.push(c);
  }

  const descriptors = Buffer.alloc(picked.length * DESCRIPTOR_BYTES);
  for (let i = 0; i < picked.length; i++) {
    const d = describeKeypoint(gray, w, h, picked[i].x, picked[i].y);
    d.copy(descriptors, i * DESCRIPTOR_BYTES);
  }

  return {
    keypoints: picked,
    descriptors,
    width: w,
    height: h,
    count: picked.length,
  };
}

/** Serialize features for Postgres storage (compact hex). */
export function serializeFeatures(features) {
  if (!features?.descriptors?.length) return null;
  return {
    w: features.width,
    h: features.height,
    n: features.count,
    xy: features.keypoints.map((k) => [k.x, k.y]),
    d: features.descriptors.toString('base64'),
  };
}

export function deserializeFeatures(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj?.d || !obj?.n) return null;
  return {
    width: obj.w || 0,
    height: obj.h || 0,
    count: obj.n,
    keypoints: (obj.xy || []).map(([x, y]) => ({ x, y, score: 0 })),
    descriptors: Buffer.from(obj.d, 'base64'),
  };
}

/**
 * Match two feature sets. Returns similarity in [0,1] and match stats.
 */
export function matchLocalFeatures(a, b, {
  maxHamming = MATCH_HAMMING_MAX,
  minMatches = MIN_MATCHES_FOR_HIT,
} = {}) {
  if (!a?.descriptors?.length || !b?.descriptors?.length) {
    return { score: 0, matches: 0, overlap: 0 };
  }

  const na = a.count || Math.floor(a.descriptors.length / DESCRIPTOR_BYTES);
  const nb = b.count || Math.floor(b.descriptors.length / DESCRIPTOR_BYTES);
  if (na < 4 || nb < 4) return { score: 0, matches: 0, overlap: 0 };

  let matches = 0;
  const usedB = new Set();

  for (let i = 0; i < na; i++) {
    const da = a.descriptors.subarray(i * DESCRIPTOR_BYTES, (i + 1) * DESCRIPTOR_BYTES);
    let best = Infinity;
    let bestJ = -1;
    let second = Infinity;
    for (let j = 0; j < nb; j++) {
      if (usedB.has(j)) continue;
      const db = b.descriptors.subarray(j * DESCRIPTOR_BYTES, (j + 1) * DESCRIPTOR_BYTES);
      const d = hammingBytes(da, db);
      if (d < best) {
        second = best;
        best = d;
        bestJ = j;
      } else if (d < second) {
        second = d;
      }
    }
    // Lowe-ish ratio test
    if (bestJ >= 0 && best <= maxHamming && best < second * 0.85) {
      matches += 1;
      usedB.add(bestJ);
    }
  }

  const denom = Math.min(na, nb);
  const overlap = denom > 0 ? matches / denom : 0;
  // Soft score: require minMatches for a strong hit, but partial credit below.
  let score = overlap;
  if (matches >= minMatches) {
    score = Math.min(1, 0.55 + overlap * 0.45);
  } else if (matches >= Math.max(6, Math.floor(minMatches * 0.5))) {
    score = Math.min(0.7, overlap * 0.9);
  } else {
    score = Math.min(0.45, overlap * 0.6);
  }

  return { score, matches, overlap, na, nb };
}

export const FEATURE_MIN_MATCHES = MIN_MATCHES_FOR_HIT;
