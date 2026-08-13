import { GlobalFonts, loadImage } from '@napi-rs/canvas';
import { log } from '../../logger.js';

// Shared palette, font registration, and low-level drawing primitives for the
// in-Discord Canvas cards. We draw icons as vector shapes (not emoji) so nothing
// depends on a color-emoji font being present on the host.

export const C = {
  bg0: '#0a0a12',
  bg1: '#1a1330',
  panel: '#14141f',
  panel2: '#1c1c2b',
  gold: '#c9a227',
  gold2: '#ffd66b',
  red: '#7a1620',
  red2: '#a2202c',
  text: '#ece9f5',
  muted: '#9a97b5',
  line: '#2a2a3d',
};

// Register a sans + bold face from whatever the host provides. Tries common
// Linux paths (Replit/Railway/Debian/Fedora). Falls back silently.
let FONT = 'DNSans';
let FONT_BOLD = 'DNSansBold';
(function registerFonts() {
  const candidates = [
    ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
    ['/usr/share/fonts/TTF/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf'],
    ['/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'],
    ['/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf', '/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf'],
  ];
  let ok = false;
  for (const [reg, bold] of candidates) {
    try {
      GlobalFonts.registerFromPath(reg, FONT);
      GlobalFonts.registerFromPath(bold, FONT_BOLD);
      ok = true;
      break;
    } catch {
      /* try next */
    }
  }
  if (!ok) {
    // Fall back to any default family the runtime exposes.
    FONT = GlobalFonts.families?.[0]?.family || 'sans-serif';
    FONT_BOLD = FONT;
    log.warn('Canvas: DejaVu not found; using fallback font. Cards still render.');
  }
})();

export const font = (size, bold = false) => `${bold ? '' : ''}${size}px ${bold ? FONT_BOLD : FONT}`;

// ---- primitives ------------------------------------------------------------
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function vGradient(ctx, x, y, w, h, from, to) {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  return g;
}

export function text(ctx, str, x, y, { size = 24, bold = false, color = C.text, align = 'left', maxWidth } = {}) {
  ctx.font = font(size, bold);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(str ?? '', x, y, maxWidth);
}

// Truncate a string to fit maxWidth in the current font.
export function ellipsize(ctx, str, size, bold, maxWidth) {
  ctx.font = font(size, bold);
  if (ctx.measureText(str).width <= maxWidth) return str;
  let s = str;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxWidth) s = s.slice(0, -1);
  return s + '…';
}

// Safe remote image loader — returns an Image or null (never throws).
export async function loadRemote(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return await loadImage(buf);
  } catch {
    return null;
  }
}

// Draw a circular avatar; if the image failed to load, draw a colored disc with
// the user's initials so the card always looks complete.
export async function avatarCircle(ctx, user, cx, cy, radius) {
  const img = await loadRemote(user?.avatar);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (img) {
    ctx.drawImage(img, cx - radius, cy - radius, radius * 2, radius * 2);
  } else {
    const hues = ['#8ab4ff', '#ff9ec4', '#8affc4', '#c9a2ff', '#ffb38a', '#8affe0'];
    const seed = [...(user?.id || 'x')].reduce((a, c) => a + c.charCodeAt(0), 0);
    ctx.fillStyle = hues[seed % hues.length];
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.fillStyle = '#14101c';
    ctx.font = font(radius, true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((user?.name || '?').slice(0, 2).toUpperCase(), cx, cy + 2);
  }
  ctx.restore();
  // gold ring
  ctx.strokeStyle = C.gold2;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
}

// A little film-strip band (perforated), used as a decorative marquee.
export function filmStrip(ctx, x, y, w, h) {
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#2a2a3d';
  const hole = h * 0.18;
  for (let px = x + 6; px < x + w - 6; px += hole * 1.8) {
    roundRect(ctx, px, y + 4, hole, hole, 2);
    ctx.fill();
    roundRect(ctx, px, y + h - hole - 4, hole, hole, 2);
    ctx.fill();
  }
}

// Vector popcorn box (red/white stripes + kernels).
export function popcornBox(ctx, x, y, w, h) {
  // kernels
  ctx.fillStyle = C.gold2;
  for (let i = 0; i < 16; i++) {
    const kx = x + w * 0.15 + Math.random() * w * 0.7;
    const ky = y - Math.random() * h * 0.5;
    ctx.beginPath();
    ctx.arc(kx, ky, w * 0.06, 0, Math.PI * 2);
    ctx.fill();
  }
  // box (trapezoid)
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w * 0.85, y + h);
  ctx.lineTo(x + w * 0.15, y + h);
  ctx.closePath();
  ctx.fillStyle = '#f4f4f8';
  ctx.fill();
  // red stripes
  ctx.save();
  ctx.clip();
  ctx.fillStyle = C.red2;
  const sw = w / 6;
  for (let i = 0; i < 7; i += 2) ctx.fillRect(x + i * sw, y, sw, h);
  ctx.restore();
}

// Vector cinema seat glyph.
export function seatGlyph(ctx, x, y, w, h, color = C.gold) {
  ctx.fillStyle = color;
  roundRect(ctx, x, y + h * 0.35, w, h * 0.65, 8); // base
  ctx.fill();
  roundRect(ctx, x, y, w * 0.22, h, 6); // left arm
  ctx.fill();
  roundRect(ctx, x + w * 0.78, y, w * 0.22, h, 6); // right arm
  ctx.fill();
}
