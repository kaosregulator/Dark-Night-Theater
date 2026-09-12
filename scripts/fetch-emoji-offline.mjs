#!/usr/bin/env node
// Downloads the MakeEmoji offline pack from the public DN-cards repo into
// artifacts/emoji-offline/. Skips when the pack is already present (or when
// EMOJI_SKIP_FETCH=1). Used by postinstall so Railway/deploys get assets
// without stuffing ~380MB of GIFs into git.
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const DEST = process.env.EMOJI_OFFLINE_PACKAGE_PATH?.trim() || join(ROOT, 'artifacts/emoji-offline');
const MARKER = join(DEST, 'manifest.json');
const REPO = process.env.EMOJI_OFFLINE_REPO || 'https://github.com/kaosregulator/DN-cards.git';
const REF = process.env.EMOJI_OFFLINE_REF || 'main';
const SPARSE = 'artifacts/emoji-offline';

if (process.env.EMOJI_SKIP_FETCH === '1') {
  console.log('[emoji-offline] EMOJI_SKIP_FETCH=1 — skipping fetch.');
  process.exit(0);
}

if (existsSync(MARKER) && process.env.EMOJI_FORCE_FETCH !== '1') {
  try {
    const m = JSON.parse(readFileSync(MARKER, 'utf8'));
    console.log(`[emoji-offline] already present (${m.version ?? 'unknown'}) at ${DEST}`);
    process.exit(0);
  } catch {
    /* fall through and re-fetch */
  }
}

const tmp = join(ROOT, '.tmp-dn-cards-emoji');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

console.log(`[emoji-offline] cloning ${REPO} (${REF}) sparse:${SPARSE} …`);
const clone = spawnSync(
  'git',
  [
    'clone',
    '--depth', '1',
    '--filter=blob:none',
    '--sparse',
    '--branch', REF,
    REPO,
    tmp,
  ],
  { stdio: 'inherit' },
);
if (clone.status !== 0) {
  console.warn('[emoji-offline] clone failed — /emoji offline pack will be unavailable until assets are present.');
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0); // never fail install
}

const sparse = spawnSync('git', ['sparse-checkout', 'set', SPARSE], { cwd: tmp, stdio: 'inherit' });
if (sparse.status !== 0) {
  console.warn('[emoji-offline] sparse-checkout failed.');
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

const src = join(tmp, SPARSE);
if (!existsSync(join(src, 'manifest.json'))) {
  console.warn('[emoji-offline] cloned repo missing artifacts/emoji-offline/manifest.json');
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(join(ROOT, 'artifacts'), { recursive: true });

// Copy without the giant backup zips (not needed at runtime).
const copy = spawnSync(
  'bash',
  ['-lc', `shopt -s dotglob && mkdir -p "${DEST}" && cp -a "${src}/." "${DEST}/" && rm -f "${DEST}"/*.zip "${DEST}"/greenscreen/*.zip 2>/dev/null; true`],
  { stdio: 'inherit' },
);
rmSync(tmp, { recursive: true, force: true });

if (copy.status !== 0 || !existsSync(MARKER)) {
  console.warn('[emoji-offline] copy incomplete — check network / disk.');
  process.exit(0);
}

writeFileSync(join(DEST, '.fetched-from'), `${REPO}@${REF}\n`, 'utf8');
console.log(`[emoji-offline] ready at ${DEST}`);
