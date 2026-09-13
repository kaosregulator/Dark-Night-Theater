// Heuristics for MovieBox / rip files that look like ".mp4" but often use
// HEVC/H.265 or AC-3 — Discord Activities paint those as a black screen until
// we convert to live HLS. Used at party-start (before probe) so we never attach
// the incompatible progressive URL while a multi‑GB upload is still running.

/** Filename / title patterns that almost always need a Discord-safe convert. */
const NAME_HINT =
  /moviebox|hevc|h\.?265|x265|10[\s._-]?bit|hdr10|dolby[\s._-]?vision|bluray|blu[\s._-]?ray|remux|web[\s._-]?dl|webrip|hdtv|\beac3\b|\bac3\b|\bdts\b|\batmos\b/i;

/** Files at/above this size are held until probed (full movies, not short YouTube converts). */
export const LARGE_HOLD_BYTES = 700 * 1024 * 1024; // 700 MB

export function looksLikeNeedsConvert(name, size = 0) {
  const n = String(name || '');
  if (NAME_HINT.test(n)) return true;
  const bytes = Number(size) || 0;
  return bytes >= LARGE_HOLD_BYTES;
}

export function suspectReason(name, size = 0) {
  const n = String(name || '');
  if (NAME_HINT.test(n)) {
    return 'This looks like a MovieBox/rip file — Discord can’t paint HEVC. Holding playback until a Discord-safe HLS stream is ready.';
  }
  const bytes = Number(size) || 0;
  if (bytes >= LARGE_HOLD_BYTES) {
    return 'Large movie file — holding playback until the server verifies Discord-safe codecs (or builds HLS). Keep the host tab open.';
  }
  return null;
}
