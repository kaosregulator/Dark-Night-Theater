import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FETCH_TIMEOUT_MS,
  IMAGE_EXT,
  IMAGE_MIME,
  MAX_IMAGE_BYTES,
  MAX_REDIRECTS,
  VIDEO_EXT,
} from './constants.js';

const execFileAsync = promisify(execFile);

/**
 * Safe media download + validation for the image-target watcher.
 * Reuses the same SSRF ideas as the emoji source loader, but keeps this
 * module self-contained so the feature stays drop-in.
 */

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  '169.254.169.254',
  '100.100.100.200',
  'fd00:ec2::254',
]);

export function isBlockedHost(rawHost) {
  const host = String(rawHost || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (!host) return true;
  if (METADATA_HOSTS.has(host)) return true;
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    host.endsWith('.home.arpa') ||
    (!host.includes('.') && !host.includes(':'))
  ) {
    return true;
  }
  if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;

  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (mappedDotted?.[1]) return isBlockedHost(mappedDotted[1]);

  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (mappedHex) {
    const high = parseInt(mappedHex[1], 16);
    const low = parseInt(mappedHex[2], 16);
    return isBlockedHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    return (
      a === 0 ||
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0) ||
      a >= 224
    );
  }
  return false;
}

function isPrivateIp(ip) {
  return isBlockedHost(ip);
}

export function assertPublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('bad_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('bad_url');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isBlockedHost(host)) throw new Error('ssrf_blocked');
  return url;
}

/** Resolve hostname and reject if any answer is private/link-local. */
async function assertResolvedPublic(url) {
  const host = url.hostname;
  if (isBlockedHost(host)) throw new Error('ssrf_blocked');
  // Literal IPs already checked by isBlockedHost.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return;
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('dns_failed');
  }
  if (!addrs.length) throw new Error('dns_failed');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('ssrf_blocked');
  }
}

/**
 * Download bytes with size + timeout + redirect + SSRF limits.
 * Discord CDN URLs are allowed (public).
 */
export async function downloadBytes(rawUrl, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  let url = assertPublicHttpUrl(rawUrl);
  await assertResolvedPublic(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'DarkNight-ImageTarget/1.0',
          Accept: 'image/*,video/*,*/*;q=0.8',
        },
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('bad_redirect');
        url = assertPublicHttpUrl(new URL(loc, url).toString());
        await assertResolvedPublic(url);
        continue;
      }

      if (!res.ok) throw new Error(`http_${res.status}`);

      const declared = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error('too_large');
      }

      const reader = res.body?.getReader?.();
      if (!reader) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) throw new Error('too_large');
        if (!buf.length) throw new Error('empty');
        return {
          buffer: buf,
          contentType: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
          finalUrl: url.toString(),
        };
      }

      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          try { reader.cancel(); } catch { /* ignore */ }
          throw new Error('too_large');
        }
        chunks.push(Buffer.from(value));
      }
      const buffer = Buffer.concat(chunks);
      if (!buffer.length) throw new Error('empty');
      return {
        buffer,
        contentType: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
        finalUrl: url.toString(),
      };
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error('timeout');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('too_many_redirects');
}

export function extensionOf(nameOrUrl = '') {
  const clean = String(nameOrUrl).split('?')[0].split('#')[0];
  const base = clean.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function looksLikeImage({ contentType, filename, url } = {}) {
  if (contentType && IMAGE_MIME.has(contentType)) return true;
  const ext = extensionOf(filename || url || '');
  return IMAGE_EXT.has(ext);
}

export function looksLikeVideo({ contentType, filename, url } = {}) {
  if (contentType && contentType.startsWith('video/')) return true;
  const ext = extensionOf(filename || url || '');
  return VIDEO_EXT.has(ext);
}

/**
 * Extract a still JPEG frame from a video buffer via ffmpeg.
 * Returns null if ffmpeg fails (caller should skip).
 */
export async function extractVideoFrame(videoBuffer) {
  const dir = await mkdtemp(path.join(tmpdir(), 'img-target-'));
  const inFile = path.join(dir, 'in.bin');
  const outFile = path.join(dir, 'frame.jpg');
  try {
    await writeFile(inFile, videoBuffer);
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error',
        '-y',
        '-i', inFile,
        '-frames:v', '1',
        '-q:v', '3',
        outFile,
      ],
      { timeout: 20_000 },
    );
    return await readFile(outFile);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Normalize any supported media into image bytes for hashing/embedding.
 * - images/gifs → as-is (sharp reads first GIF frame)
 * - videos → first frame via ffmpeg
 */
export async function loadMediaAsImage(buffer, meta = {}) {
  if (looksLikeVideo(meta) || (!looksLikeImage(meta) && meta.forceVideo)) {
    const frame = await extractVideoFrame(buffer);
    if (!frame) throw new Error('video_frame_failed');
    return { buffer: frame, mediaKind: 'video' };
  }
  // Let sharp validate; callers fingerprint next.
  return { buffer, mediaKind: looksLikeImage(meta) ? (extensionOf(meta.filename || meta.url) === 'gif' ? 'gif' : 'image') : 'image' };
}

/** Match common direct image URLs in message content. */
export function extractImageUrls(text = '') {
  const re = /https?:\/\/[^\s<>]+/gi;
  const out = [];
  for (const match of text.match(re) || []) {
    const url = match.replace(/[),.;>'"`]+$/g, '');
    const ext = extensionOf(url);
    if (IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)) out.push(url);
  }
  return [...new Set(out)];
}

/**
 * Custom emoji → CDN URL(s).
 * Static: png, animated: gif.
 */
export function emojiCdnUrl(emojiId, animated = false) {
  const ext = animated ? 'gif' : 'png';
  return `https://cdn.discordapp.com/emojis/${emojiId}.${ext}?size=256&quality=lossless`;
}

export function extractCustomEmojis(text = '') {
  const re = /<(a?):(\w+):(\d+)>/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    out.push({
      animated: m[1] === 'a',
      name: m[2],
      id: m[3],
      url: emojiCdnUrl(m[3], m[1] === 'a'),
    });
  }
  return out;
}
