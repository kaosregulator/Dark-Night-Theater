/**
 * Color histogram hash (Image Target V3).
 *
 * Captures coarse color distribution — complementary to structural hashes
 * that ignore hue. Still useful after mild recolor; weak alone after grayscale.
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

/**
 * 64-bit color hash from 4×4×4 RGB histogram bits vs mean.
 */
export async function computeColorHash(buffer) {
  const { data, info } = await sharp(buffer, { animated: false, failOn: 'none' })
    .rotate()
    .resize(32, 32, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bins = new Float64Array(64); // 4×4×4
  const n = info.width * info.height;
  for (let i = 0; i < n; i++) {
    const r = data[i * 3] >> 6;
    const g = data[i * 3 + 1] >> 6;
    const b = data[i * 3 + 2] >> 6;
    bins[(r << 4) | (g << 2) | b] += 1;
  }
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += bins[i];
  const mean = sum / 64;
  const bits = [];
  for (let i = 0; i < 64; i++) bits.push(bins[i] > mean);
  return bitsToHex(bits);
}
