const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shiro", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  onInteractive: (cb) => ipcRenderer.on("interactive", (_e, value) => cb(value)),
  setInteractive: (value) => ipcRenderer.send("set-interactive", value),
  quit: () => ipcRenderer.send("quit"),
});
