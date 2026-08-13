import { createCanvas } from '@napi-rs/canvas';
import {
  C,
  roundRect,
  vGradient,
  text,
  ellipsize,
  loadRemote,
  avatarCircle,
  filmStrip,
  popcornBox,
  seatGlyph,
  font,
} from './theme.js';

const W = 900;
const H = 400;

// Canvas has no color-emoji font, so strip astral emoji from any text we DRAW
// (embed description text, which Discord renders, keeps its emoji).
const noEmoji = (s) => String(s ?? '').replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '').replace(/\s{2,}/g, ' ').trim();

function base() {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = vGradient(ctx, 0, 0, W, H, C.bg1, C.bg0);
  ctx.fillRect(0, 0, W, H);
  // subtle projector glow
  const g = ctx.createRadialGradient(W / 2, -40, 40, W / 2, -40, 520);
  g.addColorStop(0, 'rgba(201,162,39,0.12)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  return { c, ctx };
}

function marquee(ctx, label = 'DARKNIGHT CINEMA') {
  filmStrip(ctx, 0, 0, W, 34);
  text(ctx, label, W / 2, 24, { size: 18, bold: true, color: C.gold2, align: 'center' });
}

// Deterministic "Row X, Seat NN" from a user id so a user keeps their seat.
export function assignSeat(userId = '') {
  const n = [...userId].reduce((a, ch) => a + ch.charCodeAt(0), 7);
  const row = String.fromCharCode(65 + (n % 8)); // A–H
  const seat = 1 + (n % 24);
  return `Row ${row}, Seat ${seat}`;
}
export function ticketNumber(userId = '', uid = '') {
  const n = [...(userId + uid)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 1000000, 13);
  return String(n).padStart(6, '0');
}

// Draw the "screen" = owner-set poster/thumbnail, or a styled placeholder.
async function drawScreen(ctx, video, x, y, w, h) {
  ctx.save();
  roundRect(ctx, x, y, w, h, 12);
  ctx.clip();
  const img = await loadRemote(video?.thumbnail);
  if (img) {
    // cover-fit
    const ar = img.width / img.height;
    const tr = w / h;
    let dw = w,
      dh = h,
      dx = x,
      dy = y;
    if (ar > tr) {
      dh = h;
      dw = h * ar;
      dx = x - (dw - w) / 2;
    } else {
      dw = w;
      dh = w / ar;
      dy = y - (dh - h) / 2;
    }
    ctx.drawImage(img, dx, dy, dw, dh);
  } else {
    ctx.fillStyle = vGradient(ctx, x, y, w, h, '#2a2150', '#12101f');
    ctx.fillRect(x, y, w, h);
    filmStrip(ctx, x + w / 2 - 70, y + h / 2 - 16, 140, 30);
    text(ctx, 'NO PREVIEW SET', x + w / 2, y + h / 2 + 48, { size: 18, bold: true, align: 'center', color: C.muted });
  }
  ctx.restore();
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;
  roundRect(ctx, x, y, w, h, 12);
  ctx.stroke();
  // gold glow frame
  ctx.strokeStyle = 'rgba(201,162,39,0.5)';
  ctx.lineWidth = 6;
  roundRect(ctx, x - 3, y - 3, w + 6, h + 6, 14);
  ctx.stroke();
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function chip(ctx, label, x, y) {
  ctx.font = font(18, true);
  const w = ctx.measureText(label).width + 28;
  ctx.fillStyle = C.panel2;
  roundRect(ctx, x, y, w, 30, 15);
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, 30, 15);
  ctx.stroke();
  text(ctx, label, x + 14, y + 21, { size: 18, bold: true, color: C.gold2 });
  return w;
}

// ---- 1) BOX OFFICE / preview ----------------------------------------------
export async function renderBoxOffice(video, user) {
  const { c, ctx } = base();
  marquee(ctx, '★  DARKNIGHT BOX OFFICE  ★');

  await drawScreen(ctx, video, 40, 70, 400, 225);
  text(ctx, 'NOW SHOWING', 470, 100, { size: 20, bold: true, color: C.gold2 });
  const title = ellipsize(ctx, noEmoji(video?.name) || 'Untitled', 34, true, 400);
  text(ctx, title, 470, 145, { size: 34, bold: true, color: C.text });

  let cx = 470;
  cx += chip(ctx, video?.category || 'Uncategorized', cx, 170) + 10;
  chip(ctx, fmtDur(video?.durationSeconds), cx, 170);
  if (video?.requireSignedURLs) chip(ctx, 'SIGNED', 470, 212);

  const desc = noEmoji(video?.description || 'Grab your ticket, get some popcorn, find your seat — the show is about to begin.').slice(0, 140);
  wrap(ctx, desc, 470, 250, 400, 24, { size: 17, color: C.muted });

  // viewer badge
  await avatarCircle(ctx, user, 70, 350, 26);
  text(ctx, `Welcome, ${(user?.name || 'guest').slice(0, 22)}`, 108, 357, { size: 18, bold: true, color: C.text });

  return c.toBuffer('image/png');
}

// ---- 2) TICKET -------------------------------------------------------------
export async function renderTicket(user, video, { seat, ticketNo }) {
  const { c, ctx } = base();
  marquee(ctx);

  const tx = 60,
    ty = 90,
    tw = 780,
    th = 250;
  // ticket body
  ctx.fillStyle = vGradient(ctx, tx, ty, tw, th, '#201a10', '#141019');
  roundRect(ctx, tx, ty, tw, th, 18);
  ctx.fill();
  ctx.strokeStyle = C.gold;
  ctx.lineWidth = 3;
  roundRect(ctx, tx, ty, tw, th, 18);
  ctx.stroke();

  // perforated stub divider
  const sx = tx + 250;
  ctx.setLineDash([10, 10]);
  ctx.strokeStyle = 'rgba(201,162,39,0.6)';
  ctx.beginPath();
  ctx.moveTo(sx, ty + 12);
  ctx.lineTo(sx, ty + th - 12);
  ctx.stroke();
  ctx.setLineDash([]);
  // notches
  ctx.fillStyle = C.bg0;
  ctx.beginPath();
  ctx.arc(sx, ty, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(sx, ty + th, 14, 0, Math.PI * 2);
  ctx.fill();

  // stub: avatar + ADMIT ONE
  await avatarCircle(ctx, user, tx + 125, ty + 95, 55);
  text(ctx, (user?.name || 'Guest').slice(0, 16), tx + 125, ty + 175, { size: 20, bold: true, align: 'center', color: C.text });
  text(ctx, 'ADMIT ONE', tx + 125, ty + 205, { size: 22, bold: true, align: 'center', color: C.gold2 });
  text(ctx, `No. ${ticketNo}`, tx + 125, ty + 230, { size: 16, align: 'center', color: C.muted });

  // main: movie details
  const mx = sx + 30;
  text(ctx, '★  MOVIE TICKET', mx, ty + 45, { size: 20, bold: true, color: C.gold2 });
  const title = ellipsize(ctx, noEmoji(video?.name) || 'Untitled', 32, true, tw - 320);
  text(ctx, title, mx, ty + 90, { size: 32, bold: true, color: C.text });
  text(ctx, `${video?.category || 'Feature'} · ${fmtDur(video?.durationSeconds)}`, mx, ty + 122, { size: 18, color: C.muted });
  seatGlyph(ctx, mx, ty + 150, 34, 34, C.gold2);
  text(ctx, seat, mx + 48, ty + 178, { size: 24, bold: true, color: C.text });
  text(ctx, 'DarkNight Home Theater · Enjoy the show', mx, ty + 220, { size: 15, color: C.muted });

  return c.toBuffer('image/png');
}

// ---- 3) CONCESSIONS / popcorn ---------------------------------------------
export async function renderConcession(user, { snack }) {
  const { c, ctx } = base();
  marquee(ctx, '★  CONCESSION STAND  ★');

  // popcorn box centerpiece
  popcornBox(ctx, 360, 150, 180, 170);
  // soda cup
  ctx.fillStyle = C.red2;
  ctx.beginPath();
  ctx.moveTo(560, 175);
  ctx.lineTo(620, 175);
  ctx.lineTo(608, 320);
  ctx.lineTo(572, 320);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = C.gold2;
  ctx.fillRect(585, 130, 8, 55); // straw

  await avatarCircle(ctx, user, 180, 230, 60);
  text(ctx, `${(user?.name || 'You')} grabbed`, 180, 320, { size: 20, bold: true, align: 'center', color: C.text });
  text(ctx, noEmoji(snack), 180, 348, { size: 24, bold: true, align: 'center', color: C.gold2 });

  text(ctx, 'One more step — take your seat!', W / 2, 385, { size: 18, align: 'center', color: C.muted });
  return c.toBuffer('image/png');
}

// ---- 4) SEATED / ready -----------------------------------------------------
export async function renderSeated(user, video, { seat }) {
  const { c, ctx } = base();
  marquee(ctx);

  // glowing screen up top with title
  await drawScreen(ctx, video, 250, 60, 400, 150);
  text(ctx, ellipsize(ctx, noEmoji(video?.name) || '', 22, true, 380), 450, 235, { size: 22, bold: true, align: 'center', color: C.gold2 });

  // rows of seats, one highlighted with the avatar
  const rows = 3,
    cols = 9;
  const startX = 120,
    startY = 270,
    gap = 74,
    sw = 46,
    sh = 40;
  const hi = { r: 1, cIdx: 4 };
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const x = startX + col * gap;
      const y = startY + r * 42;
      if (r === hi.r && col === hi.cIdx) continue; // leave the spot for avatar
      seatGlyph(ctx, x, y, sw, sh, r === hi.r ? C.gold : C.panel2);
    }
  }
  const ax = startX + hi.cIdx * gap + sw / 2;
  const ay = startY + hi.r * 42 + sh / 2;
  await avatarCircle(ctx, user, ax, ay, 30);

  text(ctx, `You're seated — ${seat}`, W / 2, 388, { size: 20, bold: true, align: 'center', color: C.text });
  return c.toBuffer('image/png');
}

// simple word-wrap
function wrap(ctx, str, x, y, maxW, lh, opts) {
  const words = String(str).split(' ');
  let line = '';
  let yy = y;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    ctx.font = font(opts.size, opts.bold);
    if (ctx.measureText(test).width > maxW && line) {
      text(ctx, line, x, yy, opts);
      line = w;
      yy += lh;
    } else {
      line = test;
    }
  }
  if (line) text(ctx, line, x, yy, opts);
}
