function fmtBytes(n) {
  if (n == null || n <= 0) return "";
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/0+$/, "").replace(/\.$/, "") + " GB";
  if (n >= 1e6) return Math.round(n / 1e6) + " MB";
  return Math.max(1, Math.round(n / 1e3)) + " KB";
}

function fmtSizeStr(bytes, approx = true) {
  if (bytes == null) return "";
  return (approx ? "~" : "") + fmtBytes(bytes);
}

const SUB_FMT_WHITELIST = ["srt", "vtt", "ttml", "webvtt", "ass", "ssa", "sbv", "lrc"];
const SUB_FMT_LABEL = {
  srt: "SRT", vtt: "VTT", ttml: "TTML", webvtt: "WebVTT",
  ass: "ASS", ssa: "SSA", sbv: "SBV", lrc: "LRC",
};

const el = (id) => document.getElementById(id);

let prefs = { ...DEFAULTS };
let url = "";
let probeData = null;
let playlistTouched = false;
// Set once the user edits the URL field by hand, so the popup stops
// overwriting it from the tab's own navigations.
let urlTouched = false;
// True while the active download is SIGSTOP'd on the host; drives the
// Pause/Resume toggle label and the frozen "Paused" hint.
let pausedNow = false;
// Signature of the last queue render. Progress broadcasts arrive ~4x/s while a
// download runs and each one re-renders the (usually unchanged) waiting queue;
// skipping the DOM rebuild when the visible rows really didn't change keeps the
// popup idle instead of churning <li> nodes every 250ms.
let lastQueueSig = null;

function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e) }));
}

// A dead or stale MV3 service worker rejects every runtime.sendMessage with this
// exact Chrome text. Surface a reload hint instead of raw API noise; the fix is
// browser-side (reload from chrome://extensions), not code-side.
// theme.js (loaded before this file on popup.html) owns the single copy of the
// regex and message and exports them on window.
const SW_GONE_RE = window.SW_GONE_RE;
const SW_GONE_MSG =
  window.SW_GONE_DIAG ||
  "The extension's background worker isn't responding. Open chrome://extensions, reload Video Downloader Ultra, then try again.";
function swGone(message) {
  return SW_GONE_RE.test(String(message || ""));
}

function checkHost() {
  send({ action: "ping" }).then((r) => {
    const ok = !!(r && r.ok);
    const swGoneDiag = swGone(r && r.error) && window.SW_GONE_DIAG;
    const title = ok ? undefined : swGoneDiag || (r && r.error) || undefined;
    const kind = ok ? "ok" : swGoneDiag ? "reload" : "offline";
    if (window.setHostConn) window.setHostConn(kind, title);
    else el("hostDot").className = "dot " + (ok ? "on" : "off");
  });
}

function loadPrefs() {
  return chrome.storage.local.get(null).then((s) => {
    for (const k of Object.keys(DEFAULTS)) {
      if (s[k] !== undefined) prefs[k] = s[k];
    }
    el("subsOn").checked = prefs.subsOn;
    el("autoSubs").checked = prefs.auto;
    el("subFormat").value = prefs.subFormat;
    el("subFormat").disabled = true;
    el("convertSrt").checked = prefs.convertSrt;
    el("embed").checked = prefs.embed;
    el("playlist").checked = prefs.playlist;
    el("chapters").value = prefs.chapters;
    el("outDir").textContent = prefs.outDir;
  });
}

function savePrefs() {
  prefs.subsOn = el("subsOn").checked;
  prefs.auto = el("autoSubs").checked;
  if (el("langs").value) prefs.langs = el("langs").value;
  prefs.subFormat = el("subFormat").value;
  prefs.convertSrt = el("convertSrt").checked;
  prefs.embed = el("embed").checked;
  prefs.playlist = el("playlist").checked;
  prefs.chapters = el("chapters").value || "off";
  chrome.storage.local.set(prefs);
}

function plausibleVideoUrl(u) {
  return /^https?:\/\//i.test(u || "");
}

// Last probe result, keyed by the exact URL it was run against. Reopening the
// popup on the same page restores the options instantly instead of re-probing;
// the manual Probe button still always refetches.
const PROBE_CACHE_KEY = "lastProbe";

function saveProbeCache(sourceUrl, data) {
  return chrome.storage.session
    .set({ [PROBE_CACHE_KEY]: { url: sourceUrl, data } })
    .catch(() => {});
}

async function loadProbeCache() {
  try {
    const o = await chrome.storage.session.get(PROBE_CACHE_KEY);
    const entry = o[PROBE_CACHE_KEY];
    return entry && entry.url && entry.data ? entry : null;
  } catch (e) {
    return null;
  }
}

function probe() {
  const requestedUrl = el("url").value.trim();
  url = requestedUrl;
  setWarn(null);
  if (!plausibleVideoUrl(requestedUrl)) {
    el("probeArea").hidden = false;
    el("probeErr").hidden = false;
    el("probeErr").textContent = "Enter an http(s) video URL first.";
    return;
  }
  el("probeBtn").disabled = true;
  el("downloadBtn").disabled = true;
  el("probeErr").hidden = true;
  el("meta").textContent = "Probing…";
  el("meta").classList.add("probing");
  el("probeArea").hidden = false;

  send({ action: "probe", url: requestedUrl }).then((r) => {
    el("probeBtn").disabled = false;
    // Drop a stale reply: the field has moved on (new tab URL or a manual
    // edit), so this result belongs to a different page and must neither be
    // shown nor cached — otherwise it lands on the next video's row.
    if (el("url").value.trim() !== requestedUrl) return;
    if (!r || !r.ok) {
      el("probeErr").hidden = false;
      const err = (r && r.error) || "Probe failed";
      el("probeErr").textContent = swGone(err) ? SW_GONE_MSG : err;
      el("meta").classList.remove("probing");
      el("meta").textContent = "";
      // No result for this URL: drop any previous video's data so its options
      // can't be submitted against the new link.
      probeData = null;
      return;
    }
    saveProbeCache(requestedUrl, r);
    renderProbe(r, requestedUrl);
  });
}

function fmtOrder(a, b) {
  if ((a.height || 0) !== (b.height || 0)) return (b.height || 0) - (a.height || 0);
  const aio = a.vcodec && a.vcodec !== "none" ? 0 : 1;
  const bio = b.vcodec && b.vcodec !== "none" ? 0 : 1;
  if (aio !== bio) return aio - bio;
  return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
}

function codecRank(c) {
  const s = String(c || "").toLowerCase();
  if (s.startsWith("avc")) return 3;      // h264 / mp4: most compatible
  if (s.startsWith("vp09") || s.startsWith("vp9")) return 2;
  if (s.startsWith("av01")) return 1;     // av1: most efficient but least compatible
  return 0;
}

function pickVideo(top) {
  return top.slice().sort((a, b) =>
    ((b.acodec && b.acodec !== "none" ? 100 : 0) + codecRank(b.vcodec)) -
      ((a.acodec && a.acodec !== "none" ? 100 : 0) + codecRank(a.vcodec))
  )[0];
}

function pickAudio(list) {
  const fam = (f) => (String(f.acodec || "").toLowerCase().startsWith("mp4a") ? 0 : 1);
  const num = (f) => parseInt(String(f.id), 10) || 0;
  return list.slice().sort((a, b) => fam(a) - fam(b) || num(b) - num(a))[0];
}

function presetFormats() {
  const presets = [];
  const add = (id, label, opts = {}) =>
    presets.push({ id, label, preset: true, res: opts.res || "best", audioOnly: !!opts.audioOnly });
  add("preset-best", "Best");
  add("preset-2160", "2160p (4K)", { res: "2160" });
  add("preset-1440", "1440p", { res: "1440" });
  add("preset-1080", "1080p", { res: "1080" });
  add("preset-720", "720p", { res: "720" });
  add("preset-480", "480p", { res: "480" });
  add("preset-360", "360p", { res: "360" });
  add("preset-240", "240p", { res: "240" });
  add("preset-144", "144p", { res: "144" });
  add("preset-audio", "Audio only · MP3", { audioOnly: true });
  return presets;
}

function bestAudioSize() {
  const a = (probeData.formats || []).filter((x) => !x.vcodec || x.vcodec === "none");
  const best = a.length ? pickAudio(a) : null;
  return best && best.size ? best.size : 0;
}

function renderFormats() {
  const sel = el("formatSelect");
  sel.innerHTML = "";
  const all = probeData.formats || [];
  const formatHint = el("formatHint");

  if (!all.length) {
    if (probeData.meta && probeData.meta.is_playlist) {
      const presets = presetFormats();
      probeData.formats = presets;
      for (const p of presets) {
        const o = document.createElement("option");
        o.value = String(p.id);
        o.textContent = p.label;
        sel.appendChild(o);
      }
      sel.value = "preset-best";
      sel.disabled = false;
      updateSizeEstimate();
      formatHint.hidden = !probeData.meta.sample_error;
      formatHint.textContent = probeData.meta.sample_error
        ? "Couldn't reach the first video to read its resolutions; using presets."
        : "";
      return;
    }
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "No formats reported";
    sel.appendChild(o);
    sel.disabled = true;
    updateSizeEstimate();
    return;
  }

  const byHeight = new Map();
  const audioOnly = [];
  for (const f of all) {
    if (!f.vcodec || f.vcodec === "none") audioOnly.push(f);
    else {
      const h = f.height || 0;
      if (!byHeight.has(h)) byHeight.set(h, []);
      byHeight.get(h).push(f);
    }
  }

  const collapsed = [];
  for (const grp of byHeight.values()) collapsed.push(pickVideo(grp));
  collapsed.sort(fmtOrder); // non-audio first, big → small
  if (audioOnly.length) {
    // A preset rather than a specific audio format id: the host then uses the
    // best available audio track (`ba/b`) and transcodes it to MP3.
    collapsed.push({ id: "preset-audio", label: "Audio only · MP3",
                     preset: true, audioOnly: true, res: "best" });
  }

  probeData.formats = collapsed;

  const bonus = bestAudioSize();
  for (const f of collapsed) {
    const o = document.createElement("option");
    o.value = String(f.id);
    o.title = `id ${f.id}`;
    if (!f.vcodec || f.vcodec === "none") {
      o.textContent = f.preset ? f.label : "Audio only" + fmtSizeStr(f.size);
    } else {
      let label = f.height ? f.height + "p" : "Video";
      if (f.fps && f.fps > 30) label += " · " + Math.round(f.fps) + "fps";
      let sz = f.size;
      if (sz && (!f.acodec || f.acodec === "none")) sz += bonus;
      label += fmtSizeStr(sz);
      o.textContent = label;
    }
    sel.appendChild(o);
  }
  sel.disabled = false;

  const favored = collapsed.find((f) => f.vcodec && f.vcodec !== "none") || collapsed[0];
  sel.value = String(favored.id);

  formatHint.hidden = !(probeData.meta && probeData.meta.sample);
  formatHint.textContent = probeData.meta && probeData.meta.sample
    ? "Resolutions from the first video in the playlist: " + probeData.meta.sample
    : "";
  updateSizeEstimate();
}

function updateSizeEstimate() {
  const meta = probeData && probeData.meta;
  const row = el("sizeRow");
  const span = el("sizeEst");
  if (!meta || !row || !span) return;
  let bytes = null;
  const fmt = selectedFormat();
  if (fmt && (fmt.audioOnly || fmt.formatId)) {
    const f = (probeData.formats || []).find((x) => String(x.id) === String(fmt.formatId));
    if (f && f.size) {
      bytes = f.size;
      if (!fmt.audioOnly && (!f.acodec || f.acodec === "none")) bytes += bestAudioSize();
    }
  }
  if (bytes == null) {
    row.hidden = true;
    return;
  }
  const count = meta.is_playlist ? (meta.playlist_count || 0) : 1;
  let txt = fmtSizeStr(bytes);
  if (count > 1) txt += " × " + count + " videos";
  span.textContent = txt;
  row.hidden = false;
}

function renderSubFormats() {
  const sel = el("subFormat");
  const offered = (probeData.subFormats || []).filter((x) => SUB_FMT_WHITELIST.includes(x));
  const list = offered.length ? offered : ["srt", "vtt"];
  sel.innerHTML = "";
  for (const c of list) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = SUB_FMT_LABEL[c] || c.toUpperCase();
    sel.appendChild(o);
  }
  const def = list.includes(prefs.subFormat)
    ? prefs.subFormat
    : list.includes("srt") ? "srt" : list[0];
  sel.value = def;
  prefs.subFormat = sel.value;
  sel.disabled = false;
}

// The "All available (auto default)" option is an intent, not a language: with
// auto-captions on the host would otherwise emit every auto track in every
// language (`--write-auto-subs` with no `--sub-langs`). Resolve it to a single
// sensible track — English when offered, else the first offered.
function defaultAutoTrack() {
  const manual = Object.keys((probeData && probeData.subs) || {});
  const auto = Object.keys((probeData && probeData.autoSubs) || {});
  const offered = [...manual, ...auto.filter((c) => !manual.includes(c))];
  return offered.includes("en") ? "en" : (offered[0] || "all");
}

function renderLangs() {
  const sel = el("langs");
  const manual = Object.keys(probeData.subs || {});
  const auto = Object.keys(probeData.autoSubs || {});
  sel.innerHTML = "";

  const withAuto = el("autoSubs").checked;
  const entries = new Map();
  for (const c of manual) entries.set(c, { code: c, autoOnly: false });
  for (const c of auto) {
    if (!entries.has(c)) entries.set(c, { code: c, autoOnly: true });
  }

  const noSubs = entries.size === 0;
  el("subsOn").disabled = noSubs;
  el("langs").disabled = noSubs;
  el("subHint").hidden = !noSubs;
  el("subHint").textContent = noSubs ? "No subtitles are offered by this video" : "";
  updateSubsVisibility();
  if (noSubs) return;

  const isPlaylist = !!(probeData.meta && probeData.meta.is_playlist);
  const langOk = prefs.langs && (prefs.langs === "all" || entries.has(prefs.langs));
  let want;
  if (isPlaylist && prefs.langsTouched && langOk) {
    want = prefs.langs;
  } else if (isPlaylist) {
    want = "all";
  } else if (prefs.langs === "all") {
    // "all" is an explicit menu option ("every manual track"); honor the
    // choice instead of silently rewriting it to the first manual language.
    // With auto-captions on it means "the site's auto default", so resolve it
    // to one concrete track rather than every auto track in every language.
    want = withAuto ? defaultAutoTrack() : "all";
  } else {
    want = prefs.langs && !withAuto && !manual.includes(prefs.langs)
      ? (manual.length ? manual[0] : "all")
      : (prefs.langs && entries.has(prefs.langs) ? prefs.langs : (manual.includes("en") ? "en" : [...entries.keys()][0]));
  }
  prefs.langs = want === "all" ? "all" : (entries.has(want) ? want : [...entries.keys()][0]);

  const oAll = document.createElement("option");
  oAll.value = "all";
  oAll.textContent = withAuto ? "All available (auto default)" : "All available (subtitles)";
  sel.appendChild(oAll);

  const manualGroup = document.createElement("optgroup");
  manualGroup.label = "Subtitles";
  for (const c of manual) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    manualGroup.appendChild(o);
  }
  sel.appendChild(manualGroup);

  if (withAuto && auto.length) {
    const autoGroup = document.createElement("optgroup");
    autoGroup.label = "Auto-generated";
    for (const c of auto) {
      if (entries.get(c).autoOnly) {
        const o = document.createElement("option");
        o.value = c;
        o.textContent = c;
        autoGroup.appendChild(o);
      }
    }
    if (autoGroup.children.length) sel.appendChild(autoGroup);
  }

  sel.value = [...sel.options].some((o) => o.value === prefs.langs) ? prefs.langs : "all";
  renderSubFormats();
}

// Single owner of the subtitles block's visibility. It's gated on two things:
// the "Download subtitles" toggle being ticked, and the probed video actually
// offering a track (renderLangs() keeps #subsOn.disabled in sync with that, and
// leaves it false until a probe has landed). Both the toggle handler and
// renderLangs() come through here so the two conditions can't fight over
// `style.display` — and `hidden` only works because popup.css re-asserts the
// hide for `.subs-options[hidden]` (its author `display: flex` would otherwise
// beat the UA's `[hidden]` rule).
function updateSubsVisibility() {
  const offered = !!probeData && !el("subsOn").disabled;
  el("subsOpts").hidden = !el("subsOn").checked || !offered;
}

// The playlist control only exists for playlist links: a plain video URL has no
// playlist to download, so the box is hidden outright rather than left sitting
// there unchecked (buildSelection() then refuses to ship `playlist:true` for it,
// and no stray "Playlist" tag reaches a queue row). `prefs.playlist` stays the
// saved default — it seeds the box on the next playlist probe.
function updatePlaylistControl() {
  const isPlaylist = !!(probeData && probeData.meta && probeData.meta.is_playlist);
  el("playlistWrap").hidden = !isPlaylist;
  if (!isPlaylist) return;
  if (!playlistTouched) el("playlist").checked = true;
  prefs.playlist = el("playlist").checked;
}

const CHAPTER_CONTAINERS = ["mp4", "webm", "mkv"];

function chaptersControlState() {
  const meta = probeData && probeData.meta;
  const count = meta ? meta.chapterCount : null;
  const fmt = selectedFormat();
  if (!count || fmt.audioOnly) return { visible: false, enabled: false, reason: "" };
  let ok = true;
  let reason = "";
  const ext = (fmt.formatExt || "").toLowerCase();
  if (fmt.formatId && ext && !CHAPTER_CONTAINERS.includes(ext)) {
    ok = false;
    reason = `Chapters need MKV/MP4/WebM; this format is ${ext || "a container that can't hold them"}.`;
  }
  return { visible: true, enabled: ok, reason };
}

function updateChaptersControl() {
  const wrap = el("chaptersWrap");
  const sel = el("chapters");
  const hint = el("chaptersHint");
  const st = chaptersControlState();
  wrap.hidden = !st.visible;
  if (!st.visible) return;
  sel.disabled = !st.enabled;
  hint.hidden = !st.enabled;
  hint.textContent = st.reason && !st.enabled ? st.reason : "";
  sel.value = prefs.chapters || "off";
  // This select's option list is static, so the decorated label only re-syncs
  // on a change event (the MutationObserver can't see a programmatic .value
  // set); surface it so the visible choice matches the saved pref.
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  const label = wrap.querySelector(".field-label");
  if (label) label.textContent = `Video sections (${probeData.meta.chapterCount} chapters)`;
}

function renderProbe(r, sourceUrl) {
  // Work on a defensive copy: renderFormats() replaces probeData.formats in
  // place, and `r` may also be the very object handed to saveProbeCache() —
  // mutating it would leak the collapsed/preset list into the cache for a
  // future reopen (a playlist that fell back to presets would then reopen as
  // a single broken "Audio only" option).
  el("meta").classList.remove("probing");
  probeData = JSON.parse(JSON.stringify(r));
  // Bind this result to the exact URL it was probed for so the Download
  // button can refuse to ship an old video's selection against a new URL.
  probeData.sourceUrl = sourceUrl || "";
  const meta = probeData.meta || {};
  const tag = [];
  if (meta.is_playlist) tag.push("playlist" + (meta.playlist_count ? ` · ${meta.playlist_count}` : ""));
  if (meta.chapterCount) tag.push(meta.chapterCount + " chapters");
  if (meta.duration) tag.push(Math.round(meta.duration) + "s");
  if (meta.extractor) tag.push(meta.extractor);

  el("meta").innerHTML =
    `<b>${escapeHtml(meta.title || "Untitled")}</b>` +
    (tag.length ? `<span class="tag">${tag.map(escapeHtml).join(" · ")}</span>` : "");

  updatePlaylistControl();

  renderFormats();
  updateChaptersControl();
  renderLangs();
  el("opts").hidden = false;
  el("downloadBtn").disabled = false;
  el("probeArea").hidden = false;
  el("meta").style.display = "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function selectedFormat() {
  const id = el("formatSelect").value;
  const f = probeData.formats.find((x) => String(x.id) === id);
  if (!f) return { audioOnly: false, formatId: null, formatHasAudio: false, formatExt: null, resolution: null };
  if (f.preset) {
    return {
      audioOnly: f.audioOnly,
      formatId: null,
      formatHasAudio: false,
      formatExt: null,
      resolution: f.res || "best",
    };
  }
  if (!f.vcodec || f.vcodec === "none") {
    return { audioOnly: true, formatId: String(f.id), formatHasAudio: false, formatExt: f.ext || null, resolution: null };
  }
  return {
    audioOnly: false,
    formatId: String(f.id),
    formatHasAudio: !!(f.acodec && f.acodec !== "none"),
    formatExt: f.ext || null,
    resolution: null,
  };
}

function buildSelection() {
  savePrefs();
  const fmt = selectedFormat();
  const meta = probeData && probeData.meta;
  return {
    title: (meta && (meta.sample || meta.title)) || "",
    label: formatLabel(),
    audioOnly: fmt.audioOnly,
    audioFmt: "mp3",
    formatId: fmt.formatId,
    formatHasAudio: !!fmt.formatHasAudio,
    formatExt: fmt.formatExt,
    resolution: fmt.resolution,
    playlist: !el("playlistWrap").hidden && el("playlist").checked,
    chapters: (!el("chaptersWrap").hidden && !el("chapters").disabled) ? prefs.chapters : "off",
    subs: {
      on: prefs.subsOn && !el("subsOn").disabled,
      auto: prefs.auto,
      // Never ship "all" with auto-captions on: the host would then emit
      // `--write-auto-subs` with no `--sub-langs` and fetch every language.
      langs: (prefs.langs === "all" && prefs.auto)
        ? defaultAutoTrack()
        : (prefs.langs || "all"),
      subFormat: prefs.subFormat,
      convert: prefs.convertSrt ? "srt" : "best",
      embed: prefs.embed,
    },
    outputDir: prefs.outDir,
  };
}

function setProgress(p) {
  const fill = el("barFill");
  fill.style.width = (p ?? 0) + "%";
  el("pct").textContent = p != null ? Math.round(p) + "%" : "";
}

// Title of the job the bar describes. Every queue item carries the host's
// sanitized `selection.title`, so the queue head names the active video even
// when this popup didn't start it (a widget-started job, or one adopted after
// an extension reload). The probe's own title only covers the beat between
// clicking Download and the first queue broadcast — and only for the URL still
// in the field, so a probe of a *different* video can't mislabel the bar.
function activeJobTitle(snapshot) {
  const head = (snapshot.queue || [])[0];
  if (!head) return "";
  const echoed = head.selection && head.selection.title;
  if (echoed) return echoed;
  if (probeData && probeData.meta && head.url === url) return probeData.meta.title || "";
  return "";
}

function setProgressTitle(title) {
  const node = el("progressTitle");
  const text = String(title || "").trim();
  node.hidden = text === "";
  node.textContent = text;
  node.title = text;
}

function setWarn(msg) {
  el("warn").hidden = !msg;
  el("warn").textContent = msg || "";
}

function formatLabel() {
  const id = el("formatSelect").value;
  const f = (probeData.formats || []).find((x) => String(x.id) === id);
  if (!f) return "Best";
  if (f.preset) return f.label;
  if (!f.vcodec || f.vcodec === "none") return "Audio only";
  let label = f.height ? f.height + "p" : "Video";
  if (f.fps && f.fps > 30) label += " " + Math.round(f.fps) + "fps";
  return label;
}

function summarizeSelection(sel = {}) {
  const parts = [];
  if (sel.label) {
    parts.push(sel.label);
  } else if (sel.audioOnly) {
    parts.push("Audio");
  } else if (sel.formatId) {
    parts.push(sel.formatId + (sel.formatExt ? ` · ${sel.formatExt}` : ""));
  } else if (sel.resolution && sel.resolution !== "best") {
    parts.push(sel.resolution + "p");
  }
  if (sel.playlist) parts.push("Playlist");
  const chapters = sel.chapters;
  if (chapters === "embed") parts.push("chapters embed");
  else if (chapters === "split") parts.push("split chapters");
  const subs = sel.subs;
  if (subs && subs.on) {
    let tag = "subs";
    if (subs.embed) tag += " embed";
    if (subs.auto) tag += " auto";
    parts.push(tag);
  }
  return parts.join(" · ");
}

function renderQueue(queue) {
  const section = el("queueSection");
  const list = el("queueList");
  const waiting = (Array.isArray(queue) ? queue : []).filter((it) => it && it.status === "queued");
  const sig = waiting
    .map((it, i) => `${it.id}|${it.status}|${i}|${(it.selection && it.selection.title) || it.url || ""}`)
    .join("\n");
  const hidden = waiting.length === 0;
  if (sig === lastQueueSig && hidden === (section.hidden === true)) return;
  lastQueueSig = sig;
  section.hidden = hidden;
  list.textContent = "";
  waiting.forEach((it, i) => {
    const row = document.createElement("li");
    row.className = "qrow";

    const pos = document.createElement("span");
    pos.className = "qpos";
    pos.textContent = String(i + 1);

    const info = document.createElement("span");
    info.className = "qinfo";
    const title = document.createElement("span");
    title.className = "qtitle";
    title.textContent = (it.selection && it.selection.title) || it.url || "";
    title.title = title.textContent;
    const opts = document.createElement("span");
    opts.className = "qopts";
    opts.textContent = summarizeSelection(it.selection) || "queued";
    opts.title = opts.textContent;
    info.append(title, opts);

    const btns = document.createElement("span");
    btns.className = "qbtns";
    const move = (delta) => {
      const newIndex = i + delta;
      if (newIndex < 0 || newIndex >= waiting.length) return;
      send({ action: "reorder", queueId: it.id, newIndex });
    };
    const up = document.createElement("button");
    up.type = "button";
    up.className = "btn qbtn";
    up.textContent = "\u2191";
    up.title = "Move earlier";
    up.setAttribute("aria-label", "Move earlier");
    up.disabled = i === 0;
    up.addEventListener("click", () => move(-1));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "btn qbtn";
    down.textContent = "\u2193";
    down.title = "Move later";
    down.setAttribute("aria-label", "Move later");
    down.disabled = i === waiting.length - 1;
    down.addEventListener("click", () => move(1));
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "btn qbtn qbtn-rm";
    rm.textContent = "\u2715";
    rm.title = "Remove from queue";
    rm.setAttribute("aria-label", "Remove from queue");
    rm.addEventListener("click", () => send({ action: "cancel", queueId: it.id }));
    btns.append(up, down, rm);

    row.append(pos, info, btns);
    list.appendChild(row);
  });
}

// The Pause/Resume + Cancel row is bound to the *active job*: it appears with
// the progress bar and disappears with it, so a job that ended (done / error /
// cancelled, including one the queue snapshot reports as gone — a widget-side
// cancel) can't leave a stray Cancel button floating with no bar to explain it.
function setJobControls(active) {
  el("actionsRow").hidden = !active;
  el("pauseBtn").hidden = !active;
  el("cancelBtn").hidden = !active;
}

function onHostEvent(snapshot) {
  if (snapshot.status === "downloading") {
    el("opts").hidden = false;
    el("progress").hidden = false;
    setProgressTitle(activeJobTitle(snapshot));
    el("downloadBtn").hidden = false;
    el("downloadBtn").disabled = false;
    setJobControls(true);
    pausedNow = !!snapshot.paused;
    el("pauseBtn").textContent = pausedNow ? "Resume" : "Pause";
    setProgress(snapshot.pct ?? 0);
    const d = snapshot.downloaded, t = snapshot.total;
    el("dlSize").textContent = t != null
      ? fmtBytes(d != null ? d : 0) + " / ~" + fmtBytes(t)
      : (d != null ? fmtBytes(d) + " downloaded" : "");
    const speedParts = [];
    if (snapshot.speed) speedParts.push(`speed ${snapshot.speed}`);
    if (snapshot.eta) speedParts.push(`${snapshot.eta} left`);
    el("speed").textContent = speedParts.join(" · ");
    el("msg").textContent = snapshot.message || (pausedNow ? "Paused" : "");
  } else if (snapshot.status === "done") {
    el("progress").hidden = true;
    setProgressTitle("");
    el("dlSize").textContent = "";
    el("downloadBtn").hidden = false;
    el("downloadBtn").disabled = false;
    setJobControls(false);
    pausedNow = false;
    if (snapshot.message === "Cancelled") {
      setWarn(null);
      el("msg").textContent = (snapshot.items || []).length
        ? `Cancelled. ${snapshot.items.length} file(s) saved so far`
        : "Cancelled";
    } else {
      setWarn(snapshot.warn || null);
      el("msg").textContent =
        (snapshot.items || []).length
          ? `Saved ${snapshot.items.length} file(s)`
          : snapshot.message || "Finished";
    }
  } else if (snapshot.status === "error") {
    el("progress").hidden = true;
    setProgressTitle("");
    el("dlSize").textContent = "";
    el("downloadBtn").hidden = false;
    el("downloadBtn").disabled = false;
    setJobControls(false);
    pausedNow = false;
    setWarn(null);
    el("msg").textContent = "Error: " + (snapshot.message || "unknown");
  } else {
    setProgressTitle("");
    setJobControls(false);
    pausedNow = false;
  }
  renderQueue(snapshot.queue || []);
}

function startDownload() {
  url = el("url").value.trim();
  if (!url) return;
  if (!probeData || !probeData.meta) {
    setWarn("Detect a video URL first.");
    return;
  }
  // The field may have moved on since the last probe (manual edit sets
  // urlTouched, which stops the tab-follow auto-probe); re-detect instead of
  // silently shipping the previous video's title/format/subtitle selection
  // against the new URL.
  if (probeData.sourceUrl !== url) {
    setWarn("URL changed since Detect; re-detecting…");
    probe();
    return;
  }
  savePrefs();
  setWarn(null);
  send({ action: "download", url, selection: buildSelection() }).then((r) => {
    if (!r || !r.ok) {
      const err = (r && r.error) || "could not start";
      el("msg").textContent = "Error: " + (swGone(err) ? SW_GONE_MSG : err);
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadPrefs();
  // Honor a persisted playlist preference set in Options: otherwise every
  // reopen resets playlistTouched to false and renderProbe() overrides the
  // stored default (re-checking the box on playlists, unchecking on videos).
  playlistTouched = !!prefs.playlist;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  updateSubsVisibility();
  el("opts").hidden = true;
  if (tab && tab.url && tab.url.startsWith("http")) {
    el("url").value = tab.url;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "hostEvent") onHostEvent(msg.snapshot);
    return false;
  });

  checkHost();

  // Ask for host state first: a download already running (from a previous
  // popup session) must reopen as the live progress view, never a fresh probe
  // that wipes it. The queue list below it renders too, and the reopen keeps
  // going (cached probe / auto-probe) so adding more downloads stays possible
  // while the queue drains. A probe is safe while a download runs — it runs off
  // the host's main loop and never touches the progress view — so a new URL
  // always auto-detects, which is what lets a second video be lined up.
  const { state } = await send({ action: "getState" });
  if (state) onHostEvent(state);

  // The SW drops the native port when idle, so between popup opens it may have
  // missed broadcasts of a widget-started download. Force a reconnect + host
  // refresh so a running job reopens as the live progress view rather than the
  // cached idle snapshot (the getQueue hostEvent mirrors it down to us).
  send({ action: "getQueue" });

  const target = el("url").value.trim();
  if (!target) return;

  const cached = await loadProbeCache();
  if (cached && cached.url === target) {
    renderProbe(cached.data, cached.url);
  } else {
    probe();
  }

  // The tab can keep navigating while the popup is open (video sites are SPAs,
  // autoplay advances). Follow it so the field and the probe never stay stuck
  // on the link the popup happened to open with.
  if (tab && tab.id != null) {
    // SPA navigations can burst several onUpdated events in one tick (link
    // rewrites, redirect chains); each URL hop also passed through our own
    // assignment above. Debounce so we settle on the URL, not every stop.
    let followTimer = null;
    const onTabUpdated = (id, info) => {
      if (id !== tab.id || !info.url) return;
      if (urlTouched || !info.url.startsWith("http")) return;
      if (info.url === el("url").value.trim()) return;
      clearTimeout(followTimer);
      followTimer = setTimeout(() => {
        el("url").value = info.url;
        probe();
      }, 250);
    };
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    window.addEventListener("unload", () => {
      clearTimeout(followTimer);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
    });
  }
});

el("subsOn").addEventListener("change", () => {
  updateSubsVisibility();
  savePrefs();
});
el("autoSubs").addEventListener("change", () => {
  renderLangs();
  savePrefs();
});
el("langs").addEventListener("change", () => {
  prefs.langs = el("langs").value;
  // "all" with auto-captions resolves to the site's default auto track; pin the
  // concrete code so the visible selection and the saved pref match the wire
  // value buildSelection() sends.
  if (prefs.langs === "all" && el("autoSubs").checked) {
    prefs.langs = defaultAutoTrack();
    el("langs").value = prefs.langs;
    // The decorated select only re-syncs its label on a change event (the
    // MutationObserver can't see an IDL .value set).
    el("langs").dispatchEvent(new Event("change", { bubbles: true }));
  }
  prefs.langsTouched = true;
  savePrefs();
});
el("formatSelect").addEventListener("change", () => {
  savePrefs();
  updateSizeEstimate();
  updateChaptersControl();
});
el("subFormat").addEventListener("change", () => savePrefs());
el("convertSrt").addEventListener("change", () => savePrefs());
el("embed").addEventListener("change", () => savePrefs());
el("chapters").addEventListener("change", () => savePrefs());
el("playlist").addEventListener("change", () => {
  playlistTouched = true;
  prefs.playlist = el("playlist").checked;
  savePrefs();
});
el("url").addEventListener("input", () => { urlTouched = true; });
el("url").addEventListener("keydown", (e) => { if (e.key === "Enter") probe(); });
el("probeBtn").addEventListener("click", probe);
el("downloadBtn").addEventListener("click", startDownload);
el("cancelBtn").addEventListener("click", () => send({ action: "cancel" }));
el("pauseBtn").addEventListener("click", () =>
  send({ action: "pause", paused: !pausedNow }));
el("optsLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});