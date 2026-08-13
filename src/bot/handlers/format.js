// Small display helpers shared across command handlers.

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

// A tidy label for a video option (used in select menus / embeds).
export function videoLabel(v) {
  const dur = formatDuration(v.durationSeconds);
  return `${v.name} • ${dur} • ${v.category}`;
}

export const COLORS = {
  gold: 0xc9a227,
  dark: 0x15151f,
  red: 0xd23b3b,
  green: 0x3bd275,
};
