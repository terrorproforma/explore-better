const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("exploreBetterDesktop", {
  getPathForFile(file) {
    if (!file) {
      return "";
    }
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  startFileDrag(paths) {
    if (!Array.isArray(paths) || !paths.length) {
      return false;
    }
    ipcRenderer.send(
      "explore-better:start-file-drag",
      paths.map((item) => String(item || "")).filter(Boolean)
    );
    return true;
  },
  updateStatus() {
    return ipcRenderer.invoke("explore-better:update-status");
  },
  checkForUpdates() {
    return ipcRenderer.invoke("explore-better:check-for-updates");
  },
  backendStatus() {
    return ipcRenderer.invoke("explore-better:backend-status");
  },
  restartBackend() {
    return ipcRenderer.invoke("explore-better:restart-backend");
  }
});
