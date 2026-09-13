// Soft heuristics for diagnostics only.
// Filename / size hints may inform logging, but they must NEVER block playback
// or tell the user the movie cannot play. Conversion-first always attempts HLS.

/** Filename / title patterns that historically needed a Discord-safe convert. */
const NAME_HINT =
  /moviebox|hevc|h\.?265|x265|10[\s._-]?bit|hdr10|dolby[\s._-]?vision|bluray|blu[\s._-]?ray|remux|web[\s._-]?dl|webrip|hdtv|\beac3\b|\bac3\b|\bdts\b|\batmos\b/i;

/** Large files are noted for diagnostics (full movies, not short clips). */
export const LARGE_HOLD_BYTES = 700 * 1024 * 1024; // 700 MB

export function looksLikeNeedsConvert(name, size = 0) {
  const n = String(name || '');
  if (NAME_HINT.test(n)) return true;
  const bytes = Number(size) || 0;
  return bytes >= LARGE_HOLD_BYTES;
}

/** Diagnostic hint only — never shown as a hard block / manual-convert tip. */
export function suspectReason(name, size = 0) {
  if (!looksLikeNeedsConvert(name, size)) return null;
  return 'Preparing a Discord-safe stream… playback starts after the first segments.';
}
