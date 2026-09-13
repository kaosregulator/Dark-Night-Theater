import GIFEncoder from "gifencoder";
import sharp from "sharp";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getCanvas } from "../../../animations/engine.js";
import { logger } from "../../../../lib/logger.js";
import { EmojiError } from "../../utils/errors.js";
import { offlinePackageRoot } from "./registry.js";
const SCENE_PREFIX = "scene:";
const FULL_MAX_FRAMES = 45;
const FULL_LONG_EDGE = 360;
const MIN_LONG_EDGE = 96;
const MAX_LONG_EDGE = 600;
let cache;
function scenesDir() {
  const root = offlinePackageRoot();
  if (!root) return null;
  const dir = join(root, "scenes");
  return existsSync(join(dir, "scenes.json")) ? dir : null;
}
function loadScenes() {
  if (cache !== void 0) return cache;
  const dir = scenesDir();
  if (!dir) {
    cache = null;
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "scenes.json"), "utf8"));
    const list = parsed.scenes.filter((s) => existsSync(join(dir, `${s.id}.gif`)));
    const byId = new Map(list.map((s) => [s.id, s]));
    cache = { list, byId, dir };
    return cache;
  } catch (err) {
    logger.warn({ err }, "scene catalog failed to load");
    cache = null;
    return null;
  }
}
function reloadScenes() {
  cache = void 0;
}
function sceneIdOf(animation) {
  if (!animation) return null;
  const id = animation.startsWith(SCENE_PREFIX) ? animation.slice(SCENE_PREFIX.length) : animation;
  return loadScenes()?.byId.has(id) ? id : null;
}
function sceneStyleEntries() {
  return loadScenes()?.list.map((s) => ({ value: `${SCENE_PREFIX}${s.id}`, label: s.label })) ?? [];
}
function isSceneAnimation(animation) {
  return sceneIdOf(animation) != null;
}
function sceneLabelOf(animation) {
  const id = sceneIdOf(animation);
  return id ? loadScenes()?.byId.get(id)?.label ?? id : null;
}
const isGreen = (r, g, b) => g > 90 && g - r > 40 && g - b > 40;
const isBlue = (r, g, b) => b > 110 && r < 120 && g < 130 && b - r > 60 && b - g > 55;
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const PREVIEW_LONG_EDGE = 120;
const PREVIEW_MAX_FRAMES = 10;
function sceneRenderOptions(opts = {}) {
  if (opts.preview) {
    return { longEdge: PREVIEW_LONG_EDGE, maxFrames: PREVIEW_MAX_FRAMES, quality: 12 };
  }
  const px = opts.size ? Number(/\d+/.exec(opts.size)?.[0] ?? NaN) : NaN;
  const longEdge = Number.isFinite(px) ? px : void 0;
  const rate = parseSpeedRate(opts.speed);
  const speedFactor = rate > 0 ? 1 / rate : 1;
  return { ...longEdge != null ? { longEdge } : {}, speedFactor };
}
function parseSpeedRate(speed) {
  if (!speed) return 1;
  if (/^normal$/i.test(speed.trim())) return 1;
  const n = Number(/(\d+(?:\.\d+)?)/.exec(speed)?.[1] ?? NaN);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
async function renderScene(image, id, opts = {}) {
  const scenes = loadScenes();
  const cfg = scenes?.byId.get(id.startsWith(SCENE_PREFIX) ? id.slice(SCENE_PREFIX.length) : id);
  if (!scenes || !cfg) throw new EmojiError("unknown_effect", `\`${id}\` is not a known scene.`);
  const mod = await getCanvas();
  if (!mod) throw new EmojiError("internal", "Canvas backend unavailable for scene rendering.");
  const target = await mod.loadImage(image);
  const key = cfg.chroma === "blue" ? isBlue : isGreen;
  const path = join(scenes.dir, `${cfg.id}.gif`);
  const src = await sharp(path, { animated: true }).metadata();
  const pages = src.pages ?? 1;
  const srcW = src.width ?? 1, srcH = src.pageHeight ?? src.height ?? 1;
  const delays = src.delay ?? [];
  const longEdge = Math.max(MIN_LONG_EDGE, Math.min(MAX_LONG_EDGE, opts.longEdge ?? FULL_LONG_EDGE));
  const scale = Math.min(1, longEdge / Math.max(srcW, srcH));
  const W = Math.max(1, Math.round(srcW * scale)), H = Math.max(1, Math.round(srcH * scale));
  const N = Math.min(pages, Math.max(1, opts.maxFrames ?? FULL_MAX_FRAMES));
  const pick = Array.from({ length: N }, (_, i) => Math.round(i * (pages - 1) / Math.max(1, N - 1)));
  const durationStretch = pages / N;
  const speedFactor = opts.speedFactor && opts.speedFactor > 0 ? opts.speedFactor : 1;
  const frameDelay = (base) => Math.max(20, Math.min(500, Math.round(base * durationStretch * speedFactor)));
  const stacked = await sharp(path, { animated: true }).resize({ width: W }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pageH = Math.round(stacked.info.height / pages);
  const frames = pick.map((p) => {
    const start = p * pageH * W * 4;
    return {
      data: stacked.data.subarray(start, start + pageH * W * 4),
      delay: frameDelay(delays[p] && delays[p] > 0 ? delays[p] : 80)
    };
  });
  const H2 = pageH;
  const boxes = [];
  const quads = [];
  for (const f of frames) {
    const d = f.data;
    let minX = W, minY = H2, maxX = -1, maxY = -1, cnt = 0;
    let tlS = Infinity, brS = -Infinity, trS = -Infinity, blS = Infinity;
    let tl = { x: 0, y: 0 }, tr = { x: 0, y: 0 }, br = { x: 0, y: 0 }, bl = { x: 0, y: 0 };
    for (let y = 0; y < H2; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!key(d[i], d[i + 1], d[i + 2])) continue;
      cnt++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const sum = x + y, diff = x - y;
      if (sum < tlS) {
        tlS = sum;
        tl = { x, y };
      }
      if (sum > brS) {
        brS = sum;
        br = { x, y };
      }
      if (diff > trS) {
        trS = diff;
        tr = { x, y };
      }
      if (diff < blS) {
        blS = diff;
        bl = { x, y };
      }
    }
    if (cnt < W * H2 * 4e-3) {
      boxes.push(null);
      quads.push(null);
      continue;
    }
    boxes.push({ x: minX, y: minY, w: maxX - minX, h: maxY - minY, absent: false });
    quads.push({ tl, tr, br, bl, absent: false });
  }
  const smooth = [];
  let last = null;
  for (const b of boxes) {
    if (!b) {
      smooth.push(last ? { ...last, absent: true } : null);
      continue;
    }
    if (!last) last = b;
    const a = 0.5;
    last = {
      x: last.x + (b.x - last.x) * a,
      y: last.y + (b.y - last.y) * a,
      w: last.w + (b.w - last.w) * a,
      h: last.h + (b.h - last.h) * a,
      absent: false
    };
    smooth.push({ ...last });
  }
  const smoothQuads = [];
  let lastQ = null;
  let fillSum = 0, fillCnt = 0;
  for (let i = 0; i < quads.length; i++) {
    const q = quads[i];
    if (!q) {
      smoothQuads.push(lastQ ? { ...lastQ, absent: true } : null);
      continue;
    }
    if (!lastQ) lastQ = q;
    const a = 0.5;
    lastQ = {
      tl: lerpPt(lastQ.tl, q.tl, a),
      tr: lerpPt(lastQ.tr, q.tr, a),
      br: lerpPt(lastQ.br, q.br, a),
      bl: lerpPt(lastQ.bl, q.bl, a),
      absent: false
    };
    smoothQuads.push({ ...lastQ });
    const box = boxes[i];
    if (box && box.w > 2 && box.h > 2) {
      fillSum += quadArea(q) / (box.w * box.h);
      fillCnt++;
    }
  }
  const rectangular = fillCnt > 0 && fillSum / fillCnt >= 0.72;
  // DN-cards original enables a two-triangle affine warp on rectangular chroma
  // holes. That warp leaves a faint diagonal "slash" seam through the photo
  // (mission-passed, Dexter locker, …). Keep everything else identical — only
  // force the axis-aligned cover/stretch + keyed FG path.
  const useWarp = false;
  let explodeStart = null;
  if (cfg.effect === "explode") {
    for (let k = 0; k < frames.length; k++) {
      const d = frames[k].data;
      let fire = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] > 80 && d[i + 1] < 190 && d[i + 2] < 90) fire++;
      if (fire > W * H2 * 0.02) {
        explodeStart = k;
        break;
      }
    }
  }
  let revealAt = 0;
  for (let i = 0; i < smooth.length; i++) {
    const s = smooth[i];
    if (s && !s.absent) {
      revealAt = i;
      break;
    }
  }
  const encoder = new GIFEncoder(W, H2);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setQuality(opts.quality ?? 10);
  const canvas = mod.createCanvas(W, H2);
  const ctx = canvas.getContext("2d");
  const fgCanvas = mod.createCanvas(W, H2);
  const fgctx = fgCanvas.getContext("2d");
  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f];
    const fg = new Uint8ClampedArray(frame.data);
    for (let i = 0; i < fg.length; i += 4) {
      if (key(fg[i], fg[i + 1], fg[i + 2])) fg[i + 3] = 0;
      else if (cfg.chroma === "green" && fg[i + 1] > fg[i] && fg[i + 1] > fg[i + 2]) fg[i + 1] = Math.max(fg[i], fg[i + 2]);
      else if (cfg.chroma === "blue" && fg[i + 2] > fg[i] && fg[i + 2] > fg[i + 1]) fg[i + 2] = Math.max(fg[i], fg[i + 1]);
    }
    ctx.clearRect(0, 0, W, H2);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H2);
    const box = smooth[f];
    const quad = smoothQuads[f];
    if (useWarp && quad && !quad.absent) {
      warpTargetToQuad(ctx, target, quad);
    } else if (box && !box.absent) {
      drawTarget(mod, ctx, target, box, cfg, f, frames.length, explodeStart, revealAt);
    }
    const fgId = fgctx.createImageData(W, H2);
    fgId.data.set(fg);
    fgctx.putImageData(fgId, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(fgCanvas, 0, 0);
    encoder.setDelay(frame.delay);
    encoder.addFrame(ctx);
  }
  encoder.finish();
  return encoder.out.getData();
}
function lerpPt(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
function quadArea(q) {
  const p = [q.tl, q.tr, q.br, q.bl];
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}
function affineFromTri(s, d) {
  const [s0, s1, s2] = s;
  const [d0, d1, d2] = d;
  const det = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(det) < 1e-6) return [1, 0, 0, 1, 0, 0];
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / det;
  const c = ((s1.x - s0.x) * (d2.x - d0.x) - (s2.x - s0.x) * (d1.x - d0.x)) / det;
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / det;
  const dd = ((s1.x - s0.x) * (d2.y - d0.y) - (s2.x - s0.x) * (d1.y - d0.y)) / det;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - dd * s0.y;
  return [a, b, c, dd, e, f];
}
function warpTargetToQuad(ctx, target, q) {
  const topW = Math.hypot(q.tr.x - q.tl.x, q.tr.y - q.tl.y);
  const botW = Math.hypot(q.br.x - q.bl.x, q.br.y - q.bl.y);
  const leftH = Math.hypot(q.bl.x - q.tl.x, q.bl.y - q.tl.y);
  const rightH = Math.hypot(q.br.x - q.tr.x, q.br.y - q.tr.y);
  const quadAspect = (topW + botW) / 2 / Math.max(1, (leftH + rightH) / 2);
  const iw = target.width, ih = target.height;
  let sw = iw, sh = ih;
  if (iw / ih > quadAspect) sw = ih * quadAspect;
  else sh = iw / quadAspect;
  const sx = (iw - sw) / 2, sy = (ih - sh) / 2;
  const s = [
    { x: sx, y: sy },
    { x: sx + sw, y: sy },
    { x: sx + sw, y: sy + sh },
    { x: sx, y: sy + sh }
  ];
  const d = [q.tl, q.tr, q.br, q.bl];
  for (const [i, j, k] of [[0, 1, 2], [0, 2, 3]]) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(d[i].x, d[i].y);
    ctx.lineTo(d[j].x, d[j].y);
    ctx.lineTo(d[k].x, d[k].y);
    ctx.closePath();
    ctx.clip();
    const [a, b, c, dd, e, ff] = affineFromTri([s[i], s[j], s[k]], [d[i], d[j], d[k]]);
    ctx.setTransform(a, b, c, dd, e, ff);
    ctx.drawImage(target, 0, 0);
    ctx.resetTransform();
    ctx.restore();
  }
}
function drawTarget(mod, ctx, target, box, cfg, idx, total, explodeStart, revealAt) {
  let tw, th, tx, ty;
  if (cfg.fit === "stretch") {
    tw = box.w;
    th = box.h;
    tx = box.x;
    ty = box.y;
  } else {
    const s = Math.max(box.w / target.width, box.h / target.height);
    tw = target.width * s;
    th = target.height * s;
    tx = box.x + (box.w - tw) / 2;
    ty = box.y + (box.h - th) / 2;
  }
  let alpha = 1, ox = 0, oy = 0, sc = 1;
  if (cfg.effect === "shake") {
    ox = 6 * Math.sin(idx * 0.9);
    oy = 4 * Math.cos(idx * 1.3);
  }
  if (cfg.effect === "punch") {
    ox = 11 * Math.sin(idx * 1.7);
    oy = 8 * Math.cos(idx * 2.3);
  }
  if (cfg.effect === "explode" && explodeStart != null && idx >= explodeStart) {
    const t = Math.min(1, (idx - explodeStart) / 8);
    sc = 1 + t * 0.7;
    alpha = 1 - t * 0.65;
    ox = Math.sin(idx * 7) * 18 * t;
    oy = Math.cos(idx * 5) * 18 * t;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  if (cfg.effect !== "explode") {
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
  }
  const cw = tw * sc, ch = th * sc;
  const dx = tx + ox - (cw - tw) / 2, dy = ty + oy - (ch - th) / 2;
  const chFlash = cfg.effect === "channel" && idx >= revealAt && idx < revealAt + 5;
  if (chFlash) {
    const r = mulberry(idx * 911);
    for (let s = 0; s < 900; s++) {
      const v = r() * 255 | 0;
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(box.x + r() * box.w, box.y + r() * box.h, 2, 2);
    }
  } else if (cfg.effect === "cut" || cfg.effect === "rip") {
    const prog = idx / (total - 1);
    const cutT = Math.max(0, Math.min(1, (prog - 0.5) / 0.4));
    const lw = Math.max(1, Math.round(dx + cw) + 4);
    const lh = Math.max(1, Math.round(dy + ch) + 4);
    const layer = mod.createCanvas(lw, lh);
    const lctx = layer.getContext("2d");
    lctx.drawImage(target, dx, dy, cw, ch);
    const midX = Math.round(box.x + box.w / 2);
    const gap = box.w * (cfg.effect === "rip" ? 0.06 : 0.16) * cutT;
    const tear = cfg.effect === "rip" ? box.h * 0.03 * cutT : 0;
    ctx.drawImage(layer, 0, 0, midX, lh, -gap / 2, -tear, midX, lh);
    ctx.drawImage(layer, midX, 0, lw - midX, lh, midX + gap / 2, tear, lw - midX, lh);
  } else {
    ctx.drawImage(target, dx, dy, cw, ch);
  }
  if (cfg.effect === "punch") {
    const r = mulberry(4242);
    const nSpl = Math.floor(4 + idx / (total - 1) * 26);
    for (let s = 0; s < nSpl; s++) {
      const px = box.x + r() * box.w, py = box.y + r() * box.h, rad = 3 + r() * 15;
      ctx.globalAlpha = (0.5 + r() * 0.45) * alpha;
      ctx.fillStyle = r() > 0.3 ? "#7a0b0b" : "#b01414";
      ctx.beginPath();
      ctx.ellipse(px, py, rad, rad * (0.6 + r() * 0.8), r() * 6, 0, 7);
      ctx.fill();
      if (r() > 0.7) ctx.fillRect(px - 1, py, 2 + r() * 2, rad + r() * 22);
    }
    ctx.globalAlpha = alpha;
  }
  if (cfg.effect === "fuzzytv" || cfg.effect === "channel" && !chFlash) {
    const r = mulberry(idx * 17 + 3);
    ctx.globalAlpha = (cfg.effect === "fuzzytv" ? 0.18 : 0.12) * alpha;
    for (let s = 0; s < 34; s++) {
      ctx.fillStyle = r() > 0.5 ? "#fff" : "#000";
      ctx.fillRect(box.x, box.y + r() * box.h, box.w, 1 + r() * 2);
    }
    ctx.globalAlpha = alpha;
  }
  ctx.restore();
}
export {
  SCENE_PREFIX,
  isSceneAnimation,
  loadScenes,
  reloadScenes,
  renderScene,
  sceneIdOf,
  sceneLabelOf,
  sceneRenderOptions,
  sceneStyleEntries
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic2NlbmUtcGFjay50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBTY2VuZSBwYWNrcyBcdTIwMTQgZ3JlZW4vYmx1ZS1zY3JlZW4gbWluaS1zY2VuZXMgZm9yIC9lbW9qaS5cbi8vXG4vLyBVbmxpa2UgdGhlIE1ha2VFbW9qaSBsYXllciBwYWNrcyAoYSBncmVlbiBzdWJqZWN0IHNpemVkIHRvIGEgc21hbGwgZW1vamkpLCBhXG4vLyBzY2VuZSBwYWNrIGlzIGEgd2hvbGUgY2xpcCB0aGF0IHBsYXlzIG91dCBhdCBpdHMgbmF0aXZlIHNpemU6IGEgbW92aWUgdGhlYXRlcixcbi8vIGFuIGV4cGxvc2lvbiwgYSBUViwgc29tZW9uZSBob2xkaW5nIGEgY2FyZC4gUGFydCBvZiB0aGUgZnJhbWUgaXMgYSBncmVlbiAob3Jcbi8vIGJsdWUpIHNjcmVlbjsgdGhlIHVzZXIncyB0YXJnZXQgaW1hZ2UgaXMgY29tcG9zaXRlZCBJTlRPIHRoYXQgcmVnaW9uIGFuZCB0aGVcbi8vIHJlc3Qgb2YgdGhlIHNjZW5lIFx1MjAxNCBhY3RvcnMsIHRleHQsIGVmZmVjdHMgXHUyMDE0IHN0YXlzIG9uIHRvcC4gTm90aGluZyBpcyBjcm9wcGVkO1xuLy8gdGhlIHdob2xlIHNjZW5lIHBsYXlzLlxuLy9cbi8vIFBpcGVsaW5lIHBlciBmcmFtZTpcbi8vICAgMSkgZGVjb2RlIHRoZSBzb3VyY2UgZnJhbWUgKGdpZnVjdClcbi8vICAgMikga2V5IHRoZSBjaHJvbWEgdG8gdHJhbnNwYXJlbnQgIFx1MjE5MiB0aGF0J3MgdGhlIGZvcmVncm91bmQgY2hyb21lXG4vLyAgIDMpIGZpdCB0aGUgdGFyZ2V0IGludG8gdGhlIGNocm9tYSByZWdpb24ncyBwZXItZnJhbWUgYmJveCAodHJhY2tzIHpvb20vcGFuKVxuLy8gICA0KSBkcmF3IHRhcmdldCBiZWhpbmQsIGZvcmVncm91bmQgb24gdG9wLCBwbHVzIHRoZSBzdHlsZSdzIGVmZmVjdFxuLy9cbi8vIEVmZmVjdHMgbGF5ZXIgZXh0cmEgbW90aW9uIG9uIHRoZSBUQVJHRVQ6IGV4cGxvZGUsIHNoYWtlLCBjdXQsIHJpcCwgcHVuY2hcbi8vICgrIGZha2UgYmxvb2QpLCBjaGFubmVsIChUVi1zdGF0aWMgcmV2ZWFsKSwgZnV6enl0diAoc3RhdGljIG92ZXJsYXkpLlxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmltcG9ydCBHSUZFbmNvZGVyIGZyb20gXCJnaWZlbmNvZGVyXCI7XG5pbXBvcnQgc2hhcnAgZnJvbSBcInNoYXJwXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGdldENhbnZhcywgdHlwZSBDYW52YXNNb2QgfSBmcm9tIFwiLi4vLi4vLi4vYW5pbWF0aW9ucy9lbmdpbmUuanNcIjtcbmltcG9ydCB7IGxvZ2dlciB9IGZyb20gXCIuLi8uLi8uLi8uLi9saWIvbG9nZ2VyLmpzXCI7XG5pbXBvcnQgeyBFbW9qaUVycm9yIH0gZnJvbSBcIi4uLy4uL3V0aWxzL2Vycm9ycy5qc1wiO1xuaW1wb3J0IHsgb2ZmbGluZVBhY2thZ2VSb290IH0gZnJvbSBcIi4vcmVnaXN0cnkuanNcIjtcblxuZXhwb3J0IHR5cGUgU2NlbmVDaHJvbWEgPSBcImdyZWVuXCIgfCBcImJsdWVcIjtcbmV4cG9ydCB0eXBlIFNjZW5lRWZmZWN0ID1cbiAgfCBcIm5vbmVcIiB8IFwiZXhwbG9kZVwiIHwgXCJzaGFrZVwiIHwgXCJmdXp6eXR2XCIgfCBcImN1dFwiIHwgXCJyaXBcIiB8IFwicHVuY2hcIiB8IFwiY2hhbm5lbFwiO1xuZXhwb3J0IHR5cGUgU2NlbmVGaXQgPSBcImNvdmVyXCIgfCBcInN0cmV0Y2hcIjtcblxuZXhwb3J0IGludGVyZmFjZSBTY2VuZUNvbmZpZyB7XG4gIGlkOiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIGNocm9tYTogU2NlbmVDaHJvbWE7XG4gIGVmZmVjdDogU2NlbmVFZmZlY3Q7XG4gIGZpdDogU2NlbmVGaXQ7XG59XG5cbmludGVyZmFjZSBTY2VuZXNGaWxlIHsgc2NlbmVzOiBTY2VuZUNvbmZpZ1tdIH1cblxuLyoqIFZhbHVlIHByZWZpeCB0aGF0IG1hcmtzIGEgc3R5bGUgYXMgYSBzY2VuZSBwYWNrICh2cyBhIE1ha2VFbW9qaSBzdHlsZSkuICovXG5leHBvcnQgY29uc3QgU0NFTkVfUFJFRklYID0gXCJzY2VuZTpcIjtcblxuLyoqXG4gKiBEZWZhdWx0IGZyYW1lIGNlaWxpbmcgd2hlbiB0aGUgY2FsbGVyIGRvZXNuJ3QgYXNrIGZvciBhIGxpZ2h0ZXIgcHJldmlldy5cbiAqIEtlcHQgaGlnaCBzbyBmYXN0LCBoaWdoLWRldGFpbCBjbGlwcyAoVFYgc3RhdGljLCBleHBsb3Npb25zKSBkb24ndCB2aXNpYmx5XG4gKiBza2lwIFx1MjAxNCB3ZSBzdWJzYW1wbGUgb25seSB3aGVuIHRoZSBzb3VyY2UgaGFzIG1vcmUgZnJhbWVzIHRoYW4gdGhpcywgYW5kIGVhY2hcbiAqIGtlcHQgZnJhbWUncyBkZWxheSBpcyBzdHJldGNoZWQgdG8gcHJlc2VydmUgdGhlIGNsaXAncyByZWFsIGR1cmF0aW9uLlxuICovXG5jb25zdCBGVUxMX01BWF9GUkFNRVMgPSA0NTtcbi8qKlxuICogRGVmYXVsdCBsb25nIGVkZ2UuIENhbGxlcnMgY2FuIG92ZXJyaWRlICh0aGUgU2l6ZSBjb250cm9sKTsgdGhpcyBpcyB0aGUgdmFsdWVcbiAqIHVzZWQgd2hlbiBub25lIGlzIGdpdmVuLiBDYXBwZWQgbm90IHRvIGNyb3AgKG5vdGhpbmcgaXMgY3JvcHBlZCkgYnV0IHRvIGtlZXBcbiAqIHRoZSB3aG9sZS1zY2VuZSBHSUYgYSByZWFzb25hYmxlIHNpemUgdG8gc2hhcmUgXHUyMDE0IDM2MHB4IHJlYWRzIGNyaXNwIGF0IERpc2NvcmQnc1xuICogZGlzcGxheSBzaXplIHdoaWxlIGtlZXBpbmcgZmlsZXMgcm91Z2hseSBoYWxmIG9mIGEgNjAwcHggcmVuZGVyLlxuICovXG5jb25zdCBGVUxMX0xPTkdfRURHRSA9IDM2MDtcbi8qKiBDbGFtcCBmb3IgYSB1c2VyLXJlcXVlc3RlZCBvdXRwdXQgbG9uZyBlZGdlIChrZWVwcyBHSUZzIHVuZGVyIERpc2NvcmQncyBjYXApLiAqL1xuY29uc3QgTUlOX0xPTkdfRURHRSA9IDk2O1xuY29uc3QgTUFYX0xPTkdfRURHRSA9IDYwMDtcblxubGV0IGNhY2hlOiB7IGxpc3Q6IFNjZW5lQ29uZmlnW107IGJ5SWQ6IE1hcDxzdHJpbmcsIFNjZW5lQ29uZmlnPjsgZGlyOiBzdHJpbmcgfSB8IG51bGwgfCB1bmRlZmluZWQ7XG5cbi8qKiBEaXJlY3RvcnkgaG9sZGluZyB0aGUgc2NlbmUgR0lGcyArIHNjZW5lcy5qc29uLCBvciBudWxsIHdoZW4gdW5hdmFpbGFibGUuICovXG5mdW5jdGlvbiBzY2VuZXNEaXIoKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IHJvb3QgPSBvZmZsaW5lUGFja2FnZVJvb3QoKTtcbiAgaWYgKCFyb290KSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZGlyID0gam9pbihyb290LCBcInNjZW5lc1wiKTtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihkaXIsIFwic2NlbmVzLmpzb25cIikpID8gZGlyIDogbnVsbDtcbn1cblxuLyoqIExvYWQgYW5kIGNhY2hlIHRoZSBzY2VuZSBjYXRhbG9nLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvYWRTY2VuZXMoKTogeyBsaXN0OiBTY2VuZUNvbmZpZ1tdOyBieUlkOiBNYXA8c3RyaW5nLCBTY2VuZUNvbmZpZz47IGRpcjogc3RyaW5nIH0gfCBudWxsIHtcbiAgaWYgKGNhY2hlICE9PSB1bmRlZmluZWQpIHJldHVybiBjYWNoZTtcbiAgY29uc3QgZGlyID0gc2NlbmVzRGlyKCk7XG4gIGlmICghZGlyKSB7IGNhY2hlID0gbnVsbDsgcmV0dXJuIG51bGw7IH1cbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhqb2luKGRpciwgXCJzY2VuZXMuanNvblwiKSwgXCJ1dGY4XCIpKSBhcyBTY2VuZXNGaWxlO1xuICAgIGNvbnN0IGxpc3QgPSBwYXJzZWQuc2NlbmVzLmZpbHRlcihzID0+IGV4aXN0c1N5bmMoam9pbihkaXIsIGAke3MuaWR9LmdpZmApKSk7XG4gICAgY29uc3QgYnlJZCA9IG5ldyBNYXAobGlzdC5tYXAocyA9PiBbcy5pZCwgc10pKTtcbiAgICBjYWNoZSA9IHsgbGlzdCwgYnlJZCwgZGlyIH07XG4gICAgcmV0dXJuIGNhY2hlO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dnZXIud2Fybih7IGVyciB9LCBcInNjZW5lIGNhdGFsb2cgZmFpbGVkIHRvIGxvYWRcIik7XG4gICAgY2FjaGUgPSBudWxsO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKiBUZXN0L3JlbG9hZCBoZWxwZXIuICovXG5leHBvcnQgZnVuY3Rpb24gcmVsb2FkU2NlbmVzKCk6IHZvaWQgeyBjYWNoZSA9IHVuZGVmaW5lZDsgfVxuXG4vKiogVGhlIHNjZW5lIGlkIGZvciBhbiBhbmltYXRpb24gdmFsdWUsIG9yIG51bGwgd2hlbiBpdCBpc24ndCBhIHNjZW5lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjZW5lSWRPZihhbmltYXRpb246IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWFuaW1hdGlvbikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGlkID0gYW5pbWF0aW9uLnN0YXJ0c1dpdGgoU0NFTkVfUFJFRklYKSA/IGFuaW1hdGlvbi5zbGljZShTQ0VORV9QUkVGSVgubGVuZ3RoKSA6IGFuaW1hdGlvbjtcbiAgcmV0dXJuIGxvYWRTY2VuZXMoKT8uYnlJZC5oYXMoaWQpID8gaWQgOiBudWxsO1xufVxuXG4vKiogRXZlcnkgc2NlbmUgYXMgYHsgdmFsdWU6IFwic2NlbmU6PGlkPlwiLCBsYWJlbCB9YCwgaW4gZmVhdHVyZWQgb3JkZXIuICovXG5leHBvcnQgZnVuY3Rpb24gc2NlbmVTdHlsZUVudHJpZXMoKTogeyB2YWx1ZTogc3RyaW5nOyBsYWJlbDogc3RyaW5nIH1bXSB7XG4gIHJldHVybiBsb2FkU2NlbmVzKCk/Lmxpc3QubWFwKHMgPT4gKHsgdmFsdWU6IGAke1NDRU5FX1BSRUZJWH0ke3MuaWR9YCwgbGFiZWw6IHMubGFiZWwgfSkpID8/IFtdO1xufVxuXG4vKiogVHJ1ZSB3aGVuIGFuIGFuaW1hdGlvbiB2YWx1ZSByZWZlcnMgdG8gYSBzY2VuZSBwYWNrLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU2NlbmVBbmltYXRpb24oYW5pbWF0aW9uOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIHNjZW5lSWRPZihhbmltYXRpb24pICE9IG51bGw7XG59XG5cbi8qKiBGcmllbmRseSBsYWJlbCBmb3IgYSBzY2VuZSBhbmltYXRpb24gdmFsdWUsIG9yIG51bGwgd2hlbiBpdCBpc24ndCBhIHNjZW5lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjZW5lTGFiZWxPZihhbmltYXRpb246IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBpZCA9IHNjZW5lSWRPZihhbmltYXRpb24pO1xuICByZXR1cm4gaWQgPyAobG9hZFNjZW5lcygpPy5ieUlkLmdldChpZCk/LmxhYmVsID8/IGlkKSA6IG51bGw7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBDaHJvbWEga2V5cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmNvbnN0IGlzR3JlZW4gPSAocjogbnVtYmVyLCBnOiBudW1iZXIsIGI6IG51bWJlcikgPT4gZyA+IDkwICYmIGcgLSByID4gNDAgJiYgZyAtIGIgPiA0MDtcbi8vIFNhdHVyYXRlZCBzY3JlZW4gYmx1ZSBvbmx5IFx1MjAxNCBwYWxlIHNreS9jbG91ZCBibHVlIGhhcyBoaWdoIFIgYW5kIEcuXG5jb25zdCBpc0JsdWUgPSAocjogbnVtYmVyLCBnOiBudW1iZXIsIGI6IG51bWJlcikgPT4gYiA+IDExMCAmJiByIDwgMTIwICYmIGcgPCAxMzAgJiYgYiAtIHIgPiA2MCAmJiBiIC0gZyA+IDU1O1xuXG5pbnRlcmZhY2UgQ3R4MkQge1xuICBmaWxsU3R5bGU6IHN0cmluZzsgZ2xvYmFsQWxwaGE6IG51bWJlcjsgZm9udDogc3RyaW5nOyB0ZXh0QWxpZ246IHN0cmluZzsgdGV4dEJhc2VsaW5lOiBzdHJpbmc7XG4gIGNsZWFyUmVjdCh4OiBudW1iZXIsIHk6IG51bWJlciwgdzogbnVtYmVyLCBoOiBudW1iZXIpOiB2b2lkO1xuICBmaWxsUmVjdCh4OiBudW1iZXIsIHk6IG51bWJlciwgdzogbnVtYmVyLCBoOiBudW1iZXIpOiB2b2lkO1xuICBjcmVhdGVJbWFnZURhdGEodzogbnVtYmVyLCBoOiBudW1iZXIpOiB7IGRhdGE6IFVpbnQ4Q2xhbXBlZEFycmF5IH07XG4gIHB1dEltYWdlRGF0YShkOiB7IGRhdGE6IFVpbnQ4Q2xhbXBlZEFycmF5IH0sIHg6IG51bWJlciwgeTogbnVtYmVyKTogdm9pZDtcbiAgZ2V0SW1hZ2VEYXRhKHg6IG51bWJlciwgeTogbnVtYmVyLCB3OiBudW1iZXIsIGg6IG51bWJlcik6IHsgZGF0YTogVWludDhDbGFtcGVkQXJyYXkgfTtcbiAgZHJhd0ltYWdlKGltZzogdW5rbm93biwgLi4uYTogbnVtYmVyW10pOiB2b2lkO1xuICBzYXZlKCk6IHZvaWQ7IHJlc3RvcmUoKTogdm9pZDtcbiAgYmVnaW5QYXRoKCk6IHZvaWQ7IGVsbGlwc2UoeDogbnVtYmVyLCB5OiBudW1iZXIsIHJ4OiBudW1iZXIsIHJ5OiBudW1iZXIsIHJvdDogbnVtYmVyLCBzOiBudW1iZXIsIGU6IG51bWJlcik6IHZvaWQ7IGZpbGwoKTogdm9pZDtcbiAgcmVjdCh4OiBudW1iZXIsIHk6IG51bWJlciwgdzogbnVtYmVyLCBoOiBudW1iZXIpOiB2b2lkOyBjbGlwKCk6IHZvaWQ7XG4gIG1vdmVUbyh4OiBudW1iZXIsIHk6IG51bWJlcik6IHZvaWQ7IGxpbmVUbyh4OiBudW1iZXIsIHk6IG51bWJlcik6IHZvaWQ7IGNsb3NlUGF0aCgpOiB2b2lkO1xuICBzZXRUcmFuc2Zvcm0oYTogbnVtYmVyLCBiOiBudW1iZXIsIGM6IG51bWJlciwgZDogbnVtYmVyLCBlOiBudW1iZXIsIGY6IG51bWJlcik6IHZvaWQ7XG4gIHJlc2V0VHJhbnNmb3JtKCk6IHZvaWQ7XG59XG5cbmludGVyZmFjZSBQdCB7IHg6IG51bWJlcjsgeTogbnVtYmVyIH1cbi8qKiBGb3VyIHRyYWNrZWQgY29ybmVycyBvZiB0aGUgY2hyb21hIHJlZ2lvbiAoY2xvY2t3aXNlIGZyb20gdG9wLWxlZnQpLiAqL1xuaW50ZXJmYWNlIFF1YWQgeyB0bDogUHQ7IHRyOiBQdDsgYnI6IFB0OyBibDogUHQ7IGFic2VudDogYm9vbGVhbiB9XG5cbmludGVyZmFjZSBGcmFtZSB7IGRhdGE6IFVpbnQ4Q2xhbXBlZEFycmF5OyBkZWxheTogbnVtYmVyIH1cblxuaW50ZXJmYWNlIEJveCB7IHg6IG51bWJlcjsgeTogbnVtYmVyOyB3OiBudW1iZXI7IGg6IG51bWJlcjsgYWJzZW50OiBib29sZWFuIH1cblxuLyoqIFNlZWRlZCBSTkcgc28gYmxvb2Qvc3RhdGljIGFyZSBzdGFibGUgcGVyIGZyYW1lIGJ1dCBhY2N1bXVsYXRlLiAqL1xuZnVuY3Rpb24gbXVsYmVycnkoc2VlZDogbnVtYmVyKTogKCkgPT4gbnVtYmVyIHtcbiAgbGV0IGEgPSBzZWVkID4+PiAwO1xuICByZXR1cm4gKCkgPT4ge1xuICAgIGEgfD0gMDsgYSA9IChhICsgMHg2RDJCNzlGNSkgfCAwO1xuICAgIGxldCB0ID0gTWF0aC5pbXVsKGEgXiAoYSA+Pj4gMTUpLCAxIHwgYSk7XG4gICAgdCA9ICh0ICsgTWF0aC5pbXVsKHQgXiAodCA+Pj4gNyksIDYxIHwgdCkpIF4gdDtcbiAgICByZXR1cm4gKCh0IF4gKHQgPj4+IDE0KSkgPj4+IDApIC8gNDI5NDk2NzI5NjtcbiAgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZW5kZXJTY2VuZU9wdGlvbnMge1xuICAvKipcbiAgICogT3V0cHV0IGxvbmcgZWRnZSBpbiBweC4gQ2xhbXBlZCB0byBbTUlOX0xPTkdfRURHRSwgTUFYX0xPTkdfRURHRV07IG9taXR0ZWQgPVxuICAgKiBGVUxMX0xPTkdfRURHRS4gVGhpcyBpcyB3aGF0IHRoZSB1c2VyJ3MgU2l6ZSBjb250cm9sIGRyaXZlcyBcdTIwMTQgZ2VudWluZWx5IGFcbiAgICogYmlnZ2VyIG9yIHNtYWxsZXIgZmluYWwgR0lGLlxuICAgKi9cbiAgbG9uZ0VkZ2U/OiBudW1iZXI7XG4gIC8qKiBNYXggZnJhbWVzIGtlcHQgZnJvbSB0aGUgc291cmNlIGNsaXA7IG9taXR0ZWQgPSBGVUxMX01BWF9GUkFNRVMuICovXG4gIG1heEZyYW1lcz86IG51bWJlcjtcbiAgLyoqIEdJRiBlbmNvZGVyIHF1YWxpdHkgKGxvd2VyID0gYmV0dGVyKTsgb21pdHRlZCA9IDEwLiAqL1xuICBxdWFsaXR5PzogbnVtYmVyO1xuICAvKipcbiAgICogUGxheWJhY2stZGVsYXkgbXVsdGlwbGllciBmcm9tIHRoZSBTcGVlZCBjb250cm9sLiAxID0gdGhlIGNsaXAncyBvd24gdGltaW5nLFxuICAgKiA+MSA9IHRydWx5IHNsb3dlciAoZWFjaCBmcmFtZSBoZWxkIGxvbmdlciksIDwxID0gZmFzdGVyLiBBcHBsaWVkIG9uIHRvcCBvZlxuICAgKiB0aGUgZHVyYXRpb24tcHJlc2VydmluZyBzdWJzYW1wbGUgY29ycmVjdGlvbi5cbiAgICovXG4gIHNwZWVkRmFjdG9yPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIEJvYXJkIHRodW1ibmFpbCBlZGdlICsgZnJhbWUgYnVkZ2V0IGZvciBhIHByZXZpZXcgcmVuZGVyLiBLZXB0IHNtYWxsOiB0aGUgYm9hcmRcbiAqIGNlbGwgZHJhd3MgdGhlc2UgYXQgfjEwNHB4IGFuZCBzdWJzYW1wbGVzIHRvIH4xNCBmcmFtZXMsIHNvIGEgMTIwcHggLyAxMC1mcmFtZVxuICogc2NlbmUgdGh1bWIgbG9va3MgaWRlbnRpY2FsIHRoZXJlIHdoaWxlIGRlY29kaW5nIG1hcmtlZGx5IGZhc3Rlci5cbiAqL1xuY29uc3QgUFJFVklFV19MT05HX0VER0UgPSAxMjA7XG5jb25zdCBQUkVWSUVXX01BWF9GUkFNRVMgPSAxMDtcblxuLyoqXG4gKiBUcmFuc2xhdGUgdGhlIC9lbW9qaSBTaXplICsgU3BlZWQgY29udHJvbHMgKE1ha2VFbW9qaSdzIG93biB2b2NhYnVsYXJ5LCBlLmcuXG4gKiBgXCJcdTJCMUMgMjU2cHhcImAgYW5kIGBcIjJ4XCJgKSBpbnRvIGNvbmNyZXRlIHNjZW5lIHJlbmRlciBvcHRpb25zLlxuICpcbiAqIC0gYHByZXZpZXdgIChib2FyZC9ob3ZlciB0aHVtYm5haWxzKSBmb3JjZXMgYSBzbWFsbCwgZmV3LWZyYW1lIHJlbmRlciBhbmRcbiAqICAgaWdub3JlcyB0aGUgdXNlciBjb250cm9scyBcdTIwMTQgdGhvc2Ugb25seSBzaGFwZSB0aGUgZmluYWwgcmVzdWx0LlxuICogLSBTaXplIHNldHMgdGhlIG91dHB1dCBsb25nIGVkZ2UsIHNvIGEgYmlnZ2VyIHB4IGNob2ljZSBpcyBhIGdlbnVpbmVseSBiaWdnZXJcbiAqICAgR0lGIChjbGFtcGVkIHRvIGtlZXAgaXQgc2hhcmVhYmxlKS5cbiAqIC0gU3BlZWQgc2NhbGVzIHBsYXliYWNrOiBgXCIyeFwiYCBwbGF5cyB0d2ljZSBhcyBmYXN0IChkZWxheXMgXHUwMEQ3IFx1MDBCRCksIGBcIjAuNXhcImBcbiAqICAgdHJ1bHkgc2xvd2VyIChkZWxheXMgXHUwMEQ3IDIpLCBgXCJOb3JtYWxcImAga2VlcHMgdGhlIGNsaXAncyBvd24gdGltaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NlbmVSZW5kZXJPcHRpb25zKFxuICBvcHRzOiB7IHNpemU/OiBzdHJpbmc7IHNwZWVkPzogc3RyaW5nOyBwcmV2aWV3PzogYm9vbGVhbiB9ID0ge30sXG4pOiBSZW5kZXJTY2VuZU9wdGlvbnMge1xuICBpZiAob3B0cy5wcmV2aWV3KSB7XG4gICAgcmV0dXJuIHsgbG9uZ0VkZ2U6IFBSRVZJRVdfTE9OR19FREdFLCBtYXhGcmFtZXM6IFBSRVZJRVdfTUFYX0ZSQU1FUywgcXVhbGl0eTogMTIgfTtcbiAgfVxuICBjb25zdCBweCA9IG9wdHMuc2l6ZSA/IE51bWJlcigvXFxkKy8uZXhlYyhvcHRzLnNpemUpPy5bMF0gPz8gTmFOKSA6IE5hTjtcbiAgY29uc3QgbG9uZ0VkZ2UgPSBOdW1iZXIuaXNGaW5pdGUocHgpID8gcHggOiB1bmRlZmluZWQ7XG4gIGNvbnN0IHJhdGUgPSBwYXJzZVNwZWVkUmF0ZShvcHRzLnNwZWVkKTtcbiAgY29uc3Qgc3BlZWRGYWN0b3IgPSByYXRlID4gMCA/IDEgLyByYXRlIDogMTtcbiAgcmV0dXJuIHsgLi4uKGxvbmdFZGdlICE9IG51bGwgPyB7IGxvbmdFZGdlIH0gOiB7fSksIHNwZWVkRmFjdG9yIH07XG59XG5cbi8qKiBQbGF5YmFjayByYXRlIGZyb20gYSBNYWtlRW1vamkgc3BlZWQgdmFsdWU6IGBcIk5vcm1hbFwiYFx1MjE5MjEsIGBcIjJ4XCJgXHUyMTkyMiwgYFwiMC41eFwiYFx1MjE5MjAuNS4gKi9cbmZ1bmN0aW9uIHBhcnNlU3BlZWRSYXRlKHNwZWVkPzogc3RyaW5nKTogbnVtYmVyIHtcbiAgaWYgKCFzcGVlZCkgcmV0dXJuIDE7XG4gIGlmICgvXm5vcm1hbCQvaS50ZXN0KHNwZWVkLnRyaW0oKSkpIHJldHVybiAxO1xuICBjb25zdCBuID0gTnVtYmVyKC8oXFxkKyg/OlxcLlxcZCspPykvLmV4ZWMoc3BlZWQpPy5bMV0gPz8gTmFOKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiAxO1xufVxuXG4vKipcbiAqIENvbXBvc2l0ZSBgaW1hZ2VgIGludG8gc2NlbmUgYGlkYCwgcmV0dXJuaW5nIGFuIGFuaW1hdGVkIEdJRi4gRnVsbCBuYXRpdmUgc2l6ZVxuICogYnkgZGVmYXVsdDsgYSBzbWFsbGVyLCBmZXdlci1mcmFtZWQgcHJldmlldyB3aGVuIGEgc21hbGwgYGxvbmdFZGdlYC9gbWF4RnJhbWVzYFxuICogaXMgZ2l2ZW4gKHRoZSBib2FyZCkuIGBzcGVlZEZhY3RvcmAgc2NhbGVzIHBsYXliYWNrIGZvciB0aGUgU3BlZWQgY29udHJvbC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlbmRlclNjZW5lKFxuICBpbWFnZTogQnVmZmVyLCBpZDogc3RyaW5nLCBvcHRzOiBSZW5kZXJTY2VuZU9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8QnVmZmVyPiB7XG4gIGNvbnN0IHNjZW5lcyA9IGxvYWRTY2VuZXMoKTtcbiAgY29uc3QgY2ZnID0gc2NlbmVzPy5ieUlkLmdldChpZC5zdGFydHNXaXRoKFNDRU5FX1BSRUZJWCkgPyBpZC5zbGljZShTQ0VORV9QUkVGSVgubGVuZ3RoKSA6IGlkKTtcbiAgaWYgKCFzY2VuZXMgfHwgIWNmZykgdGhyb3cgbmV3IEVtb2ppRXJyb3IoXCJ1bmtub3duX2VmZmVjdFwiLCBgXFxgJHtpZH1cXGAgaXMgbm90IGEga25vd24gc2NlbmUuYCk7XG5cbiAgY29uc3QgbW9kID0gYXdhaXQgZ2V0Q2FudmFzKCk7XG4gIGlmICghbW9kKSB0aHJvdyBuZXcgRW1vamlFcnJvcihcImludGVybmFsXCIsIFwiQ2FudmFzIGJhY2tlbmQgdW5hdmFpbGFibGUgZm9yIHNjZW5lIHJlbmRlcmluZy5cIik7XG5cbiAgY29uc3QgdGFyZ2V0ID0gYXdhaXQgbW9kLmxvYWRJbWFnZShpbWFnZSk7XG4gIGNvbnN0IGtleSA9IGNmZy5jaHJvbWEgPT09IFwiYmx1ZVwiID8gaXNCbHVlIDogaXNHcmVlbjtcblxuICAvLyBFeHRyYWN0IG9ubHkgdGhlIGZyYW1lcyB3ZSBuZWVkLCBhbHJlYWR5IHNjYWxlZCB0byB0aGUgb3V0cHV0IHNpemUsIGluIGFcbiAgLy8gc2luZ2xlIG5hdGl2ZSAoc2hhcnApIGRlY29kZSBcdTIwMTQgZmFyIGNoZWFwZXIgdGhhbiBjb21wb3NpdGluZyBldmVyeSBzb3VyY2VcbiAgLy8gZnJhbWUgYXQgZnVsbCByZXNvbHV0aW9uLlxuICBjb25zdCBwYXRoID0gam9pbihzY2VuZXMuZGlyLCBgJHtjZmcuaWR9LmdpZmApO1xuICBjb25zdCBzcmMgPSBhd2FpdCBzaGFycChwYXRoLCB7IGFuaW1hdGVkOiB0cnVlIH0pLm1ldGFkYXRhKCk7XG4gIGNvbnN0IHBhZ2VzID0gc3JjLnBhZ2VzID8/IDE7XG4gIGNvbnN0IHNyY1cgPSBzcmMud2lkdGggPz8gMSwgc3JjSCA9IHNyYy5wYWdlSGVpZ2h0ID8/IHNyYy5oZWlnaHQgPz8gMTtcbiAgY29uc3QgZGVsYXlzID0gKHNyYy5kZWxheSA/PyBbXSkgYXMgbnVtYmVyW107XG5cbiAgY29uc3QgbG9uZ0VkZ2UgPSBNYXRoLm1heChNSU5fTE9OR19FREdFLCBNYXRoLm1pbihNQVhfTE9OR19FREdFLCBvcHRzLmxvbmdFZGdlID8/IEZVTExfTE9OR19FREdFKSk7XG4gIGNvbnN0IHNjYWxlID0gTWF0aC5taW4oMSwgbG9uZ0VkZ2UgLyBNYXRoLm1heChzcmNXLCBzcmNIKSk7XG4gIGNvbnN0IFcgPSBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKHNyY1cgKiBzY2FsZSkpLCBIID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChzcmNIICogc2NhbGUpKTtcbiAgY29uc3QgTiA9IE1hdGgubWluKHBhZ2VzLCBNYXRoLm1heCgxLCBvcHRzLm1heEZyYW1lcyA/PyBGVUxMX01BWF9GUkFNRVMpKTtcbiAgY29uc3QgcGljayA9IEFycmF5LmZyb20oeyBsZW5ndGg6IE4gfSwgKF8sIGkpID0+IE1hdGgucm91bmQoaSAqIChwYWdlcyAtIDEpIC8gKE1hdGgubWF4KDEsIE4gLSAxKSkpKTtcbiAgLy8gV2Uga2VlcCBvbmx5IE4gb2YgYHBhZ2VzYCBmcmFtZXMgYnV0IG11c3Qgc3RpbGwgcGxheSBmb3IgdGhlIGNsaXAncyBvcmlnaW5hbFxuICAvLyBkdXJhdGlvbiwgc28gZWFjaCBrZXB0IGZyYW1lJ3MgZGVsYXkgaXMgc3RyZXRjaGVkIGJ5IHBhZ2VzL04uIFRoZSBTcGVlZFxuICAvLyBjb250cm9sIHRoZW4gc2NhbGVzIHRoYXQ6ID4xIHNsb3dlciwgPDEgZmFzdGVyLiBDbGFtcCB0byBhIHNhbmUgR0lGIHJhbmdlLlxuICBjb25zdCBkdXJhdGlvblN0cmV0Y2ggPSBwYWdlcyAvIE47XG4gIGNvbnN0IHNwZWVkRmFjdG9yID0gb3B0cy5zcGVlZEZhY3RvciAmJiBvcHRzLnNwZWVkRmFjdG9yID4gMCA/IG9wdHMuc3BlZWRGYWN0b3IgOiAxO1xuICBjb25zdCBmcmFtZURlbGF5ID0gKGJhc2U6IG51bWJlcik6IG51bWJlciA9PlxuICAgIE1hdGgubWF4KDIwLCBNYXRoLm1pbig1MDAsIE1hdGgucm91bmQoYmFzZSAqIGR1cmF0aW9uU3RyZXRjaCAqIHNwZWVkRmFjdG9yKSkpO1xuXG4gIC8vIE9uZSBkZWNvZGU6IHRoZSB3aG9sZSBhbmltYXRpb24gcmVzaXplZCB0byB3aWR0aCBXLCBwYWdlcyBzdGFja2VkIHZlcnRpY2FsbHkuXG4gIGNvbnN0IHN0YWNrZWQgPSBhd2FpdCBzaGFycChwYXRoLCB7IGFuaW1hdGVkOiB0cnVlIH0pXG4gICAgLnJlc2l6ZSh7IHdpZHRoOiBXIH0pLmVuc3VyZUFscGhhKCkucmF3KCkudG9CdWZmZXIoeyByZXNvbHZlV2l0aE9iamVjdDogdHJ1ZSB9KTtcbiAgY29uc3QgcGFnZUggPSBNYXRoLnJvdW5kKHN0YWNrZWQuaW5mby5oZWlnaHQgLyBwYWdlcyk7XG4gIGNvbnN0IGZyYW1lczogRnJhbWVbXSA9IHBpY2subWFwKHAgPT4ge1xuICAgIGNvbnN0IHN0YXJ0ID0gcCAqIHBhZ2VIICogVyAqIDQ7XG4gICAgcmV0dXJuIHtcbiAgICAgIGRhdGE6IHN0YWNrZWQuZGF0YS5zdWJhcnJheShzdGFydCwgc3RhcnQgKyBwYWdlSCAqIFcgKiA0KSBhcyB1bmtub3duIGFzIFVpbnQ4Q2xhbXBlZEFycmF5LFxuICAgICAgZGVsYXk6IGZyYW1lRGVsYXkoZGVsYXlzW3BdICYmIGRlbGF5c1twXSEgPiAwID8gZGVsYXlzW3BdISA6IDgwKSxcbiAgICB9O1xuICB9KTtcbiAgY29uc3QgSDIgPSBwYWdlSDsgLy8gYWN0dWFsIHBlci1wYWdlIGhlaWdodCBzaGFycCBwcm9kdWNlZFxuXG4gIC8vIFBlci1mcmFtZSBjaHJvbWEgYmJveCBBTkQgdGhlIGZvdXIgZXh0cmVtZSBjb3JuZXJzIG9mIHRoZSByZWdpb24uIFRoZSBncmVlblxuICAvLyBzY3JlZW4gaXMgZGlyZWN0bHkgZGV0ZWN0YWJsZSBldmVyeSBmcmFtZSAoaXQgaXMgbGl0ZXJhbGx5IGNvbG91cmVkKSwgc28gd2VcbiAgLy8gcmVhZCBpdHMgZXhhY3QgcXVhZCByYXRoZXIgdGhhbiB0cmFja2luZyBpdCB3aXRoIGEgdGVtcGxhdGUgXHUyMDE0IG5vIGRyaWZ0LCBub1xuICAvLyBsYWcuIFRoZSBjb3JuZXJzIGxldCBhIGZsYXQvdGlsdGVkIHNjcmVlbiBjYXJyeSB0aGUgaW1hZ2UgaW4gcGVyc3BlY3RpdmUuXG4gIGNvbnN0IGJveGVzOiAoQm94IHwgbnVsbClbXSA9IFtdO1xuICBjb25zdCBxdWFkczogKFF1YWQgfCBudWxsKVtdID0gW107XG4gIGZvciAoY29uc3QgZiBvZiBmcmFtZXMpIHtcbiAgICBjb25zdCBkID0gZi5kYXRhO1xuICAgIGxldCBtaW5YID0gVywgbWluWSA9IEgyLCBtYXhYID0gLTEsIG1heFkgPSAtMSwgY250ID0gMDtcbiAgICAvLyBFeHRyZW1lIHBvaW50czogdGw9bWluKHgreSksIGJyPW1heCh4K3kpLCB0cj1tYXgoeC15KSwgYmw9bWluKHgteSkuXG4gICAgbGV0IHRsUyA9IEluZmluaXR5LCBiclMgPSAtSW5maW5pdHksIHRyUyA9IC1JbmZpbml0eSwgYmxTID0gSW5maW5pdHk7XG4gICAgbGV0IHRsOiBQdCA9IHsgeDogMCwgeTogMCB9LCB0cjogUHQgPSB7IHg6IDAsIHk6IDAgfSwgYnI6IFB0ID0geyB4OiAwLCB5OiAwIH0sIGJsOiBQdCA9IHsgeDogMCwgeTogMCB9O1xuICAgIGZvciAobGV0IHkgPSAwOyB5IDwgSDI7IHkrKykgZm9yIChsZXQgeCA9IDA7IHggPCBXOyB4KyspIHtcbiAgICAgIGNvbnN0IGkgPSAoeSAqIFcgKyB4KSAqIDQ7XG4gICAgICBpZiAoIWtleShkW2ldISwgZFtpICsgMV0hLCBkW2kgKyAyXSEpKSBjb250aW51ZTtcbiAgICAgIGNudCsrO1xuICAgICAgaWYgKHggPCBtaW5YKSBtaW5YID0geDsgaWYgKHggPiBtYXhYKSBtYXhYID0geDsgaWYgKHkgPCBtaW5ZKSBtaW5ZID0geTsgaWYgKHkgPiBtYXhZKSBtYXhZID0geTtcbiAgICAgIGNvbnN0IHN1bSA9IHggKyB5LCBkaWZmID0geCAtIHk7XG4gICAgICBpZiAoc3VtIDwgdGxTKSB7IHRsUyA9IHN1bTsgdGwgPSB7IHgsIHkgfTsgfVxuICAgICAgaWYgKHN1bSA+IGJyUykgeyBiclMgPSBzdW07IGJyID0geyB4LCB5IH07IH1cbiAgICAgIGlmIChkaWZmID4gdHJTKSB7IHRyUyA9IGRpZmY7IHRyID0geyB4LCB5IH07IH1cbiAgICAgIGlmIChkaWZmIDwgYmxTKSB7IGJsUyA9IGRpZmY7IGJsID0geyB4LCB5IH07IH1cbiAgICB9XG4gICAgaWYgKGNudCA8IFcgKiBIMiAqIDAuMDA0KSB7IGJveGVzLnB1c2gobnVsbCk7IHF1YWRzLnB1c2gobnVsbCk7IGNvbnRpbnVlOyB9XG4gICAgYm94ZXMucHVzaCh7IHg6IG1pblgsIHk6IG1pblksIHc6IG1heFggLSBtaW5YLCBoOiBtYXhZIC0gbWluWSwgYWJzZW50OiBmYWxzZSB9KTtcbiAgICBxdWFkcy5wdXNoKHsgdGwsIHRyLCBiciwgYmwsIGFic2VudDogZmFsc2UgfSk7XG4gIH1cbiAgY29uc3Qgc21vb3RoOiAoQm94IHwgbnVsbClbXSA9IFtdO1xuICBsZXQgbGFzdDogQm94IHwgbnVsbCA9IG51bGw7XG4gIGZvciAoY29uc3QgYiBvZiBib3hlcykge1xuICAgIGlmICghYikgeyBzbW9vdGgucHVzaChsYXN0ID8geyAuLi5sYXN0LCBhYnNlbnQ6IHRydWUgfSA6IG51bGwpOyBjb250aW51ZTsgfVxuICAgIGlmICghbGFzdCkgbGFzdCA9IGI7XG4gICAgY29uc3QgYSA9IDAuNTtcbiAgICBsYXN0ID0ge1xuICAgICAgeDogbGFzdC54ICsgKGIueCAtIGxhc3QueCkgKiBhLCB5OiBsYXN0LnkgKyAoYi55IC0gbGFzdC55KSAqIGEsXG4gICAgICB3OiBsYXN0LncgKyAoYi53IC0gbGFzdC53KSAqIGEsIGg6IGxhc3QuaCArIChiLmggLSBsYXN0LmgpICogYSwgYWJzZW50OiBmYWxzZSxcbiAgICB9O1xuICAgIHNtb290aC5wdXNoKHsgLi4ubGFzdCB9KTtcbiAgfVxuXG4gIC8vIFNtb290aCB0aGUgY29ybmVyIHF1YWQgdGhlIHNhbWUgd2F5LCBhbmQgZGVjaWRlIHdoZXRoZXIgdGhpcyBzY2VuZSdzIGNocm9tYVxuICAvLyByZWdpb24gaXMgcmVjdGFuZ3VsYXIgZW5vdWdoIHRvIGNhcnJ5IGEgcGVyc3BlY3RpdmUgd2FycC4gQSByZWFsIHNjcmVlbiBvclxuICAvLyBjYXJkIGZpbGxzIG1vc3Qgb2YgaXRzIGJvdW5kaW5nIGJveCAocmF0aW8gXHUyMTkyIDEpOyBhIHJvdW5kIHBvcnRhbCBvciBhblxuICAvLyBpcnJlZ3VsYXIgc3BsYXQgbGVhdmVzIGEgbG93IHJhdGlvLCBhbmQgd2FycGluZyBhIHJlY3RhbmdsZSBvbnRvIHRoYXQgbG9va3NcbiAgLy8gd29yc2UgdGhhbiBhIHBsYWluIGNlbnRyZWQgZmlsbCBcdTIwMTQgc28gdGhvc2UgZmFsbCBiYWNrIHRvIHRoZSBib3ggY292ZXIuXG4gIGNvbnN0IHNtb290aFF1YWRzOiAoUXVhZCB8IG51bGwpW10gPSBbXTtcbiAgbGV0IGxhc3RROiBRdWFkIHwgbnVsbCA9IG51bGw7XG4gIGxldCBmaWxsU3VtID0gMCwgZmlsbENudCA9IDA7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcXVhZHMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBxID0gcXVhZHNbaV07XG4gICAgaWYgKCFxKSB7IHNtb290aFF1YWRzLnB1c2gobGFzdFEgPyB7IC4uLmxhc3RRLCBhYnNlbnQ6IHRydWUgfSA6IG51bGwpOyBjb250aW51ZTsgfVxuICAgIGlmICghbGFzdFEpIGxhc3RRID0gcTtcbiAgICBjb25zdCBhID0gMC41O1xuICAgIGxhc3RRID0ge1xuICAgICAgdGw6IGxlcnBQdChsYXN0US50bCwgcS50bCwgYSksIHRyOiBsZXJwUHQobGFzdFEudHIsIHEudHIsIGEpLFxuICAgICAgYnI6IGxlcnBQdChsYXN0US5iciwgcS5iciwgYSksIGJsOiBsZXJwUHQobGFzdFEuYmwsIHEuYmwsIGEpLCBhYnNlbnQ6IGZhbHNlLFxuICAgIH07XG4gICAgc21vb3RoUXVhZHMucHVzaCh7IC4uLmxhc3RRIH0pO1xuICAgIGNvbnN0IGJveCA9IGJveGVzW2ldO1xuICAgIGlmIChib3ggJiYgYm94LncgPiAyICYmIGJveC5oID4gMikgeyBmaWxsU3VtICs9IHF1YWRBcmVhKHEpIC8gKGJveC53ICogYm94LmgpOyBmaWxsQ250Kys7IH1cbiAgfVxuICBjb25zdCByZWN0YW5ndWxhciA9IGZpbGxDbnQgPiAwICYmIGZpbGxTdW0gLyBmaWxsQ250ID49IDAuNzI7XG4gIC8vIFBlcnNwZWN0aXZlIGlzIG9ubHkgbWVhbmluZ2Z1bCBvbiBhIHN0YXRpYyBzY3JlZW4vY2FyZC4gRWZmZWN0cyBtb3ZlIG9yIHNjYWxlXG4gIC8vIHRoZSB0YXJnZXQgb2ZmIGl0cyBib3gsIHNvIHRob3NlIGtlZXAgdGhlIGF4aXMtYWxpZ25lZCBjb3ZlciBwYXRoLlxuICBjb25zdCB1c2VXYXJwID0gcmVjdGFuZ3VsYXIgJiYgY2ZnLmVmZmVjdCA9PT0gXCJub25lXCIgJiYgY2ZnLmZpdCAhPT0gXCJzdHJldGNoXCI7XG5cbiAgbGV0IGV4cGxvZGVTdGFydDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIGlmIChjZmcuZWZmZWN0ID09PSBcImV4cGxvZGVcIikge1xuICAgIGZvciAobGV0IGsgPSAwOyBrIDwgZnJhbWVzLmxlbmd0aDsgaysrKSB7XG4gICAgICBjb25zdCBkID0gZnJhbWVzW2tdIS5kYXRhOyBsZXQgZmlyZSA9IDA7XG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGQubGVuZ3RoOyBpICs9IDQpIGlmIChkW2ldISA+IDE4MCAmJiBkW2kgKyAxXSEgPiA4MCAmJiBkW2kgKyAxXSEgPCAxOTAgJiYgZFtpICsgMl0hIDwgOTApIGZpcmUrKztcbiAgICAgIGlmIChmaXJlID4gVyAqIEgyICogMC4wMikgeyBleHBsb2RlU3RhcnQgPSBrOyBicmVhazsgfVxuICAgIH1cbiAgfVxuICBsZXQgcmV2ZWFsQXQgPSAwO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHNtb290aC5sZW5ndGg7IGkrKykgeyBjb25zdCBzID0gc21vb3RoW2ldOyBpZiAocyAmJiAhcy5hYnNlbnQpIHsgcmV2ZWFsQXQgPSBpOyBicmVhazsgfSB9XG5cbiAgY29uc3QgZW5jb2RlciA9IG5ldyBHSUZFbmNvZGVyKFcsIEgyKTtcbiAgZW5jb2Rlci5zdGFydCgpOyBlbmNvZGVyLnNldFJlcGVhdCgwKTsgZW5jb2Rlci5zZXRRdWFsaXR5KG9wdHMucXVhbGl0eSA/PyAxMCk7XG5cbiAgY29uc3QgY2FudmFzID0gbW9kLmNyZWF0ZUNhbnZhcyhXLCBIMik7XG4gIGNvbnN0IGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KFwiMmRcIikgYXMgdW5rbm93biBhcyBDdHgyRDtcbiAgY29uc3QgZmdDYW52YXMgPSBtb2QuY3JlYXRlQ2FudmFzKFcsIEgyKTtcbiAgY29uc3QgZmdjdHggPSBmZ0NhbnZhcy5nZXRDb250ZXh0KFwiMmRcIikgYXMgdW5rbm93biBhcyBDdHgyRDtcblxuICBmb3IgKGxldCBmID0gMDsgZiA8IGZyYW1lcy5sZW5ndGg7IGYrKykge1xuICAgIGNvbnN0IGZyYW1lID0gZnJhbWVzW2ZdITtcbiAgICAvLyBGb3JlZ3JvdW5kID0gZnJhbWUgd2l0aCBjaHJvbWEga2V5ZWQgb3V0ICsgbGlnaHQgZGVzcGlsbC5cbiAgICBjb25zdCBmZyA9IG5ldyBVaW50OENsYW1wZWRBcnJheShmcmFtZS5kYXRhKTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGZnLmxlbmd0aDsgaSArPSA0KSB7XG4gICAgICBpZiAoa2V5KGZnW2ldISwgZmdbaSArIDFdISwgZmdbaSArIDJdISkpIGZnW2kgKyAzXSA9IDA7XG4gICAgICBlbHNlIGlmIChjZmcuY2hyb21hID09PSBcImdyZWVuXCIgJiYgZmdbaSArIDFdISA+IGZnW2ldISAmJiBmZ1tpICsgMV0hID4gZmdbaSArIDJdISkgZmdbaSArIDFdID0gTWF0aC5tYXgoZmdbaV0hLCBmZ1tpICsgMl0hKTtcbiAgICAgIGVsc2UgaWYgKGNmZy5jaHJvbWEgPT09IFwiYmx1ZVwiICYmIGZnW2kgKyAyXSEgPiBmZ1tpXSEgJiYgZmdbaSArIDJdISA+IGZnW2kgKyAxXSEpIGZnW2kgKyAyXSA9IE1hdGgubWF4KGZnW2ldISwgZmdbaSArIDFdISk7XG4gICAgfVxuXG4gICAgY3R4LmNsZWFyUmVjdCgwLCAwLCBXLCBIMik7XG4gICAgY3R4LmZpbGxTdHlsZSA9IFwiIzAwMFwiOyBjdHguZmlsbFJlY3QoMCwgMCwgVywgSDIpO1xuXG4gICAgY29uc3QgYm94ID0gc21vb3RoW2ZdO1xuICAgIGNvbnN0IHF1YWQgPSBzbW9vdGhRdWFkc1tmXTtcbiAgICBpZiAodXNlV2FycCAmJiBxdWFkICYmICFxdWFkLmFic2VudCkge1xuICAgICAgd2FycFRhcmdldFRvUXVhZChjdHgsIHRhcmdldCwgcXVhZCk7XG4gICAgfSBlbHNlIGlmIChib3ggJiYgIWJveC5hYnNlbnQpIHtcbiAgICAgIGRyYXdUYXJnZXQobW9kLCBjdHgsIHRhcmdldCwgYm94LCBjZmcsIGYsIGZyYW1lcy5sZW5ndGgsIGV4cGxvZGVTdGFydCwgcmV2ZWFsQXQpO1xuICAgIH1cblxuICAgIGNvbnN0IGZnSWQgPSBmZ2N0eC5jcmVhdGVJbWFnZURhdGEoVywgSDIpO1xuICAgIGZnSWQuZGF0YS5zZXQoZmcpO1xuICAgIGZnY3R4LnB1dEltYWdlRGF0YShmZ0lkLCAwLCAwKTtcbiAgICBjdHguZ2xvYmFsQWxwaGEgPSAxO1xuICAgIGN0eC5kcmF3SW1hZ2UoZmdDYW52YXMgYXMgdW5rbm93biwgMCwgMCk7XG5cbiAgICBlbmNvZGVyLnNldERlbGF5KGZyYW1lLmRlbGF5KTtcbiAgICBlbmNvZGVyLmFkZEZyYW1lKGN0eCBhcyB1bmtub3duIGFzIG5ldmVyKTtcbiAgfVxuICBlbmNvZGVyLmZpbmlzaCgpO1xuICByZXR1cm4gZW5jb2Rlci5vdXQuZ2V0RGF0YSgpO1xufVxuXG5mdW5jdGlvbiBsZXJwUHQoYTogUHQsIGI6IFB0LCB0OiBudW1iZXIpOiBQdCB7XG4gIHJldHVybiB7IHg6IGEueCArIChiLnggLSBhLngpICogdCwgeTogYS55ICsgKGIueSAtIGEueSkgKiB0IH07XG59XG5cbi8qKiBTaG9lbGFjZSBhcmVhIG9mIGEgcXVhZCAoY29ybmVyIG9yZGVyIHRsXHUyMTkydHJcdTIxOTJiclx1MjE5MmJsKS4gKi9cbmZ1bmN0aW9uIHF1YWRBcmVhKHE6IFF1YWQpOiBudW1iZXIge1xuICBjb25zdCBwID0gW3EudGwsIHEudHIsIHEuYnIsIHEuYmxdO1xuICBsZXQgcyA9IDA7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgNDsgaSsrKSB7XG4gICAgY29uc3QgYSA9IHBbaV0hLCBiID0gcFsoaSArIDEpICUgNF0hO1xuICAgIHMgKz0gYS54ICogYi55IC0gYi54ICogYS55O1xuICB9XG4gIHJldHVybiBNYXRoLmFicyhzKSAvIDI7XG59XG5cbi8qKiBBZmZpbmUgdGhhdCBtYXBzIHNvdXJjZSB0cmlhbmdsZSBgc2Agb250byBkZXN0aW5hdGlvbiB0cmlhbmdsZSBgZGAuICovXG5mdW5jdGlvbiBhZmZpbmVGcm9tVHJpKHM6IFB0W10sIGQ6IFB0W10pOiBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyLCBudW1iZXIsIG51bWJlcl0ge1xuICBjb25zdCBbczAsIHMxLCBzMl0gPSBzIGFzIFtQdCwgUHQsIFB0XTtcbiAgY29uc3QgW2QwLCBkMSwgZDJdID0gZCBhcyBbUHQsIFB0LCBQdF07XG4gIGNvbnN0IGRldCA9IChzMS54IC0gczAueCkgKiAoczIueSAtIHMwLnkpIC0gKHMyLnggLSBzMC54KSAqIChzMS55IC0gczAueSk7XG4gIGlmIChNYXRoLmFicyhkZXQpIDwgMWUtNikgcmV0dXJuIFsxLCAwLCAwLCAxLCAwLCAwXTtcbiAgY29uc3QgYSA9ICgoZDEueCAtIGQwLngpICogKHMyLnkgLSBzMC55KSAtIChkMi54IC0gZDAueCkgKiAoczEueSAtIHMwLnkpKSAvIGRldDtcbiAgY29uc3QgYyA9ICgoczEueCAtIHMwLngpICogKGQyLnggLSBkMC54KSAtIChzMi54IC0gczAueCkgKiAoZDEueCAtIGQwLngpKSAvIGRldDtcbiAgY29uc3QgYiA9ICgoZDEueSAtIGQwLnkpICogKHMyLnkgLSBzMC55KSAtIChkMi55IC0gZDAueSkgKiAoczEueSAtIHMwLnkpKSAvIGRldDtcbiAgY29uc3QgZGQgPSAoKHMxLnggLSBzMC54KSAqIChkMi55IC0gZDAueSkgLSAoczIueCAtIHMwLngpICogKGQxLnkgLSBkMC55KSkgLyBkZXQ7XG4gIGNvbnN0IGUgPSBkMC54IC0gYSAqIHMwLnggLSBjICogczAueTtcbiAgY29uc3QgZiA9IGQwLnkgLSBiICogczAueCAtIGRkICogczAueTtcbiAgcmV0dXJuIFthLCBiLCBjLCBkZCwgZSwgZl07XG59XG5cbi8qKlxuICogRHJhdyB0aGUgdGFyZ2V0IG9udG8gdGhlIHRyYWNrZWQgY2hyb21hIHF1YWQgaW4gcGVyc3BlY3RpdmUsIHNvIGl0IHNpdHMgb24gdGhlXG4gKiBzY3JlZW4vY2FyZCBsaWtlIGl0IGJlbG9uZ3MgdGhlcmUuIFRoZSB1cGxvYWQgaXMgY292ZXItY3JvcHBlZCB0byB0aGUgcXVhZCdzXG4gKiBhc3BlY3QgKG5vIGRpc3RvcnRpb24sIG5vIGJhcnMpIGFuZCB0aGUgY3JvcCBpcyBtYXBwZWQgb250byB0aGUgcXVhZCBhcyB0d29cbiAqIGNsaXBwZWQgYWZmaW5lIHRyaWFuZ2xlcyBcdTIwMTQgYSBwaWVjZXdpc2UtYWZmaW5lIHBlcnNwZWN0aXZlIHRoYXQgcmVhZHMgdHJ1ZSBmb3JcbiAqIHRoZSBtb2RlcmF0ZSB0aWx0cyB0aGVzZSBjbGlwcyBoYXZlLCB3aXRoIG5vIG5hdGl2ZSBkZXBlbmRlbmN5LlxuICovXG5mdW5jdGlvbiB3YXJwVGFyZ2V0VG9RdWFkKGN0eDogQ3R4MkQsIHRhcmdldDogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9LCBxOiBRdWFkKTogdm9pZCB7XG4gIGNvbnN0IHRvcFcgPSBNYXRoLmh5cG90KHEudHIueCAtIHEudGwueCwgcS50ci55IC0gcS50bC55KTtcbiAgY29uc3QgYm90VyA9IE1hdGguaHlwb3QocS5ici54IC0gcS5ibC54LCBxLmJyLnkgLSBxLmJsLnkpO1xuICBjb25zdCBsZWZ0SCA9IE1hdGguaHlwb3QocS5ibC54IC0gcS50bC54LCBxLmJsLnkgLSBxLnRsLnkpO1xuICBjb25zdCByaWdodEggPSBNYXRoLmh5cG90KHEuYnIueCAtIHEudHIueCwgcS5ici55IC0gcS50ci55KTtcbiAgY29uc3QgcXVhZEFzcGVjdCA9ICgodG9wVyArIGJvdFcpIC8gMikgLyBNYXRoLm1heCgxLCAobGVmdEggKyByaWdodEgpIC8gMik7XG5cbiAgLy8gQ292ZXItY3JvcCB0aGUgc291cmNlIHRvIHRoZSBxdWFkJ3MgYXNwZWN0LCBjZW50cmVkLlxuICBjb25zdCBpdyA9IHRhcmdldC53aWR0aCwgaWggPSB0YXJnZXQuaGVpZ2h0O1xuICBsZXQgc3cgPSBpdywgc2ggPSBpaDtcbiAgaWYgKGl3IC8gaWggPiBxdWFkQXNwZWN0KSBzdyA9IGloICogcXVhZEFzcGVjdDsgZWxzZSBzaCA9IGl3IC8gcXVhZEFzcGVjdDtcbiAgY29uc3Qgc3ggPSAoaXcgLSBzdykgLyAyLCBzeSA9IChpaCAtIHNoKSAvIDI7XG4gIGNvbnN0IHM6IFB0W10gPSBbXG4gICAgeyB4OiBzeCwgeTogc3kgfSwgeyB4OiBzeCArIHN3LCB5OiBzeSB9LCB7IHg6IHN4ICsgc3csIHk6IHN5ICsgc2ggfSwgeyB4OiBzeCwgeTogc3kgKyBzaCB9LFxuICBdO1xuICBjb25zdCBkID0gW3EudGwsIHEudHIsIHEuYnIsIHEuYmxdO1xuXG4gIC8vIFR3byB0cmlhbmdsZXM6ICh0bCx0cixicikgYW5kICh0bCxicixibCkuXG4gIGZvciAoY29uc3QgW2ksIGosIGtdIG9mIFtbMCwgMSwgMl0sIFswLCAyLCAzXV0gYXMgY29uc3QpIHtcbiAgICBjdHguc2F2ZSgpO1xuICAgIGN0eC5iZWdpblBhdGgoKTtcbiAgICBjdHgubW92ZVRvKGRbaV0hLngsIGRbaV0hLnkpOyBjdHgubGluZVRvKGRbal0hLngsIGRbal0hLnkpOyBjdHgubGluZVRvKGRba10hLngsIGRba10hLnkpOyBjdHguY2xvc2VQYXRoKCk7XG4gICAgY3R4LmNsaXAoKTtcbiAgICBjb25zdCBbYSwgYiwgYywgZGQsIGUsIGZmXSA9IGFmZmluZUZyb21UcmkoW3NbaV0hLCBzW2pdISwgc1trXSFdLCBbZFtpXSEsIGRbal0hLCBkW2tdIV0pO1xuICAgIGN0eC5zZXRUcmFuc2Zvcm0oYSwgYiwgYywgZGQsIGUsIGZmKTtcbiAgICBjdHguZHJhd0ltYWdlKHRhcmdldCBhcyB1bmtub3duLCAwLCAwKTtcbiAgICBjdHgucmVzZXRUcmFuc2Zvcm0oKTtcbiAgICBjdHgucmVzdG9yZSgpO1xuICB9XG59XG5cbi8qKiBEcmF3IHRoZSB0YXJnZXQgaW50byB0aGUgY2hyb21hIGJveCB3aXRoIHRoZSBzY2VuZSdzIGZpdCArIGVmZmVjdC4gKi9cbmZ1bmN0aW9uIGRyYXdUYXJnZXQoXG4gIG1vZDogQ2FudmFzTW9kLCBjdHg6IEN0eDJELCB0YXJnZXQ6IHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXIgfSxcbiAgYm94OiBCb3gsIGNmZzogU2NlbmVDb25maWcsIGlkeDogbnVtYmVyLCB0b3RhbDogbnVtYmVyLFxuICBleHBsb2RlU3RhcnQ6IG51bWJlciB8IG51bGwsIHJldmVhbEF0OiBudW1iZXIsXG4pOiB2b2lkIHtcbiAgbGV0IHR3OiBudW1iZXIsIHRoOiBudW1iZXIsIHR4OiBudW1iZXIsIHR5OiBudW1iZXI7XG4gIGlmIChjZmcuZml0ID09PSBcInN0cmV0Y2hcIikge1xuICAgIHR3ID0gYm94Lnc7IHRoID0gYm94Lmg7IHR4ID0gYm94Lng7IHR5ID0gYm94Lnk7XG4gIH0gZWxzZSB7XG4gICAgLy8gQ292ZXI6IHJlLWN1dCB0aGUgdXBsb2FkIHRvIHRoZSBncmVlbiBzY3JlZW4ncyBvd24gc2hhcGUsIGZpbGxpbmcgaXQgZWRnZVxuICAgIC8vIHRvIGVkZ2UgYW5kIGNlbnRyZWQgXHUyMDE0IG5vIGxldHRlcmJveCBiYXJzLCBubyBiYWNrZHJvcC4gVGhlIG92ZXJmbG93ICh0aGVcbiAgICAvLyBwYXJ0IG9mIHRoZSBpbWFnZSB0aGUgc2NyZWVuJ3MgYXNwZWN0IGNhbid0IHNob3cpIGlzIGNsaXBwZWQgdG8gdGhlIHNjcmVlblxuICAgIC8vIGJlbG93LCBzbyB0aGUgdGFyZ2V0IHJlYWRzIGFzIGlmIGl0IHdlcmUgYWx3YXlzIG9uIHRoYXQgc2NyZWVuLlxuICAgIGNvbnN0IHMgPSBNYXRoLm1heChib3gudyAvIHRhcmdldC53aWR0aCwgYm94LmggLyB0YXJnZXQuaGVpZ2h0KTtcbiAgICB0dyA9IHRhcmdldC53aWR0aCAqIHM7IHRoID0gdGFyZ2V0LmhlaWdodCAqIHM7XG4gICAgdHggPSBib3gueCArIChib3gudyAtIHR3KSAvIDI7IHR5ID0gYm94LnkgKyAoYm94LmggLSB0aCkgLyAyO1xuICB9XG4gIGxldCBhbHBoYSA9IDEsIG94ID0gMCwgb3kgPSAwLCBzYyA9IDE7XG4gIGlmIChjZmcuZWZmZWN0ID09PSBcInNoYWtlXCIpIHsgb3ggPSA2ICogTWF0aC5zaW4oaWR4ICogMC45KTsgb3kgPSA0ICogTWF0aC5jb3MoaWR4ICogMS4zKTsgfVxuICBpZiAoY2ZnLmVmZmVjdCA9PT0gXCJwdW5jaFwiKSB7IG94ID0gMTEgKiBNYXRoLnNpbihpZHggKiAxLjcpOyBveSA9IDggKiBNYXRoLmNvcyhpZHggKiAyLjMpOyB9XG4gIGlmIChjZmcuZWZmZWN0ID09PSBcImV4cGxvZGVcIiAmJiBleHBsb2RlU3RhcnQgIT0gbnVsbCAmJiBpZHggPj0gZXhwbG9kZVN0YXJ0KSB7XG4gICAgY29uc3QgdCA9IE1hdGgubWluKDEsIChpZHggLSBleHBsb2RlU3RhcnQpIC8gOCk7IHNjID0gMSArIHQgKiAwLjc7IGFscGhhID0gMSAtIHQgKiAwLjY1O1xuICAgIG94ID0gTWF0aC5zaW4oaWR4ICogNykgKiAxOCAqIHQ7IG95ID0gTWF0aC5jb3MoaWR4ICogNSkgKiAxOCAqIHQ7XG4gIH1cblxuICBjdHguc2F2ZSgpO1xuICBjdHguZ2xvYmFsQWxwaGEgPSBhbHBoYTtcbiAgLy8gS2VlcCB0aGUgdGFyZ2V0IG9uIGl0cyBzY3JlZW46IGNsaXAgY292ZXItb3ZlcmZsb3cgKGFuZCBqaXR0ZXIpIHRvIHRoZSBncmVlblxuICAvLyByZWdpb24gc28gbm90aGluZyBzcGlsbHMgb3ZlciB0aGUgc2NlbmUgY2hyb21lLiBFeHBsb2RlIGlzIHRoZSBleGNlcHRpb24gXHUyMDE0XG4gIC8vIGl0IGlzIG1lYW50IHRvIGJ1cnN0IHBhc3QgdGhlIGZyYW1lLlxuICBpZiAoY2ZnLmVmZmVjdCAhPT0gXCJleHBsb2RlXCIpIHtcbiAgICBjdHguYmVnaW5QYXRoKCk7XG4gICAgY3R4LnJlY3QoYm94LngsIGJveC55LCBib3gudywgYm94LmgpO1xuICAgIGN0eC5jbGlwKCk7XG4gIH1cbiAgY29uc3QgY3cgPSB0dyAqIHNjLCBjaCA9IHRoICogc2M7XG4gIGNvbnN0IGR4ID0gdHggKyBveCAtIChjdyAtIHR3KSAvIDIsIGR5ID0gdHkgKyBveSAtIChjaCAtIHRoKSAvIDI7XG5cbiAgY29uc3QgY2hGbGFzaCA9IGNmZy5lZmZlY3QgPT09IFwiY2hhbm5lbFwiICYmIGlkeCA+PSByZXZlYWxBdCAmJiBpZHggPCByZXZlYWxBdCArIDU7XG4gIGlmIChjaEZsYXNoKSB7XG4gICAgY29uc3QgciA9IG11bGJlcnJ5KGlkeCAqIDkxMSk7XG4gICAgZm9yIChsZXQgcyA9IDA7IHMgPCA5MDA7IHMrKykge1xuICAgICAgY29uc3QgdiA9IChyKCkgKiAyNTUpIHwgMDsgY3R4LmZpbGxTdHlsZSA9IGByZ2IoJHt2fSwke3Z9LCR7dn0pYDtcbiAgICAgIGN0eC5maWxsUmVjdChib3gueCArIHIoKSAqIGJveC53LCBib3gueSArIHIoKSAqIGJveC5oLCAyLCAyKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAoY2ZnLmVmZmVjdCA9PT0gXCJjdXRcIiB8fCBjZmcuZWZmZWN0ID09PSBcInJpcFwiKSB7XG4gICAgY29uc3QgcHJvZyA9IGlkeCAvICh0b3RhbCAtIDEpO1xuICAgIGNvbnN0IGN1dFQgPSBNYXRoLm1heCgwLCBNYXRoLm1pbigxLCAocHJvZyAtIDAuNSkgLyAwLjQpKTtcbiAgICAvLyBCdWlsZCB0aGUgdGFyZ2V0IG9uIGl0cyBvd24gbGF5ZXIsIHRoZW4gYmxpdCB0aGUgaGFsdmVzIGFwYXJ0IHdpdGggYSBnYXAuXG4gICAgY29uc3QgbHcgPSBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKGR4ICsgY3cpICsgNCk7XG4gICAgY29uc3QgbGggPSBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKGR5ICsgY2gpICsgNCk7XG4gICAgY29uc3QgbGF5ZXIgPSBtb2QuY3JlYXRlQ2FudmFzKGx3LCBsaCk7XG4gICAgY29uc3QgbGN0eCA9IGxheWVyLmdldENvbnRleHQoXCIyZFwiKSBhcyB1bmtub3duIGFzIEN0eDJEO1xuICAgIGxjdHguZHJhd0ltYWdlKHRhcmdldCBhcyB1bmtub3duLCBkeCwgZHksIGN3LCBjaCk7XG4gICAgY29uc3QgbWlkWCA9IE1hdGgucm91bmQoYm94LnggKyBib3gudyAvIDIpO1xuICAgIGNvbnN0IGdhcCA9IGJveC53ICogKGNmZy5lZmZlY3QgPT09IFwicmlwXCIgPyAwLjA2IDogMC4xNikgKiBjdXRUO1xuICAgIGNvbnN0IHRlYXIgPSBjZmcuZWZmZWN0ID09PSBcInJpcFwiID8gYm94LmggKiAwLjAzICogY3V0VCA6IDA7XG4gICAgY3R4LmRyYXdJbWFnZShsYXllciBhcyB1bmtub3duLCAwLCAwLCBtaWRYLCBsaCwgLWdhcCAvIDIsIC10ZWFyLCBtaWRYLCBsaCk7XG4gICAgY3R4LmRyYXdJbWFnZShsYXllciBhcyB1bmtub3duLCBtaWRYLCAwLCBsdyAtIG1pZFgsIGxoLCBtaWRYICsgZ2FwIC8gMiwgdGVhciwgbHcgLSBtaWRYLCBsaCk7XG4gIH0gZWxzZSB7XG4gICAgY3R4LmRyYXdJbWFnZSh0YXJnZXQgYXMgdW5rbm93biwgZHgsIGR5LCBjdywgY2gpO1xuICB9XG5cbiAgaWYgKGNmZy5lZmZlY3QgPT09IFwicHVuY2hcIikge1xuICAgIGNvbnN0IHIgPSBtdWxiZXJyeSg0MjQyKTtcbiAgICBjb25zdCBuU3BsID0gTWF0aC5mbG9vcig0ICsgKGlkeCAvICh0b3RhbCAtIDEpKSAqIDI2KTtcbiAgICBmb3IgKGxldCBzID0gMDsgcyA8IG5TcGw7IHMrKykge1xuICAgICAgY29uc3QgcHggPSBib3gueCArIHIoKSAqIGJveC53LCBweSA9IGJveC55ICsgcigpICogYm94LmgsIHJhZCA9IDMgKyByKCkgKiAxNTtcbiAgICAgIGN0eC5nbG9iYWxBbHBoYSA9ICgwLjUgKyByKCkgKiAwLjQ1KSAqIGFscGhhO1xuICAgICAgY3R4LmZpbGxTdHlsZSA9IHIoKSA+IDAuMyA/IFwiIzdhMGIwYlwiIDogXCIjYjAxNDE0XCI7XG4gICAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5lbGxpcHNlKHB4LCBweSwgcmFkLCByYWQgKiAoMC42ICsgcigpICogMC44KSwgcigpICogNiwgMCwgNyk7IGN0eC5maWxsKCk7XG4gICAgICBpZiAocigpID4gMC43KSBjdHguZmlsbFJlY3QocHggLSAxLCBweSwgMiArIHIoKSAqIDIsIHJhZCArIHIoKSAqIDIyKTtcbiAgICB9XG4gICAgY3R4Lmdsb2JhbEFscGhhID0gYWxwaGE7XG4gIH1cbiAgaWYgKGNmZy5lZmZlY3QgPT09IFwiZnV6enl0dlwiIHx8IChjZmcuZWZmZWN0ID09PSBcImNoYW5uZWxcIiAmJiAhY2hGbGFzaCkpIHtcbiAgICBjb25zdCByID0gbXVsYmVycnkoaWR4ICogMTcgKyAzKTtcbiAgICBjdHguZ2xvYmFsQWxwaGEgPSAoY2ZnLmVmZmVjdCA9PT0gXCJmdXp6eXR2XCIgPyAwLjE4IDogMC4xMikgKiBhbHBoYTtcbiAgICBmb3IgKGxldCBzID0gMDsgcyA8IDM0OyBzKyspIHtcbiAgICAgIGN0eC5maWxsU3R5bGUgPSByKCkgPiAwLjUgPyBcIiNmZmZcIiA6IFwiIzAwMFwiO1xuICAgICAgY3R4LmZpbGxSZWN0KGJveC54LCBib3gueSArIHIoKSAqIGJveC5oLCBib3gudywgMSArIHIoKSAqIDIpO1xuICAgIH1cbiAgICBjdHguZ2xvYmFsQWxwaGEgPSBhbHBoYTtcbiAgfVxuICBjdHgucmVzdG9yZSgpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBb0JBLE9BQU8sZ0JBQWdCO0FBQ3ZCLE9BQU8sV0FBVztBQUNsQixTQUFTLFlBQVksb0JBQW9CO0FBQ3pDLFNBQVMsWUFBWTtBQUNyQixTQUFTLGlCQUFpQztBQUMxQyxTQUFTLGNBQWM7QUFDdkIsU0FBUyxrQkFBa0I7QUFDM0IsU0FBUywwQkFBMEI7QUFrQjVCLE1BQU0sZUFBZTtBQVE1QixNQUFNLGtCQUFrQjtBQU94QixNQUFNLGlCQUFpQjtBQUV2QixNQUFNLGdCQUFnQjtBQUN0QixNQUFNLGdCQUFnQjtBQUV0QixJQUFJO0FBR0osU0FBUyxZQUEyQjtBQUNsQyxRQUFNLE9BQU8sbUJBQW1CO0FBQ2hDLE1BQUksQ0FBQyxLQUFNLFFBQU87QUFDbEIsUUFBTSxNQUFNLEtBQUssTUFBTSxRQUFRO0FBQy9CLFNBQU8sV0FBVyxLQUFLLEtBQUssYUFBYSxDQUFDLElBQUksTUFBTTtBQUN0RDtBQUdPLFNBQVMsYUFBMEY7QUFDeEcs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
