import { randomUUID } from "node:crypto";

// Deliver lifecycle actions to the existing document, including during startup.
export function createDesktopEventDispatcher({ getWindow, timeoutMs = 30_000, maximumPending = 32 }) {
  const pending = new Map();
  function send(type, payload) {
    const window = getWindow();
    if (!window || window.isDestroyed()) return Promise.reject(new Error("The desktop window is unavailable."));
    if (pending.size >= maximumPending) return Promise.reject(new Error("Too many desktop actions are waiting."));
    const contents = window.webContents;
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const finish = (error, result) => {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        contents.removeListener("did-finish-load", deliver);
        contents.removeListener("did-fail-load", failed);
        if (error) {
          try { if (!contents.isDestroyed()) contents.send("explore-better:desktop-event-cancel", { requestId }); } catch {}
          reject(error);
        } else resolve(result);
      };
      const record = { contents, frame: null, finish };
      const deliver = () => {
        if (!pending.has(requestId)) return;
        if (contents.isDestroyed()) return finish(new Error("The desktop window closed."));
        record.frame = contents.mainFrame;
        try { contents.send("explore-better:desktop-event", { requestId, type, payload }); }
        catch (error) { finish(error); }
      };
      const failed = (_event, _code, description, _url, isMainFrame) => {
        if (isMainFrame) finish(new Error(description || "The desktop document could not load."));
      };
      const timer = setTimeout(() => finish(new Error("The desktop did not acknowledge the action.")), timeoutMs);
      timer.unref?.();
      pending.set(requestId, record);
      if (contents.isLoadingMainFrame()) {
        contents.once("did-finish-load", deliver);
        contents.on("did-fail-load", failed);
      } else deliver();
    });
  }
  function settle(event, response) {
    const record = pending.get(String(response?.requestId || ""));
    if (!record || record.contents !== event.sender || record.frame !== event.senderFrame) return false;
    record.finish(response.error ? new Error(String(response.error)) : null, response.result);
    return true;
  }
  function cancel(contents, message = "The desktop document closed.", { deliveredOnly = false } = {}) {
    for (const record of [...pending.values()]) {
      if ((!contents || record.contents === contents) && (!deliveredOnly || record.frame)) record.finish(new Error(message));
    }
  }
  return { send, settle, cancel };
}
