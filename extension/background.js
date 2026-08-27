// Scrapbook — MV3 service worker.
// Classic (non-module) worker so env.js can be optional: importScripts throws
// if the file is missing and we catch it instead of killing the worker.

try {
  importScripts("env.js");
} catch (e) {
  // No env.js yet — capture still works; poster generation will ask for a key.
}

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODELS = {
  standard: "gemini-3.1-flash-image", // Nano Banana 2
  lite: "gemini-3.1-flash-lite-image" // Nano Banana 2 Lite (cheap mode)
};

const MAX_CLIPS = 12;
const MAX_POSTERS = 5;

// ---------------------------------------------------------------------------
// Capture entry points (all listeners registered at top level — MV3 rule)
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "capture-region") startCapture(tab);
});

chrome.action.onClicked.addListener((tab) => {
  startCapture(tab);
});

function isInjectable(tab) {
  if (!tab || !tab.id || !tab.url) return false;
  return /^(https?|file):/.test(tab.url);
}

async function startCapture(tab) {
  if (!tab) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = active;
  }
  if (!isInjectable(tab)) {
    flashBadge("✕", "#B3402A");
    return;
  }
  // Must be called while the user gesture is still "fresh" — before any long
  // async work — or Chrome rejects sidePanel.open().
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    // Older Chrome or gesture expired — capture still proceeds.
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content/capture.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/capture.js"] });
  } catch (e) {
    flashBadge("✕", "#B3402A");
  }
}

function flashBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1600);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "region-selected") {
    handleRegion(msg, sender)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // async response
  }
  if (msg && msg.type === "start-capture") {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([tab]) => {
      if (!isInjectable(tab)) {
        sendResponse({ ok: false, error: "This page can't be clipped (Chrome pages and the Web Store are off-limits). Switch to a normal tab first." });
        return;
      }
      startCapture(tab).then(() => sendResponse({ ok: true }));
    });
    return true;
  }
  if (msg && msg.type === "get-status") {
    sendResponse({ hasKey: !!getApiKey() });
    return false;
  }
  if (msg && msg.type === "generate-poster") {
    generatePoster(msg.payload)
      .then((poster) => sendResponse({ ok: true, poster }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Region capture → crop → tray
// ---------------------------------------------------------------------------

async function handleRegion(msg, sender) {
  const tab = sender.tab;
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });

  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  // captureVisibleTab returns device pixels; map CSS-px rect via actual ratio
  // (covers devicePixelRatio *and* page zoom).
  const scaleX = bitmap.width / msg.vw;
  const scaleY = bitmap.height / msg.vh;
  const sx = Math.max(0, Math.round(msg.rect.x * scaleX));
  const sy = Math.max(0, Math.round(msg.rect.y * scaleY));
  const sw = Math.min(bitmap.width - sx, Math.round(msg.rect.w * scaleX));
  const sh = Math.min(bitmap.height - sy, Math.round(msg.rect.h * scaleY));
  if (sw < 4 || sh < 4) throw new Error("Selection too small");

  const canvas = new OffscreenCanvas(sw, sh);
  canvas.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const clipDataUrl = await canvasToDataUrl(canvas, "image/png");

  // Small thumbnail for the tray so rendering stays snappy.
  const thumbW = Math.min(360, sw);
  const thumbH = Math.round(sh * (thumbW / sw));
  const thumbCanvas = new OffscreenCanvas(thumbW, thumbH);
  const tctx = thumbCanvas.getContext("2d");
  tctx.imageSmoothingQuality = "high";
  tctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, thumbW, thumbH);
  const thumbUrl = await canvasToDataUrl(thumbCanvas, "image/jpeg", 0.85);
  bitmap.close();

  const clip = {
    id: "clip_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    dataUrl: clipDataUrl,
    thumbUrl,
    sourceUrl: tab.url || "",
    title: tab.title || "",
    ts: Date.now(),
    w: sw,
    h: sh
  };

  const { scrapbook_clips = [] } = await chrome.storage.local.get("scrapbook_clips");
  const clips = [clip, ...scrapbook_clips].slice(0, MAX_CLIPS);
  await setWithQuotaFallback({ scrapbook_clips: clips });
  flashBadge("✓", "#5A8F5E");
}

async function canvasToDataUrl(canvas, type, quality) {
  const blob = await canvas.convertToBlob({ type, quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // No FileReader in service workers — base64 by hand, chunked to keep the
  // argument list under engine limits.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

// chrome.storage.local caps at ~10 MB without unlimitedStorage; if a write
// trips the quota, shed the oldest clips/posters and retry once.
async function setWithQuotaFallback(items) {
  try {
    await chrome.storage.local.set(items);
  } catch (e) {
    const store = await chrome.storage.local.get(["scrapbook_clips", "scrapbook_posters"]);
    const pruned = {
      scrapbook_clips: (items.scrapbook_clips || store.scrapbook_clips || []).slice(0, 5),
      scrapbook_posters: (items.scrapbook_posters || store.scrapbook_posters || []).slice(0, 2)
    };
    await chrome.storage.local.set(pruned);
  }
}

// ---------------------------------------------------------------------------
// Poster generation — Gemini Interactions API (Nano Banana 2)
// ---------------------------------------------------------------------------

function getApiKey() {
  const key = self.SCRAPBOOK_ENV && self.SCRAPBOOK_ENV.GEMINI_API_KEY;
  if (!key || /PASTE_YOUR/.test(key)) return null;
  return key;
}

async function generatePoster({ prompt, clipIds, aspect, cheap }) {
  const key = getApiKey();
  if (!key) {
    throw new Error("No API key found. Copy env.example.js to env.js inside the extension folder, paste your Gemini key, and reload the extension.");
  }
  const { scrapbook_clips = [] } = await chrome.storage.local.get("scrapbook_clips");
  const clips = clipIds
    .map((id) => scrapbook_clips.find((c) => c.id === id))
    .filter(Boolean);
  if (!clips.length) throw new Error("Pick at least one clip from the tray.");

  const input = [{ type: "text", text: prompt }];
  for (const clip of clips) {
    const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(clip.dataUrl);
    if (!m) continue;
    input.push({ type: "image", mime_type: m[1], data: m[2] });
  }

  const body = {
    model: cheap ? MODELS.lite : MODELS.standard,
    input,
    response_format: {
      type: "image",
      aspect_ratio: aspect === "16:9" ? "16:9" : "1:1",
      image_size: cheap ? "1K" : "2K"
    }
  };

  // A generation runs 10–30s and fetch alone doesn't reset the MV3 idle
  // timer — ping an extension API every 20s to keep the worker alive.
  const keepalive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  let json;
  try {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    json = await res.json().catch(() => null);
    if (!res.ok) {
      const apiMsg = json && json.error && json.error.message;
      throw new Error(apiMsg || `Gemini API returned ${res.status}`);
    }
  } finally {
    clearInterval(keepalive);
  }

  const image = extractImage(json);
  if (!image) throw new Error("The model returned no image — try Regenerate, or simplify the prompt.");

  const poster = {
    id: "poster_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    dataUrl: `data:${image.mime_type || "image/png"};base64,${image.data}`,
    ts: Date.now(),
    prompt,
    aspect,
    model: body.model,
    clipIds
  };

  const { scrapbook_posters = [] } = await chrome.storage.local.get("scrapbook_posters");
  await setWithQuotaFallback({ scrapbook_posters: [poster, ...scrapbook_posters].slice(0, MAX_POSTERS) });
  return poster;
}

// The Interactions API surfaces the image either as a top-level output_image
// or inside model_output steps — accept both shapes.
function extractImage(json) {
  if (!json) return null;
  if (json.output_image && json.output_image.data) return json.output_image;
  if (Array.isArray(json.steps)) {
    for (const step of json.steps) {
      if (step.type !== "model_output" || !Array.isArray(step.content)) continue;
      for (const block of step.content) {
        if (block.type === "image" && block.data) return block;
      }
    }
  }
  if (Array.isArray(json.output)) {
    for (const block of json.output) {
      if (block.type === "image" && block.data) return block;
    }
  }
  return null;
}
