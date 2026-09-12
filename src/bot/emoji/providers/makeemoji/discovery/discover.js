import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchBrowser, newContext } from "../runtime.js";
import { OPTION_KEYS } from "../types.js";
import { analyzeBundle, classifyProcessing } from "./bundles.js";
import { expandListboxes, inspectPage, mapControlToOption } from "./inspect.js";
import { isBinaryContentType, recordNetwork } from "./recorder.js";
import { buildReport, verdictFor } from "./report.js";
const DEFAULT_SITE_URL = "https://makeemoji.com/";
const DEFAULT_OUTPUT_DIR = "makeemoji-investigation";
const STEP_TIMEOUT_MS = 2e4;
async function probeFetch(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15e3);
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    clearTimeout(timer);
    return {
      method: "node-fetch",
      ok: res.ok,
      status: res.status,
      detail: `HTTP ${res.status} ${res.statusText}`
    };
  } catch (err) {
    return {
      method: "node-fetch",
      ok: false,
      status: null,
      detail: `${err.message} \u2014 if this says CONNECT/403/EGRESS, this host cannot reach the site; run from one that can.`
    };
  }
}
function shortlistCandidates(exchanges) {
  const INTERESTING_PATH = /(api|upload|generate|render|process|convert|export|emoji|gif|webp|job|task|create|encode)/i;
  return exchanges.filter((x) => {
    if (x.resourceType === "document" || x.resourceType === "stylesheet") return false;
    if (x.resourceType === "font") return false;
    if (x.method !== "GET" && x.postData) return true;
    if (x.method !== "GET" && x.method !== "HEAD") return true;
    if (x.binary && x.resourceType !== "image") return true;
    if (x.resourceType === "xhr" || x.resourceType === "fetch") return true;
    return INTERESTING_PATH.test(x.url);
  });
}
function buildControls(inventory) {
  const controls = {};
  for (const control of inventory.controls) {
    const key = mapControlToOption(control.label);
    if (!key) continue;
    const spec = {
      selector: control.selector,
      kind: control.kind,
      ...control.valueAttribute ? { valueAttribute: control.valueAttribute } : {},
      values: control.values
    };
    const existing = controls[key];
    if (!existing || existing.values.length < spec.values.length) controls[key] = spec;
  }
  return controls;
}
function pickActionSelectors(inventory) {
  const ranked = (pattern, { buttonsOnly = false } = {}) => inventory.actionButtons.filter((b) => {
    if (!pattern.test(b.text) || /zip/i.test(b.text)) return false;
    if (buttonsOnly && b.tag && b.tag !== "button") return false;
    return true;
  }).sort((a, b) => {
    const score = (x) => (x.tag === "button" ? 0 : 2) + (x.text.trim().split(/\s+/).length > 3 ? 1 : 0);
    return score(a) - score(b);
  });
  return {
    generate: ranked(/^(generate|create|render|apply)\b/i, { buttonsOnly: true })[0]?.selector ?? null,
    download: ranked(/^(download|export|save)\b/i)[0]?.selector ?? null
  };
}
async function step(outcome, name, run) {
  try {
    const value = await run();
    outcome.steps.push({ step: name, ok: true, detail: "ok" });
    return value;
  } catch (err) {
    outcome.steps.push({ step: name, ok: false, detail: err.message.split("\n")[0] });
    return null;
  }
}
async function discover(options) {
  const siteUrl = options.siteUrl ?? DEFAULT_SITE_URL;
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const timeout = options.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  const say = options.onProgress ?? (() => {
  });
  const outcome = {
    siteUrl,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    reachability: [],
    inventory: null,
    inventoryAfterUpload: null,
    bundles: [],
    processing: null,
    verdict: "inconclusive",
    exchanges: [],
    websockets: [],
    candidates: [],
    result: { obtained: false, via: null, url: null, bytes: 0, contentType: null },
    manifest: {
      verified: false,
      discoveredAt: (/* @__PURE__ */ new Date()).toISOString(),
      siteUrl,
      notes: "",
      controls: {},
      browser: {
        readySelector: null,
        fileInputSelector: null,
        generateSelector: null,
        resultSelector: null,
        downloadSelector: null,
        dismissSelectors: []
      },
      api: null
    },
    steps: []
  };
  mkdirSync(join(outputDir, "responses"), { recursive: true });
  say("probing reachability with a plain HTTP request\u2026");
  outcome.reachability.push(await probeFetch(siteUrl));
  let browser = null;
  let resultBuffer = null;
  try {
    browser = await launchBrowser();
    const context = await newContext(browser);
    const page = await context.newPage();
    page.setDefaultTimeout(timeout);
    const recorder = recordNetwork(page);
    say(`opening ${siteUrl}\u2026`);
    const navigated = await step(outcome, "navigate", async () => {
      const response = await page.goto(siteUrl, { waitUntil: "domcontentloaded", timeout });
      outcome.reachability.push({
        method: "browser",
        ok: Boolean(response?.ok()),
        status: response?.status() ?? null,
        detail: response ? `HTTP ${response.status()}` : "no response"
      });
      await page.waitForLoadState("networkidle", { timeout }).catch(() => {
      });
      return true;
    });
    if (navigated) {
      say("inventorying page controls\u2026");
      outcome.inventory = await step(outcome, "inspect", () => inspectPage(page));
      if (outcome.inventory) {
        say("expanding listbox controls\u2026");
        outcome.inventory = await step(
          outcome,
          "expand-listboxes",
          () => expandListboxes(page, outcome.inventory)
        ) ?? outcome.inventory;
      }
      say("analysing JavaScript bundles\u2026");
      await step(outcome, "bundles", async () => {
        const fetchText = async (url) => {
          const res = await context.request.get(url, { timeout });
          return { status: res.status(), body: await res.text() };
        };
        const scripts = (outcome.inventory?.scripts ?? []).slice(0, 25);
        for (const url of scripts) {
          outcome.bundles.push(await analyzeBundle(url, fetchText));
        }
        outcome.processing = classifyProcessing(outcome.bundles);
        return true;
      });
      say("uploading the test image\u2026");
      const uploaded = await step(outcome, "upload", async () => {
        const selector = outcome.inventory?.fileInputs[0];
        if (!selector) throw new Error("no <input type=file> found on the page");
        await page.setInputFiles(selector, {
          name: "test.png",
          mimeType: "image/png",
          buffer: options.testImage
        });
        await page.waitForTimeout(2500);
        return selector;
      });
      if (uploaded) {
        say("re-inventorying after upload\u2026");
        outcome.inventoryAfterUpload = await step(outcome, "inspect-after-upload", async () => {
          await page.evaluate(async () => {
            const w = globalThis;
            const grid = w.document.querySelector("[data-output-grid]");
            for (let i = 0; i < 40; i++) {
              if (grid) {
                grid.scrollTop = grid.scrollHeight;
              }
              w.scrollBy?.(0, 800);
              await new Promise((r) => setTimeout(r, 120));
            }
          }).catch(() => {
          });
          await page.waitForTimeout(2e3);
          const inv = await inspectPage(page);
          return expandListboxes(page, inv);
        });
      }
      say("triggering generation\u2026");
      await step(outcome, "generate", async () => {
        const source = outcome.inventoryAfterUpload ?? outcome.inventory;
        if (!source) throw new Error("no inventory to pick a generate control from");
        const { generate } = pickActionSelectors(source);
        if (!generate) {
          say("no generate control (editor may render live)");
          await page.waitForFunction(() => {
            const w = globalThis;
            return Array.from(
              w.document.querySelectorAll("img")
            ).some((el) => /generated/i.test(el.getAttribute("alt") || ""));
          }, { timeout }).catch(() => {
          });
          await page.waitForTimeout(1500);
          return true;
        }
        await page.click(generate, { timeout });
        await page.waitForTimeout(3e3);
        return true;
      });
      say("retrieving the generated file\u2026");
      await step(outcome, "retrieve", async () => {
        const source = outcome.inventoryAfterUpload ?? outcome.inventory;
        const { download } = source ? pickActionSelectors(source) : { download: null };
        if (download) {
          try {
            const downloadPromise = page.waitForEvent("download", {
              timeout: Math.min(8e3, timeout)
            });
            await page.click(download, { timeout: Math.min(5e3, timeout) }).catch(() => {
            });
            const dl = await downloadPromise;
            const stream = await dl.createReadStream();
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            resultBuffer = Buffer.concat(chunks);
            outcome.result = {
              obtained: true,
              via: "download",
              url: redactedDownloadUrl(dl),
              bytes: resultBuffer.length,
              contentType: sniffContentType(resultBuffer)
            };
            return true;
          } catch {
            say("download control did not yield a file; trying preview\u2026");
          }
        }
        const previewSrc = await page.evaluate(() => {
          const w = globalThis;
          const nodes = Array.from(
            w.document.querySelectorAll("img, video, source")
          );
          const scored = nodes.map((el) => {
            const media = el;
            const src = media.src || el.getAttribute("src") || "";
            const alt = (el.getAttribute("alt") || "").toLowerCase();
            const isBlob = src.startsWith("blob:") || src.startsWith("data:");
            const generated = /generated/.test(alt);
            if (!isBlob && !generated) return null;
            if (!isBlob && /^https?:/i.test(src)) return null;
            const score = (generated ? 4 : 0) + (isBlob ? 2 : 0) + (/animated emoji|static emoji/.test(alt) ? 1 : 0);
            return { src, score };
          }).filter((x) => x !== null).sort((a, b) => a.score - b.score);
          return scored[scored.length - 1]?.src ?? null;
        });
        if (!previewSrc) throw new Error("no preview image/blob found after generating");
        resultBuffer = await readPreview(page, previewSrc);
        outcome.result = {
          obtained: true,
          via: "preview-src",
          url: previewSrc.startsWith("data:") ? "(data: uri)" : previewSrc.startsWith("blob:") ? "(in-page blob)" : previewSrc,
          bytes: resultBuffer.length,
          contentType: sniffContentType(resultBuffer)
        };
        return true;
      });
    }
    recorder.stop();
    outcome.exchanges = recorder.exchanges;
    outcome.websockets = recorder.websockets;
    outcome.candidates = shortlistCandidates(recorder.exchanges);
    await context.close();
  } finally {
    await browser?.close().catch(() => {
    });
  }
  const inventory = outcome.inventoryAfterUpload ?? outcome.inventory;
  if (inventory) {
    const actions = pickActionSelectors(inventory);
    outcome.manifest.controls = buildControls(inventory);
    const fileInput = inventory.fileInputs.length === 1 ? "input[type=file]" : inventory.fileInputs[0] ?? null;
    const hasGeneratedPreview = outcome.result.via === "preview-src";
    outcome.manifest.browser = {
      readySelector: fileInput,
      fileInputSelector: fileInput,
      generateSelector: actions.generate,
      resultSelector: hasGeneratedPreview ? 'img[alt*="generated" i]' : null,
      downloadSelector: outcome.result.via === "download" ? actions.download : null,
      dismissSelectors: []
    };
  }
  outcome.verdict = verdictFor(
    outcome,
    outcome.candidates.filter((x) => x.method !== "GET" && x.postData !== null)
  ).verdict;
  const hasFileInput = outcome.manifest.browser.fileInputSelector !== null;
  const hasAnimations = (outcome.manifest.controls.animation?.values.length ?? 0) > 0;
  outcome.manifest.verified = hasFileInput && hasAnimations;
  outcome.manifest.notes = [
    `Discovered ${outcome.startedAt}.`,
    `Processing verdict: ${outcome.verdict}.`,
    `Result obtained: ${outcome.result.obtained ? outcome.result.via : "no"}.`,
    hasFileInput ? "" : "NO FILE INPUT FOUND \u2014 browser provider cannot run.",
    hasAnimations ? "" : "NO ANIMATION VALUES FOUND \u2014 check the report's control inventory and fill controls.animation by hand.",
    "api stays null until a generation request is confirmed from the recorded traffic; see report.md."
  ].filter(Boolean).join(" ");
  writeFileSync(join(outputDir, "network.json"), JSON.stringify(
    { siteUrl, startedAt: outcome.startedAt, websockets: outcome.websockets, exchanges: outcome.exchanges },
    null,
    2
  ));
  writeFileSync(join(outputDir, "relevant-requests.json"), JSON.stringify(outcome.candidates, null, 2));
  writeFileSync(join(outputDir, "inventory.json"), JSON.stringify(
    { before: outcome.inventory, afterUpload: outcome.inventoryAfterUpload },
    null,
    2
  ));
  writeFileSync(join(outputDir, "bundles.json"), JSON.stringify(outcome.bundles, null, 2));
  writeFileSync(join(outputDir, "manifest.json"), JSON.stringify(outcome.manifest, null, 2));
  if (resultBuffer) {
    writeFileSync(join(outputDir, "responses", `result${extensionFor(outcome.result.contentType)}`), resultBuffer);
  }
  writeFileSync(join(outputDir, "report.md"), buildReport(outcome));
  say(`wrote ${outputDir}/report.md`);
  return outcome;
}
function redactedDownloadUrl(download) {
  return describeDownloadUrl(download.url());
}
function describeDownloadUrl(raw) {
  if (raw.startsWith("blob:")) return "(in-page blob)";
  if (raw.startsWith("data:")) return "(data: uri)";
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(unknown)";
  }
}
function extensionFor(contentType) {
  if (!contentType) return ".bin";
  if (/gif/i.test(contentType)) return ".gif";
  if (/webp/i.test(contentType)) return ".webp";
  if (/png/i.test(contentType)) return ".png";
  return ".bin";
}
function sniffContentType(buffer) {
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return "image/gif";
  }
  if (buffer.length >= 8 && buffer[0] === 137 && buffer[1] === 80 && buffer[2] === 78 && buffer[3] === 71) {
    return "image/png";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}
async function readPreview(page, src) {
  const base64 = await page.evaluate(async (url) => {
    const w = globalThis;
    const response = await w.fetch(url);
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new w.FileReader();
      reader.onloadend = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error("could not read the preview blob"));
      reader.readAsDataURL(blob);
    });
  }, src);
  return Buffer.from(base64, "base64");
}
export {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_SITE_URL,
  OPTION_KEYS,
  discover,
  isBinaryContentType
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiZGlzY292ZXIudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLy8gTWFrZUVtb2ppIGRpc2NvdmVyeS5cbi8vXG4vLyBEcml2ZXMgdGhlIHJlYWwgZWRpdG9yIGluIGEgcmVhbCBicm93c2VyIGFuZCB3cml0ZXMgZG93biB3aGF0IGFjdHVhbGx5XG4vLyBoYXBwZW5lZCwgc28gdGhlIHByb3ZpZGVyIGNhbiBiZSBidWlsdCBmcm9tIGV2aWRlbmNlIGluc3RlYWQgb2YgYXNzdW1wdGlvbnMuXG4vL1xuLy8gSXQgYW5zd2VycywgaW4gb3JkZXI6XG4vLyAgIDEuIElzIHRoZSBzaXRlIHJlYWNoYWJsZSBhdCBhbGwgZnJvbSB0aGlzIGhvc3QsIGJ5IHBsYWluIEhUVFAgYW5kIGJ5IGJyb3dzZXI/XG4vLyAgIDIuIFdoYXQgY29udHJvbHMgZG9lcyB0aGUgZWRpdG9yIGhhdmUsIGFuZCB3aGF0IHZhbHVlcyBkbyB0aGV5IGFjY2VwdD9cbi8vICAgMy4gRG8gdGhlIGJ1bmRsZXMgc2hvdyBhIGJhY2tlbmQgcGlwZWxpbmUsIG9yIGluLWJyb3dzZXIgZW5jb2Rpbmc/XG4vLyAgIDQuIFdoZW4gYW4gaW1hZ2UgaXMgdXBsb2FkZWQgYW5kIGdlbmVyYXRpb24gdHJpZ2dlcmVkLCB3aGljaCByZXF1ZXN0IFx1MjAxNCBpZlxuLy8gICAgICBhbnkgXHUyMDE0IHByb2R1Y2VzIHRoZSBvdXRwdXQ/XG4vLyAgIDUuIFdoZXJlIGRvZXMgdGhlIGZpbmlzaGVkIGZpbGUgY29tZSBmcm9tOiBhIGRvd25sb2FkLCBhIGJsb2IsIGEgVVJMP1xuLy9cbi8vIFRoZSBydW4gcHJvZHVjZXMgYSBtYW5pZmVzdCB0aGUgcHJvdmlkZXIgcmVhZHMsIHBsdXMgYSBodW1hbiByZXBvcnQuIElmIGEgc3RlcFxuLy8gZmFpbHMsIHRoZSBydW4ga2VlcHMgZ29pbmcgYW5kIHJlY29yZHMgdGhlIGZhaWx1cmU6IGEgcGFydGlhbCBtYW5pZmVzdCB3aXRoIGFuXG4vLyBob25lc3QgcmVwb3J0IGJlYXRzIG5vIGluZm9ybWF0aW9uIGF0IGFsbC5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG5pbXBvcnQgeyBta2RpclN5bmMsIHdyaXRlRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQnJvd3NlciwgRG93bmxvYWQsIFBhZ2UgfSBmcm9tIFwicGxheXdyaWdodFwiO1xuaW1wb3J0IHsgbGF1bmNoQnJvd3NlciwgbmV3Q29udGV4dCB9IGZyb20gXCIuLi9ydW50aW1lLmpzXCI7XG5pbXBvcnQgeyBPUFRJT05fS0VZUywgdHlwZSBDb250cm9sU3BlYywgdHlwZSBNYW5pZmVzdCwgdHlwZSBPcHRpb25LZXkgfSBmcm9tIFwiLi4vdHlwZXMuanNcIjtcbmltcG9ydCB7IGFuYWx5emVCdW5kbGUsIGNsYXNzaWZ5UHJvY2Vzc2luZywgdHlwZSBCdW5kbGVSZXBvcnQgfSBmcm9tIFwiLi9idW5kbGVzLmpzXCI7XG5pbXBvcnQgeyBleHBhbmRMaXN0Ym94ZXMsIGluc3BlY3RQYWdlLCBtYXBDb250cm9sVG9PcHRpb24sIHR5cGUgUGFnZUludmVudG9yeSB9IGZyb20gXCIuL2luc3BlY3QuanNcIjtcbmltcG9ydCB7IGlzQmluYXJ5Q29udGVudFR5cGUsIHJlY29yZE5ldHdvcmssIHR5cGUgUmVjb3JkZWRFeGNoYW5nZSB9IGZyb20gXCIuL3JlY29yZGVyLmpzXCI7XG5pbXBvcnQgeyBidWlsZFJlcG9ydCwgdmVyZGljdEZvciB9IGZyb20gXCIuL3JlcG9ydC5qc1wiO1xuaW1wb3J0IHR5cGUgeyBCcm93c2VyV2luZG93LCBEb21FbGVtZW50LCBEb21NZWRpYSB9IGZyb20gXCIuL2RvbS10eXBlcy5qc1wiO1xuXG5leHBvcnQgY29uc3QgREVGQVVMVF9TSVRFX1VSTCA9IFwiaHR0cHM6Ly9tYWtlZW1vamkuY29tL1wiO1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfT1VUUFVUX0RJUiA9IFwibWFrZWVtb2ppLWludmVzdGlnYXRpb25cIjtcblxuZXhwb3J0IGludGVyZmFjZSBEaXNjb3Zlck9wdGlvbnMge1xuICBzaXRlVXJsPzogc3RyaW5nO1xuICBvdXRwdXREaXI/OiBzdHJpbmc7XG4gIC8qKiBQTkcgYnl0ZXMgdXBsb2FkZWQgdG8gdGhlIGVkaXRvci4gKi9cbiAgdGVzdEltYWdlOiBCdWZmZXI7XG4gIC8qKiBQZXItc3RlcCBidWRnZXQuIFRoZSB3aG9sZSBydW4gaXMgcm91Z2hseSA2XHUwMEQ3IHRoaXMuICovXG4gIHN0ZXBUaW1lb3V0TXM/OiBudW1iZXI7XG4gIC8qKiBDYWxsZWQgd2l0aCBwcm9ncmVzcyBtZXNzYWdlcyBzbyBhIENMSSBjYW4gbmFycmF0ZSB0aGUgcnVuLiAqL1xuICBvblByb2dyZXNzPzogKG1lc3NhZ2U6IHN0cmluZykgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZWFjaGFiaWxpdHlQcm9iZSB7XG4gIG1ldGhvZDogXCJub2RlLWZldGNoXCIgfCBcImJyb3dzZXJcIjtcbiAgb2s6IGJvb2xlYW47XG4gIHN0YXR1czogbnVtYmVyIHwgbnVsbDtcbiAgZGV0YWlsOiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGlzY292ZXJ5T3V0Y29tZSB7XG4gIHNpdGVVcmw6IHN0cmluZztcbiAgc3RhcnRlZEF0OiBzdHJpbmc7XG4gIHJlYWNoYWJpbGl0eTogUmVhY2hhYmlsaXR5UHJvYmVbXTtcbiAgaW52ZW50b3J5OiBQYWdlSW52ZW50b3J5IHwgbnVsbDtcbiAgaW52ZW50b3J5QWZ0ZXJVcGxvYWQ6IFBhZ2VJbnZlbnRvcnkgfCBudWxsO1xuICBidW5kbGVzOiBCdW5kbGVSZXBvcnRbXTtcbiAgcHJvY2Vzc2luZzogUmV0dXJuVHlwZTx0eXBlb2YgY2xhc3NpZnlQcm9jZXNzaW5nPiB8IG51bGw7XG4gIC8qKiBXaGVyZSBwcm9jZXNzaW5nIGhhcHBlbnMsIGNvbWJpbmluZyBidW5kbGUgYW5hbHlzaXMgd2l0aCBvYnNlcnZlZCBiZWhhdmlvdXIuICovXG4gIHZlcmRpY3Q6IHN0cmluZztcbiAgZXhjaGFuZ2VzOiBSZWNvcmRlZEV4Y2hhbmdlW107XG4gIHdlYnNvY2tldHM6IHN0cmluZ1tdO1xuICAvKiogUmVxdWVzdHMgdGhhdCBwbGF1c2libHkgcHJvZHVjZWQgdGhlIG91dHB1dC4gKi9cbiAgY2FuZGlkYXRlczogUmVjb3JkZWRFeGNoYW5nZVtdO1xuICAvKiogSG93IHRoZSBmaW5pc2hlZCBmaWxlIHdhcyBvYnRhaW5lZCwgd2hlbiBpdCB3YXMuICovXG4gIHJlc3VsdDoge1xuICAgIG9idGFpbmVkOiBib29sZWFuO1xuICAgIHZpYTogXCJkb3dubG9hZFwiIHwgXCJwcmV2aWV3LXNyY1wiIHwgXCJiaW5hcnktcmVzcG9uc2VcIiB8IG51bGw7XG4gICAgdXJsOiBzdHJpbmcgfCBudWxsO1xuICAgIGJ5dGVzOiBudW1iZXI7XG4gICAgY29udGVudFR5cGU6IHN0cmluZyB8IG51bGw7XG4gIH07XG4gIG1hbmlmZXN0OiBNYW5pZmVzdDtcbiAgc3RlcHM6IHsgc3RlcDogc3RyaW5nOyBvazogYm9vbGVhbjsgZGV0YWlsOiBzdHJpbmcgfVtdO1xufVxuXG5jb25zdCBTVEVQX1RJTUVPVVRfTVMgPSAyMF8wMDA7XG5cbi8qKiBQcm9iZSB0aGUgc2l0ZSB3aXRoIGEgcGxhaW4gTm9kZSBmZXRjaCBcdTIwMTQgaXMgdGhpcyBhIG5ldHdvcmsgcHJvYmxlbSBvciBhIHNpdGUgcHJvYmxlbT8gKi9cbmFzeW5jIGZ1bmN0aW9uIHByb2JlRmV0Y2godXJsOiBzdHJpbmcpOiBQcm9taXNlPFJlYWNoYWJpbGl0eVByb2JlPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCAxNV8wMDApO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsLCByZWRpcmVjdDogXCJmb2xsb3dcIiB9KTtcbiAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIHJldHVybiB7XG4gICAgICBtZXRob2Q6IFwibm9kZS1mZXRjaFwiLFxuICAgICAgb2s6IHJlcy5vayxcbiAgICAgIHN0YXR1czogcmVzLnN0YXR1cyxcbiAgICAgIGRldGFpbDogYEhUVFAgJHtyZXMuc3RhdHVzfSAke3Jlcy5zdGF0dXNUZXh0fWAsXG4gICAgfTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG1ldGhvZDogXCJub2RlLWZldGNoXCIsXG4gICAgICBvazogZmFsc2UsXG4gICAgICBzdGF0dXM6IG51bGwsXG4gICAgICBkZXRhaWw6IGAkeyhlcnIgYXMgRXJyb3IpLm1lc3NhZ2V9IFx1MjAxNCBpZiB0aGlzIHNheXMgQ09OTkVDVC80MDMvRUdSRVNTLCB0aGlzIGhvc3QgY2Fubm90IHJlYWNoIHRoZSBzaXRlOyBydW4gZnJvbSBvbmUgdGhhdCBjYW4uYCxcbiAgICB9O1xuICB9XG59XG5cbi8qKlxuICogUmVxdWVzdHMgdGhhdCBjb3VsZCBoYXZlIHByb2R1Y2VkIHRoZSBlbW9qaS5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgZ2VuZXJvdXM6IGl0IGlzIGZhciBiZXR0ZXIgdG8gb3Zlci1yZXBvcnQgYW5kIGxldCBhIGh1bWFuIHJlYWRcbiAqIHRoZSBzaG9ydGxpc3QgdGhhbiB0byBmaWx0ZXIgb3V0IHRoZSBvbmUgcmVxdWVzdCB0aGF0IG1hdHRlcmVkLlxuICovXG5mdW5jdGlvbiBzaG9ydGxpc3RDYW5kaWRhdGVzKGV4Y2hhbmdlczogUmVjb3JkZWRFeGNoYW5nZVtdKTogUmVjb3JkZWRFeGNoYW5nZVtdIHtcbiAgY29uc3QgSU5URVJFU1RJTkdfUEFUSCA9IC8oYXBpfHVwbG9hZHxnZW5lcmF0ZXxyZW5kZXJ8cHJvY2Vzc3xjb252ZXJ0fGV4cG9ydHxlbW9qaXxnaWZ8d2VicHxqb2J8dGFza3xjcmVhdGV8ZW5jb2RlKS9pO1xuXG4gIHJldHVybiBleGNoYW5nZXMuZmlsdGVyKHggPT4ge1xuICAgIGlmICh4LnJlc291cmNlVHlwZSA9PT0gXCJkb2N1bWVudFwiIHx8IHgucmVzb3VyY2VUeXBlID09PSBcInN0eWxlc2hlZXRcIikgcmV0dXJuIGZhbHNlO1xuICAgIGlmICh4LnJlc291cmNlVHlwZSA9PT0gXCJmb250XCIpIHJldHVybiBmYWxzZTtcblxuICAgIC8vIEEgYm9keS1jYXJyeWluZyByZXF1ZXN0IGlzIGFsd2F5cyB3b3J0aCBhIGxvb2sgXHUyMDE0IHRoYXQgaXMgaG93IGFuIGltYWdlIGdldHNcbiAgICAvLyBzZW50IHNvbWV3aGVyZS5cbiAgICBpZiAoeC5tZXRob2QgIT09IFwiR0VUXCIgJiYgeC5wb3N0RGF0YSkgcmV0dXJuIHRydWU7XG4gICAgaWYgKHgubWV0aG9kICE9PSBcIkdFVFwiICYmIHgubWV0aG9kICE9PSBcIkhFQURcIikgcmV0dXJuIHRydWU7XG4gICAgLy8gQSBiaW5hcnkgcmVzcG9uc2UgdGhhdCBpc24ndCBhIHBhZ2UgYXNzZXQgbWF5IGJlIHRoZSBnZW5lcmF0ZWQgZmlsZS5cbiAgICBpZiAoeC5iaW5hcnkgJiYgeC5yZXNvdXJjZVR5cGUgIT09IFwiaW1hZ2VcIikgcmV0dXJuIHRydWU7XG4gICAgaWYgKHgucmVzb3VyY2VUeXBlID09PSBcInhoclwiIHx8IHgucmVzb3VyY2VUeXBlID09PSBcImZldGNoXCIpIHJldHVybiB0cnVlO1xuICAgIHJldHVybiBJTlRFUkVTVElOR19QQVRILnRlc3QoeC51cmwpO1xuICB9KTtcbn1cblxuLyoqIE1hcCB0aGUgZGlzY292ZXJlZCBpbnZlbnRvcnkgb250byBvdXIgb3B0aW9uIGtleXMuICovXG5mdW5jdGlvbiBidWlsZENvbnRyb2xzKGludmVudG9yeTogUGFnZUludmVudG9yeSk6IFBhcnRpYWw8UmVjb3JkPE9wdGlvbktleSwgQ29udHJvbFNwZWM+PiB7XG4gIGNvbnN0IGNvbnRyb2xzOiBQYXJ0aWFsPFJlY29yZDxPcHRpb25LZXksIENvbnRyb2xTcGVjPj4gPSB7fTtcblxuICBmb3IgKGNvbnN0IGNvbnRyb2wgb2YgaW52ZW50b3J5LmNvbnRyb2xzKSB7XG4gICAgY29uc3Qga2V5ID0gbWFwQ29udHJvbFRvT3B0aW9uKGNvbnRyb2wubGFiZWwpO1xuICAgIGlmICgha2V5KSBjb250aW51ZTtcblxuICAgIGNvbnN0IHNwZWM6IENvbnRyb2xTcGVjID0ge1xuICAgICAgc2VsZWN0b3I6IGNvbnRyb2wuc2VsZWN0b3IsXG4gICAgICBraW5kOiBjb250cm9sLmtpbmQsXG4gICAgICAuLi4oY29udHJvbC52YWx1ZUF0dHJpYnV0ZSA/IHsgdmFsdWVBdHRyaWJ1dGU6IGNvbnRyb2wudmFsdWVBdHRyaWJ1dGUgfSA6IHt9KSxcbiAgICAgIHZhbHVlczogY29udHJvbC52YWx1ZXMsXG4gICAgfTtcblxuICAgIC8vIFNldmVyYWwgY29udHJvbHMgY2FuIG1hcCB0byB0aGUgc2FtZSBrZXkgKGEgXCJzaXplXCIgc2xpZGVyIGFuZCBhIFwic2l6ZVwiXG4gICAgLy8gc2VsZWN0KS4gUHJlZmVyIHdoaWNoZXZlciBvZmZlcnMgcmVhbCBjaG9pY2VzIFx1MjAxNCB0aGF0IGlzIHRoZSBvbmUgYSBjYWxsZXJcbiAgICAvLyBjYW4gYWN0dWFsbHkgZHJpdmUgZnJvbSBhbiBvcHRpb24gdmFsdWUuXG4gICAgY29uc3QgZXhpc3RpbmcgPSBjb250cm9sc1trZXldO1xuICAgIGlmICghZXhpc3RpbmcgfHwgZXhpc3RpbmcudmFsdWVzLmxlbmd0aCA8IHNwZWMudmFsdWVzLmxlbmd0aCkgY29udHJvbHNba2V5XSA9IHNwZWM7XG4gIH1cblxuICByZXR1cm4gY29udHJvbHM7XG59XG5cbi8qKiBCZXN0IGd1ZXNzIGF0IHdoaWNoIGFjdGlvbiBidXR0b24gc3RhcnRzIGdlbmVyYXRpb24sIGFuZCB3aGljaCBkb3dubG9hZHMuICovXG5mdW5jdGlvbiBwaWNrQWN0aW9uU2VsZWN0b3JzKGludmVudG9yeTogUGFnZUludmVudG9yeSk6IHtcbiAgZ2VuZXJhdGU6IHN0cmluZyB8IG51bGw7IGRvd25sb2FkOiBzdHJpbmcgfCBudWxsO1xufSB7XG4gIC8vIFByZWZlciByZWFsIDxidXR0b24+cyBvdmVyIDxhPiBtYXJrZXRpbmcgbGlua3MsIGFuZCBza2lwIFpJUCBidWxrIGFjdGlvbnMgXHUyMDE0XG4gIC8vIE1ha2VFbW9qaSdzIHBlci1lbW9qaSBkb3dubG9hZCBsaXZlcyBpbiBhIGNhcmQgbWVudSwgbm90IGluIHRob3NlIGJ1dHRvbnMuXG4gIC8vIE5ldmVyIHRyZWF0IGFuIDxhIGhyZWY+IGFzIGdlbmVyYXRlOiBcIkNvbnZlcnQgQW55IEltYWdlXHUyMDI2XCIgbWF0Y2hlcyBjb252ZXJ0XG4gIC8vIGFuZCB3b3VsZCBuYXZpZ2F0ZSBhd2F5IGZyb20gdGhlIGVkaXRvci5cbiAgY29uc3QgcmFua2VkID0gKHBhdHRlcm46IFJlZ0V4cCwgeyBidXR0b25zT25seSA9IGZhbHNlIH0gPSB7fSkgPT5cbiAgICBpbnZlbnRvcnkuYWN0aW9uQnV0dG9uc1xuICAgICAgLmZpbHRlcihiID0+IHtcbiAgICAgICAgaWYgKCFwYXR0ZXJuLnRlc3QoYi50ZXh0KSB8fCAvemlwL2kudGVzdChiLnRleHQpKSByZXR1cm4gZmFsc2U7XG4gICAgICAgIGlmIChidXR0b25zT25seSAmJiBiLnRhZyAmJiBiLnRhZyAhPT0gXCJidXR0b25cIikgcmV0dXJuIGZhbHNlO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0pXG4gICAgICAuc29ydCgoYSwgYikgPT4ge1xuICAgICAgICBjb25zdCBzY29yZSA9ICh4OiB0eXBlb2YgYSkgPT5cbiAgICAgICAgICAoeC50YWcgPT09IFwiYnV0dG9uXCIgPyAwIDogMikgKyAoeC50ZXh0LnRyaW0oKS5zcGxpdCgvXFxzKy8pLmxlbmd0aCA+IDMgPyAxIDogMCk7XG4gICAgICAgIHJldHVybiBzY29yZShhKSAtIHNjb3JlKGIpO1xuICAgICAgfSk7XG5cbiAgcmV0dXJuIHtcbiAgICBnZW5lcmF0ZTogcmFua2VkKC9eKGdlbmVyYXRlfGNyZWF0ZXxyZW5kZXJ8YXBwbHkpXFxiL2ksIHsgYnV0dG9uc09ubHk6IHRydWUgfSlbMF0/LnNlbGVjdG9yXG4gICAgICA/PyBudWxsLFxuICAgIGRvd25sb2FkOiByYW5rZWQoL14oZG93bmxvYWR8ZXhwb3J0fHNhdmUpXFxiL2kpWzBdPy5zZWxlY3RvciA/PyBudWxsLFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdGVwPFQ+KFxuICBvdXRjb21lOiBEaXNjb3ZlcnlPdXRjb21lLCBuYW1lOiBzdHJpbmcsIHJ1bjogKCkgPT4gUHJvbWlzZTxUPixcbik6IFByb21pc2U8VCB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB2YWx1ZSA9IGF3YWl0IHJ1bigpO1xuICAgIG91dGNvbWUuc3RlcHMucHVzaCh7IHN0ZXA6IG5hbWUsIG9rOiB0cnVlLCBkZXRhaWw6IFwib2tcIiB9KTtcbiAgICByZXR1cm4gdmFsdWU7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIG91dGNvbWUuc3RlcHMucHVzaCh7IHN0ZXA6IG5hbWUsIG9rOiBmYWxzZSwgZGV0YWlsOiAoZXJyIGFzIEVycm9yKS5tZXNzYWdlLnNwbGl0KFwiXFxuXCIpWzBdISB9KTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGlzY292ZXIob3B0aW9uczogRGlzY292ZXJPcHRpb25zKTogUHJvbWlzZTxEaXNjb3ZlcnlPdXRjb21lPiB7XG4gIGNvbnN0IHNpdGVVcmwgPSBvcHRpb25zLnNpdGVVcmwgPz8gREVGQVVMVF9TSVRFX1VSTDtcbiAgY29uc3Qgb3V0cHV0RGlyID0gb3B0aW9ucy5vdXRwdXREaXIgPz8gREVGQVVMVF9PVVRQVVRfRElSO1xuICBjb25zdCB0aW1lb3V0ID0gb3B0aW9ucy5zdGVwVGltZW91dE1zID8/IFNURVBfVElNRU9VVF9NUztcbiAgY29uc3Qgc2F5ID0gb3B0aW9ucy5vblByb2dyZXNzID8/ICgoKSA9PiB7fSk7XG5cbiAgY29uc3Qgb3V0Y29tZTogRGlzY292ZXJ5T3V0Y29tZSA9IHtcbiAgICBzaXRlVXJsLFxuICAgIHN0YXJ0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIHJlYWNoYWJpbGl0eTogW10sXG4gICAgaW52ZW50b3J5OiBudWxsLFxuICAgIGludmVudG9yeUFmdGVyVXBsb2FkOiBudWxsLFxuICAgIGJ1bmRsZXM6IFtdLFxuICAgIHByb2Nlc3Npbmc6IG51bGwsXG4gICAgdmVyZGljdDogXCJpbmNvbmNsdXNpdmVcIixcbiAgICBleGNoYW5nZXM6IFtdLFxuICAgIHdlYnNvY2tldHM6IFtdLFxuICAgIGNhbmRpZGF0ZXM6IFtdLFxuICAgIHJlc3VsdDogeyBvYnRhaW5lZDogZmFsc2UsIHZpYTogbnVsbCwgdXJsOiBudWxsLCBieXRlczogMCwgY29udGVudFR5cGU6IG51bGwgfSxcbiAgICBtYW5pZmVzdDoge1xuICAgICAgdmVyaWZpZWQ6IGZhbHNlLFxuICAgICAgZGlzY292ZXJlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgICBzaXRlVXJsLFxuICAgICAgbm90ZXM6IFwiXCIsXG4gICAgICBjb250cm9sczoge30sXG4gICAgICBicm93c2VyOiB7XG4gICAgICAgIHJlYWR5U2VsZWN0b3I6IG51bGwsIGZpbGVJbnB1dFNlbGVjdG9yOiBudWxsLCBnZW5lcmF0ZVNlbGVjdG9yOiBudWxsLFxuICAgICAgICByZXN1bHRTZWxlY3RvcjogbnVsbCwgZG93bmxvYWRTZWxlY3RvcjogbnVsbCwgZGlzbWlzc1NlbGVjdG9yczogW10sXG4gICAgICB9LFxuICAgICAgYXBpOiBudWxsLFxuICAgIH0sXG4gICAgc3RlcHM6IFtdLFxuICB9O1xuXG4gIG1rZGlyU3luYyhqb2luKG91dHB1dERpciwgXCJyZXNwb25zZXNcIiksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gIHNheShcInByb2JpbmcgcmVhY2hhYmlsaXR5IHdpdGggYSBwbGFpbiBIVFRQIHJlcXVlc3RcdTIwMjZcIik7XG4gIG91dGNvbWUucmVhY2hhYmlsaXR5LnB1c2goYXdhaXQgcHJvYmVGZXRjaChzaXRlVXJsKSk7XG5cbiAgbGV0IGJyb3dzZXI6IEJyb3dzZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IHJlc3VsdEJ1ZmZlcjogQnVmZmVyIHwgbnVsbCA9IG51bGw7XG5cbiAgdHJ5IHtcbiAgICBicm93c2VyID0gYXdhaXQgbGF1bmNoQnJvd3NlcigpO1xuICAgIGNvbnN0IGNvbnRleHQgPSBhd2FpdCBuZXdDb250ZXh0KGJyb3dzZXIpO1xuICAgIGNvbnN0IHBhZ2UgPSBhd2FpdCBjb250ZXh0Lm5ld1BhZ2UoKTtcbiAgICBwYWdlLnNldERlZmF1bHRUaW1lb3V0KHRpbWVvdXQpO1xuICAgIGNvbnN0IHJlY29yZGVyID0gcmVjb3JkTmV0d29yayhwYWdlKTtcblxuICAgIHNheShgb3BlbmluZyAke3NpdGVVcmx9XHUyMDI2YCk7XG4gICAgY29uc3QgbmF2aWdhdGVkID0gYXdhaXQgc3RlcChvdXRjb21lLCBcIm5hdmlnYXRlXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgcGFnZS5nb3RvKHNpdGVVcmwsIHsgd2FpdFVudGlsOiBcImRvbWNvbnRlbnRsb2FkZWRcIiwgdGltZW91dCB9KTtcbiAgICAgIG91dGNvbWUucmVhY2hhYmlsaXR5LnB1c2goe1xuICAgICAgICBtZXRob2Q6IFwiYnJvd3NlclwiLFxuICAgICAgICBvazogQm9vbGVhbihyZXNwb25zZT8ub2soKSksXG4gICAgICAgIHN0YXR1czogcmVzcG9uc2U/LnN0YXR1cygpID8/IG51bGwsXG4gICAgICAgIGRldGFpbDogcmVzcG9uc2UgPyBgSFRUUCAke3Jlc3BvbnNlLnN0YXR1cygpfWAgOiBcIm5vIHJlc3BvbnNlXCIsXG4gICAgICB9KTtcbiAgICAgIC8vIEVkaXRvcnMgaHlkcmF0ZSBhZnRlciBsb2FkOyBnaXZlIGNsaWVudC1zaWRlIHJlbmRlcmluZyBhIG1vbWVudCBiZWZvcmVcbiAgICAgIC8vIGludmVudG9yeWluZywgb3IgdGhlIGludmVudG9yeSByZWNvcmRzIGFuIGVtcHR5IHNoZWxsLlxuICAgICAgYXdhaXQgcGFnZS53YWl0Rm9yTG9hZFN0YXRlKFwibmV0d29ya2lkbGVcIiwgeyB0aW1lb3V0IH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0pO1xuXG4gICAgaWYgKG5hdmlnYXRlZCkge1xuICAgICAgc2F5KFwiaW52ZW50b3J5aW5nIHBhZ2UgY29udHJvbHNcdTIwMjZcIik7XG4gICAgICBvdXRjb21lLmludmVudG9yeSA9IGF3YWl0IHN0ZXAob3V0Y29tZSwgXCJpbnNwZWN0XCIsICgpID0+IGluc3BlY3RQYWdlKHBhZ2UpKTtcblxuICAgICAgaWYgKG91dGNvbWUuaW52ZW50b3J5KSB7XG4gICAgICAgIHNheShcImV4cGFuZGluZyBsaXN0Ym94IGNvbnRyb2xzXHUyMDI2XCIpO1xuICAgICAgICBvdXRjb21lLmludmVudG9yeSA9IGF3YWl0IHN0ZXAob3V0Y29tZSwgXCJleHBhbmQtbGlzdGJveGVzXCIsICgpID0+XG4gICAgICAgICAgZXhwYW5kTGlzdGJveGVzKHBhZ2UsIG91dGNvbWUuaW52ZW50b3J5ISksXG4gICAgICAgICkgPz8gb3V0Y29tZS5pbnZlbnRvcnk7XG4gICAgICB9XG5cbiAgICAgIHNheShcImFuYWx5c2luZyBKYXZhU2NyaXB0IGJ1bmRsZXNcdTIwMjZcIik7XG4gICAgICBhd2FpdCBzdGVwKG91dGNvbWUsIFwiYnVuZGxlc1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGZldGNoVGV4dCA9IGFzeW5jICh1cmw6IHN0cmluZykgPT4ge1xuICAgICAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGNvbnRleHQucmVxdWVzdC5nZXQodXJsLCB7IHRpbWVvdXQgfSk7XG4gICAgICAgICAgcmV0dXJuIHsgc3RhdHVzOiByZXMuc3RhdHVzKCksIGJvZHk6IGF3YWl0IHJlcy50ZXh0KCkgfTtcbiAgICAgICAgfTtcbiAgICAgICAgY29uc3Qgc2NyaXB0cyA9IChvdXRjb21lLmludmVudG9yeT8uc2NyaXB0cyA/PyBbXSkuc2xpY2UoMCwgMjUpO1xuICAgICAgICBmb3IgKGNvbnN0IHVybCBvZiBzY3JpcHRzKSB7XG4gICAgICAgICAgb3V0Y29tZS5idW5kbGVzLnB1c2goYXdhaXQgYW5hbHl6ZUJ1bmRsZSh1cmwsIGZldGNoVGV4dCkpO1xuICAgICAgICB9XG4gICAgICAgIG91dGNvbWUucHJvY2Vzc2luZyA9IGNsYXNzaWZ5UHJvY2Vzc2luZyhvdXRjb21lLmJ1bmRsZXMpO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0pO1xuXG4gICAgICBzYXkoXCJ1cGxvYWRpbmcgdGhlIHRlc3QgaW1hZ2VcdTIwMjZcIik7XG4gICAgICBjb25zdCB1cGxvYWRlZCA9IGF3YWl0IHN0ZXAob3V0Y29tZSwgXCJ1cGxvYWRcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBzZWxlY3RvciA9IG91dGNvbWUuaW52ZW50b3J5Py5maWxlSW5wdXRzWzBdO1xuICAgICAgICBpZiAoIXNlbGVjdG9yKSB0aHJvdyBuZXcgRXJyb3IoXCJubyA8aW5wdXQgdHlwZT1maWxlPiBmb3VuZCBvbiB0aGUgcGFnZVwiKTtcbiAgICAgICAgYXdhaXQgcGFnZS5zZXRJbnB1dEZpbGVzKHNlbGVjdG9yLCB7XG4gICAgICAgICAgbmFtZTogXCJ0ZXN0LnBuZ1wiLCBtaW1lVHlwZTogXCJpbWFnZS9wbmdcIiwgYnVmZmVyOiBvcHRpb25zLnRlc3RJbWFnZSxcbiAgICAgICAgfSk7XG4gICAgICAgIGF3YWl0IHBhZ2Uud2FpdEZvclRpbWVvdXQoMjUwMCk7XG4gICAgICAgIHJldHVybiBzZWxlY3RvcjtcbiAgICAgIH0pO1xuXG4gICAgICBpZiAodXBsb2FkZWQpIHtcbiAgICAgICAgc2F5KFwicmUtaW52ZW50b3J5aW5nIGFmdGVyIHVwbG9hZFx1MjAyNlwiKTtcbiAgICAgICAgb3V0Y29tZS5pbnZlbnRvcnlBZnRlclVwbG9hZCA9IGF3YWl0IHN0ZXAob3V0Y29tZSwgXCJpbnNwZWN0LWFmdGVyLXVwbG9hZFwiLCBhc3luYyAoKSA9PiB7XG4gICAgICAgICAgLy8gU3R5bGUgdGlsZXMgdmlydHVhbGlzZSBcdTIwMTQgc2Nyb2xsIHRoZSBvdXRwdXQgZ3JpZCBzbyBtb3JlIGdlbl9idG5fKlxuICAgICAgICAgIC8vIGNoaXBzIGVudGVyIHRoZSBET00gYmVmb3JlIHdlIGludmVudG9yeSBhbmltYXRpb25zLlxuICAgICAgICAgIGF3YWl0IHBhZ2UuZXZhbHVhdGUoYXN5bmMgKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgdyA9IGdsb2JhbFRoaXMgYXMgdW5rbm93biBhcyBCcm93c2VyV2luZG93O1xuICAgICAgICAgICAgY29uc3QgZ3JpZCA9IHcuZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIltkYXRhLW91dHB1dC1ncmlkXVwiKTtcbiAgICAgICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNDA7IGkrKykge1xuICAgICAgICAgICAgICBpZiAoZ3JpZCkge1xuICAgICAgICAgICAgICAgIChncmlkIGFzIERvbUVsZW1lbnQgJiB7IHNjcm9sbFRvcDogbnVtYmVyOyBzY3JvbGxIZWlnaHQ6IG51bWJlciB9KS5zY3JvbGxUb3AgPVxuICAgICAgICAgICAgICAgICAgKGdyaWQgYXMgRG9tRWxlbWVudCAmIHsgc2Nyb2xsSGVpZ2h0OiBudW1iZXIgfSkuc2Nyb2xsSGVpZ2h0O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIHcuc2Nyb2xsQnk/LigwLCA4MDApO1xuICAgICAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZShyID0+IHNldFRpbWVvdXQociwgMTIwKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIGF3YWl0IHBhZ2Uud2FpdEZvclRpbWVvdXQoMjAwMCk7XG4gICAgICAgICAgY29uc3QgaW52ID0gYXdhaXQgaW5zcGVjdFBhZ2UocGFnZSk7XG4gICAgICAgICAgcmV0dXJuIGV4cGFuZExpc3Rib3hlcyhwYWdlLCBpbnYpO1xuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgc2F5KFwidHJpZ2dlcmluZyBnZW5lcmF0aW9uXHUyMDI2XCIpO1xuICAgICAgYXdhaXQgc3RlcChvdXRjb21lLCBcImdlbmVyYXRlXCIsIGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3Qgc291cmNlID0gb3V0Y29tZS5pbnZlbnRvcnlBZnRlclVwbG9hZCA/PyBvdXRjb21lLmludmVudG9yeTtcbiAgICAgICAgaWYgKCFzb3VyY2UpIHRocm93IG5ldyBFcnJvcihcIm5vIGludmVudG9yeSB0byBwaWNrIGEgZ2VuZXJhdGUgY29udHJvbCBmcm9tXCIpO1xuICAgICAgICBjb25zdCB7IGdlbmVyYXRlIH0gPSBwaWNrQWN0aW9uU2VsZWN0b3JzKHNvdXJjZSk7XG4gICAgICAgIGlmICghZ2VuZXJhdGUpIHtcbiAgICAgICAgICAvLyBNYWtlRW1vamkgKGFuZCBzaW1pbGFyIGxpdmUgZWRpdG9ycykgcmVuZGVyIGFzIHNvb24gYXMgYW4gaW1hZ2UgaXNcbiAgICAgICAgICAvLyB1cGxvYWRlZCBcdTIwMTQgbm8gZ2VuZXJhdGUgY29udHJvbCBpcyBhIG5vcm1hbCBmaW5kaW5nLCBub3QgYSBmYWlsdXJlLlxuICAgICAgICAgIHNheShcIm5vIGdlbmVyYXRlIGNvbnRyb2wgKGVkaXRvciBtYXkgcmVuZGVyIGxpdmUpXCIpO1xuICAgICAgICAgIC8vIFdhaXQgZm9yIGNsaWVudC1zaWRlIGVuY29kaW5nIHRvIHBvcHVsYXRlIGdlbmVyYXRlZCBwcmV2aWV3cy5cbiAgICAgICAgICBhd2FpdCBwYWdlLndhaXRGb3JGdW5jdGlvbigoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB3ID0gZ2xvYmFsVGhpcyBhcyB1bmtub3duIGFzIEJyb3dzZXJXaW5kb3c7XG4gICAgICAgICAgICByZXR1cm4gQXJyYXkuZnJvbShcbiAgICAgICAgICAgICAgdy5kb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKFwiaW1nXCIpIGFzIEFycmF5TGlrZTxEb21FbGVtZW50PixcbiAgICAgICAgICAgICkuc29tZShlbCA9PiAvZ2VuZXJhdGVkL2kudGVzdChlbC5nZXRBdHRyaWJ1dGUoXCJhbHRcIikgfHwgXCJcIikpO1xuICAgICAgICAgIH0sIHsgdGltZW91dCB9KS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgYXdhaXQgcGFnZS53YWl0Rm9yVGltZW91dCgxNTAwKTtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBwYWdlLmNsaWNrKGdlbmVyYXRlLCB7IHRpbWVvdXQgfSk7XG4gICAgICAgIGF3YWl0IHBhZ2Uud2FpdEZvclRpbWVvdXQoMzAwMCk7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSk7XG5cbiAgICAgIHNheShcInJldHJpZXZpbmcgdGhlIGdlbmVyYXRlZCBmaWxlXHUyMDI2XCIpO1xuICAgICAgYXdhaXQgc3RlcChvdXRjb21lLCBcInJldHJpZXZlXCIsIGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3Qgc291cmNlID0gb3V0Y29tZS5pbnZlbnRvcnlBZnRlclVwbG9hZCA/PyBvdXRjb21lLmludmVudG9yeTtcbiAgICAgICAgY29uc3QgeyBkb3dubG9hZCB9ID0gc291cmNlID8gcGlja0FjdGlvblNlbGVjdG9ycyhzb3VyY2UpIDogeyBkb3dubG9hZDogbnVsbCB9O1xuXG4gICAgICAgIC8vIFByZWZlcnJlZDogYSByZWFsIGRvd25sb2FkLCB3aGljaCBnaXZlcyB0aGUgZXhhY3QgYnl0ZXMgdGhlIHNpdGVcbiAgICAgICAgLy8gaW50ZW5kcyB0aGUgdXNlciB0byByZWNlaXZlLlxuICAgICAgICBpZiAoZG93bmxvYWQpIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3QgZG93bmxvYWRQcm9taXNlOiBQcm9taXNlPERvd25sb2FkPiA9IHBhZ2Uud2FpdEZvckV2ZW50KFwiZG93bmxvYWRcIiwge1xuICAgICAgICAgICAgICB0aW1lb3V0OiBNYXRoLm1pbig4XzAwMCwgdGltZW91dCksXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIGF3YWl0IHBhZ2UuY2xpY2soZG93bmxvYWQsIHsgdGltZW91dDogTWF0aC5taW4oNV8wMDAsIHRpbWVvdXQpIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICAgIGNvbnN0IGRsID0gYXdhaXQgZG93bmxvYWRQcm9taXNlO1xuICAgICAgICAgICAgY29uc3Qgc3RyZWFtID0gYXdhaXQgZGwuY3JlYXRlUmVhZFN0cmVhbSgpO1xuICAgICAgICAgICAgY29uc3QgY2h1bmtzOiBCdWZmZXJbXSA9IFtdO1xuICAgICAgICAgICAgZm9yIGF3YWl0IChjb25zdCBjaHVuayBvZiBzdHJlYW0pIGNodW5rcy5wdXNoKGNodW5rIGFzIEJ1ZmZlcik7XG4gICAgICAgICAgICByZXN1bHRCdWZmZXIgPSBCdWZmZXIuY29uY2F0KGNodW5rcyk7XG4gICAgICAgICAgICBvdXRjb21lLnJlc3VsdCA9IHtcbiAgICAgICAgICAgICAgb2J0YWluZWQ6IHRydWUsIHZpYTogXCJkb3dubG9hZFwiLCB1cmw6IHJlZGFjdGVkRG93bmxvYWRVcmwoZGwpLFxuICAgICAgICAgICAgICBieXRlczogcmVzdWx0QnVmZmVyLmxlbmd0aCwgY29udGVudFR5cGU6IHNuaWZmQ29udGVudFR5cGUocmVzdWx0QnVmZmVyKSxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8vIEZhbGwgdGhyb3VnaCB0byBwcmV2aWV3IHNjcmFwZSBcdTIwMTQgTWFrZUVtb2ppJ3MgWklQIGJ1dHRvbnMgYW5kXG4gICAgICAgICAgICAvLyBjYXJkLW1lbnUgZG93bmxvYWRzIG9mdGVuIGRvbid0IGZpcmUgYSB0b3AtbGV2ZWwgZG93bmxvYWQgZXZlbnRcbiAgICAgICAgICAgIC8vIGZyb20gdGhlIHNlbGVjdG9yIGRpc2NvdmVyeSBndWVzc2VkLlxuICAgICAgICAgICAgc2F5KFwiZG93bmxvYWQgY29udHJvbCBkaWQgbm90IHlpZWxkIGEgZmlsZTsgdHJ5aW5nIHByZXZpZXdcdTIwMjZcIik7XG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gU2NyYXBlIGEgZ2VuZXJhdGVkIHByZXZpZXcuIFJlcXVpcmUgYmxvYjovZGF0YTogb3IgYW4gYWx0IHRoYXQgc2F5c1xuICAgICAgICAvLyBcImdlbmVyYXRlZFwiIFx1MjAxNCBuZXZlciBhY2NlcHQgb3JkaW5hcnkgcGFnZSBhc3NldHMgKGxvZ29zLCB0aHVtYm5haWxzKS5cbiAgICAgICAgY29uc3QgcHJldmlld1NyYyA9IGF3YWl0IHBhZ2UuZXZhbHVhdGUoKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHcgPSBnbG9iYWxUaGlzIGFzIHVua25vd24gYXMgQnJvd3NlcldpbmRvdztcbiAgICAgICAgICBjb25zdCBub2RlcyA9IEFycmF5LmZyb20oXG4gICAgICAgICAgICB3LmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoXCJpbWcsIHZpZGVvLCBzb3VyY2VcIikgYXMgQXJyYXlMaWtlPERvbUVsZW1lbnQ+LFxuICAgICAgICAgICk7XG4gICAgICAgICAgY29uc3Qgc2NvcmVkID0gbm9kZXNcbiAgICAgICAgICAgIC5tYXAoZWwgPT4ge1xuICAgICAgICAgICAgICBjb25zdCBtZWRpYSA9IGVsIGFzIERvbU1lZGlhO1xuICAgICAgICAgICAgICBjb25zdCBzcmMgPSBtZWRpYS5zcmMgfHwgZWwuZ2V0QXR0cmlidXRlKFwic3JjXCIpIHx8IFwiXCI7XG4gICAgICAgICAgICAgIGNvbnN0IGFsdCA9IChlbC5nZXRBdHRyaWJ1dGUoXCJhbHRcIikgfHwgXCJcIikudG9Mb3dlckNhc2UoKTtcbiAgICAgICAgICAgICAgY29uc3QgaXNCbG9iID0gc3JjLnN0YXJ0c1dpdGgoXCJibG9iOlwiKSB8fCBzcmMuc3RhcnRzV2l0aChcImRhdGE6XCIpO1xuICAgICAgICAgICAgICBjb25zdCBnZW5lcmF0ZWQgPSAvZ2VuZXJhdGVkLy50ZXN0KGFsdCk7XG4gICAgICAgICAgICAgIGlmICghaXNCbG9iICYmICFnZW5lcmF0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICAgICAgICBpZiAoIWlzQmxvYiAmJiAvXmh0dHBzPzovaS50ZXN0KHNyYykpIHJldHVybiBudWxsO1xuICAgICAgICAgICAgICBjb25zdCBzY29yZSA9IChnZW5lcmF0ZWQgPyA0IDogMCkgKyAoaXNCbG9iID8gMiA6IDApXG4gICAgICAgICAgICAgICAgKyAoL2FuaW1hdGVkIGVtb2ppfHN0YXRpYyBlbW9qaS8udGVzdChhbHQpID8gMSA6IDApO1xuICAgICAgICAgICAgICByZXR1cm4geyBzcmMsIHNjb3JlIH07XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLmZpbHRlcigoeCk6IHggaXMgeyBzcmM6IHN0cmluZzsgc2NvcmU6IG51bWJlciB9ID0+IHggIT09IG51bGwpXG4gICAgICAgICAgICAuc29ydCgoYSwgYikgPT4gYS5zY29yZSAtIGIuc2NvcmUpO1xuICAgICAgICAgIHJldHVybiBzY29yZWRbc2NvcmVkLmxlbmd0aCAtIDFdPy5zcmMgPz8gbnVsbDtcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghcHJldmlld1NyYykgdGhyb3cgbmV3IEVycm9yKFwibm8gcHJldmlldyBpbWFnZS9ibG9iIGZvdW5kIGFmdGVyIGdlbmVyYXRpbmdcIik7XG5cbiAgICAgICAgcmVzdWx0QnVmZmVyID0gYXdhaXQgcmVhZFByZXZpZXcocGFnZSwgcHJldmlld1NyYyk7XG4gICAgICAgIG91dGNvbWUucmVzdWx0ID0ge1xuICAgICAgICAgIG9idGFpbmVkOiB0cnVlLCB2aWE6IFwicHJldmlldy1zcmNcIixcbiAgICAgICAgICB1cmw6IHByZXZpZXdTcmMuc3RhcnRzV2l0aChcImRhdGE6XCIpID8gXCIoZGF0YTogdXJpKVwiXG4gICAgICAgICAgICA6IHByZXZpZXdTcmMuc3RhcnRzV2l0aChcImJsb2I6XCIpID8gXCIoaW4tcGFnZSBibG9iKVwiXG4gICAgICAgICAgICA6IHByZXZpZXdTcmMsXG4gICAgICAgICAgYnl0ZXM6IHJlc3VsdEJ1ZmZlci5sZW5ndGgsIGNvbnRlbnRUeXBlOiBzbmlmZkNvbnRlbnRUeXBlKHJlc3VsdEJ1ZmZlciksXG4gICAgICAgIH07XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmVjb3JkZXIuc3RvcCgpO1xuICAgIG91dGNvbWUuZXhjaGFuZ2VzID0gcmVjb3JkZXIuZXhjaGFuZ2VzO1xuICAgIG91dGNvbWUud2Vic29ja2V0cyA9IHJlY29yZGVyLndlYnNvY2tldHM7XG4gICAgb3V0Y29tZS5jYW5kaWRhdGVzID0gc2hvcnRsaXN0Q2FuZGlkYXRlcyhyZWNvcmRlci5leGNoYW5nZXMpO1xuXG4gICAgYXdhaXQgY29udGV4dC5jbG9zZSgpO1xuICB9IGZpbmFsbHkge1xuICAgIC8vIEEgbGVha2VkIENocm9taXVtIG9uIGEgYm90IGhvc3QgaXMgYSBzbG93IHJlc291cmNlIGxlYWssIHNvIHRoZSBicm93c2VyIGlzXG4gICAgLy8gY2xvc2VkIGV2ZW4gd2hlbiBkaXNjb3ZlcnkgZmFpbHMgcGFydHdheS5cbiAgICBhd2FpdCBicm93c2VyPy5jbG9zZSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBhc3NlbWJsZSB0aGUgbWFuaWZlc3QgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGludmVudG9yeSA9IG91dGNvbWUuaW52ZW50b3J5QWZ0ZXJVcGxvYWQgPz8gb3V0Y29tZS5pbnZlbnRvcnk7XG4gIGlmIChpbnZlbnRvcnkpIHtcbiAgICBjb25zdCBhY3Rpb25zID0gcGlja0FjdGlvblNlbGVjdG9ycyhpbnZlbnRvcnkpO1xuICAgIG91dGNvbWUubWFuaWZlc3QuY29udHJvbHMgPSBidWlsZENvbnRyb2xzKGludmVudG9yeSk7XG4gICAgLy8gUHJlZmVyIGEgc3RhYmxlIGZpbGUtaW5wdXQgc2VsZWN0b3Igd2hlbiB0aGUgcGFnZSBoYXMgZXhhY3RseSBvbmUgXHUyMDE0XG4gICAgLy8gTWFrZUVtb2ppJ3MgZGVlcCBudGgtb2YtdHlwZSBwYXRoIGJyZWFrcyBvbiBtaW5vciBET00gY2h1cm4uXG4gICAgY29uc3QgZmlsZUlucHV0ID0gaW52ZW50b3J5LmZpbGVJbnB1dHMubGVuZ3RoID09PSAxXG4gICAgICA/IFwiaW5wdXRbdHlwZT1maWxlXVwiXG4gICAgICA6IChpbnZlbnRvcnkuZmlsZUlucHV0c1swXSA/PyBudWxsKTtcbiAgICBjb25zdCBoYXNHZW5lcmF0ZWRQcmV2aWV3ID0gb3V0Y29tZS5yZXN1bHQudmlhID09PSBcInByZXZpZXctc3JjXCI7XG4gICAgb3V0Y29tZS5tYW5pZmVzdC5icm93c2VyID0ge1xuICAgICAgcmVhZHlTZWxlY3RvcjogZmlsZUlucHV0LFxuICAgICAgZmlsZUlucHV0U2VsZWN0b3I6IGZpbGVJbnB1dCxcbiAgICAgIGdlbmVyYXRlU2VsZWN0b3I6IGFjdGlvbnMuZ2VuZXJhdGUsXG4gICAgICByZXN1bHRTZWxlY3RvcjogaGFzR2VuZXJhdGVkUHJldmlld1xuICAgICAgICA/ICdpbWdbYWx0Kj1cImdlbmVyYXRlZFwiIGldJ1xuICAgICAgICA6IG51bGwsXG4gICAgICBkb3dubG9hZFNlbGVjdG9yOiBvdXRjb21lLnJlc3VsdC52aWEgPT09IFwiZG93bmxvYWRcIiA/IGFjdGlvbnMuZG93bmxvYWQgOiBudWxsLFxuICAgICAgZGlzbWlzc1NlbGVjdG9yczogW10sXG4gICAgfTtcbiAgfVxuXG4gIC8vIFRoZSB2ZXJkaWN0IHRoYXQgYWNjb3VudHMgZm9yIHdoYXQgdGhlIHJ1biBhY3R1YWxseSBvYnNlcnZlZCwgbm90IGp1c3QgdGhlXG4gIC8vIGJ1bmRsZSBzaWduYXR1cmVzIFx1MjAxNCBzbyB0aGUgQ0xJIHN1bW1hcnksIHRoZSBtYW5pZmVzdCBub3RlcyBhbmQgdGhlIHJlcG9ydFxuICAvLyBhbGwgc3RhdGUgdGhlIHNhbWUgY29uY2x1c2lvbi5cbiAgb3V0Y29tZS52ZXJkaWN0ID0gdmVyZGljdEZvcihcbiAgICBvdXRjb21lLFxuICAgIG91dGNvbWUuY2FuZGlkYXRlcy5maWx0ZXIoeCA9PiB4Lm1ldGhvZCAhPT0gXCJHRVRcIiAmJiB4LnBvc3REYXRhICE9PSBudWxsKSxcbiAgKS52ZXJkaWN0O1xuXG4gIC8vIGB2ZXJpZmllZGAgaXMgdGhlIGdhdGUgdGhlIHByb3ZpZGVyIGNoZWNrcywgc28gaXQgaXMgc2V0IE9OTFkgd2hlbiB0aGUgcnVuXG4gIC8vIHByb3ZlZCB0aGUgdHdvIHRoaW5ncyBhIGdlbmVyYXRpb24gYWN0dWFsbHkgbmVlZHM6IHNvbWV3aGVyZSB0byBwdXQgdGhlXG4gIC8vIGltYWdlLCBhbmQgYSB2b2NhYnVsYXJ5IG9mIGFuaW1hdGlvbnMgdG8gY2hvb3NlIGZyb20uXG4gIGNvbnN0IGhhc0ZpbGVJbnB1dCA9IG91dGNvbWUubWFuaWZlc3QuYnJvd3Nlci5maWxlSW5wdXRTZWxlY3RvciAhPT0gbnVsbDtcbiAgY29uc3QgaGFzQW5pbWF0aW9ucyA9IChvdXRjb21lLm1hbmlmZXN0LmNvbnRyb2xzLmFuaW1hdGlvbj8udmFsdWVzLmxlbmd0aCA/PyAwKSA+IDA7XG4gIG91dGNvbWUubWFuaWZlc3QudmVyaWZpZWQgPSBoYXNGaWxlSW5wdXQgJiYgaGFzQW5pbWF0aW9ucztcbiAgb3V0Y29tZS5tYW5pZmVzdC5ub3RlcyA9IFtcbiAgICBgRGlzY292ZXJlZCAke291dGNvbWUuc3RhcnRlZEF0fS5gLFxuICAgIGBQcm9jZXNzaW5nIHZlcmRpY3Q6ICR7b3V0Y29tZS52ZXJkaWN0fS5gLFxuICAgIGBSZXN1bHQgb2J0YWluZWQ6ICR7b3V0Y29tZS5yZXN1bHQub2J0YWluZWQgPyBvdXRjb21lLnJlc3VsdC52aWEgOiBcIm5vXCJ9LmAsXG4gICAgaGFzRmlsZUlucHV0ID8gXCJcIiA6IFwiTk8gRklMRSBJTlBVVCBGT1VORCBcdTIwMTQgYnJvd3NlciBwcm92aWRlciBjYW5ub3QgcnVuLlwiLFxuICAgIGhhc0FuaW1hdGlvbnMgPyBcIlwiIDogXCJOTyBBTklNQVRJT04gVkFMVUVTIEZPVU5EIFx1MjAxNCBjaGVjayB0aGUgcmVwb3J0J3MgY29udHJvbCBpbnZlbnRvcnkgYW5kIGZpbGwgY29udHJvbHMuYW5pbWF0aW9uIGJ5IGhhbmQuXCIsXG4gICAgXCJhcGkgc3RheXMgbnVsbCB1bnRpbCBhIGdlbmVyYXRpb24gcmVxdWVzdCBpcyBjb25maXJtZWQgZnJvbSB0aGUgcmVjb3JkZWQgdHJhZmZpYzsgc2VlIHJlcG9ydC5tZC5cIixcbiAgXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcIik7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIHdyaXRlIHRoZSBhcnRlZmFjdHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIHdyaXRlRmlsZVN5bmMoam9pbihvdXRwdXREaXIsIFwibmV0d29yay5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShcbiAgICB7IHNpdGVVcmwsIHN0YXJ0ZWRBdDogb3V0Y29tZS5zdGFydGVkQXQsIHdlYnNvY2tldHM6IG91dGNvbWUud2Vic29ja2V0cywgZXhjaGFuZ2VzOiBvdXRjb21lLmV4Y2hhbmdlcyB9LFxuICAgIG51bGwsIDIsXG4gICkpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4ob3V0cHV0RGlyLCBcInJlbGV2YW50LXJlcXVlc3RzLmpzb25cIiksIEpTT04uc3RyaW5naWZ5KG91dGNvbWUuY2FuZGlkYXRlcywgbnVsbCwgMikpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4ob3V0cHV0RGlyLCBcImludmVudG9yeS5qc29uXCIpLCBKU09OLnN0cmluZ2lmeShcbiAgICB7IGJlZm9yZTogb3V0Y29tZS5pbnZlbnRvcnksIGFmdGVyVXBsb2FkOiBvdXRjb21lLmludmVudG9yeUFmdGVyVXBsb2FkIH0sIG51bGwsIDIsXG4gICkpO1xuICB3cml0ZUZpbGVTeW5jKGpvaW4ob3V0cHV0RGlyLCBcImJ1bmRsZXMuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkob3V0Y29tZS5idW5kbGVzLCBudWxsLCAyKSk7XG4gIHdyaXRlRmlsZVN5bmMoam9pbihvdXRwdXREaXIsIFwibWFuaWZlc3QuanNvblwiKSwgSlNPTi5zdHJpbmdpZnkob3V0Y29tZS5tYW5pZmVzdCwgbnVsbCwgMikpO1xuICBpZiAocmVzdWx0QnVmZmVyKSB7XG4gICAgd3JpdGVGaWxlU3luYyhqb2luKG91dHB1dERpciwgXCJyZXNwb25zZXNcIiwgYHJlc3VsdCR7ZXh0ZW5zaW9uRm9yKG91dGNvbWUucmVzdWx0LmNvbnRlbnRUeXBlKX1gKSwgcmVzdWx0QnVmZmVyKTtcbiAgfVxuICB3cml0ZUZpbGVTeW5jKGpvaW4ob3V0cHV0RGlyLCBcInJlcG9ydC5tZFwiKSwgYnVpbGRSZXBvcnQob3V0Y29tZSkpO1xuXG4gIHNheShgd3JvdGUgJHtvdXRwdXREaXJ9L3JlcG9ydC5tZGApO1xuICByZXR1cm4gb3V0Y29tZTtcbn1cblxuLyoqXG4gKiBBIHNhZmUsIHJlYWRhYmxlIGxhYmVsIGZvciBhIGRvd25sb2FkJ3Mgc291cmNlLlxuICpcbiAqIEEgYGJsb2I6YCBVUkwgcGFyc2VzIG9kZGx5IFx1MjAxNCBpdHMgXCJwYXRobmFtZVwiIGlzIHRoZSB3aG9sZSBpbm5lciBVUkwgXHUyMDE0IHNvXG4gKiBjb25jYXRlbmF0aW5nIG9yaWdpbiBhbmQgcGF0aG5hbWUgcHJvZHVjZWQgYSBkb3VibGVkLCBub25zZW5zZSBzdHJpbmcuIEJsb2JcbiAqIGFuZCBkYXRhIFVSTHMgY2Fycnkgbm8gdXNlZnVsIG9yaWdpbiBhbnl3YXksIHNvIHRoZXkgYXJlIG5hbWVkIGFzIHdoYXQgdGhleVxuICogYXJlOyBvcmRpbmFyeSBVUkxzIGFyZSB0cmltbWVkIHRvIG9yaWdpbiArIHBhdGggYmVjYXVzZSBkb3dubG9hZCBsaW5rc1xuICogcm91dGluZWx5IGNhcnJ5IHNpZ25lZCBxdWVyeSBwYXJhbWV0ZXJzLlxuICovXG5mdW5jdGlvbiByZWRhY3RlZERvd25sb2FkVXJsKGRvd25sb2FkOiBEb3dubG9hZCk6IHN0cmluZyB7XG4gIHJldHVybiBkZXNjcmliZURvd25sb2FkVXJsKGRvd25sb2FkLnVybCgpKTtcbn1cblxuZnVuY3Rpb24gZGVzY3JpYmVEb3dubG9hZFVybChyYXc6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChyYXcuc3RhcnRzV2l0aChcImJsb2I6XCIpKSByZXR1cm4gXCIoaW4tcGFnZSBibG9iKVwiO1xuICBpZiAocmF3LnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgcmV0dXJuIFwiKGRhdGE6IHVyaSlcIjtcbiAgdHJ5IHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJhdyk7XG4gICAgcmV0dXJuIGAke3VybC5vcmlnaW59JHt1cmwucGF0aG5hbWV9YDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFwiKHVua25vd24pXCI7XG4gIH1cbn1cblxuZnVuY3Rpb24gZXh0ZW5zaW9uRm9yKGNvbnRlbnRUeXBlOiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgaWYgKCFjb250ZW50VHlwZSkgcmV0dXJuIFwiLmJpblwiO1xuICBpZiAoL2dpZi9pLnRlc3QoY29udGVudFR5cGUpKSByZXR1cm4gXCIuZ2lmXCI7XG4gIGlmICgvd2VicC9pLnRlc3QoY29udGVudFR5cGUpKSByZXR1cm4gXCIud2VicFwiO1xuICBpZiAoL3BuZy9pLnRlc3QoY29udGVudFR5cGUpKSByZXR1cm4gXCIucG5nXCI7XG4gIHJldHVybiBcIi5iaW5cIjtcbn1cblxuLyoqIEJlc3QtZWZmb3J0IGNvbnRlbnQgdHlwZSBmcm9tIG1hZ2ljIGJ5dGVzIHdoZW4gdGhlIHNpdGUgZ2F2ZSB1cyBhIGJsb2IuICovXG5mdW5jdGlvbiBzbmlmZkNvbnRlbnRUeXBlKGJ1ZmZlcjogQnVmZmVyKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChidWZmZXIubGVuZ3RoID49IDYgJiYgYnVmZmVyLnN1YmFycmF5KDAsIDMpLnRvU3RyaW5nKFwiYXNjaWlcIikgPT09IFwiR0lGXCIpIHtcbiAgICByZXR1cm4gXCJpbWFnZS9naWZcIjtcbiAgfVxuICBpZiAoXG4gICAgYnVmZmVyLmxlbmd0aCA+PSA4ICYmXG4gICAgYnVmZmVyWzBdID09PSAweDg5ICYmIGJ1ZmZlclsxXSA9PT0gMHg1MCAmJiBidWZmZXJbMl0gPT09IDB4NGUgJiYgYnVmZmVyWzNdID09PSAweDQ3XG4gICkge1xuICAgIHJldHVybiBcImltYWdlL3BuZ1wiO1xuICB9XG4gIGlmIChcbiAgICBidWZmZXIubGVuZ3RoID49IDEyICYmXG4gICAgYnVmZmVyLnN1YmFycmF5KDAsIDQpLnRvU3RyaW5nKFwiYXNjaWlcIikgPT09IFwiUklGRlwiICYmXG4gICAgYnVmZmVyLnN1YmFycmF5KDgsIDEyKS50b1N0cmluZyhcImFzY2lpXCIpID09PSBcIldFQlBcIlxuICApIHtcbiAgICByZXR1cm4gXCJpbWFnZS93ZWJwXCI7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogUmVhZCBhIHByZXZpZXcncyBieXRlcywgd2hldGhlciBpdCBpcyBhIGJsb2I6LCBkYXRhOiBvciBvcmRpbmFyeSBVUkwuXG4gKlxuICogVGhlIHJlYWQgaGFwcGVucyBJTlNJREUgdGhlIHBhZ2U6IGEgYGJsb2I6YCBVUkwgaXMgc2NvcGVkIHRvIGl0cyBkb2N1bWVudCBhbmRcbiAqIG1lYW5zIG5vdGhpbmcgdG8gTm9kZSwgc28gZmV0Y2hpbmcgaXQgaGVyZSBpcyB0aGUgb25seSB3YXkgdG8gZ2V0IHRoZSBieXRlcy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVhZFByZXZpZXcocGFnZTogUGFnZSwgc3JjOiBzdHJpbmcpOiBQcm9taXNlPEJ1ZmZlcj4ge1xuICBjb25zdCBiYXNlNjQgPSBhd2FpdCBwYWdlLmV2YWx1YXRlKGFzeW5jICh1cmw6IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IHcgPSBnbG9iYWxUaGlzIGFzIHVua25vd24gYXMgQnJvd3NlcldpbmRvdztcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IHcuZmV0Y2godXJsKTtcbiAgICBjb25zdCBibG9iID0gYXdhaXQgcmVzcG9uc2UuYmxvYigpO1xuICAgIHJldHVybiBhd2FpdCBuZXcgUHJvbWlzZTxzdHJpbmc+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHJlYWRlciA9IG5ldyB3LkZpbGVSZWFkZXIoKTtcbiAgICAgIHJlYWRlci5vbmxvYWRlbmQgPSAoKSA9PiByZXNvbHZlKFN0cmluZyhyZWFkZXIucmVzdWx0KS5zcGxpdChcIixcIilbMV0gPz8gXCJcIik7XG4gICAgICByZWFkZXIub25lcnJvciA9ICgpID0+IHJlamVjdChuZXcgRXJyb3IoXCJjb3VsZCBub3QgcmVhZCB0aGUgcHJldmlldyBibG9iXCIpKTtcbiAgICAgIHJlYWRlci5yZWFkQXNEYXRhVVJMKGJsb2IpO1xuICAgIH0pO1xuICB9LCBzcmMpO1xuICByZXR1cm4gQnVmZmVyLmZyb20oYmFzZTY0LCBcImJhc2U2NFwiKTtcbn1cblxuZXhwb3J0IHsgT1BUSU9OX0tFWVMsIGlzQmluYXJ5Q29udGVudFR5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
