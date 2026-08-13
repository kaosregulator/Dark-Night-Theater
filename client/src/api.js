import { dc } from './discord.js';

// Thin API client. All authenticated calls carry the Discord access token so the
// server can verify who we are.
async function req(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${dc.auth?.access_token || ''}`,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

export const api = {
  library: (query = '', category = '') =>
    req(`/library?query=${encodeURIComponent(query)}&category=${encodeURIComponent(category)}`),
  playback: (uid) => req('/playback', { method: 'POST', body: JSON.stringify({ uid }) }),
  session: (channelId) => req(`/session/${channelId}`),
  startMovie: (channelId, uid, guildId) =>
    req(`/session/${channelId}/movie`, { method: 'POST', body: JSON.stringify({ uid, guildId }) }),
  saveProgress: (uid, position) =>
    req('/private/progress', { method: 'POST', body: JSON.stringify({ uid, position }) }),
  history: () => req('/private/history'),
  progress: (uid) => req(`/private/progress/${uid}`),
  settings: (guildId) => req(`/guild/${guildId}/settings`),
};
