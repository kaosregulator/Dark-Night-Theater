// Heuristics for MovieBox / large / rip files that often need live HLS.
// Used to *hold progressive* during upload — never to refuse conversion.

/** Filename / title patterns that usually need a Discord-safe convert. */
const NAME_HINT =
  /moviebox|hevc|h\.?265|x265|10[\s._-]?bit|hdr10|dolby[\s._-]?vision|bluray|blu[\s._-]?ray|remux|web[\s._-]?dl|webrip|hdtv|\beac3\b|\bac3\b|\bdts\b|\batmos\b/i;

/** Large files are held for probe/HLS (full movies, not short clips). */
export const LARGE_HOLD_BYTES = 700 * 1024 * 1024; // 700 MB

export function looksLikeNeedsConvert(name, size = 0) {
  const n = String(name || '');
  if (NAME_HINT.test(n)) return true;
  const bytes = Number(size) || 0;
  return bytes >= LARGE_HOLD_BYTES;
}

/** Soft hold tip shown while MovieBox/large uploads prepare HLS. */
export function suspectReason(name, size = 0) {
  if (!looksLikeNeedsConvert(name, size)) return null;
  return 'Large/MovieBox file — preparing a Discord-safe stream… playback starts after the first segments.';
}
