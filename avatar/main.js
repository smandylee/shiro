const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session } = require("electron");
const { readFileSync, existsSync, writeFileSync, appendFileSync, statSync } = require("node:fs");
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
// Wide enough for the padded canvas (1280 + 2x170 source px at the default
// scale) so a drooping tail is never clipped by the window itself.
const WIN_WIDTH = 600;
const WIN_HEIGHT = 620;

let win = null;
let interactive = false;

function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - WIN_WIDTH - 24,
    y: workArea.y + workArea.height - WIN_HEIGHT - 24,
  };
}

function createWindow() {
  const saved = loadJson(STATE_PATH, null);
  const pos = saved && Number.isInteger(saved.x) ? saved : defaultPosition();

  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
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

  // Mic and watch decisions, plus anything that went wrong on the page.
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2 || /^\[(mic|watch)\]/.test(message)) logLine(`[page] ${message}`);
  });

  win.setAlwaysOnTop(true, "screen-saver");
  // forward:true keeps hover events flowing so the renderer can still react.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  win.on("moved", () => {
    const [x, y] = win.getPosition();
    try {
      writeFileSync(STATE_PATH, JSON.stringify({ x, y }));
    } catch (err) {
      console.error("failed to save window position:", err.message);
    }
  });
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

app.whenReady().then(() => {
  createWindow();

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
  ipcMain.on("set-watching", (_e, value) => setWatching(Boolean(value)));
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
