import express from 'express';
import { config, readiness, missingSecrets } from '../../config.js';
import { requireUser, exchangeCode } from '../../util/auth.js';
import * as library from '../../services/library-store.js';
import * as sessions from '../../services/sessions.js';
import { getSettings } from '../../services/settings-store.js';
import { getPlayback } from '../../media/store.js';
import { log } from '../../logger.js';

export const api = express.Router();
api.use(express.json());

// Public health/status — used by the setup landing page and uptime checks.
api.get('/status', (req, res) => {
  res.json({
    ok: true,
    readiness: { bot: readiness.bot, activity: readiness.activity, media: readiness.media },
    missing: missingSecrets(),
    library: { count: library.getCachedLibrary().length, syncedAt: library.lastSyncedAt() },
  });
});

// Public client bootstrap — only non-secret values the Activity needs at load.
// (Movies are served same-origin now, so there's nothing external to proxy.)
api.get('/config', (req, res) => {
  res.json({ clientId: config.discord.clientId });
});

// OAuth code -> access token (Activity handshake). Secret stays server-side.
api.post('/token', async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Missing code' });
    const token = await exchangeCode(code);
    res.json({ access_token: token.access_token });
  } catch (err) {
    log.warn('token exchange:', err.message);
    res.status(500).json({ error: 'Token exchange failed' });
  }
});

// ---- everything below requires a verified Discord user ----------------------
api.use(requireUser);

// Browse / search the library (no secrets — just display metadata).
api.get('/library', (req, res) => {
  const { query = '', category = '' } = req.query;
  res.json({
    videos: library.search({ query, category }),
    categories: library.categories(),
    syncedAt: library.lastSyncedAt(),
  });
});

// Mint a short-lived signed playback URL for one video.
api.post('/playback', (req, res) => {
  const { uid } = req.body || {};
  const video = library.findVideo(uid);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const urls = getPlayback(video);
  res.json({ uid: video.uid, name: video.name, durationSeconds: video.durationSeconds, ...urls });
});

// Signed /host upload link for the Activity "Host a Movie" button (opens in browser).
api.post('/host-link', async (req, res) => {
  const { channelId, guildId, textChannelId } = req.body || {};
  if (!config.app.baseUrl) return res.status(503).json({ error: 'PUBLIC_BASE_URL not configured' });
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  const { signHostSession } = await import('../../media/token.js');
  const token = signHostSession({
    userId: req.user.id,
    guildId: guildId || null,
    voiceChannelId: channelId,
    textChannelId: textChannelId || null,
  });
  res.json({ url: `${config.app.baseUrl}/host?s=${encodeURIComponent(token)}` });
});

// Current room snapshot (Activity fetches this on load; live updates via WS).
api.get('/session/:channelId', (req, res) => {
  res.json(sessions.snapshot(sessions.getRoom(req.params.channelId)));
});

// Start a clan movie from inside the Activity (host-initiated).
api.post('/session/:channelId/movie', (req, res) => {
  const { uid, guildId } = req.body || {};
  const video = library.findVideo(uid);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  const playback = getPlayback(video);
  sessions.startClanMovie(req.params.channelId, { hostId: req.user.id, guildId, video, playback });
  res.json(sessions.snapshot(sessions.getRoom(req.params.channelId)));
});

// Private viewing progress + history.
api.post('/private/progress', (req, res) => {
  const { uid, position } = req.body || {};
  const video = library.findVideo(uid);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  sessions.savePrivateProgress(req.user.id, video, position || 0);
  res.json({ ok: true });
});
api.get('/private/history', (req, res) => {
  res.json({ history: sessions.getHistory(req.user.id) });
});
api.get('/private/progress/:uid', (req, res) => {
  res.json({ progress: sessions.getPrivateProgress(req.user.id, req.params.uid) });
});

// Read-only per-guild settings (editing happens via /theater-settings).
api.get('/guild/:guildId/settings', (req, res) => {
  res.json({ settings: getSettings(req.params.guildId) });
});
