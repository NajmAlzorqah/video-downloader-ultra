# AGENTS.md

Chromium/Brave extension + local yt-dlp native host, shipped as an **Omarchy
plugin**: the repo root is the plugin (bar-widget `najmalzorqah.video-downloader-ultra` + the `panel`
kind that renders the download OSD), installable with `omarchy plugin add
<git-url> --enable`. Because `omarchy plugin add` runs no plugin scripts, the
widget's first click runs `install.sh` (browser side) and streams its output;
the extension's widget shares one agent socket with the popup/service worker,
so the download queue survives every surface. Extension sends
`ping`/`probe`/`download`/`cancel`/`reorder`/`getQueue`/`theme` JSON over a
native-messaging port; the Python host runs yt-dlp and streams
`queue`/`start`/`progress`/`file`/`done`/`error`/`cancelled`.
Companion pattern to the Omarchy "Download Video" extension (match its OSD
glyphs/toast style) and its design system (popup/options follow the live
Omarchy theme via the host's read-only `theme` action).

## Layout

| Path | Role |
|---|---|
| `manifest.json` | Omarchy plugin manifest — one plugin, two `kinds`: bar-widget `Panel.qml` + panel `Osd.qml` (OSD IPC target `najmalzorqah.video-downloader-ultra.osd`, host-compatible) |
| `Panel.qml` | bar-widget: shared queue monitor + first-click setup pane (installs the browser side until the marker exists) |
| `Client.js` `Formats.js` `Defaults.js` | widget JS (agent-socket client, probe-option helpers ported from `popup.js`) |
| `Osd.qml` `OsdModel.js` | panel kind: stacked title-over-bar progress OSD (derived from stock `omarchy.osd`, MIT; see CREDITS.md) |
| `extension/app/` | MV3 extension (no build step; loaded unpacked from the installed plugin's `extension/app/`) |
| `extension/app/manifest.json` | static, committed — its SPKI `key` pins the extension id (no private key exists) |
| `extension/app/background-7.js` | owns the native port (drops it when idle — ~300ms after the last host reply so a request's follow-up `queue` broadcast always lands before the close — letting the shim exit + the SW can suspend; re-adopts the agent's queue after an unexpected drop), routes messages + the download queue, 200s probe timeout, ~4s `theme` cache (filename is versioned — see Gotchas) |
| `extension/app/theme.js` | resolves the host's raw `theme` payload into CSS variables on `:root`; on `getTheme` failure it does **not** re-apply a palette — it labels the header's connection state `offline`/`reload needed` and records the reason in `data-theme-error` |
| `extension/app/controls.js` | decorates native selects/checkboxes (custom dropdown + pill toggle) without touching `popup.js`/`options.js` logic |
| `extension/app/defaults.js` | single canonical `DEFAULTS` map shared by `popup.js` and `options.js` (both write the same `chrome.storage.local` namespace — a second copy is how default values drift between pages) |
| `extension/app/theme.css` | shared Omarchy design-system layer; `:root` holds the **single** Solitude fallback palette (first-paint/no-JS guard) plus layout tokens |
| `extension/app/popup.{html,js,css}` | main UI; `popup.js` is the big file (~815 lines) |
| `extension/app/options.{html,js,css}` | defaults via `chrome.storage.local` |
| `host/video-downloader-ultra-host` | single-file stdlib-only Python host with two modes: the default **shim** serves the browser's 4-byte LE length-prefixed JSON on stdio by relaying it to the JSON-lines **agent** daemon over a unix socket; `--agent` runs the long-lived daemon that owns the shared queue (see "Shared queue daemon") |
| `host/com.najmalzorqah.video_downloader_ultra.json.tpl` | NativeMessagingHosts manifest template (`@@HOST_PATH@@`, `@@EXT_ORIGIN@@`) |
| `host/browsers.sh` | single source of browser coverage for `install.sh`/`uninstall.sh`: canonical roots + conservative discovery (only registers a non-canonical Chromium-family root whose flags conf already exists — never invents paths) |
| `install.sh` / `uninstall.sh` | register/deregister the browser side in the ten Chromium-family profiles; install.sh writes the marker the widget reads and arms the removal watcher; uninstall.sh is marker-driven (acts on `installed.json`, not its own dir — the state-dir copy install.sh refreshes is what the watcher runs) |
| `tools/make-icons.py` | regenerates `extension/app/icons/*.png` |
| `tools/perf-check.sh` | samples agent/shim/quickshell RSS + CPU over a window, or counts `najmalzorqah.video-downloader-ultra.osd` "show" spawns — the measurement tool behind the OSD/theme perf fixes (see Commands) |
| `~/.config/omarchy/plugins/najmalzorqah.video-downloader-ultra/` | the installed clone of this repo (git-managed by `omarchy plugin add`; never edit in place — commit upstream and `omarchy plugin update`) |

## Commands

There is **no test, lint, or typecheck infrastructure** — don't hunt for one.

```bash
omarchy plugin validate .                          # plugin manifest/QML validation
omarchy plugin add <git-url> --enable              # install the plugin (clones the repo)
qmllint -I /usr/share/omarchy/shell Panel.qml Osd.qml
python3 -m py_compile host/video-downloader-ultra-host         # only host syntax check that exists
./install.sh                                      # browser side (widget first-click does this)
./uninstall.sh                                    # full cleanup, marker-driven
./uninstall.sh --if-plugin-gone                   # watcher mode: no-op unless installed_from dir is gone
tools/omarchy-remove.sh                           # uninstall.sh + omarchy plugin remove (fully clean reinstall)
uv run --directory tools python make-icons.py      # regenerate icons (dep-free script)
tools/perf-check.sh [--seconds 15] [--spawns 60]   # sample agent/shim/quickshell RSS+CPU, or OSD-show spawn rate
```

The widget has its own lightweight validation (no framework):

```bash
omarchy plugin validate .                       # in the repo root
qmllint Panel.qml Client.js Formats.js         # syntax/type check the QML + JS
```

Formats.js / probe-FSM harnesses are recreated ad hoc under `/tmp/opencode/` when
needed (they unit-test the widget/popup pure logic); they are **not** part of the
repo — `/tmp` is ephemeral, don't chase a missing file.

Manual testing: `chrome://extensions` → reload the unpacked extension. A browser
restart is needed after install (native host manifests + `--load-extension=` flags).
A **service-worker change needs a reload or full browser quit** (see Gotchas) —
the popup header showing `reload needed` is the tell-tale of a stale SW.
Widget QML edits are hot-reloaded by the shell watcher, but a full
`omarchy restart shell` is the reliable way to pick up `Panel.qml` changes
(the OSD clone in `najmalzorqah.video-downloader-ultra.osd/` needs one too — see Gotchas).

## Shared queue daemon (`--agent`)

The host is a **two-process relay**. A browser-session **shim** process is what
the NativeMessagingHosts manifest spawns: it reads 4-byte framed JSON from the
extension's stdio and forwards each line to the shared **agent** unix-socket
daemon, replying with the agent's JSON-lines in reverse. The agent (`--agent`)
owns the actual download queue — it outlives every shim/browser session, which
is what makes the queue shared between the extension popup and the widget, and
persistent across popup/SW restarts.

- Socket: `$XDG_RUNTIME_DIR/najmalzorqah.video-downloader-ultra/agent.sock` (falls back to
  `~/.local/state/najmalzorqah.video-downloader-ultra/`), 0600, single-instance via
  `create()/fcntl` lock + stale-socket-file cleanup (`bind_agent_socket()`).
  JSON-lines framing, up to `AGENT_MAX_CLIENTS` (8) simultaneous clients.
- The agent is lazy-spawned (detached) by a shim when the socket is missing,
  and **idle-exits** after `AGENT_IDLE_S` (120s) with no clients, no queue, and
  nothing in flight — it must never accumulate as immortal background processes.
- Routing (`send()`): requests carry a per-originator `req`. The agent maps an
  internal `nd<uid>:<req>↦(client, orig)` in `REQ_OWNERS` so per-job streams
  (`start`/`progress`/`file`/`done`/`error`/`cancelled`/`info`) and one-shot
  replies go **only to the client that issued the request**; `queue` snapshots
  and coarse `progress` broadcasts go to **every** live client. A req with no
  registered owner falls back to broadcast.
- Probes are coalesced + cached (`PROBE_CACHE_TTL` 60s, `PROBE_CACHE_MAX` 8) so
  concurrent/repeated probes share one yt-dlp run; failures are cached too.

Driving the agent by hand (the shim's stdin framing, in case the socket is up):

```bash
# agent mode needs the native-channel framing translated; easiest is the shim:
python3 host/video-downloader-ultra-host            # grabs a shim on this stdio, relays to socket
# or talk JSON-lines straight to the socket with a 3-line python client
```

The `theme` action still works through the agent socket unchanged
(`theme.js` → `background-7.js` → native port → shim → agent).

## Theme pipeline (live Omarchy colors)

`background-7.js` handles `getTheme` with a ~4s cache: it forwards the request
over the native port; the host reads `~/.local/state/omarchy/current/theme/`
(`colors.toml` + `shell.toml` + `theme.name`, plus the `~/.config/omarchy/
shell.toml` machine overlay) and replies without ever invoking yt-dlp.
`theme.js` maps that payload to CSS variables on `:root`. `colors.toml`'s
`mode = "dark"|"light"` (whitelisted in the host, `RE_THEME_MODE`) becomes
`--color-scheme`; both pages set `color-scheme: var(--color-scheme, dark)`.

- **The static Solitude fallback lives in exactly one place: `theme.css`
  `:root`** — it's the first-paint / no-JS guard. `theme.js` reads its token
  fallbacks from the computed `:root` styles at apply time (`readFallbacks()`)
  and holds no palette literals, so a live theme only overrides tokens it
  actually provides and there is no second palette copy to drift.
  When `getTheme` fails it labels the header's connection state
  (`offline`/`reload needed` — `setHostConn`, exported so popup.js can refresh
  it from the uncached `ping`) and puts the reason in
  `document.documentElement.dataset.themeError` plus a `[theme]` console.warn.
  The active theme name still lives in the `#themeName` tooltip.
  A second palette copy is how the theme previously "silently never changed"
  during de-duplication — the two sets had already drifted (`--fg-dim`).
- **Chromium extensions cannot read the browser theme**: `chrome.theme` does
  not exist and `browser.theme` is Firefox-only (w3c/webextensions #680/#869,
  Chromium bug 40914887). The native-host round-trip above is the only path to
  the real palette; `prefers-color-scheme` only mirrors the OS dark/light hint.
- Run the host by hand to sanity-check the payload (the 4-byte LE prefix must
  equal the JSON byte length — `{"action":"theme"}` is 18 = `\x12`, a wrong
  prefix reads short, fails to parse, and the host exits silently with no
  output):
  `printf '\x12\x00\x00\x00{"action":"theme"}' | VDU_NO_OMARCHY=1 ./host/video-downloader-ultra-host`

## Gotchas

- **Never edit `extension/app/manifest.json`** — it is static and committed; its
  SPKI `key` pins the extension id (`sha256(spki)` → first 16 bytes hex-mapped
  `0-f→a-p`, derived identically inside `install.sh`). No private key exists.
- **Never regenerate or delete the key/SPKI**: a new key = new id = mismatched
  `allowed_origins` and a dead host. Keep the committed manifest's `key` field
  untouched.
- **`omarchy plugin add` git-clones the repo** — plugin changes don't exist for
  new installs until they're committed and pushed; the installed clone at
  `~/.config/omarchy/plugins/najmalzorqah.video-downloader-ultra/` must stay clean (nothing writes
  into it — install.sh writes its marker to `~/.local/state/`), or
  `omarchy plugin update` refuses to fast-forward.
- Extension JS/HTML changes need only an extension reload (unpacked);
  manifest/host-template changes need `./install.sh` re-run.
- **Chromium caches MV3 service workers for `--load-extension` extensions and
  a window close can leave `chrome.exe`-style background processes that keep
  the stale worker alive.** The SW file is therefore versioned
  (`background-7.js`, same trick as Omarchy's `copy-url`): bump the filename on
  any SW logic change, then reload from `chrome://extensions` or fully quit the
  browser. Symptoms of a stale SW: every `runtime.sendMessage` fails with
  `Could not establish connection. Receiving end does not exist.` (shown as a
  probe error / red host dot), `getTheme` fails, and the popup header shows
  `reload needed`. The popup/`theme.js` map that exact error to a "reload
  the extension" hint; code cannot fix it — only a reload/heal can.
- Host **hardcodes** `/usr/bin/yt-dlp` and `/usr/bin/ffmpeg` (lines 32-33); ping
  reports their existence, not PATH lookup.
- **OSD/deps coupling is health-reported, not silent.** The host `ping` reply now
  carries additive `osd` (`unknown|ok|missing|broken`), `osdIssue`, and `deps`
  (`ytdlp`/`ffmpeg`/`omarchyShell`/`hyprctl`/`fcMatch`) fields — additive so the
  browser classifiers (`Client.js` `isPingReply`, `background-7.js` ping state)
  keep working. The widget's popup shows a warn row under the status line when
  the progress OSD is unreachable or an Omarchy dep checks out missing (an
  Omarchy update that breaks `omarchy-shell -q najmalzorqah.video-downloader-ultra.osd show|close` shows up
  there, not as a silent absence). OSD health is probed TTL-gated (60s) and only
  when a download is about to show a card, so nothing flickers at rest.
  The OSD payload carries `ipc: "nd-osd-1"` + `iface_version` which the panel
  (`OsdModel.js`) validates with a `console.warn` on mismatch. The Omarchy
  contract is version-dependent — re-verify it after any Omarchy update.
- Headless / custom `--user-data-dir` runs expect `com.najmalzorqah.video_downloader_ultra.json` inside
  the profile's `NativeMessagingHosts/`, not `~/.config/...`.
- Set `VDU_NO_OMARCHY=1` when driving the host by hand to suppress the OSD
  (`omarchy-shell -q najmalzorqah.video-downloader-ultra.osd show/close`) and toasts
  (`omarchy-notification-send`).
- The download OSD's stacked title-over-bar layout comes from the **`panel`
  kind of this same plugin** (`Osd.qml`/`OsdModel.js`); stock `omarchy.osd` in
  `/usr/share/omarchy/shell/plugins/osd/` renders *either* a bar *or* a
  message. The two coexist: stock `omarchy.osd` is enabled and serves the
  whole system (volume/brightness/media/monitor OSDs keep their stock single-row
  layout), while this project drives `najmalzorqah.video-downloader-ultra.osd` **directly** — the merged
  plugin's manifest carries **no `omarchy.clonedFrom`** (so
  `PluginRegistry.resolveEnabledId` never redirects system `omarchy.osd` summons
  to it), the panel registers `IpcHandler { target: "najmalzorqah.video-downloader-ultra.osd" }` and uses the
  `najmalzorqah-video-downloader-ultra-osd` layer-shell namespace. The host sends
  `omarchy-shell -q najmalzorqah.video-downloader-ultra.osd show <json>`/`close` instead of the `omarchy-osd`
  binary. Keep `OsdModel.js`'s `readout` field and `stacked`/bar logic in sync
  with what `osd_progress()` sends. Never edit the installed clone in place under
  `~/.config/omarchy/plugins/` (git-managed by `omarchy plugin add`; commit
  upstream and `omarchy plugin update`). QML edits in the repo need
  `omarchy restart shell` — the plugin watcher only logs `Local plugin changed,
  reloading`, it does **not** re-instantiate the running OSD panel (so an edit
  can look ignored until a full shell restart).

## Host security invariants (don't weaken when editing)

Everything in `host/video-downloader-ultra-host` is deliberately paranoid and must stay so:
array argv (no shell), `--` ends yt-dlp options, output confined to the output
dir via `realpath`, all echo strings stripped of ANSI/control chars, and
whitelist-validated inputs (`RE_FMTID`, `RE_LANG`, `RE_INT`, `RE_SUB_ERROR`).
The read-only `theme` action follows the same rules: `colors.toml` values are
`#hex`-only, `shell.toml` keys are `[A-Za-z0-9_-]` and values pass
`RE_TOML_SAFE` (≤200 chars, no control chars), `theme.name` and the
`fc-match` family pass their own regexes, and `hyprctl` runs with array argv
+ a 3s timeout. Nothing from the theme is ever passed to yt-dlp or a shell.

## Parser coupling in the host

`build_command()` emits tagged lines the parser in `run_one()` regexes:
`NJDP:PCT\t<pct>\t<speed>\t<eta>\t<downloaded>\t<total>` (from the
`--progress-template`), plus `NJDP:FILE\t<path>` and `NJDP:TITLE\t<title>`.
Editing one side without the other silently breaks progress/file tracking.
`build_command()` is also reused for the subtitle 429-retry check.

**Chapters coupling:** the selection key `chapters` is `"off"|"embed"|"split"`.
`"embed"` appends `--embed-chapters` (arguably `--embed-metadata` already
covers it in the embed-subs path); `"split"` appends `--split-chapters` plus a
`chapter:` output template deriving the section filename from the main template
(`%(title)s - %(section_number)02d_%(section_title)s.%(ext)s`). yt-dlp ≥2025
**keeps** the whole video next to the sections and reports only the original on
`NJDP:FILE`, so `download_worker()` re-derives the section files from each
main path (`split_sections()`, same dir + stem, ` - NN_title<ext>` naming) and
removes the originals — keep the `chapter:` template and `split_sections()` in
sync, or split downloads report one stale file and leave a duplicate. Split
cleanup runs per playlist entry, not just the first file.

## Subtitle lockout

`subtitle_lock_ok()` in the host is tri-state: `"ok"` (subs served fine),
`"unknown"` (timeout or a non-subtitle-keyword failure — the download still
runs with subs, and the real run's retry path decides), or `"blocked"`
(subtitle-specific failure after 3 attempts → subs are skipped). The
`"rate-limiting (HTTP 429)"` warning is shown only when the captured yt-dlp
output actually mentions 429/rate-limiting; otherwise a generic
"didn't serve them" message is used. Playlist lock probes are capped with
`--playlist-items 1` so they don't crawl the whole playlist. The lock probe is
cancellable, runs in a scratch dir (discarded — no subtitle files leak into
the output dir), and reports `"cancelled"` when the user hits Cancel mid-probe.

## Download queue

The native host owns the queue (it survives popup/SW death): at most one
`active_job` downloads at a time and every further `download` request joins a
FIFO `wait_queue`, replying `{ok:true, queueId}`. `finish_job()` auto-promotes
the next job after done **or error or cancel**, so one bad video never stalls
the rest and a cancel aimed at the active item starts the next one. Every
mutation broadcasts a `queue` event: `[{id, url, status:"downloading",
position, selection}, {status:"queued", ...}, ...]` (active first, oldest
waiting last). The per-active-job stream (`start`/`progress`/`file`/`done`/
`error`/`cancelled`) is unchanged.

- `cancel` with a `queueId` just removes that waiting item (nothing to tear
  down; an id that isn't waiting anymore — it was just promoted — is a no-op
  `not found`); `cancel` without one terminates the active job and advances
  the queue.
- `reorder {queueId, newIndex}` moves a *waiting* item; `newIndex` is a 0-based
  index in the waiting subgroup (validated + clamped in the host).
- `getQueue` returns the same snapshot as the `queue` event (used by the SW's
  restart authority check).
- Echoed selections are host-sanitized field-by-field with the exact
  `build_command()` whitelists, plus a display-only `label`
  (`RE_LABEL`, ≤80 safe chars — set by the popup for queue rows, never passed
  to yt-dlp). The snapshot is therefore safe to re-submit after a restart.
- `finish_job(job)` is *idempotent per job* and `download_worker` wraps the
  real body (`_download_worker`) in `try/finally`, so an unexpected exception
  — or a closed browser-side stdout, which `send()` now swallows — can never
  leave `active_job` set and wedge the queue; the wrapper also emits a
  terminal `error` event so the popup doesn't hang in the progress view.

**Persistence/restore:** the service worker mirrors `state.queue` into
`chrome.storage.local` (key `downloadQueue`, throttled ~1/s, removed when the
queue empties). On `onStartup`/`onInstalled` it asks the host `getQueue` — if
the host already owns a queue (it outlived an extension reload) the host wins
and storage is overwritten; only when the host is idle does it re-submit the
saved jobs (`{action:"download", url, selection}`) in order, former active
first, then clear storage. A browser restart restarts the active item from
scratch — there is no yt-dlp resume wiring. An **unexpected native-port drop**
(shim death, not the SW's own idle drop) never blanks the progress view: the
SW keeps `state.queue`/`status` (the agent is still downloading) and re-adopts
the host queue via `getQueue` on its next connection.

## Downloading progress (OSD only)

While a download runs the host shows **no notification at all** — progress
lives solely in the bottom-center Omarchy OSD (`osd_progress()`, title over a
progress bar + %). There is intentionally no in-progress toast: an earlier
`Downloading` notification re-sent ~1/s (even replaced in place via `-r`) made
Omarchy's notification service write a new `~/.local/state/omarchy/
notifications/history/` entry every tick, spamming the notification center.
End-of-download toasts (`notify_done`/`notify_many`/`notify_error`) are
unchanged and still fall back to `notify-send`; the progress OSD is
Omarchy-only and absent when `VDU_NO_OMARCHY`/no shell.

The stacked title-over-bar rendering comes from the **`panel` kind of this
same plugin** (`Osd.qml`/`OsdModel.js`, IPC target `najmalzorqah.video-downloader-ultra.osd`; see Gotchas) —
stock Omarchy draws *either* a bar *or* a message, never both (`OsdModel.js`
forced `hasProgress=false` whenever a message was passed). The host builds the
OSD payload itself (`icon`, `message`, `value`, `progressText`, `max`,
`duration`) and sends it straight to the clone via
`omarchy-shell -q najmalzorqah.video-downloader-ultra.osd show <json>`; stock `omarchy.osd` is untouched and
keeps serving every system OSD (volume/brightness/media/monitor), so only
downloads render the vertical clone. `_osd_refresh()` re-shows the OSD
every ~2.5s (throttled), including during the subtitle lock probe's retry backoffs
and per-attempt clock thread, so the 8s card doesn't expire mid-probe; every
exit path calls `osd_close()`. Clicking the card hides it: the clone sets a
`dismissed` flag so the download's ~2.5s refreshes can't pop it straight back
up, re-arming only once those refreshes stop (or when the host's `osd_close()`
resets it), while volume/brightness/media OSDs are never suppressed. The card
is the only interactive part of the surface (`mask: Region` covers just it),
so the desktop stays clickable. The video name travels as
`selection.title` (probe `meta.title`, playlist `meta.sample`) from `popup.js` → host — **not** a
new `NJDP:` tag, so it adds no parser coupling. The popup's own progress bar
labels itself from that same host-echoed field (queue head → `selection.title`),
falling back to the probe's `meta.title` only while the URL field still holds
that video, so a promoted or widget-started job never renders an unlabeled bar.

## Popup reopen behavior

Popup `DOMContentLoaded` asks the host for state **before** auto-probing the
active tab: if a download is running from a previous popup session it reopens
as the live progress view with the waiting queue rendered below it (nothing
wiped). A probe is safe while a download runs — it runs on its own host thread
(so it can't stall Cancel) and never touches the progress view — so a URL
change **always** auto-probes even mid-download, which is what lets a second
video be lined up in the queue. On a reopen it restores the last probe result
for the exact same URL from `chrome.storage.session` (`lastProbe` cache written
on successful probes) so the previously chosen options/estimate reappear
instantly without a refetch; only a URL change or the manual Probe button
triggers a new probe. The popup also follows the active tab while it stays open
(`chrome.tabs.onUpdated`) so SPA navigations / autoplay-advance don't leave it
stuck on the link it opened with, and `probe()` keys its reply to the URL it
was asked about (dropping superseded replies and clearing `probeData` on
failure) so an earlier video's metadata can't land on the current one. The
cache is session-scoped and lost on browser restart/extension reload.

## Removal & update model

`omarchy plugin remove najmalzorqah.video-downloader-ultra` only disables the plugin and `rm -rf`s
its clone (it runs no scripts), so the browser side must not live solely inside
the plugin. The removal/update contract keeps a reinstall **guaranteed fresh**:

- **Marker journal.** `installed.json` records `installed_from` (the dir the
  browser side is served from at install time) and `served_git` (that checkout's
  `git rev-parse HEAD`, best-effort), plus `flags_confs` (the flags-conf names,
  since `profiles` — `~/.config`-relative dirs — don't map 1:1 to conf names).
- **Removal watcher.** install.sh copies `uninstall.sh` to
  `~/.local/state/najmalzorqah.video-downloader-ultra/` and arms two systemd user units
  (`najmalzorqah.video-downloader-ultra-watch.path` → `najmalzorqah.video-downloader-ultra-cleanup.service`). The path
  unit watches `~/.config/omarchy/plugins/` with `PathChanged` — which fires on
  top-level add/remove (a plugin removal) but **not** on in-subdir git pulls,
  so updates land on the widget's self-heal, never on the watcher. The service
  runs the state-dir copy `uninstall.sh --if-plugin-gone`, which exits 0 unless
  the recorded `installed_from` dir is gone — other plugins' add/remove and
  `omarchy plugin update` never trigger it. A dev-checkout install
  (`installed_from` = your checkout, still present) is likewise never touched.
- **Marker-driven uninstall.** `uninstall.sh` no longer sources
  `host/browsers.sh`; it strips exactly the recorded `extension_dir` from each
  recorded flags conf, removes the recorded NativeMessagingHosts manifests,
  **process-group-kills** the agent (it runs `start_new_session=True` and has no
  SIGTERM handler — killing just it would orphan the child yt-dlp), removes both
  runtime dirs, disarms the watcher, and deletes the marker + its own state-dir
  copy. It therefore runs identically from the clone, a checkout, or the state
  copy (which is what survives the plugin's removal). Downloads are untouched.
- **Update self-heal.** `Panel.qml` compares the clone's `HEAD` against
  `served_git`: when the marker came from this clone and the clone moved on,
  install.sh re-runs automatically on shell load (idempotent; the marker's
  `served_git` then matches). A marker from a different checkout is never
  re-pointed automatically. Requires a shell restart to pick up a newer
  Panel.qml (see Gotchas).
- **No in-widget uninstall.** The panel's manage footer (re-run install /
  uninstall buttons) was removed; teardown is only the console path —
  `./uninstall.sh` (browser side + runtime) or `tools/omarchy-remove.sh`
  (the same, plus the plugin itself).

## Widget (`najmalzorqah.video-downloader-ultra`)

The bar-widget **is this repo** (`Panel.qml` at the root; the installed clone
lives at `~/.config/omarchy/plugins/najmalzorqah.video-downloader-ultra/`). It is a **second client
of the same agent socket** (`$XDG_RUNTIME_DIR/najmalzorqah.video-downloader-ultra/agent.sock`,
fallback `~/.local/state/…`). It shares the queue with the extension popup: a
job started in one renders live in the other because `queue` snapshots and
coarse `progress` broadcasts go to every client. It is *not* a re-implementation
of `background-7.js` — it talks JSON-lines to the agent directly, with no
4-byte framing (that is shim-only).

| File | Role |
|---|---|
| `manifest.json` | Omarchy plugin manifest (id `najmalzorqah.video-downloader-ultra`, kinds `bar-widget` + `panel`) |
| `Panel.qml` | shared-queue monitor + first-click setup pane (installs the browser side until the marker exists): progress view, cancel/pause/resume the active job, queue reorder/remove, connection state, and the update self-heal (see Removal & update model). Only file with QML; hot-reloaded by the shell watcher, reliable pickup via `omarchy restart shell` |
| `Client.js` | JSON-lines frame builders + reply classifiers mirroring the agent contract (keep in sync with the host's `AGENT_SOCK_*` / dispatch) |
| `Formats.js` | probe-option helpers ported from `extension/popup.js` (see Parser coupling — `summarizeSelection`/labels must track popup.js) |
| `Defaults.js` | mirrors `extension/defaults.js` — a **second copy** and the known defaults-drift surface (kept for the node unit harness, which loads it for `DEFAULTS`; the widget itself no longer builds selections) |

The widget starts no downloads — the extension popup owns URL probing and
download initiation. It reopens into the shared queue view and follows
`queue` snapshots + coarse `progress` broadcasts, so it survives shell
restarts without losing the queue it shares with the popup/SW.

## Toolchain coupling

Keep JSON/message formats in sync with what `host/video-downloader-ultra-host` actually
parses; the toolchain depends on the host OS integration (Omarchy
OSD/notifications).