import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getCanvas } from "../../../animations/engine.js";
import { EmojiError } from "../../utils/errors.js";
import { offlinePackageRoot } from "./registry.js";
function assetsRoot() {
  const root = offlinePackageRoot();
  return root ? join(root, "assets") : null;
}
function resolveAssetDir(kind, slug) {
  const root = assetsRoot();
  if (!root) return null;
  const base = join(root, kind);
  const candidates = [
    slug,
    slug.replace(/-/g, ""),
    // banana-dance → bananaDance
    slug.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    // pepe-flag stays pepe-flag; party-parrot stays
  ];
  if (!existsSync(base)) return null;
  const entries = readdirSync(base);
  for (const c of candidates) {
    const hit = entries.find((e) => e === c || e.toLowerCase() === c.toLowerCase());
    if (hit) {
      const path = join(base, hit);
      if (existsSync(path)) return path;
    }
  }
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = norm(slug);
  const fuzzy = entries.find((e) => norm(e) === want);
  return fuzzy ? join(base, fuzzy) : null;
}
function listFrameFiles(dir) {
  const files = readdirSync(dir).filter((f) => /\.(webp|png|avif|gif)$/i.test(f));
  return files.sort((a, b) => {
    const ca = /chunk-(\d+)/i.exec(a);
    const cb = /chunk-(\d+)/i.exec(b);
    if (ca && cb) return Number(ca[1]) - Number(cb[1]);
    const fa = /frame_(\d+)/i.exec(a);
    const fb = /frame_(\d+)/i.exec(b);
    if (fa && fb) return Number(fa[1]) - Number(fb[1]);
    const na = /^(\d+)\./.exec(a);
    const nb = /^(\d+)\./.exec(b);
    if (na && nb) return Number(na[1]) - Number(nb[1]);
    return a.localeCompare(b);
  }).map((f) => join(dir, f));
}
function findHole(data, w, h, threshold = 40) {
  const isClear = (x, y) => data[(y * w + x) * 4 + 3] < threshold;
  let oMinX = w, oMinY = h, oMaxX = 0, oMaxY = 0, opaque = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isClear(x, y)) continue;
      opaque++;
      if (x < oMinX) oMinX = x;
      if (y < oMinY) oMinY = y;
      if (x > oMaxX) oMaxX = x;
      if (y > oMaxY) oMaxY = y;
    }
  }
  if (opaque < 16) {
    return { x: 0, y: 0, w, h, frac: 1 };
  }
  const seen = new Uint8Array(w * h);
  const regions = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (seen[idx] || !isClear(x, y)) continue;
      const stack = [idx];
      seen[idx] = 1;
      let minX2 = x, minY2 = y, maxX2 = x, maxY2 = y, count2 = 0, border = false;
      while (stack.length) {
        const i = stack.pop();
        const cx = i % w, cy = i / w | 0;
        count2++;
        if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) border = true;
        if (cx < minX2) minX2 = cx;
        if (cy < minY2) minY2 = cy;
        if (cx > maxX2) maxX2 = cx;
        if (cy > maxY2) maxY2 = cy;
        for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (seen[ni] || !isClear(nx, ny)) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
      if (count2 >= 16) regions.push({ minX: minX2, minY: minY2, maxX: maxX2, maxY: maxY2, count: count2, border });
    }
  }
  const interior = regions.filter((r) => !r.border).sort((a, b) => b.count - a.count);
  if (interior[0]) {
    const r = interior[0];
    return {
      x: r.minX,
      y: r.minY,
      w: r.maxX - r.minX + 1,
      h: r.maxY - r.minY + 1,
      frac: r.count / (w * h)
    };
  }
  let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
  for (let y = oMinY + 1; y < oMaxY; y++) {
    for (let x = oMinX + 1; x < oMaxX; x++) {
      if (!isClear(x, y)) continue;
      count++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (count < 16) {
    return { x: 0, y: 0, w, h, frac: 1 };
  }
  return {
    x: minX,
    y: minY,
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    frac: count / (w * h)
  };
}
function fitContain(sw, sh, boxW, boxH) {
  const scale = Math.min(boxW / Math.max(1, sw), boxH / Math.max(1, sh));
  return { w: sw * scale, h: sh * scale };
}
function detectTileSize(w, h, data) {
  const cands = [];
  const preferred = [56, 64, 68, 72, 80, 96, 102, 104, 112, 128, 130, 136, 152, 170, 208];
  const twSet = new Set(preferred);
  for (let d = 48; d <= Math.min(w, h); d++) {
    if (w % d === 0 && h % d === 0) twSet.add(d);
  }
  if (w <= 160 && h <= 160) return null;
  for (const tw of twSet) {
    if (w % tw !== 0 || h % tw !== 0) continue;
    const cols = w / tw, rows = h / tw;
    const cells = cols * rows;
    if (cells < 6 || cells > 64) continue;
    if (cols < 2 || rows < 2) continue;
    const opaque = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let op = 0;
        for (let y = 0; y < tw; y += 2) {
          for (let x = 0; x < tw; x += 2) {
            const gx = c * tw + x, gy = r * tw + y;
            if (data[(gy * w + gx) * 4 + 3] > 40) op++;
          }
        }
        opaque.push(op);
      }
    }
    const mean = opaque.reduce((a, b) => a + b, 0) / opaque.length;
    const vari = opaque.reduce((a, b) => a + (b - mean) ** 2, 0) / opaque.length;
    const nonempty = opaque.filter((t) => t > tw * tw * 0.01).length;
    if (nonempty < 4) continue;
    if (vari < 100) continue;
    let edgeBleed = 0, edgeSamples = 0;
    const band = Math.max(1, Math.floor(tw * 0.08));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cellOp = opaque[r * cols + c];
        if (cellOp <= tw * tw * 0.01) continue;
        for (let y = 0; y < tw; y += 2) {
          for (let x = 0; x < tw; x += 2) {
            const onEdge = x < band || y < band || x >= tw - band || y >= tw - band;
            if (!onEdge) continue;
            edgeSamples++;
            const gx = c * tw + x, gy = r * tw + y;
            if (data[(gy * w + gx) * 4 + 3] > 40) edgeBleed++;
          }
        }
      }
    }
    const bleed = edgeSamples ? edgeBleed / edgeSamples : 1;
    cands.push({ tw, th: tw, cols, rows, vari, nonempty, cells, bleed });
  }
  cands.sort((a, b) => {
    const bleedDelta = a.bleed - b.bleed;
    if (Math.abs(bleedDelta) > 0.04) return bleedDelta;
    const ideal = (n) => n >= 6 && n <= 24 ? 1e3 + n : n;
    const idealDelta = ideal(b.nonempty) - ideal(a.nonempty);
    if (idealDelta !== 0) return idealDelta;
    return b.vari - a.vari;
  });
  const best = cands[0];
  return best ? { tw: best.tw, th: best.th } : null;
}
async function expandOneFile(mod, file, maxFrames) {
  const out = [];
  const buf = readFileSync(file);
  const probeImg = await mod.loadImage(buf);
  const probe = mod.createCanvas(probeImg.width, probeImg.height);
  const probeCtx = probe.getContext("2d");
  probeCtx.clearRect(0, 0, probeImg.width, probeImg.height);
  probeCtx.drawImage(probeImg, 0, 0, probeImg.width, probeImg.height);
  const raw = probeCtx.getImageData(0, 0, probeImg.width, probeImg.height);
  const tile = detectTileSize(probeImg.width, probeImg.height, raw.data);
  if (tile) {
    const { tw, th } = tile;
    const cols = probeImg.width / tw;
    const rows = probeImg.height / th;
    try {
      const sharp = (await import("sharp")).default;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (out.length >= maxFrames) break;
          const cropped = await sharp(buf).extract({ left: c * tw, top: r * th, width: tw, height: th }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          let op = 0;
          for (let i = 3; i < cropped.data.length; i += 4) if (cropped.data[i] > 40) op++;
          if (op < tw * th * 0.02) continue;
          const png = await sharp(cropped.data, {
            raw: { width: tw, height: th, channels: 4 }
          }).png().toBuffer();
          const img = await mod.loadImage(png);
          out.push({ img, w: tw, h: th });
        }
      }
    } catch {
    }
  }
  if (out.length === 0) {
    out.push({ img: probeImg, w: probeImg.width, h: probeImg.height });
  }
  return out;
}
async function expandToOverlayFrames(mod, files, maxFrames) {
  const out = [];
  const used = files.length > maxFrames ? files.filter((_, i) => i % Math.ceil(files.length / maxFrames) === 0).slice(0, maxFrames) : files;
  for (const file of used) {
    if (out.length >= maxFrames) break;
    try {
      const frames = await expandOneFile(mod, file, maxFrames - out.length);
      out.push(...frames);
    } catch {
    }
  }
  return out;
}
async function composeSequence(input) {
  const mod = await getCanvas();
  if (!mod) {
    throw new EmojiError(
      "canvas_missing",
      "The image renderer isn't available right now. Please try again later."
    );
  }
  const files = listFrameFiles(input.sequenceDir);
  if (files.length === 0) {
    throw new EmojiError("unknown_effect", `No frames in ${input.sequenceDir}`);
  }
  const max = input.maxFrames ?? 24;
  let subject;
  try {
    subject = await mod.loadImage(input.image);
  } catch {
    throw new EmojiError("not_an_image", "Source image could not be read.");
  }
  const overlays = await expandToOverlayFrames(mod, files, max);
  const size = input.size;
  const out = [];
  for (const overlay of overlays) {
    const probe = mod.createCanvas(overlay.w, overlay.h);
    const probeCtx = probe.getContext("2d");
    probeCtx.clearRect(0, 0, overlay.w, overlay.h);
    probeCtx.drawImage(overlay.img, 0, 0, overlay.w, overlay.h);
    const probeData = probeCtx.getImageData(0, 0, overlay.w, overlay.h);
    const hole = findHole(probeData.data, overlay.w, overlay.h);
    const sx = size / overlay.w;
    const sy = size / overlay.h;
    const holeBox = {
      x: hole.x * sx,
      y: hole.y * sy,
      w: hole.w * sx,
      h: hole.h * sy
    };
    const inset = hole.frac > 0.85 ? 0.78 : hole.frac > 0.5 ? 0.88 : 0.92;
    const fitted = fitContain(subject.width, subject.height, holeBox.w * inset, holeBox.h * inset);
    const dx = holeBox.x + (holeBox.w - fitted.w) / 2;
    const dy = holeBox.y + (holeBox.h - fitted.h) / 2;
    const frameCanvas = mod.createCanvas(size, size);
    const ctx = frameCanvas.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(subject, dx, dy, fitted.w, fitted.h);
    ctx.drawImage(overlay.img, 0, 0, size, size);
    out.push(new Uint8ClampedArray(ctx.getImageData(0, 0, size, size).data));
  }
  if (out.length === 0) {
    throw new EmojiError("encode_failed", "Atlas/frame sequence produced no frames.");
  }
  return out;
}
function resolveAtlasDir(slug) {
  return resolveAssetDir("atlases", slug);
}
function resolveFramesDir(slug) {
  return resolveAssetDir("frames", slug);
}
export {
  composeSequence,
  resolveAssetDir,
  resolveAtlasDir,
  resolveFramesDir
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiYXRsYXMudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gQXRsYXMgLyBmcmFtZS1zZXF1ZW5jZSBjb21wb3NpdG9ycyBmb3IgdGhlIG9mZmxpbmUgTWFrZUVtb2ppIGVuZ2luZS5cbi8vXG4vLyBNYWtlRW1vamkgc2hpcHMgYW5pbWF0ZWQgXCJjaGFyYWN0ZXJcIiBzdHlsZXMgYXMgV2ViUCBhdGxhcyBjaHVua3MgKGFuZCBzb21lIGFzXG4gLy8gbnVtYmVyZWQgUE5HIGZyYW1lcykuIEVhY2ggY2h1bmsgaXMgYSBmdWxsLWZyYW1lIG92ZXJsYXkgd2l0aCBhIHRyYW5zcGFyZW50XG4vLyBob2xlIGZvciB0aGUgc3ViamVjdCBcdTIwMTQgc2FtZSBwbGFjZW1lbnQgbW9kZWwgYXMgc3RhdGljIG92ZXJsYXlzLCBidXQgTiBmcmFtZXMuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZGRpclN5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBDYW52YXMgfSBmcm9tIFwiQG5hcGktcnMvY2FudmFzXCI7XG5pbXBvcnQgeyBnZXRDYW52YXMsIHR5cGUgQ2FudmFzTW9kLCB0eXBlIEN0eCB9IGZyb20gXCIuLi8uLi8uLi9hbmltYXRpb25zL2VuZ2luZS5qc1wiO1xuaW1wb3J0IHsgRW1vamlFcnJvciB9IGZyb20gXCIuLi8uLi91dGlscy9lcnJvcnMuanNcIjtcbmltcG9ydCB7IG9mZmxpbmVQYWNrYWdlUm9vdCB9IGZyb20gXCIuL3JlZ2lzdHJ5LmpzXCI7XG5cbmludGVyZmFjZSBQaXhlbEJ1ZmZlciB7XG4gIGRhdGE6IFVpbnQ4Q2xhbXBlZEFycmF5O1xuICB3aWR0aDogbnVtYmVyO1xuICBoZWlnaHQ6IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIFBpeGVsQ3R4IHtcbiAgZ2V0SW1hZ2VEYXRhKHN4OiBudW1iZXIsIHN5OiBudW1iZXIsIHN3OiBudW1iZXIsIHNoOiBudW1iZXIpOiBQaXhlbEJ1ZmZlcjtcbiAgZHJhd0ltYWdlKHNvdXJjZTogQ2FudmFzLCBkeDogbnVtYmVyLCBkeTogbnVtYmVyLCBkdzogbnVtYmVyLCBkaDogbnVtYmVyKTogdm9pZDtcbn1cblxuZnVuY3Rpb24gYXNzZXRzUm9vdCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3Qgcm9vdCA9IG9mZmxpbmVQYWNrYWdlUm9vdCgpO1xuICByZXR1cm4gcm9vdCA/IGpvaW4ocm9vdCwgXCJhc3NldHNcIikgOiBudWxsO1xufVxuXG4vKioga2ViYWItY2FzZSBcdTIxOTQgY2FtZWxDYXNlIC8gcmF3IENETiBmb2xkZXIgbmFtZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQXNzZXREaXIoa2luZDogXCJhdGxhc2VzXCIgfCBcImZyYW1lc1wiLCBzbHVnOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3Qgcm9vdCA9IGFzc2V0c1Jvb3QoKTtcbiAgaWYgKCFyb290KSByZXR1cm4gbnVsbDtcbiAgY29uc3QgYmFzZSA9IGpvaW4ocm9vdCwga2luZCk7XG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBbXG4gICAgc2x1ZyxcbiAgICBzbHVnLnJlcGxhY2UoLy0vZywgXCJcIiksXG4gICAgLy8gYmFuYW5hLWRhbmNlIFx1MjE5MiBiYW5hbmFEYW5jZVxuICAgIHNsdWcucmVwbGFjZSgvLShbYS16XSkvZywgKF8sIGM6IHN0cmluZykgPT4gYy50b1VwcGVyQ2FzZSgpKSxcbiAgICAvLyBwZXBlLWZsYWcgc3RheXMgcGVwZS1mbGFnOyBwYXJ0eS1wYXJyb3Qgc3RheXNcbiAgXTtcbiAgLy8gQWxzbyBzY2FuIGRpcmVjdG9yeSBmb3IgY2FzZS1pbnNlbnNpdGl2ZSAvIGtlYmFiIG1hdGNoLlxuICBpZiAoIWV4aXN0c1N5bmMoYmFzZSkpIHJldHVybiBudWxsO1xuICBjb25zdCBlbnRyaWVzID0gcmVhZGRpclN5bmMoYmFzZSk7XG4gIGZvciAoY29uc3QgYyBvZiBjYW5kaWRhdGVzKSB7XG4gICAgY29uc3QgaGl0ID0gZW50cmllcy5maW5kKGUgPT4gZSA9PT0gYyB8fCBlLnRvTG93ZXJDYXNlKCkgPT09IGMudG9Mb3dlckNhc2UoKSk7XG4gICAgaWYgKGhpdCkge1xuICAgICAgY29uc3QgcGF0aCA9IGpvaW4oYmFzZSwgaGl0KTtcbiAgICAgIGlmIChleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gcGF0aDtcbiAgICB9XG4gIH1cbiAgLy8gZnV6enk6IHN0cmlwIG5vbi1hbG51bVxuICBjb25zdCBub3JtID0gKHM6IHN0cmluZykgPT4gcy50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1teYS16MC05XS9nLCBcIlwiKTtcbiAgY29uc3Qgd2FudCA9IG5vcm0oc2x1Zyk7XG4gIGNvbnN0IGZ1enp5ID0gZW50cmllcy5maW5kKGUgPT4gbm9ybShlKSA9PT0gd2FudCk7XG4gIHJldHVybiBmdXp6eSA/IGpvaW4oYmFzZSwgZnV6enkpIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gbGlzdEZyYW1lRmlsZXMoZGlyOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGZpbGVzID0gcmVhZGRpclN5bmMoZGlyKS5maWx0ZXIoZiA9PiAvXFwuKHdlYnB8cG5nfGF2aWZ8Z2lmKSQvaS50ZXN0KGYpKTtcbiAgLy8gUHJlZmVyIGNodW5rLU5OTi0qIG9yZGVyLCB0aGVuIGZyYW1lX05OTk4sIHRoZW4gbnVtZXJpYy5cbiAgcmV0dXJuIGZpbGVzLnNvcnQoKGEsIGIpID0+IHtcbiAgICBjb25zdCBjYSA9IC9jaHVuay0oXFxkKykvaS5leGVjKGEpO1xuICAgIGNvbnN0IGNiID0gL2NodW5rLShcXGQrKS9pLmV4ZWMoYik7XG4gICAgaWYgKGNhICYmIGNiKSByZXR1cm4gTnVtYmVyKGNhWzFdKSAtIE51bWJlcihjYlsxXSk7XG4gICAgY29uc3QgZmEgPSAvZnJhbWVfKFxcZCspL2kuZXhlYyhhKTtcbiAgICBjb25zdCBmYiA9IC9mcmFtZV8oXFxkKykvaS5leGVjKGIpO1xuICAgIGlmIChmYSAmJiBmYikgcmV0dXJuIE51bWJlcihmYVsxXSkgLSBOdW1iZXIoZmJbMV0pO1xuICAgIGNvbnN0IG5hID0gL14oXFxkKylcXC4vLmV4ZWMoYSk7XG4gICAgY29uc3QgbmIgPSAvXihcXGQrKVxcLi8uZXhlYyhiKTtcbiAgICBpZiAobmEgJiYgbmIpIHJldHVybiBOdW1iZXIobmFbMV0pIC0gTnVtYmVyKG5iWzFdKTtcbiAgICByZXR1cm4gYS5sb2NhbGVDb21wYXJlKGIpO1xuICB9KS5tYXAoZiA9PiBqb2luKGRpciwgZikpO1xufVxuXG4vKipcbiAqIEZpbmQgdGhlIHN1YmplY3QgaG9sZTogdGhlIGxhcmdlc3QgdHJhbnNwYXJlbnQgcmVnaW9uIHRoYXQgZG9lcyBOT1QgdG91Y2hcbiAqIHRoZSBpbWFnZSBib3JkZXIgKHNvIGV4dGVyaW9yIGNhbnZhcyB0cmFuc3BhcmVuY3kgaXNuJ3QgdHJlYXRlZCBhcyB0aGUgaG9sZSkuXG4gKiBGYWxscyBiYWNrIHRvIHRyYW5zcGFyZW50IHBpeGVscyBpbnNpZGUgdGhlIG9wYXF1ZSBhcnR3b3JrJ3MgYm91bmRpbmcgYm94LlxuICovXG5mdW5jdGlvbiBmaW5kSG9sZShkYXRhOiBVaW50OENsYW1wZWRBcnJheSwgdzogbnVtYmVyLCBoOiBudW1iZXIsIHRocmVzaG9sZCA9IDQwKSB7XG4gIGNvbnN0IGlzQ2xlYXIgPSAoeDogbnVtYmVyLCB5OiBudW1iZXIpID0+IGRhdGFbKHkgKiB3ICsgeCkgKiA0ICsgM10hIDwgdGhyZXNob2xkO1xuXG4gIC8vIE9wYXF1ZSBhcnR3b3JrIGJib3ggXHUyMDE0IGFuY2hvcnMgdGhlIHNlYXJjaCBzbyBmdWxsLWZyYW1lIGNsZWFyIGNhbnZhc2VzIHN0aWxsIHdvcmsuXG4gIGxldCBvTWluWCA9IHcsIG9NaW5ZID0gaCwgb01heFggPSAwLCBvTWF4WSA9IDAsIG9wYXF1ZSA9IDA7XG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaDsgeSsrKSB7XG4gICAgZm9yIChsZXQgeCA9IDA7IHggPCB3OyB4KyspIHtcbiAgICAgIGlmIChpc0NsZWFyKHgsIHkpKSBjb250aW51ZTtcbiAgICAgIG9wYXF1ZSsrO1xuICAgICAgaWYgKHggPCBvTWluWCkgb01pblggPSB4O1xuICAgICAgaWYgKHkgPCBvTWluWSkgb01pblkgPSB5O1xuICAgICAgaWYgKHggPiBvTWF4WCkgb01heFggPSB4O1xuICAgICAgaWYgKHkgPiBvTWF4WSkgb01heFkgPSB5O1xuICAgIH1cbiAgfVxuICBpZiAob3BhcXVlIDwgMTYpIHtcbiAgICByZXR1cm4geyB4OiAwLCB5OiAwLCB3LCBoLCBmcmFjOiAxIH07XG4gIH1cblxuICAvLyBGbG9vZC1maWxsIGNsZWFyIGNvbXBvbmVudHM7IHByZWZlciBpbnRlcmlvciBvbmVzIChub3QgdG91Y2hpbmcgdGhlIGJvcmRlcikuXG4gIGNvbnN0IHNlZW4gPSBuZXcgVWludDhBcnJheSh3ICogaCk7XG4gIHR5cGUgUmVnaW9uID0geyBtaW5YOiBudW1iZXI7IG1pblk6IG51bWJlcjsgbWF4WDogbnVtYmVyOyBtYXhZOiBudW1iZXI7IGNvdW50OiBudW1iZXI7IGJvcmRlcjogYm9vbGVhbiB9O1xuICBjb25zdCByZWdpb25zOiBSZWdpb25bXSA9IFtdO1xuXG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaDsgeSsrKSB7XG4gICAgZm9yIChsZXQgeCA9IDA7IHggPCB3OyB4KyspIHtcbiAgICAgIGNvbnN0IGlkeCA9IHkgKiB3ICsgeDtcbiAgICAgIGlmIChzZWVuW2lkeF0gfHwgIWlzQ2xlYXIoeCwgeSkpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qgc3RhY2s6IG51bWJlcltdID0gW2lkeF07XG4gICAgICBzZWVuW2lkeF0gPSAxO1xuICAgICAgbGV0IG1pblggPSB4LCBtaW5ZID0geSwgbWF4WCA9IHgsIG1heFkgPSB5LCBjb3VudCA9IDAsIGJvcmRlciA9IGZhbHNlO1xuICAgICAgd2hpbGUgKHN0YWNrLmxlbmd0aCkge1xuICAgICAgICBjb25zdCBpID0gc3RhY2sucG9wKCkhO1xuICAgICAgICBjb25zdCBjeCA9IGkgJSB3LCBjeSA9IChpIC8gdykgfCAwO1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICBpZiAoY3ggPT09IDAgfHwgY3kgPT09IDAgfHwgY3ggPT09IHcgLSAxIHx8IGN5ID09PSBoIC0gMSkgYm9yZGVyID0gdHJ1ZTtcbiAgICAgICAgaWYgKGN4IDwgbWluWCkgbWluWCA9IGN4O1xuICAgICAgICBpZiAoY3kgPCBtaW5ZKSBtaW5ZID0gY3k7XG4gICAgICAgIGlmIChjeCA+IG1heFgpIG1heFggPSBjeDtcbiAgICAgICAgaWYgKGN5ID4gbWF4WSkgbWF4WSA9IGN5O1xuICAgICAgICBmb3IgKGNvbnN0IFtueCwgbnldIG9mIFtbY3ggKyAxLCBjeV0sIFtjeCAtIDEsIGN5XSwgW2N4LCBjeSArIDFdLCBbY3gsIGN5IC0gMV1dIGFzIFtudW1iZXIsIG51bWJlcl1bXSkge1xuICAgICAgICAgIGlmIChueCA8IDAgfHwgbnkgPCAwIHx8IG54ID49IHcgfHwgbnkgPj0gaCkgY29udGludWU7XG4gICAgICAgICAgY29uc3QgbmkgPSBueSAqIHcgKyBueDtcbiAgICAgICAgICBpZiAoc2VlbltuaV0gfHwgIWlzQ2xlYXIobngsIG55KSkgY29udGludWU7XG4gICAgICAgICAgc2VlbltuaV0gPSAxO1xuICAgICAgICAgIHN0YWNrLnB1c2gobmkpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBpZiAoY291bnQgPj0gMTYpIHJlZ2lvbnMucHVzaCh7IG1pblgsIG1pblksIG1heFgsIG1heFksIGNvdW50LCBib3JkZXIgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gUHJlZmVyIHRoZSBsYXJnZXN0IGludGVyaW9yIGNsZWFyIHJlZ2lvbiAodGhlIGZhY2UgaG9sZSkuIElmIG5vbmUsIHVzZSBjbGVhclxuICAvLyBwaXhlbHMgc3RyaWN0bHkgaW5zaWRlIHRoZSBvcGFxdWUgYXJ0d29yayBiYm94LlxuICBjb25zdCBpbnRlcmlvciA9IHJlZ2lvbnMuZmlsdGVyKHIgPT4gIXIuYm9yZGVyKS5zb3J0KChhLCBiKSA9PiBiLmNvdW50IC0gYS5jb3VudCk7XG4gIGlmIChpbnRlcmlvclswXSkge1xuICAgIGNvbnN0IHIgPSBpbnRlcmlvclswXTtcbiAgICByZXR1cm4ge1xuICAgICAgeDogci5taW5YLCB5OiByLm1pblksXG4gICAgICB3OiByLm1heFggLSByLm1pblggKyAxLCBoOiByLm1heFkgLSByLm1pblkgKyAxLFxuICAgICAgZnJhYzogci5jb3VudCAvICh3ICogaCksXG4gICAgfTtcbiAgfVxuXG4gIC8vIEZhbGxiYWNrOiB0cmFuc3BhcmVudCBwaXhlbHMgaW5zaWRlIHRoZSBvcGFxdWUgYmJveCAoaW5zZXQgMXB4KS5cbiAgbGV0IG1pblggPSB3LCBtaW5ZID0gaCwgbWF4WCA9IDAsIG1heFkgPSAwLCBjb3VudCA9IDA7XG4gIGZvciAobGV0IHkgPSBvTWluWSArIDE7IHkgPCBvTWF4WTsgeSsrKSB7XG4gICAgZm9yIChsZXQgeCA9IG9NaW5YICsgMTsgeCA8IG9NYXhYOyB4KyspIHtcbiAgICAgIGlmICghaXNDbGVhcih4LCB5KSkgY29udGludWU7XG4gICAgICBjb3VudCsrO1xuICAgICAgaWYgKHggPCBtaW5YKSBtaW5YID0geDtcbiAgICAgIGlmICh5IDwgbWluWSkgbWluWSA9IHk7XG4gICAgICBpZiAoeCA+IG1heFgpIG1heFggPSB4O1xuICAgICAgaWYgKHkgPiBtYXhZKSBtYXhZID0geTtcbiAgICB9XG4gIH1cbiAgaWYgKGNvdW50IDwgMTYpIHtcbiAgICAvLyBObyByZWFsIGhvbGUgXHUyMDE0IHBsYWNlIHN1YmplY3QgY2VudHJlZCB1bmRlciB0aGUgd2hvbGUgb3ZlcmxheS5cbiAgICByZXR1cm4geyB4OiAwLCB5OiAwLCB3LCBoLCBmcmFjOiAxIH07XG4gIH1cbiAgcmV0dXJuIHtcbiAgICB4OiBtaW5YLCB5OiBtaW5ZLCB3OiBtYXhYIC0gbWluWCArIDEsIGg6IG1heFkgLSBtaW5ZICsgMSxcbiAgICBmcmFjOiBjb3VudCAvICh3ICogaCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIGZpdENvbnRhaW4oc3c6IG51bWJlciwgc2g6IG51bWJlciwgYm94VzogbnVtYmVyLCBib3hIOiBudW1iZXIpIHtcbiAgY29uc3Qgc2NhbGUgPSBNYXRoLm1pbihib3hXIC8gTWF0aC5tYXgoMSwgc3cpLCBib3hIIC8gTWF0aC5tYXgoMSwgc2gpKTtcbiAgcmV0dXJuIHsgdzogc3cgKiBzY2FsZSwgaDogc2ggKiBzY2FsZSB9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNlcXVlbmNlQ29tcG9zZUlucHV0IHtcbiAgaW1hZ2U6IEJ1ZmZlcjtcbiAgLyoqIEFic29sdXRlIGRpcmVjdG9yeSBjb250YWluaW5nIG9yZGVyZWQgZnJhbWUvY2h1bmsgZmlsZXMuICovXG4gIHNlcXVlbmNlRGlyOiBzdHJpbmc7XG4gIHNpemU6IG51bWJlcjtcbiAgLyoqIENhcCBmcmFtZXMgKGxhcmdlIGF0bGFzZXMpLiAqL1xuICBtYXhGcmFtZXM/OiBudW1iZXI7XG59XG5cbi8qKlxuICogRGV0ZWN0IGEgcmVndWxhciBzcHJpdGUtc2hlZXQgZ3JpZCBhbmQgcmV0dXJuIHRpbGUgd2lkdGgvaGVpZ2h0LlxuICpcbiAqIE1ha2VFbW9qaSBwYWNrcyBtYW55IGFuaW1hdGVkIHN0eWxlcyBhcyBvbmUgV2ViUCB3aXRoIE5cdTAwRDdNIGNlbGxzLiBEcmF3aW5nXG4gKiB0aGF0IHNoZWV0IHdob2xlIGlzIHdoYXQgcHJvZHVjZWQgdGhlIFwic3ViamVjdCB0aWxlZCBhY3Jvc3MgdGhlIGNhbnZhc1wiXG4gKiBidWcgXHUyMDE0IGV2ZXJ5IGNlbGwncyBob2xlIHNob3dlZCB0aGUgc2FtZSBzdHJldGNoZWQgc3ViamVjdC4gV2UgbXVzdCBzbGljZVxuICogZmlyc3QuIFJldHVybnMgbnVsbCB3aGVuIHRoZSBpbWFnZSBpcyBhIHNpbmdsZSBmdWxsLWZyYW1lIG92ZXJsYXkuXG4gKi9cbmZ1bmN0aW9uIGRldGVjdFRpbGVTaXplKFxuICB3OiBudW1iZXIsXG4gIGg6IG51bWJlcixcbiAgZGF0YTogVWludDhDbGFtcGVkQXJyYXksXG4pOiB7IHR3OiBudW1iZXI7IHRoOiBudW1iZXIgfSB8IG51bGwge1xuICB0eXBlIENhbmQgPSB7XG4gICAgdHc6IG51bWJlcjsgdGg6IG51bWJlcjsgY29sczogbnVtYmVyOyByb3dzOiBudW1iZXI7XG4gICAgdmFyaTogbnVtYmVyOyBub25lbXB0eTogbnVtYmVyOyBjZWxsczogbnVtYmVyOyBibGVlZDogbnVtYmVyO1xuICB9O1xuICBjb25zdCBjYW5kczogQ2FuZFtdID0gW107XG5cbiAgLy8gUHJlZmVyIGNvbW1vbiBNYWtlRW1vamkgY2VsbCBzaXplcywgdGhlbiBhbnkgZGl2aXNvciB0aGF0IHlpZWxkcyA0XHUyMDEzNjQgY2VsbHMuXG4gIGNvbnN0IHByZWZlcnJlZCA9IFs1NiwgNjQsIDY4LCA3MiwgODAsIDk2LCAxMDIsIDEwNCwgMTEyLCAxMjgsIDEzMCwgMTM2LCAxNTIsIDE3MCwgMjA4XTtcbiAgY29uc3QgdHdTZXQgPSBuZXcgU2V0PG51bWJlcj4ocHJlZmVycmVkKTtcbiAgZm9yIChsZXQgZCA9IDQ4OyBkIDw9IE1hdGgubWluKHcsIGgpOyBkKyspIHtcbiAgICBpZiAodyAlIGQgPT09IDAgJiYgaCAlIGQgPT09IDApIHR3U2V0LmFkZChkKTtcbiAgfVxuXG4gIC8vIEluZGl2aWR1YWwgQ0ROIGZyYW1lcyBhcmUgYWxyZWFkeSAxMjhcdTAwRDcxMjggKG9yIHNpbWlsYXIpLiBOZXZlciB0cmVhdCBhXG4gIC8vIG5lYXItZW1vamktc2l6ZWQgaW1hZ2UgYXMgYSBzaGVldCBcdTIwMTQgdGhhdCByZWludHJvZHVjZXMgdGhlIGdyaWQgYnVnIGJ5XG4gIC8vIGNhcnZpbmcgb25lIG92ZXJsYXkgaW50byBhIDJcdTAwRDcyIG9mIGdhcmJhZ2UgdGlsZXMuXG4gIGlmICh3IDw9IDE2MCAmJiBoIDw9IDE2MCkgcmV0dXJuIG51bGw7XG5cbiAgZm9yIChjb25zdCB0dyBvZiB0d1NldCkge1xuICAgIGlmICh3ICUgdHcgIT09IDAgfHwgaCAlIHR3ICE9PSAwKSBjb250aW51ZTtcbiAgICBjb25zdCBjb2xzID0gdyAvIHR3LCByb3dzID0gaCAvIHR3O1xuICAgIGNvbnN0IGNlbGxzID0gY29scyAqIHJvd3M7XG4gICAgLy8gTmVlZCBhIHJlYWwgZ3JpZCAoYXQgbGVhc3QgM1x1MDBENzIgLyAyXHUwMEQ3MyksIG5vdCBhIDJcdTAwRDcyIGNyb3Agb2YgYSBzaW5nbGUgZnJhbWUuXG4gICAgaWYgKGNlbGxzIDwgNiB8fCBjZWxscyA+IDY0KSBjb250aW51ZTtcbiAgICBpZiAoY29scyA8IDIgfHwgcm93cyA8IDIpIGNvbnRpbnVlO1xuXG4gICAgY29uc3Qgb3BhcXVlOiBudW1iZXJbXSA9IFtdO1xuICAgIGZvciAobGV0IHIgPSAwOyByIDwgcm93czsgcisrKSB7XG4gICAgICBmb3IgKGxldCBjID0gMDsgYyA8IGNvbHM7IGMrKykge1xuICAgICAgICBsZXQgb3AgPSAwO1xuICAgICAgICBmb3IgKGxldCB5ID0gMDsgeSA8IHR3OyB5ICs9IDIpIHtcbiAgICAgICAgICBmb3IgKGxldCB4ID0gMDsgeCA8IHR3OyB4ICs9IDIpIHtcbiAgICAgICAgICAgIGNvbnN0IGd4ID0gYyAqIHR3ICsgeCwgZ3kgPSByICogdHcgKyB5O1xuICAgICAgICAgICAgaWYgKGRhdGFbKGd5ICogdyArIGd4KSAqIDQgKyAzXSEgPiA0MCkgb3ArKztcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgb3BhcXVlLnB1c2gob3ApO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBtZWFuID0gb3BhcXVlLnJlZHVjZSgoYSwgYikgPT4gYSArIGIsIDApIC8gb3BhcXVlLmxlbmd0aDtcbiAgICBjb25zdCB2YXJpID0gb3BhcXVlLnJlZHVjZSgoYSwgYikgPT4gYSArIChiIC0gbWVhbikgKiogMiwgMCkgLyBvcGFxdWUubGVuZ3RoO1xuICAgIGNvbnN0IG5vbmVtcHR5ID0gb3BhcXVlLmZpbHRlcih0ID0+IHQgPiB0dyAqIHR3ICogMC4wMSkubGVuZ3RoO1xuICAgIC8vIFJlYWwgc2hlZXRzIGhhdmUgc2V2ZXJhbCBwb3B1bGF0ZWQgY2VsbHMgd2l0aCB1bmV2ZW4gZmlsbCAoaWRsZSB2cyBhY3RpdmUpLlxuICAgIC8vIFJlamVjdCBuZWFyLXVuaWZvcm0gZ3JpZHMgKGEgZnVsbC1ibGVlZCBvdmVybGF5IHdyb25nbHkgZGl2aXNpYmxlIGludG8gdGlsZXMpLlxuICAgIGlmIChub25lbXB0eSA8IDQpIGNvbnRpbnVlO1xuICAgIGlmICh2YXJpIDwgMTAwKSBjb250aW51ZTtcblxuICAgIC8vIEVkZ2UgYmxlZWQ6IHdyb25nIHRpbGUgc2l6ZXMgY3V0IHRocm91Z2ggc3ByaXRlcyBzbyBvcGFxdWUgcGl4ZWxzIGh1Z1xuICAgIC8vIHRoZSBjZWxsIGJvcmRlci4gUHJlZmVyIGdyaWRzIHdoZXJlIGNvbnRlbnQgc2l0cyBpbnNpZGUgdGhlIGNlbGwuXG4gICAgbGV0IGVkZ2VCbGVlZCA9IDAsIGVkZ2VTYW1wbGVzID0gMDtcbiAgICBjb25zdCBiYW5kID0gTWF0aC5tYXgoMSwgTWF0aC5mbG9vcih0dyAqIDAuMDgpKTtcbiAgICBmb3IgKGxldCByID0gMDsgciA8IHJvd3M7IHIrKykge1xuICAgICAgZm9yIChsZXQgYyA9IDA7IGMgPCBjb2xzOyBjKyspIHtcbiAgICAgICAgLy8gU2tpcCBlbXB0eSBjZWxsc1xuICAgICAgICBjb25zdCBjZWxsT3AgPSBvcGFxdWVbciAqIGNvbHMgKyBjXSE7XG4gICAgICAgIGlmIChjZWxsT3AgPD0gdHcgKiB0dyAqIDAuMDEpIGNvbnRpbnVlO1xuICAgICAgICBmb3IgKGxldCB5ID0gMDsgeSA8IHR3OyB5ICs9IDIpIHtcbiAgICAgICAgICBmb3IgKGxldCB4ID0gMDsgeCA8IHR3OyB4ICs9IDIpIHtcbiAgICAgICAgICAgIGNvbnN0IG9uRWRnZSA9IHggPCBiYW5kIHx8IHkgPCBiYW5kIHx8IHggPj0gdHcgLSBiYW5kIHx8IHkgPj0gdHcgLSBiYW5kO1xuICAgICAgICAgICAgaWYgKCFvbkVkZ2UpIGNvbnRpbnVlO1xuICAgICAgICAgICAgZWRnZVNhbXBsZXMrKztcbiAgICAgICAgICAgIGNvbnN0IGd4ID0gYyAqIHR3ICsgeCwgZ3kgPSByICogdHcgKyB5O1xuICAgICAgICAgICAgaWYgKGRhdGFbKGd5ICogdyArIGd4KSAqIDQgKyAzXSEgPiA0MCkgZWRnZUJsZWVkKys7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IGJsZWVkID0gZWRnZVNhbXBsZXMgPyBlZGdlQmxlZWQgLyBlZGdlU2FtcGxlcyA6IDE7XG4gICAgY2FuZHMucHVzaCh7IHR3LCB0aDogdHcsIGNvbHMsIHJvd3MsIHZhcmksIG5vbmVtcHR5LCBjZWxscywgYmxlZWQgfSk7XG4gIH1cblxuICAvLyBQcmVmZXI6XG4gIC8vICAxLiBMb3cgZWRnZSBibGVlZCAodGlsZXMgZG9uJ3QgY3V0IHRocm91Z2ggbmVpZ2hib3VyaW5nIHNwcml0ZXMpXG4gIC8vICAyLiBOb25lbXB0eSBjb3VudCBpbiBhIHR5cGljYWwgYW5pbWF0aW9uIHJhbmdlICg2XHUyMDEzMjQpXG4gIC8vICAzLiBIaWdoZXIgdmFyaWFuY2UgYXMgYSB3ZWFrIHRpZS1icmVha1xuICBjYW5kcy5zb3J0KChhLCBiKSA9PiB7XG4gICAgY29uc3QgYmxlZWREZWx0YSA9IGEuYmxlZWQgLSBiLmJsZWVkO1xuICAgIGlmIChNYXRoLmFicyhibGVlZERlbHRhKSA+IDAuMDQpIHJldHVybiBibGVlZERlbHRhO1xuICAgIGNvbnN0IGlkZWFsID0gKG46IG51bWJlcikgPT4gKG4gPj0gNiAmJiBuIDw9IDI0ID8gMTAwMCArIG4gOiBuKTtcbiAgICBjb25zdCBpZGVhbERlbHRhID0gaWRlYWwoYi5ub25lbXB0eSkgLSBpZGVhbChhLm5vbmVtcHR5KTtcbiAgICBpZiAoaWRlYWxEZWx0YSAhPT0gMCkgcmV0dXJuIGlkZWFsRGVsdGE7XG4gICAgcmV0dXJuIGIudmFyaSAtIGEudmFyaTtcbiAgfSk7XG4gIGNvbnN0IGJlc3QgPSBjYW5kc1swXTtcbiAgcmV0dXJuIGJlc3QgPyB7IHR3OiBiZXN0LnR3LCB0aDogYmVzdC50aCB9IDogbnVsbDtcbn1cblxudHlwZSBPdmVybGF5RnJhbWUgPSB7XG4gIGltZzogQXdhaXRlZDxSZXR1cm5UeXBlPENhbnZhc01vZFtcImxvYWRJbWFnZVwiXT4+O1xuICB3OiBudW1iZXI7XG4gIGg6IG51bWJlcjtcbn07XG5cbi8qKiBTbGljZSBvbmUgaW1hZ2UgZmlsZSBpbnRvIG92ZXJsYXkgZnJhbWVzIChzcHJpdGUgc2hlZXQgXHUyMTkyIHRpbGVzLCBlbHNlIHdob2xlKS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGV4cGFuZE9uZUZpbGUoXG4gIG1vZDogQ2FudmFzTW9kLFxuICBmaWxlOiBzdHJpbmcsXG4gIG1heEZyYW1lczogbnVtYmVyLFxuKTogUHJvbWlzZTxPdmVybGF5RnJhbWVbXT4ge1xuICBjb25zdCBvdXQ6IE92ZXJsYXlGcmFtZVtdID0gW107XG4gIGNvbnN0IGJ1ZiA9IHJlYWRGaWxlU3luYyhmaWxlKTtcbiAgY29uc3QgcHJvYmVJbWcgPSBhd2FpdCBtb2QubG9hZEltYWdlKGJ1Zik7XG4gIGNvbnN0IHByb2JlOiBDYW52YXMgPSBtb2QuY3JlYXRlQ2FudmFzKHByb2JlSW1nLndpZHRoLCBwcm9iZUltZy5oZWlnaHQpO1xuICBjb25zdCBwcm9iZUN0eCA9IHByb2JlLmdldENvbnRleHQoXCIyZFwiKSBhcyB1bmtub3duIGFzIEN0eCAmIFBpeGVsQ3R4O1xuICBwcm9iZUN0eC5jbGVhclJlY3QoMCwgMCwgcHJvYmVJbWcud2lkdGgsIHByb2JlSW1nLmhlaWdodCk7XG4gIHByb2JlQ3R4LmRyYXdJbWFnZShwcm9iZUltZyBhcyB1bmtub3duIGFzIENhbnZhcywgMCwgMCwgcHJvYmVJbWcud2lkdGgsIHByb2JlSW1nLmhlaWdodCk7XG4gIGNvbnN0IHJhdyA9IHByb2JlQ3R4LmdldEltYWdlRGF0YSgwLCAwLCBwcm9iZUltZy53aWR0aCwgcHJvYmVJbWcuaGVpZ2h0KTtcbiAgY29uc3QgdGlsZSA9IGRldGVjdFRpbGVTaXplKHByb2JlSW1nLndpZHRoLCBwcm9iZUltZy5oZWlnaHQsIHJhdy5kYXRhKTtcblxuICBpZiAodGlsZSkge1xuICAgIGNvbnN0IHsgdHcsIHRoIH0gPSB0aWxlO1xuICAgIGNvbnN0IGNvbHMgPSBwcm9iZUltZy53aWR0aCAvIHR3O1xuICAgIGNvbnN0IHJvd3MgPSBwcm9iZUltZy5oZWlnaHQgLyB0aDtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc2hhcnAgPSAoYXdhaXQgaW1wb3J0KFwic2hhcnBcIikpLmRlZmF1bHQ7XG4gICAgICBmb3IgKGxldCByID0gMDsgciA8IHJvd3M7IHIrKykge1xuICAgICAgICBmb3IgKGxldCBjID0gMDsgYyA8IGNvbHM7IGMrKykge1xuICAgICAgICAgIGlmIChvdXQubGVuZ3RoID49IG1heEZyYW1lcykgYnJlYWs7XG4gICAgICAgICAgY29uc3QgY3JvcHBlZCA9IGF3YWl0IHNoYXJwKGJ1ZilcbiAgICAgICAgICAgIC5leHRyYWN0KHsgbGVmdDogYyAqIHR3LCB0b3A6IHIgKiB0aCwgd2lkdGg6IHR3LCBoZWlnaHQ6IHRoIH0pXG4gICAgICAgICAgICAuZW5zdXJlQWxwaGEoKVxuICAgICAgICAgICAgLnJhdygpXG4gICAgICAgICAgICAudG9CdWZmZXIoeyByZXNvbHZlV2l0aE9iamVjdDogdHJ1ZSB9KTtcbiAgICAgICAgICBsZXQgb3AgPSAwO1xuICAgICAgICAgIGZvciAobGV0IGkgPSAzOyBpIDwgY3JvcHBlZC5kYXRhLmxlbmd0aDsgaSArPSA0KSBpZiAoY3JvcHBlZC5kYXRhW2ldISA+IDQwKSBvcCsrO1xuICAgICAgICAgIC8vIFNraXAgZW1wdHkgLyBuZWFybHktZW1wdHkgY2VsbHMgaW4gYSBzcGFyc2UgYXRsYXMuXG4gICAgICAgICAgaWYgKG9wIDwgdHcgKiB0aCAqIDAuMDIpIGNvbnRpbnVlO1xuICAgICAgICAgIGNvbnN0IHBuZyA9IGF3YWl0IHNoYXJwKGNyb3BwZWQuZGF0YSwge1xuICAgICAgICAgICAgcmF3OiB7IHdpZHRoOiB0dywgaGVpZ2h0OiB0aCwgY2hhbm5lbHM6IDQgfSxcbiAgICAgICAgICB9KS5wbmcoKS50b0J1ZmZlcigpO1xuICAgICAgICAgIGNvbnN0IGltZyA9IGF3YWl0IG1vZC5sb2FkSW1hZ2UocG5nKTtcbiAgICAgICAgICBvdXQucHVzaCh7IGltZywgdzogdHcsIGg6IHRoIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBmYWxsIHRocm91Z2ggdG8gd2hvbGUgaW1hZ2VcbiAgICB9XG4gIH1cblxuICBpZiAob3V0Lmxlbmd0aCA9PT0gMCkge1xuICAgIG91dC5wdXNoKHsgaW1nOiBwcm9iZUltZywgdzogcHJvYmVJbWcud2lkdGgsIGg6IHByb2JlSW1nLmhlaWdodCB9KTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKipcbiAqIEV4cGFuZCBhdGxhcy9mcmFtZSBmaWxlcyBpbnRvIHBlci1mcmFtZSBvdmVybGF5IGltYWdlcy5cbiAqXG4gKiAtIE51bWJlcmVkIFBORyBmcmFtZSBkaXJzIFx1MjE5MiBvbmUgb3ZlcmxheSBwZXIgZmlsZSAoYWxyZWFkeSBpbmRpdmlkdWFsIGZyYW1lcykuXG4gKiAtIFNwcml0ZS1zaGVldCBXZWJQcyAob25lIG9yIG1hbnkgY2h1bmtzKSBcdTIxOTIgc2xpY2VkIGludG8gY2VsbHM7IE5FVkVSIGRyYXduIHdob2xlLlxuICogLSBNdWx0aS1jaHVuayBhdGxhc2VzIHdob3NlIGNodW5rcyBhcmUgYWxyZWFkeSBmdWxsIGZyYW1lcyBcdTIxOTIgb25lIG92ZXJsYXkgcGVyIGNodW5rLlxuICovXG5hc3luYyBmdW5jdGlvbiBleHBhbmRUb092ZXJsYXlGcmFtZXMoXG4gIG1vZDogQ2FudmFzTW9kLFxuICBmaWxlczogc3RyaW5nW10sXG4gIG1heEZyYW1lczogbnVtYmVyLFxuKTogUHJvbWlzZTxPdmVybGF5RnJhbWVbXT4ge1xuICBjb25zdCBvdXQ6IE92ZXJsYXlGcmFtZVtdID0gW107XG5cbiAgLy8gU2FtcGxlIGZpbGVzIHdoZW4gdGhlcmUgYXJlIGZhciBtb3JlIHRoYW4gd2Ugd2lsbCBlbmNvZGUuXG4gIGNvbnN0IHVzZWQgPSBmaWxlcy5sZW5ndGggPiBtYXhGcmFtZXNcbiAgICA/IGZpbGVzLmZpbHRlcigoXywgaSkgPT4gaSAlIE1hdGguY2VpbChmaWxlcy5sZW5ndGggLyBtYXhGcmFtZXMpID09PSAwKS5zbGljZSgwLCBtYXhGcmFtZXMpXG4gICAgOiBmaWxlcztcblxuICBmb3IgKGNvbnN0IGZpbGUgb2YgdXNlZCkge1xuICAgIGlmIChvdXQubGVuZ3RoID49IG1heEZyYW1lcykgYnJlYWs7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGZyYW1lcyA9IGF3YWl0IGV4cGFuZE9uZUZpbGUobW9kLCBmaWxlLCBtYXhGcmFtZXMgLSBvdXQubGVuZ3RoKTtcbiAgICAgIC8vIElmIGEgXCJjaHVua1wiIGV4cGFuZHMgaW50byBtYW55IHRpbGVzLCB0aG9zZSBBUkUgdGhlIGFuaW1hdGlvbiBmcmFtZXMgXHUyMDE0XG4gICAgICAvLyB0YWtlIHRoZW0gYWxsICh1cCB0byB0aGUgY2FwKS4gSWYgaXQgc3RheXMgb25lIGZyYW1lLCBhcHBlbmQgYW5kIGNvbnRpbnVlXG4gICAgICAvLyB0byB0aGUgbmV4dCBjaHVuay5cbiAgICAgIG91dC5wdXNoKC4uLmZyYW1lcyk7XG4gICAgfSBjYXRjaCB7IC8qIHNraXAgdW5yZWFkYWJsZSAqLyB9XG4gIH1cblxuICByZXR1cm4gb3V0O1xufVxuXG4vKipcbiAqIENvbXBvc2l0ZSB0aGUgc3ViamVjdCBpbnRvIGVhY2ggYXRsYXMvZnJhbWUgb3ZlcmxheSdzIHRyYW5zcGFyZW50IGhvbGUuXG4gKiBSZXR1cm5zIG9uZSBSR0JBIGJ1ZmZlciBwZXIgc2VxdWVuY2UgZnJhbWUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb21wb3NlU2VxdWVuY2UoaW5wdXQ6IFNlcXVlbmNlQ29tcG9zZUlucHV0KTogUHJvbWlzZTxVaW50OENsYW1wZWRBcnJheVtdPiB7XG4gIGNvbnN0IG1vZDogQ2FudmFzTW9kIHwgbnVsbCA9IGF3YWl0IGdldENhbnZhcygpO1xuICBpZiAoIW1vZCkge1xuICAgIHRocm93IG5ldyBFbW9qaUVycm9yKFxuICAgICAgXCJjYW52YXNfbWlzc2luZ1wiLFxuICAgICAgXCJUaGUgaW1hZ2UgcmVuZGVyZXIgaXNuJ3QgYXZhaWxhYmxlIHJpZ2h0IG5vdy4gUGxlYXNlIHRyeSBhZ2FpbiBsYXRlci5cIixcbiAgICApO1xuICB9XG5cbiAgY29uc3QgZmlsZXMgPSBsaXN0RnJhbWVGaWxlcyhpbnB1dC5zZXF1ZW5jZURpcik7XG4gIGlmIChmaWxlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRW1vamlFcnJvcihcInVua25vd25fZWZmZWN0XCIsIGBObyBmcmFtZXMgaW4gJHtpbnB1dC5zZXF1ZW5jZURpcn1gKTtcbiAgfVxuICBjb25zdCBtYXggPSBpbnB1dC5tYXhGcmFtZXMgPz8gMjQ7XG5cbiAgbGV0IHN1YmplY3Q7XG4gIHRyeSB7XG4gICAgc3ViamVjdCA9IGF3YWl0IG1vZC5sb2FkSW1hZ2UoaW5wdXQuaW1hZ2UpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgRW1vamlFcnJvcihcIm5vdF9hbl9pbWFnZVwiLCBcIlNvdXJjZSBpbWFnZSBjb3VsZCBub3QgYmUgcmVhZC5cIik7XG4gIH1cblxuICBjb25zdCBvdmVybGF5cyA9IGF3YWl0IGV4cGFuZFRvT3ZlcmxheUZyYW1lcyhtb2QsIGZpbGVzLCBtYXgpO1xuICBjb25zdCBzaXplID0gaW5wdXQuc2l6ZTtcbiAgY29uc3Qgb3V0OiBVaW50OENsYW1wZWRBcnJheVtdID0gW107XG5cbiAgZm9yIChjb25zdCBvdmVybGF5IG9mIG92ZXJsYXlzKSB7XG4gICAgY29uc3QgcHJvYmU6IENhbnZhcyA9IG1vZC5jcmVhdGVDYW52YXMob3ZlcmxheS53LCBvdmVybGF5LmgpO1xuICAgIGNvbnN0IHByb2JlQ3R4ID0gcHJvYmUuZ2V0Q29udGV4dChcIjJkXCIpIGFzIHVua25vd24gYXMgQ3R4ICYgUGl4ZWxDdHg7XG4gICAgcHJvYmVDdHguY2xlYXJSZWN0KDAsIDAsIG92ZXJsYXkudywgb3ZlcmxheS5oKTtcbiAgICBwcm9iZUN0eC5kcmF3SW1hZ2Uob3ZlcmxheS5pbWcgYXMgdW5rbm93biBhcyBDYW52YXMsIDAsIDAsIG92ZXJsYXkudywgb3ZlcmxheS5oKTtcbiAgICBjb25zdCBwcm9iZURhdGEgPSBwcm9iZUN0eC5nZXRJbWFnZURhdGEoMCwgMCwgb3ZlcmxheS53LCBvdmVybGF5LmgpO1xuICAgIGNvbnN0IGhvbGUgPSBmaW5kSG9sZShwcm9iZURhdGEuZGF0YSwgb3ZlcmxheS53LCBvdmVybGF5LmgpO1xuXG4gICAgY29uc3Qgc3ggPSBzaXplIC8gb3ZlcmxheS53O1xuICAgIGNvbnN0IHN5ID0gc2l6ZSAvIG92ZXJsYXkuaDtcbiAgICBjb25zdCBob2xlQm94ID0ge1xuICAgICAgeDogaG9sZS54ICogc3gsXG4gICAgICB5OiBob2xlLnkgKiBzeSxcbiAgICAgIHc6IGhvbGUudyAqIHN4LFxuICAgICAgaDogaG9sZS5oICogc3ksXG4gICAgfTtcblxuICAgIGNvbnN0IGluc2V0ID0gaG9sZS5mcmFjID4gMC44NSA/IDAuNzggOiBob2xlLmZyYWMgPiAwLjUgPyAwLjg4IDogMC45MjtcbiAgICBjb25zdCBmaXR0ZWQgPSBmaXRDb250YWluKHN1YmplY3Qud2lkdGgsIHN1YmplY3QuaGVpZ2h0LCBob2xlQm94LncgKiBpbnNldCwgaG9sZUJveC5oICogaW5zZXQpO1xuICAgIGNvbnN0IGR4ID0gaG9sZUJveC54ICsgKGhvbGVCb3gudyAtIGZpdHRlZC53KSAvIDI7XG4gICAgY29uc3QgZHkgPSBob2xlQm94LnkgKyAoaG9sZUJveC5oIC0gZml0dGVkLmgpIC8gMjtcblxuICAgIGNvbnN0IGZyYW1lQ2FudmFzOiBDYW52YXMgPSBtb2QuY3JlYXRlQ2FudmFzKHNpemUsIHNpemUpO1xuICAgIGNvbnN0IGN0eCA9IGZyYW1lQ2FudmFzLmdldENvbnRleHQoXCIyZFwiKSBhcyB1bmtub3duIGFzIEN0eCAmIFBpeGVsQ3R4ICYge1xuICAgICAgaW1hZ2VTbW9vdGhpbmdFbmFibGVkOiBib29sZWFuO1xuICAgIH07XG4gICAgY3R4LmNsZWFyUmVjdCgwLCAwLCBzaXplLCBzaXplKTtcbiAgICBjdHguaW1hZ2VTbW9vdGhpbmdFbmFibGVkID0gdHJ1ZTtcbiAgICBjdHguZHJhd0ltYWdlKHN1YmplY3QgYXMgdW5rbm93biBhcyBDYW52YXMsIGR4LCBkeSwgZml0dGVkLncsIGZpdHRlZC5oKTtcbiAgICBjdHguZHJhd0ltYWdlKG92ZXJsYXkuaW1nIGFzIHVua25vd24gYXMgQ2FudmFzLCAwLCAwLCBzaXplLCBzaXplKTtcblxuICAgIG91dC5wdXNoKG5ldyBVaW50OENsYW1wZWRBcnJheShjdHguZ2V0SW1hZ2VEYXRhKDAsIDAsIHNpemUsIHNpemUpLmRhdGEpKTtcbiAgfVxuXG4gIGlmIChvdXQubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVtb2ppRXJyb3IoXCJlbmNvZGVfZmFpbGVkXCIsIFwiQXRsYXMvZnJhbWUgc2VxdWVuY2UgcHJvZHVjZWQgbm8gZnJhbWVzLlwiKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUF0bGFzRGlyKHNsdWc6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gcmVzb2x2ZUFzc2V0RGlyKFwiYXRsYXNlc1wiLCBzbHVnKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVGcmFtZXNEaXIoc2x1Zzogc3RyaW5nKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiByZXNvbHZlQXNzZXREaXIoXCJmcmFtZXNcIiwgc2x1Zyk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFRQSxTQUFTLFlBQVksYUFBYSxvQkFBb0I7QUFDdEQsU0FBUyxZQUFZO0FBRXJCLFNBQVMsaUJBQTJDO0FBQ3BELFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsMEJBQTBCO0FBYW5DLFNBQVMsYUFBNEI7QUFDbkMsUUFBTSxPQUFPLG1CQUFt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QUc7QUFDNUQsUUFBTSxPQUFPLE1BQU07QUFDbkIsUUFBTSxNQUEyQixDQUFDO0FBRWxDLGFBQVcsV0FBVyxVQUFVO0FBQzlCLFVBQU0sUUFBZ0IsSUFBSSxhQUFhLFFBQVEsR0FBRyxRQUFRLENBQUM7QUFDM0QsVUFBTSxXQUFXLE1BQU0sV0FBVyxJQUFJO0FBQ3RDLGFBQVMsVUFBVSxHQUFHLEdBQUcsUUFBUSxHQUFHLFFBQVEsQ0FBQztBQUM3QyxhQUFTLFVBQVUsUUFBUSxLQUEwQixHQUFHLEdBQUcsUUFBUSxHQUFHLFFBQVEsQ0FBQztBQUMvRSxVQUFNLFlBQVksU0FBUyxhQUFhLEdBQUcsR0FBRyxRQUFRLEdBQUcsUUFBUSxDQUFDO0FBQ2xFLFVBQU0sT0FBTyxTQUFTLFVBQVUsTUFBTSxRQUFRLEdBQUcsUUFBUSxDQUFDO0FBRTFELFVBQU0sS0FBSyxPQUFPLFFBQVE7QUFDMUIsVUFBTSxLQUFLLE9BQU8sUUFBUTtBQUMxQixVQUFNLFVBQVU7QUFBQSxNQUNkLEdBQUcsS0FBSyxJQUFJO0FBQUEsTUFDWixHQUFHLEtBQUssSUFBSTtBQUFBLE1BQ1osR0FBRyxLQUFLLElBQUk7QUFBQSxNQUNaLEdBQUcsS0FBSyxJQUFJO0FBQUEsSUFDZDtBQUVBLFVBQU0sUUFBUSxLQUFLLE9BQU8sT0FBTyxPQUFPLEtBQUssT0FBTyxNQUFNLE9BQU87QUFDakUsVUFBTSxTQUFTLFdBQVcsUUFBUSxPQUFPLFFBQVEsUUFBUSxRQUFRLElBQUksT0FBTyxRQUFRLElBQUksS0FBSztBQUM3RixVQUFNLEtBQUssUUFBUSxLQUFLLFFBQVEsSUFBSSxPQUFPLEtBQUs7QUFDaEQsVUFBTSxLQUFLLFFBQVEsS0FBSyxRQUFRLElBQUksT0FBTyxLQUFLO0FBRWhELFVBQU0sY0FBc0IsSUFBSSxhQUFhLE1BQU0sSUFBSTtBQUN2RCxVQUFNLE1BQU0sWUFBWSxXQUFXLElBQUk7QUFHdkMsUUFBSSxVQUFVLEdBQUcsR0FBRyxNQUFNLElBQUk7QUFDOUIsUUFBSSx3QkFBd0I7QUFDNUIsUUFBSSxVQUFVLFNBQThCLElBQUksSUFBSSxPQUFPLEdBQUcsT0FBTyxDQUFDO0FBQ3RFLFFBQUksVUFBVSxRQUFRLEtBQTBCLEdBQUcsR0FBRyxNQUFNLElBQUk7QUFFaEUsUUFBSSxLQUFLLElBQUksa0JBQWtCLElBQUksYUFBYSxHQUFHLEdBQUcsTUFBTSxJQUFJLEVBQUUsSUFBSSxDQUFDO0FBQUEsRUFDekU7QUFFQSxNQUFJLElBQUksV0FBVyxHQUFHO0FBQ3BCLFVBQU0sSUFBSSxXQUFXLGlCQUFpQiwwQ0FBMEM7QUFBQSxFQUNsRjtBQUNBLFNBQU87QUFDVDtBQUVPLFNBQVMsZ0JBQWdCLE1BQTZCO0FBQzNELFNBQU8sZ0JBQWdCLFdBQVcsSUFBSTtBQUN4QztBQUVPLFNBQVMsaUJBQWlCLE1BQTZCO0FBQzVELFNBQU8sZ0JBQWdCLFVBQVUsSUFBSTtBQUN2QzsiLAogICJuYW1lcyI6IFsibWluWCIsICJtaW5ZIiwgIm1heFgiLCAibWF4WSIsICJjb3VudCJdCn0K
