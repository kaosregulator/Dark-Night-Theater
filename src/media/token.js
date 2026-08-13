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
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
