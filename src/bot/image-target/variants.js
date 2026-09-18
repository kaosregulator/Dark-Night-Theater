import sharp from 'sharp';
import { IMAGE_TARGET_MAX_VARIANTS } from './constants.js';

/**
 * Multi-variant normalization for crop / color / flip robustness.
 *
 * Bounded set — never explode into dozens of transforms.
 * Each variant is a JPEG buffer + key used in scoring/debug output.
 */

async function toJpeg(pipeline) {
  return pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
}

async function baseMeta(buffer) {
  const meta = await sharp(buffer, { animated: false, failOn: 'none' }).metadata();
  return {
    width: meta.width || 0,
    height: meta.height || 0,
  };
}

/**
 * Generate comparison variants for a single frame/image buffer.
 * Always includes `original` (EXIF-rotated, size-capped).
 */
export async function generateVariants(buffer, { maxVariants = IMAGE_TARGET_MAX_VARIANTS } = {}) {
  const { width, height } = await baseMeta(buffer);
  if (!width || !height) throw new Error('not_an_image');

  const variants = [];

  const push = async (key, pipeline) => {
    if (variants.length >= maxVariants) return;
    try {
      const buf = await toJpeg(pipeline);
      variants.push({ key, buffer: buf });
    } catch {
      // Skip failed variant — keep pipeline resilient.
    }
  };

  // 1) Original (EXIF rotate + mild normalize to shared edge).
  await push(
    'original',
    sharp(buffer, { animated: false, failOn: 'none' })
      .rotate()
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }),
  );

  // 2) Grayscale + contrast normalize (brightness / color / sat resistance).
  await push(
    'grayscale-normalized',
    sharp(buffer, { animated: false, failOn: 'none' })
      .rotate()
      .greyscale()
      .normalize()
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }),
  );

  // 3) Center crop ~90% (borders / slight crops).
  if (width >= 32 && height >= 32) {
    const left = Math.floor(width * 0.05);
    const top = Math.floor(height * 0.05);
    const w = Math.max(8, Math.floor(width * 0.9));
    const h = Math.max(8, Math.floor(height * 0.9));
    await push(
      'center-crop-90',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .extract({ left, top, width: Math.min(w, width - left), height: Math.min(h, height - top) })
        .resize({ width: 768, height: 768, fit: 'inside' }),
    );
  }

  // 4) Center crop ~80% (captions / watermark margins / heavier crops).
  if (width >= 40 && height >= 40) {
    const left = Math.floor(width * 0.1);
    const top = Math.floor(height * 0.1);
    const w = Math.max(8, Math.floor(width * 0.8));
    const h = Math.max(8, Math.floor(height * 0.8));
    await push(
      'center-crop-80',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .extract({ left, top, width: Math.min(w, width - left), height: Math.min(h, height - top) })
        .normalize()
        .resize({ width: 768, height: 768, fit: 'inside' }),
    );
  }

  // 4b) Aggressive center crop ~70% (thick borders / big captions).
  if (width >= 48 && height >= 48 && maxVariants >= 7) {
    const left = Math.floor(width * 0.15);
    const top = Math.floor(height * 0.15);
    const w = Math.max(8, Math.floor(width * 0.7));
    const h = Math.max(8, Math.floor(height * 0.7));
    await push(
      'center-crop-70',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .extract({ left, top, width: Math.min(w, width - left), height: Math.min(h, height - top) })
        .normalize()
        .resize({ width: 768, height: 768, fit: 'inside' }),
    );
  }

  // 4c) Strip bottom/top bars (captions / letterbox bars).
  if (height >= 48 && maxVariants >= 8) {
    const h80 = Math.max(8, Math.floor(height * 0.8));
    await push(
      'crop-bottom-20',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .extract({ left: 0, top: 0, width, height: h80 })
        .normalize()
        .resize({ width: 768, height: 768, fit: 'inside' }),
    );
  }

  // 5) Aspect-ratio letterbox onto square (aspect changes / padding).
  await push(
    'letterbox-square',
    sharp(buffer, { animated: false, failOn: 'none' })
      .rotate()
      .resize({
        width: 512,
        height: 512,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      }),
  );

  // 6) Horizontal flip (mirror evasion).
  await push(
    'flip-h',
    sharp(buffer, { animated: false, failOn: 'none' })
      .rotate()
      .flop()
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }),
  );

  // 7) Small rotation tolerance (±6°) — pick one direction + auto-trim.
  await push(
    'rotate-6',
    sharp(buffer, { animated: false, failOn: 'none' })
      .rotate(6, { background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .resize({ width: 768, height: 768, fit: 'inside' }),
  );

  // 8) Contrast-boosted (mild brightness/contrast edits).
  await push(
    'contrast-boost',
    sharp(buffer, { animated: false, failOn: 'none' })
      .rotate()
      .modulate({ brightness: 1.05, saturation: 1.1 })
      .linear(1.15, -(128 * 0.15))
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }),
  );

  if (!variants.length) {
    // Absolute fallback — raw buffer as "original".
    variants.push({ key: 'original', buffer });
  }

  return variants.slice(0, maxVariants);
}
