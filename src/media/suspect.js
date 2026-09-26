// Heuristics for MovieBox / rip files that look like ".mp4" but often use
// HEVC/H.265 or AC-3. Used to schedule a background Discord-safe convert —
// playback is NEVER held; progressive /tmedia starts immediately.

/** Filename / title patterns that almost always need a Discord-safe convert. */
const NAME_HINT =
  /moviebox|hevc|h\.?265|x265|10[\s._-]?bit|hdr10|dolby[\s._-]?vision|bluray|blu[\s._-]?ray|remux|web[\s._-]?dl|webrip|hdtv|\beac3\b|\bac3\b|\bdts\b|\batmos\b/i;

/** Large full-length films — still play immediately; convert runs in the background. */
export const LARGE_HOLD_BYTES = 700 * 1024 * 1024; // 700 MB (legacy name; no longer a hold)

export function looksLikeNeedsConvert(name, size = 0) {
  const n = String(name || '');
  if (NAME_HINT.test(n)) return true;
  const bytes = Number(size) || 0;
  return bytes >= LARGE_HOLD_BYTES;
}

export function suspectReason(name, size = 0) {
  const n = String(name || '');
  if (NAME_HINT.test(n)) {
    return 'MovieBox/rip detected — playing now; building a Discord-safe stream in the background if needed.';
  }
  const bytes = Number(size) || 0;
  if (bytes >= LARGE_HOLD_BYTES) {
    return 'Full-length movie — playing while it uploads; optimizing for Discord in the background.';
  }
  return null;
}
