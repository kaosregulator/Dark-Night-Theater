import 'dotenv/config';
import path from 'node:path';

// Centralised, validated configuration. Reads once at boot. Missing values are
// reported (not fatal) so the web server can still start and show setup help —
// which makes "deploy first, paste secrets after" workflows painless.

function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === null ? fallback : String(v).trim();
}
function int(name, fallback) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
}
function list(name) {
  return str(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  discord: {
    botToken: str('DISCORD_BOT_TOKEN'),
    clientId: str('DISCORD_CLIENT_ID'),
    clientSecret: str('DISCORD_CLIENT_SECRET'),
    devGuildId: str('DISCORD_DEV_GUILD_ID'),
  },
  // Local-device movie host. Videos are served from disk with HTTP range
  // support — no cloud storage, no transcoding service.
  media: {
    dir: path.resolve(process.cwd(), str('MEDIA_DIR', 'media')),
    maxUploadMb: int('MAX_UPLOAD_MB', 8192),
    tokenTtl: int('MEDIA_TOKEN_TTL', 86400), // playback URLs valid 24h by default
    // Temporary per-party session files are scrubbed after this age, or after
    // ~30 min of inactivity, or when the party ends — whichever comes first.
    sessionTtl: int('SESSION_TTL_SECONDS', 21600), // 6h (covers a 3h+ movie)
    // Key that protects the /host upload page. Falls back to SESSION_SECRET.
    get adminKey() {
      return str('HOST_ADMIN_KEY') || config.app.sessionSecret;
    },
  },
  app: {
    baseUrl: str('PUBLIC_BASE_URL').replace(/\/$/, ''),
    port: int('PORT', 3000),
    adminUserIds: list('ADMIN_USER_IDS'),
    sessionSecret: str('SESSION_SECRET', 'change-me'),
  },
  // Optional — enables stage-2 visual matching for /image-target.
  // Free key: https://jina.ai/?sui=apikey
  // Without it, the watcher still works via local perceptual hashes.
  jina: {
    apiKey: str('JINA_API_KEY'),
  },
  // Railway Postgres (required for Image Target Watcher in production).
  // In Railway: Dark-Night-Theater → Variables → add reference
  //   DATABASE_URL = ${{Postgres.DATABASE_URL}}
  database: {
    url: str('DATABASE_URL'),
  },
};

// Which subsystems are ready. The media host needs no secrets, so it's always on.
export const readiness = {
  get bot() {
    return Boolean(config.discord.botToken && config.discord.clientId);
  },
  get activity() {
    return Boolean(config.discord.clientId && config.discord.clientSecret);
  },
  get media() {
    return true;
  },
};

export function missingSecrets() {
  const missing = [];
  if (!config.discord.botToken) missing.push('DISCORD_BOT_TOKEN');
  if (!config.discord.clientId) missing.push('DISCORD_CLIENT_ID');
  if (!config.discord.clientSecret) missing.push('DISCORD_CLIENT_SECRET');
  if (!config.app.baseUrl) missing.push('PUBLIC_BASE_URL');
  return missing;
}
