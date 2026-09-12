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
    const list = parsed.scenes.filter((s) => existsSync(join(dir, `${s.id}.gif`))).map(applySceneOverrides);
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
const isGreen = (r, g, b) => g > 120 && g - r > 40 && g - b > 40;
const isBlue = (r, g, b) => b > 110 && r < 120 && g < 130 && b - r > 60 && b - g > 55;
const isCyan = (r, g, b) => b > 100 && g > 100 && r < 185 && g + b > r * 2 && b >= r - 10 && g >= r - 25 && !(g > 150 && g - r > 50 && g - b > 40);
function chromaKey(chroma) {
  if (chroma === "blue") return isBlue;
  if (chroma === "cyan") return (r, g, b) => isCyan(r, g, b) || isBlue(r, g, b) || isGreen(r, g, b);
  return isGreen;
}
const DEFAULT_INSET = 0.92;
const SCENE_OVERRIDES = {
  // Theater screen is only green for a beat — hold authored screen for the rest.
  theater: { fit: "stretch", hole: [0.09, 0.12, 0.81, 0.6], holeSeed: true },
  // Small desk TV; green comes and goes / soft.
  "professor-tv": { fit: "contain", hole: [0.62, 0.36, 0.26, 0.48], inset: 0.9, holeSeed: true },
  // Genie portal: pure blue screen opens mid-clip. Green keys the character's
  // skin (wrong). Authored hole matches the blue portal; live blue refines it.
  "giant-portal": { chroma: "blue", fit: "contain", inset: 0.9, hole: [0.37, 0.15, 0.51, 0.71], holeSeed: true },
  // Wanted poster card: green arrives late — seed the card rect.
  "catch-me-card": { fit: "contain", hole: [0.3, 0.22, 0.32, 0.55], inset: 0.9 },
  // Movie theater–style wide screens: contain so the whole face reads.
  "mission-passed": { fit: "contain" },
  explosion: { fit: "contain" },
  "cutting-board": { fit: "contain" },
  "breaking-bad": { fit: "contain" },
  "dexter-locker": { fit: "contain" },
  "toy-story-tv": { fit: "contain", inset: 0.9 },
  "villain-tv": { fit: "contain", inset: 0.9 },
  "rocket-paper": { fit: "contain" },
  "rock-throw": { fit: "contain" },
  "megamind-card": { fit: "contain", inset: 0.9 },
  "megamind-card-2": { fit: "contain", inset: 0.9 },
  "mario-movie": { fit: "contain" },
  "control-room": { fit: "contain" },
  "big-screen": { fit: "contain" },
  "tiktok-hearing": { fit: "contain" },
  "gta-office": { fit: "contain" },
  "blue-card-kid": { fit: "contain", inset: 0.9 },
  "surprised-cat": { fit: "contain" },
  "baby-dog": { fit: "contain" },
  "dancing-baby": { fit: "contain" },
  chimp: { fit: "contain" }
};
function applySceneOverrides(raw) {
  const o = SCENE_OVERRIDES[raw.id];
  const fit = o?.fit ?? (raw.fit === "stretch" ? "stretch" : "contain");
  return { ...raw, ...o, fit };
}
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
  const key = chromaKey(cfg.chroma);
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
  if (cfg.hole) {
    const [fx, fy, fw, fh] = cfg.hole;
    const hb = {
      x: fx * W,
      y: fy * H2,
      w: Math.max(1, fw * W),
      h: Math.max(1, fh * H2),
      absent: false
    };
    const hq = {
      tl: { x: hb.x, y: hb.y },
      tr: { x: hb.x + hb.w, y: hb.y },
      br: { x: hb.x + hb.w, y: hb.y + hb.h },
      bl: { x: hb.x, y: hb.y + hb.h },
      absent: false
    };
    const authoredArea = hb.w * hb.h;
    let seenLive = false;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const liveOk = !!(b && b.w * b.h >= authoredArea * 0.35 && b.w * b.h <= authoredArea * 1.6 && b.x + b.w * 0.5 >= hb.x && b.x + b.w * 0.5 <= hb.x + hb.w && b.y + b.h * 0.5 >= hb.y && b.y + b.h * 0.5 <= hb.y + hb.h);
      if (liveOk) {
        seenLive = true;
        continue;
      }
      if (cfg.holeSeed || seenLive) {
        boxes[i] = { ...hb };
        quads[i] = { ...hq, tl: { ...hq.tl }, tr: { ...hq.tr }, br: { ...hq.br }, bl: { ...hq.bl } };
      }
    }
  }
  const smooth = [];
  let last = null;
  for (const b of boxes) {
    if (!b) {
      smooth.push(last ? { ...last, absent: false } : null);
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
      smoothQuads.push(lastQ ? { ...lastQ, absent: false } : null);
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
  const holeFill = fillCnt > 0 ? fillSum / fillCnt : 1;
  const rectangular = holeFill >= 0.72;
  const useWarp = rectangular && cfg.effect === "none" && cfg.fit !== "stretch" && !cfg.hole;
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
    let heldHole = false;
    if (useWarp && quad && !quad.absent || box && !box.absent) {
      const layer = mod.createCanvas(W, H2);
      const lctx = layer.getContext("2d");
      lctx.clearRect(0, 0, W, H2);
      const drawBox = box && !rectangular ? shrinkBoxToFill(box, holeFill) : box;
      if (useWarp && quad && !quad.absent) {
        warpTargetToQuad(lctx, target, quad, cfg.fit || "contain", cfg.inset ?? DEFAULT_INSET);
      } else if (drawBox && !drawBox.absent) {
        drawTarget(mod, lctx, target, drawBox, cfg, f, frames.length, explodeStart, revealAt);
      }
      if (cfg.effect !== "explode" && box && !box.absent) {
        const maskId = lctx.createImageData(W, H2);
        const md = maskId.data;
        const src2 = frame.data;
        let keyed = 0;
        let keyedInBox = 0;
        const x0 = Math.max(0, Math.floor(box.x));
        const y0 = Math.max(0, Math.floor(box.y));
        const x1 = Math.min(W, Math.ceil(box.x + box.w));
        const y1 = Math.min(H2, Math.ceil(box.y + box.h));
        const boxArea = Math.max(1, (x1 - x0) * (y1 - y0));
        for (let y = 0; y < H2; y++) {
          for (let x = 0; x < W; x++) {
            const i = (y * W + x) * 4;
            if (!key(src2[i], src2[i + 1], src2[i + 2])) continue;
            keyed++;
            if (x >= x0 && x < x1 && y >= y0 && y < y1) keyedInBox++;
          }
        }
        const solidKey = keyedInBox >= boxArea * 0.45;
        if (solidKey) {
          for (let i = 0; i < md.length; i += 4) {
            if (key(src2[i], src2[i + 1], src2[i + 2])) {
              md[i] = md[i + 1] = md[i + 2] = 255;
              md[i + 3] = 255;
            }
          }
        } else {
          heldHole = keyed < W * H2 * 4e-3 || !!cfg.hole;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const i = (y * W + x) * 4;
              md[i] = md[i + 1] = md[i + 2] = 255;
              md[i + 3] = 255;
            }
          }
        }
        const maskCanvas = mod.createCanvas(W, H2);
        const mctx = maskCanvas.getContext("2d");
        mctx.putImageData(maskId, 0, 0);
        lctx.globalCompositeOperation = "destination-in";
        lctx.drawImage(maskCanvas, 0, 0);
        lctx.globalCompositeOperation = "source-over";
      }
      ctx.drawImage(layer, 0, 0);
    }
    if (heldHole && box && !box.absent) {
      for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(H2, Math.ceil(box.y + box.h)); y++) {
        for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(W, Math.ceil(box.x + box.w)); x++) {
          fg[(y * W + x) * 4 + 3] = 0;
        }
      }
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
function shrinkBoxToFill(box, fill) {
  const s = Math.sqrt(Math.max(0.35, Math.min(1, fill)));
  if (s >= 0.98) return box;
  const nw = box.w * s, nh = box.h * s;
  return {
    x: box.x + (box.w - nw) / 2,
    y: box.y + (box.h - nh) / 2,
    w: nw,
    h: nh,
    absent: box.absent
  };
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
function warpTargetToQuad(ctx, target, q, fit = "contain", inset = DEFAULT_INSET) {
  const topW = Math.hypot(q.tr.x - q.tl.x, q.tr.y - q.tl.y);
  const botW = Math.hypot(q.br.x - q.bl.x, q.br.y - q.bl.y);
  const leftH = Math.hypot(q.bl.x - q.tl.x, q.bl.y - q.tl.y);
  const rightH = Math.hypot(q.br.x - q.tr.x, q.br.y - q.tr.y);
  const quadAspect = (topW + botW) / 2 / Math.max(1, (leftH + rightH) / 2);
  const iw = target.width, ih = target.height;
  let sw = iw, sh = ih;
  if (fit === "cover") {
    if (iw / ih > quadAspect) sw = ih * quadAspect;
    else sh = iw / quadAspect;
  } else {
    if (iw / ih > quadAspect) sh = iw / quadAspect;
    else sw = ih * quadAspect;
  }
  const inv = Math.max(0.5, Math.min(1, inset));
  sw /= inv;
  sh /= inv;
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
  const inset = Math.max(0.5, Math.min(1, cfg.inset ?? DEFAULT_INSET));
  const aw = box.w * inset, ah = box.h * inset;
  const fit = cfg.fit || "contain";
  if (fit === "stretch") {
    tw = aw;
    th = ah;
    tx = box.x + (box.w - tw) / 2;
    ty = box.y + (box.h - th) / 2;
  } else if (fit === "cover") {
    const s = Math.max(aw / target.width, ah / target.height);
    tw = target.width * s;
    th = target.height * s;
    tx = box.x + (box.w - tw) / 2;
    ty = box.y + (box.h - th) / 2;
  } else {
    const s = Math.min(aw / target.width, ah / target.height);
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
