const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shiro", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  captureScreen: () => ipcRenderer.invoke("capture-screen"),
  onMic: (cb) => ipcRenderer.on("mic", (_e, state) => cb(state)),
  onWatch: (cb) => ipcRenderer.on("watch", (_e, state) => cb(state)),
  onWatchFrame: (cb) => ipcRenderer.on("watch-frame", (_e, frame) => cb(frame)),
  onJobResults: (cb) => ipcRenderer.on("job-results", (_e, payload) => cb(payload)),
  jobResultsAck: (id, ok) => ipcRenderer.send("job-results-ack", id, ok),
  setWatching: (value) => ipcRenderer.send("set-watching", value),
  onInteractive: (cb) => ipcRenderer.on("interactive", (_e, value) => cb(value)),
  setInteractive: (value) => ipcRenderer.send("set-interactive", value),
  setMouseCapture: (value) => ipcRenderer.send("set-mouse-capture", Boolean(value)),
  resizeWindow: (size) => ipcRenderer.send("resize-window", size),
  dragStart: () => ipcRenderer.send("drag-start"),
  dragEnd: () => ipcRenderer.send("drag-end"),
  quit: () => ipcRenderer.send("quit"),
});
