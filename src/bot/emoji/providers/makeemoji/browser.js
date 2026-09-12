import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../../../../lib/logger.js";
import { EmojiError } from "../../utils/errors.js";
import { launchBrowser, newContext } from "./runtime.js";
import { resolveValue } from "./manifest.js";
import { recordNetwork } from "./discovery/recorder.js";
import { writeDebugTrace } from "./debug.js";
const GENERATE_TIMEOUT_MS = 6e4;
const STEP_TIMEOUT_MS = 15e3;
const RESULT_TIMEOUT_MS = 25e3;
function browserPathProblem(manifest) {
  if (!manifest) return "no manifest loaded";
  if (!manifest.browser.fileInputSelector) {
    return "manifest has no file-input selector \u2014 re-run discovery";
  }
  return null;
}
async function applyControl(page, key, spec, value) {
  switch (spec.kind) {
    case "select":
      await page.selectOption(spec.selector, value, { timeout: STEP_TIMEOUT_MS });
      return;
    case "listbox": {
      await page.click(spec.selector, { timeout: STEP_TIMEOUT_MS });
      const option = page.locator('[role="option"]').filter({ hasText: value }).first();
      if (await option.count()) {
        await option.click({ timeout: STEP_TIMEOUT_MS });
      } else {
        await page.getByRole("option", { name: new RegExp(escapeRegExp(value), "i") }).first().click({ timeout: STEP_TIMEOUT_MS });
      }
      await page.keyboard.press("Escape").catch(() => {
      });
      return;
    }
    case "radio":
      await page.click(`${spec.selector}[value="${value}"]`, { timeout: STEP_TIMEOUT_MS });
      return;
    case "button": {
      const attribute = spec.valueAttribute ?? "data-value";
      const locator = page.locator(`[${attribute}="${value}"]`).first();
      try {
        await locator.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS });
        await locator.click({ timeout: STEP_TIMEOUT_MS });
        return;
      } catch {
        const styleName = value.replace(/^gen_btn_/i, "").replace(/^:|:$/g, "");
        await page.locator("details").filter({ has: page.locator('input[placeholder*="Search" i]') }).locator("summary").click({ timeout: 3e3 }).catch(() => {
        });
        const search = page.locator(
          'input[placeholder*="Search" i], input[aria-label*="Search" i], input[type=search]'
        ).first();
        if (await search.count()) {
          await search.click({ timeout: STEP_TIMEOUT_MS });
          await search.fill("");
          await search.fill(styleName, { timeout: STEP_TIMEOUT_MS });
          await page.waitForTimeout(1200);
          const found = page.locator(`[${attribute}="${value}"]`).first();
          await found.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS }).catch(() => {
          });
          await found.click({ timeout: STEP_TIMEOUT_MS });
          return;
        }
        throw new Error(`button ${attribute}=${value} not found`);
      }
    }
    case "range":
    case "text":
      await page.fill(spec.selector, value, { timeout: STEP_TIMEOUT_MS });
      return;
    case "checkbox":
      await page.setChecked(spec.selector, value !== "false" && value !== "0", {
        timeout: STEP_TIMEOUT_MS
      });
      return;
    default:
      logger.warn({ key, kind: spec.kind }, "unhandled MakeEmoji control kind");
  }
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
async function applyOptions(page, manifest, options) {
  const applied = [];
  const wanted = [
    // Platform first: on most editors it is a preset that rewrites size and
    // format, so applying it later would silently undo explicit choices.
    ["platform", options.platform],
    ["animation", options.animation],
    ["speed", options.speed],
    ["direction", options.direction],
    ["size", options.size],
    ["color", options.color],
    ["format", options.format],
    ["quality", options.quality]
  ];
  for (const [key, raw] of wanted) {
    if (raw === void 0) continue;
    const spec = manifest.controls[key];
    if (!spec) continue;
    const resolved = resolveValue(manifest, key, raw) ?? (spec.kind === "text" || spec.kind === "range" ? raw : null);
    if (resolved === null) continue;
    try {
      await applyControl(page, key, spec, resolved);
      applied.push(`${key}=${resolved}`);
    } catch {
      logger.warn({ key, selector: spec.selector }, "MakeEmoji control could not be set");
    }
  }
  return applied;
}
async function readPreviewBytes(page, src) {
  const base64 = await page.evaluate(async (url) => {
    const w = globalThis;
    const response = await w.fetch(url);
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new w.FileReader();
      reader.onloadend = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error("preview blob unreadable"));
      reader.readAsDataURL(blob);
    });
  }, src);
  return Buffer.from(base64, "base64");
}
async function findPreviewSrc(page, resultSelector, animation) {
  return page.evaluate(({ selector, anim }) => {
    const w = globalThis;
    const nodes = Array.from(
      w.document.querySelectorAll(selector ?? "img, video, source")
    );
    const styleName = (anim ?? "").replace(/^gen_btn_/i, "").replace(/^:|:$/g, "").toLowerCase();
    const scored = [];
    for (const el of nodes) {
      const src = el.src || el.getAttribute("src") || "";
      if (!(src.startsWith("blob:") || src.startsWith("data:") || /\.(gif|webp|png)(\?|$)/i.test(src))) continue;
      const alt = (el.getAttribute("alt") || "").toLowerCase();
      let score = 0;
      if (/generated/.test(alt)) score += 2;
      if (src.startsWith("blob:")) score += 1;
      if (styleName && alt.includes(styleName)) score += 10;
      scored.push({ src, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored[scored.length - 1]?.src ?? null;
  }, { selector: resultSelector, anim: animation ?? null });
}
async function generateViaBrowser(manifest, options) {
  const problem = browserPathProblem(manifest);
  if (problem) {
    logger.error({ problem }, "MakeEmoji browser path is not configured");
    throw new EmojiError("provider_unavailable", "The emoji generator isn't set up yet.");
  }
  const started = Date.now();
  const deadline = started + GENERATE_TIMEOUT_MS;
  const remaining = () => Math.max(1e3, deadline - Date.now());
  const tempDir = mkdtempSync(join(tmpdir(), "makeemoji-"));
  const browser = await launchBrowser();
  let context;
  try {
    context = await newContext(browser);
    const page = await context.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    const recorder = options.debug ? recordNetwork(page) : null;
    await page.goto(manifest.siteUrl, { waitUntil: "domcontentloaded", timeout: remaining() });
    for (const selector of manifest.browser.dismissSelectors) {
      await page.click(selector, { timeout: 3e3 }).catch(() => {
      });
    }
    if (manifest.browser.readySelector) {
      await page.waitForSelector(manifest.browser.readySelector, {
        timeout: remaining(),
        state: "attached"
      }).catch(() => {
        throw new EmojiError("site_changed", "The emoji service looks different than expected.");
      });
    }
    const fileInput = manifest.browser.fileInputSelector;
    await page.setInputFiles(fileInput, {
      name: "source.png",
      mimeType: "image/png",
      buffer: options.image
    }).catch(() => {
      logger.error({ fileInput }, "MakeEmoji file input not found \u2014 manifest is stale");
      throw new EmojiError("site_changed", "The emoji service looks different than expected.");
    });
    await page.waitForTimeout(1500);
    const applied = await applyOptions(page, manifest, options);
    logger.debug({ applied }, "MakeEmoji options applied");
    if (manifest.browser.generateSelector) {
      await page.click(manifest.browser.generateSelector, { timeout: remaining() }).catch(() => {
        logger.warn({ selector: manifest.browser.generateSelector }, "MakeEmoji generate control not clickable");
      });
    }
    await page.waitForFunction(
      ({ anim, selector }) => {
        const w = globalThis;
        const styleName = (anim ?? "").replace(/^gen_btn_/i, "").replace(/^:|:$/g, "").toLowerCase();
        const nodes = Array.from(
          w.document.querySelectorAll(selector ?? 'img[alt*="generated" i], img, video')
        );
        return nodes.some((el) => {
          const alt = (el.getAttribute("alt") || "").toLowerCase();
          const src = el.src || el.getAttribute("src") || "";
          if (!(src.startsWith("blob:") || src.startsWith("data:"))) return false;
          if (!/generated/.test(alt)) return false;
          if (styleName && !alt.includes(styleName)) return false;
          return !/placeholder/i.test(alt);
        });
      },
      {
        anim: options.animation ?? null,
        selector: manifest.browser.resultSelector
      },
      { timeout: Math.min(RESULT_TIMEOUT_MS, remaining()) }
    ).catch(() => {
    });
    await page.waitForTimeout(750);
    let buffer = null;
    let sourceUrl;
    if (manifest.browser.downloadSelector) {
      const downloadPromise = page.waitForEvent("download", {
        timeout: Math.min(RESULT_TIMEOUT_MS, remaining())
      });
      await page.click(manifest.browser.downloadSelector, { timeout: remaining() }).catch(() => {
      });
      const download = await downloadPromise.catch(() => null);
      if (download) {
        const path = join(tempDir, "result.bin");
        await download.saveAs(path);
        const { readFileSync } = await import("node:fs");
        buffer = readFileSync(path);
        sourceUrl = safeOrigin(download.url());
      }
    }
    if (!buffer) {
      const until = Math.min(Date.now() + RESULT_TIMEOUT_MS, deadline);
      const wantGif = !options.format || options.format === "gif";
      const wantWebp = options.format === "webp";
      while (Date.now() < until) {
        const src = await findPreviewSrc(
          page,
          manifest.browser.resultSelector,
          options.animation
        );
        if (src) {
          const candidate = await readPreviewBytes(page, src).catch(() => null);
          if (candidate?.length) {
            const isGif = candidate.subarray(0, 3).toString("ascii") === "GIF";
            const isPng = candidate[0] === 137 && candidate[1] === 80;
            const isWebp = candidate.subarray(0, 4).toString("ascii") === "RIFF";
            if (wantGif && isPng && !isGif) {
              await page.waitForTimeout(750);
              continue;
            }
            if (wantWebp && !isWebp) {
              await page.waitForTimeout(750);
              continue;
            }
            buffer = candidate;
            sourceUrl = src.startsWith("data:") || src.startsWith("blob:") ? void 0 : src;
            break;
          }
        }
        await page.waitForTimeout(750);
      }
    }
    if (recorder) {
      recorder.stop();
      writeDebugTrace("generate", recorder.exchanges, recorder.websockets);
    }
    if (!buffer?.length) {
      logger.warn({ site: manifest.siteUrl }, "MakeEmoji produced no result");
      throw new EmojiError("generation_failed", "The emoji service didn't produce a file. Please try again.");
    }
    return {
      buffer,
      format: options.format,
      bytes: buffer.length,
      providerId: "makeemoji-browser",
      durationMs: Date.now() - started,
      ...sourceUrl ? { sourceUrl } : {},
      cached: false
    };
  } catch (err) {
    if (err instanceof EmojiError) throw err;
    const message = err.message ?? "";
    if (/Timeout|timeout/.test(message)) {
      throw new EmojiError("timeout", "The emoji service took too long. Please try again.");
    }
    logger.error({ err: message.split("\n")[0] }, "MakeEmoji browser generation failed");
    throw new EmojiError("browser_failed", "The emoji generator hit a problem. Please try again.");
  } finally {
    await context?.close().catch(() => {
    });
    await browser.close().catch(() => {
    });
    rmSync(tempDir, { recursive: true, force: true });
  }
}
function safeOrigin(raw) {
  if (raw.startsWith("blob:") || raw.startsWith("data:")) return void 0;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return void 0;
  }
}
export {
  browserPathProblem,
  generateViaBrowser
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiYnJvd3Nlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vLyBCcm93c2VyIHBhdGguXG4vL1xuLy8gRHJpdmVzIE1ha2VFbW9qaSdzIG93biBlZGl0b3IgaW4gaGVhZGxlc3MgQ2hyb21pdW06IHVwbG9hZCB0aGUgaW1hZ2UsIHNldCB0aGVcbi8vIGNvbnRyb2xzLCB0cmlnZ2VyIGdlbmVyYXRpb24sIHRha2UgdGhlIGZpbmlzaGVkIGZpbGUuIFNsb3dlciB0aGFuIGEgZGlyZWN0XG4vLyByZXF1ZXN0LCBidXQgaXQgaXMgdGhlIHBhdGggdGhhdCB3b3JrcyB3aGVuIGdlbmVyYXRpb24gaGFwcGVucyBpbnNpZGUgdGhlIHBhZ2Vcbi8vIFx1MjAxNCB3aGljaCwgZm9yIGFuIGVtb2ppIGVkaXRvciwgaXMgdGhlIGxpa2VseSBjYXNlLlxuLy9cbi8vIEV2ZXJ5IHNlbGVjdG9yIGFuZCBvcHRpb24gdmFsdWUgY29tZXMgZnJvbSB0aGUgZGlzY292ZXJ5IG1hbmlmZXN0LiBOb3RoaW5nXG4vLyBoZXJlIGtub3dzIHdoYXQgTWFrZUVtb2ppJ3MgRE9NIGxvb2tzIGxpa2UsIHNvIGEgcmVkZXNpZ24gb2YgdGhlIHNpdGUgaXMgZml4ZWRcbi8vIGJ5IHJlLXJ1bm5pbmcgZGlzY292ZXJ5IHJhdGhlciB0aGFuIGJ5IGVkaXRpbmcgdGhpcyBmaWxlLlxuLy9cbi8vIFJlbGlhYmlsaXR5IHJ1bGVzIHRoaXMgZmlsZSBmb2xsb3dzLCBiZWNhdXNlIGl0IHJ1bnMgb24gYSBEaXNjb3JkIGJvdDpcbi8vICAgXHUyMDIyIG9uZSBicm93c2VyIHBlciBnZW5lcmF0aW9uLCBhbHdheXMgY2xvc2VkIGluIGBmaW5hbGx5YCBcdTIwMTQgYSBsZWFrZWQgQ2hyb21pdW1cbi8vICAgICBpcyB+MTAwIE1CIHRoYXQgbmV2ZXIgY29tZXMgYmFja1xuLy8gICBcdTIwMjIgZXZlcnkgd2FpdCBpcyBib3VuZGVkOyBub3RoaW5nIGJsb2NrcyBmb3JldmVyIG9uIGEgc2VsZWN0b3IgdGhhdCBjaGFuZ2VkXG4vLyAgIFx1MjAyMiBhIG1pc3Npbmcgc2VsZWN0b3IgaXMgYHNpdGVfY2hhbmdlZGAsIG5vdCBhIGNyYXNoLCBzbyB0aGUgdXNlciBnZXRzIGFcbi8vICAgICBjbGVhbiBtZXNzYWdlIGFuZCBhbiBvcGVyYXRvciBnZXRzIGEgbG9nIGxpbmUgbmFtaW5nIHRoZSBzZWxlY3RvclxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbmltcG9ydCB7IG1rZHRlbXBTeW5jLCBybVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IEJyb3dzZXJDb250ZXh0LCBEb3dubG9hZCwgUGFnZSB9IGZyb20gXCJwbGF5d3JpZ2h0XCI7XG5pbXBvcnQgeyBsb2dnZXIgfSBmcm9tIFwiLi4vLi4vLi4vLi4vbGliL2xvZ2dlci5qc1wiO1xuaW1wb3J0IHsgRW1vamlFcnJvciB9IGZyb20gXCIuLi8uLi91dGlscy9lcnJvcnMuanNcIjtcbmltcG9ydCB0eXBlIHsgR2VuZXJhdGVPcHRpb25zLCBHZW5lcmF0ZVJlc3VsdCB9IGZyb20gXCIuLi8uLi90eXBlcy5qc1wiO1xuaW1wb3J0IHsgbGF1bmNoQnJvd3NlciwgbmV3Q29udGV4dCB9IGZyb20gXCIuL3J1bnRpbWUuanNcIjtcbmltcG9ydCB7IHJlc29sdmVWYWx1ZSB9IGZyb20gXCIuL21hbmlmZXN0LmpzXCI7XG5pbXBvcnQgdHlwZSB7IENvbnRyb2xTcGVjLCBNYW5pZmVzdCwgT3B0aW9uS2V5IH0gZnJvbSBcIi4vdHlwZXMuanNcIjtcbmltcG9ydCB7IHJlY29yZE5ldHdvcmsgfSBmcm9tIFwiLi9kaXNjb3ZlcnkvcmVjb3JkZXIuanNcIjtcbmltcG9ydCB7IHdyaXRlRGVidWdUcmFjZSB9IGZyb20gXCIuL2RlYnVnLmpzXCI7XG5pbXBvcnQgdHlwZSB7IEJyb3dzZXJXaW5kb3csIERvbUVsZW1lbnQsIERvbU1lZGlhIH0gZnJvbSBcIi4vZGlzY292ZXJ5L2RvbS10eXBlcy5qc1wiO1xuXG4vKiogQnVkZ2V0IGZvciBvbmUgd2hvbGUgZ2VuZXJhdGlvbiwgYnJvd3NlciBsYXVuY2ggaW5jbHVkZWQuICovXG5jb25zdCBHRU5FUkFURV9USU1FT1VUX01TID0gNjBfMDAwO1xuLyoqIEJ1ZGdldCBmb3IgYW55IHNpbmdsZSBwYWdlIGludGVyYWN0aW9uLiAqL1xuY29uc3QgU1RFUF9USU1FT1VUX01TID0gMTVfMDAwO1xuLyoqIEhvdyBsb25nIHRvIHdhaXQgZm9yIHRoZSBlZGl0b3IgdG8gcHJvZHVjZSBhIHJlc3VsdCBhZnRlciB0aGUgdHJpZ2dlci4gKi9cbmNvbnN0IFJFU1VMVF9USU1FT1VUX01TID0gMjVfMDAwO1xuXG4vKiogV2h5IHRoZSBicm93c2VyIHBhdGggY2FuJ3QgcnVuIGFnYWluc3QgdGhpcyBtYW5pZmVzdCwgb3IgbnVsbCB3aGVuIGl0IGNhbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBicm93c2VyUGF0aFByb2JsZW0obWFuaWZlc3Q6IE1hbmlmZXN0IHwgbnVsbCk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIW1hbmlmZXN0KSByZXR1cm4gXCJubyBtYW5pZmVzdCBsb2FkZWRcIjtcbiAgaWYgKCFtYW5pZmVzdC5icm93c2VyLmZpbGVJbnB1dFNlbGVjdG9yKSB7XG4gICAgcmV0dXJuIFwibWFuaWZlc3QgaGFzIG5vIGZpbGUtaW5wdXQgc2VsZWN0b3IgXHUyMDE0IHJlLXJ1biBkaXNjb3ZlcnlcIjtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIEFwcGx5IG9uZSBvcHRpb24gdG8gaXRzIGNvbnRyb2wsIHVzaW5nIHdoYXRldmVyIGtpbmQgb2YgY29udHJvbCBpdCBpcy4gKi9cbmFzeW5jIGZ1bmN0aW9uIGFwcGx5Q29udHJvbChcbiAgcGFnZTogUGFnZSwga2V5OiBPcHRpb25LZXksIHNwZWM6IENvbnRyb2xTcGVjLCB2YWx1ZTogc3RyaW5nLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIHN3aXRjaCAoc3BlYy5raW5kKSB7XG4gICAgY2FzZSBcInNlbGVjdFwiOlxuICAgICAgYXdhaXQgcGFnZS5zZWxlY3RPcHRpb24oc3BlYy5zZWxlY3RvciwgdmFsdWUsIHsgdGltZW91dDogU1RFUF9USU1FT1VUX01TIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIGNhc2UgXCJsaXN0Ym94XCI6IHtcbiAgICAgIC8vIEN1c3RvbSBsaXN0Ym94ZXMgKE1ha2VFbW9qaSk6IG9wZW4gdGhlIHRyaWdnZXIsIHRoZW4gY2xpY2sgdGhlIG9wdGlvblxuICAgICAgLy8gd2hvc2UgdmlzaWJsZSB0ZXh0IG1hdGNoZXMgdGhlIGRpc2NvdmVyZWQgdmFsdWUgKG9yIGl0cyBjb21wYWN0IGxhYmVsKS5cbiAgICAgIGF3YWl0IHBhZ2UuY2xpY2soc3BlYy5zZWxlY3RvciwgeyB0aW1lb3V0OiBTVEVQX1RJTUVPVVRfTVMgfSk7XG4gICAgICBjb25zdCBvcHRpb24gPSBwYWdlLmxvY2F0b3IoJ1tyb2xlPVwib3B0aW9uXCJdJykuZmlsdGVyKHsgaGFzVGV4dDogdmFsdWUgfSkuZmlyc3QoKTtcbiAgICAgIC8vIEZhbGwgYmFjayB0byBhIGxvb3NlciBjb250YWlucyBtYXRjaCB3aGVuIHRoZSB2YWx1ZSBpcyBhIGNvbXBhY3QgbGFiZWxcbiAgICAgIC8vIGxpa2UgXCJHSUZcIiBhZ2FpbnN0IG9wdGlvbiB0ZXh0IFwiXHVEODNEXHVEQ0MxIEdJRlwiLlxuICAgICAgaWYgKGF3YWl0IG9wdGlvbi5jb3VudCgpKSB7XG4gICAgICAgIGF3YWl0IG9wdGlvbi5jbGljayh7IHRpbWVvdXQ6IFNURVBfVElNRU9VVF9NUyB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGF3YWl0IHBhZ2UuZ2V0QnlSb2xlKFwib3B0aW9uXCIsIHsgbmFtZTogbmV3IFJlZ0V4cChlc2NhcGVSZWdFeHAodmFsdWUpLCBcImlcIikgfSlcbiAgICAgICAgICAuZmlyc3QoKVxuICAgICAgICAgIC5jbGljayh7IHRpbWVvdXQ6IFNURVBfVElNRU9VVF9NUyB9KTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHBhZ2Uua2V5Ym9hcmQucHJlc3MoXCJFc2NhcGVcIikuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjYXNlIFwicmFkaW9cIjpcbiAgICAgIGF3YWl0IHBhZ2UuY2xpY2soYCR7c3BlYy5zZWxlY3Rvcn1bdmFsdWU9XCIke3ZhbHVlfVwiXWAsIHsgdGltZW91dDogU1RFUF9USU1FT1VUX01TIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIGNhc2UgXCJidXR0b25cIjoge1xuICAgICAgY29uc3QgYXR0cmlidXRlID0gc3BlYy52YWx1ZUF0dHJpYnV0ZSA/PyBcImRhdGEtdmFsdWVcIjtcbiAgICAgIGNvbnN0IGxvY2F0b3IgPSBwYWdlLmxvY2F0b3IoYFske2F0dHJpYnV0ZX09XCIke3ZhbHVlfVwiXWApLmZpcnN0KCk7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBsb2NhdG9yLnNjcm9sbEludG9WaWV3SWZOZWVkZWQoeyB0aW1lb3V0OiBTVEVQX1RJTUVPVVRfTVMgfSk7XG4gICAgICAgIGF3YWl0IGxvY2F0b3IuY2xpY2soeyB0aW1lb3V0OiBTVEVQX1RJTUVPVVRfTVMgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvLyBTdHlsZSBncmlkcyB2aXJ0dWFsaXNlLiBPcGVuIHRoZSBzdHlsZXMgZmlsdGVyL3NlYXJjaCBVSSBpZiBuZWVkZWQsXG4gICAgICAgIC8vIHR5cGUgdGhlIHN0eWxlIG5hbWUsIHRoZW4gY2xpY2sgdGhlIHRpbGUgb25jZSBpdCBtb3VudHMuXG4gICAgICAgIGNvbnN0IHN0eWxlTmFtZSA9IHZhbHVlLnJlcGxhY2UoL15nZW5fYnRuXy9pLCBcIlwiKS5yZXBsYWNlKC9eOnw6JC9nLCBcIlwiKTtcbiAgICAgICAgYXdhaXQgcGFnZS5sb2NhdG9yKFwiZGV0YWlsc1wiKS5maWx0ZXIoeyBoYXM6IHBhZ2UubG9jYXRvcignaW5wdXRbcGxhY2Vob2xkZXIqPVwiU2VhcmNoXCIgaV0nKSB9KVxuICAgICAgICAgIC5sb2NhdG9yKFwic3VtbWFyeVwiKS5jbGljayh7IHRpbWVvdXQ6IDNfMDAwIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgY29uc3Qgc2VhcmNoID0gcGFnZS5sb2NhdG9yKFxuICAgICAgICAgICdpbnB1dFtwbGFjZWhvbGRlcio9XCJTZWFyY2hcIiBpXSwgaW5wdXRbYXJpYS1sYWJlbCo9XCJTZWFyY2hcIiBpXSwgaW5wdXRbdHlwZT1zZWFyY2hdJyxcbiAgICAgICAgKS5maXJzdCgpO1xuICAgICAgICBpZiAoYXdhaXQgc2VhcmNoLmNvdW50KCkpIHtcbiAgICAgICAgICBhd2FpdCBzZWFyY2guY2xpY2soeyB0aW1lb3V0OiBTVEVQX1RJTUVPVVRfTVMgfSk7XG4gICAgICAgICAgYXdhaXQgc2VhcmNoLmZpbGwoXCJcIik7XG4gICAgICAgICAgYXdhaXQgc2VhcmNoLmZpbGwoc3R5bGVOYW1lLCB7IHRpbWVvdXQ6IFNURVBfVElNRU9VVF9NUyB9KTtcbiAgICAgICAgICBhd2FpdCBwYWdlLndhaXRGb3JUaW1lb3V0KDEyMDApO1xuICAgICAgICAgIGNvbnN0IGZvdW5kID0gcGFnZS5sb2NhdG9yKGBbJHthdHRyaWJ1dGV9PVwiJHt2YWx1ZX1cIl1gKS5maXJzdCgpO1xuICAgICAgICAgIGF3YWl0IGZvdW5kLnNjcm9sbEludG9WaWV3SWZOZWVkZWQoeyB0aW1lb3V0OiBTVEVQX1RJTUVPVVRfTVMgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIGF3YWl0IGZvdW5kLmNsaWNrKHsgdGltZW91dDogU1RFUF9USU1FT1VUX01TIH0pO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGJ1dHRvbiAke2F0dHJpYnV0ZX09JHt2YWx1ZX0gbm90IGZvdW5kYCk7XG4gICAgICB9XG4gICAgfVxuICAgIGNhc2UgXCJyYW5nZVwiOlxuICAgIGNhc2UgXCJ0ZXh0XCI6XG4gICAgICBhd2FpdCBwYWdlLmZpbGwoc3BlYy5zZWxlY3RvciwgdmFsdWUsIHsgdGltZW91dDogU1RFUF9USU1FT1VUX01TIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIGNhc2UgXCJjaGVja2JveFwiOlxuICAgICAgYXdhaXQgcGFnZS5zZXRDaGVja2VkKHNwZWMuc2VsZWN0b3IsIHZhbHVlICE9PSBcImZhbHNlXCIgJiYgdmFsdWUgIT09IFwiMFwiLCB7XG4gICAgICAgIHRpbWVvdXQ6IFNURVBfVElNRU9VVF9NUyxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIGRlZmF1bHQ6XG4gICAgICBsb2dnZXIud2Fybih7IGtleSwga2luZDogc3BlYy5raW5kIH0sIFwidW5oYW5kbGVkIE1ha2VFbW9qaSBjb250cm9sIGtpbmRcIik7XG4gIH1cbn1cblxuZnVuY3Rpb24gZXNjYXBlUmVnRXhwKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWUucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpO1xufVxuXG4vKiogU2V0IGV2ZXJ5IG9wdGlvbiB0aGUgbWFuaWZlc3Qga25vd3MgaG93IHRvIGRyaXZlLiAqL1xuYXN5bmMgZnVuY3Rpb24gYXBwbHlPcHRpb25zKFxuICBwYWdlOiBQYWdlLCBtYW5pZmVzdDogTWFuaWZlc3QsIG9wdGlvbnM6IEdlbmVyYXRlT3B0aW9ucyxcbik6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgY29uc3QgYXBwbGllZDogc3RyaW5nW10gPSBbXTtcblxuICBjb25zdCB3YW50ZWQ6IFtPcHRpb25LZXksIHN0cmluZyB8IHVuZGVmaW5lZF1bXSA9IFtcbiAgICAvLyBQbGF0Zm9ybSBmaXJzdDogb24gbW9zdCBlZGl0b3JzIGl0IGlzIGEgcHJlc2V0IHRoYXQgcmV3cml0ZXMgc2l6ZSBhbmRcbiAgICAvLyBmb3JtYXQsIHNvIGFwcGx5aW5nIGl0IGxhdGVyIHdvdWxkIHNpbGVudGx5IHVuZG8gZXhwbGljaXQgY2hvaWNlcy5cbiAgICBbXCJwbGF0Zm9ybVwiLCBvcHRpb25zLnBsYXRmb3JtXSxcbiAgICBbXCJhbmltYXRpb25cIiwgb3B0aW9ucy5hbmltYXRpb25dLFxuICAgIFtcInNwZWVkXCIsIG9wdGlvbnMuc3BlZWRdLFxuICAgIFtcImRpcmVjdGlvblwiLCBvcHRpb25zLmRpcmVjdGlvbl0sXG4gICAgW1wic2l6ZVwiLCBvcHRpb25zLnNpemVdLFxuICAgIFtcImNvbG9yXCIsIG9wdGlvbnMuY29sb3JdLFxuICAgIFtcImZvcm1hdFwiLCBvcHRpb25zLmZvcm1hdF0sXG4gICAgW1wicXVhbGl0eVwiLCBvcHRpb25zLnF1YWxpdHldLFxuICBdO1xuXG4gIGZvciAoY29uc3QgW2tleSwgcmF3XSBvZiB3YW50ZWQpIHtcbiAgICBpZiAocmF3ID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHNwZWMgPSBtYW5pZmVzdC5jb250cm9sc1trZXldO1xuICAgIGlmICghc3BlYykgY29udGludWU7XG5cbiAgICAvLyBGcmVlLXRleHQgY29udHJvbHMgKGEgY29sb3VyIGhleCwgYSBudW1lcmljIHNpemUpIGFjY2VwdCBhIHZhbHVlIHRoYXQgd2FzXG4gICAgLy8gbmV2ZXIgaW4gYW4gZW51bWVyYXRlZCBsaXN0LCBzbyBmYWxsIGJhY2sgdG8gdGhlIHJhdyB2YWx1ZSBmb3IgdGhvc2UuXG4gICAgY29uc3QgcmVzb2x2ZWQgPSByZXNvbHZlVmFsdWUobWFuaWZlc3QsIGtleSwgcmF3KVxuICAgICAgPz8gKHNwZWMua2luZCA9PT0gXCJ0ZXh0XCIgfHwgc3BlYy5raW5kID09PSBcInJhbmdlXCIgPyByYXcgOiBudWxsKTtcbiAgICBpZiAocmVzb2x2ZWQgPT09IG51bGwpIGNvbnRpbnVlO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGFwcGx5Q29udHJvbChwYWdlLCBrZXksIHNwZWMsIHJlc29sdmVkKTtcbiAgICAgIGFwcGxpZWQucHVzaChgJHtrZXl9PSR7cmVzb2x2ZWR9YCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBPbmUgY29udHJvbCB0aGF0IGhhcyBtb3ZlZCBzaG91bGRuJ3Qgc2luayB0aGUgd2hvbGUgZ2VuZXJhdGlvbiBcdTIwMTQgdGhlXG4gICAgICAvLyByZXN0IG9mIHRoZSBzZXR0aW5ncyBzdGlsbCBhcHBseSBhbmQgdGhlIHNpdGUncyBkZWZhdWx0IGNvdmVycyB0aGlzIG9uZS5cbiAgICAgIGxvZ2dlci53YXJuKHsga2V5LCBzZWxlY3Rvcjogc3BlYy5zZWxlY3RvciB9LCBcIk1ha2VFbW9qaSBjb250cm9sIGNvdWxkIG5vdCBiZSBzZXRcIik7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGFwcGxpZWQ7XG59XG5cbi8qKiBSZWFkIHRoZSBjdXJyZW50IHByZXZpZXcncyBieXRlcyBmcm9tIGluc2lkZSB0aGUgcGFnZS4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlYWRQcmV2aWV3Qnl0ZXMocGFnZTogUGFnZSwgc3JjOiBzdHJpbmcpOiBQcm9taXNlPEJ1ZmZlcj4ge1xuICBjb25zdCBiYXNlNjQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKGFzeW5jICh1cmw6IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHcgPSBnbG9iYWxUaGlzIGFzIHVua25vd24gYXMgQnJvd3NlcldpbmRvdztcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHcuZmV0Y2godXJsKTtcbiAgICBjb25zdCBibG9iID0gYXdhaXQgcmVzcG9uc2UuYmxvYigpO1xuICAgIHJldHVybiBhd2FpdCBuZXcgUHJvbWlzZTxzdHJpbmc+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHJlYWRlciA9IG5ldyB3LkZpbGVSZWFkZXIoKTtcbiAgICAgIHJlYWRlci5vbmxvYWRlbmQgPSAoKSA9PiByZXNvbHZlKFN0cmluZyhyZWFkZXIucmVzdWx0KS5zcGxpdChcIixcIilbMV0gPz8gXCJcIik7XG4gICAgICByZWFkZXIub25lcnJvciA9ICgpID0+IHJlamVjdChuZXcgRXJyb3IoXCJwcmV2aWV3IGJsb2IgdW5yZWFkYWJsZVwiKSk7XG4gICAgICByZWFkZXIucmVhZEFzRGF0YVVSTChibG9iKTtcbiAgICB9KTtcbiAgfSwgc3JjKTtcbiAgcmV0dXJuIEJ1ZmZlci5mcm9tKGJhc2U2NCwgXCJiYXNlNjRcIik7XG59XG5cbi8qKiBUaGUgbmV3ZXN0IGdlbmVyYXRlZC1sb29raW5nIG1lZGlhIHNvdXJjZSBpbiB0aGUgcGFnZSwgaWYgYW55LiAqL1xuYXN5bmMgZnVuY3Rpb24gZmluZFByZXZpZXdTcmMoXG4gIHBhZ2U6IFBhZ2UsXG4gIHJlc3VsdFNlbGVjdG9yOiBzdHJpbmcgfCBudWxsLFxuICBhbmltYXRpb24/OiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgcmV0dXJuIHBhZ2UuZXZhbHVhdGUoKHsgc2VsZWN0b3IsIGFuaW0gfSkgPT4ge1xuICAgIGNvbnN0IHcgPSBnbG9iYWxUaGlzIGFzIHVua25vd24gYXMgQnJvd3NlcldpbmRvdztcbiAgICBjb25zdCBub2RlcyA9IEFycmF5LmZyb20oXG4gICAgICB3LmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoc2VsZWN0b3IgPz8gXCJpbWcsIHZpZGVvLCBzb3VyY2VcIikgYXMgQXJyYXlMaWtlPERvbUVsZW1lbnQ+LFxuICAgICk7XG4gICAgY29uc3Qgc3R5bGVOYW1lID0gKGFuaW0gPz8gXCJcIilcbiAgICAgIC5yZXBsYWNlKC9eZ2VuX2J0bl8vaSwgXCJcIilcbiAgICAgIC5yZXBsYWNlKC9eOnw6JC9nLCBcIlwiKVxuICAgICAgLnRvTG93ZXJDYXNlKCk7XG5cbiAgICB0eXBlIFNjb3JlZCA9IHsgc3JjOiBzdHJpbmc7IHNjb3JlOiBudW1iZXIgfTtcbiAgICBjb25zdCBzY29yZWQ6IFNjb3JlZFtdID0gW107XG4gICAgZm9yIChjb25zdCBlbCBvZiBub2Rlcykge1xuICAgICAgY29uc3Qgc3JjID0gKGVsIGFzIERvbU1lZGlhKS5zcmMgfHwgZWwuZ2V0QXR0cmlidXRlKFwic3JjXCIpIHx8IFwiXCI7XG4gICAgICBpZiAoIShcbiAgICAgICAgc3JjLnN0YXJ0c1dpdGgoXCJibG9iOlwiKSB8fCBzcmMuc3RhcnRzV2l0aChcImRhdGE6XCIpIHx8XG4gICAgICAgIC9cXC4oZ2lmfHdlYnB8cG5nKShcXD98JCkvaS50ZXN0KHNyYylcbiAgICAgICkpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgYWx0ID0gKGVsLmdldEF0dHJpYnV0ZShcImFsdFwiKSB8fCBcIlwiKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgbGV0IHNjb3JlID0gMDtcbiAgICAgIGlmICgvZ2VuZXJhdGVkLy50ZXN0KGFsdCkpIHNjb3JlICs9IDI7XG4gICAgICBpZiAoc3JjLnN0YXJ0c1dpdGgoXCJibG9iOlwiKSkgc2NvcmUgKz0gMTtcbiAgICAgIC8vIFByZWZlciB0aGUgdGlsZSB0aGF0IG1hdGNoZXMgdGhlIGFuaW1hdGlvbiB0aGUgdXNlciBhc2tlZCBmb3JcbiAgICAgIC8vIChcIlRoZSBnZW5lcmF0ZWQgcGFydHktcGFycm90IGFuaW1hdGVkIGVtb2ppXCIpLlxuICAgICAgaWYgKHN0eWxlTmFtZSAmJiBhbHQuaW5jbHVkZXMoc3R5bGVOYW1lKSkgc2NvcmUgKz0gMTA7XG4gICAgICBzY29yZWQucHVzaCh7IHNyYywgc2NvcmUgfSk7XG4gICAgfVxuICAgIHNjb3JlZC5zb3J0KChhLCBiKSA9PiBhLnNjb3JlIC0gYi5zY29yZSk7XG4gICAgcmV0dXJuIHNjb3JlZFtzY29yZWQubGVuZ3RoIC0gMV0/LnNyYyA/PyBudWxsO1xuICB9LCB7IHNlbGVjdG9yOiByZXN1bHRTZWxlY3RvciwgYW5pbTogYW5pbWF0aW9uID8/IG51bGwgfSk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZW5lcmF0ZVZpYUJyb3dzZXIoXG4gIG1hbmlmZXN0OiBNYW5pZmVzdCwgb3B0aW9uczogR2VuZXJhdGVPcHRpb25zLFxuKTogUHJvbWlzZTxHZW5lcmF0ZVJlc3VsdD4ge1xuICBjb25zdCBwcm9ibGVtID0gYnJvd3NlclBhdGhQcm9ibGVtKG1hbmlmZXN0KTtcbiAgaWYgKHByb2JsZW0pIHtcbiAgICBsb2dnZXIuZXJyb3IoeyBwcm9ibGVtIH0sIFwiTWFrZUVtb2ppIGJyb3dzZXIgcGF0aCBpcyBub3QgY29uZmlndXJlZFwiKTtcbiAgICB0aHJvdyBuZXcgRW1vamlFcnJvcihcInByb3ZpZGVyX3VuYXZhaWxhYmxlXCIsIFwiVGhlIGVtb2ppIGdlbmVyYXRvciBpc24ndCBzZXQgdXAgeWV0LlwiKTtcbiAgfVxuXG4gIGNvbnN0IHN0YXJ0ZWQgPSBEYXRlLm5vdygpO1xuICBjb25zdCBkZWFkbGluZSA9IHN0YXJ0ZWQgKyBHRU5FUkFURV9USU1FT1VUX01TO1xuICBjb25zdCByZW1haW5pbmcgPSAoKSA9PiBNYXRoLm1heCgxMDAwLCBkZWFkbGluZSAtIERhdGUubm93KCkpO1xuXG4gIGNvbnN0IHRlbXBEaXIgPSBta2R0ZW1wU3luYyhqb2luKHRtcGRpcigpLCBcIm1ha2VlbW9qaS1cIikpO1xuICBjb25zdCBicm93c2VyID0gYXdhaXQgbGF1bmNoQnJvd3NlcigpO1xuICBsZXQgY29udGV4dDogQnJvd3NlckNvbnRleHQgfCB1bmRlZmluZWQ7XG5cbiAgdHJ5IHtcbiAgICBjb250ZXh0ID0gYXdhaXQgbmV3Q29udGV4dChicm93c2VyKTtcbiAgICBjb25zdCBwYWdlID0gYXdhaXQgY29udGV4dC5uZXdQYWdlKCk7XG4gICAgcGFnZS5zZXREZWZhdWx0VGltZW91dChTVEVQX1RJTUVPVVRfTVMpO1xuXG4gICAgLy8gT25seSByZWNvcmRlZCB3aGVuIGV4cGxpY2l0bHkgYXNrZWQgZm9yOiB0aGUgdHJhY2UgaXMgbGFyZ2UsIGFuZCBldmVuXG4gICAgLy8gcmVkYWN0ZWQgaXQgZGVzY3JpYmVzIGV4YWN0bHkgd2hhdCB0aGUgYm90IHNlbnQuXG4gICAgY29uc3QgcmVjb3JkZXIgPSBvcHRpb25zLmRlYnVnID8gcmVjb3JkTmV0d29yayhwYWdlKSA6IG51bGw7XG5cbiAgICBhd2FpdCBwYWdlLmdvdG8obWFuaWZlc3Quc2l0ZVVybCwgeyB3YWl0VW50aWw6IFwiZG9tY29udGVudGxvYWRlZFwiLCB0aW1lb3V0OiByZW1haW5pbmcoKSB9KTtcblxuICAgIC8vIENvb2tpZSBiYW5uZXJzIGFuZCBpbnRlcnN0aXRpYWxzIGludGVyY2VwdCB0aGUgdmVyeSBjbGlja3Mgd2UgbmVlZC5cbiAgICBmb3IgKGNvbnN0IHNlbGVjdG9yIG9mIG1hbmlmZXN0LmJyb3dzZXIuZGlzbWlzc1NlbGVjdG9ycykge1xuICAgICAgYXdhaXQgcGFnZS5jbGljayhzZWxlY3RvciwgeyB0aW1lb3V0OiAzMDAwIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICB9XG5cbiAgICBpZiAobWFuaWZlc3QuYnJvd3Nlci5yZWFkeVNlbGVjdG9yKSB7XG4gICAgICAvLyBGaWxlIGlucHV0cyBhcmUgcm91dGluZWx5IHZpc3VhbGx5IGhpZGRlbiAoTWFrZUVtb2ppIHVzZXMgYGNsYXNzPVwiaGlkZGVuXCJgKSxcbiAgICAgIC8vIHNvIHdhaXQgZm9yIGF0dGFjaG1lbnQgcmF0aGVyIHRoYW4gdmlzaWJpbGl0eS5cbiAgICAgIGF3YWl0IHBhZ2Uud2FpdEZvclNlbGVjdG9yKG1hbmlmZXN0LmJyb3dzZXIucmVhZHlTZWxlY3Rvciwge1xuICAgICAgICB0aW1lb3V0OiByZW1haW5pbmcoKSxcbiAgICAgICAgc3RhdGU6IFwiYXR0YWNoZWRcIixcbiAgICAgIH0pLmNhdGNoKCgpID0+IHsgdGhyb3cgbmV3IEVtb2ppRXJyb3IoXCJzaXRlX2NoYW5nZWRcIiwgXCJUaGUgZW1vamkgc2VydmljZSBsb29rcyBkaWZmZXJlbnQgdGhhbiBleHBlY3RlZC5cIik7IH0pO1xuICAgIH1cblxuICAgIGNvbnN0IGZpbGVJbnB1dCA9IG1hbmlmZXN0LmJyb3dzZXIuZmlsZUlucHV0U2VsZWN0b3IhO1xuICAgIGF3YWl0IHBhZ2Uuc2V0SW5wdXRGaWxlcyhmaWxlSW5wdXQsIHtcbiAgICAgIG5hbWU6IFwic291cmNlLnBuZ1wiLCBtaW1lVHlwZTogXCJpbWFnZS9wbmdcIiwgYnVmZmVyOiBvcHRpb25zLmltYWdlLFxuICAgIH0pLmNhdGNoKCgpID0+IHtcbiAgICAgIGxvZ2dlci5lcnJvcih7IGZpbGVJbnB1dCB9LCBcIk1ha2VFbW9qaSBmaWxlIGlucHV0IG5vdCBmb3VuZCBcdTIwMTQgbWFuaWZlc3QgaXMgc3RhbGVcIik7XG4gICAgICB0aHJvdyBuZXcgRW1vamlFcnJvcihcInNpdGVfY2hhbmdlZFwiLCBcIlRoZSBlbW9qaSBzZXJ2aWNlIGxvb2tzIGRpZmZlcmVudCB0aGFuIGV4cGVjdGVkLlwiKTtcbiAgICB9KTtcblxuICAgIC8vIExpdmUgZWRpdG9ycyBlbmNvZGUgYXN5bmNocm9ub3VzbHkgYWZ0ZXIgdXBsb2FkOyBnaXZlIHRoZW0gYSBtb21lbnRcbiAgICAvLyBiZWZvcmUgYXBwbHlpbmcgb3B0aW9ucyBzbyBsaXN0Ym94ZXMgYW5kIHN0eWxlIHRpbGVzIGFyZSBpbnRlcmFjdGl2ZS5cbiAgICBhd2FpdCBwYWdlLndhaXRGb3JUaW1lb3V0KDE1MDApO1xuXG4gICAgY29uc3QgYXBwbGllZCA9IGF3YWl0IGFwcGx5T3B0aW9ucyhwYWdlLCBtYW5pZmVzdCwgb3B0aW9ucyk7XG4gICAgbG9nZ2VyLmRlYnVnKHsgYXBwbGllZCB9LCBcIk1ha2VFbW9qaSBvcHRpb25zIGFwcGxpZWRcIik7XG5cbiAgICAvLyBTb21lIGVkaXRvcnMgcmVuZGVyIGxpdmUgb24gY2hhbmdlIGFuZCBoYXZlIG5vIHRyaWdnZXIgYXQgYWxsOyBhIG1pc3NpbmdcbiAgICAvLyBnZW5lcmF0ZSBzZWxlY3RvciBpcyB0aGVyZWZvcmUgbm9ybWFsLCBub3QgYW4gZXJyb3IuXG4gICAgaWYgKG1hbmlmZXN0LmJyb3dzZXIuZ2VuZXJhdGVTZWxlY3Rvcikge1xuICAgICAgYXdhaXQgcGFnZS5jbGljayhtYW5pZmVzdC5icm93c2VyLmdlbmVyYXRlU2VsZWN0b3IsIHsgdGltZW91dDogcmVtYWluaW5nKCkgfSkuY2F0Y2goKCkgPT4ge1xuICAgICAgICBsb2dnZXIud2Fybih7IHNlbGVjdG9yOiBtYW5pZmVzdC5icm93c2VyLmdlbmVyYXRlU2VsZWN0b3IgfSwgXCJNYWtlRW1vamkgZ2VuZXJhdGUgY29udHJvbCBub3QgY2xpY2thYmxlXCIpO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gQWZ0ZXIgb3B0aW9ucyBjaGFuZ2UsIE1ha2VFbW9qaSByZS1lbmNvZGVzIGNsaWVudC1zaWRlLiBXYWl0IGZvciBhXG4gICAgLy8gZ2VuZXJhdGVkIHByZXZpZXcgdGhhdCBtYXRjaGVzIHRoZSByZXF1ZXN0ZWQgYW5pbWF0aW9uIGJlZm9yZSBzY3JhcGluZy5cbiAgICBhd2FpdCBwYWdlLndhaXRGb3JGdW5jdGlvbihcbiAgICAgICh7IGFuaW0sIHNlbGVjdG9yIH06IHsgYW5pbTogc3RyaW5nIHwgbnVsbDsgc2VsZWN0b3I6IHN0cmluZyB8IG51bGwgfSkgPT4ge1xuICAgICAgICBjb25zdCB3ID0gZ2xvYmFsVGhpcyBhcyB1bmtub3duIGFzIHtcbiAgICAgICAgICBkb2N1bWVudDoge1xuICAgICAgICAgICAgcXVlcnlTZWxlY3RvckFsbChzZWw6IHN0cmluZyk6IEFycmF5TGlrZTx7XG4gICAgICAgICAgICAgIGdldEF0dHJpYnV0ZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsO1xuICAgICAgICAgICAgICBzcmM/OiBzdHJpbmc7XG4gICAgICAgICAgICB9PjtcbiAgICAgICAgICB9O1xuICAgICAgICB9O1xuICAgICAgICBjb25zdCBzdHlsZU5hbWUgPSAoYW5pbSA/PyBcIlwiKVxuICAgICAgICAgIC5yZXBsYWNlKC9eZ2VuX2J0bl8vaSwgXCJcIilcbiAgICAgICAgICAucmVwbGFjZSgvXjp8OiQvZywgXCJcIilcbiAgICAgICAgICAudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgY29uc3Qgbm9kZXMgPSBBcnJheS5mcm9tKFxuICAgICAgICAgIHcuZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzZWxlY3RvciA/PyAnaW1nW2FsdCo9XCJnZW5lcmF0ZWRcIiBpXSwgaW1nLCB2aWRlbycpLFxuICAgICAgICApO1xuICAgICAgICByZXR1cm4gbm9kZXMuc29tZShlbCA9PiB7XG4gICAgICAgICAgY29uc3QgYWx0ID0gKGVsLmdldEF0dHJpYnV0ZShcImFsdFwiKSB8fCBcIlwiKS50b0xvd2VyQ2FzZSgpO1xuICAgICAgICAgIGNvbnN0IHNyYyA9IGVsLnNyYyB8fCBlbC5nZXRBdHRyaWJ1dGUoXCJzcmNcIikgfHwgXCJcIjtcbiAgICAgICAgICBpZiAoIShzcmMuc3RhcnRzV2l0aChcImJsb2I6XCIpIHx8IHNyYy5zdGFydHNXaXRoKFwiZGF0YTpcIikpKSByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgaWYgKCEvZ2VuZXJhdGVkLy50ZXN0KGFsdCkpIHJldHVybiBmYWxzZTtcbiAgICAgICAgICBpZiAoc3R5bGVOYW1lICYmICFhbHQuaW5jbHVkZXMoc3R5bGVOYW1lKSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgIHJldHVybiAhL3BsYWNlaG9sZGVyL2kudGVzdChhbHQpO1xuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgICB7XG4gICAgICAgIGFuaW06IG9wdGlvbnMuYW5pbWF0aW9uID8/IG51bGwsXG4gICAgICAgIHNlbGVjdG9yOiBtYW5pZmVzdC5icm93c2VyLnJlc3VsdFNlbGVjdG9yLFxuICAgICAgfSxcbiAgICAgIHsgdGltZW91dDogTWF0aC5taW4oUkVTVUxUX1RJTUVPVVRfTVMsIHJlbWFpbmluZygpKSB9LFxuICAgICkuY2F0Y2goKCkgPT4ge30pO1xuICAgIGF3YWl0IHBhZ2Uud2FpdEZvclRpbWVvdXQoNzUwKTtcblxuICAgIC8vIFx1MjUwMFx1MjUwMCByZXRyaWV2ZSB0aGUgZmluaXNoZWQgZmlsZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICBsZXQgYnVmZmVyOiBCdWZmZXIgfCBudWxsID0gbnVsbDtcbiAgICBsZXQgc291cmNlVXJsOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG5cbiAgICBpZiAobWFuaWZlc3QuYnJvd3Nlci5kb3dubG9hZFNlbGVjdG9yKSB7XG4gICAgICAvLyBBIHJlYWwgZG93bmxvYWQgZ2l2ZXMgdGhlIGV4YWN0IGJ5dGVzIHRoZSBzaXRlIGludGVuZHMgdG8gaGFuZCBvdmVyLlxuICAgICAgY29uc3QgZG93bmxvYWRQcm9taXNlOiBQcm9taXNlPERvd25sb2FkPiA9IHBhZ2Uud2FpdEZvckV2ZW50KFwiZG93bmxvYWRcIiwge1xuICAgICAgICB0aW1lb3V0OiBNYXRoLm1pbihSRVNVTFRfVElNRU9VVF9NUywgcmVtYWluaW5nKCkpLFxuICAgICAgfSk7XG4gICAgICBhd2FpdCBwYWdlLmNsaWNrKG1hbmlmZXN0LmJyb3dzZXIuZG93bmxvYWRTZWxlY3RvciwgeyB0aW1lb3V0OiByZW1haW5pbmcoKSB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICBjb25zdCBkb3dubG9hZCA9IGF3YWl0IGRvd25sb2FkUHJvbWlzZS5jYXRjaCgoKSA9PiBudWxsKTtcbiAgICAgIGlmIChkb3dubG9hZCkge1xuICAgICAgICBjb25zdCBwYXRoID0gam9pbih0ZW1wRGlyLCBcInJlc3VsdC5iaW5cIik7XG4gICAgICAgIGF3YWl0IGRvd25sb2FkLnNhdmVBcyhwYXRoKTtcbiAgICAgICAgY29uc3QgeyByZWFkRmlsZVN5bmMgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6ZnNcIik7XG4gICAgICAgIGJ1ZmZlciA9IHJlYWRGaWxlU3luYyhwYXRoKTtcbiAgICAgICAgc291cmNlVXJsID0gc2FmZU9yaWdpbihkb3dubG9hZC51cmwoKSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKCFidWZmZXIpIHtcbiAgICAgIC8vIEZhbGwgYmFjayB0byB0aGUgcHJldmlldy4gUG9sbCByYXRoZXIgdGhhbiB3YWl0IG9uY2U6IGdlbmVyYXRpb25cbiAgICAgIC8vIGZpbmlzaGVzIGFzeW5jaHJvbm91c2x5IGFuZCB0aGUgZWxlbWVudCBtYXkgYWxyZWFkeSBleGlzdCBidXQgc3RpbGwgYmVcbiAgICAgIC8vIHNob3dpbmcgdGhlIHByZXZpb3VzIGZyYW1lLlxuICAgICAgY29uc3QgdW50aWwgPSBNYXRoLm1pbihEYXRlLm5vdygpICsgUkVTVUxUX1RJTUVPVVRfTVMsIGRlYWRsaW5lKTtcbiAgICAgIGNvbnN0IHdhbnRHaWYgPSAhb3B0aW9ucy5mb3JtYXQgfHwgb3B0aW9ucy5mb3JtYXQgPT09IFwiZ2lmXCI7XG4gICAgICBjb25zdCB3YW50V2VicCA9IG9wdGlvbnMuZm9ybWF0ID09PSBcIndlYnBcIjtcbiAgICAgIHdoaWxlIChEYXRlLm5vdygpIDwgdW50aWwpIHtcbiAgICAgICAgY29uc3Qgc3JjID0gYXdhaXQgZmluZFByZXZpZXdTcmMoXG4gICAgICAgICAgcGFnZSwgbWFuaWZlc3QuYnJvd3Nlci5yZXN1bHRTZWxlY3Rvciwgb3B0aW9ucy5hbmltYXRpb24sXG4gICAgICAgICk7XG4gICAgICAgIGlmIChzcmMpIHtcbiAgICAgICAgICBjb25zdCBjYW5kaWRhdGUgPSBhd2FpdCByZWFkUHJldmlld0J5dGVzKHBhZ2UsIHNyYykuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgICAgICAgaWYgKGNhbmRpZGF0ZT8ubGVuZ3RoKSB7XG4gICAgICAgICAgICBjb25zdCBpc0dpZiA9IGNhbmRpZGF0ZS5zdWJhcnJheSgwLCAzKS50b1N0cmluZyhcImFzY2lpXCIpID09PSBcIkdJRlwiO1xuICAgICAgICAgICAgY29uc3QgaXNQbmcgPSBjYW5kaWRhdGVbMF0gPT09IDB4ODkgJiYgY2FuZGlkYXRlWzFdID09PSAweDUwO1xuICAgICAgICAgICAgY29uc3QgaXNXZWJwID0gY2FuZGlkYXRlLnN1YmFycmF5KDAsIDQpLnRvU3RyaW5nKFwiYXNjaWlcIikgPT09IFwiUklGRlwiO1xuICAgICAgICAgICAgLy8gU2tpcCBwbGFjZWhvbGRlcnMgdGhhdCBkb24ndCBtYXRjaCB0aGUgcmVxdWVzdGVkIGZvcm1hdCB3aGlsZVxuICAgICAgICAgICAgLy8gTWFrZUVtb2ppIGlzIHN0aWxsIHJlLWVuY29kaW5nIGFmdGVyIGFuIG9wdGlvbiBjaGFuZ2UuXG4gICAgICAgICAgICBpZiAod2FudEdpZiAmJiBpc1BuZyAmJiAhaXNHaWYpIHtcbiAgICAgICAgICAgICAgYXdhaXQgcGFnZS53YWl0Rm9yVGltZW91dCg3NTApO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh3YW50V2VicCAmJiAhaXNXZWJwKSB7XG4gICAgICAgICAgICAgIGF3YWl0IHBhZ2Uud2FpdEZvclRpbWVvdXQoNzUwKTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBidWZmZXIgPSBjYW5kaWRhdGU7XG4gICAgICAgICAgICBzb3VyY2VVcmwgPSBzcmMuc3RhcnRzV2l0aChcImRhdGE6XCIpIHx8IHNyYy5zdGFydHNXaXRoKFwiYmxvYjpcIikgPyB1bmRlZmluZWQgOiBzcmM7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgcGFnZS53YWl0Rm9yVGltZW91dCg3NTApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChyZWNvcmRlcikge1xuICAgICAgcmVjb3JkZXIuc3RvcCgpO1xuICAgICAgd3JpdGVEZWJ1Z1RyYWNlKFwiZ2VuZXJhdGVcIiwgcmVjb3JkZXIuZXhjaGFuZ2VzLCByZWNvcmRlci53ZWJzb2NrZXRzKTtcbiAgICB9XG5cbiAgICBpZiAoIWJ1ZmZlcj8ubGVuZ3RoKSB7XG4gICAgICBsb2dnZXIud2Fybih7IHNpdGU6IG1hbmlmZXN0LnNpdGVVcmwgfSwgXCJNYWtlRW1vamkgcHJvZHVjZWQgbm8gcmVzdWx0XCIpO1xuICAgICAgdGhyb3cgbmV3IEVtb2ppRXJyb3IoXCJnZW5lcmF0aW9uX2ZhaWxlZFwiLCBcIlRoZSBlbW9qaSBzZXJ2aWNlIGRpZG4ndCBwcm9kdWNlIGEgZmlsZS4gUGxlYXNlIHRyeSBhZ2Fpbi5cIik7XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIGJ1ZmZlcixcbiAgICAgIGZvcm1hdDogb3B0aW9ucy5mb3JtYXQsXG4gICAgICBieXRlczogYnVmZmVyLmxlbmd0aCxcbiAgICAgIHByb3ZpZGVySWQ6IFwibWFrZWVtb2ppLWJyb3dzZXJcIixcbiAgICAgIGR1cmF0aW9uTXM6IERhdGUubm93KCkgLSBzdGFydGVkLFxuICAgICAgLi4uKHNvdXJjZVVybCA/IHsgc291cmNlVXJsIH0gOiB7fSksXG4gICAgICBjYWNoZWQ6IGZhbHNlLFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGlmIChlcnIgaW5zdGFuY2VvZiBFbW9qaUVycm9yKSB0aHJvdyBlcnI7XG4gICAgY29uc3QgbWVzc2FnZSA9IChlcnIgYXMgRXJyb3IpLm1lc3NhZ2UgPz8gXCJcIjtcbiAgICBpZiAoL1RpbWVvdXR8dGltZW91dC8udGVzdChtZXNzYWdlKSkge1xuICAgICAgdGhyb3cgbmV3IEVtb2ppRXJyb3IoXCJ0aW1lb3V0XCIsIFwiVGhlIGVtb2ppIHNlcnZpY2UgdG9vayB0b28gbG9uZy4gUGxlYXNlIHRyeSBhZ2Fpbi5cIik7XG4gICAgfVxuICAgIGxvZ2dlci5lcnJvcih7IGVycjogbWVzc2FnZS5zcGxpdChcIlxcblwiKVswXSB9LCBcIk1ha2VFbW9qaSBicm93c2VyIGdlbmVyYXRpb24gZmFpbGVkXCIpO1xuICAgIHRocm93IG5ldyBFbW9qaUVycm9yKFwiYnJvd3Nlcl9mYWlsZWRcIiwgXCJUaGUgZW1vamkgZ2VuZXJhdG9yIGhpdCBhIHByb2JsZW0uIFBsZWFzZSB0cnkgYWdhaW4uXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIC8vIENsb3NlZCBpbiBldmVyeSBwYXRoOiBhIGxlYWtlZCBjb250ZXh0IG9yIGJyb3dzZXIgaXMgYSBwZXJtYW5lbnQgbWVtb3J5XG4gICAgLy8gY29zdCBvbiBhIGxvbmctcnVubmluZyBib3QsIGFuZCB0aGUgdGVtcCBkaXIgaG9sZHMgdGhlIGRvd25sb2FkZWQgZmlsZS5cbiAgICBhd2FpdCBjb250ZXh0Py5jbG9zZSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBhd2FpdCBicm93c2VyLmNsb3NlKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIHJtU3luYyh0ZW1wRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gIH1cbn1cblxuLyoqXG4gKiBPcmlnaW4gKyBwYXRoIG9ubHkgXHUyMDE0IGRvd25sb2FkIFVSTHMgcm91dGluZWx5IGNhcnJ5IHNpZ25lZCBxdWVyeSBwYXJhbWV0ZXJzLlxuICpcbiAqIEEgYGJsb2I6YCBVUkwgcGFyc2VzIG9kZGx5IChpdHMgXCJwYXRobmFtZVwiIGlzIHRoZSB3aG9sZSBpbm5lciBVUkwpIGFuZCBuYW1lc1xuICogbm90aGluZyBvdXRzaWRlIHRoZSBwYWdlLCBzbyBpdCBpcyByZXBvcnRlZCBhcyBhYnNlbnQgcmF0aGVyIHRoYW4gYXMgYVxuICogbWFuZ2xlZCBhZGRyZXNzLlxuICovXG5mdW5jdGlvbiBzYWZlT3JpZ2luKHJhdzogc3RyaW5nKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHJhdy5zdGFydHNXaXRoKFwiYmxvYjpcIikgfHwgcmF3LnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJhdyk7XG4gICAgcmV0dXJuIGAke3VybC5vcmlnaW59JHt1cmwucGF0aG5hbWV9YDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIkFBb0JBLFNBQVMsYUFBYSxjQUFjO0FBQ3BDLFNBQVMsY0FB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
