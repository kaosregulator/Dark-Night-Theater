/**
 * Collage / partial-region / recursive crop search (Image Target V3).
 * Deep-scan only — keeps quick path fast.
 */

import sharp from 'sharp';

async function extractJpeg(buffer, region, key) {
  const { left, top, width, height } = region;
  if (width < 12 || height < 12) return null;
  try {
    const buf = await sharp(buffer, { animated: false, failOn: 'none' })
      .rotate()
      .extract({ left, top, width, height })
      .normalize()
      .resize({ width: 512, height: 512, fit: 'inside' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    return { key, buffer: buf, region };
  } catch {
    return null;
  }
}

/** 2×2 and 3×3 collage tiles + full/center. */
export async function generateCollageRegions(buffer, { maxRegions = 16 } = {}) {
  const meta = await sharp(buffer, { animated: false, failOn: 'none' }).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height) return [];

  const regions = [];
  const push = async (key, left, top, w, h) => {
    if (regions.length >= maxRegions) return;
    const item = await extractJpeg(buffer, {
      left: Math.max(0, left),
      top: Math.max(0, top),
      width: Math.min(w, width - left),
      height: Math.min(h, height - top),
    }, key);
    if (item) regions.push(item);
  };

  await push('region-full', 0, 0, width, height);
  await push(
    'region-center',
    Math.floor(width * 0.2),
    Math.floor(height * 0.2),
    Math.floor(width * 0.6),
    Math.floor(height * 0.6),
  );

  // 2×2 quadrants
  const hw = Math.floor(width / 2);
  const hh = Math.floor(height / 2);
  await push('tile-2x2-tl', 0, 0, hw, hh);
  await push('tile-2x2-tr', hw, 0, width - hw, hh);
  await push('tile-2x2-bl', 0, hh, hw, height - hh);
  await push('tile-2x2-br', hw, hh, width - hw, height - hh);

  // 3×3 grid (salient for collages)
  const tw = Math.floor(width / 3);
  const th = Math.floor(height / 3);
  for (let gy = 0; gy < 3; gy++) {
    for (let gx = 0; gx < 3; gx++) {
      const left = gx * tw;
      const top = gy * th;
      const w = gx === 2 ? width - left : tw;
      const h = gy === 2 ? height - top : th;
      await push(`tile-3x3-${gy}${gx}`, left, top, w, h);
    }
  }

  return regions.slice(0, maxRegions);
}

/**
 * Adaptive recursive crop search (deep only).
 * center / edges / corners at multiple scales.
 */
export async function generateAdaptiveCrops(buffer, { maxCrops = 18 } = {}) {
  const meta = await sharp(buffer, { animated: false, failOn: 'none' }).metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height) return [];

  const scales = [0.9, 0.8, 0.7, 0.6, 0.5];
  const anchors = [
    ['center', 0.5, 0.5],
    ['top', 0.5, 0.0],
    ['bottom', 0.5, 1.0],
    ['left', 0.0, 0.5],
    ['right', 1.0, 0.5],
    ['tl', 0.0, 0.0],
    ['tr', 1.0, 0.0],
    ['bl', 0.0, 1.0],
    ['br', 1.0, 1.0],
  ];

  const out = [];
  for (const scale of scales) {
    const cw = Math.max(12, Math.floor(width * scale));
    const ch = Math.max(12, Math.floor(height * scale));
    for (const [name, ax, ay] of anchors) {
      if (out.length >= maxCrops) return out;
      const left = Math.min(width - cw, Math.max(0, Math.floor((width - cw) * ax)));
      const top = Math.min(height - ch, Math.max(0, Math.floor((height - ch) * ay)));
      // Prefer center at every scale; edge/corner only at 0.7 and below to save budget.
      if (name !== 'center' && scale > 0.7) continue;
      const item = await extractJpeg(
        buffer,
        { left, top, width: cw, height: ch },
        `crop-${Math.round(scale * 100)}-${name}`,
      );
      if (item) out.push(item);
    }
  }
  return out;
}

/**
 * Estimate visual content overlap from best region score vs full-frame score.
 * Used for "73% visual content overlap" style reporting.
 */
export function estimateContentOverlap({ bestRegionScore = 0, fullScore = 0, regionKey = '' }) {
  if (bestRegionScore <= 0) return 0;
  const isPartial =
    regionKey.startsWith('tile-') ||
    regionKey.startsWith('crop-') ||
    regionKey.startsWith('region-center');
  if (!isPartial) return Math.min(1, bestRegionScore);
  // Partial region hit → report overlap as blend of region strength.
  const base = Math.max(bestRegionScore, fullScore * 0.5);
  return Math.min(0.95, base);
}
