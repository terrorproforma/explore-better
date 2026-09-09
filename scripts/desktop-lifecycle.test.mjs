import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createDesktopEventDispatcher } from "../lib/desktop-events.mjs";

const main = await readFile(process.env.EB_DESKTOP_MAIN_SOURCE || new URL("../electron-main.mjs", import.meta.url), "utf8");
const preload = await readFile(process.env.EB_DESKTOP_PRELOAD_SOURCE || new URL("../electron-preload.cjs", import.meta.url), "utf8");
const backend = await readFile(process.env.EB_DESKTOP_BACKEND_SOURCE || new URL("../server.mjs", import.meta.url), "utf8");
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function functions(from, to) { return main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from))); }
function preloadHarness() {
  let api;
  const ipc = new EventEmitter();
  ipc.sent = [];
  ipc.send = (...args) => ipc.sent.push(args);
  ipc.invoke = async () => true;
  vm.runInNewContext(preload, { require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, webUtils: {} }) });
  const port = id => {
    const value = { closes: 0, start() {}, postMessage() {}, close() { this.closes++; } };
    ipc.emit("explore-better:terminal-port", { ports: [value] }, { sessionId: id });
    return value;
  };
  return { api, ipc, port };
}

test("naturally exited terminals release preload ports and stop accepting input", () => {
  const h = preloadHarness();
  const seen = [];
  h.api.terminal.onEvent(message => seen.push(message.type));
  for (let index = 0; index < 30; index++) {
    const id = `session-${index}`, port = h.port(id);
    assert.equal(h.api.terminal.write(id, "hello"), true);
    port.onmessage({ data: { type: "exit", sessionId: id, exitCode: 0 } });
    assert.equal(port.closes, 1);
    assert.equal(h.api.terminal.write(id, "late input"), false);
  }
  assert.equal(seen.length, 30);
});

test("disposal releases preload resources even when the backend session has already gone", async () => {
  const h = preloadHarness(), port = h.port("gone");
  h.ipc.invoke = async () => { throw new Error("Unknown terminal session."); };
  await assert.rejects(h.api.terminal.dispose("gone"), /Unknown/);
  assert.equal(port.closes, 1);
  assert.equal(h.api.terminal.resize("gone", 80, 24), false);
});

test("desktop events wait for registration, execute in order and acknowledge completion", async () => {
  const h = preloadHarness(), gate = deferred(), order = [];
  h.ipc.emit("explore-better:desktop-event", {}, { requestId: "first", type: "shell-open", payload: { targetPath: "first" } });
  h.ipc.emit("explore-better:desktop-event", {}, { requestId: "second", type: "shell-open", payload: { targetPath: "second" } });
  h.api.onShellOpen(async payload => { order.push(payload.targetPath); if (payload.targetPath === "first") await gate.promise; return "done"; });
  await tick();
  assert.deepEqual(order, ["first"]);
  assert.equal(h.ipc.sent.length, 0);
  gate.resolve(); await tick();
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(h.ipc.sent.length, 2);
  assert.equal(h.ipc.sent[1][1].requestId, "second");
  h.ipc.emit("explore-better:desktop-event", {}, { requestId: "cancel", type: "backend-recovered" });
  h.ipc.emit("explore-better:desktop-event-cancel", {}, { requestId: "cancel" });
  h.api.onBackendRecovered(() => { throw new Error("Canceled event executed"); });
  await tick(); assert.equal(h.ipc.sent.length, 2);
});

function eventHarness(options = {}) {
  const contents = new EventEmitter();
  Object.assign(contents, { mainFrame: {}, loading: true, sent: [], isDestroyed: () => false,
    isLoadingMainFrame() { return this.loading; }, send(...args) { this.sent.push(args); } });
  const dispatcher = createDesktopEventDispatcher({ getWindow: () => ({ isDestroyed: () => false, webContents: contents }), ...options });
  return { contents, dispatcher };
}

test("canceling a desktop action waiting for renderer readiness prevents late navigation", async () => {
  const h = preloadHarness(), gate = deferred(); let navigated = false;
  h.api.onShellOpen(async (_payload, control) => { await gate.promise; if (!control.isCanceled()) navigated = true; });
  h.ipc.emit("explore-better:desktop-event", {}, { requestId: "waiting", type: "shell-open", payload: {} });
  h.ipc.emit("explore-better:desktop-event-cancel", {}, { requestId: "waiting" });
  gate.resolve(); await tick();
  assert.equal(navigated, false);
});

test("desktop actions survive initial loading and only the receiving frame can acknowledge", async () => {
  const { contents, dispatcher } = eventHarness();
  const result = dispatcher.send("shell-open", { targetPath: "fixture" });
  dispatcher.cancel(contents, "initial navigation committed", { deliveredOnly: true });
  assert.equal(contents.sent.length, 0);
  contents.loading = false; contents.emit("did-finish-load");
  const requestId = contents.sent[0][1].requestId;
  assert.equal(dispatcher.settle({ sender: contents, senderFrame: {} }, { requestId }), false);
  assert.equal(dispatcher.settle({ sender: contents, senderFrame: contents.mainFrame }, { requestId, result: true }), true);
  assert.equal(await result, true);
  assert.equal(contents.listenerCount("did-fail-load"), 0);
});

test("desktop actions are bounded and canceled when their document closes", async () => {
  const { contents, dispatcher } = eventHarness({ maximumPending: 1 });
  const first = dispatcher.send("shell-open", {});
  const rejected = assert.rejects(first, /closed/);
  await assert.rejects(dispatcher.send("shell-open", {}), /Too many/);
  dispatcher.cancel(contents);
  await rejected;
  assert.equal(contents.listenerCount("did-finish-load"), 0);
});

test("concurrent updater initialization binds each event once", async () => {
  const gate = deferred(), updater = new EventEmitter();
  updater.setFeedURL = () => {};
  let imports = 0;
  const context = { autoUpdateConfigurationPromise: null, autoUpdatesConfigured: false, noUpdatesMode: false,
    updateFeedUrl: "http://127.0.0.1/fixture", smokeUpdateFeedMode: false, forceDevUpdateConfig: false,
    autoUpdater: null, updateStatus: () => ({}), rememberUpdateEvent() {}, redactedUpdateFeedUrl: () => "fixture",
    loadUpdater: async () => { imports++; await gate.promise; return { autoUpdater: updater }; } };
  vm.runInNewContext(functions("async function configureAutoUpdates(", "\nfunction startNativeFileDrag(").replace('await import("electron-updater")', "await loadUpdater()"), context);
  const calls = [context.configureAutoUpdates(), context.configureAutoUpdates()];
  gate.resolve(); await Promise.all(calls);
  assert.equal(imports, 1);
  for (const name of ["checking-for-update", "update-available", "update-not-available", "download-progress", "update-downloaded", "update-cancelled", "error"]) assert.equal(updater.listenerCount(name), 1, name);
});

test("concurrent desktop startup chooses one loopback port", async () => {
  const gate = deferred(); let probes = 0;
  const context = { desktopPortPromise: null, port: 0, baseUrl: "", host: "127.0.0.1", process: { env: {} },
    http: { createServer() { const selected = 50000 + probes++; return { unref() {}, once() {}, listen(_port, _host, callback) { gate.promise.then(callback); }, address: () => ({ port: selected }), close: callback => callback() }; } } };
  vm.runInNewContext(functions("async function ensureDesktopPort(", "\nfunction isLikelyPathArgument("), context);
  const calls = [context.ensureDesktopPort(), context.ensureDesktopPort()];
  gate.resolve(); const values = await Promise.all(calls);
  assert.equal(probes, 1);
  assert.equal(values[0], values[1]);
});

function mcpContext(gate) {
  let created = 0;
  const context = { desktopClosing: false, mcpBridgeStartPromise: null, mcpBridgeService: null,
    ensureMcpBackendModule: async () => { await gate.promise; return {}; },
    createMcpBridgeService: () => { created++; return { start: async () => ({ clients: 0 }), stop: async () => {}, status: () => ({ running: true }) }; },
    app: { getVersion: () => "test", getAppPath: () => "test" }, process: { execPath: "test" },
    dispatchMcpUiAction() {}, handleMcpConnectionCount() {}, ensureMcpTray() {}, scheduleMcpHeadlessExit() {} };
  vm.runInNewContext(functions("async function ensureMcpBridge(", '\nipcMain.on("explore-better:mcp-context"'), context);
  return { context, created: () => created };
}

test("desktop shutdown waits for embedded filesystem helper cleanup after closing HTTP", async () => {
  const gate = deferred(), events = [];
  const context = { serverProcess: null, desktopServerStartPromise: null, backendRecoveryPromise: null, stopBackendMonitor() {}, closeEmbeddedServer: async () => events.push("http-closed"),
    stopChildBackendProcess: async () => {},
    embeddedServerModule: { stopServer: async () => { events.push("helper-stopping"); await gate.promise; events.push("helper-stopped"); } } };
  vm.runInNewContext(functions("async function stopServer(", "\nasync function exitSmoke("), context);
  let finished = false;
  const stopped = context.stopServer().then(() => { finished = true; });
  await tick(); assert.deepEqual(events, ["http-closed", "helper-stopping"]); assert.equal(finished, false);
  gate.resolve(); await stopped; assert.equal(finished, true);
});

test("concurrent desktop MCP startup creates one bridge", async () => {
  const gate = deferred(), h = mcpContext(gate);
  const calls = [h.context.ensureMcpBridge(), h.context.ensureMcpBridge()];
  gate.resolve(); await Promise.all(calls);
  assert.equal(h.created(), 1);
});

test("shutdown during desktop MCP setup cannot create a late bridge", async () => {
  const gate = deferred(), h = mcpContext(gate);
  const pending = h.context.ensureMcpBridge();
  h.context.desktopClosing = true; gate.resolve();
  await assert.rejects(pending, /closing/);
  assert.equal(h.created(), 0);
});

test("activating an existing desktop does not reload it", async () => {
  const events = []; let reloads = 0;
  const context = { mainWindow: { isMinimized: () => false, focus() {}, webContents: { isCrashed: () => false }, loadURL: async () => { reloads++; } },
    ensureServer: async () => {}, ensureMcpBridge: async () => {}, startBackendMonitor() {}, listerUrl: () => "fixture-url",
    desktopEvents: { send: async (...args) => events.push(args) } };
  vm.runInNewContext(functions("async function showLister(", "\nasync function rendererShellOpenSnapshot("), context);
  await context.showLister();
  await context.showLister("fixture-folder", "activeNewTab");
  assert.equal(reloads, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "shell-open");
});

const baseUpdaterSource = await readFile(new URL("../node_modules/electron-updater/out/BaseUpdater.js", import.meta.url), "utf8");

function updateShutdownHarness({ dirty = false, choice = 0 } = {}) {
  const app = new EventEmitter(), contents = new EventEmitter(), calls = [], handlers = new Map();
  const terminal = deferred(), bridge = deferred(), backend = deferred();
  let windowOpen = true;
  const fixture = { dirty, choice };
  app.quit = () => {
    calls.push({ type: "quit-request" });
    if (windowOpen && fixture.dirty) {
      let allowed = false;
      contents.emit("will-prevent-unload", { preventDefault() { allowed = true; } });
      if (!allowed) return;
    }
    if (windowOpen) { windowOpen = false; calls.push({ type: "window-closed" }); }
    let prevented = false;
    app.emit("will-quit", { preventDefault() { prevented = true; } });
    if (!prevented) { calls.push({ type: "quit" }); app.emit("quit", {}, 0); }
  };
  // Exercise the installed updater's real quit/installation ordering. Its only
  // installer hook is a fixture; no executable or downloaded update is used.
  const module = { exports: {} };
  vm.runInNewContext(baseUpdaterSource, { exports: module.exports, setImmediate,
    require(id) {
      if (id === "./AppUpdater") return { AppUpdater: class {} };
      if (id === "electron") return { autoUpdater: new EventEmitter() };
      return {};
    }
  });
  const updater = new module.exports.BaseUpdater();
  Object.assign(updater, { _logger: { info() {}, warn() {} }, autoInstallOnAppQuit: true, autoRunAppAfterInstall: true,
    app: { quit: app.quit, onQuit: listener => app.on("quit", (_event, code) => listener(code)) },
    downloadedUpdateHelper: { file: "fixture-installer-never-executed", downloadedFileInfo: {} },
    doInstall(options) { calls.push({ type: "install", ...options }); return true; },
    dispatchError(error) { calls.push({ type: "updater-error", error }); } });
  updater.addQuitHandler();
  const context = { app, mainWindow: { webContents: contents }, dialog: { showMessageBoxSync: () => fixture.choice },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, rendererIsTrusted: () => true,
    configureAutoUpdates: async () => {}, autoUpdater: updater, autoUpdateDownloaded: true, autoUpdateVersion: "fixture",
    autoUpdateInstallRequested: false, desktopClosing: false, updateStatus: () => ({}),
    rememberUpdateEvent: (...args) => calls.push({ type: "update-event", args }),
    desktopEvents: { cancel() {} }, mcpHeadlessExitTimer: null, mcpUiRequests: new Map(), mcpTray: null,
    terminalService: { disposeAll() { calls.push({ type: "cleanup-start" }); }, waitForIdle: () => terminal.promise },
    mcpBridgeService: { stop: () => bridge.promise }, mcpBridgeStartPromise: null,
    stopBackendMonitor() {}, stopServer: () => backend.promise, setImmediate, clearTimeout };
  vm.runInNewContext(functions('ipcMain.handle("explore-better:install-update"', '\nipcMain.handle("explore-better:backend-status"'), context);
  vm.runInNewContext(functions('  mainWindow.webContents.on("will-prevent-unload"', '  mainWindow.webContents.session.setPermissionCheckHandler'), context);
  vm.runInNewContext(main.slice(main.indexOf("  let shutdownComplete = false;"), main.lastIndexOf("\n}")), context);
  return { app, fixture, calls, terminal, bridge, backend, context,
    request: () => handlers.get("explore-better:install-update")({}),
    finish(value = true) { terminal.resolve(value); bridge.resolve(); backend.resolve(); } };
}

test("explicit update waits for approved window closure and every cleanup task", async () => {
  const h = updateShutdownHarness({ dirty: true, choice: 1 });
  assert.equal((await h.request()).accepted, true);
  await tick();
  assert.equal(h.calls.some(call => call.type === "window-closed"), true);
  assert.equal(h.calls.some(call => call.type === "install"), false);
  h.terminal.resolve(true); h.backend.resolve(); await tick();
  assert.equal(h.calls.some(call => call.type === "install"), false, "bridge cleanup is still pending");
  h.bridge.resolve(); await tick();
  const installs = h.calls.filter(call => call.type === "install");
  assert.equal(installs.length, 1);
  assert.equal(installs[0].isSilent, false);
  assert.equal(installs[0].isForceRunAfter, true, "explicit installation retains relaunch");
});

test("keeping an unsaved draft cancels explicit installation and preserves ordinary auto-install", async () => {
  const h = updateShutdownHarness({ dirty: true });
  await h.request(); await tick();
  assert.equal(h.calls.some(call => call.type === "install" || call.type === "cleanup-start"), false);
  h.fixture.dirty = false;
  h.app.quit(); h.finish(); await tick();
  const installs = h.calls.filter(call => call.type === "install");
  assert.equal(installs.length, 1);
  assert.equal(installs[0].isSilent, true);
  assert.equal(installs[0].isForceRunAfter, false, "later ordinary quit does not inherit a canceled relaunch");
});

test("an update can be requested again after keeping the draft and duplicate clicks share cleanup", async () => {
  const h = updateShutdownHarness({ dirty: true });
  await h.request(); await tick();
  h.fixture.choice = 1;
  await Promise.all([h.request(), h.request()]); await tick();
  assert.equal(h.calls.filter(call => call.type === "cleanup-start").length, 1);
  assert.equal(h.calls.some(call => call.type === "install"), false);
  h.finish(); await tick();
  assert.equal(h.calls.filter(call => call.type === "install").length, 1);
});

test("failed native cleanup suppresses explicit and automatic update installers", async () => {
  for (const explicit of [false, true]) {
    const h = updateShutdownHarness();
    if (explicit) { await h.request(); await tick(); } else h.app.quit();
    h.finish(false); await tick();
    assert.equal(h.calls.some(call => call.type === "quit"), true);
    assert.equal(h.calls.some(call => call.type === "install"), false);
    assert.equal(h.calls.some(call => call.type === "update-event" && call.args[0] === "error"), true);
  }
});

function backendFunctions(from, to) { return backend.slice(backend.indexOf(from), backend.indexOf(to, backend.indexOf(from))); }

function nativeCleanupHarness({ stateReady = Promise.resolve(), killError = null } = {}) {
  const children = [], timers = new Map(), calls = [];
  const server = new EventEmitter();
  server.listening = false;
  server.listen = () => { server.listening = true; calls.push("http-opened"); queueMicrotask(() => server.emit("listening")); };
  server.close = callback => { server.listening = false; calls.push("http-closed"); callback(); };
  const context = { server, nativeFilesystemHelperPath: () => "fixture-helper-never-executed",
    readCachedState: () => stateReady, syncBackgroundIndexWatchersFromState: async () => {},
    monotonicMs: () => 0, host: "fixture", port: 0, console: { log() {}, warn() {} },
    setTimeout(callback) { const id = {}; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    spawn() {
      const child = new EventEmitter();
      Object.assign(child, { exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(), kills: 0,
        stdin: { destroyed: false, end() { calls.push("helper-input-ended"); } },
        kill() { child.kills++; if (killError) throw killError; return true; },
        finish() { child.exitCode = 0; child.emit("exit", 0); child.emit("close", 0); } });
      children.push(child);
      return child;
    }
  };
  context.warmNativeFilesystemHelper = async () => context.ensureNativeFilesystemHelperClient();
  const lifecycle = backendFunctions("let serverStartPromise = null;", "\nlet mcpAutomationServicePromise")
    .replace(/^export \{[^\n]+\};\r?\n/gm, "").replace(/\bexport /g, "");
  vm.runInNewContext(backendFunctions("let nativeFilesystemHelperClientState = null;", "\nfunction nativeFilesystemHelperRequest(") +
    backendFunctions("function stopNativeFilesystemHelperClient()", "\nfunction shouldWarmNativeFilesystemHelper()") + lifecycle, context);
  return { context, children, server, calls, expire() { for (const callback of [...timers.values()]) callback(); } };
}

test("backend stop waits for native child close and permits a later explicit restart", async () => {
  const h = nativeCleanupHarness();
  h.context.ensureNativeFilesystemHelperClient();
  let finished = false;
  const stopped = h.context.stopServer();
  assert.equal(h.context.stopServer(), stopped, "concurrent cleanup shares one promise");
  stopped.then(() => { finished = true; });
  await tick();
  assert.equal(h.children[0].kills, 1);
  assert.equal(finished, false, "requesting termination does not prove native teardown finished");
  h.children[0].finish(); await stopped;
  assert.equal(finished, true);
  assert.throws(() => h.context.ensureNativeFilesystemHelperClient(), /stopped/);
  await h.context.startServer();
  assert.equal(h.server.listening, true);
  assert.equal(h.children.length, 2);
  const restartedStop = h.context.stopServer(); await tick();
  h.children[1].finish(); await restartedStop;
});

test("backend stop includes retired helpers after their request state has failed", async () => {
  const h = nativeCleanupHarness();
  const old = h.context.ensureNativeFilesystemHelperClient();
  h.context.failNativeFilesystemHelperClient(old, new Error("Fixture response failed"));
  h.context.ensureNativeFilesystemHelperClient();
  let finished = false;
  const stopped = h.context.stopServer().then(() => { finished = true; });
  await tick();
  assert.deepEqual(h.children.map(child => child.kills), [1, 1]);
  h.children[1].finish(); await tick();
  assert.equal(finished, false);
  h.children[0].finish(); await stopped;
});

test("backend stop waits for an in-flight start before closing HTTP and its helper", async () => {
  const gate = deferred(), h = nativeCleanupHarness({ stateReady: gate.promise });
  const started = h.context.startServer();
  let finished = false;
  const stopped = h.context.stopServer().then(() => { finished = true; });
  await tick(); assert.equal(finished, false);
  gate.resolve(); await started; await tick();
  assert.deepEqual(h.calls.slice(0, 2), ["http-opened", "http-closed"]);
  assert.equal(h.server.listening, false);
  assert.equal(finished, false);
  h.children[0].finish(); await stopped;
});

test("native cleanup timeout and termination failure propagate and suppress installation", async () => {
  for (const failure of ["timeout", "termination"]) {
    const h = nativeCleanupHarness({ killError: failure === "termination" ? new Error("Fixture termination failed") : null });
    h.context.ensureNativeFilesystemHelperClient();
    const result = h.context.stopServer().then(() => null, error => error);
    await tick(); h.expire();
    const error = await result;
    assert.match(error?.message || "", failure === "timeout" ? /did not exit/ : /termination failed/);
    const desktop = updateShutdownHarness();
    await desktop.request(); await tick();
    desktop.terminal.resolve(true); desktop.bridge.resolve(); desktop.backend.resolve(Promise.reject(error));
    await tick();
    assert.equal(desktop.calls.some(call => call.type === "install"), false);
    assert.equal(desktop.calls.some(call => call.type === "update-event" && call.args[0] === "error"), true);
    h.children[0].finish();
  }
});

test("child backend shutdown IPC waits for cleanup and reports failures through its exit code", async () => {
  for (const fail of [false, true]) {
    const gate = deferred(), child = new EventEmitter(), exits = [], errors = [];
    child.send = () => {};
    child.exit = code => exits.push(code);
    let stops = 0;
    const context = { invokedPath: "fixture", modulePath: "fixture", process: child, console: { error: error => errors.push(error) },
      startServer: async () => {}, stopServer: async () => { stops++; await gate.promise; if (fail) throw new Error("Fixture cleanup failed"); } };
    vm.runInNewContext(backend.slice(backend.indexOf("if (invokedPath === modulePath) {")), context);
    child.emit("message", { type: "unrelated-fixture-message" });
    assert.equal(stops, 0);
    child.emit("message", { type: "explore-better:shutdown" });
    child.emit("message", { type: "explore-better:shutdown" });
    await tick(); assert.equal(stops, 1); assert.deepEqual(exits, []);
    gate.resolve(); await tick();
    assert.deepEqual(exits, [fail ? 1 : 0]);
    assert.equal(errors.length, fail ? 1 : 0);
  }
});
