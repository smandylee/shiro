const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shiro", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  captureScreen: () => ipcRenderer.invoke("capture-screen"),
  onWatch: (cb) => ipcRenderer.on("watch", (_e, state) => cb(state)),
  onWatchFrame: (cb) => ipcRenderer.on("watch-frame", (_e, frame) => cb(frame)),
  setWatching: (value) => ipcRenderer.send("set-watching", value),
  onInteractive: (cb) => ipcRenderer.on("interactive", (_e, value) => cb(value)),
  setInteractive: (value) => ipcRenderer.send("set-interactive", value),
  quit: () => ipcRenderer.send("quit"),
});
