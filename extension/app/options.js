// Defaults come from defaults.js (shared with the popup so the two pages can't
// drift). options.js only touches keys that have an element here — popup-only
// keys (subFormat, langsTouched) are read/written by the popup alone.
const el = (id) => document.getElementById(id);

// The subtitles block (auto-generated captions, languages, convert, embed) only
// means something with subtitles on, so it stays hidden until "Download
// subtitles by default" is ticked — matching the popup's subtitles block.
// options.css re-asserts `[hidden]` for it, since the block's own author
// `display` rule would otherwise beat the UA's `[hidden]` rule.
function updateSubsVisibility() {
  el("subsOpts").hidden = !el("subsOn").checked;
}

async function load() {
  const s = await chrome.storage.local.get(null);
  for (const k of Object.keys(DEFAULTS)) {
    const e = el(k);
    if (!e) continue;
    const v = s[k] !== undefined ? s[k] : DEFAULTS[k];
    e.value = v;
    if (e.type === "checkbox") e.checked = v;
    // The decorated dropdown label re-syncs on a change event (its option list
    // is static, so the MutationObserver never fires for a .value set).
    if (e.tagName === "SELECT") e.dispatchEvent(new Event("change", { bubbles: true }));
  }
  updateSubsVisibility();
}

function save() {
  for (const k of Object.keys(DEFAULTS)) {
    const e = el(k);
    if (!e) continue;
    chrome.storage.local.set({ [k]: e.type === "checkbox" ? e.checked : e.value });
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await load();
});

// options page can't rely on popup's imports; ping via bg
chrome.runtime.sendMessage({ action: "ping" })
  .then((r) => {
    el("hostStatus").textContent = r && r.ok
      ? `native host OK · yt-dlp ${r.ytdlp ? "✓" : "✗"} · ffmpeg ${r.ffmpeg ? "✓" : "✗"}`
      : "native host NOT detected; run install.sh and restart the browser";
  })
  .catch(() => {
    el("hostStatus").textContent = "extension background unavailable";
  });

el("save").addEventListener("click", () => {
  save();
  el("saved").textContent = "Saved";
  setTimeout(() => (el("saved").textContent = ""), 1500);
});

el("subsOn").addEventListener("change", updateSubsVisibility);

el("reset").addEventListener("click", async () => {
  for (const k of Object.keys(DEFAULTS)) {
    const e = el(k);
    if (!e) continue;
    e.value = DEFAULTS[k];
    if (e.type === "checkbox") e.checked = DEFAULTS[k];
    if (e.tagName === "SELECT") e.dispatchEvent(new Event("change", { bubbles: true }));
  }
  updateSubsVisibility();
  save();
});
