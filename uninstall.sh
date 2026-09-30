#!/usr/bin/env bash
# Uninstall Video Downloader Ultra's browser side, marker-driven.
#
# This script acts on what install.sh recorded in the setup marker
# (~/.local/state/najmalzorqah.video-downloader-ultra/installed.json), NOT on its own directory:
# strip the recorded extension dir from the recorded flags confs (preserving
# other tools' entries), remove the recorded NativeMessagingHosts manifests,
# stop the agent process group, drop the runtime dirs, and remove the setup
# marker plus the removal watcher it armed. Because it never reads its own
# location, it runs identically from the installed clone, the dev checkout, or
# the self-contained copy install.sh keeps refreshed in the state dir — which
# is what the systemd path watcher executes with --if-plugin-gone.
#
#   --if-plugin-gone   exit 0 unless the marker exists AND the directory the
#                      browser side is served from (~marker.installed_from) is
#                      gone; then do the full cleanup below. This is the
#                      watcher's guard: plugin add/update or other plugins'
#                      add/remove never trigger cleanup, only a real removal of
#                      this install's dir does (and a dev-checkout install,
#                      whose dir is still present, is never touched).
set -euo pipefail

STATE_DIR="$HOME/.local/state/najmalzorqah.video-downloader-ultra"
MARKER="$STATE_DIR/installed.json"
UNINSTALL_COPY="$STATE_DIR/uninstall.sh"
MANIFEST_NAME="com.najmalzorqah.video_downloader_ultra.json"
USER_NAME="${USER:-$(id -un)}"

marker_field() {
  # Print one marker field: plain value, or one line per element for arrays.
  python3 - "$MARKER" "$1" <<'PY' 2>/dev/null || return 1
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
v = d.get(sys.argv[2])
if v is None:
    sys.exit(1)
print("\n".join(str(x) for x in v) if isinstance(v, list) else v)
PY
}

if [[ "${1:-}" == "--if-plugin-gone" ]]; then
  [[ -f "$MARKER" ]] || exit 0
  installed_from="$(python3 -c 'import json,sys
try: print(json.load(open(sys.argv[1])).get("installed_from", ""))
except Exception: print("")' "$MARKER" 2>/dev/null || true)"
  [[ -n "$installed_from" && -d "$installed_from" ]] && exit 0
fi

echo "Video Downloader Ultra uninstall (marker-driven at $MARKER)"

# ----------------------------------------------------- NativeMessaging hosts
# Only the profile dirs the marker recorded from the last install.
EXT_DIR="$(marker_field extension_dir 2>/dev/null || true)"
mapfile -t PROFILES < <(marker_field profiles 2>/dev/null || true)
mapfile -t FLAGS_CONFS < <(marker_field flags_confs 2>/dev/null || true)

for dir in "${PROFILES[@]}"; do
  file="$HOME/.config/$dir/NativeMessagingHosts/$MANIFEST_NAME"
  if [[ -f "$file" ]]; then
    rm -f "$file"
    echo "removed $file"
  fi
done

# ------------------------------------------------------------ flags strip
# Strip EXT_DIR from the recorded confs. Always in place — never restore a
# .video-downloader-ultra-bak wholesale, or flags other tools added after install would be lost.
strip_flags() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  if ! grep -qF -- "$EXT_DIR" "$file"; then
    return 0
  fi
  local esc
  esc="$(printf '%s' "$EXT_DIR" | sed 's/[][\\.^$*?+(){}|]/\\&/g')"
  sed -i -E \
    -e "s~--load-extension=$esc,~--load-extension=~g" \
    -e "s~,$esc,~,~g" \
    -e "s~,$esc([[:space:]]|\$)~\1~g" \
    -e "s~--load-extension=$esc([[:space:]]|\$)~--load-extension=\1~g" \
    -e "s~[[:space:]]*--load-extension=([[:space:]]|\$)~\1~g" \
    -e 's/^[[:space:]]+//; s/[[:space:]]+$//' \
    "$file"
  sed -i '/^[[:space:]]*$/d' "$file"
  echo "stripped $EXT_DIR from $file"
  if [[ -f "${file}.video-downloader-ultra-bak" ]]; then
    echo "  backup kept at ${file}.video-downloader-ultra-bak"
  fi
}
if [[ -n "$EXT_DIR" ]]; then
  for name in "${FLAGS_CONFS[@]}"; do
    strip_flags "$HOME/.config/$name-flags.conf"
    if [[ "$EXT_DIR" == */app ]]; then
      orig_ext="$EXT_DIR"
      EXT_DIR="${EXT_DIR%/app}"
      strip_flags "$HOME/.config/$name-flags.conf"
      EXT_DIR="$orig_ext"
    fi
  done
else
  echo "warn  no extension_dir recorded — nothing to strip from flags confs"
fi

# ---------------------------------------------------------- runtime teardown
# Stop the agent. The agent runs start_new_session=True (its own process group)
# and has no SIGTERM handler, so killing only the python pid would orphan the
# yt-dlp it spawned mid-download (which would keep writing to the downloads
# dir). Kill the whole group. pgid guards make `kill -- -1` (all processes)
# impossible. Remove the runtime dirs at both socket fallback locations.
for _pid in $(pgrep -u "$USER_NAME" -f "video-downloader-ultra-host.*--agent" 2>/dev/null || true); do
  _pgid="$(ps -o pgid= -p "$_pid" 2>/dev/null | tr -d ' ' || true)"
  if [[ -n "$_pgid" && "$_pgid" != "1" && "$_pgid" != "$$" ]]; then
    kill -TERM -- "-$_pgid" 2>/dev/null || true
  fi
  kill -TERM "$_pid" 2>/dev/null || true
done
unset _pid _pgid

rm -rf "${XDG_RUNTIME_DIR:-$HOME/.local/state}/najmalzorqah.video-downloader-ultra" "$HOME/.local/state/najmalzorqah.video-downloader-ultra"

# -------------------------------------------------------- watcher teardown
# Uninstall disarms the path watcher it armed: stop/disable before deleting
# unit files, then reload. Explicitly not run through a failing verifier — the
# whole block is best-effort so uninstall still succeeds without systemd.
if systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user stop najmalzorqah.video-downloader-ultra-watch.path 2>/dev/null || true
  systemctl --user disable najmalzorqah.video-downloader-ultra-watch.path 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/najmalzorqah.video-downloader-ultra-watch.path" \
        "$HOME/.config/systemd/user/najmalzorqah.video-downloader-ultra-cleanup.service"
  systemctl --user daemon-reload 2>/dev/null || true
fi

# ------------------------------------------------ marker + state copy gone
rm -f "$UNINSTALL_COPY" "$MARKER"
rmdir "$STATE_DIR" 2>/dev/null || true

echo
echo "Video Downloader Ultra uninstalled. Restart the browsers to unload the extension."
echo "The extension id stays pinned to the committed key; re-install with install.sh."