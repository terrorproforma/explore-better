const { contextBridge, ipcRenderer, webUtils } = require("electron");

const terminalPorts = new Map();
const terminalListeners = new Set();

ipcRenderer.on("explore-better:terminal-port", (event, payload) => {
  const sessionId = String(payload?.sessionId || "");
  const port = event.ports?.[0];
  if (!sessionId || !port) {
    return;
  }
  terminalPorts.set(sessionId, port);
  port.onmessage = (messageEvent) => {
    for (const listener of terminalListeners) {
      try {
        listener(messageEvent.data);
      } catch {
        // Renderer listeners are isolated from the terminal transport.
      }
    }
  };
  port.start();
});

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
  appInfo() {
    return ipcRenderer.invoke("explore-better:app-info");
  },
  restartBackend() {
    return ipcRenderer.invoke("explore-better:restart-backend");
  },
  terminal: {
    capabilities() {
      return ipcRenderer.invoke("explore-better:terminal-capabilities");
    },
    create(request) {
      return ipcRenderer.invoke("explore-better:terminal-create", request);
    },
    write(sessionId, data) {
      const port = terminalPorts.get(String(sessionId || ""));
      if (!port) return false;
      port.postMessage({ type: "write", data: String(data || "") });
      return true;
    },
    resize(sessionId, cols, rows) {
      const port = terminalPorts.get(String(sessionId || ""));
      if (!port) return false;
      port.postMessage({ type: "resize", cols: Number(cols), rows: Number(rows) });
      return true;
    },
    syncDirectory(sessionId, cwd) {
      return ipcRenderer.invoke("explore-better:terminal-sync-directory", sessionId, cwd);
    },
    async restart(sessionId, request) {
      const result = await ipcRenderer.invoke("explore-better:terminal-restart", sessionId, request);
      terminalPorts.get(String(sessionId || ""))?.close();
      terminalPorts.delete(String(sessionId || ""));
      return result;
    },
    async dispose(sessionId) {
      const result = await ipcRenderer.invoke("explore-better:terminal-dispose", sessionId);
      terminalPorts.get(String(sessionId || ""))?.close();
      terminalPorts.delete(String(sessionId || ""));
      return result;
    },
    onEvent(listener) {
      if (typeof listener !== "function") return () => {};
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    }
  }
});
