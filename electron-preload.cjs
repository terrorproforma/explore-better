const { contextBridge, ipcRenderer, webUtils } = require("electron");

const terminalPorts = new Map();
const terminalListeners = new Set();
const mcpActionListeners = new Set();
const updateListeners = new Set();
const desktopListeners = new Map();
const desktopEvents = [];
let desktopEventsRunning = false;
let activeDesktopEvent = null;

async function flushDesktopEvents() {
  if (desktopEventsRunning) return;
  desktopEventsRunning = true;
  try {
    while (desktopEvents.length) {
      const next = desktopEvents[0];
      const listeners = [...(desktopListeners.get(next.type) || [])];
      if (!listeners.length) break;
      desktopEvents.shift();
      activeDesktopEvent = next;
      try {
        let result;
        for (const listener of listeners) {
          if (next.canceled) break;
          result = await listener(next.payload, { isCanceled: () => next.canceled === true });
        }
        ipcRenderer.send("explore-better:desktop-event-result", { requestId: next.requestId, result });
      } catch (error) {
        ipcRenderer.send("explore-better:desktop-event-result", { requestId: next.requestId, error: error?.message || String(error) });
      } finally { activeDesktopEvent = null; }
    }
  } finally { desktopEventsRunning = false; }
}

function onDesktopEvent(type, listener) {
  if (typeof listener !== "function") return () => {};
  const listeners = desktopListeners.get(type) || new Set();
  listeners.add(listener);
  desktopListeners.set(type, listeners);
  void flushDesktopEvents();
  return () => listeners.delete(listener);
}

ipcRenderer.on("explore-better:desktop-event", (_event, payload) => {
  if (!["shell-open", "backend-recovered"].includes(payload?.type)) return;
  if (desktopEvents.length >= 32) {
    ipcRenderer.send("explore-better:desktop-event-result", { requestId: payload.requestId, error: "Too many desktop actions are waiting." });
    return;
  }
  desktopEvents.push(payload);
  void flushDesktopEvents();
});
ipcRenderer.on("explore-better:desktop-event-cancel", (_event, payload) => {
  if (activeDesktopEvent?.requestId === payload?.requestId) activeDesktopEvent.canceled = true;
  const index = desktopEvents.findIndex(item => item.requestId === payload?.requestId);
  if (index !== -1) desktopEvents.splice(index, 1);
  void flushDesktopEvents();
});

ipcRenderer.on("explore-better:terminal-port", (event, payload) => {
  const sessionId = String(payload?.sessionId || "");
  const port = event.ports?.[0];
  if (!sessionId || !port) {
    return;
  }
  terminalPorts.get(sessionId)?.close();
  terminalPorts.set(sessionId, port);
  port.onmessage = (messageEvent) => {
    for (const listener of terminalListeners) {
      try {
        listener(messageEvent.data);
      } catch {
        // Renderer listeners are isolated from the terminal transport.
      }
    }
    if (messageEvent.data?.type === "exit" && terminalPorts.get(sessionId) === port) {
      terminalPorts.delete(sessionId);
      port.close();
    }
  };
  port.start();
});

ipcRenderer.on("explore-better:mcp-ui-action", (_event, payload) => {
  const listeners = [...mcpActionListeners];
  Promise.resolve()
    .then(async () => {
      if (!listeners.length) throw Object.assign(new Error("No renderer AI action handler is registered."), { code: "UI_UNAVAILABLE" });
      let result = null;
      for (const listener of listeners) {
        result = await listener(payload.action);
        if (result?.__exploreBetterUiError) {
          throw Object.assign(new Error(result.__exploreBetterUiError.message), {
            code: result.__exploreBetterUiError.code || "UI_ACTION_FAILED"
          });
        }
      }
      ipcRenderer.send("explore-better:mcp-ui-action-result", { requestId: payload.requestId, result });
    })
    .catch((error) => {
      ipcRenderer.send("explore-better:mcp-ui-action-result", {
        requestId: payload.requestId,
        error: { code: error?.code || "UI_ACTION_FAILED", message: error?.message || String(error) }
      });
    });
});

ipcRenderer.on("explore-better:update-event", (_event, payload) => {
  for (const listener of updateListeners) {
    try {
      listener(payload);
    } catch {
      // Renderer listeners are isolated from the updater transport.
    }
  }
});

contextBridge.exposeInMainWorld("exploreBetterDesktop", {
  onShellOpen(listener) { return onDesktopEvent("shell-open", listener); },
  onBackendRecovered(listener) { return onDesktopEvent("backend-recovered", listener); },
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
  downloadUpdate() {
    return ipcRenderer.invoke("explore-better:download-update");
  },
  installUpdate() {
    return ipcRenderer.invoke("explore-better:install-update");
  },
  onUpdate(listener) {
    if (typeof listener !== "function") return () => {};
    updateListeners.add(listener);
    return () => updateListeners.delete(listener);
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
  aiBridge: {
    status() {
      return ipcRenderer.invoke("explore-better:mcp-status");
    },
    configure(patch) {
      return ipcRenderer.invoke("explore-better:mcp-configure", patch);
    },
    upsertProfile(profile) {
      return ipcRenderer.invoke("explore-better:mcp-profile-upsert", profile);
    },
    revokeProfile(profileId) {
      return ipcRenderer.invoke("explore-better:mcp-profile-revoke", profileId);
    },
    audit(limit) {
      return ipcRenderer.invoke("explore-better:mcp-audit", limit);
    },
    installClient(client, profileId) {
      return ipcRenderer.invoke("explore-better:mcp-client-install", client, profileId);
    },
    removeClient(client) {
      return ipcRenderer.invoke("explore-better:mcp-client-remove", client);
    },
    publishContext(context) {
      ipcRenderer.send("explore-better:mcp-context", context);
      return true;
    },
    onAction(listener) {
      if (typeof listener !== "function") return () => {};
      mcpActionListeners.add(listener);
      return () => mcpActionListeners.delete(listener);
    }
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
      try {
        return await ipcRenderer.invoke("explore-better:terminal-dispose", sessionId);
      } finally {
        terminalPorts.get(String(sessionId || ""))?.close();
        terminalPorts.delete(String(sessionId || ""));
      }
    },
    onEvent(listener) {
      if (typeof listener !== "function") return () => {};
      terminalListeners.add(listener);
      return () => terminalListeners.delete(listener);
    }
  }
});
