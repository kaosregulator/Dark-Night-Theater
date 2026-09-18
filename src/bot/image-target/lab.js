/**
 * Image Target Lab — self-attack harness (V3).
 *
 * Generates common evasion transforms against a saved target and reports
 * which attacks are still detected. Used by hub "Lab" and unit tests.
 */

import sharp from 'sharp';
import { matchAgainstTargets } from './detector.js';
import { listTargets } from './store.js';

async function jpeg(pipeline, quality = 85) {
  return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
}

/**
 * Build attack buffers from an original image/GIF still.
 */
export async function generateLabAttacks(buffer) {
  const meta = await sharp(buffer, { animated: false, failOn: 'none' }).metadata();
  const width = meta.width || 256;
  const height = meta.height || 256;
  const attacks = [];

  const add = async (name, fn) => {
    try {
      const buf = await fn();
      if (buf?.length) attacks.push({ name, buffer: buf });
    } catch {
      // skip failed attack generation
    }
  };

  await add('original', () =>
    jpeg(sharp(buffer, { animated: false, failOn: 'none' }).rotate().resize({
      width: 768, height: 768, fit: 'inside', withoutEnlargement: true,
    })),
  );
  await add('jpeg-30', () =>
    sharp(buffer, { animated: false, failOn: 'none' }).rotate()
      .resize({ width: 640, height: 640, fit: 'inside' })
      .jpeg({ quality: 30 }).toBuffer(),
  );
  await add('jpeg-10', () =>
    sharp(buffer, { animated: false, failOn: 'none' }).rotate()
      .resize({ width: 480, height: 480, fit: 'inside' })
      .jpeg({ quality: 10 }).toBuffer(),
  );
  await add('screenshot', async () => {
    const inner = await jpeg(
      sharp(buffer, { animated: false, failOn: 'none' }).rotate()
        .resize(400, 400, { fit: 'inside' }),
    );
    return jpeg(
      sharp({
        create: {
          width: 520,
          height: 560,
          channels: 3,
          background: { r: 32, g: 34, b: 37 },
        },
      }).composite([{ input: inner, top: 48, left: 40 }]),
    );
  });
  await add('discord-screenshot', async () => {
    const inner = await jpeg(
      sharp(buffer, { animated: false, failOn: 'none' }).rotate()
        .resize(360, 360, { fit: 'inside' }),
    );
    return jpeg(
      sharp({
        create: {
          width: 480,
          height: 520,
          channels: 3,
          background: { r: 54, g: 57, b: 63 },
        },
      }).composite([
        { input: inner, top: 60, left: 50 },
        {
          input: await sharp({
            create: {
              width: 480,
              height: 36,
              channels: 3,
              background: { r: 88, g: 101, b: 242 },
            },
          }).png().toBuffer(),
          top: 0,
          left: 0,
        },
      ]),
    );
  });

  for (const pct of [90, 75, 50]) {
    const s = pct / 100;
    await add(`crop-${pct}`, () => {
      const left = Math.floor(width * ((1 - s) / 2));
      const top = Math.floor(height * ((1 - s) / 2));
      const w = Math.max(8, Math.floor(width * s));
      const h = Math.max(8, Math.floor(height * s));
      return jpeg(
        sharp(buffer, { animated: false, failOn: 'none' }).rotate()
          .extract({ left, top, width: Math.min(w, width - left), height: Math.min(h, height - top) })
          .resize({ width: 640, height: 640, fit: 'inside' }),
      );
    });
  }

  await add('mirror', () =>
    jpeg(sharp(buffer, { animated: false, failOn: 'none' }).rotate().flop()
      .resize({ width: 640, height: 640, fit: 'inside' })),
  );
  await add('rotate-90', () =>
    jpeg(sharp(buffer, { animated: false, failOn: 'none' }).rotate(90)
      .resize({ width: 640, height: 640, fit: 'inside' })),
  );
  await add('rotate-15', () =>
    jpeg(sharp(buffer, { animated: false, failOn: 'none' })
      .rotate(15, { background: { r: 0, g: 0, b: 0 } })
      .resize({ width: 640, height: 640, fit: 'inside' })),
  );
  await add('grayscale', () =>
    jpeg(sharp(buffer, { animated: false, failOn: 'none' }).rotate().greyscale().normalize()
      .resize({ width: 640, height: 640, fit: 'inside' })),
  );
  await add('blur', () =>
    jpeg(sharp(buffer, { animated: false, failOn: 'none' }).rotate().blur(1.8)
      .resize({ width: 640, height: 640, fit: 'inside' })),
  );
  await add('noise', async () => {
    const base = await sharp(buffer, { animated: false, failOn: 'none' }).rotate()
      .resize(256, 256, { fit: 'fill' }).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    for (let i = 0; i < base.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 40;
      base.data[i] = Math.max(0, Math.min(255, base.data[i] + n));
      base.data[i + 1] = Math.max(0, Math.min(255, base.data[i + 1] + n));
      base.data[i + 2] = Math.max(0, Math.min(255, base.data[i + 2] + n));
    }
    return sharp(base.data, { raw: { width: 256, height: 256, channels: 4 } })
      .jpeg({ quality: 80 }).toBuffer();
  });
  await add('watermark', async () => {
    const overlay = Buffer.from(
      `<svg width="200" height="40"><text x="0" y="28" font-size="24" fill="white" opacity="0.7">WATERMARK</text></svg>`,
    );
    return jpeg(
      sharp(buffer, { animated: false, failOn: 'none' }).rotate()
        .resize({ width: 640, height: 640, fit: 'inside' })
        .composite([{ input: overlay, gravity: 'southeast' }]),
    );
  });
  await add('caption', async () => {
    const bar = await sharp({
      create: { width: 640, height: 72, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer();
    const inner = await jpeg(
      sharp(buffer, { animated: false, failOn: 'none' }).rotate()
        .resize(640, 480, { fit: 'cover' }),
    );
    return jpeg(
      sharp({
        create: {
          width: 640,
          height: 552,
          channels: 3,
          background: { r: 0, g: 0, b: 0 },
        },
      }).composite([
        { input: bar, top: 0, left: 0 },
        { input: inner, top: 72, left: 0 },
      ]),
    );
  });
  await add('huge-overlay', async () => {
    const overlay = Buffer.from(
      `<svg width="400" height="200"><rect width="400" height="200" fill="red" fill-opacity="0.35"/><text x="20" y="110" font-size="48" fill="yellow">BANNER</text></svg>`,
    );
    return jpeg(
      sharp(buffer, { animated: false, failOn: 'none' }).rotate()
        .resize(640, 640, { fit: 'cover' })
        .composite([{ input: overlay, gravity: 'center' }]),
    );
  });
  await add('brightness', () =>
    jpeg(sharp(buffer, { animated: false, failOn: 'none' }).rotate()
      .modulate({ brightness: 1.4 }).resize({ width: 640, height: 640, fit: 'inside' })),
  );
  await add('contrast', () =>
    jpeg(sharp(buffer, { animated: false, failOn: 'none' }).rotate()
      .linear(1.5, -64).resize({ width: 640, height: 640, fit: 'inside' })),
  );
  await add('saturation', () =>
    jpeg(sharp(buffer, { animated: false, failOn: 'none' }).rotate()
      .modulate({ saturation: 0.2 }).resize({ width: 640, height: 640, fit: 'inside' })),
  );
  await add('perspective', () =>
    jpeg(
      sharp(buffer, { animated: false, failOn: 'none' })
        .rotate(4, { background: { r: 0, g: 0, b: 0 } })
        .affine([1.08, 0.05, 0.04, 1.03], { background: { r: 0, g: 0, b: 0 } })
        .resize({ width: 640, height: 640, fit: 'cover' }),
    ),
  );
  await add('letterbox', () =>
    jpeg(
      sharp(buffer, { animated: false, failOn: 'none' }).rotate()
        .resize({
          width: 640,
          height: 360,
          fit: 'contain',
          background: { r: 0, g: 0, b: 0 },
        }),
    ),
  );
  await add('collage', async () => {
    const tile = await jpeg(
      sharp(buffer, { animated: false, failOn: 'none' }).rotate().resize(320, 320, { fit: 'cover' }),
    );
    const other = await sharp({
      create: { width: 320, height: 320, channels: 3, background: { r: 180, g: 40, b: 90 } },
    }).jpeg().toBuffer();
    return jpeg(
      sharp({
        create: {
          width: 640,
          height: 640,
          channels: 3,
          background: { r: 20, g: 20, b: 20 },
        },
      }).composite([
        { input: tile, top: 0, left: 0 },
        { input: other, top: 0, left: 320 },
        { input: other, top: 320, left: 0 },
        { input: tile, top: 320, left: 320 },
      ]),
    );
  });
  await add('zoom', () => {
    const left = Math.floor(width * 0.2);
    const top = Math.floor(height * 0.2);
    return jpeg(
      sharp(buffer, { animated: false, failOn: 'none' }).rotate()
        .extract({
          left,
          top,
          width: Math.max(8, width - left * 2),
          height: Math.max(8, height - top * 2),
        })
        .resize(640, 640, { fit: 'cover' }),
    );
  });
  await add('resized', () =>
    jpeg(sharp(buffer, { animated: false, failOn: 'none' }).rotate().resize(128, 128, { fit: 'fill' })
      .resize(640, 640, { fit: 'fill' })),
  );
  await add('stretched', () =>
    jpeg(sharp(buffer, { animated: false, failOn: 'none' }).rotate()
      .resize(800, 300, { fit: 'fill' })),
  );

  return attacks;
}

/**
 * Run lab attacks against a guild target (by id or name).
 */
export async function runImageTargetLab(guildId, {
  targetId = null,
  targetName = null,
  sourceBuffer = null,
} = {}) {
  const targets = await listTargets(guildId, { includeDisabled: false });
  let target = null;
  if (targetId) target = targets.find((t) => t.targetId === targetId);
  if (!target && targetName) {
    const q = String(targetName).toLowerCase();
    target = targets.find((t) => t.name.toLowerCase() === q)
      || targets.find((t) => t.name.toLowerCase().includes(q));
  }
  if (!target && targets.length === 1) target = targets[0];
  if (!target) {
    return {
      ok: false,
      message: 'Target not found. Pass a target name or add exactly one target.',
      results: [],
    };
  }

  // Prefer stored preview as attack source; caller may pass original bytes.
  let base = sourceBuffer;
  if (!base && target.previewJpeg) base = Buffer.from(target.previewJpeg);
  if (!base) {
    return {
      ok: false,
      message: 'No source image available for lab (missing preview). Re-add the target.',
      results: [],
      target,
    };
  }

  const attacks = await generateLabAttacks(base);
  const results = [];
  for (const attack of attacks) {
    const row = await matchAgainstTargets(guildId, attack.buffer, {
      meta: { contentType: 'image/jpeg', filename: `${attack.name}.jpg` },
    });
    const detected = Boolean(
      row?.matched && row.target?.targetId === target.targetId,
    );
    const score = detected ? (row?.finalScore ?? row?.score ?? 0) : (row?.finalScore ?? 0);
    results.push({
      name: attack.name,
      detected,
      score,
      method: row?.methodLabel || row?.method || null,
      deepScan: Boolean(row?.deepScan),
    });
  }

  const detected = results.filter((r) => r.detected).length;
  const missed = results.length - detected;
  const scores = results.map((r) => r.score).filter((n) => Number.isFinite(n));
  const strongest = scores.length ? Math.max(...scores) : 0;
  const weakestDetected = results.filter((r) => r.detected).map((r) => r.score);
  const weakest = weakestDetected.length ? Math.min(...weakestDetected) : 0;

  return {
    ok: true,
    target,
    tests: results.length,
    detected,
    missed,
    strongest,
    weakest,
    results,
    reportText: formatLabReport({
      target,
      tests: results.length,
      detected,
      missed,
      strongest,
      weakest,
      results,
    }),
  };
}

export function formatLabReport({
  target,
  tests,
  detected,
  missed,
  strongest,
  weakest,
  results,
}) {
  const lines = [
    '╔══════════════════════════════╗',
    '║     IMAGE TARGET LAB         ║',
    '╠══════════════════════════════╣',
    `║ Target: ${String(target?.name || '—').slice(0, 20).padEnd(20)} ║`,
    `║ Tests: ${String(tests).padEnd(21)} ║`,
    '║                              ║',
    `║ DETECTED       ${String(detected).padStart(2)} / ${String(tests).padStart(2)}       ║`,
    `║ MISSED          ${String(missed).padStart(2)} / ${String(tests).padStart(2)}       ║`,
    '║                              ║',
    `║ Strongest: ${(strongest * 100).toFixed(1).padStart(5)}%             ║`,
    `║ Weakest:   ${(weakest * 100).toFixed(1).padStart(5)}%             ║`,
    '╚══════════════════════════════╝',
    '',
  ];
  for (const r of results || []) {
    lines.push(`${r.detected ? '✓' : '✗'} ${r.name}  ${(r.score * 100).toFixed(1)}%`);
  }
  return lines.join('\n');
}
