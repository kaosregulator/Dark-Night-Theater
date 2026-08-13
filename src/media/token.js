import crypto from 'node:crypto';
import { config } from '../config.js';

// Lightweight signed playback tokens so raw /media URLs can't be trivially
// scraped or shared past a session. HMAC over "<id>.<exp>" using SESSION_SECRET.
// (Same-origin video tags can't send auth headers, so the token rides in the URL.)

export function signMediaToken(id, ttlSeconds = config.media.tokenTtl) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto
    .createHmac('sha256', config.app.sessionSecret)
    .update(`${id}.${exp}`)
    .digest('base64url');
  return `${exp}.${sig}`;
}

export function verifyMediaToken(id, token) {
  if (!token) return false;
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto
    .createHmac('sha256', config.app.sessionSecret)
    .update(`${id}.${exp}`)
    .digest('base64url');
  return safeEqual(sig, expected);
}

function hmac(str) {
  return crypto.createHmac('sha256', config.app.sessionSecret).update(str).digest('base64url');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- Host session tokens ----------------------------------------------------
// A short-lived, signed token that authorises ONE host to upload + start a party
// from the /host page, carrying the Discord context (who, which guild, which
// voice + text channel) so no admin key or manual wiring is needed.
export function signHostSession(data, ttlSeconds = 900) {
  const body = { ...data, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const json = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${json}.${hmac(json)}`;
}

export function verifyHostSession(token) {
  if (!token) return null;
  const [json, sig] = String(token).split('.');
  if (!json || !sig) return null;
  if (!safeEqual(sig, hmac(json))) return null;
  let body;
  try {
    body = JSON.parse(Buffer.from(json, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if ((body.exp || 0) < Math.floor(Date.now() / 1000)) return null;
  return body;
}
