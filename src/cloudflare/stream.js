import crypto from 'node:crypto';
import { config, readiness } from '../config.js';
import { log } from '../logger.js';

// Cloudflare Stream client.
//
// SECURITY MODEL: the Cloudflare Account ID, API token, and signing key never
// leave this process. The browser (the Discord Activity) only ever receives a
// short-lived *signed playback URL*. Raw video UIDs are treated as non-secret
// (they always appear in playback URLs) but access is gated by signed tokens
// for any video with requireSignedURLs=true.

const API_BASE = 'https://api.cloudflare.com/client/v4';

function apiHeaders() {
  return {
    Authorization: `Bearer ${config.cloudflare.apiToken}`,
    'Content-Type': 'application/json',
  };
}

function accountPath(suffix = '') {
  return `${API_BASE}/accounts/${config.cloudflare.accountId}/stream${suffix}`;
}

async function cfFetch(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...apiHeaders(), ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    const errs = (body?.errors || []).map((e) => e.message).join('; ') || res.statusText;
    throw new Error(`Cloudflare Stream API ${res.status}: ${errs}`);
  }
  return body;
}

// Normalise a Cloudflare video record into the shape the app uses everywhere.
export function normaliseVideo(v) {
  const meta = v.meta || {};
  return {
    uid: v.uid,
    name: meta.name || v.meta?.filename || 'Untitled',
    // "category" is a free-form custom metadata field you can set per video in
    // the Cloudflare dashboard (Video -> Metadata) or via the sync admin tools.
    category: meta.category || 'Uncategorized',
    description: meta.description || '',
    durationSeconds: Math.round(v.duration || 0),
    thumbnail: v.thumbnail || '',
    // playback.hls / playback.dash are the canonical manifest URLs Cloudflare
    // returns. For public videos we can hand these straight to the player.
    hls: v.playback?.hls || '',
    dash: v.playback?.dash || '',
    requireSignedURLs: Boolean(v.requireSignedURLs),
    ready: v.readyToStream === true || v.status?.state === 'ready',
    createdAt: v.created || null,
  };
}

// List the whole Stream library (paginates via the `asc`/`start` cursor).
export async function listLibrary() {
  if (!readiness.cloudflare) throw new Error('Cloudflare is not configured yet.');
  const out = [];
  let cursor = null;
  // Cloudflare returns up to 1000 per page; loop defensively.
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({ limit: '1000' });
    if (cursor) params.set('start', cursor);
    const body = await cfFetch(`${accountPath()}?${params.toString()}`);
    const items = body.result || [];
    for (const v of items) out.push(normaliseVideo(v));
    // The list endpoint has no simple next-cursor; when fewer than limit came
    // back we're done. (Most libraries fit in one page.)
    if (items.length < 1000) break;
    cursor = items[items.length - 1]?.created || null;
    if (!cursor) break;
  }
  return out.filter((v) => v.ready);
}

export async function getVideo(uid) {
  const body = await cfFetch(accountPath(`/${uid}`));
  return normaliseVideo(body.result);
}

// Set custom metadata (e.g. category) on a video — used by admin sync tools.
export async function updateVideoMeta(uid, meta) {
  const body = await cfFetch(accountPath(`/${uid}`), {
    method: 'POST',
    body: JSON.stringify({ meta }),
  });
  return normaliseVideo(body.result);
}

// ---- Signed playback --------------------------------------------------------

// Mint a signed token via Cloudflare's API (default path — only needs the API
// token you already provide). Works for any video.
async function apiSignedToken(uid, ttlSeconds) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = await cfFetch(accountPath(`/${uid}/token`), {
    method: 'POST',
    body: JSON.stringify({ exp }),
  });
  return body.result.token;
}

// Sign a token locally with a Stream signing key (optional, avoids an API call
// per playback). Implements Cloudflare's JWT scheme (RS256, kid = key id).
function localSignedToken(uid, ttlSeconds) {
  const header = { alg: 'RS256', kid: config.cloudflare.signingKeyId };
  const payload = {
    sub: uid,
    kid: config.cloudflare.signingKeyId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    // accessRules could be added here (e.g. IP / country restrictions).
  };
  const b64 = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const data = `${b64(header)}.${b64(payload)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  signer.end();
  const signature = signer.sign(config.cloudflare.signingKeyPem).toString('base64url');
  return `${data}.${signature}`;
}

// Build a ready-to-play, short-lived playback URL for a video. Returns HLS by
// default (best for long videos + adaptive bitrate); DASH also available.
export async function getPlaybackUrls(video, { ttlSeconds } = {}) {
  const ttl = ttlSeconds || config.app.streamTokenTtl;

  // Public video — no token needed.
  if (!video.requireSignedURLs) {
    return { hls: video.hls, dash: video.dash, signed: false, expiresIn: null };
  }

  // Private video — needs a signed token substituted into the manifest URL.
  const token = readiness.localSigning
    ? localSignedToken(video.uid, ttl)
    : await apiSignedToken(video.uid, ttl);

  const swap = (url) => (url ? url.replace(`/${video.uid}/`, `/${token}/`) : '');
  return {
    hls: swap(video.hls),
    dash: swap(video.dash),
    signed: true,
    expiresIn: ttl,
  };
}

log.debug('cloudflare/stream.js loaded');
