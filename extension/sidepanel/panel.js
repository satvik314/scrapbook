// Scrapbook side panel logic.
// State lives in chrome.storage.local; the panel renders from it and listens
// for changes so clips captured in any tab drop straight into the tray.

const $ = (id) => document.getElementById(id);

const el = {
  newClipBtn: $("newClipBtn"),
  trayError: $("trayError"),
  trayEmpty: $("trayEmpty"),
  clipGrid: $("clipGrid"),
  selectHint: $("selectHint"),
  aspectGroup: $("aspectGroup"),
  bgGroup: $("bgGroup"),
  punchline: $("punchlineInput"),
  tagline: $("taglineInput"),
  person: $("personCheck"),
  cheap: $("cheapCheck"),
  promptFold: $("promptFold"),
  promptText: $("promptText"),
  promptReset: $("promptReset"),
  customBadge: $("customBadge"),
  makeBtn: $("makeBtn"),
  makeNote: $("makeNote"),
  keyNote: $("keyNote"),
  darkroom: $("darkroom"),
  printWindow: $("printWindow"),
  printing: $("printing"),
  posterImg: $("posterImg"),
  printCaption: $("printCaption"),
  genError: $("genError"),
  downloadBtn: $("downloadBtn"),
  regenBtn: $("regenBtn"),
  historySection: $("historySection"),
  historyStrip: $("historyStrip"),
  shortcutHint: $("shortcutHint")
};

const MAX_PICKS = 5;
const DEFAULT_TAGLINE = "unrot 2.0 — coming soon";

const state = {
  clips: [],
  posters: [],
  picked: [], // clip ids, in stacking order
  aspect: "1:1",
  bg: "purple",
  promptCustom: false,
  currentPoster: null,
  lastPayload: null,
  generating: false,
  knownClipIds: new Set()
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

init();

async function init() {
  if (!navigator.platform.toLowerCase().includes("mac")) {
    el.shortcutHint.textContent = "Ctrl+Shift+S";
  }

  const store = await chrome.storage.local.get([
    "scrapbook_clips",
    "scrapbook_posters",
    "scrapbook_settings",
    "scrapbook_last_error"
  ]);
  showTrayError(store.scrapbook_last_error);
  state.clips = store.scrapbook_clips || [];
  state.posters = store.scrapbook_posters || [];
  state.knownClipIds = new Set(state.clips.map((c) => c.id));

  const s = store.scrapbook_settings || {};
  state.aspect = s.aspect || "1:1";
  state.bg = s.bg || "purple";
  el.tagline.value = s.tagline != null ? s.tagline : DEFAULT_TAGLINE;
  el.punchline.value = s.punchline || "";
  el.person.checked = !!s.person;
  el.cheap.checked = !!s.cheap;

  syncChips();
  renderTray();
  renderHistory();
  if (state.posters.length) showPoster(state.posters[0], { animate: false });
  refreshPrompt();

  chrome.runtime.sendMessage({ type: "get-status" }, (res) => {
    if (!chrome.runtime.lastError && res) el.keyNote.hidden = !!res.hasKey;
  });

  chrome.storage.onChanged.addListener(onStorageChanged);
  wireEvents();
}

function onStorageChanged(changes, area) {
  if (area !== "local") return;
  if (changes.scrapbook_clips) {
    state.clips = changes.scrapbook_clips.newValue || [];
    state.picked = state.picked.filter((id) => state.clips.some((c) => c.id === id));
    renderTray();
    refreshPrompt();
  }
  if (changes.scrapbook_posters) {
    state.posters = changes.scrapbook_posters.newValue || [];
    renderHistory();
  }
  if (changes.scrapbook_last_error) {
    showTrayError(changes.scrapbook_last_error.newValue);
  }
}

function showTrayError(err) {
  // only surface reasonably fresh failures — a stale note from last week
  // shouldn't greet you on open
  const fresh = err && err.message && Date.now() - (err.ts || 0) < 10 * 60 * 1000;
  el.trayError.textContent = fresh ? err.message : "";
  el.trayError.hidden = !fresh;
}

function saveSettings() {
  chrome.storage.local.set({
    scrapbook_settings: {
      aspect: state.aspect,
      bg: state.bg,
      tagline: el.tagline.value,
      punchline: el.punchline.value,
      person: el.person.checked,
      cheap: el.cheap.checked
    }
  });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function renderTray() {
  el.trayEmpty.hidden = state.clips.length > 0;
  el.selectHint.hidden = state.clips.length === 0;
  el.clipGrid.replaceChildren();

  for (const clip of state.clips) {
    const scrap = document.createElement("div");
    scrap.className = "scrap";
    scrap.dataset.id = clip.id;
    scrap.title = clip.title || clip.sourceUrl;
    if (!state.knownClipIds.has(clip.id)) {
      scrap.classList.add("is-new");
      state.knownClipIds.add(clip.id);
    }

    const img = document.createElement("img");
    img.src = clip.thumbUrl || clip.dataUrl;
    img.alt = clip.title || "clip";
    scrap.appendChild(img);

    const meta = document.createElement("div");
    meta.className = "meta";
    const domain = document.createElement("span");
    domain.className = "domain";
    domain.textContent = domainOf(clip.sourceUrl);
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = timeAgo(clip.ts);
    meta.append(domain, when);
    scrap.appendChild(meta);

    const pickIdx = state.picked.indexOf(clip.id);
    if (pickIdx >= 0) {
      scrap.classList.add("is-selected");
      const badge = document.createElement("span");
      badge.className = "pick-badge";
      badge.textContent = String(pickIdx + 1);
      scrap.appendChild(badge);
    }

    const del = document.createElement("button");
    del.className = "scrap-del";
    del.title = "Remove this clip";
    del.textContent = "✕";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteClip(clip.id);
    });
    scrap.appendChild(del);

    scrap.addEventListener("click", () => togglePick(clip.id));
    el.clipGrid.appendChild(scrap);
  }
}

function togglePick(id) {
  const idx = state.picked.indexOf(id);
  if (idx >= 0) {
    state.picked.splice(idx, 1);
  } else {
    if (state.picked.length >= MAX_PICKS) {
      note(`five scraps is the limit — unpick one first`);
      return;
    }
    state.picked.push(id);
  }
  note("");
  renderTray();
  refreshPrompt();
}

function deleteClip(id) {
  const clips = state.clips.filter((c) => c.id !== id);
  chrome.storage.local.set({ scrapbook_clips: clips });
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "somewhere";
  }
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

function composePrompt() {
  const n = state.picked.length;
  const aspectPhrase = state.aspect === "16:9" ? "16:9 landscape" : "1:1 square";
  const purple = state.bg === "purple";
  const hook = el.punchline.value.trim();
  const tagline = el.tagline.value.trim();
  const clipPhrase =
    n <= 1
      ? "the attached clipped screenshot, presented cleanly — as if it's a real UI element: a screenshot, a report card, a notification, a chart"
      : `the ${n} attached clipped screenshots, stacked as slightly overlapping, subtly tilted white cards — the chaos is the design`;

  const lines = [
    `Create a ${aspectPhrase} social post.`,
    `Background: solid ${purple ? "#9D7FFF purple" : "white #FFFFFF"}.`,
    `Center: a white card (rounded corners, subtle shadow) occupying ~35–50% of the canvas, containing ${clipPhrase}.`,
    hook
      ? `Below or beside the card, one punchline line: '${hook}' — ${purple ? "white text" : "black or #9D7FFF text"}.`
      : `No headline text beyond what the card itself contains.`,
    tagline ? `Bottom: a small tagline line in the accent color: '${tagline}'.` : null,
    `Generous negative space — the rest of the canvas is breathing room.`,
    el.person.checked
      ? `Add a line-art person (thick black #262626 outlines, white fill, no facial features, rounded body) reacting to the card.`
      : null,
    `Flat, minimal, deadpan. The data is the punchline. No gradients, no 3D, no clutter.`,
    `Use the attached image${n > 1 ? "s" : ""} exactly as provided — reproduce ${n > 1 ? "their" : "its"} content faithfully, do not redraw, invent, or alter what ${n > 1 ? "they show" : "it shows"}.`
  ];
  return lines.filter(Boolean).join(" ");
}

function refreshPrompt() {
  if (state.promptCustom) return;
  el.promptText.value = composePrompt();
}

function markCustom(custom) {
  state.promptCustom = custom;
  el.customBadge.hidden = !custom;
  el.promptReset.hidden = !custom;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

async function makePoster(payload) {
  if (state.generating) return;
  state.generating = true;
  state.lastPayload = payload;

  el.genError.hidden = true;
  el.darkroom.hidden = false;
  el.posterImg.removeAttribute("src");
  el.printCaption.textContent = "";
  el.printing.hidden = false;
  el.printing.classList.toggle("wide", payload.aspect === "16:9");
  el.makeBtn.disabled = true;
  el.regenBtn.disabled = true;
  el.makeBtn.classList.add("is-stamping");
  el.darkroom.scrollIntoView({ behavior: "smooth", block: "nearest" });

  chrome.runtime.sendMessage({ type: "generate-poster", payload }, (res) => {
    state.generating = false;
    el.makeBtn.disabled = false;
    el.regenBtn.disabled = false;
    el.makeBtn.classList.remove("is-stamping");
    el.printing.hidden = true;

    if (chrome.runtime.lastError || !res) {
      showGenError("The service worker went quiet — try again.");
      return;
    }
    if (!res.ok) {
      showGenError(res.error || "Something went wrong.");
      return;
    }
    showPoster(res.poster, { animate: true });
  });
}

function showGenError(message) {
  el.genError.textContent = message;
  el.genError.hidden = false;
  el.darkroom.hidden = false;
  // put the previous print back behind the error note
  if (state.currentPoster) {
    el.posterImg.src = state.currentPoster.dataUrl;
    el.printCaption.textContent = captionFor(state.currentPoster);
  }
  el.downloadBtn.disabled = !state.currentPoster;
}

function showPoster(poster, { animate }) {
  state.currentPoster = poster;
  el.darkroom.hidden = false;
  el.printing.hidden = true;
  el.genError.hidden = true;
  el.posterImg.src = poster.dataUrl;
  el.downloadBtn.disabled = false;
  el.printCaption.textContent = captionFor(poster);
  el.printWindow.classList.remove("is-printing-out");
  if (animate) {
    // restart the print-out animation
    void el.printWindow.offsetWidth;
    el.printWindow.classList.add("is-printing-out");
  }
  renderHistory();
}

function captionFor(poster) {
  const d = new Date(poster.ts);
  const model = /lite/.test(poster.model || "") ? "draft" : "full";
  return `${poster.aspect} · ${model} · ${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function renderHistory() {
  el.historySection.hidden = state.posters.length === 0;
  el.historyStrip.replaceChildren();
  for (const poster of state.posters) {
    const b = document.createElement("button");
    b.className = "h-print";
    b.title = captionFor(poster);
    if (state.currentPoster && state.currentPoster.id === poster.id) b.classList.add("is-active");
    const img = document.createElement("img");
    img.src = poster.dataUrl;
    img.alt = "poster";
    b.appendChild(img);
    b.addEventListener("click", () => showPoster(poster, { animate: false }));
    el.historyStrip.appendChild(b);
  }
}

function note(text) {
  el.makeNote.textContent = text;
  el.makeNote.hidden = !text;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function wireEvents() {
  el.newClipBtn.addEventListener("click", () => {
    el.trayError.hidden = true;
    chrome.runtime.sendMessage({ type: "start-capture" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && !res.ok && res.error) {
        el.trayError.textContent = res.error;
        el.trayError.hidden = false;
      }
    });
  });

  el.aspectGroup.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state.aspect = chip.dataset.aspect;
    syncChips();
    saveSettings();
    refreshPrompt();
  });

  el.bgGroup.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state.bg = chip.dataset.bg;
    syncChips();
    saveSettings();
    refreshPrompt();
  });

  for (const input of [el.punchline, el.tagline]) {
    input.addEventListener("input", () => {
      saveSettings();
      refreshPrompt();
    });
  }
  for (const check of [el.person, el.cheap]) {
    check.addEventListener("change", () => {
      saveSettings();
      refreshPrompt();
    });
  }

  el.promptText.addEventListener("input", () => markCustom(true));
  el.promptReset.addEventListener("click", () => {
    markCustom(false);
    refreshPrompt();
  });

  el.makeBtn.addEventListener("click", () => {
    if (!state.picked.length) {
      note("pick at least one scrap from the tray first");
      el.clipGrid.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    note("");
    el.makeBtn.classList.remove("did-stamp");
    void el.makeBtn.offsetWidth;
    el.makeBtn.classList.add("did-stamp");
    makePoster({
      prompt: el.promptText.value.trim() || composePrompt(),
      clipIds: [...state.picked],
      aspect: state.aspect,
      cheap: el.cheap.checked
    });
  });

  el.regenBtn.addEventListener("click", () => {
    const payload = state.lastPayload || (state.currentPoster && {
      prompt: state.currentPoster.prompt,
      clipIds: state.currentPoster.clipIds || [],
      aspect: state.currentPoster.aspect,
      cheap: /lite/.test(state.currentPoster.model || "")
    });
    if (payload) makePoster(payload);
  });

  el.downloadBtn.addEventListener("click", () => {
    if (!state.currentPoster) return;
    const a = document.createElement("a");
    const d = new Date(state.currentPoster.ts);
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    a.href = state.currentPoster.dataUrl;
    a.download = `scrapbook-poster-${stamp}.png`;
    a.click();
  });
}

function syncChips() {
  for (const chip of el.aspectGroup.querySelectorAll(".chip")) {
    const on = chip.dataset.aspect === state.aspect;
    chip.classList.toggle("is-on", on);
    chip.setAttribute("aria-checked", String(on));
  }
  for (const chip of el.bgGroup.querySelectorAll(".chip")) {
    const on = chip.dataset.bg === state.bg;
    chip.classList.toggle("is-on", on);
    chip.setAttribute("aria-checked", String(on));
  }
}
