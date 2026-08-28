const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require("electron");
const { readFileSync, existsSync, writeFileSync } = require("node:fs");
const path = require("node:path");

// Shiro sits on top of whatever the owner is doing, so the window is
// transparent, frameless, and click-through by default. Interactive mode is a
// deliberate toggle — otherwise she would swallow clicks meant for the desktop.

const CONFIG_PATH = path.join(__dirname, "config.json");
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
    },
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

app.whenReady().then(() => {
  createWindow();

  // Ctrl+Shift+S: let the owner grab, move, and configure her.
  globalShortcut.register("CommandOrControl+Shift+S", () => setInteractive(!interactive));
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());

  ipcMain.handle("get-config", () => config);
  ipcMain.on("quit", () => app.quit());
  ipcMain.on("set-interactive", (_e, value) => setInteractive(Boolean(value)));
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
