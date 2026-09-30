// Omarchy theme resolver. Takes the native host's `theme` payload (raw
// colors.toml + shell.toml dicts) and applies the same resolution rules as
// the shell's qs.Ui Color/Style singletons, writing CSS variables onto
// :root. The static fallback palette is owned solely by theme.css `:root`:
// readFallbacks() pulls the tokens straight from the computed stylesheet, so
// this file never stores a second palette copy (that copy is how the palette
// previously "silently never changed" once the two sets drifted, e.g.
// --fg-dim). When the host is down this file only flags the offline state.
(() => {
  "use strict";

  const FALLBACK_NAME = "solitude";

  // Header connection-state labels (shown in place of the theme name; the
  // active theme name still lives in the element's tooltip).
  const CONN_LABELS = {
    ok: "connected",
    offline: "offline",
    reload: "reload needed",
  };

  const HEX_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/;

  // A stale/stopped MV3 service worker rejects the getTheme round-trip with
  // Chrome's stock "no receiver" text; make the recorded reason actionable.
  // Exported on window (theme.js loads before popup.js/options.js on both
  // pages) so popup.js consumers share this single regex and message instead
  // of keeping a second, driftable copy of their own.
  const SW_GONE_RE = /Could not establish connection|Receiving end does not exist/;
  const SW_GONE_DIAG =
    "The extension's background worker isn't responding. Open chrome://extensions, reload Video Downloader Ultra, then try again.";

  // Fallback tokens come from theme.css `:root` (the single palette source).
  // If a token resolves empty here, apply() leaves the CSS variable unset so
  // the cascade keeps theme.css's own value — no literals cached in JS.
  function readFallbacks() {
    const cs = getComputedStyle(document.documentElement);
    const get = (name) => cs.getPropertyValue(name).trim();
    const px = (name) => {
      const m = /^(\d+)px$/.exec(get(name));
      return m ? parseInt(m[1], 10) : null;
    };
    return {
      fg: get("--fg"),
      bg: get("--bg-card"),
      canvas: get("--canvas"),
      urgent: get("--bar-active"),
      accent: get("--accent"),
      selection: get("--selection"),
      ok: get("--ok"),
      err: get("--err"),
      warn: get("--warn"),
      fgDim: get("--fg-dim"),
      border: get("--card-border"),
      radius: px("--radius"),
      borderW: px("--card-border-w"),
      base: px("--font-body"),
      fontFamily: get("--font-family"),
    };
  }

  function hexToRgb(hex) {
    const m = HEX_RE.exec(hex || "");
    if (!m) return null;
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  }

  function toRgba(hex, alpha) {
    const rgb = hexToRgb(hex);
    return rgb ? `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})` : "transparent";
  }

  function intVal(raw, fallback, min, max) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
  }

  function numVal(raw, fallback) {
    const n = Number(raw);
    return raw !== null && raw !== "" && Number.isFinite(n) ? n : fallback;
  }

  function buildTheme(t, fb) {
    const C = t.colors || {};
    const S = t.shell || {};

    const get = (key, fbVal) =>
      typeof S[key] === "string" && S[key] ? S[key].trim() : fbVal;

    const pickHex = (key, fbVal) => {
      const v = get(key, null) ?? C[key];
      return v && HEX_RE.test(v) ? v : fbVal;
    };

    const fg = pickHex("popups.text", pickHex("foreground", fb.fg));
    const bg = pickHex("popups.background", pickHex("background", fb.bg));
    const accent = pickHex("accent", pickHex("blue", pickHex("color4", fb.accent)));
    const urgent = pickHex("red", fb.urgent);
    const muted = toRgba(fg, 0.6);
    const canvas = pickHex("darker_background", pickHex("dark_background", fb.canvas));

    const state = (kind, suffix, fbNum) =>
      numVal(get(`controls.${kind}-${suffix}`, null) ?? get(`style.${kind}-${suffix}`, null), fbNum);
    const stateColor = (kind, fbHex) => {
      const tok = get(`controls.${kind}-color`, null) ?? get(`style.${kind}-color`, null);
      if (tok && HEX_RE.test(tok)) return tok;
      if (tok && tok.toLowerCase() === "accent") return accent;
      return fbHex;
    };

    const fill = (kind, fbNum) => toRgba(stateColor(kind, fg), state(kind, "fill-alpha", fbNum));
    const rule = (kind, fbNum) =>
      toRgba(stateColor(kind, fg), state(kind, "border-alpha", fbNum));

    const selectedText = pickHex("menu.selected-text", accent);

    const border = (() => {
      let tok = get("popups.border", "hyprland.active-border");
      for (let i = 0; i < 4 && tok in S; i++) tok = S[tok].trim();
      const stops = tok.match(/rgba\([0-9a-fA-F]{6}[0-9a-fA-F]{2}?\)/g);
      if (stops && stops.length >= 2) {
        const css = stops.map((s) => {
          const m = /rgba\(([0-9a-fA-F]{6})([0-9a-fA-F]{2})?\)/.exec(s);
          const rgb = hexToRgb(m[1]) || [202, 204, 204];
          const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
          return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(2)})`;
        });
        return `linear-gradient(135deg, ${css.join(", ")})`;
      }
      if (HEX_RE.test(tok)) return `linear-gradient(135deg, ${tok}, ${tok})`;
      return fb.border;
    })();

    const base = intVal(get("font.base-size", null), fb.base ?? 12, 1, 72);
    const SCALE = {
      caption: 0.833,
      "body-small": 0.917,
      body: 1,
      subtitle: 1.083,
      title: 1.167,
      heading: 1.333,
      display: 2,
      "display-large": 2.333,
    };
    const font = {};
    for (const name of Object.keys(SCALE)) {
      const pinned = intVal(get(`font.${name}`, null), null, 1, 192);
      font[name] = pinned !== null ? pinned : Math.max(1, Math.round(base * SCALE[name]));
    }

    return {
      "--color-scheme": (t && t.mode === "light") ? "light" : "dark",
      "--font-family": t.fontFamily || fb.fontFamily,
      "--font-base": base + "px",
      "--font-caption": font.caption + "px",
      "--font-body-small": font["body-small"] + "px",
      "--font-body": font.body + "px",
      "--font-subtitle": font.subtitle + "px",
      "--font-title": font.title + "px",
      "--font-heading": font.heading + "px",
      "--font-display": font.display + "px",
      "--font-display-large": font["display-large"] + "px",
      "--canvas": canvas,
      "--bg-card": bg,
      "--card-border": border,
      "--card-border-w": Math.max(1, intVal(get("popups.border-width", null), fb.borderW ?? 2, 1, 8)) + "px",
      "--radius": intVal(t.radius, fb.radius ?? 6, 0, 64) + "px",
      "--fg": fg,
      "--fg-dim": pickHex("fg-dim", pickHex("dim", fb.fgDim)),
      "--fg-faint": toRgba(fg, 0.55),
      "--muted": muted,
      "--accent": accent,
      "--selection": pickHex("selection", fb.selection),
      "--bar-bg": pickHex("bar.background", bg),
      "--bar-text": pickHex("bar.text", fg),
      "--bar-active": pickHex("bar.active", urgent),
      "--ok": pickHex("green", fb.ok),
      "--err": pickHex("bright_red", fb.err),
      "--warn": pickHex("bright_yellow", fb.warn),
      "--track": toRgba(fg, 0.45),
      "--ctrl-color": fg,
      "--ctrl-selected-color": selectedText,
      "--ctrl-normal-fill": fill("normal", 0.04),
      "--ctrl-hover-fill": fill("hover-cursor", 0.08),
      "--ctrl-focus-fill": fill("focus", 0.08),
      "--ctrl-selected-fill": fill("selected", 0.18),
      "--ctrl-pressed-fill": fill("pressed", 0.22),
      "--ctrl-normal-border": rule("normal", 0.4),
      "--ctrl-hover-border": rule("hover-cursor", 0.25),
      "--ctrl-focus-border": rule("focus", 0.25),
      "--ctrl-selected-border": rule("selected", 1),
      "--ctrl-selected-border-w": intVal(get("controls.selected-border-width", null), 0, 0, 8) + "px",
      "--selection-fill": toRgba(accent, 0.45),
    };
  }

  function apply(theme) {
    const vars = buildTheme(theme, readFallbacks());
    const el = document.documentElement;
    for (const [k, v] of Object.entries(vars)) {
      if (v) el.style.setProperty(k, v);
    }
    setHostConn("ok", theme && theme.name ? theme.name.trim() : FALLBACK_NAME);
  }

  // Header connection-state label. The getTheme round-trip doubles as a host
  // liveness probe, so the header now shows that health instead of just the
  // theme name ("connected"/"offline"/"reload needed"), with the active theme
  // kept in the tooltip. Exported so popup.js can refresh/overrule it from the
  // authoritative `ping` response (which is never served from the ~4s cache).
  function setHostConn(kind, title) {
    const capt = document.getElementById("themeName");
    if (capt) {
      capt.textContent = CONN_LABELS[kind] || CONN_LABELS.offline;
      if (title !== undefined) capt.title = title;
      capt.classList.remove("conn-ok", "conn-off", "conn-reload");
      capt.classList.add(
        kind === "ok" ? "conn-ok" : kind === "reload" ? "conn-reload" : "conn-off"
      );
    }
    const dot = document.getElementById("hostDot");
    if (dot) dot.className = "dot " + (kind === "ok" ? "on" : "off");
  }

  async function applyLive() {
    const el = document.documentElement;
    let theme = null;
    let diag = null;
    let swGone = false;
    try {
      const res = await chrome.runtime.sendMessage({ action: "getTheme" });
      if (res && res.ok && res.theme) {
        theme = res.theme;
      } else {
        diag = (res && res.error) || "no response from background";
      }
    } catch (err) {
      diag = String((err && err.message) || err);
    }
    if (SW_GONE_RE.test(diag)) {
      swGone = true;
      diag = SW_GONE_DIAG;
    }
    el.dataset.themeError = diag || "";
    if (theme) {
      apply(theme);
    } else {
      setHostConn(swGone ? "reload" : "offline", diag || "no response from background");
      if (diag) console.warn("[theme] getTheme failed:", diag);
    }
  }

  window.applyOmarchyTheme = applyLive;
  window.setHostConn = setHostConn;
  window.SW_GONE_RE = SW_GONE_RE;
  window.SW_GONE_DIAG = SW_GONE_DIAG;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyLive);
  } else {
    applyLive();
  }
})();