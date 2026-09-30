const HOST = "com.najmalzorqah.video_downloader_ultra";

let port = null;
let connecting = false;
let requestId = 0;
const pendings = new Map();
// True for the ~0ms between maybeDropIdlePort's disconnect() and the
// onDisconnect callback: distinguishes "we closed the port because nothing is
// happening" (host is fine, keep state.alive) from "the host/shim actually
// died" (reload signal / offline header).
let intentionalDrop = false;
// True once a real (non-deliberate) disconnect is seen: the shared agent
// outlived the shim, so the next connection must re-adopt the host's queue
// instead of trusting the snapshot from before the drop.
let needsReAdopt = false;
// Monotonic-ish clock of the last host message received. The idle port is only
// closed once this has been quiet for IDLE_DROP_QUIET_MS, so a request's
// follow-up `queue` broadcast can never lose the race to the close.
let lastHostTraffic = 0;

const state = {
  alive: false,
  ytdlp: false,
  ffmpeg: false,
  status: "idle", // idle | probing | downloading | done | error
  pct: null,
  speed: null,
  eta: null,
  downloaded: null,
  total: null,
  items: [],
  message: null,
  warn: null,
  // Waiting downloads, mirror of the host's `queue` event (active item is
  // tracked by status/pct/items above).
  queue: [],
  // id of the queue item whose progress `status`/`pct` currently reflect.
  // Lets the queue handler tell a same-job progress blip from a promotion to
  // a different job (which must clear stale pct).
  activeId: null,
  // True while the active job is SIGSTOP'd on the host (`queue` head reports
  // `status:"paused"`); progress stays frozen at the last emitted values.
  paused: false,
};

function emit(extra) {
  const snapshot = { ...state, ...extra };
  chrome.runtime.sendMessage({ action: "hostEvent", snapshot }).catch(() => {});
  // Every state-broadcast is a chance the work may have settled; dropping the
  // idle port here covers ping/probe/done/queue-empty alike, so the SW isn't
  // relying on one specific transition to notice it can go to sleep. Dropping
  // is deferred: a request's reply is emitted before the caller's .then adopts
  // the fresh state (getQueue/probe), and download/cancel/pause/reorder carry
  // their real state in a follow-up `queue` broadcast a moment later —
  // maybeDropIdlePort() waits that out via the quiet window instead of closing
  // the port on a stale-empty queue.
  scheduleIdleDrop();
}

// The native port is closed only once no host message has arrived for this
// long. A reply to download/cancel/pause/reorder is always followed by the
// `queue` broadcast that actually updates the mirror; a 0ms close could land
// in that gap and silently lose both the mirror update and the per-job stream
// for a job the agent is still downloading.
const IDLE_DROP_QUIET_MS = 300;

let idleDropTimer = null;
function scheduleIdleDrop(ms = 0) {
  if (idleDropTimer) return;
  idleDropTimer = setTimeout(() => {
    idleDropTimer = null;
    maybeDropIdlePort();
  }, ms);
}

function ensureConnected() {
  return new Promise((resolve) => {
    if (port) return resolve(port);
    if (connecting) return setTimeout(() => resolve(ensureConnected()), 50);

    connecting = true;
    try {
      port = chrome.runtime.connectNative(HOST);
    } catch (err) {
      connecting = false;
      resolve(null);
      return;
    }

    port.onMessage.addListener((msg) => {
      handleHostMessage(msg);
    });
    port.onDisconnect.addListener(() => {
      const deliberate = intentionalDrop;
      intentionalDrop = false;
      port = null;
      connecting = false;
      if (deliberate) {
        // We closed the port on purpose (idle) — the host is still healthy,
        // just unreachable until next demand. Leave state.alive/queue alone.
        return;
      }
      // Real drop: the shim (or the browser's side of the port) died. The
      // shared agent and its queue survive a dead shim, so a running download
      // is still running and must not be blanked — keep state.queue/status and
      // re-adopt the host's queue when the next connection comes up.
      failPendings();
      needsReAdopt = true;
      if (!state.alive) return;
      state.alive = false;
      emit();
      const err = chrome.runtime.lastError;
      if (err) console.warn("native host disconnected:", err.message);
    });

    connecting = false;
    resolve(port);
    if (needsReAdopt) {
      needsReAdopt = false;
      // The queue the agent kept is authoritative; re-fetch it so an open
      // popup's progress view returns without waiting for a new `queue`
      // broadcast to arrive on the fresh connection.
      hostQueue().then((res) => {
        if (res && res.ok && res.queue) {
          adoptQueue(res.queue);
          persistQueueNow();
          emit();
        }
      });
    }
  });
}

// The native port is only needed while work might be happening: an open port
// keeps the browser's shim (≈20MB RSS) alive and stops this MV3 service worker
// from ever suspending. Once every pending request has settled AND nothing is
// downloading/probing AND the queue is empty, close the port and let the shim
// exit. Reconnect is demand-driven (ensureConnected), and the shared agent
// daemon keeps the queue across that gap, so nothing is lost by closing it.
function maybeDropIdlePort() {
  if (!port || connecting) return;
  if (pendings.size > 0) return;
  if (state.queue.length > 0) return;
  if (state.status === "downloading" || state.status === "probing" || state.paused) return;
  const quiet = Date.now() - lastHostTraffic;
  if (quiet < IDLE_DROP_QUIET_MS) {
    // A request just answered; its `queue` broadcast may still be in flight.
    // Re-check once the quiet window elapses instead of racing it.
    scheduleIdleDrop(IDLE_DROP_QUIET_MS - quiet);
    return;
  }
  const p = port;
  port = null;
  intentionalDrop = true; // onDisconnect: host fine, don't flip state.alive.
  try {
    p.disconnect();
  } catch (err) {
    // The port was already gone (the browser tore it down, so its onDisconnect
    // is queued and will consume intentionalDrop as a deliberate close).
    // Deferred untick guards the corner where no onDisconnect ever arrives, so
    // a later genuine drop can't be misread as this intentional one.
    setTimeout(() => { intentionalDrop = false; }, 250);
  }
}

// The done/error/cancelled/start/queue transitions all clear the same five
// per-job progress fields before applying their own status; keeping that in one
// helper is what stops the copies from drifting apart.
function resetTo(overrides) {
  state.pct = null;
  state.speed = null;
  state.eta = null;
  state.downloaded = null;
  state.total = null;
  Object.assign(state, overrides);
}

// Apply a host `queue` snapshot to `state.queue` + the active-download status.
// Shared by the `queue` event handler, `getQueue`, and queue restore so the
// status reflects a job this SW did not start (widget-started) without three
// copies drifting.
function adoptQueue(queue) {
  state.queue = queue || [];
  const head = state.queue[0];
  if (head && (head.status === "downloading" || head.status === "paused")) {
    state.paused = head.status === "paused";
    const jobChanged = state.activeId !== head.id;
    state.activeId = head.id;
    // Clear items/pct whenever the active job changes, not just on a terminal
    // status: a promoted next job shouldn't flash the previous job's pct. A
    // pause↔resume flips only head.status; the job id is unchanged and status
    // stays "downloading", so resetTo is never reached and the frozen progress
    // survives the transition.
    if (jobChanged || state.status !== "downloading") {
      resetTo({ status: "downloading", items: [], message: null, warn: null });
    }
  } else {
    state.activeId = null;
    state.paused = false;
    // No active download. The host only routes done/error/cancelled to the
    // job's originator — a widget-started job's terminal transition never
    // reaches us, so this branch is the only signal it ended. Own jobs have
    // already been moved out of "downloading" by their routed terminal event,
    // so this reset only fires for foreign jobs (and, if a terminal event is
    // still in flight, is a harmless no-op on its way to the same result).
    if (state.status === "downloading") {
      resetTo({ status: "idle", items: [], message: null, warn: null });
    }
  }
  schedulePersist();
}

function handleHostMessage(msg) {
  lastHostTraffic = Date.now();
  if (msg && msg.event && msg.event !== "progress") {
    if (msg.event === "done") {
      resetTo({ status: "done", items: msg.items || [], pct: 100, warn: msg.warn || null });
    } else if (msg.event === "error") {
      resetTo({ status: "error", message: msg.message, warn: null });
    } else if (msg.event === "cancelled") {
      resetTo({ status: "done", message: "Cancelled", items: msg.items || [], warn: null });
    } else if (msg.event === "start") {
      resetTo({ status: "downloading", items: [], message: null, warn: null });
    } else if (msg.event === "info") {
      state.message = msg.message;
    }
  }

  if (msg && msg.event === "progress") {
    // Req-less broadcasts carry `queueId`; the fine-grained per-job stream
    // (with a req) is routed to us only if *we* started the job. Either way
    // these fields describe the currently-active queue item, so they always
    // belong to `state`. The handler above already moved us into
    // "downloading" via the queue snapshot.
    state.pct = msg.pct;
    state.speed = msg.speed;
    state.eta = msg.eta;
    state.downloaded = msg.downloaded;
    state.total = msg.total;
  }

  if (msg && msg.event === "queue") {
    adoptQueue(msg.queue);
  }

  const req = msg && msg.req;
  const pending = req && pendings.get(req);
  if (pending) {
    pendings.delete(req);
    if (pending.type === "ping") {
      state.alive = !!msg.ok;
      state.ytdlp = !!msg.ytdlp;
      state.ffmpeg = !!msg.ffmpeg;
      pending.resolve(msg.ok);
    } else if (pending.type === "probe") {
      // A probe finishing while a download runs must not clobber the download's
      // status message (the probe handler below applies the same guard).
      if (state.status !== "downloading") state.message = msg.ok ? null : msg.error;
      pending.resolve(msg);
    } else {
      // theme, getQueue, download, cancel, reorder — resolve the caller with
      // the host's raw reply; they carry their own typed state via events.
      pending.resolve(msg);
    }
  }
  emit();
}

function nextReq() {
  return ++requestId;
}

// Reject every in-flight request against a dead port: with the shim gone the
// replies will never arrive, so callers (ping/probe/getQueue) must resolve
// promptly instead of waiting out their full timeouts.
function failPendings(error = "native host disconnected") {
  if (!pendings.size) return;
  const stuck = [...pendings.values()];
  pendings.clear();
  for (const p of stuck) p.resolve({ ok: false, error });
}

// One-shot request over the native port. Registers a pending, times it out,
// and resolves with the host's reply (or `{ok:false, error}` on timeout /
// post failure). Per-type state updates still happen in handleHostMessage via
// the registered pending.type before this promise resolves.
function request(p, action, body = {}, timeout = 10000, timeoutError = "request timed out") {
  return new Promise((resolve) => {
    const req = nextReq();
    const timer = setTimeout(() => {
      if (pendings.has(req)) {
        pendings.delete(req);
        resolve({ ok: false, error: timeoutError });
        maybeDropIdlePort();
      }
    }, timeout);
    pendings.set(req, {
      type: action,
      resolve: (res) => {
        clearTimeout(timer);
        resolve(res);
      },
    });
    try {
      p.postMessage({ req, action, ...body });
    } catch (err) {
      clearTimeout(timer);
      pendings.delete(req);
      resolve({ ok: false, error: String(err) });
      maybeDropIdlePort();
    }
  });
}

function withNativePort() {
  return ensureConnected().then((p) => {
    if (!p) throw new Error("native host not available");
    return p;
  });
}

// ---------------------------------------------------------------------------
// Queue persistence: mirror the host's queue into chrome.storage.local so a
// full browser restart can re-submit the waiting jobs to a fresh host. The
// host stays authoritative while it is alive; storage is only a restart
// snapshot and is never trusted over what the host reports (`getQueue`).
const QUEUE_STORAGE_KEY = "downloadQueue";
let persistTimer = null;

function persistQueueNow() {
  if (state.queue.length) {
    chrome.storage.local.set({ [QUEUE_STORAGE_KEY]: { queue: state.queue } }).catch(() => {});
  } else {
    chrome.storage.local.remove(QUEUE_STORAGE_KEY).catch(() => {});
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistQueueNow();
  }, 500);
}

function hostQueue() {
  return withNativePort().then((p) => request(p, "getQueue", {}, 5000, "getQueue timed out"));
}

let restoring = false;

async function restoreFromStorage() {
  if (restoring) return;
  restoring = true;
  try {
    const qr = await hostQueue();
    if (!qr.ok) return; // can't confirm host state — don't risk duplicates
    if (qr.queue && qr.queue.length) {
      // The host already owns a running queue (extension reload while a
      // download was in flight, or a widget-started job): adopt it, drop the
      // stored copy.
      adoptQueue(qr.queue);
      persistQueueNow();
      return;
    }
    const stored = await chrome.storage.local.get(QUEUE_STORAGE_KEY);
    const saved = (stored[QUEUE_STORAGE_KEY] || {}).queue;
    if (!Array.isArray(saved) || !saved.length) return;
    state.queue = saved;
    for (const item of saved) {
      if (!item || typeof item.url !== "string") continue;
      try {
        const p = await withNativePort();
        p.postMessage({
          req: nextReq(),
          action: "download",
          url: item.url,
          selection: item.selection || {},
        });
      } catch (err) {
        break;
      }
    }
    // Mirror the re-submitted queue back into storage instead of clearing it:
    // the host's own `queue` events (arriving milliseconds after each accepted
    // download) overwrite this copy with the live snapshot. Clearing here would
    // open a window where a browser death right after the restore loses the
    // queue before the next event re-persists it.
    persistQueueNow();
  } finally {
    restoring = false;
  }
}

// Probe worst case in the host: run_probe(60s) + sleep(2s) + run_probe(60s)
// for a failed-first-try playlist URL, then flat_entries(60s) + first-video
// probe(60s) = up to 242s of subprocess waits in pathological time-out-every
// step. Typical probes take a couple of seconds, and most real runs stay well
// under 120s; 200s bounds a genuinely hung host without a near-miss on
// legitimate slow probes.
const PROBE_TIMEOUT_MS = 200000;
const PING_TIMEOUT_MS = 10000;
const THEME_TIMEOUT_MS = 5000;

// Live Omarchy theme, short-cached so repeated popup opens don't re-spawn
// hyprctl/fc-match on every open.
let themeCache = { at: 0, val: null };
const THEME_TTL_MS = 4000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case "ping":
      withNativePort()
        .then((p) =>
          request(p, "ping", {}, PING_TIMEOUT_MS, "ping timed out").then((res) => {
            if (res === true) {
              sendResponse({ ok: true, ytdlp: state.ytdlp, ffmpeg: state.ffmpeg });
            } else {
              sendResponse({ ok: false, error: (res && res.error) || "ping failed" });
            }
          })
        )
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "getState":
      sendResponse({ state: { ...state } });
      return false;

    case "getQueue":
      hostQueue()
        .then((res) => {
          if (res && res.ok && res.queue) {
            adoptQueue(res.queue);
            persistQueueNow();
            // The popup reopens from cached getState while the SW may have
            // been idle (port closed, no live broadcasts): shadow a hostEvent
            // so a widget-started download reappears instead of the stale
            // idle view.
            emit();
            sendResponse({ ok: true, queue: state.queue });
          } else {
            sendResponse({ ok: false, error: (res && res.error) || "queue unavailable" });
          }
        })
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "getTheme":
      if (themeCache.val && Date.now() - themeCache.at < THEME_TTL_MS) {
        sendResponse({ ok: true, theme: themeCache.val });
        return false;
      }
      withNativePort()
        .then((p) =>
          request(p, "theme", {}, THEME_TIMEOUT_MS, "theme timed out").then((res) => {
            if (res && res.ok && res.theme) {
              themeCache = { at: Date.now(), val: res.theme };
              sendResponse({ ok: true, theme: res.theme });
            } else {
              sendResponse({ ok: false, error: (res && res.error) || "theme unavailable" });
            }
          })
        )
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "probe":
      withNativePort()
        .then((p) => {
          if (state.status !== "downloading") state.status = "probing";
          emit();
          request(p, "probe", { url: msg.url }, PROBE_TIMEOUT_MS, "probe timed out").then((res) => {
            // Keep an in-flight download's status untouched: probing during a
            // download is allowed (manual Detect), and dropping back to
            // "idle" here would freeze the popup's progress view (same guard
            // as in handleHostMessage).
            const downloading = state.status === "downloading";
            if (!downloading) state.status = "idle";
            if (res && res.ok) {
              if (!downloading) state.message = null;
              emit();
              sendResponse(res);
            } else {
              const err = (res && res.error) || "probe failed";
              if (!downloading) state.message = err;
              emit();
              sendResponse({ ok: false, error: err });
            }
          });
        })
        .catch((err) => {
          if (state.status !== "downloading") {
            state.status = "idle";
            state.message = null;
          }
          emit();
          sendResponse({ ok: false, error: String(err) });
        });
      return true;

    case "download":
      withNativePort()
        .then((p) =>
          request(p, "download", { url: msg.url, selection: msg.selection }).then((res) => {
            if (res && res.ok) sendResponse({ ok: true, queueId: res.queueId });
            else sendResponse({ ok: false, error: (res && res.error) || "download rejected" });
          })
        )
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "cancel":
      withNativePort()
        .then((p) => {
          const body = {};
          if (Number.isInteger(msg.queueId)) body.queueId = msg.queueId;
          return request(p, "cancel", body).then((res) => {
            if (res && res.ok) sendResponse({ ok: true });
            else sendResponse({ ok: false, error: (res && res.error) || "cancel rejected" });
          });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "pause":
      if (typeof msg.paused !== "boolean") {
        sendResponse({ ok: false, error: "invalid paused flag" });
        return false;
      }
      withNativePort()
        .then((p) =>
          request(p, "pause", { paused: msg.paused }).then((res) => {
            if (res && res.ok) sendResponse({ ok: true });
            else sendResponse({ ok: false, error: (res && res.error) || "pause rejected" });
          })
        )
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "reorder":
      if (!Number.isInteger(msg.queueId) || !Number.isInteger(msg.newIndex)) {
        sendResponse({ ok: false, error: "invalid queueId/newIndex" });
        return false;
      }
      withNativePort()
        .then((p) =>
          request(p, "reorder", { queueId: msg.queueId, newIndex: msg.newIndex }).then((res) => {
            if (res && res.ok) sendResponse({ ok: true });
            else sendResponse({ ok: false, error: (res && res.error) || "reorder rejected" });
          })
        )
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    default:
      return false;
  }
});

// After a full browser restart the native host comes up fresh (empty queue):
// re-submit the jobs persisted to chrome.storage.local in their saved order
// (former active item first). Also fires on extension reload, where the host
// may still be running — restoreFromStorage() then adopts the host's queue
// instead of submitting duplicates.
chrome.runtime.onStartup.addListener(() => restoreFromStorage());
chrome.runtime.onInstalled.addListener(() => restoreFromStorage());
