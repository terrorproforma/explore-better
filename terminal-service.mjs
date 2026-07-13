import { EventEmitter, once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const MAX_INPUT_BYTES = 256 * 1024;
const MAX_DIMENSION = 1000;
const OUTPUT_BATCH_BYTES = 128 * 1024;
const BROKER_TIMEOUT_MS = 20000;
const idleMarkerPattern = /\x1b\]633;EB;idle(?:\x07|\x1b\\)/g;
const cwdMarkerPatterns = [
  /\x1b\]9;9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g,
  /\x1b\]7;file:\/\/\/([^\x07\x1b]*)(?:\x07|\x1b\\)/g
];

function cleanCwdMarker(value) {
  const decoded = decodeURIComponent(String(value || "")).replace(/^\/+([A-Za-z]:)/, "$1");
  return decoded.replaceAll("/", path.sep);
}

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
  if (profile.kind === "cmd") {
    env.PROMPT = "$E]633;EB;idle$E\\$E]9;9;$P$E\\$P$G";
  }
  return env;
}

async function loadNodePty() {
  const module = await import("node-pty");
  return module.default || module;
}

async function createLocalAdapter(options) {
  const nodePty = await loadNodePty();
  const emitter = new EventEmitter();
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
  pty.onData((data) => emitter.emit("data", data));
  pty.onExit((event) => emitter.emit("exit", event));
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
  return (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > MAX_INPUT_BYTES * 8) throw new Error("Terminal broker message exceeded its limit.");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) onMessage(JSON.parse(line));
      newline = buffer.indexOf("\n");
    }
  };
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function createElevatedAdapter(options, runtime) {
  const emitter = new EventEmitter();
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
  const server = net.createServer((candidate) => {
    if (socket) return candidate.destroy();
    const consume = parseJsonLines((message) => {
      if (!socket) {
        if (message?.type !== "hello" || message?.nonce !== nonce || message?.parentPid !== process.pid) {
          candidate.destroy();
          return;
        }
        socket = candidate;
        settled = true;
        emitter.emit("ready", { pid: message.pid });
        return;
      }
      if (message?.type === "data") emitter.emit("data", Buffer.from(String(message.data || ""), "base64").toString("utf8"));
      if (message?.type === "exit") emitter.emit("exit", { exitCode: message.exitCode, signal: message.signal });
      if (message?.type === "error") emitter.emit("error", new Error(String(message.message || "Elevated terminal failed.")));
    });
    candidate.on("data", (chunk) => {
      try { consume(chunk); } catch (error) { emitter.emit("error", error); candidate.destroy(); }
    });
    candidate.on("close", () => {
      if (socket === candidate) emitter.emit("disconnect");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName, resolve);
  });

  const brokerArg = `--terminal-broker-manifest=${manifestPath}`;
  const launchArgs = runtime.packaged ? [brokerArg] : [runtime.appPath, brokerArg];
  const command = `Start-Process -FilePath ${psQuote(runtime.executablePath)} -Verb RunAs -WindowStyle Hidden -ArgumentList @(${launchArgs.map(psQuote).join(",")})`;
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
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Administrator terminal connection timed out.")), BROKER_TIMEOUT_MS));
  try {
    await Promise.race([once(emitter, "ready"), launchFailure, timeout]);
  } catch (error) {
    server.close();
    socket?.destroy();
    await rm(manifestPath, { force: true }).catch(() => {});
    throw error;
  }
  await rm(manifestPath, { force: true }).catch(() => {});

  return Object.assign(emitter, {
    pid: null,
    write(data) { if (socket?.writable) sendJson(socket, { type: "write", data: Buffer.from(data).toString("base64") }); },
    resize(cols, rows) { if (socket?.writable) sendJson(socket, { type: "resize", cols, rows }); },
    kill() {
      if (socket?.writable) sendJson(socket, { type: "kill" });
      socket?.end();
      server.close();
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
  for (const pattern of cwdMarkerPatterns) {
    let match;
    while ((match = pattern.exec(markerData))) {
      const cwd = cleanCwdMarker(match[1]);
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
    session.adapter.write(quoteDirectory(session.profile, pending));
  }
}

export function createTerminalService({ MessageChannelMain, getMainWindow, getBaseUrl, runtime }) {
  const sessions = new Map();
  const tabSessions = new Map();

  function trusted(event) {
    const window = getMainWindow();
    if (!window || event.sender !== window.webContents) return false;
    try { return new URL(event.senderFrame.url).origin === new URL(getBaseUrl()).origin; } catch { return false; }
  }

  async function create(event, rawRequest, replacementSessionId = "") {
    if (!trusted(event)) throw new Error("Untrusted terminal sender.");
    const options = await validateCreateRequest(rawRequest);
    const tabKey = `${event.sender.id}:${options.tabId}`;
    const existingSessionId = tabSessions.get(tabKey) || "";
    if (existingSessionId && existingSessionId !== replacementSessionId) throw new Error("This tab already owns a terminal.");
    const sessionId = randomUUID();
    const channel = new MessageChannelMain();
    const adapter = options.elevation === "administrator"
      ? await createElevatedAdapter(options, runtime)
      : await createLocalAdapter(options);
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
      if (runtime.debug) console.log(`Explore Better PTY data: ${JSON.stringify(String(data).slice(0, 240))}`);
      inspectMarkers(session, data);
      session.recentOutput = `${session.recentOutput}${data}`.slice(-1024 * 1024);
      session.output += data;
      if (Buffer.byteLength(session.output) >= OUTPUT_BATCH_BYTES) flush();
      else if (!session.outputTimer) session.outputTimer = setTimeout(flush, 8);
    });
    adapter.on("exit", ({ exitCode, signal }) => {
      if (runtime.debug) console.log(`Explore Better PTY exit: code=${exitCode} signal=${signal}`);
      flush();
      session.send({ type: "exit", exitCode: Number(exitCode ?? 0), signal: Number(signal ?? 0) });
      dispose(sessionId, { kill: false });
    });
    adapter.on("error", (error) => session.send({ type: "error", message: error.message }));
    channel.port1.on("message", (messageEvent) => handlePortMessage(session, messageEvent.data));
    channel.port1.start();
    event.senderFrame.postMessage("explore-better:terminal-port", { sessionId }, [channel.port2]);
    session.send({ type: "ready", profileId: options.profile.id, profileLabel: options.profile.label, elevation: options.elevation, cwd: options.cwd, pid: adapter.pid });
    return { sessionId, profileId: options.profile.id, profileLabel: options.profile.label, elevation: options.elevation, cwd: options.cwd };
  }

  function ownSession(event, sessionId) {
    if (!trusted(event)) throw new Error("Untrusted terminal sender.");
    const session = sessions.get(String(sessionId || ""));
    if (!session || session.webContentsId !== event.sender.id) throw new Error("Unknown terminal session.");
    return session;
  }

  function handlePortMessage(session, message) {
    if (!sessions.has(session.id) || !message || typeof message !== "object") return;
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
  }

  function syncSessionDirectory(session, rawCwd) {
    const cwd = String(rawCwd || "");
    if (!cwd || /[\0\r\n]/.test(cwd)) throw new Error("Terminal sync folder does not exist.");
    const normalizedCwd = path.resolve(cwd);
    let directory = false;
    try { directory = statSync(normalizedCwd).isDirectory(); } catch {}
    if (!directory) throw new Error("Terminal sync folder does not exist.");
    if (session.busy || !session.promptReady) {
      session.pendingCwd = normalizedCwd;
      session.send({ type: "sync-pending", cwd: normalizedCwd });
      return { queued: true, cwd: normalizedCwd };
    }
    session.pendingCwd = "";
    session.adapter.write(quoteDirectory(session.profile, normalizedCwd));
    return { queued: false, cwd: normalizedCwd };
  }

  function syncDirectory(event, sessionId, rawCwd) {
    return syncSessionDirectory(ownSession(event, sessionId), rawCwd);
  }

  function dispose(sessionId, { kill = true } = {}) {
    const session = sessions.get(String(sessionId || ""));
    if (!session) return false;
    sessions.delete(session.id);
    tabSessions.delete(session.tabKey);
    if (session.outputTimer) clearTimeout(session.outputTimer);
    if (kill) {
      try { session.adapter.kill(); } catch {}
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
    for (const session of [...sessions.values()]) {
      if (session.webContentsId === webContentsId) dispose(session.id);
    }
  }

  function disposeAll() {
    for (const sessionId of [...sessions.keys()]) dispose(sessionId);
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

export async function runTerminalBroker(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await rm(manifestPath, { force: true }).catch(() => {});
  if (manifest?.version !== 1 || !manifest.pipeName || !manifest.nonce || Date.now() - Number(manifest.createdAt) > BROKER_TIMEOUT_MS * 2) {
    throw new Error("Invalid or expired administrator terminal manifest.");
  }
  const profile = profileById(String(manifest.profileId || ""));
  if (!profile || !profile.file || !existsSync(profile.file) || !["powershell", "cmd"].includes(profile.kind)) throw new Error("Invalid administrator terminal profile.");
  const options = { profile, cwd: manifest.cwd, cols: clampDimension(manifest.cols, 100), rows: clampDimension(manifest.rows, 28) };
  const adapter = await createLocalAdapter(options);
  const socket = net.createConnection(manifest.pipeName);
  await once(socket, "connect");
  sendJson(socket, { type: "hello", nonce: manifest.nonce, parentPid: manifest.parentPid, pid: adapter.pid });
  adapter.on("data", (data) => sendJson(socket, { type: "data", data: Buffer.from(data).toString("base64") }));
  adapter.on("exit", ({ exitCode, signal }) => {
    sendJson(socket, { type: "exit", exitCode, signal });
    socket.end();
  });
  const consume = parseJsonLines((message) => {
    if (message?.type === "write") adapter.write(Buffer.from(String(message.data || ""), "base64").toString("utf8"));
    if (message?.type === "resize") adapter.resize(clampDimension(message.cols, 100), clampDimension(message.rows, 28));
    if (message?.type === "kill") adapter.kill();
  });
  socket.on("data", (chunk) => { try { consume(chunk); } catch { adapter.kill(); socket.destroy(); } });
  socket.on("close", () => adapter.kill());
  await Promise.race([once(adapter, "exit"), once(socket, "close")]);
}
