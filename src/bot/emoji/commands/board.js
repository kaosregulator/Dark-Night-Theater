import GIFEncoder from "gifencoder";
import { parseGIF, decompressFrames } from "gifuct-js";
import { getCanvas } from "../../animations/engine.js";
import { logger } from "../../../lib/logger.js";
import {
  previewKey,
  renderStyleThumb,
  renderStyleThumbGif,
  targetHash
} from "../preview/index.js";
import { isFavorite } from "./favorites.js";
const BOARD_PAGE_SIZE = 8;
const BOARD_FILENAME = "style-board.gif";
const BOARD_FILENAME_STILL = "style-board.png";
const BOARD_MAX_FRAMES = 14;
const BOARD_QUALITY = 16;
const BOARD_MAX_BYTES = 75e5;
const CELL_LOAD_CONCURRENCY = Math.min(6, Math.max(2, Number(process.env["EMOJI_BOARD_CONCURRENCY"] ?? 4)));
const COLS = 4;
const CELL_W = 150;
const CELL_H = 168;
const THUMB = 104;
const GAP = 14;
const PAD = 20;
const HEADER_H = 100;
const BG_TOP = "#2b2d42";
const BG_BOT = "#1e1f2e";
const CELL_BG = "#33364a";
const CELL_BG_SEL = "#3b4670";
const RING = "#5865f2";
const STAR = "#f1c40f";
const TEXT = "#eceef5";
const SUBTLE = "#aab0c4";
const BADGE_BG = "#12131c";
function roundRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}\u2026`).width > maxWidth) {
    t = t.slice(0, -1);
  }
  return `${t}\u2026`;
}
function drawContain(ctx, img, x, y, box) {
  const scale = Math.min(box / img.width, box / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, x + (box - w) / 2, y + (box - h) / 2, w, h);
}
function boardDims(count) {
  const rows = Math.max(1, Math.ceil(count / COLS));
  const gridW = COLS * CELL_W + (COLS - 1) * GAP;
  const width = PAD * 2 + gridW;
  const height = HEADER_H + PAD + rows * CELL_H + (rows - 1) * GAP + PAD;
  return { width, height, gridW, rows };
}
function cellLayout(stylesLen, i, gridW) {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const rowCount = Math.min(COLS, stylesLen - row * COLS);
  const rowW = rowCount * CELL_W + (rowCount - 1) * GAP;
  const rowStart = PAD + (gridW - rowW) / 2;
  const x = rowStart + col * (CELL_W + GAP);
  const y = HEADER_H + PAD + row * (CELL_H + GAP);
  return { x, y, tx: x + (CELL_W - THUMB) / 2, ty: y + 16 };
}
function drawBoard(ctx, opts, target, cellImages) {
  const { styles, focusValue, userId } = opts;
  const { width, height, gridW } = boardDims(styles.length);
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, BG_TOP);
  bg.addColorStop(1, BG_BOT);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = TEXT;
  ctx.font = `700 26px "Orbitron", sans-serif`;
  ctx.fillText("Style Board", PAD, 46);
  ctx.fillStyle = SUBTLE;
  ctx.font = `500 15px sans-serif`;
  ctx.fillText(
    `Page ${opts.page + 1}/${opts.pages} \xB7 ${opts.total} styles \xB7 ${opts.format.toUpperCase()}`,
    PAD,
    74
  );
  const chip = 56;
  const chipX = width - PAD - chip;
  const chipY = 26;
  ctx.fillStyle = BADGE_BG;
  roundRect(ctx, chipX - 6, chipY - 6, chip + 12, chip + 12, 12);
  ctx.fill();
  if (target) {
    ctx.save();
    roundRect(ctx, chipX, chipY, chip, chip, 8);
    ctx.clip();
    drawContain(ctx, target, chipX, chipY, chip);
    ctx.restore();
  }
  ctx.fillStyle = SUBTLE;
  ctx.font = `500 12px sans-serif`;
  ctx.textAlign = "right";
  const label = fitText(ctx, opts.targetLabel, 150);
  ctx.fillText("Your target", chipX - 12, 44);
  ctx.fillStyle = TEXT;
  ctx.font = `600 13px sans-serif`;
  ctx.fillText(label, chipX - 12, 66);
  ctx.textAlign = "left";
  styles.forEach((style, i) => {
    const { x, y, tx, ty } = cellLayout(styles.length, i, gridW);
    const selected = style.value === focusValue;
    const fav = isFavorite(userId, style.value);
    const img = cellImages[i];
    ctx.fillStyle = selected ? CELL_BG_SEL : CELL_BG;
    roundRect(ctx, x, y, CELL_W, CELL_H, 14);
    ctx.fill();
    if (selected) {
      ctx.strokeStyle = RING;
      ctx.lineWidth = 3;
      roundRect(ctx, x + 1.5, y + 1.5, CELL_W - 3, CELL_H - 3, 13);
      ctx.stroke();
    }
    if (img) {
      ctx.save();
      roundRect(ctx, tx, ty, THUMB, THUMB, 10);
      ctx.clip();
      drawContain(ctx, img, tx, ty, THUMB);
      ctx.restore();
    } else {
      ctx.fillStyle = BADGE_BG;
      roundRect(ctx, tx, ty, THUMB, THUMB, 10);
      ctx.fill();
      ctx.fillStyle = SUBTLE;
      ctx.font = `500 12px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("no preview", x + CELL_W / 2, ty + THUMB / 2 + 4);
      ctx.textAlign = "left";
    }
    const bx = x + 16;
    const by = y + 16;
    ctx.fillStyle = selected ? RING : BADGE_BG;
    ctx.beginPath();
    ctx.arc(bx, by, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = TEXT;
    ctx.font = `700 15px "Orbitron", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), bx, by + 1);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    if (fav) {
      ctx.fillStyle = STAR;
      ctx.font = `700 18px sans-serif`;
      ctx.textAlign = "right";
      ctx.fillText("\u2605", x + CELL_W - 12, by + 6);
      ctx.textAlign = "left";
    }
    ctx.fillStyle = selected ? TEXT : SUBTLE;
    ctx.font = `600 14px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(fitText(ctx, style.label, CELL_W - 24), x + CELL_W / 2, y + CELL_H - 16);
    ctx.textAlign = "left";
  });
}
const DECODED_MAX_ENTRIES = 24;
const DECODED_MAX_BYTES = 12 * 1024 * 1024;
const DECODED_TTL_MS = 15 * 60 * 1e3;
const decodedCache = /* @__PURE__ */ new Map();
let decodedBytes = 0;
function estimateDecodedBytes(gif) {
  let n = 0;
  for (const f of gif.frames) n += Math.max(1, f.width) * Math.max(1, f.height) * 4;
  return n;
}
function dropDecoded(entry) {
  if (decodedCache.delete(entry.key)) decodedBytes -= entry.bytes;
}
function enforceDecodedBounds() {
  const now = Date.now();
  for (const entry of [...decodedCache.values()]) {
    if (entry.expiresAt <= now) dropDecoded(entry);
  }
  if (decodedCache.size <= DECODED_MAX_ENTRIES && decodedBytes <= DECODED_MAX_BYTES) return;
  for (const entry of [...decodedCache.values()].sort((a, b) => a.usedAt - b.usedAt)) {
    if (decodedCache.size <= DECODED_MAX_ENTRIES && decodedBytes <= DECODED_MAX_BYTES) break;
    dropDecoded(entry);
  }
}
function getDecoded(key) {
  const entry = decodedCache.get(key);
  if (!entry) return void 0;
  if (entry.expiresAt <= Date.now()) {
    dropDecoded(entry);
    return void 0;
  }
  entry.usedAt = Date.now();
  return entry.value;
}
function putDecoded(key, value) {
  const existing = decodedCache.get(key);
  if (existing) dropDecoded(existing);
  const bytes = estimateDecodedBytes(value);
  decodedCache.set(key, {
    key,
    value,
    bytes,
    expiresAt: Date.now() + DECODED_TTL_MS,
    usedAt: Date.now()
  });
  decodedBytes += bytes;
  enforceDecodedBounds();
}
function clearBoardDecodedCache() {
  decodedCache.clear();
  decodedBytes = 0;
}
function subsampleFrames(gif, maxFrames) {
  const n = gif.frames.length;
  if (n <= maxFrames) return gif;
  const frames = [];
  const delays = [];
  for (let i = 0; i < maxFrames; i++) {
    const start = Math.floor(i * n / maxFrames);
    const end = Math.floor((i + 1) * n / maxFrames);
    frames.push(gif.frames[start]);
    let d = 0;
    for (let j = start; j < end; j++) d += gif.delays[j] ?? 90;
    delays.push(Math.max(20, d));
  }
  return { frames, delays };
}
function decodeGif(mod, buffer) {
  try {
    const ab = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
    const gif = parseGIF(ab);
    const frames = decompressFrames(gif, true);
    if (frames.length === 0) return null;
    const W = gif.lsd.width;
    const H = gif.lsd.height;
    const work = mod.createCanvas(W, H);
    const wctx = work.getContext("2d");
    let maxW = 1;
    let maxH = 1;
    for (const f of frames) {
      maxW = Math.max(maxW, f.dims.width);
      maxH = Math.max(maxH, f.dims.height);
    }
    const patch = mod.createCanvas(maxW, maxH);
    const pctx = patch.getContext("2d");
    const out = [];
    const delays = [];
    for (const f of frames) {
      const id = pctx.createImageData(f.dims.width, f.dims.height);
      id.data.set(f.patch);
      pctx.putImageData(id, 0, 0);
      wctx.drawImage(
        patch,
        0,
        0,
        f.dims.width,
        f.dims.height,
        f.dims.left,
        f.dims.top,
        f.dims.width,
        f.dims.height
      );
      const snap = mod.createCanvas(W, H);
      snap.getContext("2d").drawImage(work, 0, 0);
      out.push(snap);
      delays.push(f.delay && f.delay > 0 ? f.delay : 90);
      if (f.disposalType === 2) {
        wctx.clearRect(f.dims.left, f.dims.top, f.dims.width, f.dims.height);
      }
    }
    return subsampleFrames({ frames: out, delays }, BOARD_MAX_FRAMES);
  } catch (err) {
    logger.debug({ err }, "board cell GIF decode failed");
    return null;
  }
}
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (; ; ) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(Math.max(1, limit), Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}
async function loadCell(mod, image, style) {
  const gif = await renderStyleThumbGif(image, style).catch(() => null);
  if (gif) {
    const key = `decoded:${previewKey(targetHash(image), style)}`;
    let decoded = getDecoded(key);
    if (!decoded) {
      decoded = decodeGif(mod, gif) ?? void 0;
      if (decoded) putDecoded(key, decoded);
    }
    if (decoded && decoded.frames.length > 1) {
      return { frames: decoded.frames, delays: decoded.delays };
    }
  }
  const still = await renderStyleThumb(image, style).catch(() => null);
  const img = still ? await mod.loadImage(still).catch(() => null) : null;
  return { frames: [img], delays: [90] };
}
const BOARD_RESULT_MAX_ENTRIES = 8;
const BOARD_RESULT_MAX_BYTES = 16 * 1024 * 1024;
const BOARD_RESULT_TTL_MS = 10 * 60 * 1e3;
const boardResultCache = /* @__PURE__ */ new Map();
let boardResultBytes = 0;
function dropBoardResult(entry) {
  if (boardResultCache.delete(entry.key)) boardResultBytes -= entry.result.buffer.length;
}
function enforceBoardResultBounds() {
  const now = Date.now();
  for (const entry of [...boardResultCache.values()]) {
    if (entry.expiresAt <= now) dropBoardResult(entry);
  }
  if (boardResultCache.size <= BOARD_RESULT_MAX_ENTRIES && boardResultBytes <= BOARD_RESULT_MAX_BYTES) return;
  for (const entry of [...boardResultCache.values()].sort((a, b) => a.usedAt - b.usedAt)) {
    if (boardResultCache.size <= BOARD_RESULT_MAX_ENTRIES && boardResultBytes <= BOARD_RESULT_MAX_BYTES) break;
    dropBoardResult(entry);
  }
}
function boardCacheKey(opts) {
  const favs = opts.styles.filter((s) => isFavorite(opts.userId, s.value)).map((s) => s.value).join(",");
  return [
    "board:v2",
    targetHash(opts.image),
    opts.styles.map((s) => s.value).join(","),
    opts.focusValue,
    String(opts.page),
    String(opts.pages),
    String(opts.total),
    opts.format,
    opts.targetLabel,
    favs
  ].join("|");
}
function getBoardCached(key) {
  const entry = boardResultCache.get(key);
  if (!entry) return void 0;
  if (entry.expiresAt <= Date.now()) {
    dropBoardResult(entry);
    return void 0;
  }
  entry.usedAt = Date.now();
  return {
    buffer: entry.result.buffer,
    name: entry.result.name,
    animated: entry.result.animated
  };
}
function putBoardCached(key, result) {
  const existing = boardResultCache.get(key);
  if (existing) dropBoardResult(existing);
  boardResultCache.set(key, {
    key,
    result,
    expiresAt: Date.now() + BOARD_RESULT_TTL_MS,
    usedAt: Date.now()
  });
  boardResultBytes += result.buffer.length;
  enforceBoardResultBounds();
}
function clearBoardResultCache() {
  boardResultCache.clear();
  boardResultBytes = 0;
}
const composeFg = [];
const composeBg = [];
let composing = false;
function pumpCompose() {
  if (composing) return;
  const job = composeFg.shift() ?? composeBg.shift();
  if (!job) return;
  composing = true;
  job();
}
function withBoardCompose(fn, background = false) {
  return new Promise((resolve, reject) => {
    const job = () => {
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        composing = false;
        pumpCompose();
      });
    };
    (background ? composeBg : composeFg).push(job);
    pumpCompose();
  });
}
function cellCycleMs(cell) {
  if (cell.frames.length <= 1) return 0;
  return cell.delays.reduce((a, b) => a + (b > 0 ? b : 90), 0);
}
function frameAt(cell, tMs) {
  const frames = cell.frames;
  if (frames.length === 0) return null;
  if (frames.length === 1) return frames[0] ?? null;
  const cycle = cellCycleMs(cell) || 90 * frames.length;
  let t = (tMs % cycle + cycle) % cycle;
  for (let i = 0; i < frames.length; i++) {
    const d = cell.delays[i] && cell.delays[i] > 0 ? cell.delays[i] : 90;
    t -= d;
    if (t < 0) return frames[i] ?? null;
  }
  return frames[frames.length - 1] ?? null;
}
async function renderBoard(opts) {
  const cacheKey = boardCacheKey(opts);
  const cached = getBoardCached(cacheKey);
  if (cached) return cached;
  const mod = await getCanvas();
  if (!mod) return null;
  const { image, styles } = opts;
  targetHash(image);
  const [target, cells] = await Promise.all([
    mod.loadImage(image).catch(() => null),
    mapPool(styles, CELL_LOAD_CONCURRENCY, (s) => loadCell(mod, image, s.value))
  ]);
  const { width, height } = boardDims(styles.length);
  const result = await withBoardCompose(async () => {
    const raced = getBoardCached(cacheKey);
    if (raced) return raced;
    const animatedCount = cells.filter((c) => c.frames.length > 1).length;
    if (animatedCount === 0) {
      return renderStill(mod, opts, target, cells, width, height);
    }
    const animated = renderAnimated(mod, opts, target, cells, width, height);
    if (animated && animated.buffer.length <= BOARD_MAX_BYTES) return animated;
    if (animated) {
      logger.debug(
        { bytes: animated.buffer.length },
        "animated board over size budget; using still fallback"
      );
    }
    return await renderStill(mod, opts, target, cells, width, height);
  }, opts.background ?? false);
  if (result) putBoardCached(cacheKey, result);
  return result;
}
function renderAnimated(mod, opts, target, cells, width, height) {
  try {
    const canvas = mod.createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const maxCycle = Math.max(1, ...cells.map(cellCycleMs));
    const frameCount = Math.min(
      BOARD_MAX_FRAMES,
      Math.max(2, Math.round(maxCycle / 90))
    );
    const tickMs = Math.min(140, Math.max(50, Math.round(maxCycle / frameCount)));
    const chrome = mod.createCanvas(width, height);
    const chromeCtx = chrome.getContext("2d");
    const standIn = mod.createCanvas(1, 1);
    const standIns = cells.map((c) => c.frames[0] ? standIn : null);
    drawBoard(chromeCtx, opts, target, standIns);
    const { gridW } = boardDims(opts.styles.length);
    const encoder = new GIFEncoder(width, height);
    encoder.start();
    encoder.setRepeat(0);
    encoder.setQuality(BOARD_QUALITY);
    encoder.setDelay(tickMs);
    for (let f = 0; f < frameCount; f++) {
      const t = f * tickMs;
      ctx.drawImage(chrome, 0, 0, width, height);
      for (let i = 0; i < cells.length; i++) {
        const img = frameAt(cells[i], t);
        if (!img) continue;
        const { tx, ty } = cellLayout(opts.styles.length, i, gridW);
        ctx.save();
        roundRect(ctx, tx, ty, THUMB, THUMB, 10);
        ctx.clip();
        drawContain(ctx, img, tx, ty, THUMB);
        ctx.restore();
      }
      for (let i = 0; i < opts.styles.length; i++) {
        const style = opts.styles[i];
        const { x, y } = cellLayout(opts.styles.length, i, gridW);
        const selected = style.value === opts.focusValue;
        const fav = isFavorite(opts.userId, style.value);
        const bx = x + 16;
        const by = y + 16;
        ctx.fillStyle = selected ? RING : BADGE_BG;
        ctx.beginPath();
        ctx.arc(bx, by, 15, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = TEXT;
        ctx.font = `700 15px "Orbitron", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(i + 1), bx, by + 1);
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "left";
        if (fav) {
          ctx.fillStyle = STAR;
          ctx.font = `700 18px sans-serif`;
          ctx.textAlign = "right";
          ctx.fillText("\u2605", x + CELL_W - 12, by + 6);
          ctx.textAlign = "left";
        }
      }
      encoder.addFrame(ctx);
    }
    encoder.finish();
    return { buffer: encoder.out.getData(), name: BOARD_FILENAME, animated: true };
  } catch (err) {
    logger.debug({ err }, "animated board encode failed");
    return null;
  }
}
async function renderStill(mod, opts, target, cells, width, height) {
  try {
    const canvas = mod.createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    drawBoard(ctx, opts, target, cells.map((c) => c.frames[0] ?? null));
    const buffer = await canvas.encode("png");
    return { buffer, name: BOARD_FILENAME_STILL, animated: false };
  } catch (err) {
    logger.debug({ err }, "still board encode failed");
    return null;
  }
}
export {
  BOARD_FILENAME,
  BOARD_FILENAME_STILL,
  BOARD_PAGE_SIZE,
  clearBoardDecodedCache,
  clearBoardResultCache,
  renderBoard
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiYm9hcmQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gU3R5bGUgQm9hcmQgXHUyMDE0IHRoZSB2aXN1YWwgaGVhcnQgb2YgdGhlIC9lbW9qaSBkYXNoYm9hcmQuXG4vL1xuLy8gQWZ0ZXIgYSB0YXJnZXQgaXMgY2hvc2VuLCB0aGUgYnJvd3NlciBpcyBhICpjb250YWN0IHNoZWV0KjogdGhlIHBhZ2UncyBzdHlsZXNcbi8vIGFyZSBlYWNoIHJlbmRlcmVkIG9uIHRoZSB1c2VyJ3Mgb3duIGltYWdlIGFuZCB0aWxlZCBpbnRvIG9uZSBjYW52YXMsIG51bWJlcmVkLFxuLy8gc28gdGhlIHdob2xlIHBhZ2UgY2FuIGJlIGp1ZGdlZCBhdCBhIGdsYW5jZS4gVGhlIGNob3NlbiBzdHlsZSBpcyByaW5nZWQ7XG4vLyBmYXZvcml0ZXMgY2FycnkgYSBzdGFyOyB0aGUgdGFyZ2V0IGl0c2VsZiBpcyBzaG93biBpbiB0aGUgaGVhZGVyLlxuLy9cbi8vIFRoZSBib2FyZCBpcyBmdWxseSBBTklNQVRFRC4gRWFjaCBjZWxsJ3Mgc3R5bGUgaXMgcmVuZGVyZWQgYXMgYSBzbWFsbCBHSUYsIHRoZVxuLy8gZnJhbWVzIGFyZSBkZWNvZGVkIHdpdGggZ2lmdWN0LWpzLCBhbmQgdGhleSBhcmUgdGlsZWQgcGVyIGZyYW1lIGludG8gb25lXG4vLyBsb29waW5nIGJvYXJkIEdJRiAoZ2lmZW5jb2RlcikuIFNvIGV2ZXJ5IGNlbGwgbW92ZXMgYXQgb25jZSwgb24gdGhlIHVzZXIncyBvd25cbi8vIGltYWdlLiBDYW52YXMgKyBmcmFtZXMgYXJlIHVzZWQgb25seSBmb3IgdGhpcyBtZW51IGNocm9tZSBcdTIwMTQgdGhlIGVtb2ppIG91dHB1dFxuLy8gaXRzZWxmIHN0aWxsIGdvZXMgdGhyb3VnaCB0aGUgcmVuZGVyIGVuZ2luZS5cbi8vXG4vLyBQZXJmb3JtYW5jZSBub3RlcyAoc2VlIGJvYXJkLWJlbmNoKTpcbi8vICAgXHUyMDIyIENlbGwgdGh1bWIgR0lGcyBnbyB0aHJvdWdoIHRoZSBzaGFyZWQgcmVuZGVyIHF1ZXVlIChjb25jdXJyZW5jeSAzKS4gV2Vcbi8vICAgICBsb2FkIGNlbGxzIHdpdGggdGhlIHNhbWUgY29uY3VycmVuY3kgc28gb25lIGJvYXJkIGNhbm5vdCBmbG9vZCB0aGUgcXVldWUuXG4vLyAgIFx1MjAyMiBEZWNvZGVkIGNvbXBvc2l0ZWQgZnJhbWVzIGFyZSBjYWNoZWQgKGJvdW5kZWQpIHNvIHdhcm0gYm9hcmRzIHNraXAgZGVjb2RlLlxuLy8gICBcdTIwMjIgRmluaXNoZWQgYm9hcmQgR0lGcyBhcmUgY2FjaGVkIChib3VuZGVkKSBzbyBpZGVudGljYWwgcGFnZXMgYXJlIGZyZWUuXG4vLyAgIFx1MjAyMiBCb2FyZCBjaHJvbWUgaXMgcGFpbnRlZCBvbmNlIGFuZCBibGl0dGVkOyBvbmx5IHRodW1ibmFpbHMgY2hhbmdlIHBlciBmcmFtZS5cbi8vICAgXHUyMDIyIEVhY2ggY2VsbCBhZHZhbmNlcyBvbiBpdHMgb3duIGRlbGF5IHRpbWVsaW5lIChub3QgZiAlIGxlbmd0aCArIGF2ZyBkZWxheSkuXG4vLyAgIFx1MjAyMiBCb2FyZCBlbmNvZGUgaXMgc2VyaWFsaXplZCBzbyBjb25jdXJyZW50IC9lbW9qaSB1c2VycyBjYW5ub3Qgc3RhY2sgZW5jb2Rlcy5cbi8vXG4vLyBJZiB0aGUgY2FudmFzIGJhY2tlbmQgaXMgbWlzc2luZywgb3Igbm90aGluZyBvbiB0aGUgcGFnZSBhY3R1YWxseSBhbmltYXRlcywgaXRcbi8vIGRlZ3JhZGVzIHRvIGEgc3RpbGwgUE5HIGNvbnRhY3Qgc2hlZXQsIHNvIGJyb3dzaW5nIG5ldmVyIGJyZWFrcy5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5pbXBvcnQgR0lGRW5jb2RlciBmcm9tIFwiZ2lmZW5jb2RlclwiO1xuaW1wb3J0IHsgcGFyc2VHSUYsIGRlY29tcHJlc3NGcmFtZXMgfSBmcm9tIFwiZ2lmdWN0LWpzXCI7XG5pbXBvcnQgeyBnZXRDYW52YXMsIHR5cGUgQ2FudmFzTW9kIH0gZnJvbSBcIi4uLy4uL2FuaW1hdGlvbnMvZW5naW5lLmpzXCI7XG5pbXBvcnQgeyBsb2dnZXIgfSBmcm9tIFwiLi4vLi4vLi4vbGliL2xvZ2dlci5qc1wiO1xuaW1wb3J0IHtcbiAgcHJldmlld0tleSwgcmVuZGVyU3R5bGVUaHVtYiwgcmVuZGVyU3R5bGVUaHVtYkdpZiwgdGFyZ2V0SGFzaCxcbn0gZnJvbSBcIi4uL3ByZXZpZXcvaW5kZXguanNcIjtcbmltcG9ydCB7IGlzRmF2b3JpdGUgfSBmcm9tIFwiLi9mYXZvcml0ZXMuanNcIjtcbmltcG9ydCB0eXBlIHsgU3R5bGVFbnRyeSB9IGZyb20gXCIuL3N0eWxlcy1waWNrZXIuanNcIjtcblxuLyoqIFN0eWxlcyBzaG93biBvbiBvbmUgYm9hcmQgcGFnZS4gRWlnaHQgZmlsbHMgYSB0aWR5IDRcdTAwRDcyIGdyaWQgb2YgbGl2ZSBwcmV2aWV3cy4gKi9cbmV4cG9ydCBjb25zdCBCT0FSRF9QQUdFX1NJWkUgPSA4O1xuXG4vKiogQXR0YWNobWVudCBuYW1lcyBcdTIwMTQgdGhlIGV4dGVuc2lvbiBmb2xsb3dzIHdoZXRoZXIgdGhlIGJvYXJkIGFuaW1hdGVkLiAqL1xuZXhwb3J0IGNvbnN0IEJPQVJEX0ZJTEVOQU1FID0gXCJzdHlsZS1ib2FyZC5naWZcIjtcbmV4cG9ydCBjb25zdCBCT0FSRF9GSUxFTkFNRV9TVElMTCA9IFwic3R5bGUtYm9hcmQucG5nXCI7XG5cbi8qKiBGcmFtZSBjZWlsaW5nIGZvciB0aGUgdGlsZWQgYm9hcmQgR0lGIFx1MjAxNCBlbm91Z2ggZm9yIHNtb290aCBtb3Rpb24sIHNtYWxsIGZpbGUuICovXG5jb25zdCBCT0FSRF9NQVhfRlJBTUVTID0gMTQ7XG5cbi8qKlxuICogTmV1UXVhbnQgc2FtcGxlIGZhY3Rvci4gUHJvZmlsZWQgMTIgdnMgMTYgdnMgMjAgb24gYm9hcmQtc2l6ZWQgZW5jb2RlczogMTYgaXNcbiAqIH4xNVx1MjAxMzIwJSBmYXN0ZXIgdGhhbiAxMiB3aXRoIG5lYXJseSBpZGVudGljYWwgYnl0ZSBzaXplIG9uIHRoaXMgY2hyb21lLWhlYXZ5XG4gKiBpbWFnZTsgMjAgc2F2ZXMgbW9yZSBDUFUgYnV0IHN0YXJ0cyB0byBkaXJ0eSBncmFkaWVudHMuIEtlZXAgc2l6ZSBndWFyZCBiZWxvdy5cbiAqL1xuY29uc3QgQk9BUkRfUVVBTElUWSA9IDE2O1xuXG4vKiogR2l2ZSB1cCBvbiB0aGUgYW5pbWF0ZWQgYm9hcmQgYWJvdmUgdGhpcyBzaXplIGFuZCBmYWxsIGJhY2sgdG8gdGhlIHN0aWxsIFBORy4gKi9cbmNvbnN0IEJPQVJEX01BWF9CWVRFUyA9IDdfNTAwXzAwMDtcblxuLyoqIE1hdGNoIHRoZSBzaGFyZWQgcmVuZGVyLXF1ZXVlIGNvbmN1cnJlbmN5IHNvIG9uZSBib2FyZCBkb2VzIG5vdCBmbG9vZCBpdC4gKi9cbmNvbnN0IENFTExfTE9BRF9DT05DVVJSRU5DWSA9IE1hdGgubWluKDYsIE1hdGgubWF4KDIsIE51bWJlcihwcm9jZXNzLmVudltcIkVNT0pJX0JPQVJEX0NPTkNVUlJFTkNZXCJdID8/IDQpKSk7XG5cbi8vIExheW91dCBcdTIwMTQgcGxhaW4gcGl4ZWxzLiBDaHJvbWUgaXMgcGFpbnRlZCBvbmNlOyBvbmx5IGNlbGwgdGh1bWJuYWlscyBjaGFuZ2Vcbi8vIHBlciBmcmFtZS4gS2VwdCBnZW5lcm91cyBzbyBsYWJlbHMgc3RheSBsZWdpYmxlIHdoZW4gRGlzY29yZCBzY2FsZXMgdGhlIGltYWdlLlxuY29uc3QgQ09MUyA9IDQ7XG5jb25zdCBDRUxMX1cgPSAxNTA7XG5jb25zdCBDRUxMX0ggPSAxNjg7XG5jb25zdCBUSFVNQiA9IDEwNDtcbmNvbnN0IEdBUCA9IDE0O1xuY29uc3QgUEFEID0gMjA7XG5jb25zdCBIRUFERVJfSCA9IDEwMDtcblxuLy8gUGFsZXR0ZSBcdTIwMTQgRGlzY29yZCBibHVycGxlIGZhbWlseSBvbiBhIGRhcmsgY2FyZCwgc28gdGhlIGJvYXJkIHNpdHMgbmF0dXJhbGx5XG4vLyBpbiBib3RoIGxpZ2h0IGFuZCBkYXJrIGNsaWVudCB0aGVtZXMuXG5jb25zdCBCR19UT1AgPSBcIiMyYjJkNDJcIjtcbmNvbnN0IEJHX0JPVCA9IFwiIzFlMWYyZVwiO1xuY29uc3QgQ0VMTF9CRyA9IFwiIzMzMzY0YVwiO1xuY29uc3QgQ0VMTF9CR19TRUwgPSBcIiMzYjQ2NzBcIjtcbmNvbnN0IFJJTkcgPSBcIiM1ODY1ZjJcIjtcbmNvbnN0IFNUQVIgPSBcIiNmMWM0MGZcIjtcbmNvbnN0IFRFWFQgPSBcIiNlY2VlZjVcIjtcbmNvbnN0IFNVQlRMRSA9IFwiI2FhYjBjNFwiO1xuY29uc3QgQkFER0VfQkcgPSBcIiMxMjEzMWNcIjtcblxuLyoqIEFueXRoaW5nIHdpdGggYSB3aWR0aC9oZWlnaHQgdGhhdCBhIDJEIGNvbnRleHQgY2FuIGRyYXcgXHUyMDE0IGFuIEltYWdlIG9yIENhbnZhcy4gKi9cbnR5cGUgRHJhd2FibGUgPSB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH07XG5cbi8qKiBNaW5pbWFsIDJEIGNvbnRleHQgc3VyZmFjZSB0aGUgYm9hcmQgdXNlcyBcdTIwMTQgYXZvaWRzIHB1bGxpbmcgaW4gdGhlIERPTSBsaWIuICovXG5pbnRlcmZhY2UgQm9hcmRDdHgge1xuICBmaWxsU3R5bGU6IHN0cmluZyB8IG9iamVjdDtcbiAgc3Ryb2tlU3R5bGU6IHN0cmluZztcbiAgbGluZVdpZHRoOiBudW1iZXI7XG4gIGZvbnQ6IHN0cmluZztcbiAgdGV4dEFsaWduOiBzdHJpbmc7XG4gIHRleHRCYXNlbGluZTogc3RyaW5nO1xuICBnbG9iYWxBbHBoYTogbnVtYmVyO1xuICBmaWxsUmVjdCh4OiBudW1iZXIsIHk6IG51bWJlciwgdzogbnVtYmVyLCBoOiBudW1iZXIpOiB2b2lkO1xuICBmaWxsVGV4dCh0ZXh0OiBzdHJpbmcsIHg6IG51bWJlciwgeTogbnVtYmVyKTogdm9pZDtcbiAgbWVhc3VyZVRleHQodGV4dDogc3RyaW5nKTogeyB3aWR0aDogbnVtYmVyIH07XG4gIGJlZ2luUGF0aCgpOiB2b2lkO1xuICBtb3ZlVG8oeDogbnVtYmVyLCB5OiBudW1iZXIpOiB2b2lkO1xuICBsaW5lVG8oeDogbnVtYmVyLCB5OiBudW1iZXIpOiB2b2lkO1xuICBhcmMoeDogbnVtYmVyLCB5OiBudW1iZXIsIHI6IG51bWJlciwgczogbnVtYmVyLCBlOiBudW1iZXIpOiB2b2lkO1xuICBhcmNUbyh4MTogbnVtYmVyLCB5MTogbnVtYmVyLCB4MjogbnVtYmVyLCB5MjogbnVtYmVyLCByOiBudW1iZXIpOiB2b2lkO1xuICBjbG9zZVBhdGgoKTogdm9pZDtcbiAgZmlsbCgpOiB2b2lkO1xuICBzdHJva2UoKTogdm9pZDtcbiAgc2F2ZSgpOiB2b2lkO1xuICByZXN0b3JlKCk6IHZvaWQ7XG4gIGNsaXAoKTogdm9pZDtcbiAgZHJhd0ltYWdlKGltZzogdW5rbm93biwgZHg6IG51bWJlciwgZHk6IG51bWJlciwgZHc/OiBudW1iZXIsIGRoPzogbnVtYmVyKTogdm9pZDtcbiAgY3JlYXRlTGluZWFyR3JhZGllbnQoeDA6IG51bWJlciwgeTA6IG51bWJlciwgeDE6IG51bWJlciwgeTE6IG51bWJlcik6IHtcbiAgICBhZGRDb2xvclN0b3Aob2Zmc2V0OiBudW1iZXIsIGNvbG9yOiBzdHJpbmcpOiB2b2lkO1xuICB9O1xufVxuXG4vKiogQ29udGV4dCBzdXJmYWNlIHVzZWQgd2hpbGUgZGVjb2RpbmcgR0lGIGZyYW1lcyBvbnRvIHdvcmtpbmcgY2FudmFzZXMuICovXG5pbnRlcmZhY2UgRnJhbWVDdHgge1xuICBjcmVhdGVJbWFnZURhdGEodzogbnVtYmVyLCBoOiBudW1iZXIpOiB7IGRhdGE6IFVpbnQ4Q2xhbXBlZEFycmF5IH07XG4gIHB1dEltYWdlRGF0YShpbWFnZTogeyBkYXRhOiBVaW50OENsYW1wZWRBcnJheSB9LCBkeDogbnVtYmVyLCBkeTogbnVtYmVyKTogdm9pZDtcbiAgZHJhd0ltYWdlKGltZzogdW5rbm93biwgZHg6IG51bWJlciwgZHk6IG51bWJlcik6IHZvaWQ7XG4gIGRyYXdJbWFnZShcbiAgICBpbWc6IHVua25vd24sXG4gICAgc3g6IG51bWJlciwgc3k6IG51bWJlciwgc3c6IG51bWJlciwgc2g6IG51bWJlcixcbiAgICBkeDogbnVtYmVyLCBkeTogbnVtYmVyLCBkdzogbnVtYmVyLCBkaDogbnVtYmVyLFxuICApOiB2b2lkO1xuICBjbGVhclJlY3QoeDogbnVtYmVyLCB5OiBudW1iZXIsIHc6IG51bWJlciwgaDogbnVtYmVyKTogdm9pZDtcbn1cblxuZnVuY3Rpb24gcm91bmRSZWN0KFxuICBjdHg6IEJvYXJkQ3R4LCB4OiBudW1iZXIsIHk6IG51bWJlciwgdzogbnVtYmVyLCBoOiBudW1iZXIsIHI6IG51bWJlcixcbik6IHZvaWQge1xuICBjb25zdCByYWQgPSBNYXRoLm1pbihyLCB3IC8gMiwgaCAvIDIpO1xuICBjdHguYmVnaW5QYXRoKCk7XG4gIGN0eC5tb3ZlVG8oeCArIHJhZCwgeSk7XG4gIGN0eC5hcmNUbyh4ICsgdywgeSwgeCArIHcsIHkgKyBoLCByYWQpO1xuICBjdHguYXJjVG8oeCArIHcsIHkgKyBoLCB4LCB5ICsgaCwgcmFkKTtcbiAgY3R4LmFyY1RvKHgsIHkgKyBoLCB4LCB5LCByYWQpO1xuICBjdHguYXJjVG8oeCwgeSwgeCArIHcsIHksIHJhZCk7XG4gIGN0eC5jbG9zZVBhdGgoKTtcbn1cblxuLyoqIFRydW5jYXRlIGEgbGFiZWwgdG8gZml0IGBtYXhXaWR0aGAsIGFkZGluZyBhbiBlbGxpcHNpcyB3aGVuIGl0IG92ZXJmbG93cy4gKi9cbmZ1bmN0aW9uIGZpdFRleHQoY3R4OiBCb2FyZEN0eCwgdGV4dDogc3RyaW5nLCBtYXhXaWR0aDogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKGN0eC5tZWFzdXJlVGV4dCh0ZXh0KS53aWR0aCA8PSBtYXhXaWR0aCkgcmV0dXJuIHRleHQ7XG4gIGxldCB0ID0gdGV4dDtcbiAgd2hpbGUgKHQubGVuZ3RoID4gMSAmJiBjdHgubWVhc3VyZVRleHQoYCR7dH1cdTIwMjZgKS53aWR0aCA+IG1heFdpZHRoKSB7XG4gICAgdCA9IHQuc2xpY2UoMCwgLTEpO1xuICB9XG4gIHJldHVybiBgJHt0fVx1MjAyNmA7XG59XG5cbi8qKiBEcmF3IGFuIGltYWdlIGNlbnRlcmVkIGFuZCBjb250YWluZWQgaW5zaWRlIGEgc3F1YXJlIGJveC4gKi9cbmZ1bmN0aW9uIGRyYXdDb250YWluKFxuICBjdHg6IEJvYXJkQ3R4LCBpbWc6IERyYXdhYmxlLCB4OiBudW1iZXIsIHk6IG51bWJlciwgYm94OiBudW1iZXIsXG4pOiB2b2lkIHtcbiAgY29uc3Qgc2NhbGUgPSBNYXRoLm1pbihib3ggLyBpbWcud2lkdGgsIGJveCAvIGltZy5oZWlnaHQpO1xuICBjb25zdCB3ID0gaW1nLndpZHRoICogc2NhbGU7XG4gIGNvbnN0IGggPSBpbWcuaGVpZ2h0ICogc2NhbGU7XG4gIGN0eC5kcmF3SW1hZ2UoaW1nIGFzIHVua25vd24sIHggKyAoYm94IC0gdykgLyAyLCB5ICsgKGJveCAtIGgpIC8gMiwgdywgaCk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQm9hcmRPcHRpb25zIHtcbiAgaW1hZ2U6IEJ1ZmZlcjtcbiAgdGFyZ2V0TGFiZWw6IHN0cmluZztcbiAgc3R5bGVzOiBTdHlsZUVudHJ5W107XG4gIGZvY3VzVmFsdWU6IHN0cmluZztcbiAgdXNlcklkOiBzdHJpbmc7XG4gIHBhZ2U6IG51bWJlcjtcbiAgcGFnZXM6IG51bWJlcjtcbiAgdG90YWw6IG51bWJlcjtcbiAgZm9ybWF0OiBzdHJpbmc7XG4gIC8qKiBTcGVjdWxhdGl2ZSB3YXJtL3ByZWZldGNoIFx1MjAxNCBlbmNvZGVzIG9ubHkgd2hlbiBubyBvbi1kZW1hbmQgYm9hcmQgaXMgd2FpdGluZy4gKi9cbiAgYmFja2dyb3VuZD86IGJvb2xlYW47XG59XG5cbi8qKiBXaGF0IHJlbmRlckJvYXJkIGhhbmRzIGJhY2s6IHRoZSBlbmNvZGVkIGltYWdlIGFuZCB0aGUgYXR0YWNobWVudCBuYW1lIHRvIHVzZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQm9hcmRSZXN1bHQge1xuICBidWZmZXI6IEJ1ZmZlcjtcbiAgbmFtZTogc3RyaW5nO1xuICBhbmltYXRlZDogYm9vbGVhbjtcbn1cblxuLyoqIEJvYXJkIGNhbnZhcyBkaW1lbnNpb25zIGZvciBhIHBhZ2Ugb2YgYGNvdW50YCBjZWxscy4gKi9cbmZ1bmN0aW9uIGJvYXJkRGltcyhjb3VudDogbnVtYmVyKTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlcjsgZ3JpZFc6IG51bWJlcjsgcm93czogbnVtYmVyIH0ge1xuICBjb25zdCByb3dzID0gTWF0aC5tYXgoMSwgTWF0aC5jZWlsKGNvdW50IC8gQ09MUykpO1xuICBjb25zdCBncmlkVyA9IENPTFMgKiBDRUxMX1cgKyAoQ09MUyAtIDEpICogR0FQO1xuICBjb25zdCB3aWR0aCA9IFBBRCAqIDIgKyBncmlkVztcbiAgY29uc3QgaGVpZ2h0ID0gSEVBREVSX0ggKyBQQUQgKyByb3dzICogQ0VMTF9IICsgKHJvd3MgLSAxKSAqIEdBUCArIFBBRDtcbiAgcmV0dXJuIHsgd2lkdGgsIGhlaWdodCwgZ3JpZFcsIHJvd3MgfTtcbn1cblxuLyoqIExheW91dDogY2VsbCBvcmlnaW4gKyB0aHVtYiBvcmlnaW4gZm9yIGNlbGwgaW5kZXggYGlgLiAqL1xuZnVuY3Rpb24gY2VsbExheW91dChcbiAgc3R5bGVzTGVuOiBudW1iZXIsIGk6IG51bWJlciwgZ3JpZFc6IG51bWJlcixcbik6IHsgeDogbnVtYmVyOyB5OiBudW1iZXI7IHR4OiBudW1iZXI7IHR5OiBudW1iZXIgfSB7XG4gIGNvbnN0IGNvbCA9IGkgJSBDT0xTO1xuICBjb25zdCByb3cgPSBNYXRoLmZsb29yKGkgLyBDT0xTKTtcbiAgY29uc3Qgcm93Q291bnQgPSBNYXRoLm1pbihDT0xTLCBzdHlsZXNMZW4gLSByb3cgKiBDT0xTKTtcbiAgY29uc3Qgcm93VyA9IHJvd0NvdW50ICogQ0VMTF9XICsgKHJvd0NvdW50IC0gMSkgKiBHQVA7XG4gIGNvbnN0IHJvd1N0YXJ0ID0gUEFEICsgKGdyaWRXIC0gcm93VykgLyAyO1xuICBjb25zdCB4ID0gcm93U3RhcnQgKyBjb2wgKiAoQ0VMTF9XICsgR0FQKTtcbiAgY29uc3QgeSA9IEhFQURFUl9IICsgUEFEICsgcm93ICogKENFTExfSCArIEdBUCk7XG4gIHJldHVybiB7IHgsIHksIHR4OiB4ICsgKENFTExfVyAtIFRIVU1CKSAvIDIsIHR5OiB5ICsgMTYgfTtcbn1cblxuLyoqXG4gKiBEcmF3IHRoZSBjb21wbGV0ZSBib2FyZCBvbnRvIGBjdHhgIHVzaW5nIGBjZWxsSW1hZ2VzW2ldYCBmb3IgY2VsbCBpLiBTaGFyZWQgYnlcbiAqIHRoZSBzdGlsbCBwYXRoIGFuZCAodmlhIGNocm9tZSArIG92ZXJsYXkpIHRoZSBhbmltYXRlZCBwYXRoLlxuICovXG5mdW5jdGlvbiBkcmF3Qm9hcmQoXG4gIGN0eDogQm9hcmRDdHgsXG4gIG9wdHM6IEJvYXJkT3B0aW9ucyxcbiAgdGFyZ2V0OiBEcmF3YWJsZSB8IG51bGwsXG4gIGNlbGxJbWFnZXM6IChEcmF3YWJsZSB8IG51bGwpW10sXG4pOiB2b2lkIHtcbiAgY29uc3QgeyBzdHlsZXMsIGZvY3VzVmFsdWUsIHVzZXJJZCB9ID0gb3B0cztcbiAgY29uc3QgeyB3aWR0aCwgaGVpZ2h0LCBncmlkVyB9ID0gYm9hcmREaW1zKHN0eWxlcy5sZW5ndGgpO1xuXG4gIC8vIENhcmQgYmFja2dyb3VuZC5cbiAgY29uc3QgYmcgPSBjdHguY3JlYXRlTGluZWFyR3JhZGllbnQoMCwgMCwgMCwgaGVpZ2h0KTtcbiAgYmcuYWRkQ29sb3JTdG9wKDAsIEJHX1RPUCk7XG4gIGJnLmFkZENvbG9yU3RvcCgxLCBCR19CT1QpO1xuICBjdHguZmlsbFN0eWxlID0gYmcgYXMgdW5rbm93biBhcyBzdHJpbmc7XG4gIGN0eC5maWxsUmVjdCgwLCAwLCB3aWR0aCwgaGVpZ2h0KTtcblxuICAvLyBIZWFkZXI6IHRpdGxlIG9uIHRoZSBsZWZ0LCB0aGUgdGFyZ2V0IHRodW1ibmFpbCArIGxhYmVsIG9uIHRoZSByaWdodC5cbiAgY3R4LnRleHRCYXNlbGluZSA9IFwiYWxwaGFiZXRpY1wiO1xuICBjdHgudGV4dEFsaWduID0gXCJsZWZ0XCI7XG4gIGN0eC5maWxsU3R5bGUgPSBURVhUO1xuICBjdHguZm9udCA9IGA3MDAgMjZweCBcIk9yYml0cm9uXCIsIHNhbnMtc2VyaWZgO1xuICBjdHguZmlsbFRleHQoXCJTdHlsZSBCb2FyZFwiLCBQQUQsIDQ2KTtcblxuICBjdHguZmlsbFN0eWxlID0gU1VCVExFO1xuICBjdHguZm9udCA9IGA1MDAgMTVweCBzYW5zLXNlcmlmYDtcbiAgY3R4LmZpbGxUZXh0KFxuICAgIGBQYWdlICR7b3B0cy5wYWdlICsgMX0vJHtvcHRzLnBhZ2VzfSBcdTAwQjcgJHtvcHRzLnRvdGFsfSBzdHlsZXMgXHUwMEI3ICR7b3B0cy5mb3JtYXQudG9VcHBlckNhc2UoKX1gLFxuICAgIFBBRCwgNzQsXG4gICk7XG5cbiAgLy8gVGFyZ2V0IGNoaXAgKHJpZ2h0LWFsaWduZWQpOiB0aGUgcGljdHVyZSBldmVyeXRoaW5nIGJlbG93IGlzIHJlbmRlcmVkIG9uLlxuICBjb25zdCBjaGlwID0gNTY7XG4gIGNvbnN0IGNoaXBYID0gd2lkdGggLSBQQUQgLSBjaGlwO1xuICBjb25zdCBjaGlwWSA9IDI2O1xuICBjdHguZmlsbFN0eWxlID0gQkFER0VfQkc7XG4gIHJvdW5kUmVjdChjdHgsIGNoaXBYIC0gNiwgY2hpcFkgLSA2LCBjaGlwICsgMTIsIGNoaXAgKyAxMiwgMTIpO1xuICBjdHguZmlsbCgpO1xuICBpZiAodGFyZ2V0KSB7XG4gICAgY3R4LnNhdmUoKTtcbiAgICByb3VuZFJlY3QoY3R4LCBjaGlwWCwgY2hpcFksIGNoaXAsIGNoaXAsIDgpO1xuICAgIGN0eC5jbGlwKCk7XG4gICAgZHJhd0NvbnRhaW4oY3R4LCB0YXJnZXQsIGNoaXBYLCBjaGlwWSwgY2hpcCk7XG4gICAgY3R4LnJlc3RvcmUoKTtcbiAgfVxuICBjdHguZmlsbFN0eWxlID0gU1VCVExFO1xuICBjdHguZm9udCA9IGA1MDAgMTJweCBzYW5zLXNlcmlmYDtcbiAgY3R4LnRleHRBbGlnbiA9IFwicmlnaHRcIjtcbiAgY29uc3QgbGFiZWwgPSBmaXRUZXh0KGN0eCwgb3B0cy50YXJnZXRMYWJlbCwgMTUwKTtcbiAgY3R4LmZpbGxUZXh0KFwiWW91ciB0YXJnZXRcIiwgY2hpcFggLSAxMiwgNDQpO1xuICBjdHguZmlsbFN0eWxlID0gVEVYVDtcbiAgY3R4LmZvbnQgPSBgNjAwIDEzcHggc2Fucy1zZXJpZmA7XG4gIGN0eC5maWxsVGV4dChsYWJlbCwgY2hpcFggLSAxMiwgNjYpO1xuICBjdHgudGV4dEFsaWduID0gXCJsZWZ0XCI7XG5cbiAgLy8gQ2VsbHMuXG4gIHN0eWxlcy5mb3JFYWNoKChzdHlsZSwgaSkgPT4ge1xuICAgIGNvbnN0IHsgeCwgeSwgdHgsIHR5IH0gPSBjZWxsTGF5b3V0KHN0eWxlcy5sZW5ndGgsIGksIGdyaWRXKTtcbiAgICBjb25zdCBzZWxlY3RlZCA9IHN0eWxlLnZhbHVlID09PSBmb2N1c1ZhbHVlO1xuICAgIGNvbnN0IGZhdiA9IGlzRmF2b3JpdGUodXNlcklkLCBzdHlsZS52YWx1ZSk7XG4gICAgY29uc3QgaW1nID0gY2VsbEltYWdlc1tpXTtcblxuICAgIC8vIENlbGwgYmFja2dyb3VuZCArIHNlbGVjdGlvbiByaW5nLlxuICAgIGN0eC5maWxsU3R5bGUgPSBzZWxlY3RlZCA/IENFTExfQkdfU0VMIDogQ0VMTF9CRztcbiAgICByb3VuZFJlY3QoY3R4LCB4LCB5LCBDRUxMX1csIENFTExfSCwgMTQpO1xuICAgIGN0eC5maWxsKCk7XG4gICAgaWYgKHNlbGVjdGVkKSB7XG4gICAgICBjdHguc3Ryb2tlU3R5bGUgPSBSSU5HO1xuICAgICAgY3R4LmxpbmVXaWR0aCA9IDM7XG4gICAgICByb3VuZFJlY3QoY3R4LCB4ICsgMS41LCB5ICsgMS41LCBDRUxMX1cgLSAzLCBDRUxMX0ggLSAzLCAxMyk7XG4gICAgICBjdHguc3Ryb2tlKCk7XG4gICAgfVxuXG4gICAgLy8gVGh1bWJuYWlsIChvciBwbGFjZWhvbGRlcikuXG4gICAgaWYgKGltZykge1xuICAgICAgY3R4LnNhdmUoKTtcbiAgICAgIHJvdW5kUmVjdChjdHgsIHR4LCB0eSwgVEhVTUIsIFRIVU1CLCAxMCk7XG4gICAgICBjdHguY2xpcCgpO1xuICAgICAgZHJhd0NvbnRhaW4oY3R4LCBpbWcsIHR4LCB0eSwgVEhVTUIpO1xuICAgICAgY3R4LnJlc3RvcmUoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY3R4LmZpbGxTdHlsZSA9IEJBREdFX0JHO1xuICAgICAgcm91bmRSZWN0KGN0eCwgdHgsIHR5LCBUSFVNQiwgVEhVTUIsIDEwKTtcbiAgICAgIGN0eC5maWxsKCk7XG4gICAgICBjdHguZmlsbFN0eWxlID0gU1VCVExFO1xuICAgICAgY3R4LmZvbnQgPSBgNTAwIDEycHggc2Fucy1zZXJpZmA7XG4gICAgICBjdHgudGV4dEFsaWduID0gXCJjZW50ZXJcIjtcbiAgICAgIGN0eC5maWxsVGV4dChcIm5vIHByZXZpZXdcIiwgeCArIENFTExfVyAvIDIsIHR5ICsgVEhVTUIgLyAyICsgNCk7XG4gICAgICBjdHgudGV4dEFsaWduID0gXCJsZWZ0XCI7XG4gICAgfVxuXG4gICAgLy8gTnVtYmVyIGJhZGdlICh0b3AtbGVmdCBvZiB0aGUgY2VsbCkuXG4gICAgY29uc3QgYnggPSB4ICsgMTY7XG4gICAgY29uc3QgYnkgPSB5ICsgMTY7XG4gICAgY3R4LmZpbGxTdHlsZSA9IHNlbGVjdGVkID8gUklORyA6IEJBREdFX0JHO1xuICAgIGN0eC5iZWdpblBhdGgoKTtcbiAgICBjdHguYXJjKGJ4LCBieSwgMTUsIDAsIE1hdGguUEkgKiAyKTtcbiAgICBjdHguZmlsbCgpO1xuICAgIGN0eC5maWxsU3R5bGUgPSBURVhUO1xuICAgIGN0eC5mb250ID0gYDcwMCAxNXB4IFwiT3JiaXRyb25cIiwgc2Fucy1zZXJpZmA7XG4gICAgY3R4LnRleHRBbGlnbiA9IFwiY2VudGVyXCI7XG4gICAgY3R4LnRleHRCYXNlbGluZSA9IFwibWlkZGxlXCI7XG4gICAgY3R4LmZpbGxUZXh0KFN0cmluZyhpICsgMSksIGJ4LCBieSArIDEpO1xuICAgIGN0eC50ZXh0QmFzZWxpbmUgPSBcImFscGhhYmV0aWNcIjtcbiAgICBjdHgudGV4dEFsaWduID0gXCJsZWZ0XCI7XG5cbiAgICAvLyBGYXZvcml0ZSBzdGFyICh0b3AtcmlnaHQgb2YgdGhlIGNlbGwpLlxuICAgIGlmIChmYXYpIHtcbiAgICAgIGN0eC5maWxsU3R5bGUgPSBTVEFSO1xuICAgICAgY3R4LmZvbnQgPSBgNzAwIDE4cHggc2Fucy1zZXJpZmA7XG4gICAgICBjdHgudGV4dEFsaWduID0gXCJyaWdodFwiO1xuICAgICAgY3R4LmZpbGxUZXh0KFwiXHUyNjA1XCIsIHggKyBDRUxMX1cgLSAxMiwgYnkgKyA2KTtcbiAgICAgIGN0eC50ZXh0QWxpZ24gPSBcImxlZnRcIjtcbiAgICB9XG5cbiAgICAvLyBMYWJlbCB1bmRlciB0aGUgdGh1bWJuYWlsLlxuICAgIGN0eC5maWxsU3R5bGUgPSBzZWxlY3RlZCA/IFRFWFQgOiBTVUJUTEU7XG4gICAgY3R4LmZvbnQgPSBgNjAwIDE0cHggc2Fucy1zZXJpZmA7XG4gICAgY3R4LnRleHRBbGlnbiA9IFwiY2VudGVyXCI7XG4gICAgY3R4LmZpbGxUZXh0KGZpdFRleHQoY3R4LCBzdHlsZS5sYWJlbCwgQ0VMTF9XIC0gMjQpLCB4ICsgQ0VMTF9XIC8gMiwgeSArIENFTExfSCAtIDE2KTtcbiAgICBjdHgudGV4dEFsaWduID0gXCJsZWZ0XCI7XG4gIH0pO1xufVxuXG5pbnRlcmZhY2UgRGVjb2RlZEdpZiB7IGZyYW1lczogRHJhd2FibGVbXTsgZGVsYXlzOiBudW1iZXJbXSB9XG5cbi8vIFx1MjUwMFx1MjUwMCBEZWNvZGVkLWZyYW1lIGNhY2hlIChib3VuZGVkKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIFByZXZpZXcgY2FjaGUgc3RvcmVzIEdJRiAqYnl0ZXMqLiBXYXJtIGJvYXJkcyB3ZXJlIHN0aWxsIHJlLWRlY29kaW5nIHRob3NlXG4vLyBpbnRvIGNhbnZhc2VzLiBDYWNoZSBjb21wb3NpdGVkIGZyYW1lcyBmb3IgcmVjZW50IGNlbGxzIG9ubHkgXHUyMDE0IG5ldmVyIGFsbCA0NzMuXG5jb25zdCBERUNPREVEX01BWF9FTlRSSUVTID0gMjQ7XG5jb25zdCBERUNPREVEX01BWF9CWVRFUyA9IDEyICogMTAyNCAqIDEwMjQ7XG5jb25zdCBERUNPREVEX1RUTF9NUyA9IDE1ICogNjAgKiAxMDAwO1xuXG5pbnRlcmZhY2UgRGVjb2RlZENhY2hlRW50cnkge1xuICBrZXk6IHN0cmluZztcbiAgdmFsdWU6IERlY29kZWRHaWY7XG4gIGJ5dGVzOiBudW1iZXI7XG4gIGV4cGlyZXNBdDogbnVtYmVyO1xuICB1c2VkQXQ6IG51bWJlcjtcbn1cblxuY29uc3QgZGVjb2RlZENhY2hlID0gbmV3IE1hcDxzdHJpbmcsIERlY29kZWRDYWNoZUVudHJ5PigpO1xubGV0IGRlY29kZWRCeXRlcyA9IDA7XG5cbmZ1bmN0aW9uIGVzdGltYXRlRGVjb2RlZEJ5dGVzKGdpZjogRGVjb2RlZEdpZik6IG51bWJlciB7XG4gIGxldCBuID0gMDtcbiAgZm9yIChjb25zdCBmIG9mIGdpZi5mcmFtZXMpIG4gKz0gTWF0aC5tYXgoMSwgZi53aWR0aCkgKiBNYXRoLm1heCgxLCBmLmhlaWdodCkgKiA0O1xuICByZXR1cm4gbjtcbn1cblxuZnVuY3Rpb24gZHJvcERlY29kZWQoZW50cnk6IERlY29kZWRDYWNoZUVudHJ5KTogdm9pZCB7XG4gIGlmIChkZWNvZGVkQ2FjaGUuZGVsZXRlKGVudHJ5LmtleSkpIGRlY29kZWRCeXRlcyAtPSBlbnRyeS5ieXRlcztcbn1cblxuZnVuY3Rpb24gZW5mb3JjZURlY29kZWRCb3VuZHMoKTogdm9pZCB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGZvciAoY29uc3QgZW50cnkgb2YgWy4uLmRlY29kZWRDYWNoZS52YWx1ZXMoKV0pIHtcbiAgICBpZiAoZW50cnkuZXhwaXJlc0F0IDw9IG5vdykgZHJvcERlY29kZWQoZW50cnkpO1xuICB9XG4gIGlmIChkZWNvZGVkQ2FjaGUuc2l6ZSA8PSBERUNPREVEX01BWF9FTlRSSUVTICYmIGRlY29kZWRCeXRlcyA8PSBERUNPREVEX01BWF9CWVRFUykgcmV0dXJuO1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIFsuLi5kZWNvZGVkQ2FjaGUudmFsdWVzKCldLnNvcnQoKGEsIGIpID0+IGEudXNlZEF0IC0gYi51c2VkQXQpKSB7XG4gICAgaWYgKGRlY29kZWRDYWNoZS5zaXplIDw9IERFQ09ERURfTUFYX0VOVFJJRVMgJiYgZGVjb2RlZEJ5dGVzIDw9IERFQ09ERURfTUFYX0JZVEVTKSBicmVhaztcbiAgICBkcm9wRGVjb2RlZChlbnRyeSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZ2V0RGVjb2RlZChrZXk6IHN0cmluZyk6IERlY29kZWRHaWYgfCB1bmRlZmluZWQge1xuICBjb25zdCBlbnRyeSA9IGRlY29kZWRDYWNoZS5nZXQoa2V5KTtcbiAgaWYgKCFlbnRyeSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgaWYgKGVudHJ5LmV4cGlyZXNBdCA8PSBEYXRlLm5vdygpKSB7IGRyb3BEZWNvZGVkKGVudHJ5KTsgcmV0dXJuIHVuZGVmaW5lZDsgfVxuICBlbnRyeS51c2VkQXQgPSBEYXRlLm5vdygpO1xuICByZXR1cm4gZW50cnkudmFsdWU7XG59XG5cbmZ1bmN0aW9uIHB1dERlY29kZWQoa2V5OiBzdHJpbmcsIHZhbHVlOiBEZWNvZGVkR2lmKTogdm9pZCB7XG4gIGNvbnN0IGV4aXN0aW5nID0gZGVjb2RlZENhY2hlLmdldChrZXkpO1xuICBpZiAoZXhpc3RpbmcpIGRyb3BEZWNvZGVkKGV4aXN0aW5nKTtcbiAgY29uc3QgYnl0ZXMgPSBlc3RpbWF0ZURlY29kZWRCeXRlcyh2YWx1ZSk7XG4gIGRlY29kZWRDYWNoZS5zZXQoa2V5LCB7XG4gICAga2V5LCB2YWx1ZSwgYnl0ZXMsIGV4cGlyZXNBdDogRGF0ZS5ub3coKSArIERFQ09ERURfVFRMX01TLCB1c2VkQXQ6IERhdGUubm93KCksXG4gIH0pO1xuICBkZWNvZGVkQnl0ZXMgKz0gYnl0ZXM7XG4gIGVuZm9yY2VEZWNvZGVkQm91bmRzKCk7XG59XG5cbi8qKiBUZXN0L2JlbmNoIGhlbHBlciBcdTIwMTQgZG9lcyBub3QgY2xlYXIgdGhlIEdJRi1idWZmZXIgcHJldmlldyBjYWNoZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbGVhckJvYXJkRGVjb2RlZENhY2hlKCk6IHZvaWQge1xuICBkZWNvZGVkQ2FjaGUuY2xlYXIoKTtcbiAgZGVjb2RlZEJ5dGVzID0gMDtcbn1cblxuLyoqXG4gKiBFdmVubHkgc3Vic2FtcGxlIGEgbG9uZyBHSUYgZG93biB0byBgbWF4RnJhbWVzYCwgbWVyZ2luZyBkZWxheXMgc28gdGhlIGN5Y2xlXG4gKiBkdXJhdGlvbiAoYW5kIHRoZXJlZm9yZSBwbGF5YmFjayBzcGVlZCkgc3RheXMgdGhlIHNhbWUuXG4gKi9cbmZ1bmN0aW9uIHN1YnNhbXBsZUZyYW1lcyhnaWY6IERlY29kZWRHaWYsIG1heEZyYW1lczogbnVtYmVyKTogRGVjb2RlZEdpZiB7XG4gIGNvbnN0IG4gPSBnaWYuZnJhbWVzLmxlbmd0aDtcbiAgaWYgKG4gPD0gbWF4RnJhbWVzKSByZXR1cm4gZ2lmO1xuICBjb25zdCBmcmFtZXM6IERyYXdhYmxlW10gPSBbXTtcbiAgY29uc3QgZGVsYXlzOiBudW1iZXJbXSA9IFtdO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IG1heEZyYW1lczsgaSsrKSB7XG4gICAgY29uc3Qgc3RhcnQgPSBNYXRoLmZsb29yKChpICogbikgLyBtYXhGcmFtZXMpO1xuICAgIGNvbnN0IGVuZCA9IE1hdGguZmxvb3IoKChpICsgMSkgKiBuKSAvIG1heEZyYW1lcyk7XG4gICAgZnJhbWVzLnB1c2goZ2lmLmZyYW1lc1tzdGFydF0hKTtcbiAgICBsZXQgZCA9IDA7XG4gICAgZm9yIChsZXQgaiA9IHN0YXJ0OyBqIDwgZW5kOyBqKyspIGQgKz0gZ2lmLmRlbGF5c1tqXSA/PyA5MDtcbiAgICBkZWxheXMucHVzaChNYXRoLm1heCgyMCwgZCkpO1xuICB9XG4gIHJldHVybiB7IGZyYW1lcywgZGVsYXlzIH07XG59XG5cbi8qKlxuICogRGVjb2RlIGEgR0lGIGludG8gZnVsbHktY29tcG9zaXRlZCBwZXItZnJhbWUgY2FudmFzZXMuXG4gKlxuICogT3VyIHRodW1ibmFpbHMgY29tZSBmcm9tIHRoZSBlbW9qaSBlbmNvZGVyLCB3aGljaCB3cml0ZXMgZnVsbCBmcmFtZXMgd2l0aCBhXG4gKiB0cmFuc3BhcmVudCBrZXkgYW5kIFwicmVzdG9yZSB0byBiYWNrZ3JvdW5kXCIgZGlzcG9zYWwuIENvbXBvc2l0aW5nIHdpdGhcbiAqIGBkcmF3SW1hZ2VgIChzb3VyY2Utb3Zlcikga2VlcHMgdGhlIHByZXZpb3VzIGZyYW1lIHdoZXJlIGEgcGF0Y2ggaXNcbiAqIHRyYW5zcGFyZW50OyBhIGRpc3Bvc2FsIG9mIDIgY2xlYXJzIHRoZSByZWdpb24gZmlyc3QgXHUyMDE0IGJldHdlZW4gdGhlbSB0aGlzIGRyYXdzXG4gKiBldmVyeSBmcmFtZSBjb3JyZWN0bHkgcmVnYXJkbGVzcyBvZiBob3cgdGhlIGVuY29kZXIgb3B0aW1pc2VkIGl0LlxuICpcbiAqIE9uZSByZXVzYWJsZSBwYXRjaCBjYW52YXMgKG1heCBmcmFtZSBkaW1zKSByZXBsYWNlcyBhIG5ldyBwYXRjaCBwZXIgc291cmNlXG4gKiBmcmFtZS4gU25hcHNob3RzIHJlbWFpbiBvbmUgY2FudmFzIHBlciBjb21wb3NpdGVkIGZyYW1lIFx1MjAxNCB0aG9zZSBhcmUgd2hhdCB0aGVcbiAqIGJvYXJkIGRyYXdzLiBMb25nIHNvdXJjZSBHSUZzIGFyZSBldmVubHkgc3Vic2FtcGxlZCB0byBCT0FSRF9NQVhfRlJBTUVTLlxuICovXG5mdW5jdGlvbiBkZWNvZGVHaWYobW9kOiBDYW52YXNNb2QsIGJ1ZmZlcjogQnVmZmVyKTogRGVjb2RlZEdpZiB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IGFiID0gYnVmZmVyLmJ1ZmZlci5zbGljZShcbiAgICAgIGJ1ZmZlci5ieXRlT2Zmc2V0LCBidWZmZXIuYnl0ZU9mZnNldCArIGJ1ZmZlci5ieXRlTGVuZ3RoLFxuICAgICkgYXMgQXJyYXlCdWZmZXI7XG4gICAgY29uc3QgZ2lmID0gcGFyc2VHSUYoYWIpO1xuICAgIGNvbnN0IGZyYW1lcyA9IGRlY29tcHJlc3NGcmFtZXMoZ2lmLCB0cnVlKTtcbiAgICBpZiAoZnJhbWVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cbiAgICBjb25zdCBXID0gZ2lmLmxzZC53aWR0aDtcbiAgICBjb25zdCBIID0gZ2lmLmxzZC5oZWlnaHQ7XG4gICAgY29uc3Qgd29yayA9IG1vZC5jcmVhdGVDYW52YXMoVywgSCk7XG4gICAgY29uc3Qgd2N0eCA9IHdvcmsuZ2V0Q29udGV4dChcIjJkXCIpIGFzIHVua25vd24gYXMgRnJhbWVDdHg7XG5cbiAgICBsZXQgbWF4VyA9IDE7XG4gICAgbGV0IG1heEggPSAxO1xuICAgIGZvciAoY29uc3QgZiBvZiBmcmFtZXMpIHtcbiAgICAgIG1heFcgPSBNYXRoLm1heChtYXhXLCBmLmRpbXMud2lkdGgpO1xuICAgICAgbWF4SCA9IE1hdGgubWF4KG1heEgsIGYuZGltcy5oZWlnaHQpO1xuICAgIH1cbiAgICBjb25zdCBwYXRjaCA9IG1vZC5jcmVhdGVDYW52YXMobWF4VywgbWF4SCk7XG4gICAgY29uc3QgcGN0eCA9IHBhdGNoLmdldENvbnRleHQoXCIyZFwiKSBhcyB1bmtub3duIGFzIEZyYW1lQ3R4O1xuXG4gICAgY29uc3Qgb3V0OiBEcmF3YWJsZVtdID0gW107XG4gICAgY29uc3QgZGVsYXlzOiBudW1iZXJbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZiBvZiBmcmFtZXMpIHtcbiAgICAgIGNvbnN0IGlkID0gcGN0eC5jcmVhdGVJbWFnZURhdGEoZi5kaW1zLndpZHRoLCBmLmRpbXMuaGVpZ2h0KTtcbiAgICAgIGlkLmRhdGEuc2V0KGYucGF0Y2gpO1xuICAgICAgcGN0eC5wdXRJbWFnZURhdGEoaWQsIDAsIDApO1xuXG4gICAgICB3Y3R4LmRyYXdJbWFnZShcbiAgICAgICAgcGF0Y2ggYXMgdW5rbm93bixcbiAgICAgICAgMCwgMCwgZi5kaW1zLndpZHRoLCBmLmRpbXMuaGVpZ2h0LFxuICAgICAgICBmLmRpbXMubGVmdCwgZi5kaW1zLnRvcCwgZi5kaW1zLndpZHRoLCBmLmRpbXMuaGVpZ2h0LFxuICAgICAgKTtcblxuICAgICAgY29uc3Qgc25hcCA9IG1vZC5jcmVhdGVDYW52YXMoVywgSCk7XG4gICAgICAoc25hcC5nZXRDb250ZXh0KFwiMmRcIikgYXMgdW5rbm93biBhcyBGcmFtZUN0eCkuZHJhd0ltYWdlKHdvcmsgYXMgdW5rbm93biwgMCwgMCk7XG4gICAgICBvdXQucHVzaChzbmFwIGFzIHVua25vd24gYXMgRHJhd2FibGUpO1xuICAgICAgZGVsYXlzLnB1c2goZi5kZWxheSAmJiBmLmRlbGF5ID4gMCA/IGYuZGVsYXkgOiA5MCk7XG5cbiAgICAgIGlmIChmLmRpc3Bvc2FsVHlwZSA9PT0gMikge1xuICAgICAgICB3Y3R4LmNsZWFyUmVjdChmLmRpbXMubGVmdCwgZi5kaW1zLnRvcCwgZi5kaW1zLndpZHRoLCBmLmRpbXMuaGVpZ2h0KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHN1YnNhbXBsZUZyYW1lcyh7IGZyYW1lczogb3V0LCBkZWxheXMgfSwgQk9BUkRfTUFYX0ZSQU1FUyk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGxvZ2dlci5kZWJ1Zyh7IGVyciB9LCBcImJvYXJkIGNlbGwgR0lGIGRlY29kZSBmYWlsZWRcIik7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLyoqIE9uZSBjZWxsJ3MgZnJhbWVzIChcdTIyNjUxKSBwbHVzIHRoZSBkZWxheXMgdGhhdCBwcm9kdWNlZCB0aGVtLiAqL1xuaW50ZXJmYWNlIENlbGwgeyBmcmFtZXM6IChEcmF3YWJsZSB8IG51bGwpW107IGRlbGF5czogbnVtYmVyW10gfVxuXG4vKiogUnVuIGBpdGVtc2AgdGhyb3VnaCBgZm5gIHdpdGggYXQgbW9zdCBgbGltaXRgIGluIGZsaWdodC4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1hcFBvb2w8VCwgUj4oXG4gIGl0ZW1zOiByZWFkb25seSBUW10sXG4gIGxpbWl0OiBudW1iZXIsXG4gIGZuOiAoaXRlbTogVCwgaW5kZXg6IG51bWJlcikgPT4gUHJvbWlzZTxSPixcbik6IFByb21pc2U8UltdPiB7XG4gIGNvbnN0IG91dCA9IG5ldyBBcnJheTxSPihpdGVtcy5sZW5ndGgpO1xuICBsZXQgbmV4dCA9IDA7XG4gIGFzeW5jIGZ1bmN0aW9uIHdvcmtlcigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBmb3IgKDs7KSB7XG4gICAgICBjb25zdCBpID0gbmV4dCsrO1xuICAgICAgaWYgKGkgPj0gaXRlbXMubGVuZ3RoKSByZXR1cm47XG4gICAgICBvdXRbaV0gPSBhd2FpdCBmbihpdGVtc1tpXSEsIGkpO1xuICAgIH1cbiAgfVxuICBjb25zdCBuID0gTWF0aC5taW4oTWF0aC5tYXgoMSwgbGltaXQpLCBNYXRoLm1heCgxLCBpdGVtcy5sZW5ndGgpKTtcbiAgYXdhaXQgUHJvbWlzZS5hbGwoQXJyYXkuZnJvbSh7IGxlbmd0aDogbiB9LCAoKSA9PiB3b3JrZXIoKSkpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogRmV0Y2ggYSBjZWxsIGFzIGRlY29kZWQgYW5pbWF0ZWQgZnJhbWVzLCBmYWxsaW5nIGJhY2sgdG8gYSBzaW5nbGUgc3RpbGwuICovXG5hc3luYyBmdW5jdGlvbiBsb2FkQ2VsbChtb2Q6IENhbnZhc01vZCwgaW1hZ2U6IEJ1ZmZlciwgc3R5bGU6IHN0cmluZyk6IFByb21pc2U8Q2VsbD4ge1xuICBjb25zdCBnaWYgPSBhd2FpdCByZW5kZXJTdHlsZVRodW1iR2lmKGltYWdlLCBzdHlsZSkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gIGlmIChnaWYpIHtcbiAgICAvLyBUaGUgdGh1bWIgR0lGIGlzIHVuaXF1ZWx5IGlkZW50aWZpZWQgYnkgKHRhcmdldCBpbWFnZSwgc3R5bGUpIFx1MjAxNCB0aGUgc2FtZVxuICAgIC8vIGtleSB0aGUgYnVmZmVyIGNhY2hlIHVzZXMgXHUyMDE0IHNvIGtleSB0aGUgZGVjb2RlZCBjYWNoZSBieSBpZGVudGl0eSB0b28uIFRoYXRcbiAgICAvLyBpcyBjb2xsaXNpb24tZnJlZSBhbmQgYXZvaWRzIGZpbmdlcnByaW50aW5nIGJ5dGVzIG9uIGV2ZXJ5IGNlbGwgbG9hZC5cbiAgICBjb25zdCBrZXkgPSBgZGVjb2RlZDoke3ByZXZpZXdLZXkodGFyZ2V0SGFzaChpbWFnZSksIHN0eWxlKX1gO1xuICAgIGxldCBkZWNvZGVkID0gZ2V0RGVjb2RlZChrZXkpO1xuICAgIGlmICghZGVjb2RlZCkge1xuICAgICAgZGVjb2RlZCA9IGRlY29kZUdpZihtb2QsIGdpZikgPz8gdW5kZWZpbmVkO1xuICAgICAgaWYgKGRlY29kZWQpIHB1dERlY29kZWQoa2V5LCBkZWNvZGVkKTtcbiAgICB9XG4gICAgaWYgKGRlY29kZWQgJiYgZGVjb2RlZC5mcmFtZXMubGVuZ3RoID4gMSkge1xuICAgICAgcmV0dXJuIHsgZnJhbWVzOiBkZWNvZGVkLmZyYW1lcywgZGVsYXlzOiBkZWNvZGVkLmRlbGF5cyB9O1xuICAgIH1cbiAgfVxuICBjb25zdCBzdGlsbCA9IGF3YWl0IHJlbmRlclN0eWxlVGh1bWIoaW1hZ2UsIHN0eWxlKS5jYXRjaCgoKSA9PiBudWxsKTtcbiAgY29uc3QgaW1nID0gc3RpbGwgPyBhd2FpdCBtb2QubG9hZEltYWdlKHN0aWxsKS5jYXRjaCgoKSA9PiBudWxsKSA6IG51bGw7XG4gIHJldHVybiB7IGZyYW1lczogW2ltZyBhcyB1bmtub3duIGFzIERyYXdhYmxlIHwgbnVsbF0sIGRlbGF5czogWzkwXSB9O1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgQm9hcmQgcmVzdWx0IGNhY2hlIChib3VuZGVkKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbi8vIFdhcm0gcGF0aCB3aXRob3V0IHRoaXMgc3RpbGwgcmUtZGVjb2RlZCArIHJlLWVuY29kZWQgKH4wLjZzKS4gQ2FjaGUgYSBmZXdcbi8vIHJlY2VudCBwYWdlIEdJRnMga2V5ZWQgYnkgdGFyZ2V0ICsgc3R5bGVzICsgZm9jdXMgKyBmYXZvcml0ZXMuXG5jb25zdCBCT0FSRF9SRVNVTFRfTUFYX0VOVFJJRVMgPSA4O1xuY29uc3QgQk9BUkRfUkVTVUxUX01BWF9CWVRFUyA9IDE2ICogMTAyNCAqIDEwMjQ7XG5jb25zdCBCT0FSRF9SRVNVTFRfVFRMX01TID0gMTAgKiA2MCAqIDEwMDA7XG5cbmludGVyZmFjZSBCb2FyZENhY2hlRW50cnkge1xuICBrZXk6IHN0cmluZztcbiAgcmVzdWx0OiBCb2FyZFJlc3VsdDtcbiAgZXhwaXJlc0F0OiBudW1iZXI7XG4gIHVzZWRBdDogbnVtYmVyO1xufVxuXG5jb25zdCBib2FyZFJlc3VsdENhY2hlID0gbmV3IE1hcDxzdHJpbmcsIEJvYXJkQ2FjaGVFbnRyeT4oKTtcbmxldCBib2FyZFJlc3VsdEJ5dGVzID0gMDtcblxuZnVuY3Rpb24gZHJvcEJvYXJkUmVzdWx0KGVudHJ5OiBCb2FyZENhY2hlRW50cnkpOiB2b2lkIHtcbiAgaWYgKGJvYXJkUmVzdWx0Q2FjaGUuZGVsZXRlKGVudHJ5LmtleSkpIGJvYXJkUmVzdWx0Qnl0ZXMgLT0gZW50cnkucmVzdWx0LmJ1ZmZlci5sZW5ndGg7XG59XG5cbmZ1bmN0aW9uIGVuZm9yY2VCb2FyZFJlc3VsdEJvdW5kcygpOiB2b2lkIHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBbLi4uYm9hcmRSZXN1bHRDYWNoZS52YWx1ZXMoKV0pIHtcbiAgICBpZiAoZW50cnkuZXhwaXJlc0F0IDw9IG5vdykgZHJvcEJvYXJkUmVzdWx0KGVudHJ5KTtcbiAgfVxuICBpZiAoXG4gICAgYm9hcmRSZXN1bHRDYWNoZS5zaXplIDw9IEJPQVJEX1JFU1VMVF9NQVhfRU5UUklFU1xuICAgICYmIGJvYXJkUmVzdWx0Qnl0ZXMgPD0gQk9BUkRfUkVTVUxUX01BWF9CWVRFU1xuICApIHJldHVybjtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBbLi4uYm9hcmRSZXN1bHRDYWNoZS52YWx1ZXMoKV0uc29ydCgoYSwgYikgPT4gYS51c2VkQXQgLSBiLnVzZWRBdCkpIHtcbiAgICBpZiAoXG4gICAgICBib2FyZFJlc3VsdENhY2hlLnNpemUgPD0gQk9BUkRfUkVTVUxUX01BWF9FTlRSSUVTXG4gICAgICAmJiBib2FyZFJlc3VsdEJ5dGVzIDw9IEJPQVJEX1JFU1VMVF9NQVhfQllURVNcbiAgICApIGJyZWFrO1xuICAgIGRyb3BCb2FyZFJlc3VsdChlbnRyeSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYm9hcmRDYWNoZUtleShvcHRzOiBCb2FyZE9wdGlvbnMpOiBzdHJpbmcge1xuICBjb25zdCBmYXZzID0gb3B0cy5zdHlsZXNcbiAgICAuZmlsdGVyKHMgPT4gaXNGYXZvcml0ZShvcHRzLnVzZXJJZCwgcy52YWx1ZSkpXG4gICAgLm1hcChzID0+IHMudmFsdWUpXG4gICAgLmpvaW4oXCIsXCIpO1xuICByZXR1cm4gW1xuICAgIFwiYm9hcmQ6djJcIixcbiAgICB0YXJnZXRIYXNoKG9wdHMuaW1hZ2UpLFxuICAgIG9wdHMuc3R5bGVzLm1hcChzID0+IHMudmFsdWUpLmpvaW4oXCIsXCIpLFxuICAgIG9wdHMuZm9jdXNWYWx1ZSxcbiAgICBTdHJpbmcob3B0cy5wYWdlKSxcbiAgICBTdHJpbmcob3B0cy5wYWdlcyksXG4gICAgU3RyaW5nKG9wdHMudG90YWwpLFxuICAgIG9wdHMuZm9ybWF0LFxuICAgIG9wdHMudGFyZ2V0TGFiZWwsXG4gICAgZmF2cyxcbiAgXS5qb2luKFwifFwiKTtcbn1cblxuZnVuY3Rpb24gZ2V0Qm9hcmRDYWNoZWQoa2V5OiBzdHJpbmcpOiBCb2FyZFJlc3VsdCB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IGVudHJ5ID0gYm9hcmRSZXN1bHRDYWNoZS5nZXQoa2V5KTtcbiAgaWYgKCFlbnRyeSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgaWYgKGVudHJ5LmV4cGlyZXNBdCA8PSBEYXRlLm5vdygpKSB7IGRyb3BCb2FyZFJlc3VsdChlbnRyeSk7IHJldHVybiB1bmRlZmluZWQ7IH1cbiAgZW50cnkudXNlZEF0ID0gRGF0ZS5ub3coKTtcbiAgcmV0dXJuIHtcbiAgICBidWZmZXI6IGVudHJ5LnJlc3VsdC5idWZmZXIsXG4gICAgbmFtZTogZW50cnkucmVzdWx0Lm5hbWUsXG4gICAgYW5pbWF0ZWQ6IGVudHJ5LnJlc3VsdC5hbmltYXRlZCxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcHV0Qm9hcmRDYWNoZWQoa2V5OiBzdHJpbmcsIHJlc3VsdDogQm9hcmRSZXN1bHQpOiB2b2lkIHtcbiAgY29uc3QgZXhpc3RpbmcgPSBib2FyZFJlc3VsdENhY2hlLmdldChrZXkpO1xuICBpZiAoZXhpc3RpbmcpIGRyb3BCb2FyZFJlc3VsdChleGlzdGluZyk7XG4gIGJvYXJkUmVzdWx0Q2FjaGUuc2V0KGtleSwge1xuICAgIGtleSwgcmVzdWx0LCBleHBpcmVzQXQ6IERhdGUubm93KCkgKyBCT0FSRF9SRVNVTFRfVFRMX01TLCB1c2VkQXQ6IERhdGUubm93KCksXG4gIH0pO1xuICBib2FyZFJlc3VsdEJ5dGVzICs9IHJlc3VsdC5idWZmZXIubGVuZ3RoO1xuICBlbmZvcmNlQm9hcmRSZXN1bHRCb3VuZHMoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyQm9hcmRSZXN1bHRDYWNoZSgpOiB2b2lkIHtcbiAgYm9hcmRSZXN1bHRDYWNoZS5jbGVhcigpO1xuICBib2FyZFJlc3VsdEJ5dGVzID0gMDtcbn1cblxuLy8gU2VyaWFsaXplIGJvYXJkICplbmNvZGUqIHdvcmsgYWNyb3NzIHVzZXJzLiBDZWxsIHJlbmRlcnMgYWxyZWFkeSBnbyB0aHJvdWdoXG4vLyB0aGUgc2hhcmVkIHJlbmRlciBxdWV1ZTsgZW5jb2RpbmcgYSB+NjgyXHUwMEQ3NDkwXHUwMEQ3MTQgR0lGIGlzIHRoZSBvdGhlciBDUFUgc3Bpa2UuXG4vLyBEbyBOT1Qgd3JhcCB0aGlzIGluIHF1ZXVlUmVuZGVyIFx1MjAxNCBsb2FkQ2VsbCBhd2FpdHMgcXVldWVkIG9mZmxpbmUgcmVuZGVycyBhbmRcbi8vIHdvdWxkIGRlYWRsb2NrIChjZWxscyBhcmUgbG9hZGVkIGJlZm9yZSB0aGUgZW5jb2RlLCBzbyB0aGlzIGxhbmUgbmV2ZXIgbmVzdHMpLlxuLy9cbi8vIFR3byBsYW5lczogYSBmb3JlZ3JvdW5kIGpvYiAoYSBib2FyZCB0aGUgdXNlciBpcyB3YWl0aW5nIG9uKSBhbHdheXMgcnVuc1xuLy8gYmVmb3JlIGFueSBxdWV1ZWQgYmFja2dyb3VuZCBqb2IgKGEgc3BlY3VsYXRpdmUgd2FybSBvciBuZWlnaGJvdXIgcHJlZmV0Y2gpLFxuLy8gc28gc3BlY3VsYXRpdmUgZW5jb2RlcyBjYW4gbmV2ZXIgZGVsYXkgYW4gb24tZGVtYW5kIG9uZS4gU3RpbGwgb25lIGF0IGEgdGltZSxcbi8vIHNvIGNvbmN1cnJlbnQgdXNlcnMgY2FuJ3Qgc3RhY2sgZW5jb2Rlcy5cbmNvbnN0IGNvbXBvc2VGZzogKCgpID0+IHZvaWQpW10gPSBbXTtcbmNvbnN0IGNvbXBvc2VCZzogKCgpID0+IHZvaWQpW10gPSBbXTtcbmxldCBjb21wb3NpbmcgPSBmYWxzZTtcblxuZnVuY3Rpb24gcHVtcENvbXBvc2UoKTogdm9pZCB7XG4gIGlmIChjb21wb3NpbmcpIHJldHVybjtcbiAgY29uc3Qgam9iID0gY29tcG9zZUZnLnNoaWZ0KCkgPz8gY29tcG9zZUJnLnNoaWZ0KCk7XG4gIGlmICgham9iKSByZXR1cm47XG4gIGNvbXBvc2luZyA9IHRydWU7XG4gIGpvYigpO1xufVxuXG5mdW5jdGlvbiB3aXRoQm9hcmRDb21wb3NlPFQ+KGZuOiAoKSA9PiBUIHwgUHJvbWlzZTxUPiwgYmFja2dyb3VuZCA9IGZhbHNlKTogUHJvbWlzZTxUPiB7XG4gIHJldHVybiBuZXcgUHJvbWlzZTxUPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3Qgam9iID0gKCk6IHZvaWQgPT4ge1xuICAgICAgUHJvbWlzZS5yZXNvbHZlKCkudGhlbihmbikudGhlbihyZXNvbHZlLCByZWplY3QpLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICBjb21wb3NpbmcgPSBmYWxzZTtcbiAgICAgICAgcHVtcENvbXBvc2UoKTtcbiAgICAgIH0pO1xuICAgIH07XG4gICAgKGJhY2tncm91bmQgPyBjb21wb3NlQmcgOiBjb21wb3NlRmcpLnB1c2goam9iKTtcbiAgICBwdW1wQ29tcG9zZSgpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gY2VsbEN5Y2xlTXMoY2VsbDogQ2VsbCk6IG51bWJlciB7XG4gIGlmIChjZWxsLmZyYW1lcy5sZW5ndGggPD0gMSkgcmV0dXJuIDA7XG4gIHJldHVybiBjZWxsLmRlbGF5cy5yZWR1Y2UoKGEsIGIpID0+IGEgKyAoYiA+IDAgPyBiIDogOTApLCAwKTtcbn1cblxuLyoqIFBpY2sgdGhlIGZyYW1lIHRoYXQgc2hvdWxkIHNob3cgYXQgdGltZSBgdE1zYCBpbnRvIHRoaXMgY2VsbCdzIGxvb3AuICovXG5mdW5jdGlvbiBmcmFtZUF0KGNlbGw6IENlbGwsIHRNczogbnVtYmVyKTogRHJhd2FibGUgfCBudWxsIHtcbiAgY29uc3QgZnJhbWVzID0gY2VsbC5mcmFtZXM7XG4gIGlmIChmcmFtZXMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgaWYgKGZyYW1lcy5sZW5ndGggPT09IDEpIHJldHVybiBmcmFtZXNbMF0gPz8gbnVsbDtcbiAgY29uc3QgY3ljbGUgPSBjZWxsQ3ljbGVNcyhjZWxsKSB8fCA5MCAqIGZyYW1lcy5sZW5ndGg7XG4gIGxldCB0ID0gKCh0TXMgJSBjeWNsZSkgKyBjeWNsZSkgJSBjeWNsZTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBmcmFtZXMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBkID0gY2VsbC5kZWxheXNbaV0gJiYgY2VsbC5kZWxheXNbaV0hID4gMCA/IGNlbGwuZGVsYXlzW2ldISA6IDkwO1xuICAgIHQgLT0gZDtcbiAgICBpZiAodCA8IDApIHJldHVybiBmcmFtZXNbaV0gPz8gbnVsbDtcbiAgfVxuICByZXR1cm4gZnJhbWVzW2ZyYW1lcy5sZW5ndGggLSAxXSA/PyBudWxsO1xufVxuXG4vKipcbiAqIFJlbmRlciB0aGUgY29udGFjdC1zaGVldCBib2FyZCBmb3Igb25lIHBhZ2Ugb2Ygc3R5bGVzIFx1MjAxNCBhbmltYXRlZCB3aGVuIHRoZSBwYWdlXG4gKiBoYXMgbW90aW9uLCBhIHN0aWxsIFBORyBvdGhlcndpc2UuXG4gKlxuICogUmV0dXJucyBudWxsIHdoZW4gdGhlIGNhbnZhcyBiYWNrZW5kIGlzIHVuYXZhaWxhYmxlLCBzbyB0aGUgY2FsbGVyIGNhbiBkcm9wIHRoZVxuICogYm9hcmQgaW1hZ2UgYW5kIGtlZXAgdGhlIHJlc3Qgb2YgdGhlIGRhc2hib2FyZC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlbmRlckJvYXJkKG9wdHM6IEJvYXJkT3B0aW9ucyk6IFByb21pc2U8Qm9hcmRSZXN1bHQgfCBudWxsPiB7XG4gIGNvbnN0IGNhY2hlS2V5ID0gYm9hcmRDYWNoZUtleShvcHRzKTtcbiAgY29uc3QgY2FjaGVkID0gZ2V0Qm9hcmRDYWNoZWQoY2FjaGVLZXkpO1xuICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuXG4gIGNvbnN0IG1vZCA9IGF3YWl0IGdldENhbnZhcygpO1xuICBpZiAoIW1vZCkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgeyBpbWFnZSwgc3R5bGVzIH0gPSBvcHRzO1xuXG4gIC8vIEhhc2ggb25jZSB1cC1mcm9udCBzbyB0aHVtYiBjYWNoZSBrZXlzIHJldXNlIHRoZSBXZWFrTWFwLWNhY2hlZCBkaWdlc3QuXG4gIHRhcmdldEhhc2goaW1hZ2UpO1xuXG4gIGNvbnN0IFt0YXJnZXQsIGNlbGxzXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICBtb2QubG9hZEltYWdlKGltYWdlKS5jYXRjaCgoKSA9PiBudWxsKSBhcyBQcm9taXNlPERyYXdhYmxlIHwgbnVsbD4sXG4gICAgbWFwUG9vbChzdHlsZXMsIENFTExfTE9BRF9DT05DVVJSRU5DWSwgcyA9PiBsb2FkQ2VsbChtb2QsIGltYWdlLCBzLnZhbHVlKSksXG4gIF0pO1xuXG4gIGNvbnN0IHsgd2lkdGgsIGhlaWdodCB9ID0gYm9hcmREaW1zKHN0eWxlcy5sZW5ndGgpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHdpdGhCb2FyZENvbXBvc2UoYXN5bmMgKCkgPT4ge1xuICAgIC8vIEFub3RoZXIgY2FsbGVyIG1heSBoYXZlIGZpbmlzaGVkIHRoZSBzYW1lIHBhZ2Ugd2hpbGUgd2UgbG9hZGVkIGNlbGxzLlxuICAgIGNvbnN0IHJhY2VkID0gZ2V0Qm9hcmRDYWNoZWQoY2FjaGVLZXkpO1xuICAgIGlmIChyYWNlZCkgcmV0dXJuIHJhY2VkO1xuXG4gICAgY29uc3QgYW5pbWF0ZWRDb3VudCA9IGNlbGxzLmZpbHRlcihjID0+IGMuZnJhbWVzLmxlbmd0aCA+IDEpLmxlbmd0aDtcbiAgICBpZiAoYW5pbWF0ZWRDb3VudCA9PT0gMCkge1xuICAgICAgcmV0dXJuIHJlbmRlclN0aWxsKG1vZCwgb3B0cywgdGFyZ2V0LCBjZWxscywgd2lkdGgsIGhlaWdodCk7XG4gICAgfVxuXG4gICAgY29uc3QgYW5pbWF0ZWQgPSByZW5kZXJBbmltYXRlZChtb2QsIG9wdHMsIHRhcmdldCwgY2VsbHMsIHdpZHRoLCBoZWlnaHQpO1xuICAgIGlmIChhbmltYXRlZCAmJiBhbmltYXRlZC5idWZmZXIubGVuZ3RoIDw9IEJPQVJEX01BWF9CWVRFUykgcmV0dXJuIGFuaW1hdGVkO1xuICAgIGlmIChhbmltYXRlZCkge1xuICAgICAgbG9nZ2VyLmRlYnVnKFxuICAgICAgICB7IGJ5dGVzOiBhbmltYXRlZC5idWZmZXIubGVuZ3RoIH0sXG4gICAgICAgIFwiYW5pbWF0ZWQgYm9hcmQgb3ZlciBzaXplIGJ1ZGdldDsgdXNpbmcgc3RpbGwgZmFsbGJhY2tcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBhd2FpdCByZW5kZXJTdGlsbChtb2QsIG9wdHMsIHRhcmdldCwgY2VsbHMsIHdpZHRoLCBoZWlnaHQpO1xuICB9LCBvcHRzLmJhY2tncm91bmQgPz8gZmFsc2UpO1xuXG4gIGlmIChyZXN1bHQpIHB1dEJvYXJkQ2FjaGVkKGNhY2hlS2V5LCByZXN1bHQpO1xuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIFRpbGUgdGhlIGNlbGxzJyBmcmFtZXMgaW50byBvbmUgbG9vcGluZyBib2FyZCBHSUYuXG4gKlxuICogVGltaW5nOiBlYWNoIGNlbGwgYWR2YW5jZXMgb24gaXRzIG93biBkZWxheSB0aW1lbGluZSAobm90IGBmICUgbGVuZ3RoYCB3aXRoIGFcbiAqIGdsb2JhbCBhdmVyYWdlKS4gQm9hcmQgdGlja3MgYXJlIHVuaWZvcm07IHBlci10aWNrIHdlIHNhbXBsZSBlYWNoIGNlbGwgYXQgdGhlXG4gKiBzYW1lIHdhbGwtY2xvY2sgYHRgLiBDaHJvbWUgKGJnL2hlYWRlci9sYWJlbHMvcmluZ3MpIGlzIHBhaW50ZWQgb25jZSBhbmRcbiAqIGJsaXR0ZWQgZWFjaCBmcmFtZTsgb25seSB0aHVtYm5haWxzIGFyZSByZWRyYXduLiBCYWRnZXMvc3RhcnMgYXJlIHJlZHJhd24gb25cbiAqIHRvcCBzbyB0aGV5IHN0YXkgYWJvdmUgdGhlIGFuaW1hdGVkIHRodW1iLlxuICovXG5mdW5jdGlvbiByZW5kZXJBbmltYXRlZChcbiAgbW9kOiBDYW52YXNNb2QsXG4gIG9wdHM6IEJvYXJkT3B0aW9ucyxcbiAgdGFyZ2V0OiBEcmF3YWJsZSB8IG51bGwsXG4gIGNlbGxzOiBDZWxsW10sXG4gIHdpZHRoOiBudW1iZXIsXG4gIGhlaWdodDogbnVtYmVyLFxuKTogQm9hcmRSZXN1bHQgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjYW52YXMgPSBtb2QuY3JlYXRlQ2FudmFzKHdpZHRoLCBoZWlnaHQpO1xuICAgIGNvbnN0IGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KFwiMmRcIikgYXMgdW5rbm93biBhcyBCb2FyZEN0eDtcblxuICAgIGNvbnN0IG1heEN5Y2xlID0gTWF0aC5tYXgoMSwgLi4uY2VsbHMubWFwKGNlbGxDeWNsZU1zKSk7XG4gICAgY29uc3QgZnJhbWVDb3VudCA9IE1hdGgubWluKFxuICAgICAgQk9BUkRfTUFYX0ZSQU1FUyxcbiAgICAgIE1hdGgubWF4KDIsIE1hdGgucm91bmQobWF4Q3ljbGUgLyA5MCkpLFxuICAgICk7XG4gICAgY29uc3QgdGlja01zID0gTWF0aC5taW4oMTQwLCBNYXRoLm1heCg1MCwgTWF0aC5yb3VuZChtYXhDeWNsZSAvIGZyYW1lQ291bnQpKSk7XG5cbiAgICAvLyBTdGF0aWMgY2hyb21lIG9uY2UgXHUyMDE0IHN0YW5kLWluIHRodW1icyBzbyBcIm5vIHByZXZpZXdcIiBpcyBub3QgYmFrZWQgaW4gZm9yXG4gICAgLy8gY2VsbHMgdGhhdCB3aWxsIHJlY2VpdmUgcmVhbCBmcmFtZXMsIHdoaWxlIGVtcHR5IGNlbGxzIGtlZXAgdGhlaXIgcGxhY2Vob2xkZXIuXG4gICAgY29uc3QgY2hyb21lID0gbW9kLmNyZWF0ZUNhbnZhcyh3aWR0aCwgaGVpZ2h0KTtcbiAgICBjb25zdCBjaHJvbWVDdHggPSBjaHJvbWUuZ2V0Q29udGV4dChcIjJkXCIpIGFzIHVua25vd24gYXMgQm9hcmRDdHg7XG4gICAgY29uc3Qgc3RhbmRJbiA9IG1vZC5jcmVhdGVDYW52YXMoMSwgMSkgYXMgdW5rbm93biBhcyBEcmF3YWJsZTtcbiAgICBjb25zdCBzdGFuZElucyA9IGNlbGxzLm1hcChjID0+IChjLmZyYW1lc1swXSA/IHN0YW5kSW4gOiBudWxsKSk7XG4gICAgZHJhd0JvYXJkKGNocm9tZUN0eCwgb3B0cywgdGFyZ2V0LCBzdGFuZElucyk7XG5cbiAgICBjb25zdCB7IGdyaWRXIH0gPSBib2FyZERpbXMob3B0cy5zdHlsZXMubGVuZ3RoKTtcblxuICAgIGNvbnN0IGVuY29kZXIgPSBuZXcgR0lGRW5jb2Rlcih3aWR0aCwgaGVpZ2h0KTtcbiAgICBlbmNvZGVyLnN0YXJ0KCk7XG4gICAgZW5jb2Rlci5zZXRSZXBlYXQoMCk7XG4gICAgZW5jb2Rlci5zZXRRdWFsaXR5KEJPQVJEX1FVQUxJVFkpO1xuICAgIGVuY29kZXIuc2V0RGVsYXkodGlja01zKTtcblxuICAgIGZvciAobGV0IGYgPSAwOyBmIDwgZnJhbWVDb3VudDsgZisrKSB7XG4gICAgICBjb25zdCB0ID0gZiAqIHRpY2tNcztcbiAgICAgIGN0eC5kcmF3SW1hZ2UoY2hyb21lIGFzIHVua25vd24sIDAsIDAsIHdpZHRoLCBoZWlnaHQpO1xuXG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNlbGxzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IGltZyA9IGZyYW1lQXQoY2VsbHNbaV0hLCB0KTtcbiAgICAgICAgaWYgKCFpbWcpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCB7IHR4LCB0eSB9ID0gY2VsbExheW91dChvcHRzLnN0eWxlcy5sZW5ndGgsIGksIGdyaWRXKTtcbiAgICAgICAgY3R4LnNhdmUoKTtcbiAgICAgICAgcm91bmRSZWN0KGN0eCwgdHgsIHR5LCBUSFVNQiwgVEhVTUIsIDEwKTtcbiAgICAgICAgY3R4LmNsaXAoKTtcbiAgICAgICAgZHJhd0NvbnRhaW4oY3R4LCBpbWcsIHR4LCB0eSwgVEhVTUIpO1xuICAgICAgICBjdHgucmVzdG9yZSgpO1xuICAgICAgfVxuXG4gICAgICAvLyBCYWRnZXMgKyBzdGFycyBhYm92ZSB0aGUgdGh1bWIgKHNhbWUgc3RhY2tpbmcgYXMgdGhlIHN0aWxsIHBhdGgpLlxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBvcHRzLnN0eWxlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICBjb25zdCBzdHlsZSA9IG9wdHMuc3R5bGVzW2ldITtcbiAgICAgICAgY29uc3QgeyB4LCB5IH0gPSBjZWxsTGF5b3V0KG9wdHMuc3R5bGVzLmxlbmd0aCwgaSwgZ3JpZFcpO1xuICAgICAgICBjb25zdCBzZWxlY3RlZCA9IHN0eWxlLnZhbHVlID09PSBvcHRzLmZvY3VzVmFsdWU7XG4gICAgICAgIGNvbnN0IGZhdiA9IGlzRmF2b3JpdGUob3B0cy51c2VySWQsIHN0eWxlLnZhbHVlKTtcbiAgICAgICAgY29uc3QgYnggPSB4ICsgMTY7XG4gICAgICAgIGNvbnN0IGJ5ID0geSArIDE2O1xuICAgICAgICBjdHguZmlsbFN0eWxlID0gc2VsZWN0ZWQgPyBSSU5HIDogQkFER0VfQkc7XG4gICAgICAgIGN0eC5iZWdpblBhdGgoKTtcbiAgICAgICAgY3R4LmFyYyhieCwgYnksIDE1LCAwLCBNYXRoLlBJICogMik7XG4gICAgICAgIGN0eC5maWxsKCk7XG4gICAgICAgIGN0eC5maWxsU3R5bGUgPSBURVhUO1xuICAgICAgICBjdHguZm9udCA9IGA3MDAgMTVweCBcIk9yYml0cm9uXCIsIHNhbnMtc2VyaWZgO1xuICAgICAgICBjdHgudGV4dEFsaWduID0gXCJjZW50ZXJcIjtcbiAgICAgICAgY3R4LnRleHRCYXNlbGluZSA9IFwibWlkZGxlXCI7XG4gICAgICAgIGN0eC5maWxsVGV4dChTdHJpbmcoaSArIDEpLCBieCwgYnkgKyAxKTtcbiAgICAgICAgY3R4LnRleHRCYXNlbGluZSA9IFwiYWxwaGFiZXRpY1wiO1xuICAgICAgICBjdHgudGV4dEFsaWduID0gXCJsZWZ0XCI7XG4gICAgICAgIGlmIChmYXYpIHtcbiAgICAgICAgICBjdHguZmlsbFN0eWxlID0gU1RBUjtcbiAgICAgICAgICBjdHguZm9udCA9IGA3MDAgMThweCBzYW5zLXNlcmlmYDtcbiAgICAgICAgICBjdHgudGV4dEFsaWduID0gXCJyaWdodFwiO1xuICAgICAgICAgIGN0eC5maWxsVGV4dChcIlx1MjYwNVwiLCB4ICsgQ0VMTF9XIC0gMTIsIGJ5ICsgNik7XG4gICAgICAgICAgY3R4LnRleHRBbGlnbiA9IFwibGVmdFwiO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGVuY29kZXIuYWRkRnJhbWUoY3R4IGFzIHVua25vd24gYXMgbmV2ZXIpO1xuICAgIH1cbiAgICBlbmNvZGVyLmZpbmlzaCgpO1xuXG4gICAgcmV0dXJuIHsgYnVmZmVyOiBlbmNvZGVyLm91dC5nZXREYXRhKCksIG5hbWU6IEJPQVJEX0ZJTEVOQU1FLCBhbmltYXRlZDogdHJ1ZSB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dnZXIuZGVidWcoeyBlcnIgfSwgXCJhbmltYXRlZCBib2FyZCBlbmNvZGUgZmFpbGVkXCIpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKiBEcmF3IGEgb25lLWZyYW1lIGJvYXJkIGFuZCBlbmNvZGUgaXQgYXMgYSBQTkcuICovXG5hc3luYyBmdW5jdGlvbiByZW5kZXJTdGlsbChcbiAgbW9kOiBDYW52YXNNb2QsXG4gIG9wdHM6IEJvYXJkT3B0aW9ucyxcbiAgdGFyZ2V0OiBEcmF3YWJsZSB8IG51bGwsXG4gIGNlbGxzOiBDZWxsW10sXG4gIHdpZHRoOiBudW1iZXIsXG4gIGhlaWdodDogbnVtYmVyLFxuKTogUHJvbWlzZTxCb2FyZFJlc3VsdCB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBjYW52YXMgPSBtb2QuY3JlYXRlQ2FudmFzKHdpZHRoLCBoZWlnaHQpO1xuICAgIGNvbnN0IGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KFwiMmRcIikgYXMgdW5rbm93biBhcyBCb2FyZEN0eDtcbiAgICBkcmF3Qm9hcmQoY3R4LCBvcHRzLCB0YXJnZXQsIGNlbGxzLm1hcChjID0+IGMuZnJhbWVzWzBdID8/IG51bGwpKTtcbiAgICBjb25zdCBidWZmZXIgPSBhd2FpdCBjYW52YXMuZW5jb2RlKFwicG5nXCIpO1xuICAgIHJldHVybiB7IGJ1ZmZlciwgbmFtZTogQk9BUkRfRklMRU5BTUVfU1RJTEwsIGFuaW1hdGVkOiBmYWxzZSB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBsb2dnZXIuZGVidWcoeyBlcnIgfSwgXCJzdGlsbCBib2FyZCBlbmNvZGUgZmFpbGVkXCIpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUEyQkEsT0FBTyxnQkFBZ0I7QUFDdkIsU0FBUyxVQUFVLHdCQUF3QjtBQUMzQyxTQUFTLGlCQUFpQztBQUMxQyxTQUFTLGNBQWM7QUFDdkI7QUFBQSxFQUNFO0FBQUEsRUFBWTtBQUFBLEVBQWtCO0FBQUEsRUFBcUI7QUFBQSxPQUM5QztBQUNQLFNBQVMsa0JBQWtCO0FBSXBCLE1BQU0sa0JBQWtCO0FBR3hCLE1BQU0saUJBQWlCO0FBQ3ZCLE1BQU0sdUJBQXVCO0FBR3BDLE1BQU0sbUJBQW1CO0FBT3pCLE1BQU0sZ0JBQWdCO0FBR3RCLE1BQU0sa0JBQWtCO0FBR3hCLE1BQU0sd0JBQXdCLEtBQUssSUFBSSxHQUFHLEtBQUssSUFBSSxHQUFHLE9BQU8sUUFBUSxJQUFJLHlCQUF5QixLQUFLLENBQUMsQ0FBQyxDQUFDO0FBSTFHLE1BQU0sT0FBTztBQUNiLE1BQU0sU0FBUztBQUNmLE1BQU0sU0FBUztBQUNmLE1BQU0sUUFBUTtBQUNkLE1BQU0sTUFBTTtBQUNaLE1BQU0sTUFBTTtBQUNaLE1BQU0sV0FBVztBQUlqQixNQUFNLFNBQVM7QUFDZixNQUFNLFNBQVM7QUFDZixNQUFNLFVBQVU7QUFDaEIsTUFBTSxjQUFjO0FBQ3BCLE1BQU0sT0FBTztBQUNiLE1BQU0sT0FBTztBQUNiLE1BQU0sT0FBTztBQUNiLE1BQU0sU0FBUztBQUNmLE1BQU0sV0FBVztBQStDakIsU0FBUyxVQUNQLEtBQWUsR0FBVyxHQUFXLEdBQVcsR0FBVyxHQUNyRDtBQUNOLFFBQU0sTUFBTSxLQUFLLElBQUksR0FBRyxJQUFJLEdBQUcsSUFBSSxDQUFDO0FBQ3BDLE1BQUksVUFBVTtB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
