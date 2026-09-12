import { queueRender, RENDER_PRIORITY } from "../../../animations/render-queue.js";
import { getCanvas } from "../../../animations/engine.js";
import { encodeGif, encodePng } from "../../encoders/index.js";
import { compose } from "../../renderer/compositor.js";
import { EmojiError } from "../../utils/errors.js";
import {
  delayFor,
  isLocalFormat,
  parseDirection,
  parseSize,
  parseSpeed
} from "../../utils/options.js";
import { composeOverlay, resolveOverlayPath } from "./overlay.js";
import { composeSequence, resolveAtlasDir, resolveFramesDir } from "./atlas.js";
import { composeLayerPack, hasLayerPack } from "./layer-pack.js";
import { directionFromRecipe, effectFromPrimitive } from "./primitives.js";
import { findRecipe } from "./recipes.js";
import { findOfflineStyle } from "./registry.js";
import { renderScene, sceneIdOf, sceneRenderOptions } from "./scene-pack.js";
import {
  applyColorFilter,
  colorFrameCount,
  colorIsAnimated,
  normalizeColor,
  tintImageBuffer
} from "./color-filter.js";
const RENDER_TIMEOUT_MS = 2e4;
function styleSlug(animation, recipeId, styleId) {
  const raw = recipeId ?? styleId ?? animation;
  return raw.replace(/^gen_btn_/, "");
}
async function renderOffline(options) {
  const sceneId = sceneIdOf(options.animation);
  if (sceneId) {
    const startedScene = Date.now();
    const buffer2 = await queueRender(
      `emoji-scene:${sceneId}`,
      () => renderScene(
        options.image,
        sceneId,
        sceneRenderOptions({ size: options.size, speed: options.speed, preview: options.preview })
      ),
      options.preview ? RENDER_PRIORITY.preview : RENDER_PRIORITY.output
    );
    return {
      buffer: buffer2,
      format: "gif",
      bytes: buffer2.length,
      providerId: "offline",
      durationMs: Date.now() - startedScene,
      cached: false
    };
  }
  if (!isLocalFormat(options.format) && options.format !== "webp" && options.format !== "apng") {
    throw new EmojiError(
      "unsupported_format",
      `The offline backup can't produce ${options.format.toUpperCase()} yet \u2014 try GIF, WebP or APNG.`
    );
  }
  const recipe = findRecipe(options.animation);
  const style = findOfflineStyle(options.animation);
  const slug = styleSlug(options.animation, recipe?.slug ?? recipe?.id, style?.id);
  const layerReady = hasLayerPack(slug);
  if (!recipe && !style && !layerReady) {
    throw new EmojiError(
      "unknown_effect",
      `\`${options.animation}\` isn't in the offline MakeEmoji style archive.`
    );
  }
  const canRender = layerReady || Boolean(recipe?.primitive) || Boolean(style?.offlineImplemented && style.offlineEffectId);
  if (!canRender) {
    const id = recipe?.id ?? style?.id ?? options.animation;
    throw new EmojiError(
      "unknown_effect",
      `\`${id}\` is archived from MakeEmoji but not implemented offline yet.`
    );
  }
  const size = parseSize(options.size);
  const speed = parseSpeed(options.speed);
  const direction = directionFromRecipe(
    recipe?.params ?? {},
    parseDirection(options.direction)
  );
  const started = Date.now();
  const family = recipe?.family ?? "transform";
  const primitive = recipe?.primitive ?? style?.offlineEffectId ?? null;
  const color = normalizeColor(options.color);
  const buffer = await withTimeout(queueRender(`emoji-offline:${recipe?.id ?? style?.id ?? slug}`, async () => {
    if (layerReady) {
      const pack = await composeLayerPack({ image: options.image, slug, size });
      if (color) {
        return composeWithColor({
          family: "frames",
          image: options.image,
          color,
          format: options.format,
          size,
          speed,
          baseFrames: options.format === "png" ? 1 : pack.frames.length,
          composeOne: async (image, _frameCount) => {
            const again = await composeLayerPack({ image, slug, size });
            return again.frames;
          },
          delayMs: pack.delayMs
        });
      }
      return encodeFrames(
        pack.frames,
        size,
        options.format,
        delayFor(pack.delayMs, speed),
        "frames"
      );
    }
    if (family === "overlay") {
      const slug2 = recipe.slug;
      const overlayPath = resolveOverlayPath(slug2);
      if (!overlayPath) {
        throw new EmojiError(
          "unknown_effect",
          `Overlay asset for \`${slug2}\` is missing from the offline package.`
        );
      }
      const frames = await composeWithColor({
        family: "overlay",
        image: options.image,
        color,
        format: options.format,
        size,
        speed,
        baseFrames: options.format === "png" ? 1 : 8,
        composeOne: async (image, frameCount) => composeOverlay({
          image,
          overlayPath,
          size,
          frames: frameCount
        }),
        delayMs: 55
      });
      return frames;
    }
    if (family === "atlas" || family === "frames") {
      const slug2 = recipe.slug;
      const framesDir = resolveFramesDir(slug2);
      const atlasDir = resolveAtlasDir(slug2);
      const resolved = framesDir ?? atlasDir ?? (family === "atlas" ? resolveFramesDir(slug2) : resolveAtlasDir(slug2));
      if (!resolved) {
        throw new EmojiError(
          "unknown_effect",
          `${family} assets for \`${slug2}\` are missing from the offline package.`
        );
      }
      return composeWithColor({
        family,
        image: options.image,
        color,
        format: options.format,
        size,
        speed,
        baseFrames: options.format === "png" ? 1 : 24,
        composeOne: async (image, frameCount) => composeSequence({
          image,
          sequenceDir: resolved,
          size,
          maxFrames: frameCount
        }),
        delayMs: 50
      });
    }
    if (family === "passthrough" || family === "transform") {
      if (!primitive) {
        throw new EmojiError("unknown_effect", `No primitive for \`${recipe?.id}\`.`);
      }
      const effect = effectFromPrimitive(primitive, recipe?.params ?? {});
      if (!effect) {
        throw new EmojiError("unknown_effect", `Unknown offline primitive \`${primitive}\`.`);
      }
      const animated = options.format !== "png";
      const styleFrames = animated ? effect.frames : 1;
      const wantFrames = animated ? Math.max(styleFrames, colorFrameCount(color, 12)) : 1;
      return composeWithColor({
        family,
        image: options.image,
        color,
        format: options.format,
        size,
        speed,
        baseFrames: wantFrames,
        composeOne: async (image, frameCount) => compose({
          image,
          effect,
          direction,
          size,
          frames: frameCount
        }),
        delayMs: effect.delayMs
      });
    }
    throw new EmojiError(
      "unknown_effect",
      `Offline family \`${family}\` is not renderable yet for \`${recipe?.id}\`.`
    );
  }, options.preview ? RENDER_PRIORITY.preview : RENDER_PRIORITY.output), RENDER_TIMEOUT_MS);
  return {
    buffer,
    format: options.format === "apng" ? "apng" : options.format === "webp" ? "webp" : options.format,
    bytes: buffer.length,
    providerId: "offline",
    durationMs: Date.now() - started,
    cached: false
  };
}
async function composeWithColor(opts) {
  const { family, image, color, format, size, speed, baseFrames, composeOne, delayMs } = opts;
  if (!color) {
    const frames2 = await composeOne(image, baseFrames);
    return encodeFrames(frames2, size, format, delayFor(delayMs, speed), family);
  }
  if (!colorIsAnimated(color) || format === "png") {
    const tinted = await tintImageBuffer(image, color, 0);
    const frames2 = await composeOne(tinted, format === "png" ? 1 : baseFrames);
    return encodeFrames(frames2, size, format, delayFor(delayMs, speed), family);
  }
  const n = Math.max(baseFrames, colorFrameCount(color, 12));
  const frames = [];
  for (let i = 0; i < n; i++) {
    const tinted = await tintImageBuffer(image, color, i / n);
    const one = await composeOne(tinted, 1);
    if (one[0]) frames.push(one[0]);
  }
  void applyColorFilter;
  return encodeFrames(frames, size, format, delayFor(delayMs, speed), family);
}
const SAFE_FILL_FRAMES = 0.98;
const SAFE_FILL_OVERLAY = 0.96;
const SAFE_FILL_TRANSFORM = 0.9;
async function insetFrames(frames, size, fill = SAFE_FILL_OVERLAY) {
  const mod = await getCanvas();
  if (!mod) return frames;
  const inner = Math.max(1, Math.round(size * fill));
  if (inner >= size) return frames;
  const offset = Math.round((size - inner) / 2);
  const src = mod.createCanvas(size, size);
  const srcCtx = src.getContext("2d");
  const dst = mod.createCanvas(size, size);
  const dstCtx = dst.getContext("2d");
  const out = [];
  for (const frame of frames) {
    const image = srcCtx.createImageData(size, size);
    image.data.set(frame);
    srcCtx.putImageData(image, 0, 0);
    dstCtx.clearRect(0, 0, size, size);
    dstCtx.imageSmoothingEnabled = true;
    dstCtx.drawImage(src, offset, offset, inner, inner);
    out.push(new Uint8ClampedArray(dstCtx.getImageData(0, 0, size, size).data));
  }
  return out;
}
async function encodeFrames(rawFrames, size, format, delayMs, family = "transform") {
  const fill = family === "transform" || family === "passthrough" ? SAFE_FILL_TRANSFORM : family === "frames" ? SAFE_FILL_FRAMES : SAFE_FILL_OVERLAY;
  const frames = await insetFrames(rawFrames, size, fill);
  if (format === "png") return encodePng(frames, size);
  if (format === "gif" || format === "apng") {
    return encodeGif(frames, size, delayMs);
  }
  if (format === "webp") {
    try {
      const sharp = (await import("sharp")).default;
      const frameImgs = await Promise.all(frames.map(async (f) => {
        const rgba = Buffer.from(f.buffer, f.byteOffset, f.byteLength);
        return sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).webp().toBuffer();
      }));
      void frameImgs;
      return encodeGif(frames, size, delayMs);
    } catch {
      return encodeGif(frames, size, delayMs);
    }
  }
  return encodeGif(frames, size, delayMs);
}
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new EmojiError("timeout", "Offline render timed out.")),
      ms
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}
export {
  renderOffline
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsicmVuZGVyZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gT2ZmbGluZSByZW5kZXJlci5cbi8vXG4vLyBEaXNwYXRjaGVzIGVhY2ggTWFrZUVtb2ppIHN0eWxlIHJlY2lwZSB0byB0aGUgcmlnaHQgZmFtaWx5IGNvbXBvc2l0b3I6XG4vLyAgIHBhc3N0aHJvdWdoIC8gdHJhbnNmb3JtIFx1MjE5MiBwcm9jZWR1cmFsIEVmZmVjdERlZiArIHNoYXJlZCBjb21wb3NpdG9yXG4vLyAgIG92ZXJsYXkgICAgICAgICAgICAgICAgIFx1MjE5MiBzdWJqZWN0LWluLWhvbGUgb3ZlcmxheSBjb21wb3NpdGVcbi8vICAgYXRsYXMgLyBmcmFtZXMgICAgICAgICAgXHUyMTkyIHJlZnVzZWQgdW50aWwgYXNzZXRzICsgcGxhY2VtZW50IGxhbmRcbi8vXG4vLyBVbnJlYWR5IHN0eWxlcyB0aHJvdyByYXRoZXIgdGhhbiBzaWxlbnRseSBzdWJzdGl0dXRpbmcgYW5vdGhlciBsb29rLlxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmltcG9ydCB7IHF1ZXVlUmVuZGVyLCBSRU5ERVJfUFJJT1JJVFkgfSBmcm9tIFwiLi4vLi4vLi4vYW5pbWF0aW9ucy9yZW5kZXItcXVldWUuanNcIjtcbmltcG9ydCB7IGdldENhbnZhcyB9IGZyb20gXCIuLi8uLi8uLi9hbmltYXRpb25zL2VuZ2luZS5qc1wiO1xuaW1wb3J0IHsgZW5jb2RlR2lmLCBlbmNvZGVQbmcgfSBmcm9tIFwiLi4vLi4vZW5jb2RlcnMvaW5kZXguanNcIjtcbmltcG9ydCB7IGNvbXBvc2UgfSBmcm9tIFwiLi4vLi4vcmVuZGVyZXIvY29tcG9zaXRvci5qc1wiO1xuaW1wb3J0IHsgRW1vamlFcnJvciB9IGZyb20gXCIuLi8uLi91dGlscy9lcnJvcnMuanNcIjtcbmltcG9ydCB7XG4gIGRlbGF5Rm9yLCBpc0xvY2FsRm9ybWF0LCBwYXJzZURpcmVjdGlvbiwgcGFyc2VTaXplLCBwYXJzZVNwZWVkLFxufSBmcm9tIFwiLi4vLi4vdXRpbHMvb3B0aW9ucy5qc1wiO1xuaW1wb3J0IHR5cGUgeyBHZW5lcmF0ZU9wdGlvbnMsIEdlbmVyYXRlUmVzdWx0IH0gZnJvbSBcIi4uLy4uL3R5cGVzLmpzXCI7XG5pbXBvcnQgeyBjb21wb3NlT3ZlcmxheSwgcmVzb2x2ZU92ZXJsYXlQYXRoIH0gZnJvbSBcIi4vb3ZlcmxheS5qc1wiO1xuaW1wb3J0IHsgY29tcG9zZVNlcXVlbmNlLCByZXNvbHZlQXRsYXNEaXIsIHJlc29sdmVGcmFtZXNEaXIgfSBmcm9tIFwiLi9hdGxhcy5qc1wiO1xuaW1wb3J0IHsgY29tcG9zZUxheWVyUGFjaywgaGFzTGF5ZXJQYWNrIH0gZnJvbSBcIi4vbGF5ZXItcGFjay5qc1wiO1xuaW1wb3J0IHsgZGlyZWN0aW9uRnJvbVJlY2lwZSwgZWZmZWN0RnJvbVByaW1pdGl2ZSB9IGZyb20gXCIuL3ByaW1pdGl2ZXMuanNcIjtcbmltcG9ydCB7IGZpbmRSZWNpcGUgfSBmcm9tIFwiLi9yZWNpcGVzLmpzXCI7XG5pbXBvcnQgeyBmaW5kT2ZmbGluZVN0eWxlIH0gZnJvbSBcIi4vcmVnaXN0cnkuanNcIjtcbmltcG9ydCB7IHJlbmRlclNjZW5lLCBzY2VuZUlkT2YsIHNjZW5lUmVuZGVyT3B0aW9ucyB9IGZyb20gXCIuL3NjZW5lLXBhY2suanNcIjtcbmltcG9ydCB7XG4gIGFwcGx5Q29sb3JGaWx0ZXIsXG4gIGNvbG9yRnJhbWVDb3VudCxcbiAgY29sb3JJc0FuaW1hdGVkLFxuICBub3JtYWxpemVDb2xvcixcbiAgdGludEltYWdlQnVmZmVyLFxufSBmcm9tIFwiLi9jb2xvci1maWx0ZXIuanNcIjtcblxuY29uc3QgUkVOREVSX1RJTUVPVVRfTVMgPSAyMF8wMDA7XG5cbmZ1bmN0aW9uIHN0eWxlU2x1ZyhhbmltYXRpb246IHN0cmluZywgcmVjaXBlSWQ/OiBzdHJpbmcsIHN0eWxlSWQ/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByYXcgPSByZWNpcGVJZCA/PyBzdHlsZUlkID8/IGFuaW1hdGlvbjtcbiAgcmV0dXJuIHJhdy5yZXBsYWNlKC9eZ2VuX2J0bl8vLCBcIlwiKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlbmRlck9mZmxpbmUob3B0aW9uczogR2VuZXJhdGVPcHRpb25zKTogUHJvbWlzZTxHZW5lcmF0ZVJlc3VsdD4ge1xuICAvLyBTY2VuZSBwYWNrcyBhcmUgd2hvbGUgZ3JlZW4vYmx1ZS1zY3JlZW4gY2xpcHMgY29tcG9zaXRlZCBhdCBuYXRpdmUgc2l6ZSBcdTIwMTRcbiAgLy8gYSBkaWZmZXJlbnQgZmFtaWx5IGZyb20gdGhlIHNtYWxsIE1ha2VFbW9qaSBzdHlsZXMsIHNvIHRoZXkgc2hvcnQtY2lyY3VpdFxuICAvLyB0aGUgbWFuaWZlc3QgbG9va3VwIGFuZCB0aGUgZW1vamkgZm9ybWF0L3NpemUgcnVsZXMgZW50aXJlbHkuIFRoZXkgYWx3YXlzXG4gIC8vIGVtaXQgYSBHSUYuIGBwcmV2aWV3YCAodGhlIGJvYXJkL2hvdmVyIHRodW1ibmFpbCkgeWllbGRzIGEgc21hbGwsIGZldy1mcmFtZVxuICAvLyByZW5kZXI7IG90aGVyd2lzZSB0aGUgU2l6ZSArIFNwZWVkIGNvbnRyb2xzIHNoYXBlIHRoZSBmaW5hbCBHSUYuXG4gIGNvbnN0IHNjZW5lSWQgPSBzY2VuZUlkT2Yob3B0aW9ucy5hbmltYXRpb24pO1xuICBpZiAoc2NlbmVJZCkge1xuICAgIGNvbnN0IHN0YXJ0ZWRTY2VuZSA9IERhdGUubm93KCk7XG4gICAgLy8gU2NlbmUgY29tcG9zaXRlcyBhcmUgdGhlIGhlYXZpZXN0IG9mZmxpbmUgcmVuZGVyIChhIG5hdGl2ZSBzaGFycCBkZWNvZGUgcGVyXG4gICAgLy8gZnJhbWUpLCBzbyByb3V0ZSB0aGVtIHRocm91Z2ggdGhlIHNoYXJlZCBxdWV1ZSBcdTIwMTQgYm91bmRlZCBjb25jdXJyZW5jeSBrZWVwc1xuICAgIC8vIHNldmVyYWwgc2ltdWx0YW5lb3VzIHVzZXJzIGZyb20gc3Bpa2luZyBDUFUgXHUyMDE0IGFuZCBsZXQgYSBmaW5hbCByZW5kZXIgb3V0cmFua1xuICAgIC8vIGEgcHJldmlldyB0aHVtYm5haWwuXG4gICAgY29uc3QgYnVmZmVyID0gYXdhaXQgcXVldWVSZW5kZXIoXG4gICAgICBgZW1vamktc2NlbmU6JHtzY2VuZUlkfWAsXG4gICAgICAoKSA9PiByZW5kZXJTY2VuZShcbiAgICAgICAgb3B0aW9ucy5pbWFnZSwgc2NlbmVJZCxcbiAgICAgICAgc2NlbmVSZW5kZXJPcHRpb25zKHsgc2l6ZTogb3B0aW9ucy5zaXplLCBzcGVlZDogb3B0aW9ucy5zcGVlZCwgcHJldmlldzogb3B0aW9ucy5wcmV2aWV3IH0pLFxuICAgICAgKSxcbiAgICAgIG9wdGlvbnMucHJldmlldyA/IFJFTkRFUl9QUklPUklUWS5wcmV2aWV3IDogUkVOREVSX1BSSU9SSVRZLm91dHB1dCxcbiAgICApO1xuICAgIHJldHVybiB7XG4gICAgICBidWZmZXIsIGZvcm1hdDogXCJnaWZcIiwgYnl0ZXM6IGJ1ZmZlci5sZW5ndGgsIHByb3ZpZGVySWQ6IFwib2ZmbGluZVwiLFxuICAgICAgZHVyYXRpb25NczogRGF0ZS5ub3coKSAtIHN0YXJ0ZWRTY2VuZSwgY2FjaGVkOiBmYWxzZSxcbiAgICB9O1xuICB9XG5cbiAgaWYgKCFpc0xvY2FsRm9ybWF0KG9wdGlvbnMuZm9ybWF0KSAmJiBvcHRpb25zLmZvcm1hdCAhPT0gXCJ3ZWJwXCIgJiYgb3B0aW9ucy5mb3JtYXQgIT09IFwiYXBuZ1wiKSB7XG4gICAgdGhyb3cgbmV3IEVtb2ppRXJyb3IoXG4gICAgICBcInVuc3VwcG9ydGVkX2Zvcm1hdFwiLFxuICAgICAgYFRoZSBvZmZsaW5lIGJhY2t1cCBjYW4ndCBwcm9kdWNlICR7b3B0aW9ucy5mb3JtYXQudG9VcHBlckNhc2UoKX0geWV0IFx1MjAxNCB0cnkgR0lGLCBXZWJQIG9yIEFQTkcuYCxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgcmVjaXBlID0gZmluZFJlY2lwZShvcHRpb25zLmFuaW1hdGlvbik7XG4gIGNvbnN0IHN0eWxlID0gZmluZE9mZmxpbmVTdHlsZShvcHRpb25zLmFuaW1hdGlvbik7XG4gIGNvbnN0IHNsdWcgPSBzdHlsZVNsdWcob3B0aW9ucy5hbmltYXRpb24sIHJlY2lwZT8uc2x1ZyA/PyByZWNpcGU/LmlkLCBzdHlsZT8uaWQpO1xuICBjb25zdCBsYXllclJlYWR5ID0gaGFzTGF5ZXJQYWNrKHNsdWcpO1xuXG4gIGlmICghcmVjaXBlICYmICFzdHlsZSAmJiAhbGF5ZXJSZWFkeSkge1xuICAgIHRocm93IG5ldyBFbW9qaUVycm9yKFxuICAgICAgXCJ1bmtub3duX2VmZmVjdFwiLFxuICAgICAgYFxcYCR7b3B0aW9ucy5hbmltYXRpb259XFxgIGlzbid0IGluIHRoZSBvZmZsaW5lIE1ha2VFbW9qaSBzdHlsZSBhcmNoaXZlLmAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIFByZWZlciBhIHJlY2lwZSB3aXRoIGEgcHJpbWl0aXZlLiBvZmZsaW5lUmVhZHkgaXMgdGhlICpjbGFpbSogZ2F0ZSB1c2VkIGJ5XG4gIC8vIGltcGxlbWVudGVkT2ZmbGluZVN0eWxlcyAvIHBhY2thZ2Ugc3RhdHMgXHUyMDE0IHZlcmlmaWNhdGlvbiBtdXN0IGJlIGFibGUgdG9cbiAgLy8gcmVuZGVyIGNhbmRpZGF0ZXMgYmVmb3JlIGZsaXBwaW5nIHRoYXQgZmxhZy5cbiAgLy8gSGFydmVzdGVkIE1ha2VFbW9qaSBncmVlbi1zY3JlZW4gbGF5ZXIgcGFja3MgYWx3YXlzIHdpbiB3aGVuIHByZXNlbnQuXG4gIGNvbnN0IGNhblJlbmRlciA9IGxheWVyUmVhZHlcbiAgICB8fCBCb29sZWFuKHJlY2lwZT8ucHJpbWl0aXZlKVxuICAgIHx8IEJvb2xlYW4oc3R5bGU/Lm9mZmxpbmVJbXBsZW1lbnRlZCAmJiBzdHlsZS5vZmZsaW5lRWZmZWN0SWQpO1xuICBpZiAoIWNhblJlbmRlcikge1xuICAgIGNvbnN0IGlkID0gcmVjaXBlPy5pZCA/PyBzdHlsZT8uaWQgPz8gb3B0aW9ucy5hbmltYXRpb247XG4gICAgdGhyb3cgbmV3IEVtb2ppRXJyb3IoXG4gICAgICBcInVua25vd25fZWZmZWN0XCIsXG4gICAgICBgXFxgJHtpZH1cXGAgaXMgYXJjaGl2ZWQgZnJvbSBNYWtlRW1vamkgYnV0IG5vdCBpbXBsZW1lbnRlZCBvZmZsaW5lIHlldC5gLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBzaXplID0gcGFyc2VTaXplKG9wdGlvbnMuc2l6ZSk7XG4gIGNvbnN0IHNwZWVkID0gcGFyc2VTcGVlZChvcHRpb25zLnNwZWVkKTtcbiAgY29uc3QgZGlyZWN0aW9uID0gZGlyZWN0aW9uRnJvbVJlY2lwZShcbiAgICAocmVjaXBlPy5wYXJhbXMgPz8ge30pIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICAgIHBhcnNlRGlyZWN0aW9uKG9wdGlvbnMuZGlyZWN0aW9uKSxcbiAgKTtcblxuICBjb25zdCBzdGFydGVkID0gRGF0ZS5ub3coKTtcbiAgY29uc3QgZmFtaWx5ID0gcmVjaXBlPy5mYW1pbHkgPz8gXCJ0cmFuc2Zvcm1cIjtcbiAgY29uc3QgcHJpbWl0aXZlID0gcmVjaXBlPy5wcmltaXRpdmUgPz8gc3R5bGU/Lm9mZmxpbmVFZmZlY3RJZCA/PyBudWxsO1xuICAvLyBNYWtlRW1vamkgQ29sb3VyIHNpZGUtY29udHJvbDogcmVjb2xvcnMgdGhlIHVwbG9hZCBiZWZvcmUvd2hpbGUgdGhlIHN0eWxlIHJ1bnMuXG4gIGNvbnN0IGNvbG9yID0gbm9ybWFsaXplQ29sb3Iob3B0aW9ucy5jb2xvcik7XG5cbiAgY29uc3QgYnVmZmVyID0gYXdhaXQgd2l0aFRpbWVvdXQocXVldWVSZW5kZXIoYGVtb2ppLW9mZmxpbmU6JHtyZWNpcGU/LmlkID8/IHN0eWxlPy5pZCA/PyBzbHVnfWAsIGFzeW5jICgpID0+IHtcbiAgICAvLyBQcmV2aWV3cy9ib2FyZCBjZWxscyB5aWVsZCB0byBvbi1kZW1hbmQgb3V0cHV0IHVuZGVyIGxvYWQgKHNlZSBiZWxvdykuXG4gICAgLy8gR29sZCBwYXRoOiByZWFsIE1ha2VFbW9qaSBHSUYgaGFydmVzdGVkIHdpdGggYSBncmVlbiBzdWJqZWN0LCBjaHJvbWEta2V5ZWQuXG4gICAgaWYgKGxheWVyUmVhZHkpIHtcbiAgICAgIGNvbnN0IHBhY2sgPSBhd2FpdCBjb21wb3NlTGF5ZXJQYWNrKHsgaW1hZ2U6IG9wdGlvbnMuaW1hZ2UsIHNsdWcsIHNpemUgfSk7XG4gICAgICAvLyBDb2xvdXIgc3RpbGwgYXBwbGllcyB0byB0aGUgc3ViamVjdCBiZWZvcmUgY29tcG9zaXRpbmcgd2hlbiByZXF1ZXN0ZWQuXG4gICAgICBpZiAoY29sb3IpIHtcbiAgICAgICAgcmV0dXJuIGNvbXBvc2VXaXRoQ29sb3Ioe1xuICAgICAgICAgIGZhbWlseTogXCJmcmFtZXNcIixcbiAgICAgICAgICBpbWFnZTogb3B0aW9ucy5pbWFnZSxcbiAgICAgICAgICBjb2xvcixcbiAgICAgICAgICBmb3JtYXQ6IG9wdGlvbnMuZm9ybWF0LFxuICAgICAgICAgIHNpemUsXG4gICAgICAgICAgc3BlZWQsXG4gICAgICAgICAgYmFzZUZyYW1lczogb3B0aW9ucy5mb3JtYXQgPT09IFwicG5nXCIgPyAxIDogcGFjay5mcmFtZXMubGVuZ3RoLFxuICAgICAgICAgIGNvbXBvc2VPbmU6IGFzeW5jIChpbWFnZSwgX2ZyYW1lQ291bnQpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGFnYWluID0gYXdhaXQgY29tcG9zZUxheWVyUGFjayh7IGltYWdlLCBzbHVnLCBzaXplIH0pO1xuICAgICAgICAgICAgcmV0dXJuIGFnYWluLmZyYW1lcztcbiAgICAgICAgICB9LFxuICAgICAgICAgIGRlbGF5TXM6IHBhY2suZGVsYXlNcyxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm4gZW5jb2RlRnJhbWVzKFxuICAgICAgICBwYWNrLmZyYW1lcyxcbiAgICAgICAgc2l6ZSxcbiAgICAgICAgb3B0aW9ucy5mb3JtYXQsXG4gICAgICAgIGRlbGF5Rm9yKHBhY2suZGVsYXlNcywgc3BlZWQpLFxuICAgICAgICBcImZyYW1lc1wiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAoZmFtaWx5ID09PSBcIm92ZXJsYXlcIikge1xuICAgICAgY29uc3Qgc2x1ZyA9IHJlY2lwZSEuc2x1ZztcbiAgICAgIGNvbnN0IG92ZXJsYXlQYXRoID0gcmVzb2x2ZU92ZXJsYXlQYXRoKHNsdWcpO1xuICAgICAgaWYgKCFvdmVybGF5UGF0aCkge1xuICAgICAgICB0aHJvdyBuZXcgRW1vamlFcnJvcihcbiAgICAgICAgICBcInVua25vd25fZWZmZWN0XCIsXG4gICAgICAgICAgYE92ZXJsYXkgYXNzZXQgZm9yIFxcYCR7c2x1Z31cXGAgaXMgbWlzc2luZyBmcm9tIHRoZSBvZmZsaW5lIHBhY2thZ2UuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGZyYW1lcyA9IGF3YWl0IGNvbXBvc2VXaXRoQ29sb3Ioe1xuICAgICAgICBmYW1pbHk6IFwib3ZlcmxheVwiLFxuICAgICAgICBpbWFnZTogb3B0aW9ucy5pbWFnZSxcbiAgICAgICAgY29sb3IsXG4gICAgICAgIGZvcm1hdDogb3B0aW9ucy5mb3JtYXQsXG4gICAgICAgIHNpemUsXG4gICAgICAgIHNwZWVkLFxuICAgICAgICBiYXNlRnJhbWVzOiBvcHRpb25zLmZvcm1hdCA9PT0gXCJwbmdcIiA/IDEgOiA4LFxuICAgICAgICBjb21wb3NlT25lOiBhc3luYyAoaW1hZ2UsIGZyYW1lQ291bnQpID0+IGNvbXBvc2VPdmVybGF5KHtcbiAgICAgICAgICBpbWFnZSwgb3ZlcmxheVBhdGgsIHNpemUsIGZyYW1lczogZnJhbWVDb3VudCxcbiAgICAgICAgfSksXG4gICAgICAgIGRlbGF5TXM6IDU1LFxuICAgICAgfSk7XG4gICAgICByZXR1cm4gZnJhbWVzO1xuICAgIH1cblxuICAgIGlmIChmYW1pbHkgPT09IFwiYXRsYXNcIiB8fCBmYW1pbHkgPT09IFwiZnJhbWVzXCIpIHtcbiAgICAgIGNvbnN0IHNsdWcgPSByZWNpcGUhLnNsdWc7XG4gICAgICAvLyBQcmVmZXIgcmVhbCBDRE4gZnJhbWUgUE5HcyBvdmVyIGF0bGFzIHNwcml0ZS1zaGVldHMgd2hlbmV2ZXIgYm90aCBleGlzdC5cbiAgICAgIC8vIERyYXdpbmcgYSBzaGVldCB3aG9sZSBpcyB3aGF0IHRpbGVkIHRoZSBzdWJqZWN0IGFjcm9zcyB0aGUgY2FudmFzLlxuICAgICAgY29uc3QgZnJhbWVzRGlyID0gcmVzb2x2ZUZyYW1lc0RpcihzbHVnKTtcbiAgICAgIGNvbnN0IGF0bGFzRGlyID0gcmVzb2x2ZUF0bGFzRGlyKHNsdWcpO1xuICAgICAgY29uc3QgcmVzb2x2ZWQgPSBmcmFtZXNEaXIgPz8gYXRsYXNEaXJcbiAgICAgICAgPz8gKGZhbWlseSA9PT0gXCJhdGxhc1wiID8gcmVzb2x2ZUZyYW1lc0RpcihzbHVnKSA6IHJlc29sdmVBdGxhc0RpcihzbHVnKSk7XG4gICAgICBpZiAoIXJlc29sdmVkKSB7XG4gICAgICAgIHRocm93IG5ldyBFbW9qaUVycm9yKFxuICAgICAgICAgIFwidW5rbm93bl9lZmZlY3RcIixcbiAgICAgICAgICBgJHtmYW1pbHl9IGFzc2V0cyBmb3IgXFxgJHtzbHVnfVxcYCBhcmUgbWlzc2luZyBmcm9tIHRoZSBvZmZsaW5lIHBhY2thZ2UuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBjb21wb3NlV2l0aENvbG9yKHtcbiAgICAgICAgZmFtaWx5LFxuICAgICAgICBpbWFnZTogb3B0aW9ucy5pbWFnZSxcbiAgICAgICAgY29sb3IsXG4gICAgICAgIGZvcm1hdDogb3B0aW9ucy5mb3JtYXQsXG4gICAgICAgIHNpemUsXG4gICAgICAgIHNwZWVkLFxuICAgICAgICBiYXNlRnJhbWVzOiBvcHRpb25zLmZvcm1hdCA9PT0gXCJwbmdcIiA/IDEgOiAyNCxcbiAgICAgICAgY29tcG9zZU9uZTogYXN5bmMgKGltYWdlLCBmcmFtZUNvdW50KSA9PiBjb21wb3NlU2VxdWVuY2Uoe1xuICAgICAgICAgIGltYWdlLCBzZXF1ZW5jZURpcjogcmVzb2x2ZWQsIHNpemUsIG1heEZyYW1lczogZnJhbWVDb3VudCxcbiAgICAgICAgfSksXG4gICAgICAgIGRlbGF5TXM6IDUwLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKGZhbWlseSA9PT0gXCJwYXNzdGhyb3VnaFwiIHx8IGZhbWlseSA9PT0gXCJ0cmFuc2Zvcm1cIikge1xuICAgICAgaWYgKCFwcmltaXRpdmUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVtb2ppRXJyb3IoXCJ1bmtub3duX2VmZmVjdFwiLCBgTm8gcHJpbWl0aXZlIGZvciBcXGAke3JlY2lwZT8uaWR9XFxgLmApO1xuICAgICAgfVxuICAgICAgY29uc3QgZWZmZWN0ID0gZWZmZWN0RnJvbVByaW1pdGl2ZShwcmltaXRpdmUsIChyZWNpcGU/LnBhcmFtcyA/PyB7fSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xuICAgICAgaWYgKCFlZmZlY3QpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVtb2ppRXJyb3IoXCJ1bmtub3duX2VmZmVjdFwiLCBgVW5rbm93biBvZmZsaW5lIHByaW1pdGl2ZSBcXGAke3ByaW1pdGl2ZX1cXGAuYCk7XG4gICAgICB9XG4gICAgICBjb25zdCBhbmltYXRlZCA9IG9wdGlvbnMuZm9ybWF0ICE9PSBcInBuZ1wiO1xuICAgICAgY29uc3Qgc3R5bGVGcmFtZXMgPSBhbmltYXRlZCA/IGVmZmVjdC5mcmFtZXMgOiAxO1xuICAgICAgLy8gQ29sb3VyIGFsb25lIChzdHlsZSBgbm9uZWApIG11c3Qgc3RpbGwgcHJvZHVjZSBhIGxvb3BpbmcgR0lGIHdoZW4gdGhlXG4gICAgICAvLyBDb2xvdXIgbW9kZSBpcyBhbmltYXRlZCBcdTIwMTQgbWF0Y2hpbmcgTWFrZUVtb2ppJ3MgQ29sb3JzL1JhaW5ib3cvZXRjLlxuICAgICAgY29uc3Qgd2FudEZyYW1lcyA9IGFuaW1hdGVkXG4gICAgICAgID8gTWF0aC5tYXgoc3R5bGVGcmFtZXMsIGNvbG9yRnJhbWVDb3VudChjb2xvciwgMTIpKVxuICAgICAgICA6IDE7XG4gICAgICByZXR1cm4gY29tcG9zZVdpdGhDb2xvcih7XG4gICAgICAgIGZhbWlseSxcbiAgICAgICAgaW1hZ2U6IG9wdGlvbnMuaW1hZ2UsXG4gICAgICAgIGNvbG9yLFxuICAgICAgICBmb3JtYXQ6IG9wdGlvbnMuZm9ybWF0LFxuICAgICAgICBzaXplLFxuICAgICAgICBzcGVlZCxcbiAgICAgICAgYmFzZUZyYW1lczogd2FudEZyYW1lcyxcbiAgICAgICAgY29tcG9zZU9uZTogYXN5bmMgKGltYWdlLCBmcmFtZUNvdW50KSA9PiBjb21wb3NlKHtcbiAgICAgICAgICBpbWFnZSwgZWZmZWN0LCBkaXJlY3Rpb24sIHNpemUsIGZyYW1lczogZnJhbWVDb3VudCxcbiAgICAgICAgfSksXG4gICAgICAgIGRlbGF5TXM6IGVmZmVjdC5kZWxheU1zLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgdGhyb3cgbmV3IEVtb2ppRXJyb3IoXG4gICAgICBcInVua25vd25fZWZmZWN0XCIsXG4gICAgICBgT2ZmbGluZSBmYW1pbHkgXFxgJHtmYW1pbHl9XFxgIGlzIG5vdCByZW5kZXJhYmxlIHlldCBmb3IgXFxgJHtyZWNpcGU/LmlkfVxcYC5gLFxuICAgICk7XG4gIH0sIG9wdGlvbnMucHJldmlldyA/IFJFTkRFUl9QUklPUklUWS5wcmV2aWV3IDogUkVOREVSX1BSSU9SSVRZLm91dHB1dCksIFJFTkRFUl9USU1FT1VUX01TKTtcblxuICByZXR1cm4ge1xuICAgIGJ1ZmZlcixcbiAgICBmb3JtYXQ6IG9wdGlvbnMuZm9ybWF0ID09PSBcImFwbmdcIiA/IFwiYXBuZ1wiIDogb3B0aW9ucy5mb3JtYXQgPT09IFwid2VicFwiID8gXCJ3ZWJwXCIgOiBvcHRpb25zLmZvcm1hdCxcbiAgICBieXRlczogYnVmZmVyLmxlbmd0aCxcbiAgICBwcm92aWRlcklkOiBcIm9mZmxpbmVcIixcbiAgICBkdXJhdGlvbk1zOiBEYXRlLm5vdygpIC0gc3RhcnRlZCxcbiAgICBjYWNoZWQ6IGZhbHNlLFxuICB9O1xufVxuXG4vKipcbiAqIENvbXBvc2Ugd2l0aCBvcHRpb25hbCBNYWtlRW1vamkgQ29sb3VyIHByZS1maWx0ZXIgb24gdGhlIHN1YmplY3QuXG4gKlxuICogU3RhdGljIENvbG91cjogdGludCB0aGUgdXBsb2FkIG9uY2UsIHRoZW4gcnVuIHRoZSBzdHlsZSBhcyB1c3VhbC5cbiAqIEFuaW1hdGVkIENvbG91cjogdGludCB0aGUgdXBsb2FkIHBlciBmcmFtZSBwaGFzZSBhbmQgY29tcG9zaXRlIG9uZSBmcmFtZVxuICogYXQgYSB0aW1lIHNvIENvbG91ciBjeWNsZXMgd2hpbGUgdGhlIHN0eWxlIHBsYXlzIChvciBhbG9uZSB1bmRlciBgbm9uZWApLlxuICovXG5hc3luYyBmdW5jdGlvbiBjb21wb3NlV2l0aENvbG9yKG9wdHM6IHtcbiAgZmFtaWx5OiBzdHJpbmc7XG4gIGltYWdlOiBCdWZmZXI7XG4gIGNvbG9yOiBzdHJpbmcgfCBudWxsO1xuICBmb3JtYXQ6IEdlbmVyYXRlT3B0aW9uc1tcImZvcm1hdFwiXTtcbiAgc2l6ZTogbnVtYmVyO1xuICBzcGVlZDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VTcGVlZD47XG4gIGJhc2VGcmFtZXM6IG51bWJlcjtcbiAgY29tcG9zZU9uZTogKGltYWdlOiBCdWZmZXIsIGZyYW1lQ291bnQ6IG51bWJlcikgPT4gUHJvbWlzZTxVaW50OENsYW1wZWRBcnJheVtdPjtcbiAgZGVsYXlNczogbnVtYmVyO1xufSk6IFByb21pc2U8QnVmZmVyPiB7XG4gIGNvbnN0IHsgZmFtaWx5LCBpbWFnZSwgY29sb3IsIGZvcm1hdCwgc2l6ZSwgc3BlZWQsIGJhc2VGcmFtZXMsIGNvbXBvc2VPbmUsIGRlbGF5TXMgfSA9IG9wdHM7XG5cbiAgaWYgKCFjb2xvcikge1xuICAgIGNvbnN0IGZyYW1lcyA9IGF3YWl0IGNvbXBvc2VPbmUoaW1hZ2UsIGJhc2VGcmFtZXMpO1xuICAgIHJldHVybiBlbmNvZGVGcmFtZXMoZnJhbWVzLCBzaXplLCBmb3JtYXQsIGRlbGF5Rm9yKGRlbGF5TXMsIHNwZWVkKSwgZmFtaWx5KTtcbiAgfVxuXG4gIGlmICghY29sb3JJc0FuaW1hdGVkKGNvbG9yKSB8fCBmb3JtYXQgPT09IFwicG5nXCIpIHtcbiAgICBjb25zdCB0aW50ZWQgPSBhd2FpdCB0aW50SW1hZ2VCdWZmZXIoaW1hZ2UsIGNvbG9yLCAwKTtcbiAgICBjb25zdCBmcmFtZXMgPSBhd2FpdCBjb21wb3NlT25lKHRpbnRlZCwgZm9ybWF0ID09PSBcInBuZ1wiID8gMSA6IGJhc2VGcmFtZXMpO1xuICAgIHJldHVybiBlbmNvZGVGcmFtZXMoZnJhbWVzLCBzaXplLCBmb3JtYXQsIGRlbGF5Rm9yKGRlbGF5TXMsIHNwZWVkKSwgZmFtaWx5KTtcbiAgfVxuXG4gIC8vIEFuaW1hdGVkIGNvbG91cjogb25lIGNvbXBvc2l0ZWQgZnJhbWUgcGVyIHBoYXNlIHNvIGh1ZS9zdHJpcGVzIGN5Y2xlLlxuICBjb25zdCBuID0gTWF0aC5tYXgoYmFzZUZyYW1lcywgY29sb3JGcmFtZUNvdW50KGNvbG9yLCAxMikpO1xuICBjb25zdCBmcmFtZXM6IFVpbnQ4Q2xhbXBlZEFycmF5W10gPSBbXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBuOyBpKyspIHtcbiAgICBjb25zdCB0aW50ZWQgPSBhd2FpdCB0aW50SW1hZ2VCdWZmZXIoaW1hZ2UsIGNvbG9yLCBpIC8gbik7XG4gICAgY29uc3Qgb25lID0gYXdhaXQgY29tcG9zZU9uZSh0aW50ZWQsIDEpO1xuICAgIGlmIChvbmVbMF0pIGZyYW1lcy5wdXNoKG9uZVswXSk7XG4gIH1cbiAgdm9pZCBhcHBseUNvbG9yRmlsdGVyOyAvLyByZXNlcnZlZCBmb3IgcmF3LWJ1ZmZlciBwYXRoXG4gIHJldHVybiBlbmNvZGVGcmFtZXMoZnJhbWVzLCBzaXplLCBmb3JtYXQsIGRlbGF5Rm9yKGRlbGF5TXMsIHNwZWVkKSwgZmFtaWx5KTtcbn1cblxuLyoqXG4gKiBGcmFjdGlvbiBvZiB0aGUgY2FudmFzIHRoZSBmaW5pc2hlZCBhcnQgaXMga2VwdCB3aXRoaW4uXG4gKlxuICogLSBmcmFtZXM6IGFscmVhZHkgYXV0aG9yZWQgd2l0aCB0cmFuc3BhcmVudCBtYXJnaW5zIFx1MjAxNCBkbyBub3QgcmVzYW1wbGVcbiAqICAgKGJpbGluZWFyIGluc2V0IGRlc3Ryb3lzIEFBIHJpbXMgXHUyMTkyIFwibWlzc2luZyBwaXhlbHNcIiBhZnRlciBHSUYgZGl0aGVyKS5cbiAqIC0gYXRsYXMvb3ZlcmxheTogbGlnaHQgaW5zZXQgc28gY2hyb21lIG5ldmVyIGtpc3NlcyB0aGUgRGlzY29yZCBjcm9wIGVkZ2UuXG4gKiAtIHRyYW5zZm9ybTogZGVlcGVyIHNhZmUgYm94IHNvIHNwaW4vc2xpZGUgbmV2ZXIgY2xpcHMuXG4gKi9cbmNvbnN0IFNBRkVfRklMTF9GUkFNRVMgPSAwLjk4O1xuY29uc3QgU0FGRV9GSUxMX09WRVJMQVkgPSAwLjk2O1xuY29uc3QgU0FGRV9GSUxMX1RSQU5TRk9STSA9IDAuOTtcblxuLyoqXG4gKiBTY2FsZSBlYWNoIGZyYW1lJ3MgY29udGVudCBpbnRvIGEgY2VudGVyZWQgaW5zZXQgYm94IHNvIG5vIGFydCB0b3VjaGVzIHRoZVxuICogZWRnZS4gUnVucyBhdCB0aGUgc2luZ2xlIGVuY29kZSBmdW5uZWwuIEZ1bGx5LXRyYW5zcGFyZW50IGZyYW1lcyBwYXNzIHRocm91Z2hcbiAqIHVudG91Y2hlZC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gaW5zZXRGcmFtZXMoXG4gIGZyYW1lczogVWludDhDbGFtcGVkQXJyYXlbXSxcbiAgc2l6ZTogbnVtYmVyLFxuICBmaWxsID0gU0FGRV9GSUxMX09WRVJMQVksXG4pOiBQcm9taXNlPFVpbnQ4Q2xhbXBlZEFycmF5W10+IHtcbiAgY29uc3QgbW9kID0gYXdhaXQgZ2V0Q2FudmFzKCk7XG4gIGlmICghbW9kKSByZXR1cm4gZnJhbWVzO1xuXG4gIGNvbnN0IGlubmVyID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChzaXplICogZmlsbCkpO1xuICBpZiAoaW5uZXIgPj0gc2l6ZSkgcmV0dXJuIGZyYW1lcztcbiAgY29uc3Qgb2Zmc2V0ID0gTWF0aC5yb3VuZCgoc2l6ZSAtIGlubmVyKSAvIDIpO1xuXG4gIGNvbnN0IHNyYyA9IG1vZC5jcmVhdGVDYW52YXMoc2l6ZSwgc2l6ZSk7XG4gIGNvbnN0IHNyY0N0eCA9IHNyYy5nZXRDb250ZXh0KFwiMmRcIikgYXMgdW5rbm93biBhcyBQaXhlbEN0eDtcbiAgY29uc3QgZHN0ID0gbW9kLmNyZWF0ZUNhbnZhcyhzaXplLCBzaXplKTtcbiAgY29uc3QgZHN0Q3R4ID0gZHN0LmdldENvbnRleHQoXCIyZFwiKSBhcyB1bmtub3duIGFzIChQaXhlbEN0eCAmIHtcbiAgICBjbGVhclJlY3QoeDogbnVtYmVyLCB5OiBudW1iZXIsIHc6IG51bWJlciwgaDogbnVtYmVyKTogdm9pZDtcbiAgICBkcmF3SW1hZ2UoaW1nOiB1bmtub3duLCBkeDogbnVtYmVyLCBkeTogbnVtYmVyLCBkdzogbnVtYmVyLCBkaDogbnVtYmVyKTogdm9pZDtcbiAgICBpbWFnZVNtb290aGluZ0VuYWJsZWQ6IGJvb2xlYW47XG4gIH0pO1xuXG4gIGNvbnN0IG91dDogVWludDhDbGFtcGVkQXJyYXlbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGZyYW1lIG9mIGZyYW1lcykge1xuICAgIGNvbnN0IGltYWdlID0gc3JjQ3R4LmNyZWF0ZUltYWdlRGF0YShzaXplLCBzaXplKTtcbiAgICBpbWFnZS5kYXRhLnNldChmcmFtZSk7XG4gICAgc3JjQ3R4LnB1dEltYWdlRGF0YShpbWFnZSwgMCwgMCk7XG5cbiAgICBkc3RDdHguY2xlYXJSZWN0KDAsIDAsIHNpemUsIHNpemUpO1xuICAgIGRzdEN0eC5pbWFnZVNtb290aGluZ0VuYWJsZWQgPSB0cnVlO1xuICAgIGRzdEN0eC5kcmF3SW1hZ2Uoc3JjIGFzIHVua25vd24sIG9mZnNldCwgb2Zmc2V0LCBpbm5lciwgaW5uZXIpO1xuICAgIG91dC5wdXNoKG5ldyBVaW50OENsYW1wZWRBcnJheShkc3RDdHguZ2V0SW1hZ2VEYXRhKDAsIDAsIHNpemUsIHNpemUpLmRhdGEpKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG5pbnRlcmZhY2UgUGl4ZWxDdHgge1xuICBnZXRJbWFnZURhdGEoc3g6IG51bWJlciwgc3k6IG51bWJlciwgc3c6IG51bWJlciwgc2g6IG51bWJlcik6IHsgZGF0YTogVWludDhDbGFtcGVkQXJyYXkgfTtcbiAgcHV0SW1hZ2VEYXRhKGltYWdlOiB7IGRhdGE6IFVpbnQ4Q2xhbXBlZEFycmF5IH0sIGR4OiBudW1iZXIsIGR5OiBudW1iZXIpOiB2b2lkO1xuICBjcmVhdGVJbWFnZURhdGEoc3c6IG51bWJlciwgc2g6IG51bWJlcik6IHsgZGF0YTogVWludDhDbGFtcGVkQXJyYXkgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZW5jb2RlRnJhbWVzKFxuICByYXdGcmFtZXM6IFVpbnQ4Q2xhbXBlZEFycmF5W10sXG4gIHNpemU6IG51bWJlcixcbiAgZm9ybWF0OiBHZW5lcmF0ZU9wdGlvbnNbXCJmb3JtYXRcIl0sXG4gIGRlbGF5TXM6IG51bWJlcixcbiAgZmFtaWx5OiBzdHJpbmcgPSBcInRyYW5zZm9ybVwiLFxuKTogUHJvbWlzZTxCdWZmZXI+IHtcbiAgLy8gZnJhbWVzOiBubyByZXNhbXBsZSAoYXV0aG9yZWQgbWFyZ2lucykuIGF0bGFzL292ZXJsYXk6IGxpZ2h0IGluc2V0LlxuICAvLyB0cmFuc2Zvcm06IGRlZXAgc2FmZSBib3guXG4gIGNvbnN0IGZpbGwgPSBmYW1pbHkgPT09IFwidHJhbnNmb3JtXCIgfHwgZmFtaWx5ID09PSBcInBhc3N0aHJvdWdoXCJcbiAgICA/IFNBRkVfRklMTF9UUkFOU0ZPUk1cbiAgICA6IGZhbWlseSA9PT0gXCJmcmFtZXNcIlxuICAgICAgPyBTQUZFX0ZJTExfRlJBTUVTXG4gICAgICA6IFNBRkVfRklMTF9PVkVSTEFZO1xuICBjb25zdCBmcmFtZXMgPSBhd2FpdCBpbnNldEZyYW1lcyhyYXdGcmFtZXMsIHNpemUsIGZpbGwpO1xuXG4gIGlmIChmb3JtYXQgPT09IFwicG5nXCIpIHJldHVybiBlbmNvZGVQbmcoZnJhbWVzLCBzaXplKTtcbiAgaWYgKGZvcm1hdCA9PT0gXCJnaWZcIiB8fCBmb3JtYXQgPT09IFwiYXBuZ1wiKSB7XG4gICAgLy8gQVBORzogZW1pdCBHSUYgZm9yIG5vdyAoYW5pbWF0ZWQpOyBEaXNjb3JkIGFjY2VwdHMgdGhlIGJ5dGVzIGFzIGEgZmlsZS5cbiAgICAvLyBBIGRlZGljYXRlZCBBUE5HIGVuY29kZXIgY2FuIHJlcGxhY2UgdGhpcyB3aXRob3V0IGNoYW5naW5nIHJlY2lwZXMuXG4gICAgcmV0dXJuIGVuY29kZUdpZihmcmFtZXMsIHNpemUsIGRlbGF5TXMpO1xuICB9XG4gIGlmIChmb3JtYXQgPT09IFwid2VicFwiKSB7XG4gICAgLy8gUHJlZmVyIHNoYXJwIGFuaW1hdGVkIFdlYlAgd2hlbiBhdmFpbGFibGU7IGZhbGwgYmFjayB0byBHSUYgYnl0ZXMuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNoYXJwID0gKGF3YWl0IGltcG9ydChcInNoYXJwXCIpKS5kZWZhdWx0O1xuICAgICAgY29uc3QgZnJhbWVJbWdzID0gYXdhaXQgUHJvbWlzZS5hbGwoZnJhbWVzLm1hcChhc3luYyAoZikgPT4ge1xuICAgICAgICBjb25zdCByZ2JhID0gQnVmZmVyLmZyb20oZi5idWZmZXIsIGYuYnl0ZU9mZnNldCwgZi5ieXRlTGVuZ3RoKTtcbiAgICAgICAgcmV0dXJuIHNoYXJwKHJnYmEsIHsgcmF3OiB7IHdpZHRoOiBzaXplLCBoZWlnaHQ6IHNpemUsIGNoYW5uZWxzOiA0IH0gfSkud2VicCgpLnRvQnVmZmVyKCk7XG4gICAgICB9KSk7XG4gICAgICAvLyBzaGFycCBkb2Vzbid0IGpvaW4gYW5pbWF0ZWQgd2VicCBmcm9tIGZyYW1lcyBlYXNpbHkgd2l0aG91dCBqb2luIFx1MjAxNCB1c2UgZ2lmIGZhbGxiYWNrXG4gICAgICB2b2lkIGZyYW1lSW1ncztcbiAgICAgIHJldHVybiBlbmNvZGVHaWYoZnJhbWVzLCBzaXplLCBkZWxheU1zKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBlbmNvZGVHaWYoZnJhbWVzLCBzaXplLCBkZWxheU1zKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGVuY29kZUdpZihmcmFtZXMsIHNpemUsIGRlbGF5TXMpO1xufVxuXG5mdW5jdGlvbiB3aXRoVGltZW91dDxUPihwcm9taXNlOiBQcm9taXNlPFQ+LCBtczogbnVtYmVyKTogUHJvbWlzZTxUPiB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KFxuICAgICAgKCkgPT4gcmVqZWN0KG5ldyBFbW9qaUVycm9yKFwidGltZW91dFwiLCBcIk9mZmxpbmUgcmVuZGVyIHRpbWVkIG91dC5cIikpLFxuICAgICAgbXMsXG4gICAgKTtcbiAgICBwcm9taXNlLnRoZW4oXG4gICAgICB2ID0+IHsgY2xlYXJUaW1lb3V0KHRpbWVyKTsgcmVzb2x2ZSh2KTsgfSxcbiAgICAgIGUgPT4geyBjbGVhclRpbWVvdXQodGltZXIpOyByZWplY3QoZSk7IH0sXG4gICAgKTtcbiAgfSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiQUFXQSxTQUFTLGFBQWEsdUJBQXVCO0FBQzdDLFNBQVMsaUJBQWlCO0FBQzFCLFNBQVMsV0FBVyxpQkFBaUI7QUFDckMsU0FBUyxlQUFlO0FBQ3hCLFNBQVMsa0JBQWtCO0FBQzNCO0FBQUEsRUFDRTtBQUFBLEVBQVU7QUFBQSxFQUFlO0FBQUEsRUFBZ0I7QUFBQSxFQUFXO0FBQUEsT0FDL0M7QUFFUCxTQUFTLGdCQUFnQiwwQkFBMEI7QUFDbkQsU0FBUyxpQkFBaUIsaUJBQWlCLHdCQUF3QjtBQUNuRSxTQUFTLGtCQUFrQixvQkFBb0I7QUFDL0MsU0FBUyxxQkFBcUIsMkJBQTJCO0FBQ3pELFNBQVMsa0JBQWtCO0FBQzNCLFNBQVMsd0JBQXdCO0FBQ2pDLFNBQVMsYUFBYSxXQUFXLDBCQUEwQjtBQUMzRDtBQUFBLEVBQ0U7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsT0FDSztBQUVQLE1BQU0sb0JBQW9CO0FBRTFCLFNBQVMsVUFBVSxXQUFtQixVQUFtQixTQUEwQjtBQUNqRixRQUFNLE1BQU0sWUFBWSxXQUFXO0FBQ25D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
