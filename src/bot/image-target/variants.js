import sharp from 'sharp';
import {
  IMAGE_TARGET_DEEP_MAX_VARIANTS,
  IMAGE_TARGET_MAX_VARIANTS,
} from './constants.js';

/**
 * Multi-variant normalization (V2 quick + V2.1 deep).
 *
 * Quick path: bounded everyday transforms.
 * Deep path: extra screenshot / caption / color / blur resistance — still capped.
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
 * @param {Buffer} buffer
 * @param {{ maxVariants?: number, deep?: boolean }} [opts]
 */
export async function generateVariants(buffer, {
  maxVariants = IMAGE_TARGET_MAX_VARIANTS,
  deep = false,
} = {}) {
  const { width, height } = await baseMeta(buffer);
  if (!width || !height) throw new Error('not_an_image');

  const cap = deep
    ? Math.max(maxVariants, Math.min(IMAGE_TARGET_DEEP_MAX_VARIANTS, maxVariants))
    : maxVariants;

  const variants = [];

  const push = async (key, pipeline) => {
    if (variants.length >= cap) return;
    try {
      const buf = await toJpeg(pipeline);
      variants.push({ key, buffer: buf });
    } catch {
      // Skip failed variant.
    }
  };

  // --- Quick variants -------------------------------------------------------

  await push(
    'original',
    sharp(buffer, { animated: false, failOn: 'none' })
      .rotate()
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }),
  );

  await push(
    'grayscale-normalized',
    sharp(buffer, { animated: false, failOn: 'none' })
      .rotate()
      .greyscale()
      .normalize()
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }),
  );

  // Letterbox / pillarbox bar removal — early so it fits quick-path budgets.
  await push(
    'trim-bars',
    sharp(buffer, { animated: false, failOn: 'none' })
      .rotate()
      .trim({ threshold: 25, background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .normalize()
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }),
  );

  await push(
    'flip-h',
    sharp(buffer, { animated: false, failOn: 'none' })
      .rotate()
      .flop()
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }),
  );

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

  if (width >= 48 && height >= 48 && cap >= 7) {
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

  if (height >= 48 && cap >= 8) {
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

  await push(
    'rotate-6',
    sharp(buffer, { animated: false, failOn: 'none' })
      .rotate(6, { background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .resize({ width: 768, height: 768, fit: 'inside' }),
  );

  await push(
    'contrast-boost',
    sharp(buffer, { animated: false, failOn: 'none' })
      .rotate()
      .modulate({ brightness: 1.05, saturation: 1.1 })
      .linear(1.15, -(128 * 0.15))
      .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }),
  );

  // --- Deep-only variants (screenshot / Discord UI / combined edits) --------
  if (deep) {
    // Thick Discord-like border trim (~12% each side).
    if (width >= 64 && height >= 64) {
      const left = Math.floor(width * 0.12);
      const top = Math.floor(height * 0.12);
      const w = Math.max(8, Math.floor(width * 0.76));
      const h = Math.max(8, Math.floor(height * 0.76));
      await push(
        'border-trim-12',
        sharp(buffer, { animated: false, failOn: 'none' })
          .rotate()
          .extract({ left, top, width: Math.min(w, width - left), height: Math.min(h, height - top) })
          .normalize()
          .resize({ width: 768, height: 768, fit: 'inside' }),
      );
    }

    // Top caption strip.
    if (height >= 48) {
      const top = Math.floor(height * 0.2);
      const h80 = Math.max(8, height - top);
      await push(
        'crop-top-20',
        sharp(buffer, { animated: false, failOn: 'none' })
          .rotate()
          .extract({ left: 0, top, width, height: h80 })
          .normalize()
          .resize({ width: 768, height: 768, fit: 'inside' }),
      );
    }

    // Side crops (left/right UI chrome).
    if (width >= 64) {
      const left = Math.floor(width * 0.15);
      const w = Math.max(8, Math.floor(width * 0.7));
      await push(
        'side-crop-15',
        sharp(buffer, { animated: false, failOn: 'none' })
          .rotate()
          .extract({ left, top: 0, width: Math.min(w, width - left), height })
          .normalize()
          .resize({ width: 768, height: 768, fit: 'inside' }),
      );
    }

    // JPEG recompression normalization (Discord compression mimic).
    await push(
      'recompress-jpeg',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 55, mozjpeg: true }),
    );

    // Brightness / saturation swings.
    await push(
      'brightness-down',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .modulate({ brightness: 0.8, saturation: 0.85 })
        .normalize()
        .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }),
    );

    // Mild blur (soft screenshots / upscales).
    await push(
      'blur-mild',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .blur(1.2)
        .normalize()
        .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }),
    );

    // Sharpen.
    await push(
      'sharpen',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .sharpen()
        .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }),
    );

    // Aspect stretch normalize (cover into square then center).
    await push(
      'cover-square',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .resize({ width: 512, height: 512, fit: 'cover' }),
    );

    // Mild skew via rotate + asymmetric crop (keystone approximation).
    if (width >= 48 && height >= 48) {
      await push(
        'keystone-approx',
        sharp(buffer, { animated: false, failOn: 'none' })
          .rotate(3, { background: { r: 0, g: 0, b: 0, alpha: 1 } })
          .extract({
            left: Math.floor(width * 0.08),
            top: Math.floor(height * 0.05),
            width: Math.max(8, Math.floor(width * 0.84)),
            height: Math.max(8, Math.floor(height * 0.9)),
          })
          .normalize()
          .resize({ width: 512, height: 512, fit: 'cover' }),
      );
    }

    // Grayscale + crop-bottom combo (captioned grayscale screenshots).
    if (height >= 48) {
      const h80 = Math.max(8, Math.floor(height * 0.8));
      await push(
        'gray-crop-bottom',
        sharp(buffer, { animated: false, failOn: 'none' })
          .rotate()
          .extract({ left: 0, top: 0, width, height: h80 })
          .greyscale()
          .normalize()
          .resize({ width: 768, height: 768, fit: 'inside' }),
      );
    }

    // --- V3 forensic deep transforms (still hard-capped) --------------------

    // Large rotations (deliberate evasion).
    for (const deg of [90, 180, 270, -15, 15]) {
      await push(
        `rotate-${deg}`,
        sharp(buffer, { animated: false, failOn: 'none' })
          .rotate(deg, { background: { r: 0, g: 0, b: 0, alpha: 1 } })
          .resize({ width: 640, height: 640, fit: 'inside' }),
      );
    }

    // Vertical flip.
    await push(
      'flip-v',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .flip()
        .resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }),
    );

    // Color destruction suite.
    await push(
      'negate',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .negate({ alpha: false })
        .greyscale()
        .normalize()
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }),
    );

    await push(
      'high-contrast',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .linear(1.6, -(128 * 0.6))
        .normalize()
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }),
    );

    await push(
      'low-contrast',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .linear(0.55, 60)
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }),
    );

    await push(
      'hue-shift',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .modulate({ hue: 40, saturation: 1.3, brightness: 1.05 })
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }),
    );

    await push(
      'brightness-up',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .modulate({ brightness: 1.35, saturation: 0.7 })
        .normalize()
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }),
    );

    // Blur / noise / pixelation resilience.
    await push(
      'blur-strong',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .blur(2.4)
        .normalize()
        .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }),
    );

    await push(
      'jpeg-heavy',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 25, mozjpeg: true }),
    );

    await push(
      'pixelate',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .resize(48, 48, { fit: 'fill' })
        .resize(512, 512, { fit: 'fill', kernel: 'nearest' }),
    );

    // Perspective / deskew approximation (stronger keystone).
    if (width >= 64 && height >= 64) {
      await push(
        'perspective-deskew',
        sharp(buffer, { animated: false, failOn: 'none' })
          .rotate(-5, { background: { r: 0, g: 0, b: 0, alpha: 1 } })
          .extract({
            left: Math.floor(width * 0.1),
            top: Math.floor(height * 0.08),
            width: Math.max(8, Math.floor(width * 0.8)),
            height: Math.max(8, Math.floor(height * 0.84)),
          })
          .affine(
            [1.05, 0.04, 0.03, 1.02],
            { background: { r: 0, g: 0, b: 0, alpha: 1 } },
          )
          .normalize()
          .resize({ width: 512, height: 512, fit: 'cover' }),
      );
    }

    // Partial zoom (crop 50% center).
    if (width >= 64 && height >= 64) {
      const left = Math.floor(width * 0.25);
      const top = Math.floor(height * 0.25);
      await push(
        'zoom-50',
        sharp(buffer, { animated: false, failOn: 'none' })
          .rotate()
          .extract({
            left,
            top,
            width: Math.max(8, width - left * 2),
            height: Math.max(8, height - top * 2),
          })
          .normalize()
          .resize({ width: 640, height: 640, fit: 'inside' }),
      );
    }

    // Stretch (aspect ratio attack).
    await push(
      'stretch-wide',
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate()
        .resize({ width: 768, height: 432, fit: 'fill' })
        .resize({ width: 640, height: 640, fit: 'inside' }),
    );
  }

  if (!variants.length) {
    variants.push({ key: 'original', buffer });
  }

  return variants.slice(0, cap);
}
