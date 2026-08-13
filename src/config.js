import 'dotenv/config';

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

// Decode a signing-key PEM that may be stored base64-encoded or with literal \n.
function readSigningKey() {
  let pem = str('CLOUDFLARE_STREAM_SIGNING_KEY_PEM');
  if (!pem) return '';
  if (str('CLOUDFLARE_STREAM_SIGNING_KEY_B64') === '1') {
    try {
      pem = Buffer.from(pem, 'base64').toString('utf8');
    } catch {
      /* fall through and use as-is */
    }
  }
  return pem.replace(/\\n/g, '\n');
}

export const config = {
  discord: {
    botToken: str('DISCORD_BOT_TOKEN'),
    clientId: str('DISCORD_CLIENT_ID'),
    clientSecret: str('DISCORD_CLIENT_SECRET'),
    devGuildId: str('DISCORD_DEV_GUILD_ID'),
  },
  cloudflare: {
    accountId: str('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: str('CLOUDFLARE_STREAM_API_TOKEN'),
    signingKeyId: str('CLOUDFLARE_STREAM_SIGNING_KEY_ID'),
    signingKeyPem: readSigningKey(),
  },
  app: {
    baseUrl: str('PUBLIC_BASE_URL').replace(/\/$/, ''),
    port: int('PORT', 3000),
    adminUserIds: list('ADMIN_USER_IDS'),
    sessionSecret: str('SESSION_SECRET', 'change-me'),
    streamTokenTtl: int('STREAM_TOKEN_TTL_SECONDS', 21600),
  },
};

// Which subsystems are fully configured. Used for a clear boot report and to
// avoid crashing when, say, Cloudflare isn't wired yet.
export const readiness = {
  get bot() {
    return Boolean(config.discord.botToken && config.discord.clientId);
  },
  get activity() {
    return Boolean(config.discord.clientId && config.discord.clientSecret);
  },
  get cloudflare() {
    return Boolean(config.cloudflare.accountId && config.cloudflare.apiToken);
  },
  get localSigning() {
    return Boolean(config.cloudflare.signingKeyId && config.cloudflare.signingKeyPem);
  },
};

export function missingSecrets() {
  const missing = [];
  if (!config.discord.botToken) missing.push('DISCORD_BOT_TOKEN');
  if (!config.discord.clientId) missing.push('DISCORD_CLIENT_ID');
  if (!config.discord.clientSecret) missing.push('DISCORD_CLIENT_SECRET');
  if (!config.cloudflare.accountId) missing.push('CLOUDFLARE_ACCOUNT_ID');
  if (!config.cloudflare.apiToken) missing.push('CLOUDFLARE_STREAM_API_TOKEN');
  if (!config.app.baseUrl) missing.push('PUBLIC_BASE_URL');
  return missing;
}
