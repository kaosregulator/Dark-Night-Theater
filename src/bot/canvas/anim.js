import { createCanvas } from '@napi-rs/canvas';
import gifenc from 'gifenc';
import {
  C,
  roundRect,
  vGradient,
  text,
  ellipsize,
  font,
  filmStrip,
  seatGlyph,
  loadRemote,
  drawAvatar,
} from './theme.js';

const { GIFEncoder, quantize, applyPalette } = gifenc;

// Animated GIF versions of the pre-show cards. Each returns a GIF Buffer.
// Kept modest (640x300, ~16 frames) so encoding stays well under a second and
// files stay small enough for Discord embeds (~30–80KB). Loops forever.

const W = 640;
const H = 300;
const noEmoji = (s) => String(s ?? '').replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu, '').replace(/\s{2,}/g, ' ').trim();
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const fmtDur = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

// Build a looping GIF. draw(ctx, i, t) paints frame i (t = 0..1). `delays` is a
// per-frame ms array or a single number.
function buildGif(count, delays, draw) {
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  const gif = GIFEncoder();
  for (let i = 0; i < count; i++) {
    draw(ctx, i, count === 1 ? 1 : i / (count - 1));
    const { data } = ctx.getImageData(0, 0, W, H);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, W, H, { palette, delay: Array.isArray(delays) ? delays[i] : delays });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

function bg(ctx) {
  ctx.fillStyle = vGradient(ctx, 0, 0, W, H, C.bg1, C.bg0);
  ctx.fillRect(0, 0, W, H);
}
function marquee(ctx, label) {
  filmStrip(ctx, 0, 0, W, 26);
  text(ctx, label, W / 2, 19, { size: 15, bold: true, color: C.gold2, align: 'center' });
}
function coverImage(ctx, img, x, y, w, h) {
  const ar = img.width / img.height;
  const tr = w / h;
  let dw = w, dh = h, dx = x, dy = y;
  if (ar > tr) { dh = h; dw = h * ar; dx = x - (dw - w) / 2; }
  else { dw = w; dh = w / ar; dy = y - (dh - h) / 2; }
  ctx.save();
  roundRect(ctx, x, y, w, h, 10);
  ctx.clip();
  ctx.drawImage(img, dx, dy, dw, dh);
  ctx.restore();
}

// ---- 1) CURTAIN REVEAL (Box Office) ---------------------------------------
export async function animCurtain(video, user) {
  const poster = await loadRemote(video?.thumbnail);
  const avatar = await loadRemote(user?.avatar);
  const N = 18;
  // closed → open, then hold open at the end
  const delays = Array.from({ length: N }, (_, i) => (i >= N - 3 ? 500 : 70));

  return buildGif(N, delays, (ctx, i, t) => {
    bg(ctx);
    marquee(ctx, '★  DARKNIGHT BOX OFFICE  ★');

    // settled scene behind the curtains
    const px = 30, py = 55, pw = 300, ph = 170;
    if (poster) coverImage(ctx, poster, px, py, pw, ph);
    else {
      ctx.fillStyle = vGradient(ctx, px, py, pw, ph, '#2a2150', '#12101f');
      roundRect(ctx, px, py, pw, ph, 10);
      ctx.fill();
      filmStrip(ctx, px + pw / 2 - 55, py + ph / 2 - 12, 110, 22);
    }
    ctx.strokeStyle = 'rgba(201,162,39,0.6)';
    ctx.lineWidth = 5;
    roundRect(ctx, px - 2, py - 2, pw + 4, ph + 4, 12);
    ctx.stroke();

    text(ctx, 'NOW SHOWING', 355, 78, { size: 16, bold: true, color: C.gold2 });
    text(ctx, ellipsize(ctx, noEmoji(video?.name) || 'Untitled', 26, true, 260), 355, 112, { size: 26, bold: true, color: C.text });
    text(ctx, `${video?.category || 'Feature'} · ${fmtDur(video?.durationSeconds)}`, 355, 140, { size: 15, color: C.muted });
    drawAvatar(ctx, avatar, user, 50, 262, 20);
    text(ctx, `Welcome, ${(user?.name || 'guest').slice(0, 18)}`, 80, 268, { size: 15, bold: true, color: C.text });

    // curtains part
    const open = easeInOut(t);
    const half = W / 2;
    const cw = half * (1 - open);
    for (const [x0, dir] of [[0, 1], [W, -1]]) {
      const gx = dir === 1 ? 0 : W - cw;
      const g = ctx.createLinearGradient(gx, 0, gx + cw, 0);
      g.addColorStop(0, dir === 1 ? '#4a0c12' : '#a2202c');
      g.addColorStop(0.5, '#7a1620');
      g.addColorStop(1, dir === 1 ? '#a2202c' : '#4a0c12');
      ctx.fillStyle = g;
      ctx.fillRect(gx, 26, cw, H - 26);
      // fabric folds
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 2;
      for (let fx = 0; fx < cw; fx += 22) {
        ctx.beginPath();
        ctx.moveTo(gx + fx, 26);
        ctx.lineTo(gx + fx, H);
        ctx.stroke();
      }
    }
  });
}

// ---- 2) TICKET PRINT -------------------------------------------------------
export async function animTicket(user, video, { seat, ticketNo }) {
  const avatar = await loadRemote(user?.avatar);
  const N = 18;
  const delays = Array.from({ length: N }, (_, i) => (i >= N - 4 ? 450 : 70));

  return buildGif(N, delays, (ctx, i, t) => {
    bg(ctx);
    marquee(ctx, 'DARKNIGHT CINEMA');
    // printer slot
    ctx.fillStyle = '#000';
    roundRect(ctx, 60, 70, W - 120, 14, 6);
    ctx.fill();
    text(ctx, 'PRINTING TICKET…', W / 2, 60, { size: 13, bold: true, color: C.muted, align: 'center' });

    // ticket emerges downward from the slot
    const th = 170, tw = W - 120, tx = 60;
    const finalY = 92;
    const ty = finalY - (1 - easeOut(t)) * (th + 10);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 84, W, H); // clip so it appears to come out of the slot
    ctx.clip();

    ctx.fillStyle = vGradient(ctx, tx, ty, tw, th, '#201a10', '#141019');
    roundRect(ctx, tx, ty, tw, th, 14);
    ctx.fill();
    ctx.strokeStyle = C.gold;
    ctx.lineWidth = 2.5;
    roundRect(ctx, tx, ty, tw, th, 14);
    ctx.stroke();

    const sx = tx + 170;
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = 'rgba(201,162,39,0.6)';
    ctx.beginPath();
    ctx.moveTo(sx, ty + 10);
    ctx.lineTo(sx, ty + th - 10);
    ctx.stroke();
    ctx.setLineDash([]);

    drawAvatar(ctx, avatar, user, tx + 85, ty + 62, 38);
    text(ctx, (user?.name || 'Guest').slice(0, 14), tx + 85, ty + 118, { size: 15, bold: true, align: 'center', color: C.text });
    text(ctx, 'ADMIT ONE', tx + 85, ty + 140, { size: 16, bold: true, align: 'center', color: C.gold2 });
    text(ctx, `No. ${ticketNo}`, tx + 85, ty + 160, { size: 12, align: 'center', color: C.muted });

    const mx = sx + 22;
    text(ctx, '★  MOVIE TICKET', mx, ty + 34, { size: 15, bold: true, color: C.gold2 });
    text(ctx, ellipsize(ctx, noEmoji(video?.name) || 'Untitled', 24, true, tw - 220), mx, ty + 66, { size: 24, bold: true, color: C.text });
    text(ctx, `${video?.category || 'Feature'} · ${fmtDur(video?.durationSeconds)}`, mx, ty + 92, { size: 14, color: C.muted });
    seatGlyph(ctx, mx, ty + 112, 26, 26, C.gold2);
    text(ctx, seat, mx + 38, ty + 133, { size: 19, bold: true, color: C.text });

    // shine sweep
    const shineX = tx + (t * (tw + 120)) - 60;
    const sh = ctx.createLinearGradient(shineX, 0, shineX + 60, 0);
    sh.addColorStop(0, 'rgba(255,255,255,0)');
    sh.addColorStop(0.5, 'rgba(255,255,255,0.10)');
    sh.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sh;
    ctx.fillRect(tx, ty, tw, th);

    ctx.restore();
  });
}

// ---- 3) POPCORN POP --------------------------------------------------------
export async function animPopcorn(user, { snack }) {
  const avatar = await loadRemote(user?.avatar);
  const N = 16;
  // deterministic kernel field so the loop is seamless
  const kernels = Array.from({ length: 22 }, (_, k) => ({
    x: 330 + ((k * 53) % 190),
    phase: (k / 22) * Math.PI * 2,
    amp: 55 + ((k * 37) % 60),
    r: 6 + (k % 3),
  }));

  return buildGif(N, 80, (ctx, i, t) => {
    bg(ctx);
    marquee(ctx, '★  CONCESSION STAND  ★');

    const boxX = 330, boxY = 120, boxW = 150, boxH = 140;
    // popping kernels (drawn behind the box top)
    ctx.fillStyle = C.gold2;
    for (const k of kernels) {
      const p = (Math.sin(k.phase + t * Math.PI * 2) + 1) / 2; // 0..1 loop
      const ky = boxY - p * k.amp;
      const s = 0.6 + p * 0.8;
      ctx.beginPath();
      ctx.arc(k.x, ky, k.r * s, 0, Math.PI * 2);
      ctx.fill();
    }
    // box (trapezoid, striped)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(boxX, boxY);
    ctx.lineTo(boxX + boxW, boxY);
    ctx.lineTo(boxX + boxW * 0.85, boxY + boxH);
    ctx.lineTo(boxX + boxW * 0.15, boxY + boxH);
    ctx.closePath();
    ctx.fillStyle = '#f4f4f8';
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = C.red2;
    const sw = boxW / 6;
    for (let s = 0; s < 7; s += 2) ctx.fillRect(boxX + s * sw, boxY, sw, boxH);
    ctx.restore();

    // soda cup
    ctx.fillStyle = C.red2;
    ctx.beginPath();
    ctx.moveTo(505, 140);
    ctx.lineTo(555, 140);
    ctx.lineTo(545, 260);
    ctx.lineTo(515, 260);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = C.gold2;
    ctx.fillRect(527, 105, 6, 45);

    // viewer
    drawAvatar(ctx, avatar, user, 150, 175, 48);
    text(ctx, `${(user?.name || 'You').slice(0, 16)} grabbed`, 150, 248, { size: 16, bold: true, align: 'center', color: C.text });
    text(ctx, noEmoji(snack), 150, 270, { size: 19, bold: true, align: 'center', color: C.gold2 });
  });
}

// ---- 4) TAKE A SEAT (drop in + lights dim) --------------------------------
export async function animSeated(user, video, { seat }) {
  const avatar = await loadRemote(user?.avatar);
  const poster = await loadRemote(video?.thumbnail);
  const N = 18;
  const delays = Array.from({ length: N }, (_, i) => (i >= N - 4 ? 450 : 70));

  const rows = 3, cols = 7;
  const startX = 90, startY = 175, gap = 66, sw = 40, sh = 34;
  const hi = { r: 1, c: 3 };

  return buildGif(N, delays, (ctx, i, t) => {
    bg(ctx);
    marquee(ctx, 'DARKNIGHT CINEMA');

    // screen with poster/title
    const px = 190, py = 40, pw = 260, ph = 96;
    if (poster) coverImage(ctx, poster, px, py, pw, ph);
    else {
      ctx.fillStyle = vGradient(ctx, px, py, pw, ph, '#2a2150', '#12101f');
      roundRect(ctx, px, py, pw, ph, 8);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(201,162,39,0.55)';
    ctx.lineWidth = 4;
    roundRect(ctx, px, py, pw, ph, 8);
    ctx.stroke();
    text(ctx, ellipsize(ctx, noEmoji(video?.name) || '', 16, true, 250), W / 2, 152, { size: 16, bold: true, align: 'center', color: C.gold2 });

    // seats
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        if (r === hi.r && col === hi.c) continue;
        seatGlyph(ctx, startX + col * gap, startY + r * 36, sw, sh, r === hi.r ? C.gold : C.panel2);
      }
    }
    // avatar drops into its seat
    const ax = startX + hi.c * gap + sw / 2;
    const ayFinal = startY + hi.r * 36 + sh / 2;
    const ay = ayFinal - (1 - easeOut(t)) * 150;
    drawAvatar(ctx, avatar, user, ax, ay, 26);

    // lights dim as they settle
    ctx.fillStyle = `rgba(0,0,0,${0.45 * easeOut(t)})`;
    ctx.fillRect(0, 26, W, H - 26);
    // spotlight on the seat
    const sg = ctx.createRadialGradient(ax, ayFinal, 8, ax, ayFinal, 90);
    sg.addColorStop(0, `rgba(255,220,140,${0.18 * easeOut(t)})`);
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, 26, W, H - 26);

    text(ctx, `Seated — ${seat}`, W / 2, 288, { size: 16, bold: true, align: 'center', color: C.text });
  });
}
