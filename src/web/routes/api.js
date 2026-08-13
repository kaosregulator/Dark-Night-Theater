import express from 'express';
import { config, readiness, missingSecrets } from '../../config.js';
import { requireUser, exchangeCode } from '../../util/auth.js';
import * as library from '../../services/library-store.js';
import * as sessions from '../../services/sessions.js';
import { getSettings } from '../../services/settings-store.js';
import { getPlaybackUrls } from '../../cloudflare/stream.js';
import { log } from '../../logger.js';

export const api = express.Router();
api.use(express.json());

// Public health/status — used by the setup landing page and uptime checks.
api.get('/status', (req, res) => {
  res.json({
    ok: true,
    readiness: {
      bot: readiness.bot,
      activity: readiness.activity,
      cloudflare: readiness.cloudflare,
      localSigning: readiness.localSigning,
    },
    missing: missingSecrets(),
    library: { count: library.getCachedLibrary().length, syncedAt: library.lastSyncedAt() },
  });
});

// Public client bootstrap — only non-secret values the Activity needs at load.
// streamTargets are the Cloudflare hosts the player must reach; the Activity
// routes them through Discord's proxy via patchUrlMappings (see client/discord.js).
api.get('/config', (req, res) => {
  const hosts = new Set();
  for (const v of library.getCachedLibrary()) {
    for (const url of [v.hls, v.dash]) {
      try {
        if (url) hosts.add(new URL(url).host);
      } catch {
        /* ignore */
      }
    }
  }
  // videodelivery.net is Cloudflare Stream's legacy/segment host; include it too.
  hosts.add('videodelivery.net');
  res.json({ clientId: config.discord.clientId, streamTargets: [...hosts] });
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

// Browse / search the cached library (no secrets — just display metadata).
api.get('/library', (req, res) => {
  const { query = '', category = '' } = req.query;
  res.json({
    videos: library.search({ query, category }),
    categories: library.categories(),
    syncedAt: library.lastSyncedAt(),
  });
});

// Mint a short-lived signed playback URL for one video.
api.post('/playback', async (req, res) => {
  try {
    const { uid } = req.body || {};
    const video = library.findVideo(uid);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const urls = await getPlaybackUrls(video);
    res.json({
      uid: video.uid,
      name: video.name,
      durationSeconds: video.durationSeconds,
      ...urls,
    });
  } catch (err) {
    log.warn('playback:', err.message);
    res.status(500).json({ error: 'Could not create playback URL' });
  }
});

// Current room snapshot (Activity fetches this on load; live updates via WS).
api.get('/session/:channelId', (req, res) => {
  res.json(sessions.snapshot(sessions.getRoom(req.params.channelId)));
});

// Start a clan movie from inside the Activity (host-initiated).
api.post('/session/:channelId/movie', async (req, res) => {
  try {
    const { uid, guildId } = req.body || {};
    const video = library.findVideo(uid);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const playback = await getPlaybackUrls(video);
    sessions.startClanMovie(req.params.channelId, {
      hostId: req.user.id,
      guildId,
      video,
      playback,
    });
    res.json(sessions.snapshot(sessions.getRoom(req.params.channelId)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Read-only per-guild settings (editing happens via the Discord /theater-settings
// command where Discord enforces permissions).
api.get('/guild/:guildId/settings', (req, res) => {
  res.json({ settings: getSettings(req.params.guildId) });
});
