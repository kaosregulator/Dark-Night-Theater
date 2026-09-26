// Filename hints for rips that often need a silent background Discord-safe
// convert AFTER upload. Size alone never triggers convert or any UI hold —
// a 900 MB H.264 movie plays exactly like a 30‑minute clip.

/** Filename / title patterns that often need a Discord-safe convert. */
const NAME_HINT =
  /moviebox|hevc|h\.?265|x265|10[\s._-]?bit|hdr10|dolby[\s._-]?vision|\beac3\b|\bac3\b|\bdts\b|\batmos\b/i;

/** @deprecated kept for tests — size no longer forces convert. */
export const LARGE_HOLD_BYTES = 700 * 1024 * 1024;

export function looksLikeNeedsConvert(name, size = 0) {
  const n = String(name || '');
  // Name/codec hints only. File size must NOT schedule convert or UI banners.
  return NAME_HINT.test(n);
}

/** Never shown in the UI — logging/debug only. */
export function suspectReason(name, size = 0) {
  if (looksLikeNeedsConvert(name, size)) {
    return 'name-hint-convert';
  }
  return null;
}
