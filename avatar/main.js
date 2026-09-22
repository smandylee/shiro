const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session } = require("electron");
const { readFileSync, existsSync, writeFileSync, appendFileSync, statSync, readdirSync, unlinkSync } = require("node:fs");
const path = require("node:path");

// Shiro sits on top of whatever the owner is doing, so the window is
// transparent, frameless, and click-through by default. Interactive mode is a
// deliberate toggle — otherwise she would swallow clicks meant for the desktop.

const CONFIG_PATH = path.join(__dirname, "config.json");
// What the microphone and watch mode decided, and which hotkeys were pressed,
// so "it stopped answering" can be explained afterwards. No audio, no secrets.
const LOG_PATH = path.join(__dirname, "avatar.log");
const LOG_MAX_BYTES = 200 * 1024;

function logLine(line) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString().slice(11, 19)} ${line}\n`);
  } catch {
    /* logging must never get in the way */
  }
}

try {
  if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > LOG_MAX_BYTES) writeFileSync(LOG_PATH, "");
} catch {
  /* ignore */
}
const STATE_PATH = path.join(__dirname, ".window-state.json");

function loadJson(file, fallback) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`failed to read ${file}:`, err.message);
  }
  return fallback;
}

const config = loadJson(CONFIG_PATH, {});
// The size she was last left at (wheel or slider) wins over config.json's, and
// is kept in the same file as her position, which is not committed.
const savedState = loadJson(STATE_PATH, null);
if (savedState && Number.isFinite(savedState.scale) && savedState.scale > 0) config.scale = savedState.scale;

// The window is her drawn size plus room around it for the speech bubble and the
// control panel. These start at what fits the default scale (wide enough for the
// padded canvas, so a drooping tail is never clipped) and follow her size from
// then on: the page reports it as soon as it knows the sprite's dimensions.
const WIN_MARGIN_X = 82;
const WIN_MARGIN_TOP = 173;
let winW = 600;
let winH = 620;

let win = null;
let interactive = false;

function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - winW - 24,
    y: workArea.y + workArea.height - winH - 24,
  };
}

function createWindow() {
  const pos = savedState && Number.isInteger(savedState.x) ? savedState : defaultPosition();

  win = new BrowserWindow({
    width: winW,
    height: winH,
    x: pos.x,
    y: pos.y,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Her voice arrives over the socket, not from a click — without this the
      // renderer refuses to play it.
      autoplayPolicy: "no-user-gesture-required",
    },
  });

  // Mic, watch and job-relay decisions, plus anything that went wrong on the page.
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2 || /^\[(mic|watch|jobs|dev)\]/.test(message)) logLine(`[page] ${message}`);
  });

  win.setAlwaysOnTop(true, "screen-saver");
  // forward:true keeps hover events flowing so the renderer can still react.
  win.setIgnoreMouseEvents(true, { forward: true });
  // A job-results send before the page has attached its listener is dropped
  // silently, so the first check waits for it rather than racing it.
  win.webContents.once("did-finish-load", jobsTick);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  win.on("moved", savePosition);
}

function savePosition() {
  if (!win) return;
  const [x, y] = win.getPosition();
  try {
    writeFileSync(STATE_PATH, JSON.stringify({ x, y, scale: config.scale }));
  } catch (err) {
    console.error("failed to save window position:", err.message);
  }
}

/** Picks her up off a screen edge or a monitor that went away: keeps the window's centre on a display. */
function keepOnScreen() {
  if (!win) return;
  const b = win.getBounds();
  const centre = { x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) };
  const area = screen.getDisplayNearestPoint(centre).workArea;
  const x = Math.min(Math.max(b.x, area.x - Math.round(b.width / 2)), area.x + area.width - Math.round(b.width / 2));
  const y = Math.min(Math.max(b.y, area.y - Math.round(b.height / 2)), area.y + area.height - Math.round(b.height / 2));
  if (x !== b.x || y !== b.y) win.setBounds({ x, y, width: winW, height: winH });
}

/* ---------- picking her up ---------- */

// While the mouse button is held on her, the window follows the pointer. The
// pointer is read here, from the screen, so it keeps working even when it moves
// faster than the window can be redrawn.
const DRAG_MAX_MS = 60_000; // a lost "button released" must never leave her stuck to the pointer
let dragTimer = null;

function startDrag() {
  if (!win) return;
  endDrag(false);
  const start = screen.getCursorScreenPoint();
  const [x0, y0] = win.getPosition();
  const began = Date.now();
  logLine("[drag] start");
  dragTimer = setInterval(() => {
    if (!win || Date.now() - began > DRAG_MAX_MS) return endDrag(true);
    const c = screen.getCursorScreenPoint();
    // setBounds, not setPosition: moving between monitors with different scaling
    // can otherwise resize the window.
    win.setBounds({ x: x0 + c.x - start.x, y: y0 + c.y - start.y, width: winW, height: winH });
  }, 8);
}

function endDrag(save = true) {
  if (!dragTimer) return;
  clearInterval(dragTimer);
  dragTimer = null;
  if (save) {
    keepOnScreen();
    savePosition();
    logLine("[drag] end");
  }
}

function setInteractive(next) {
  if (!win) return;
  interactive = next;
  win.setIgnoreMouseEvents(!interactive, { forward: true });
  win.webContents.send("interactive", interactive);
}

// One picture of the screen Shiro is on, only when the owner asked her to look
// (the orchestrator sends the request) and only if they switched it on in
// config.json. Nothing is kept: the picture goes back over the socket and no
// further.
const CAPTURE_MAX_WIDTH = 1600;

/** The screen Shiro is on, as an image no wider than `maxWidth`, or null. */
async function grabScreen(maxWidth) {
  const display = screen.getDisplayMatching(win ? win.getBounds() : screen.getPrimaryDisplay().bounds);
  const scale = Math.min(1, maxWidth / display.size.width);
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale),
    },
  });
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  return source && !source.thumbnail.isEmpty() ? source.thumbnail : null;
}

async function captureScreen() {
  if (config.allowScreenCapture !== true) {
    return { error: "화면 보기가 꺼져 있어 (아바타 config.json 의 allowScreenCapture)" };
  }
  const image = await grabScreen(CAPTURE_MAX_WIDTH);
  if (!image) return { error: "화면을 캡처하지 못했어" };
  return { mime: "image/jpeg", data: image.toJPEG(80).toString("base64") };
}

/* ---------- watch mode (Ctrl+Shift+W): she watches the owner play ---------- */

// The screen is looked at here, on the owner's PC, every few seconds; a frame
// only leaves the machine when it has visibly changed (and the orchestrator
// throttles her remarks further). Off by default, off again on its own after
// a few hours, and the avatar shows a badge the whole time it's on.
const WATCH_TICK_MS = 5_000;
const WATCH_MIN_SEND_MS = 10_000;
const WATCH_FORCE_SEND_MS = 90_000;
const WATCH_MAX_MS = 3 * 60 * 60 * 1000;
const WATCH_MAX_WIDTH = 1280;
// Mean per-pixel brightness difference (0-255) that counts as "changed".
const WATCH_CHANGE_THRESHOLD = 6;

let watching = false;
let watchTimer = null;
let watchStartedAt = 0;
let lastSent = { at: 0, signature: null };

/** A tiny grayscale fingerprint of the frame, for telling whether it changed. */
function signature(image) {
  const small = image.resize({ width: 48, quality: "good" });
  const bgra = small.toBitmap();
  const out = new Uint8Array(bgra.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = (bgra[i * 4] * 0.11 + bgra[i * 4 + 1] * 0.59 + bgra[i * 4 + 2] * 0.3) | 0;
  }
  return out;
}

function difference(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

async function watchTick() {
  if (!watching || !win) return;
  if (Date.now() - watchStartedAt > WATCH_MAX_MS) return setWatching(false);
  const now = Date.now();
  if (now - lastSent.at < WATCH_MIN_SEND_MS) return;

  const image = await grabScreen(WATCH_MAX_WIDTH);
  if (!image || !watching) return;
  const sig = signature(image);
  const changed = difference(sig, lastSent.signature) >= WATCH_CHANGE_THRESHOLD;
  if (!changed && now - lastSent.at < WATCH_FORCE_SEND_MS) return;

  lastSent = { at: now, signature: sig };
  win.webContents.send("watch-frame", { mime: "image/jpeg", data: image.toJPEG(70).toString("base64") });
}

function setWatching(next) {
  if (!win) return;
  if (next && config.allowScreenCapture !== true) {
    win.webContents.send("watch", { on: false, denied: true });
    return;
  }
  watching = next;
  clearInterval(watchTimer);
  watchTimer = null;
  if (watching) {
    watchStartedAt = Date.now();
    lastSent = { at: 0, signature: null };
    watchTimer = setInterval(() => {
      watchTick().catch((err) => console.error("watch capture failed:", err.message));
    }, WATCH_TICK_MS);
  }
  win.webContents.send("watch", { on: watching });
}

/* ---------- job postings (from the PC-side JobSpy crawler, see tools/jobspy/) ---------- */

// The crawler runs on its own schedule (Windows Task Scheduler) and just drops
// JSON files here; nothing here fetches or scrapes anything. Picked up on a
// timer rather than a file-system watcher, since a scheduled task's writes
// don't need to be seen within milliseconds.
const JOBS_DIR = path.join(__dirname, "..", "tools", "jobspy", "output");
const JOBS_POLL_MS = 60_000;
const JOBS_MAX_POSTINGS = 500;
// A dropped IPC message (sent before the renderer had attached its listener,
// say) must not strand a file as "pending" forever with no ack ever coming —
// so a pending send this old is abandoned and the file is offered again.
const JOBS_PENDING_TIMEOUT_MS = 90_000;
// Files handed to the renderer, waiting for it to say whether the send worked.
const jobsPending = new Map(); // file -> { full, sentAt }

function jobsTick() {
  if (!win || !existsSync(JOBS_DIR)) return;

  const now = Date.now();
  for (const [file, entry] of jobsPending) {
    if (now - entry.sentAt > JOBS_PENDING_TIMEOUT_MS) {
      logLine(`[jobs] no ack for ${file} after ${JOBS_PENDING_TIMEOUT_MS / 1000}s, will retry`);
      jobsPending.delete(file);
    }
  }

  let files;
  try {
    files = readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json"));
  } catch (err) {
    logLine(`[jobs] could not list ${JOBS_DIR}: ${err.message}`);
    return;
  }
  for (const file of files) {
    if (jobsPending.has(file)) continue;
    const full = path.join(JOBS_DIR, file);
    let postings;
    try {
      const raw = JSON.parse(readFileSync(full, "utf8"));
      postings = Array.isArray(raw) ? raw : Array.isArray(raw?.postings) ? raw.postings : null;
    } catch (err) {
      logLine(`[jobs] could not read ${file}: ${err.message}`);
      continue;
    }
    if (!postings || postings.length === 0) {
      try {
        unlinkSync(full);
      } catch {
        /* picked up again next tick, harmless */
      }
      continue;
    }
    jobsPending.set(file, { full, sentAt: now });
    win.webContents.send("job-results", { id: file, postings: postings.slice(0, JOBS_MAX_POSTINGS) });
  }
}

app.whenReady().then(() => {
  createWindow();
  keepOnScreen(); // a saved position on a monitor that is no longer there

  // Ctrl+Shift+S: let the owner grab, move, and configure her.
  globalShortcut.register("CommandOrControl+Shift+S", () => setInteractive(!interactive));
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());
  // Ctrl+Shift+W: she watches the screen with the owner (and stops).
  globalShortcut.register("CommandOrControl+Shift+W", () => setWatching(!watching));

  // Talking to her: the first press starts listening, the next one (or a pause
  // in speech) sends it. Ctrl+Alt+V by default (Ctrl+Alt+M was already taken on
  // the owner's PC; `micHotkey` in config.json overrides it) — Ctrl+Shift+V would swallow
  // "paste as plain text" in every other app. Off unless config.json allows it.
  const micKey = typeof config.micHotkey === "string" && config.micHotkey ? config.micHotkey : "CommandOrControl+Alt+V";
  if (!globalShortcut.register(micKey, () => {
    if (!win) return;
    logLine(`[mic] hotkey pressed (${config.allowMicrophone === true ? "allowed" : "microphone is off in config.json"})`);
    win.webContents.send("mic", config.allowMicrophone === true ? { toggle: true } : { denied: true });
  })) {
    console.error(`could not register the microphone hotkey ${micKey} (already used by another app?)`);
  }

  // The microphone is only ever opened when the owner switched it on.
  const micAllowed = (permission) => permission === "media" && config.allowMicrophone === true;
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(micAllowed(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => micAllowed(permission));

  ipcMain.handle("get-config", () => config);
  ipcMain.handle("capture-screen", () =>
    captureScreen().catch((err) => ({ error: `화면 캡처 실패: ${err.message}` }))
  );
  ipcMain.on("quit", () => app.quit());
  ipcMain.on("set-interactive", (_e, value) => setInteractive(Boolean(value)));

  // Picking her up: the page says when the pointer is on her (take the mouse),
  // off her (let clicks through again), and when a drag starts and ends.
  ipcMain.on("set-mouse-capture", (_e, capture) => {
    if (!win || interactive) return; // with the panel up the window already takes the mouse
    win.setIgnoreMouseEvents(!capture, { forward: true });
  });
  // Her size changed (wheel, slider, or the sprite's dimensions became known):
  // the window grows or shrinks about her feet - the bottom centre stays put.
  ipcMain.on("resize-window", (_e, size) => {
    if (!win || !size) return;
    const { width, height, scale } = size;
    if (![width, height, scale].every(Number.isFinite) || width < 50 || height < 50 || width > 6000 || height > 6000) return;
    const b = win.getBounds();
    const centre = b.x + b.width / 2;
    const bottom = b.y + b.height;
    winW = Math.round(width) + WIN_MARGIN_X;
    winH = Math.round(height) + WIN_MARGIN_TOP;
    config.scale = scale;
    win.setBounds({ x: Math.round(centre - winW / 2), y: bottom - winH, width: winW, height: winH });
    keepOnScreen();
    savePosition();
  });
  ipcMain.on("drag-start", () => startDrag());
  ipcMain.on("drag-end", () => endDrag(true));
  ipcMain.on("set-watching", (_e, value) => setWatching(Boolean(value)));

  // A job-results file was sent (or the socket wasn't open): only remove it on
  // success, so a closed avatar just leaves it for the next time it's open.
  ipcMain.on("job-results-ack", (_e, id, ok) => {
    const entry = jobsPending.get(id);
    jobsPending.delete(id);
    if (!ok || !entry) return;
    try {
      unlinkSync(entry.full);
    } catch (err) {
      logLine(`[jobs] could not remove ${id}: ${err.message}`);
    }
  });
  setInterval(jobsTick, JOBS_POLL_MS);
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
