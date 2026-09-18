/**
 * PDQ-style 256-bit perceptual hash (Image Target V3).
 *
 * Inspired by Meta's PDQ: downsample → DCT → low-frequency quantization.
 * Pure JS via sharp; Hamming-comparable like other fingerprints.
 */

import sharp from 'sharp';

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

/** Separable 1D DCT-II. */
function dct1d(input) {
  const n = input.length;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      sum += input[i] * Math.cos(((2 * i + 1) * k * Math.PI) / (2 * n));
    }
    out[k] = sum * (k === 0 ? 1 / Math.SQRT2 : 1);
  }
  return out;
}

function dct2d64(pixels) {
  const n = 64;
  const tmp = new Float64Array(n * n);
  const row = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) row[x] = pixels[y * n + x];
    const transformed = dct1d(row);
    for (let x = 0; x < n; x++) tmp[y * n + x] = transformed[x];
  }
  const out = new Float64Array(n * n);
  const col = new Float64Array(n);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) col[y] = tmp[y * n + x];
    const transformed = dct1d(col);
    for (let y = 0; y < n; y++) out[y * n + x] = transformed[y];
  }
  return out;
}

/**
 * Compute a 256-bit PDQ-like hash (64 hex chars).
 */
export async function computePdqHash(buffer) {
  const size = 64;
  const { data } = await sharp(buffer, { animated: false, failOn: 'none' })
    .rotate()
    .greyscale()
    .resize(size, size, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Float64Array(size * size);
  for (let i = 0; i < pixels.length; i++) pixels[i] = data[i];
  const dct = dct2d64(pixels);

  // Take 16×16 low-frequency block (skip DC) → 256 coeffs.
  const coeffs = [];
  for (let u = 0; u < 16; u++) {
    for (let v = 0; v < 16; v++) {
      if (u === 0 && v === 0) continue;
      coeffs.push(dct[u * size + v]);
    }
  }
  while (coeffs.length < 256) coeffs.push(0);
  const sample = coeffs.slice(0, 256);
  const sorted = [...sample].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const bits = sample.map((c) => c > median);
  return bitsToHex(bits);
}
