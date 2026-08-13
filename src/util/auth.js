import { config } from '../config.js';

// Verify a Discord OAuth access token by asking Discord who it belongs to.
// This is how the server trusts the user id a client claims (the Activity gets
// the token via the Embedded App SDK). Small in-memory cache avoids calling
// Discord on every request.

const cache = new Map(); // token -> { user, exp }
const TTL_MS = 60_000;

export async function verifyDiscordToken(accessToken) {
  if (!accessToken) return null;
  const hit = cache.get(accessToken);
  if (hit && hit.exp > Date.now()) return hit.user;

  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const u = await res.json();
  const user = {
    id: u.id,
    username: u.username,
    name: u.global_name || u.username,
    avatar: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${(BigInt(u.id) >> 22n) % 6n}.png`,
  };
  cache.set(accessToken, { user, exp: Date.now() + TTL_MS });
  return user;
}

// Exchange an OAuth authorization code (from the Activity SDK) for an access
// token. Needs the client secret — done server-side only.
export async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: config.discord.clientId,
    client_secret: config.discord.clientSecret,
    grant_type: 'authorization_code',
    code,
  });
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OAuth token exchange failed (${res.status}): ${text}`);
  }
  return res.json(); // { access_token, token_type, expires_in, scope, ... }
}

// Express middleware: require a valid Discord token in the Authorization header.
export async function requireUser(req, res, next) {
  try {
    const auth = req.get('authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const user = await verifyDiscordToken(token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Unauthorized', detail: err.message });
  }
}
