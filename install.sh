#!/usr/bin/env bash
# Install Video Downloader Ultra's browser side.
#
# This is the repo-root Omarchy plugin installer: it registers the native
# yt-dlp host into every Chromium-family profile on the machine, merges
# --load-extension= into every browser flags conf, checks the yt-dlp/ffmpeg
# deps the host hardcodes, and writes the marker the bar widget reads to flip
# out of "setup needed" mode.
#
# `omarchy plugin add` runs no plugin scripts, so the widget launches this on
# its first click (install.sh resolves its own root, so it works identically
# from a checkout and from the installed plugin dir). Idempotent - safe to
# re-run whenever a new browser profile appears. The flags files always carry
# exactly one Video Downloader Ultra extension path: any previously configured
# path to a different checkout (same extension name) is dropped in favour of
# this one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="$ROOT/host/video-downloader-ultra-host"
EXT_DIR="$ROOT/extension/app"
MANIFEST="$EXT_DIR/manifest.json"
NATIVE_TPL="$ROOT/host/com.najmalzorqah.video_downloader_ultra.json.tpl"
MANIFEST_NAME="com.najmalzorqah.video_downloader_ultra.json"
STATE_DIR="$HOME/.local/state/najmalzorqah.video-downloader-ultra"
MARKER="$STATE_DIR/installed.json"

# Journal fields: which checkout the browser side is served from and at which
# commit, so the widget can self-heal after an update and uninstall.sh can act
# on what install actually wrote (the marker, not this script's own dir).
INSTALLED_FROM="$ROOT"
SERVED_GIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"

# Canonical browser coverage + conservative discovery (single source in
# host/browsers.sh; uninstall.sh replays what this records into the marker).
# All canonical Chromium-family roots that use the NativeMessagingHosts layout
# are written unconditionally (Omarchy-parity + this project's Brave-Origin);
# a discovered root is only registered when its flags conf already exists on
# disk — install never invents config paths.
source "$ROOT/host/browsers.sh"
mapfile -t NATIVE_DIRS < <(browser_roots)
mapfile -t FLAGS_CONFS < <(browser_conf_names)
mapfile -t CORE_CONFS < <(browser_core_confs)
DISCOVERED_ROOTS=()
DISCOVERED_CONFS=()
while IFS=$'\t' read -r _d _c || [[ -n "$_d" ]]; do
  [[ -n "$_d" ]] || continue
  DISCOVERED_ROOTS+=("$_d")
  DISCOVERED_CONFS+=("$_c")
done < <(browser_discover)
for _i in "${!DISCOVERED_ROOTS[@]}"; do
  NATIVE_DIRS+=("${DISCOVERED_ROOTS[$_i]}")
  FLAGS_CONFS+=("${DISCOVERED_CONFS[$_i]}")
done
unset _d _c _i

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: missing $1" >&2; exit 1; }; }
need sha256sum
need base64
command -v python3 >/dev/null 2>&1 || { echo "error: missing python3" >&2; exit 1; }

chmod +x "$HOST"

# ------------------------------------------------------------------ extension id
# The id is pinned by the SPKI `key` baked into extension/app/manifest.json (no
# private key involved - a new key would change the id and break
# allowed_origins). Derived the same way Chromium does it:
#   sha256(SPKI DER) first 16 bytes, hex digits mapped 0-f -> a-p.
KEYB64="$(sed -n 's/.*"key"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)"
[[ -n "$KEYB64" ]] || { echo "error: no key field in $MANIFEST" >&2; exit 1; }
DER="$(mktemp)"
printf '%s' "$KEYB64" | base64 -d > "$DER"
HEX="$(sha256sum "$DER" | cut -d' ' -f1)"
rm -f "$DER"
HEX="${HEX:0:32}"
MAP="abcdefghijklmnop"
ID=""
for ((i = 0; i < ${#HEX}; i++)); do
  v=$((16#"${HEX:$i:1}"))
  ID+="${MAP:$v:1}"
done
echo "extension id: $ID (pinned by committed key)"

# --------------------------------------------------- NativeMessaging hosts
written=()
write_native() {
  local dir="$1"
  mkdir -p "$dir/NativeMessagingHosts"
  sed -e "s|@@HOST_PATH@@|$HOST|" \
      -e "s|@@EXT_ORIGIN@@|chrome-extension://$ID/|" \
      "$NATIVE_TPL" > "$dir/NativeMessagingHosts/$MANIFEST_NAME"
  echo "host manifest -> $dir/NativeMessagingHosts/$MANIFEST_NAME"
  written+=("${dir#$HOME/.config/}")
}
for dir in "${NATIVE_DIRS[@]}"; do
  write_native "$dir"
done

# ------------------------------------------------------------- flags merge
# Adds EXT_DIR to --load-extension= in every flags conf. Idempotent: leaves
# the entry alone when EXT_DIR is already listed, and drops any OTHER Video
# Downloader Ultra checkout path so a line never carries two. The work happens
# in python (already required for the marker) to avoid sed fragility with
# comma-separated values and other flags on the same line.
CORE_ARG="$(IFS=,; echo "${CORE_CONFS[*]}")"
python3 - "$EXT_DIR" "$CORE_ARG" "${FLAGS_CONFS[@]}" <<'PY'
import json, os, re, sys

ext = sys.argv[1]
core = set(x for x in sys.argv[2].split(",") if x)
confs = sys.argv[3:]
home = os.environ.get("HOME", "")

def is_other_vdu(p):
    if p == ext:
        return False
    if ext == os.path.join(p, "app"):
        return True
    m = os.path.join(p, "manifest.json")
    if not os.path.isfile(m):
        m = os.path.join(p, "app", "manifest.json")
    if not os.path.isfile(m):
        return False
    try:
        with open(m, encoding="utf-8", errors="replace") as f:
            return '"Video Downloader Ultra"' in f.read(4096)
    except OSError:
        return False

def update(filepath, create):
    if os.path.exists(filepath):
        with open(filepath, encoding="utf-8", errors="replace") as f:
            lines = f.read().split("\n")
    else:
        lines = []
    flag_re = re.compile(r"(--load-extension=)(\S*)")
    changed = False
    patched_line = None
    for i, ln in enumerate(lines):
        m = flag_re.search(ln)
        if not m:
            continue
        parts = [p for p in m.group(2).split(",") if p]
        keep = []
        for p in parts:
            if is_other_vdu(p):
                print("  dropped previous extension path %s" % p)
                changed = True
            else:
                keep.append(p)
        if ext not in keep:
            keep.append(ext)
            changed = True
        lines[i] = ln[:m.start(2)] + ",".join(keep) + ln[m.end(2):]
        patched_line = lines[i]
        break
    if patched_line is None:
        if create:
            lines.append("--load-extension=%s" % ext)
            changed = True
        else:
            return changed, lines
    if changed:
        if os.path.exists(filepath):
            os.replace(filepath, filepath + ".video-downloader-ultra-bak")
        with open(filepath, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
    return changed, lines

for name in confs:
    path = os.path.join(home, ".config", name + "-flags.conf")
    before = os.path.exists(path)
    try:
        changed, _ = update(path, name in core)
    except OSError as e:
        print("  error %s: %s" % (path, e))
        continue
    if not before and not os.path.exists(path):
        print("  skip  %s (does not exist)" % path)
    elif changed:
        print("  updated %s" % path)
    else:
        print("  ok    %s (already loaded)" % path)
PY

# ------------------------------------------------------------- deps check
# The host hardcodes these absolute paths (host lines 32-33); a yt-dlp found
# elsewhere on PATH still has to land at /usr/bin. Best-effort install via
# omarchy-pkg-add (sudo-less, Omarchy-only); otherwise warn with the hint.
YOUTUBE_OK=0
FFMPEG_OK=0
check_dep() {
  local bin="$1"
  if [[ -x /usr/bin/$bin ]]; then
    echo "ok    /usr/bin/$bin"
    return 0
  fi
  local found
  if found="$(command -v "$bin" || true)" && [[ -n "$found" ]]; then
    echo "warn  $bin found at $found but the host hardcodes /usr/bin/$bin - symlink it there"
    return 1
  fi
  if command -v omarchy-pkg-add >/dev/null 2>&1; then
    echo "trying omarchy-pkg-add $bin ..."
    if omarchy-pkg-add "$bin" >/dev/null 2>&1 && [[ -x /usr/bin/$bin ]]; then
      echo "ok    installed /usr/bin/$bin via omarchy-pkg-add"
      return 0
    fi
  fi
  echo "warn  $bin missing - the host requires /usr/bin/$bin"
  return 1
}
check_dep yt-dlp && YOUTUBE_OK=1
check_dep ffmpeg && FFMPEG_OK=1
if [[ "$YOUTUBE_OK" != 1 || "$FFMPEG_OK" != 1 ]]; then
  echo
  echo "NOTE: yt-dlp/ffmpeg must be at /usr/bin for the native host. Install them"
  echo "      (sudo pacman -S yt-dlp ffmpeg, or omarchy-pkg-add yt-dlp ffmpeg) and"
  echo "      re-run this script."
fi

# ---------------------------------------------------------------- marker
# The widget flips out of "setup needed" when this file exists and reads
# `profiles` for its success hint. Never written into the plugin dir, so
# `omarchy plugin update` stays a clean fast-forward. The journal fields
# (installed_from/served_git/flags_confs) drive the removal watcher and the
# marker-driven uninstall.sh — flag conf names are recorded because profiles
# (dirs under ~/.config) don't map 1:1 to flags-conf names.
mkdir -p "$STATE_DIR"
CFLAGS_ARG="$(IFS=,; echo "${FLAGS_CONFS[*]}")"
python3 - "$MARKER" "$EXT_DIR" "$ID" "$HOST" "$YOUTUBE_OK" "$FFMPEG_OK" \
  "$SERVED_GIT" "$INSTALLED_FROM" "$CFLAGS_ARG" "${written[@]}" <<'PY'
import json, sys, time
marker, ext_dir, ext_id, host = sys.argv[1:5]
yt = sys.argv[5] == "1"
ff = sys.argv[6] == "1"
served_git = sys.argv[7]
installed_from = sys.argv[8]
flags_confs = [c for c in sys.argv[9].split(",") if c]
profiles = sys.argv[10:]
data = {
    "extension_dir": ext_dir,
    "extension_id": ext_id,
    "host_binary": host,
    "profiles": profiles,
    "flags_confs": flags_confs,
    "installed_from": installed_from,
    "served_git": served_git,
    "ytdlp": yt,
    "ffmpeg": ff,
    "installed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
}
with open(marker, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
echo "marker -> $MARKER"

# ---------------------------------------------------------------- removal watcher
# `omarchy plugin remove` only deletes the plugin clone — it never runs
# uninstall.sh. A systemd user path watcher on the plugins dir catches a real
# removal (top-level dir add/remove; git pulls inside a clone don't fire it) and
# runs a state-dir copy of uninstall.sh in --if-plugin-gone mode: a no-op unless
# the recorded installed_from dir is gone. The copy is refreshed here and stays
# self-contained (marker-driven, no ROOT dependency) after the clone is deleted.
cp "$ROOT/uninstall.sh" "$STATE_DIR/uninstall.sh"
chmod +x "$STATE_DIR/uninstall.sh"
if systemctl --user show-environment >/dev/null 2>&1; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  CLEANUP_SERVICE="$UNIT_DIR/najmalzorqah.video-downloader-ultra-cleanup.service"
  WATCH_PATH="$UNIT_DIR/najmalzorqah.video-downloader-ultra-watch.path"
  SIGNATURE="# Managed by najmalzorqah.video-downloader-ultra"

  can_install_watcher=1

  # Check drop-in configuration on disk
  for dropin_dir in "$CLEANUP_SERVICE.d" "$WATCH_PATH.d"; do
    if [ -d "$dropin_dir" ] && [ -n "$(ls -A "$dropin_dir" 2>/dev/null || true)" ]; then
      echo "warn     refusing to overwrite watcher units: custom drop-ins found in $dropin_dir"
      can_install_watcher=0
      break
    fi
  done

  # Inspect loaded unit state via systemctl if known to systemd
  if [ "$can_install_watcher" = 1 ]; then
    for unit_name in "najmalzorqah.video-downloader-ultra-cleanup.service" "najmalzorqah.video-downloader-ultra-watch.path"; do
      loaded_info=$(systemctl --user show -p FragmentPath,DropInPaths "$unit_name" 2>/dev/null || true)
      dropins=$(echo "$loaded_info" | grep '^DropInPaths=' | cut -d= -f2- || true)
      if [ -n "$dropins" ]; then
        echo "warn     refusing to overwrite watcher units: $unit_name has active drop-ins: $dropins"
        can_install_watcher=0
        break
      fi
      fragment=$(echo "$loaded_info" | grep '^FragmentPath=' | cut -d= -f2- || true)
      if [ -n "$fragment" ]; then
        frag_real=$(realpath -m "$fragment" 2>/dev/null || echo "$fragment")
        unit_real=$(realpath -m "$UNIT_DIR/$unit_name" 2>/dev/null || echo "$UNIT_DIR/$unit_name")
        if [ "$frag_real" != "$unit_real" ] && [ "$fragment" != "$UNIT_DIR/$unit_name" ]; then
          echo "warn     refusing to overwrite foreign unit: $unit_name is loaded from $fragment"
          can_install_watcher=0
          break
        fi
      fi
    done
  fi

  # Check existing files on disk for ownership signature / expected content
  if [ "$can_install_watcher" = 1 ]; then
    if [ -f "$CLEANUP_SERVICE" ]; then
      if ! grep -Fq "$SIGNATURE" "$CLEANUP_SERVICE" 2>/dev/null && \
         ! grep -Fq "najmalzorqah.video-downloader-ultra/uninstall.sh --if-plugin-gone" "$CLEANUP_SERVICE" 2>/dev/null; then
        echo "warn     refusing to overwrite foreign unit file: $CLEANUP_SERVICE does not belong to this plugin"
        can_install_watcher=0
      fi
    fi
    if [ -f "$WATCH_PATH" ]; then
      if ! grep -Fq "$SIGNATURE" "$WATCH_PATH" 2>/dev/null && \
         ! grep -Fq "najmalzorqah.video-downloader-ultra-cleanup.service" "$WATCH_PATH" 2>/dev/null; then
        echo "warn     refusing to overwrite foreign unit file: $WATCH_PATH does not belong to this plugin"
        can_install_watcher=0
      fi
    fi
  fi

  if [ "$can_install_watcher" = 1 ]; then
    cat > "$CLEANUP_SERVICE" <<EOF
$SIGNATURE
[Unit]
Description=Clean up Video Downloader Ultra browser side when the plugin clone is removed

[Service]
Type=oneshot
ExecStart=%h/.local/state/najmalzorqah.video-downloader-ultra/uninstall.sh --if-plugin-gone
EOF
    cat > "$WATCH_PATH" <<EOF
$SIGNATURE
[Unit]
Description=Watch the Omarchy plugins dir for Video Downloader Ultra removal

[Path]
PathChanged=%h/.config/omarchy/plugins/
Unit=najmalzorqah.video-downloader-ultra-cleanup.service

[Install]
WantedBy=default.target
EOF
    if systemctl --user daemon-reload >/dev/null 2>&1 &&
       systemctl --user enable --now najmalzorqah.video-downloader-ultra-watch.path >/dev/null 2>&1; then
      echo "watcher  -> omarchy plugin remove now uninstalls the browser side too"
    else
      echo "warn     could not arm the systemd path watcher — a plugin removal"
      echo "         won't auto-unregister the browser side; uninstall.sh still works"
    fi
  else
    echo "warn     watcher unit arming skipped to protect foreign/custom systemd configuration"
  fi
else
  echo "warn     systemd user manager not running — a plugin removal won't"
  echo "         auto-unregister the browser side; uninstall.sh still works"
fi

# ---------------------------------------------------------------- summary
echo
echo "Video Downloader Ultra installed."
echo "  extension dir : $EXT_DIR"
echo "  extension id  : $ID"
echo "  profiles      : $(IFS=', '; echo "${written[*]}")"
echo "  discovered    : ${#DISCOVERED_ROOTS[@]} extra root(s) with an existing flags conf"
echo "  yt-dlp        : $([ "$YOUTUBE_OK" = 1 ] && echo present || echo MISSING)"
echo "  ffmpeg        : $([ "$FFMPEG_OK" = 1 ] && echo present || echo MISSING)"
echo
echo "Restart the browsers (chromium, chrome, brave, edge, ...) for the extension to appear."