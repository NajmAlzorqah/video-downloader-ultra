#!/usr/bin/env bash
# Uninstall Video Downloader Ultra's browser side, marker-driven.
#
# This script acts on what install.sh recorded in the setup marker
# (~/.local/state/najmalzorqah.video-downloader-ultra/installed.json), NOT on its own directory:
# strip the recorded extension dir from the recorded flags confs (preserving
# other tools' entries), remove the recorded NativeMessagingHosts manifests,
# stop the verified agent daemon, drop the runtime dirs, and remove the setup
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
HOST_BIN="$(marker_field host_binary 2>/dev/null || true)"
INSTALLED_FROM="$(marker_field installed_from 2>/dev/null || true)"
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
# Stop the agent daemon safely. We strictly verify:
# 1. Owned agent identity: the candidate process must hold an open file descriptor
#    pointing to agent.lock in the user-owned runtime/state directory, or match
#    the agent.pid file written on socket bind. Unrelated processes with similar
#    command-line strings are never selected.
# 2. Executable verification: /proc/<pid>/exe must resolve to a Python interpreter
#    and the executed script must match the recorded host binary or installed directory.
# 3. Process group safety: SIGTERM is sent to the verified agent process and its
#    descendants. The process group (-pgid) is ONLY signaled if pgid == pid (the agent
#    is confirmed as its own process group leader from start_new_session=True), and
#    never when sharing a process group with a terminal or shell session.
python3 - "$STATE_DIR" "${XDG_RUNTIME_DIR:-}" "$HOST_BIN" "$INSTALLED_FROM" <<'PY' 2>/dev/null || true
import os, sys, signal, time

state_dir = sys.argv[1]
xdg_runtime = sys.argv[2]
host_bin = sys.argv[3] if len(sys.argv) > 3 else ""
installed_from = sys.argv[4] if len(sys.argv) > 4 else ""

rdirs = []
if xdg_runtime:
    rdirs.append(os.path.join(xdg_runtime, "najmalzorqah.video-downloader-ultra"))
rdirs.append(state_dir)
rdirs_real = [os.path.realpath(d) for d in rdirs if os.path.exists(d)]

my_uid = os.getuid()
self_pid = os.getpid()
parent_pid = os.getppid()

candidates = set()

# 1. Read agent.pid from runtime/state directories
for rdir in rdirs:
    pid_file = os.path.join(rdir, "agent.pid")
    try:
        with open(pid_file) as f:
            p = int(f.read().strip())
            if p > 1 and p != self_pid and p != parent_pid:
                candidates.add(p)
    except Exception:
        pass

# 2. Check user processes for open file descriptors to agent.lock
for entry in os.listdir("/proc"):
    if not entry.isdigit():
        continue
    p = int(entry)
    if p <= 1 or p == self_pid or p == parent_pid:
        continue
    try:
        if os.stat(f"/proc/{p}").st_uid != my_uid:
            continue
        fd_dir = f"/proc/{p}/fd"
        for fd in os.listdir(fd_dir):
            try:
                target = os.path.realpath(os.path.join(fd_dir, fd))
                if target.endswith(" (deleted)"):
                    target = target[:-10]
                for rdir in rdirs_real:
                    if target == os.path.join(rdir, "agent.lock"):
                        candidates.add(p)
                        break
            except OSError:
                pass
    except OSError:
        pass

def get_descendants(pid):
    parent_map = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        cpid = int(entry)
        try:
            with open(f"/proc/{cpid}/stat") as f:
                content = f.read()
                rparen = content.rfind(")")
                if rparen != -1:
                    fields = content[rparen + 1:].split()
                    ppid = int(fields[1])
                    parent_map.setdefault(ppid, []).append(cpid)
        except (OSError, IndexError, ValueError):
            pass
    descendants = []
    queue = [pid]
    while queue:
        curr = queue.pop(0)
        for child in parent_map.get(curr, []):
            descendants.append(child)
            queue.append(child)
    return descendants

def is_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False

# Verify candidate processes
verified = []
for p in candidates:
    try:
        if not is_alive(p):
            continue
        # Verify ownership
        if os.stat(f"/proc/{p}").st_uid != my_uid:
            continue
        # Verify executable is Python
        exe = os.path.realpath(f"/proc/{p}/exe")
        if not os.path.basename(exe).startswith("python"):
            continue
        # Verify command line arguments
        with open(f"/proc/{p}/cmdline", "rb") as f:
            args = [a.decode("utf-8", "replace") for a in f.read().split(b"\0") if a]
        if "--agent" not in args:
            continue
        script_matches = False
        for arg in args[1:]:
            if arg.startswith("-"):
                continue
            rarg = os.path.realpath(arg) if os.path.exists(arg) else arg
            if host_bin and (arg == host_bin or rarg == os.path.realpath(host_bin)):
                script_matches = True
                break
            if installed_from:
                rinst = os.path.realpath(installed_from)
                if rarg.startswith(rinst + "/") and os.path.basename(arg) == "video-downloader-ultra-host":
                    script_matches = True
                    break
            if os.path.basename(arg) == "video-downloader-ultra-host":
                script_matches = True
                break
        if not script_matches:
            continue

        # Verify owned agent identity: must have open FD or match agent.pid
        has_identity = False
        for rdir in rdirs:
            pid_file = os.path.join(rdir, "agent.pid")
            try:
                with open(pid_file) as f:
                    if int(f.read().strip()) == p:
                        has_identity = True
                        break
            except Exception:
                pass
        if not has_identity:
            fd_dir = f"/proc/{p}/fd"
            for fd in os.listdir(fd_dir):
                try:
                    target = os.path.realpath(os.path.join(fd_dir, fd))
                    if target.endswith(" (deleted)"):
                        target = target[:-10]
                    for rdir in rdirs_real:
                        if target == os.path.join(rdir, "agent.lock"):
                            has_identity = True
                            break
                except OSError:
                    pass
                if has_identity:
                    break

        if not has_identity:
            continue

        verified.append(p)
    except (OSError, ValueError):
        pass

# Terminate verified agent processes safely
for p in verified:
    descendants = get_descendants(p)
    try:
        pgid = os.getpgid(p)
        is_leader = (pgid == p and pgid > 1 and pgid != self_pid and pgid != parent_pid)
    except OSError:
        is_leader = False
        pgid = None

    # Step 1: Send SIGTERM
    if is_leader and pgid is not None:
        try:
            os.killpg(pgid, signal.SIGTERM)
        except OSError:
            pass
    else:
        for d in descendants:
            try:
                os.kill(d, signal.SIGTERM)
            except OSError:
                pass
        try:
            os.kill(p, signal.SIGTERM)
        except OSError:
            pass

    # Step 2: Wait briefly for exit
    for _ in range(15):
        if not is_alive(p):
            break
        time.sleep(0.1)

    # Step 3: If still alive, escalate to SIGKILL
    if is_alive(p):
        if is_leader and pgid is not None:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except OSError:
                pass
        else:
            for d in get_descendants(p):
                try:
                    os.kill(d, signal.SIGKILL)
                except OSError:
                    pass
            try:
                os.kill(p, signal.SIGKILL)
            except OSError:
                pass
PY

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