import { EventEmitter, once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { terminalMarkerDirectory, windowsArgumentList } from "./lib/terminal-protocol.mjs";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_DIMENSION = 1000;
const OUTPUT_BATCH_BYTES = 128 * 1024;
const BROKER_TIMEOUT_MS = 20000;
const idleMarkerPattern = /\x1b\]633;EB;idle(?:\x07|\x1b\\)/g;
const cwdMarkerPatterns = [
  { pattern: /\x1b\]9;9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g, fileUrl: false },
  { pattern: /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g, fileUrl: true }
];

function powershellPromptCommand() {
  const script = [
    "$global:__ExploreBetterOriginalPrompt = $function:prompt",
    "function global:prompt {",
    "$p = (Get-Location).Path",
    "$esc = [char]27",
    "[Console]::Out.Write(\"$esc]633;EB;idle`a$esc]9;9;$p`a\")",
    "if ($global:__ExploreBetterOriginalPrompt) { & $global:__ExploreBetterOriginalPrompt } else { \"PS $p> \" }",
    "}"
  ].join("; ");
  return Buffer.from(script, "utf16le").toString("base64");
}

function profileDefinitions() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const windowsPowerShell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const cmd = path.join(systemRoot, "System32", "cmd.exe");
  const pwshCandidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "pwsh.exe")
  ];
  const pwsh = pwshCandidates.find((candidate) => candidate && existsSync(candidate));
  return [
    pwsh && {
      id: "powershell7",
      label: "PowerShell 7",
      file: pwsh,
      args: ["-NoLogo", "-NoProfile", "-NoExit", "-EncodedCommand", powershellPromptCommand()],
      kind: "powershell"
    },
    existsSync(windowsPowerShell) && {
      id: "windows-powershell",
      label: "Windows PowerShell",
      file: windowsPowerShell,
      args: ["-NoLogo", "-NoProfile", "-NoExit", "-EncodedCommand", powershellPromptCommand()],
      kind: "powershell"
    },
    existsSync(cmd) && {
      id: "command-prompt",
      label: "Command Prompt",
      file: cmd,
      args: ["/D"],
      kind: "cmd"
    }
  ].filter(Boolean);
}

function publicProfiles() {
  return profileDefinitions().map(({ id, label }) => ({ id, label }));
}

function profileById(profileId) {
  const profiles = profileDefinitions();
  const automaticId = String(process.env.EXPLORE_BETTER_TERMINAL_PROFILE || "");
  return profiles.find((profile) => profile.id === profileId) || (profileId === "auto" ? profiles.find((profile) => profile.id === automaticId) || profiles[0] : null);
}

function clampDimension(value, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(1, Math.min(MAX_DIMENSION, number)) : fallback;
}

async function validateCreateRequest(request) {
  const tabId = String(request?.tabId || "");
  const cwd = String(request?.cwd || "");
  if (!/^[A-Za-z0-9-]{8,128}$/.test(tabId)) throw new Error("Invalid terminal tab identity.");
  if (!cwd || cwd.length > 32767 || /[\0\r\n]/.test(cwd)) throw new Error("Invalid terminal folder.");
  const info = await stat(cwd).catch(() => null);
  if (!info?.isDirectory()) throw new Error("Terminal folder does not exist.");
  const profile = profileById(String(request?.profileId || "auto"));
  if (!profile) throw new Error("Unknown terminal profile.");
  for (const [label, value] of [["columns", request?.cols], ["rows", request?.rows]]) {
    const number = Number(value);
    if (value !== undefined && (!Number.isFinite(number) || number < 1 || number > MAX_DIMENSION)) {
      throw new Error(`Terminal ${label} are outside the supported range.`);
    }
  }
  const elevation = request?.elevation === "administrator" ? "administrator" : "standard";
  return {
    tabId,
    cwd: path.resolve(cwd),
    profile,
    elevation,
    cols: clampDimension(request?.cols, 100),
    rows: clampDimension(request?.rows, 28)
  };
}

function terminalEnvironment(profile) {
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", EXPLORE_BETTER_TERMINAL: "1" };
  if (profile.kind === "powershell") {
    // A desktop launched from another PowerShell runtime inherits its module path.
    // Resolve the selected shell's inbox modules first (including PSReadLine),
    // while retaining the user's additional module directories.
    const defaults = [path.join(path.dirname(profile.file), "Modules"), path.join(process.env.ProgramFiles || "C:\\Program Files", profile.id === "windows-powershell" ? "WindowsPowerShell" : "PowerShell", "Modules")];
    const inherited = String(process.env.PSModulePath || "").split(path.delimiter).filter(Boolean);
    for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
    env.PSModulePath = [...defaults, ...inherited.filter((entry) => !defaults.some((item) => item.toLowerCase() === entry.toLowerCase()))].join(path.delimiter);
  }
  if (profile.kind === "cmd") {
    env.PROMPT = "$E]633;EB;idle$E\\$E]9;9;$P$E\\$P$G";
  }
  return env;
}

async function loadNodePty() {
  const module = await import("node-pty");
  return module.default || module;
}

export function createTerminalAdapterEmitter() {
  const emitter = new EventEmitter();
  let active = false;
  let earlyOutput = "";
  return Object.assign(emitter, {
    pushOutput(data) {
      if (active) emitter.emit("data", data);
      else earlyOutput = `${earlyOutput}${data}`.slice(-MAX_INPUT_BYTES);
    },
    activate() {
      if (active) return;
      active = true;
      const output = earlyOutput;
      earlyOutput = "";
      if (output) emitter.emit("data", output);
    }
  });
}

async function createLocalAdapter(options, _runtime, signal) {
  const nodePty = await loadNodePty();
  signal?.throwIfAborted();
  const emitter = createTerminalAdapterEmitter();
  let resolveExit;
  emitter.exited = new Promise((resolve) => { resolveExit = resolve; });
  const spawnOptions = {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: terminalEnvironment(options.profile),
    useConpty: true
  };
  const preferCompatibilityHost = process.env.EXPLORE_BETTER_USE_CONPTY_DLL !== "0";
  let pty;
  try {
    pty = nodePty.spawn(options.profile.file, options.profile.args, { ...spawnOptions, useConptyDll: preferCompatibilityHost });
  } catch (error) {
    pty = nodePty.spawn(options.profile.file, options.profile.args, { ...spawnOptions, useConptyDll: !preferCompatibilityHost });
  }
  pty.onData((data) => emitter.pushOutput(data));
  pty.onExit((event) => {
    resolveExit(event);
    emitter.emit("exit", event);
  });
  return Object.assign(emitter, {
    pid: pty.pid,
    write(data) { pty.write(data); },
    resize(cols, rows) { pty.resize(cols, rows); },
    kill() { try { pty.kill(); } catch {} }
  });
}

function sendJson(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}

function parseJsonLines(onMessage) {
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  return (chunk) => {
    buffer += decoder.write(chunk);
    if (buffer.length > MAX_INPUT_BYTES * 8) throw new Error("Terminal broker message exceeded its limit.");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid terminal broker message.");
        onMessage(message);
      }
      newline = buffer.indexOf("\n");
    }
  };
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function createElevatedAdapter(options, runtime, signal) {
  signal?.throwIfAborted();
  const emitter = createTerminalAdapterEmitter();
  // Transport errors may arrive between the readiness event and service binding.
  emitter.on("error", () => {});
  let resolveExit;
  emitter.exited = new Promise((resolve) => { resolveExit = resolve; });
  const nonce = randomBytes(32).toString("base64url");
  const pipeName = `\\\\.\\pipe\\ExploreBetter-Terminal-${randomUUID()}`;
  const brokerDir = path.join(runtime.userDataPath, "terminal-broker");
  const manifestPath = path.join(brokerDir, `${randomUUID()}.json`);
  await mkdir(brokerDir, { recursive: true });
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    pipeName,
    nonce,
    parentPid: process.pid,
    profileId: options.profile.id,
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    createdAt: Date.now()
  }), { encoding: "utf8", mode: 0o600, flag: "wx" });

  let socket = null;
  let settled = false;
  let closed = false;
  let shutdownTimer;
  const candidates = new Set();
  const server = net.createServer((candidate) => {
    if (closed || signal?.aborted || socket) return candidate.destroy();
    candidates.add(candidate);
    const consume = parseJsonLines((message) => {
      if ((closed || signal?.aborted) && socket !== candidate) return candidate.destroy();
      if (socket && socket !== candidate) return candidate.destroy();
      if (!socket) {
        if (message?.type !== "hello" || message?.nonce !== nonce || message?.parentPid !== process.pid) {
          candidate.destroy();
          return;
        }
        socket = candidate;
        settled = true;
        for (const other of candidates) if (other !== candidate) other.destroy();
        if (server.listening) server.close();
        emitter.emit("ready", { pid: message.pid });
        return;
      }
      if (message?.type === "data") emitter.pushOutput(Buffer.from(String(message.data || ""), "base64").toString("utf8"));
      if (message?.type === "exit") {
        clearTimeout(shutdownTimer);
        const result = { exitCode: message.exitCode, signal: message.signal };
        resolveExit(result);
        emitter.emit("exit", result);
        candidate.end();
      }
      if (message?.type === "error") emitter.emit("error", new Error(String(message.message || "Elevated terminal failed.")));
    });
    candidate.on("data", (chunk) => {
      try { consume(chunk); } catch (error) {
        if (socket === candidate) emitter.emit("error", error);
        candidate.destroy();
      }
    });
    candidate.on("error", (error) => { if (socket === candidate) emitter.emit("error", error); });
    candidate.on("close", () => {
      candidates.delete(candidate);
      if (socket === candidate) {
        clearTimeout(shutdownTimer);
        resolveExit({ disconnected: true });
        emitter.emit("disconnect");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName, resolve);
  });

  const brokerArg = `--terminal-broker-manifest=${manifestPath}`;
  const launchArgs = runtime.packaged ? [brokerArg] : [runtime.appPath, brokerArg];
  const command = `Start-Process -FilePath ${psQuote(runtime.executablePath)} -Verb RunAs -WindowStyle Hidden -ArgumentList ${psQuote(windowsArgumentList(launchArgs))}`;
  const launcher = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
    stdio: "ignore"
  });
  const launchFailure = new Promise((_, reject) => {
    launcher.once("error", reject);
    launcher.once("exit", (code) => {
      if (code && !settled) reject(new Error("Administrator terminal was canceled or could not start."));
    });
  });
  let timer;
  let onAbort;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Administrator terminal connection timed out.")), BROKER_TIMEOUT_MS); });
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason || new Error("Terminal creation canceled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    await Promise.race([once(emitter, "ready"), launchFailure, timeout, aborted]);
  } catch (error) {
    closed = true;
    if (server.listening) server.close();
    for (const candidate of candidates) candidate.destroy();
    launcher.kill();
    await rm(manifestPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
  await rm(manifestPath, { force: true }).catch(() => {});

  return Object.assign(emitter, {
    pid: null,
    write(data) { if (socket?.writable) sendJson(socket, { type: "write", data: Buffer.from(data).toString("base64") }); },
    resize(cols, rows) { if (socket?.writable) sendJson(socket, { type: "resize", cols, rows }); },
    kill() {
      if (closed) return;
      closed = true;
      if (socket?.writable) sendJson(socket, { type: "kill" });
      // Keep receiving until the broker acknowledges native exit. A broken
      // broker still cannot retain the parent transport indefinitely.
      shutdownTimer = setTimeout(() => socket?.destroy(), 10_000);
      for (const candidate of candidates) if (candidate !== socket) candidate.destroy();
      if (server.listening) server.close();
    }
  });
}

function quoteDirectory(profile, cwd) {
  if (/[\0\r\n"]/u.test(cwd)) throw new Error("Folder cannot be quoted for this shell.");
  if (profile.kind === "cmd") return `cd /d "${cwd}"\r`;
  return `Set-Location -LiteralPath '${cwd.replaceAll("'", "''")}'\r`;
}

function inspectMarkers(session, data) {
  const markerData = `${session.markerBuffer || ""}${data}`;
  const lastOscStart = markerData.lastIndexOf("\x1b]");
  const lastBell = markerData.lastIndexOf("\x07");
  const lastStringTerminator = markerData.lastIndexOf("\x1b\\");
  const pendingMarker = lastOscStart > Math.max(lastBell, lastStringTerminator) ? markerData.slice(lastOscStart) : "";
  session.markerBuffer = pendingMarker.length <= 65536 ? pendingMarker : "";
  let idle = false;
  if (idleMarkerPattern.test(markerData)) idle = true;
  idleMarkerPattern.lastIndex = 0;
  for (const { pattern, fileUrl } of cwdMarkerPatterns) {
    let match;
    while ((match = pattern.exec(markerData))) {
      const cwd = terminalMarkerDirectory(match[1], fileUrl);
      if (cwd && cwd !== session.cwd) {
        session.cwd = cwd;
        session.send({ type: "cwd", cwd });
      }
    }
    pattern.lastIndex = 0;
  }
  if (idle && session.busy) {
    session.busy = false;
    session.send({ type: "busy", busy: false });
  }
  if (idle) session.promptReady = true;
  if (idle && session.pendingCwd) {
    const pending = session.pendingCwd;
    session.pendingCwd = "";
    try { session.adapter.write(quoteDirectory(session.profile, pending)); }
    catch (error) { session.send({ type: "error", message: error.message }); }
  }
}

export function createTerminalService({ MessageChannelMain, getMainWindow, getBaseUrl, runtime, createAdapter = (options, runtime, signal) => options.elevation === "administrator" ? createElevatedAdapter(options, runtime, signal) : createLocalAdapter(options, runtime, signal) }) {
  const sessions = new Map();
  const tabSessions = new Map();
  const pendingCreates = new Map();
  const retiring = new Set();

  function trusted(event) {
    const window = getMainWindow();
    if (!window || event.sender !== window.webContents || event.sender.isDestroyed?.()) return false;
    if (window.webContents.mainFrame && event.senderFrame !== window.webContents.mainFrame) return false;
    try {
      const url = new URL(event.senderFrame.url);
      return url.origin === new URL(getBaseUrl()).origin && ["/", "/index.html"].includes(url.pathname);
    } catch { return false; }
  }

  function retireAdapter(adapter) {
    const stopped = adapter.exited || new Promise((resolve) => {
      adapter.once("exit", resolve);
      adapter.once("disconnect", resolve);
    });
    retiring.add(stopped);
    Promise.resolve(stopped).then(() => retiring.delete(stopped), () => retiring.delete(stopped));
    try { adapter.kill(); } catch {}
  }

  async function create(event, rawRequest, replacementSessionId = "") {
    if (!trusted(event)) throw new Error("Untrusted terminal sender.");
    const tabId = String(rawRequest?.tabId || "");
    if (!/^[A-Za-z0-9-]{8,128}$/.test(tabId)) throw new Error("Invalid terminal tab identity.");
    const tabKey = `${event.sender.id}:${tabId}`;
    const existingSessionId = tabSessions.get(tabKey) || "";
    if (pendingCreates.has(tabKey) || (existingSessionId && existingSessionId !== replacementSessionId)) throw new Error("This tab already owns a terminal.");
    let finish;
    const pending = { webContentsId: event.sender.id, controller: new AbortController(), done: new Promise((resolve) => { finish = resolve; }) };
    pendingCreates.set(tabKey, pending);
    let adapter;
    let channel;
    const sessionId = randomUUID();
    try {
      const options = await validateCreateRequest(rawRequest);
      pending.controller.signal.throwIfAborted();
      if (!trusted(event)) throw new Error("Terminal window closed while starting.");
      adapter = await createAdapter(options, runtime, pending.controller.signal);
      pending.controller.signal.throwIfAborted();
      if (!trusted(event) || pendingCreates.get(tabKey) !== pending || (replacementSessionId && !sessions.has(replacementSessionId))) throw new Error("Terminal was closed while starting.");
      channel = new MessageChannelMain();
      if (replacementSessionId) dispose(replacementSessionId);
      const session = {
        id: sessionId,
        tabKey,
        tabId: options.tabId,
        webContentsId: event.sender.id,
        profile: options.profile,
        elevation: options.elevation,
        cwd: options.cwd,
        busy: false,
        promptReady: false,
        markerBuffer: "",
        pendingCwd: "",
        adapter,
        port: channel.port1,
        output: "",
        recentOutput: "",
        outputTimer: null,
        send(message) { try { channel.port1.postMessage({ sessionId, ...message }); } catch {} }
      };
      sessions.set(sessionId, session);
      tabSessions.set(tabKey, sessionId);

      const flush = () => {
        session.outputTimer = null;
        if (!session.output) return;
        const output = session.output;
        session.output = "";
        session.send({ type: "data", data: output });
      };
      adapter.on("data", (data) => {
        if (!sessions.has(sessionId)) return;
        if (runtime.debug) console.log(`Explore Better PTY data: ${JSON.stringify(String(data).slice(0, 240))}`);
        inspectMarkers(session, data);
        session.recentOutput = `${session.recentOutput}${data}`.slice(-1024 * 1024);
        session.output += data;
        if (Buffer.byteLength(session.output) >= OUTPUT_BATCH_BYTES) flush();
        else if (!session.outputTimer) session.outputTimer = setTimeout(flush, 8);
      });
      const finishSession = ({ exitCode, signal, disconnected } = {}) => {
        if (!sessions.has(sessionId)) return;
        if (runtime.debug) console.log(`Explore Better PTY exit: code=${exitCode} signal=${signal}`);
        flush();
        session.send({ type: "exit", exitCode: disconnected ? -1 : Number(exitCode ?? 0), signal: Number(signal ?? 0) });
        dispose(sessionId, { kill: false });
      };
      adapter.on("exit", finishSession);
      adapter.on("error", (error) => session.send({ type: "error", message: error.message }));
      adapter.on("disconnect", () => finishSession({ disconnected: true }));
      // An elevated shell can exit between its hello and adapter factory return.
      // The retained completion also covers events emitted before these bindings.
      if (adapter.exited) Promise.resolve(adapter.exited).then(finishSession, (error) => {
        if (!sessions.has(sessionId)) return;
        session.send({ type: "error", message: error.message });
        finishSession({ disconnected: true });
      });
      channel.port1.on("message", (messageEvent) => handlePortMessage(session, messageEvent.data));
      channel.port1.start();
      event.senderFrame.postMessage("explore-better:terminal-port", { sessionId }, [channel.port2]);
      session.send({ type: "ready", profileId: options.profile.id, profileLabel: options.profile.label, elevation: options.elevation, cwd: options.cwd, pid: adapter.pid });
      adapter.activate?.();
      return { sessionId, profileId: options.profile.id, profileLabel: options.profile.label, elevation: options.elevation, cwd: options.cwd };
    } catch (error) {
      if (sessions.has(sessionId)) dispose(sessionId);
      else if (adapter) retireAdapter(adapter);
      try { channel?.port1.close(); channel?.port2.close(); } catch {}
      throw error;
    } finally {
      if (pendingCreates.get(tabKey) === pending) pendingCreates.delete(tabKey);
      finish();
    }
  }

  function ownSession(event, sessionId) {
    if (!trusted(event)) throw new Error("Untrusted terminal sender.");
    const session = sessions.get(String(sessionId || ""));
    if (!session || session.webContentsId !== event.sender.id) throw new Error("Unknown terminal session.");
    return session;
  }

  function handlePortMessage(session, message) {
    if (!sessions.has(session.id) || !message || typeof message !== "object") return;
    try {
      if (message.type === "write") {
        const data = String(message.data || "");
        if (Buffer.byteLength(data) > MAX_INPUT_BYTES) return session.send({ type: "error", message: "Terminal input exceeded its limit." });
        if (/[\r\n]/.test(data) && !session.busy) {
          session.busy = true;
          session.send({ type: "busy", busy: true });
        }
        session.adapter.write(data);
      }
      if (message.type === "resize") {
        session.adapter.resize(clampDimension(message.cols, 100), clampDimension(message.rows, 28));
      }
    } catch (error) {
      session.send({ type: "error", message: error.message });
    }
  }

  async function syncSessionDirectory(session, rawCwd) {
    const cwd = String(rawCwd || "");
    if (!cwd || /[\0\r\n]/.test(cwd)) throw new Error("Terminal sync folder does not exist.");
    const normalizedCwd = path.resolve(cwd);
    const revision = session.syncRevision = (session.syncRevision || 0) + 1;
    const info = await stat(normalizedCwd).catch(() => null);
    if (!info?.isDirectory()) throw new Error("Terminal sync folder does not exist.");
    if (!sessions.has(session.id)) throw new Error("Terminal was closed.");
    if (session.syncRevision !== revision) return { queued: true, superseded: true, cwd: normalizedCwd };
    const command = quoteDirectory(session.profile, normalizedCwd);
    if (session.busy || !session.promptReady) {
      session.pendingCwd = normalizedCwd;
      session.send({ type: "sync-pending", cwd: normalizedCwd });
      return { queued: true, cwd: normalizedCwd };
    }
    session.pendingCwd = "";
    session.adapter.write(command);
    return { queued: false, cwd: normalizedCwd };
  }

  function syncDirectory(event, sessionId, rawCwd) {
    return syncSessionDirectory(ownSession(event, sessionId), rawCwd);
  }

  function dispose(sessionId, { kill = true } = {}) {
    const session = sessions.get(String(sessionId || ""));
    if (!session) return false;
    sessions.delete(session.id);
    if (tabSessions.get(session.tabKey) === session.id) tabSessions.delete(session.tabKey);
    if (session.outputTimer) clearTimeout(session.outputTimer);
    if (kill) {
      retireAdapter(session.adapter);
    }
    try { session.port.close(); } catch {}
    return true;
  }

  function disposeForEvent(event, sessionId) {
    const session = ownSession(event, sessionId);
    return dispose(session.id);
  }

  function restart(event, sessionId, request) {
    const current = ownSession(event, sessionId);
    if (String(request?.tabId || "") !== current.tabId) throw new Error("Terminal restart tab identity changed.");
    return create(event, request, current.id);
  }

  function disposeWebContents(webContentsId) {
    for (const pending of pendingCreates.values()) {
      if (pending.webContentsId === webContentsId) pending.controller.abort(new Error("Terminal window closed."));
    }
    for (const session of [...sessions.values()]) {
      if (session.webContentsId === webContentsId) dispose(session.id);
    }
  }

  function disposeAll() {
    for (const pending of pendingCreates.values()) pending.controller.abort(new Error("Explore Better is closing."));
    for (const sessionId of [...sessions.keys()]) dispose(sessionId);
  }

  async function waitForIdle(timeoutMs = 8000) {
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    try {
      const settled = await Promise.race([
        (async () => {
          await Promise.allSettled([...pendingCreates.values()].map((pending) => pending.done));
          await Promise.allSettled([...retiring]);
          return sessions.size === 0 && pendingCreates.size === 0 && retiring.size === 0;
        })(),
        deadline
      ]);
      return settled;
    } finally { clearTimeout(timer); }
  }

  function writeForSmoke(data) {
    const session = sessions.values().next().value;
    if (!session) return false;
    session.busy = true;
    session.send({ type: "busy", busy: true });
    session.adapter.write(String(data || ""));
    return true;
  }

  function outputForSmoke() {
    return [...sessions.values()].map((session) => session.recentOutput).join("\n");
  }

  function firstSessionForSmoke() {
    return sessions.values().next().value || null;
  }

  return {
    capabilities: () => ({ available: process.platform === "win32", profiles: publicProfiles(), defaultProfileId: publicProfiles()[0]?.id || "", elevationAvailable: process.platform === "win32" }),
    create,
    restart,
    syncDirectory,
    disposeForEvent,
    disposeWebContents,
    disposeAll,
    waitForIdle,
    writeForSmoke,
    outputForSmoke,
    profileForSmoke: () => {
      const profile = firstSessionForSmoke()?.profile;
      return profile ? { id: profile.id, kind: profile.kind, label: profile.label } : null;
    },
    syncForSmoke: (cwd) => {
      const session = firstSessionForSmoke();
      return session ? syncSessionDirectory(session, cwd) : null;
    },
    cwdForSmoke: () => firstSessionForSmoke()?.cwd || "",
    sessionCount: () => sessions.size
  };
}

export function terminalBrokerManifestFromArgv(argv = process.argv) {
  return argv.find((value) => value.startsWith("--terminal-broker-manifest="))?.slice("--terminal-broker-manifest=".length) || "";
}

export async function runTerminalBroker(manifestPath, { createAdapter = createLocalAdapter, shutdownTimeoutMs = 8000 } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await rm(manifestPath, { force: true }).catch(() => {});
  if (manifest?.version !== 1 || !manifest.pipeName || !manifest.nonce || Date.now() - Number(manifest.createdAt) > BROKER_TIMEOUT_MS * 2) {
    throw new Error("Invalid or expired administrator terminal manifest.");
  }
  const profile = profileById(String(manifest.profileId || ""));
  if (!profile || !profile.file || !existsSync(profile.file) || !["powershell", "cmd"].includes(profile.kind)) throw new Error("Invalid administrator terminal profile.");
  const options = { profile, cwd: manifest.cwd, cols: clampDimension(manifest.cols, 100), rows: clampDimension(manifest.rows, 28) };
  // The broker owns normal pipe closure so a kill request can receive the
  // actual native exit before either side closes the connection.
  const socket = net.createConnection({ path: manifest.pipeName, allowHalfOpen: true });
  const controller = new AbortController();
  let adapter;
  let failure;
  let nativeExited = false;
  let transportClosed = false;
  let nativeExit;
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  const closed = new Promise((resolve) => { socket.once("close", resolve); });
  const stop = () => {
    controller.abort();
    resolveStopped();
  };
  const fail = (error) => { failure ||= error; stop(); };
  const closeTransport = () => { transportClosed = true; stop(); };
  const send = (message) => {
    if (transportClosed || !socket.writable || socket.destroyed) return;
    try { sendJson(socket, message); } catch (error) { fail(error); }
  };
  socket.on("error", (error) => { transportClosed = true; fail(error); });
  socket.on("end", closeTransport);
  socket.on("close", closeTransport);
  const consume = parseJsonLines((message) => {
    if (message?.type === "kill") return stop();
    if (!adapter || controller.signal.aborted) return;
    if (message?.type === "write") adapter.write(Buffer.from(String(message.data || ""), "base64").toString("utf8"));
    if (message?.type === "resize") adapter.resize(clampDimension(message.cols, 100), clampDimension(message.rows, 28));
  });
  // Listen before spawning, including while the native module is loading.
  socket.on("data", (chunk) => { try { consume(chunk); } catch (error) { fail(error); socket.destroy(); } });
  const connectionTimer = setTimeout(() => {
    fail(new Error("Administrator terminal connection timed out."));
    socket.destroy();
  }, BROKER_TIMEOUT_MS);
  const onData = (data) => send({ type: "data", data: Buffer.from(data).toString("base64") });
  const onError = (error) => { send({ type: "error", message: error.message }); fail(error); };
  try {
    await Promise.race([once(socket, "connect"), stopped]);
    clearTimeout(connectionTimer);
    if (controller.signal.aborted) throw failure || new Error("Administrator terminal connection closed.");
    adapter = await createAdapter(options, undefined, controller.signal);
    adapter.on("data", onData);
    adapter.on("error", onError);
    nativeExit = Promise.resolve(adapter.exited || once(adapter, "exit").then(([event]) => event)).then((event) => {
      nativeExited = true;
      send({ type: "exit", exitCode: event.exitCode, signal: event.signal });
      stop();
      return true;
    }, (error) => { fail(error); return false; });
    if (!controller.signal.aborted) {
      send({ type: "hello", nonce: manifest.nonce, parentPid: manifest.parentPid, pid: adapter.pid });
      adapter.activate?.();
    }
    await stopped;
  } catch (error) {
    fail(error);
  } finally {
    clearTimeout(connectionTimer);
    stop();
    if (adapter) {
      if (!nativeExited) {
        try { adapter.kill(); } catch (error) { failure ||= error; }
      }
      let timer;
      const completed = await Promise.race([
        nativeExit,
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), shutdownTimeoutMs); })
      ]);
      clearTimeout(timer);
      if (!completed) failure ||= new Error("Administrator terminal native exit timed out during cleanup.");
      adapter.off("data", onData);
      adapter.off("error", onError);
    }
    if (!socket.destroyed) {
      let timer;
      socket.end();
      await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, 500); })]);
      clearTimeout(timer);
      socket.destroy();
    }
  }
  if (failure) throw failure;
}
