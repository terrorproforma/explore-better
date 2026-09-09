import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

const protocolVersion = 2;
const maxFrameBytes = 4 * 1024 * 1024;
const maxSubscriptions = 256;
const maxResourceUriBytes = 2048;
const heartbeatTimeoutMs = 45_000;

function bridgeManifestPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "ExploreBetter", "MCP", "bridge-v1.json");
}

async function atomicWriteJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600).catch(() => {});
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

function safeError(error) {
  return {
    code: String(error?.code || "INTERNAL_ERROR"),
    message: String(error?.message || "Explore Better AI Bridge request failed.").slice(0, 2000),
    details: error?.details ?? null,
    retryable: error?.retryable === true
  };
}

function writeFrame(socket, message) {
  if (socket.destroyed || !socket.writable) return false;
  const frame = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(frame) > maxFrameBytes) {
    return socket.write(`${JSON.stringify({ version: protocolVersion, id: message.id || null, type: "error", error: safeError({ code: "LIMIT_EXCEEDED", message: "The result exceeds the AI Bridge response limit. Request a smaller page or narrow the analysis scope." }) })}\n`, "utf8");
  }
  if (socket.writableLength > maxFrameBytes * 2) {
    socket.destroy(new Error("The AI Bridge client is not reading responses."));
    return false;
  }
  return socket.write(frame, "utf8");
}

export function createMcpBridgeService(options) {
  const manifestPath = options.manifestPath || bridgeManifestPath();
  const pipeName = `\\\\.\\pipe\\explore-better-ai-${crypto.randomBytes(16).toString("hex")}`;
  const nonce = crypto.randomBytes(32).toString("base64url");
  const connections = new Map();
  const sockets = new Set();
  const lifecycle = new AbortController();
  let server = null;
  let startedAt = null;
  let disposed = false;
  let startPromise = null;
  let stopPromise = null;

  function status() {
    return {
      available: true,
      protocolVersion,
      running: Boolean(server?.listening),
      pipeName,
      manifestPath,
      clients: connections.size,
      startedAt
    };
  }

  function updateConnectionCount() {
    options.onConnectionCountChanged?.(connections.size);
  }

  async function handleRequest(connection, frame) {
    const id = String(frame.id || "").slice(0, 200);
    if (!id) {
      writeFrame(connection.socket, { version: protocolVersion, type: "error", error: safeError({ code: "INVALID_REQUEST", message: "A request ID is required." }) });
      return;
    }
    if (frame.op === "cancel") {
      const requestId = String(frame.requestId || "");
      const controller = connection.inFlight.get(requestId);
      if (controller) controller.abort();
      writeFrame(connection.socket, {
        version: protocolVersion,
        id,
        type: "result",
        result: { canceled: Boolean(controller), requestId }
      });
      return;
    }
    if (connection.inFlight.has(id) || connection.inFlight.size >= 64) {
      writeFrame(connection.socket, { version: protocolVersion, id, type: "error", error: safeError({ code: "LIMIT_EXCEEDED", message: "Use a unique request ID and wait for pending requests to complete." }) });
      return;
    }
    const controller = new AbortController();
    connection.inFlight.set(id, controller);
    try {
      let result;
      if (frame.op === "invoke") {
        result = await options.backend.invokeMcpAutomation({
          profileId: connection.profileId,
          sessionId: connection.sessionId,
          clientRoots: frame.clientRoots || connection.clientRoots,
          clientRootsProvided: frame.clientRootsProvided ?? connection.clientRootsProvided,
          context: options.getContext(),
          requestId: id,
          tool: frame.tool,
          args: frame.args || {},
          signal: controller.signal
        });
      } else if (frame.op === "resource") {
        result = await options.backend.readMcpAutomationResource({
          profileId: connection.profileId,
          sessionId: connection.sessionId,
          clientRoots: frame.clientRoots || connection.clientRoots,
          clientRootsProvided: frame.clientRootsProvided ?? connection.clientRootsProvided,
          context: options.getContext(),
          requestId: id,
          uri: frame.uri,
          signal: controller.signal
        });
      } else if (frame.op === "subscribe" || frame.op === "unsubscribe") {
        const uri = frame.uri;
        if (typeof uri !== "string" || !uri) {
          const error = new Error("A resource URI is required.");
          error.code = "INVALID_REQUEST";
          throw error;
        }
        if (Buffer.byteLength(uri, "utf8") > maxResourceUriBytes) {
          throw Object.assign(new Error("A resource URI cannot exceed 2048 UTF-8 bytes."), { code: "LIMIT_EXCEEDED" });
        }
        if (frame.op === "subscribe" && !connection.subscriptions.has(uri) && connection.subscriptions.size >= maxSubscriptions) {
          throw Object.assign(new Error("The resource subscription limit is reached. Unsubscribe from unused resources before adding another."), { code: "LIMIT_EXCEEDED" });
        }
        if (frame.op === "subscribe") connection.subscriptions.add(uri);
        else connection.subscriptions.delete(uri);
        result = { subscribed: frame.op === "subscribe", uri };
      } else if (frame.op === "contract") {
        result = await options.backend.getMcpProfileContract(connection.profileId);
      } else if (frame.op === "ping") {
        result = { pong: true, at: new Date().toISOString() };
      } else {
        const error = new Error("Unknown AI Bridge operation.");
        error.code = "INVALID_REQUEST";
        throw error;
      }
      writeFrame(connection.socket, { version: protocolVersion, id, type: "result", result });
    } catch (error) {
      writeFrame(connection.socket, { version: protocolVersion, id, type: "error", error: safeError(error) });
    } finally {
      connection.inFlight.delete(id);
    }
  }

  function accept(socket) {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    let buffer = "";
    let connection = null;
    let handshakeTimer = setTimeout(() => socket.destroy(new Error("AI Bridge handshake timed out.")), 5000);

    const close = () => {
      sockets.delete(socket);
      clearTimeout(handshakeTimer);
      if (connection) {
        for (const controller of connection.inFlight.values()) controller.abort();
        connections.delete(connection.id);
        updateConnectionCount();
      }
    };
    socket.on("close", close);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newline);
        if (Buffer.byteLength(rawLine) + 1 > maxFrameBytes) {
          socket.destroy(new Error("AI Bridge frame exceeded the size limit."));
          return;
        }
        const line = rawLine.trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          writeFrame(socket, { version: protocolVersion, type: "error", error: safeError({ code: "MALFORMED_JSON", message: "The AI Bridge frame was not valid JSON." }) });
          socket.destroy();
          return;
        }
        if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.op !== "string") {
          writeFrame(socket, { version: protocolVersion, type: "error", error: safeError({ code: "INVALID_REQUEST", message: "An AI Bridge frame must be an object with an operation name." }) });
          socket.destroy();
          return;
        }
        if (!connection) {
          if (frame.op !== "hello" || frame.version !== protocolVersion || frame.nonce !== nonce) {
            writeFrame(socket, { version: protocolVersion, id: frame.id || null, type: "error", error: safeError({ code: "BRIDGE_AUTH_FAILED", message: "AI Bridge protocol negotiation or nonce validation failed." }) });
            socket.destroy();
            return;
          }
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
          connection = {
            id: crypto.randomUUID(),
            socket,
            profileId: String(frame.profileId || "").slice(0, 100),
            sessionId: String(frame.sessionId || crypto.randomUUID()).slice(0, 120),
            clientInfo: frame.clientInfo && typeof frame.clientInfo === "object" ? frame.clientInfo : {},
            clientRoots: Array.isArray(frame.clientRoots) ? frame.clientRoots.slice(0, 100) : [],
            clientRootsProvided: frame.clientRootsProvided === true,
            inFlight: new Map(),
            subscriptions: new Set(),
            lastHeartbeat: Date.now()
          };
          connections.set(connection.id, connection);
          updateConnectionCount();
          writeFrame(socket, {
            version: protocolVersion,
            id: frame.id || null,
            type: "hello",
            connectionId: connection.id,
            server: { name: "Explore Better AI Bridge", version: options.appVersion, protocolVersion }
          });
          continue;
        }
        connection.lastHeartbeat = Date.now();
        handleRequest(connection, frame).catch(() => {});
      }
      if (Buffer.byteLength(buffer) > maxFrameBytes) {
        socket.destroy(new Error("AI Bridge frame exceeded the size limit."));
      }
    });
  }

  const heartbeat = setInterval(() => {
    const cutoff = Date.now() - heartbeatTimeoutMs;
    for (const connection of connections.values()) {
      if (connection.lastHeartbeat < cutoff) connection.socket.destroy();
    }
  }, 15_000);
  heartbeat.unref();

  function checkActive() {
    if (disposed) throw new Error("The AI Bridge service has been disposed.");
  }

  async function untilStopped(pending) {
    checkActive();
    let onStop;
    const stopped = new Promise((_, reject) => {
      onStop = () => reject(new Error("The AI Bridge service has been stopped."));
      lifecycle.signal.addEventListener("abort", onStop, { once: true });
    });
    try { return await Promise.race([pending, stopped]); }
    finally { lifecycle.signal.removeEventListener("abort", onStop); }
  }

  async function closeListener(active) {
    for (const connection of connections.values()) {
      for (const controller of connection.inFlight.values()) controller.abort();
    }
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    connections.clear();
    updateConnectionCount();
    if (server === active) server = null;
    if (active) await new Promise((resolve) => active.close(() => resolve()));
  }

  async function removeManifest() {
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (manifest.pid === process.pid && manifest.nonce === nonce) await fs.rm(manifestPath, { force: true });
    } catch {
      // Another launch may already own the manifest.
    }
  }

  async function start() {
    checkActive();
    if (startPromise) return startPromise;
    if (server?.listening) return status();
    startPromise = (async () => {
      let active = null;
      try {
        await untilStopped(options.backend.setMcpUiDispatcher(options.dispatchUiAction));
        checkActive();
        active = net.createServer(accept);
        server = active;
        active.maxConnections = 32;
        await untilStopped(new Promise((resolve, reject) => {
          const onError = (error) => { active.off("listening", onListening); reject(error); };
          const onListening = () => { active.off("error", onError); resolve(); };
          active.once("error", onError);
          active.once("listening", onListening);
          active.listen(pipeName);
        }));
        checkActive();
        startedAt = new Date().toISOString();
        await atomicWriteJson(manifestPath, {
          version: protocolVersion, pipeName, nonce, pid: process.pid,
          executablePath: options.executablePath, appPath: options.appPath,
          appVersion: options.appVersion, startedAt
        });
        checkActive();
        return status();
      } catch (error) {
        await closeListener(active);
        await removeManifest();
        throw error;
      }
    })();
    try { return await startPromise; }
    finally { startPromise = null; }
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    disposed = true;
    lifecycle.abort();
    clearInterval(heartbeat);
    stopPromise = (async () => {
      await startPromise?.catch(() => {});
      await closeListener(server);
      await removeManifest();
    })();
    return stopPromise;
  }

  function publishResourceUpdate(uri, revision = 0) {
    const safeUri = typeof uri === "string" ? uri : "";
    if (!safeUri || Buffer.byteLength(safeUri, "utf8") > maxResourceUriBytes) return 0;
    let published = 0;
    for (const connection of connections.values()) {
      if (!connection.subscriptions.has(safeUri)) continue;
      if (writeFrame(connection.socket, {
        version: protocolVersion,
        type: "resource_updated",
        uri: safeUri,
        revision: Math.max(0, Number(revision || 0))
      })) published += 1;
    }
    return published;
  }

  return { start, stop, status, publishResourceUpdate, manifestPath, pipeName };
}
