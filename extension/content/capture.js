// Scrapbook — region capture overlay, injected on demand by the service
// worker. Draws a dashed "pen frame" selection; on release the overlay is
// removed *before* the screenshot so it never appears in the clip.
(() => {
  if (window.__scrapbookCaptureActive) return;
  window.__scrapbookCaptureActive = true;

  const root = document.createElement("div");
  root.className = "scrapbook-cap-root";

  const dim = document.createElement("div");
  dim.className = "scrapbook-cap-dim";

  const hint = document.createElement("div");
  hint.className = "scrapbook-cap-hint";
  hint.innerHTML = 'drag to clip a region&nbsp; <span class="scrapbook-cap-kbd">esc</span>&nbsp;to cancel';

  const frame = document.createElement("div");
  frame.className = "scrapbook-cap-frame";
  for (const pos of ["tl", "tr", "bl", "br"]) {
    const c = document.createElement("div");
    c.className = "scrapbook-cap-corner " + pos;
    frame.appendChild(c);
  }
  const sizeTag = document.createElement("div");
  sizeTag.className = "scrapbook-cap-size";
  frame.appendChild(sizeTag);

  root.appendChild(dim);
  root.appendChild(hint);
  root.appendChild(frame);
  document.documentElement.appendChild(root);

  let startX = 0, startY = 0, dragging = false;

  function rectFrom(e) {
    const x = Math.min(startX, e.clientX);
    const y = Math.min(startY, e.clientY);
    const w = Math.abs(e.clientX - startX);
    const h = Math.abs(e.clientY - startY);
    return { x, y, w, h };
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    hint.style.display = "none";
    dim.style.opacity = "0"; // the frame's box-shadow takes over the dimming
    frame.style.display = "block";
    updateFrame(rectFrom(e));
  }

  function onMouseMove(e) {
    if (!dragging) return;
    e.preventDefault();
    updateFrame(rectFrom(e));
  }

  function updateFrame(r) {
    frame.style.left = r.x + "px";
    frame.style.top = r.y + "px";
    frame.style.width = r.w + "px";
    frame.style.height = r.h + "px";
    sizeTag.textContent = `${r.w} × ${r.h}`;
    // keep the size tag on-screen when selecting near the bottom edge
    sizeTag.style.bottom = r.y + r.h + 34 > window.innerHeight ? "6px" : "-30px";
  }

  function onMouseUp(e) {
    if (!dragging) return;
    e.preventDefault();
    const rect = rectFrom(e);
    cleanup();
    if (rect.w < 8 || rect.h < 8) return; // treat as an accidental click
    // Wait two frames so the overlay is definitely gone from the paint
    // before the worker calls captureVisibleTab.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chrome.runtime.sendMessage(
          {
            type: "region-selected",
            rect,
            vw: window.innerWidth,
            vh: window.innerHeight
          },
          (res) => {
            if (chrome.runtime.lastError) {
              showToast("Scrapbook couldn't hear back from Chrome — reload the extension and try again.", true);
            } else if (res && res.ok) {
              showToast("Clipped to Scrapbook ✓", false);
            } else {
              showToast((res && res.error) || "Capture failed — check the Scrapbook panel.", true);
            }
          }
        );
      });
    });
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  }

  function cleanup() {
    dragging = false;
    window.__scrapbookCaptureActive = false;
    root.remove();
    window.removeEventListener("keydown", onKeyDown, true);
  }

  function showToast(text, isError) {
    const toast = document.createElement("div");
    toast.className = "scrapbook-cap-toast" + (isError ? " scrapbook-cap-error" : "");
    toast.textContent = text;
    document.documentElement.appendChild(toast);
    const life = isError ? 4200 : 1100;
    setTimeout(() => toast.classList.add("scrapbook-cap-fade"), life);
    setTimeout(() => toast.remove(), life + 400);
  }

  root.addEventListener("mousedown", onMouseDown, true);
  root.addEventListener("mousemove", onMouseMove, true);
  root.addEventListener("mouseup", onMouseUp, true);
  window.addEventListener("keydown", onKeyDown, true);
})();
