/**
 * Screenshot / Discord-UI stripper (Image Target V3).
 *
 * Detects thick uniform borders, letterbox bars, and likely caption bands,
 * then returns stripped candidates for re-matching.
 */

import sharp from 'sharp';

function rowEnergy(data, width, height, channels, y) {
  let sum = 0;
  const row = y * width * channels;
  for (let x = 0; x < width; x++) {
    const i = row + x * channels;
    sum += data[i] + data[i + 1] + data[i + 2];
  }
  return sum / (width * 3);
}

function colEnergy(data, width, height, channels, x) {
  let sum = 0;
  for (let y = 0; y < height; y++) {
    const i = (y * width + x) * channels;
    sum += data[i] + data[i + 1] + data[i + 2];
  }
  return sum / (height * 3);
}

/**
 * Detect uniform border insets (dark or near-solid chrome).
 * @returns {{ left, top, right, bottom, confidence }}
 */
export function detectBorderInsets(data, width, height, channels = 3) {
  const maxInset = Math.floor(Math.min(width, height) * 0.25);
  const rowMeans = [];
  const colMeans = [];
  for (let y = 0; y < height; y++) rowMeans.push(rowEnergy(data, width, height, channels, y));
  for (let x = 0; x < width; x++) colMeans.push(colEnergy(data, width, height, channels, x));

  const global =
    rowMeans.reduce((a, b) => a + b, 0) / Math.max(1, rowMeans.length);
  const isBar = (v) => Math.abs(v - global) > 35 || v < 18 || v > 240;

  let top = 0;
  while (top < maxInset && isBar(rowMeans[top])) top += 1;
  let bottom = 0;
  while (bottom < maxInset && isBar(rowMeans[height - 1 - bottom])) bottom += 1;
  let left = 0;
  while (left < maxInset && isBar(colMeans[left])) left += 1;
  let right = 0;
  while (right < maxInset && isBar(colMeans[width - 1 - right])) right += 1;

  // Caption heuristic: thick top/bottom band with low variance.
  const topBand = rowMeans.slice(0, Math.min(height, Math.floor(height * 0.18)));
  const botBand = rowMeans.slice(Math.max(0, height - Math.floor(height * 0.18)));
  const variance = (arr) => {
    if (!arr.length) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
  };
  if (variance(topBand) < 80 && top < Math.floor(height * 0.12)) {
    top = Math.max(top, Math.floor(height * 0.12));
  }
  if (variance(botBand) < 80 && bottom < Math.floor(height * 0.12)) {
    bottom = Math.max(bottom, Math.floor(height * 0.12));
  }

  const trimmed = (width - left - right) * (height - top - bottom);
  const area = width * height;
  const confidence =
    area > 0 && trimmed > area * 0.35
      ? Math.min(1, (left + right + top + bottom) / (Math.min(width, height) * 0.5))
      : 0;

  return { left, top, right, bottom, confidence };
}

/**
 * Produce screenshot-stripped buffers for deep scan.
 */
export async function stripScreenshotChrome(buffer, { maxCandidates = 3 } = {}) {
  const { data, info } = await sharp(buffer, { animated: false, failOn: 'none' })
    .rotate()
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const insets = detectBorderInsets(data, width, height, info.channels);
  const out = [];

  const pushExtract = async (key, left, top, w, h) => {
    if (out.length >= maxCandidates) return;
    if (w < 16 || h < 16) return;
    try {
      const buf = await sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .resize({ width, height, fit: 'fill' })
        .extract({ left, top, width: w, height: h })
        .normalize()
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      out.push({ key, buffer: buf, insets });
    } catch {
      // skip
    }
  };

  if (insets.confidence > 0.15) {
    await pushExtract(
      'screenshot-strip',
      insets.left,
      insets.top,
      width - insets.left - insets.right,
      height - insets.top - insets.bottom,
    );
  }

  // Aggressive center content (Discord embed padding mimic).
  const pad = Math.floor(Math.min(width, height) * 0.1);
  await pushExtract(
    'screenshot-center',
    pad,
    pad,
    width - pad * 2,
    height - pad * 2,
  );

  // Caption-safe: drop top+bottom 15%.
  const cap = Math.floor(height * 0.15);
  await pushExtract('screenshot-caption-safe', 0, cap, width, height - cap * 2);

  return { candidates: out, insets };
}
