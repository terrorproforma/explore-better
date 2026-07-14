import { app, BrowserWindow, ipcMain, Menu, MessageChannelMain, nativeImage, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTerminalService,
  runTerminalBroker,
  terminalBrokerManifestFromArgv
} from "./terminal-service.mjs";
import { createMcpBridgeService } from "./mcp-bridge-service.mjs";
import { createMcpClientConfigurator } from "./mcp-client-config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const terminalBrokerManifest = terminalBrokerManifestFromArgv();
const terminalBrokerMode = Boolean(terminalBrokerManifest);
const host = process.env.HOST || "127.0.0.1";
let port = Number(process.env.PORT || 0);
const desktopInstanceToken =
  process.env.EXPLORE_BETTER_DESKTOP_INSTANCE_TOKEN || randomBytes(24).toString("base64url");
const backendApiCapability =
  process.env.EXPLORE_BETTER_API_CAPABILITY || randomBytes(32).toString("base64url");
process.env.HOST = host;
if (port > 0) process.env.PORT = String(port);
process.env.EXPLORE_BETTER_DESKTOP_INSTANCE_TOKEN = desktopInstanceToken;
process.env.EXPLORE_BETTER_API_CAPABILITY = backendApiCapability;
process.env.EXPLORE_BETTER_REQUIRE_API_CAPABILITY = "1";
if (app.isPackaged && !process.env.EXPLORE_BETTER_FS_HELPER) {
  const packagedFilesystemHelper = path.join(
    process.resourcesPath,
    "native",
    process.platform === "win32" ? "explore-better-fs.exe" : "explore-better-fs"
  );
  if (existsSync(packagedFilesystemHelper)) {
    process.env.EXPLORE_BETTER_FS_HELPER = packagedFilesystemHelper;
  }
}
if (app.isPackaged && !process.env.EXPLORE_BETTER_WORKSPACE_ROOT) {
  process.env.EXPLORE_BETTER_WORKSPACE_ROOT = app.getPath("desktop");
  process.env.EXPLORE_BETTER_WORKSPACE_LABEL = "Desktop";
}
let baseUrl = port > 0 ? `http://${host}:${port}` : "";
const dragIconPath = path.join(__dirname, "public", "drag-file.png");
const publicUpdateFeedUrl = "https://github.com/terrorproforma/explore-better/releases/latest/download";
const updateFeedUrl =
  process.env.EXPLORE_BETTER_UPDATE_URL || process.env.EB_UPDATE_URL || (app.isPackaged ? publicUpdateFeedUrl : "");
const userDataDir = process.env.EXPLORE_BETTER_USER_DATA_DIR || process.env.EB_USER_DATA_DIR || "";

if (userDataDir) {
  const resolvedUserData = path.resolve(userDataDir);
  app.setPath("userData", resolvedUserData);
  app.setPath("sessionData", path.join(resolvedUserData, "Session"));
}

let mainWindow = null;
let serverProcess = null;
let embeddedServer = null;
let embeddedServerModule = null;
let autoUpdater = null;
let autoUpdatesConfigured = false;
let autoUpdateChecking = false;
let autoUpdateLastEvent = {
  type: updateFeedUrl ? "not-configured" : "disabled",
  message: updateFeedUrl ? "Update feed is not initialized yet." : "Set EXPLORE_BETTER_UPDATE_URL to enable update checks.",
  at: new Date().toISOString()
};
const smokeMode = process.argv.includes("--smoke");
const smokeWindowMode = process.argv.includes("--smoke-window");
const smokeBackendRestartMode = process.argv.includes("--smoke-backend-restart");
const smokeUpdateFeedMode = process.argv.includes("--smoke-update-feed");
const smokeNativeHelperMode = process.argv.includes("--smoke-native-helper");
const smokeTerminalMode = process.argv.includes("--smoke-terminal");
const smokeTerminalSecurityMode = process.argv.includes("--smoke-terminal-security");
const noUpdatesMode = process.argv.includes("--no-updates");
const aiHostMode = process.argv.includes("--ai-host");
let mcpBridgeService = null;
let mcpTray = null;
let mcpHeadlessExitTimer = null;
let mcpRendererContext = {
  live: false,
  activePane: "left",
  paneLayout: "vertical",
  panes: { left: { activeTabId: "", path: "", tabs: [] }, right: { activeTabId: "", path: "", tabs: [] } },
  selection: [],
  focusedPath: "",
  contextRevision: 0
};
const mcpUiRequests = new Map();
const disableGpuMode =
  smokeMode ||
  terminalBrokerMode ||
  process.env.EXPLORE_BETTER_DISABLE_GPU === "1" ||
  process.env.EB_DISABLE_GPU === "1";

if (disableGpuMode) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  app.commandLine.appendSwitch("in-process-gpu");
  app.commandLine.appendSwitch("disable-features", "UseSkiaRenderer,VizDisplayCompositor,NetworkServiceSandbox");
}

const expectedSmokeUpdateEvent = process.env.EXPLORE_BETTER_UPDATE_EXPECTED_EVENT || process.env.EB_UPDATE_EXPECTED_EVENT || "available";
const forceDevUpdateConfig =
  process.env.EXPLORE_BETTER_FORCE_DEV_UPDATE_CONFIG === "1" || process.env.EB_FORCE_DEV_UPDATE_CONFIG === "1";
const backendWatchdogIntervalMs = Math.max(
  500,
  Number(process.env.EXPLORE_BETTER_BACKEND_WATCHDOG_MS || process.env.EB_BACKEND_WATCHDOG_MS || 2500)
);
const backendHealthTimeoutMs = Math.max(
  800,
  Number(process.env.EXPLORE_BETTER_BACKEND_HEALTH_TIMEOUT_MS || process.env.EB_BACKEND_HEALTH_TIMEOUT_MS || 1800)
);
const backendWatchdogMissThreshold = Math.max(
  2,
  Number(process.env.EXPLORE_BETTER_BACKEND_MISS_THRESHOLD || process.env.EB_BACKEND_MISS_THRESHOLD || 3)
);
let backendMonitor = null;
let backendRecoveryPromise = null;
let backendRestartCount = 0;
let backendConsecutiveHealthMisses = 0;
let backendLastEvent = {
  type: "idle",
  message: "Backend has not been checked yet.",
  at: new Date().toISOString()
};

const terminalService = terminalBrokerMode
  ? null
  : createTerminalService({
      MessageChannelMain,
      getMainWindow: () => mainWindow,
      getBaseUrl: () => baseUrl,
      runtime: {
        packaged: app.isPackaged,
        executablePath: process.execPath,
        appPath: app.getAppPath(),
        userDataPath: app.getPath("userData"),
        debug: false
      }
    });
const mcpClientConfigurator = terminalBrokerMode
  ? null
  : createMcpClientConfigurator({
      packaged: app.isPackaged,
      executablePath: process.execPath,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath
    });

async function ensureDesktopPort() {
  if (port > 0 && baseUrl) return port;
  port = await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      const selectedPort = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => {
        if (error) reject(error);
        else if (!selectedPort) reject(new Error("Windows did not assign a loopback port."));
        else resolve(selectedPort);
      });
    });
  });
  process.env.PORT = String(port);
  baseUrl = `http://${host}:${port}`;
  return port;
}

function isLikelyPathArgument(value) {
  return Boolean(value && !value.startsWith("--") && value !== "." && value !== __dirname);
}

function shellTargetFromArgv(argv = process.argv) {
  const repoPath = path.resolve(__dirname).toLowerCase();
  return (
    argv
      .slice(1)
      .filter(isLikelyPathArgument)
      .map((value) => path.resolve(value))
      .find((value) => value.toLowerCase() !== repoPath) || null
  );
}

function shellModeFromArgv(argv = process.argv) {
  const argument = argv.find((value) => value.startsWith("--shell-mode="));
  const mode = argument?.slice("--shell-mode=".length);
  return ["leftReplace", "rightReplace", "activeReplace", "activeNewTab"].includes(mode)
    ? mode
    : null;
}

function listerUrl(targetPath = null, shellMode = null) {
  if (!targetPath && !shellMode) {
    return `${baseUrl}/`;
  }
  const params = new URLSearchParams();
  if (targetPath) {
    params.set("open", targetPath);
  }
  if (shellMode) {
    params.set("shellMode", shellMode);
  }
  return `${baseUrl}/?${params}`;
}

function desktopShortcutAction(input) {
  if (input.type !== "keyDown" || input.alt || !(input.control || input.meta)) {
    return null;
  }
  const key = String(input.key || "").toLowerCase();
  if (input.shift && key === "t") {
    return "reopen-tab";
  }
  if (input.shift && (key === "tab" || key === "pageup")) {
    return "previous-tab";
  }
  if (!input.shift && key === "t") {
    return "duplicate-tab";
  }
  if (!input.shift && key === "w") {
    return "close-tab";
  }
  if (!input.shift && (key === "tab" || key === "pagedown")) {
    return "next-tab";
  }
  if (!input.shift && key === "pageup") {
    return "previous-tab";
  }
  return null;
}

function dispatchDesktopShortcut(windowRef, action) {
  if (!windowRef?.webContents) {
    return;
  }
  const script = `window.dispatchEvent(new CustomEvent("explore-better-desktop-shortcut", { detail: ${JSON.stringify(
    action
  )} }));`;
  windowRef.webContents.executeJavaScript(script).catch((error) => console.error(error));
}

function dragIconImage() {
  const image = nativeImage.createFromPath(dragIconPath);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

function nativeDragPaths(paths = []) {
  if (!Array.isArray(paths)) {
    return [];
  }
  const seen = new Set();
  return paths
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => path.resolve(item))
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key) || !existsSync(item)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 500);
}

function redactedUpdateFeedUrl() {
  if (!updateFeedUrl) {
    return "";
  }
  try {
    const parsed = new URL(updateFeedUrl);
    parsed.username = parsed.username ? "redacted" : "";
    parsed.password = parsed.password ? "redacted" : "";
    parsed.search = parsed.search ? "?..." : "";
    return parsed.toString();
  } catch {
    return updateFeedUrl;
  }
}

function updateStatus() {
  return {
    available: true,
    configured: autoUpdatesConfigured,
    feedConfigured: Boolean(updateFeedUrl),
    feedUrl: redactedUpdateFeedUrl(),
    checking: autoUpdateChecking,
    lastEvent: autoUpdateLastEvent
  };
}

function rememberUpdateEvent(type, message = "", data = {}) {
  autoUpdateLastEvent = {
    type,
    message,
    at: new Date().toISOString(),
    ...data
  };
}

function rememberBackendEvent(type, message = "", data = {}) {
  backendLastEvent = {
    type,
    message,
    at: new Date().toISOString(),
    restartCount: backendRestartCount,
    ...data
  };
}

async function configureAutoUpdates() {
  if (autoUpdatesConfigured || noUpdatesMode || !updateFeedUrl) {
    return updateStatus();
  }
  try {
    const updaterModule = await import("electron-updater");
    autoUpdater = updaterModule.autoUpdater || updaterModule.default?.autoUpdater;
    if (!autoUpdater) {
      throw new Error("electron-updater did not expose autoUpdater.");
    }
  } catch (error) {
    rememberUpdateEvent("error", error?.message || String(error || "Could not load updater runtime."));
    return updateStatus();
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  if (forceDevUpdateConfig) {
    autoUpdater.forceDevUpdateConfig = true;
  }
  autoUpdater.setFeedURL({ provider: "generic", url: updateFeedUrl });
  autoUpdater.on("checking-for-update", () => {
    autoUpdateChecking = true;
    rememberUpdateEvent("checking", "Checking for updates.");
  });
  autoUpdater.on("update-available", (info) => {
    autoUpdateChecking = false;
    rememberUpdateEvent("available", "Update available.", {
      version: info?.version || ""
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    autoUpdateChecking = false;
    rememberUpdateEvent("not-available", "No update available.", {
      version: info?.version || ""
    });
  });
  autoUpdater.on("error", (error) => {
    autoUpdateChecking = false;
    rememberUpdateEvent("error", error?.message || String(error || "Update check failed."));
  });
  autoUpdatesConfigured = true;
  rememberUpdateEvent("configured", "Update feed configured.", { feedUrl: redactedUpdateFeedUrl() });
  return updateStatus();
}

function startNativeFileDrag(sender, paths) {
  const dragPaths = nativeDragPaths(paths);
  if (!dragPaths.length) {
    return false;
  }
  sender.startDrag({
    file: dragPaths[0],
    files: dragPaths,
    icon: dragIconImage()
  });
  return true;
}

function serverIsReady(timeoutMs = backendHealthTimeoutMs) {
  return new Promise((resolve) => {
    const request = http.get(`${baseUrl}/api/desktop/health`, {
      headers: { "x-explore-better-capability": backendApiCapability }
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body = `${body}${chunk.toString()}`.slice(0, 8192);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          resolve(false);
          return;
        }
        try {
          const status = JSON.parse(body);
          resolve(status?.ok === true && status?.desktopInstanceToken === desktopInstanceToken);
        } catch {
          resolve(false);
        }
      });
    });
    request.on("error", () => resolve(false));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function backendStatus() {
  return {
    available: true,
    ready: await serverIsReady(),
    recovering: Boolean(backendRecoveryPromise),
    embedded: Boolean(embeddedServer?.listening),
    child: Boolean(serverProcess && !serverProcess.killed),
    restartCount: backendRestartCount,
    watchdogMs: backendWatchdogIntervalMs,
    lastEvent: backendLastEvent
  };
}

function rendererIsTrusted(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

function normalizeMcpRendererContext(input = {}) {
  const panes = {};
  for (const paneId of ["left", "right"]) {
    const pane = input.panes?.[paneId] || {};
    panes[paneId] = {
      activeTabId: String(pane.activeTabId || "").slice(0, 100),
      path: String(pane.path || "").slice(0, 32768),
      tabs: (Array.isArray(pane.tabs) ? pane.tabs : []).slice(0, 100).map((tab) => ({
        id: String(tab?.id || "").slice(0, 100),
        path: String(tab?.path || "").slice(0, 32768),
        title: String(tab?.title || "").slice(0, 260)
      }))
    };
  }
  return {
    live: true,
    activePane: input.activePane === "right" ? "right" : "left",
    paneLayout: ["vertical", "horizontal", "single", "single-left", "single-right"].includes(input.paneLayout)
      ? input.paneLayout
      : "vertical",
    panes,
    selection: (Array.isArray(input.selection) ? input.selection : []).slice(0, 100).map((item) => String(item).slice(0, 32768)),
    focusedPath: String(input.focusedPath || "").slice(0, 32768),
    contextRevision: Math.max(mcpRendererContext.contextRevision + 1, Number(input.contextRevision || 0))
  };
}

function dispatchMcpUiAction(action) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!mainWindow || mainWindow.isDestroyed()) await showLister();
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error("Explore Better window could not be opened.");
      const requestId = randomBytes(16).toString("hex");
      const timeout = setTimeout(() => {
        mcpUiRequests.delete(requestId);
        const error = new Error("The Explore Better renderer did not acknowledge the AI action.");
        error.code = "UI_UNAVAILABLE";
        reject(error);
      }, 10_000);
      mcpUiRequests.set(requestId, { resolve, reject, timeout });
      mainWindow.webContents.send("explore-better:mcp-ui-action", { requestId, action });
    } catch (error) {
      reject(error);
    }
  });
}

function scheduleMcpHeadlessExit(clientCount = mcpBridgeService?.status().clients || 0) {
  clearTimeout(mcpHeadlessExitTimer);
  mcpHeadlessExitTimer = null;
  if (!aiHostMode || clientCount > 0 || mainWindow) return;
  mcpHeadlessExitTimer = setTimeout(() => app.quit(), 30_000);
  mcpHeadlessExitTimer.unref?.();
}

function ensureMcpTray() {
  const clients = mcpBridgeService?.status().clients || 0;
  if (mcpTray || !(aiHostMode || (clients > 0 && !mainWindow))) return;
  const iconPath = existsSync(path.join(__dirname, "build", "icon.ico"))
    ? path.join(__dirname, "build", "icon.ico")
    : dragIconPath;
  mcpTray = new Tray(nativeImage.createFromPath(iconPath));
  mcpTray.setToolTip("Explore Better AI Bridge");
  mcpTray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Explore Better", click: () => showLister().catch(console.error) },
    { type: "separator" },
    { label: "Quit AI Bridge", click: () => app.quit() }
  ]));
  mcpTray.on("double-click", () => showLister().catch(console.error));
}

function handleMcpConnectionCount(count = 0) {
  if (count > 0 && !mainWindow) ensureMcpTray();
  if (!aiHostMode && count === 0 && !mainWindow) {
    app.quit();
    return;
  }
  scheduleMcpHeadlessExit(count);
}

async function ensureMcpBackendModule() {
  if (!embeddedServerModule) embeddedServerModule = await import("./server.mjs");
  return embeddedServerModule;
}

async function ensureMcpBridge() {
  if (mcpBridgeService?.status().running) return mcpBridgeService.status();
  const backend = await ensureMcpBackendModule();
  mcpBridgeService = createMcpBridgeService({
    backend,
    appVersion: app.getVersion(),
    executablePath: process.execPath,
    appPath: app.getAppPath(),
    getContext: () => mcpRendererContext,
    dispatchUiAction: dispatchMcpUiAction,
    onConnectionCountChanged: handleMcpConnectionCount
  });
  const bridgeStatus = await mcpBridgeService.start();
  ensureMcpTray();
  scheduleMcpHeadlessExit(bridgeStatus.clients);
  return bridgeStatus;
}

ipcMain.on("explore-better:mcp-context", (event, context) => {
  if (!rendererIsTrusted(event)) return;
  mcpRendererContext = normalizeMcpRendererContext(context);
});

ipcMain.on("explore-better:mcp-ui-action-result", (event, response) => {
  if (!rendererIsTrusted(event)) return;
  const pending = mcpUiRequests.get(String(response?.requestId || ""));
  if (!pending) return;
  mcpUiRequests.delete(response.requestId);
  clearTimeout(pending.timeout);
  if (response.error) pending.reject(Object.assign(new Error(String(response.error.message || response.error)), { code: response.error.code }));
  else pending.resolve(response.result || { contextRevision: mcpRendererContext.contextRevision });
});

ipcMain.handle("explore-better:mcp-status", async (event) => {
  if (!rendererIsTrusted(event)) throw new Error("Untrusted AI Bridge status request.");
  const backend = await ensureMcpBackendModule();
  return {
    bridge: await ensureMcpBridge(),
    context: mcpRendererContext,
    configuration: await backend.getMcpBridgeConfiguration(),
    contract: await backend.getMcpContract(),
    deployment: await mcpClientConfigurator.status()
  };
});

ipcMain.handle("explore-better:mcp-configure", async (event, patch) => {
  if (!rendererIsTrusted(event)) throw new Error("Untrusted AI Bridge configuration request.");
  return (await ensureMcpBackendModule()).configureMcpBridge(patch || {});
});

ipcMain.handle("explore-better:mcp-profile-upsert", async (event, profile) => {
  if (!rendererIsTrusted(event)) throw new Error("Untrusted AI Bridge profile request.");
  return (await ensureMcpBackendModule()).upsertMcpProfile(profile || {});
});

ipcMain.handle("explore-better:mcp-profile-revoke", async (event, profileId) => {
  if (!rendererIsTrusted(event)) throw new Error("Untrusted AI Bridge revocation request.");
  return (await ensureMcpBackendModule()).revokeMcpProfile(String(profileId || ""));
});

ipcMain.handle("explore-better:mcp-audit", async (event, limit) => {
  if (!rendererIsTrusted(event)) throw new Error("Untrusted AI Bridge audit request.");
  return (await ensureMcpBackendModule()).listMcpAudit(Number(limit || 200));
});

ipcMain.handle("explore-better:mcp-client-install", async (event, client, profileId) => {
  if (!rendererIsTrusted(event)) throw new Error("Untrusted AI Bridge client setup request.");
  return mcpClientConfigurator.install(String(client || ""), String(profileId || ""));
});

ipcMain.handle("explore-better:mcp-client-remove", async (event, client) => {
  if (!rendererIsTrusted(event)) throw new Error("Untrusted AI Bridge client removal request.");
  return mcpClientConfigurator.remove(String(client || ""));
});

ipcMain.on("explore-better:start-file-drag", (event, paths) => {
  try {
    startNativeFileDrag(event.sender, paths);
  } catch (error) {
    console.error(error);
  }
});

ipcMain.handle("explore-better:update-status", () => {
  return configureAutoUpdates();
});

ipcMain.handle("explore-better:check-for-updates", async () => {
  await configureAutoUpdates();
  if (!autoUpdatesConfigured || !autoUpdater) {
    return updateStatus();
  }
  let checkResult = null;
  try {
    const result = await autoUpdater.checkForUpdates();
    checkResult = result
      ? {
          isUpdateAvailable: result.isUpdateAvailable === true,
          version: result.updateInfo?.version || result.versionInfo?.version || ""
        }
      : null;
  } catch (error) {
    rememberUpdateEvent("error", error?.message || String(error || "Update check failed."));
  } finally {
    autoUpdateChecking = false;
  }
  return { ...updateStatus(), checkResult };
});

ipcMain.handle("explore-better:backend-status", () => {
  return backendStatus();
});

ipcMain.handle("explore-better:app-info", () => {
  return {
    packaged: app.isPackaged,
    smoke: smokeMode,
    version: app.getVersion()
  };
});

ipcMain.handle("explore-better:restart-backend", () => {
  return recoverBackend("desktop-ipc");
});

ipcMain.handle("explore-better:terminal-capabilities", () => {
  return terminalService?.capabilities() || { available: false, profiles: [], elevationAvailable: false };
});

ipcMain.handle("explore-better:terminal-create", (event, request) => {
  if (!terminalService) throw new Error("Terminal service is unavailable.");
  return terminalService.create(event, request);
});

ipcMain.handle("explore-better:terminal-sync-directory", (event, sessionId, cwd) => {
  if (!terminalService) throw new Error("Terminal service is unavailable.");
  return terminalService.syncDirectory(event, sessionId, cwd);
});

ipcMain.handle("explore-better:terminal-restart", (event, sessionId, request) => {
  if (!terminalService) throw new Error("Terminal service is unavailable.");
  return terminalService.restart(event, sessionId, request);
});

ipcMain.handle("explore-better:terminal-dispose", (event, sessionId) => {
  if (!terminalService) return false;
  return terminalService.disposeForEvent(event, sessionId);
});

async function waitForServer() {
  for (let index = 0; index < 30; index += 1) {
    if (await serverIsReady()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  return false;
}

async function ensureServer() {
  await ensureDesktopPort();
  if (await serverIsReady()) {
    rememberBackendEvent("ready", "Backend already answered health check.", { kind: "existing" });
    return;
  }
  rememberBackendEvent("starting", "Starting embedded backend server.", { kind: "embedded" });
  try {
    const serverModule = await import("./server.mjs");
    embeddedServerModule = serverModule;
    embeddedServer = await serverModule.startServer();
    if (await waitForServer()) {
      rememberBackendEvent("ready", "Embedded backend server is ready.", { kind: "embedded" });
      return;
    }
  } catch (error) {
    console.error(error);
    rememberBackendEvent("error", error?.message || String(error || "Embedded backend failed."), {
      kind: "embedded"
    });
  }

  rememberBackendEvent("starting", "Starting child backend server.", { kind: "child" });
  const child = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
    cwd: __dirname,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      ELECTRON_RUN_AS_NODE: "1"
    },
    stdio: "ignore",
    windowsHide: true
  });
  serverProcess = child;
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
    rememberBackendEvent("error", error?.message || "Child backend process failed to start.", { kind: "child" });
    if (serverProcess === child) serverProcess = null;
  });
  child.once("exit", (code, signal) => {
    rememberBackendEvent("exited", "Child backend server exited.", { kind: "child", code, signal });
    if (serverProcess === child) serverProcess = null;
  });
  await new Promise((resolve) => {
    child.once("spawn", resolve);
    child.once("error", resolve);
  });
  if (spawnError) {
    throw new Error(`Explore Better child backend failed to start: ${spawnError.message}`);
  }
  if (!(await waitForServer())) {
    rememberBackendEvent("error", `Explore Better server did not start at ${baseUrl}`, { kind: "child" });
    throw new Error(`Explore Better server did not start at ${baseUrl}`);
  }
  rememberBackendEvent("ready", "Child backend server is ready.", { kind: "child" });
}

async function recoverBackend(reason = "watchdog") {
  if (backendRecoveryPromise) {
    return backendRecoveryPromise;
  }
  backendRecoveryPromise = (async () => {
    backendRestartCount += 1;
    rememberBackendEvent("recovering", `Recovering backend after ${reason}.`, { reason });
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill();
      serverProcess = null;
    }
    if (embeddedServer) {
      await closeEmbeddedServer();
    }
    await ensureServer();
    if (!(await serverIsReady())) {
      throw new Error(`Backend recovery did not restore ${baseUrl}`);
    }
    backendConsecutiveHealthMisses = 0;
    rememberBackendEvent("recovered", `Backend recovered after ${reason}.`, { reason });
    if (mainWindow && !mainWindow.isDestroyed()) {
      const currentUrl = mainWindow.webContents.getURL();
      await mainWindow.loadURL(currentUrl?.startsWith(baseUrl) ? currentUrl : listerUrl());
    }
    return backendStatus();
  })()
    .catch((error) => {
      rememberBackendEvent("error", error?.message || String(error || "Backend recovery failed."), { reason });
      throw error;
    })
    .finally(() => {
      backendRecoveryPromise = null;
    });
  return backendRecoveryPromise;
}

function startBackendMonitor() {
  if (backendMonitor || !backendWatchdogIntervalMs) {
    return;
  }
  backendMonitor = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || backendRecoveryPromise) {
      return;
    }
    if (await serverIsReady()) {
      backendConsecutiveHealthMisses = 0;
      return;
    }
    backendConsecutiveHealthMisses += 1;
    rememberBackendEvent("degraded", `Backend health check missed ${backendConsecutiveHealthMisses}/${backendWatchdogMissThreshold}.`, {
      misses: backendConsecutiveHealthMisses,
      threshold: backendWatchdogMissThreshold
    });
    if (backendConsecutiveHealthMisses >= backendWatchdogMissThreshold) {
      backendConsecutiveHealthMisses = 0;
      recoverBackend("watchdog").catch((error) => console.error(error));
    }
  }, backendWatchdogIntervalMs);
  backendMonitor.unref?.();
}

function stopBackendMonitor() {
  if (backendMonitor) {
    clearInterval(backendMonitor);
    backendMonitor = null;
  }
}

async function simulateBackendFailureForSmoke() {
  if (embeddedServer?.listening) {
    await closeEmbeddedServer();
    rememberBackendEvent("simulated-failure", "Smoke closed embedded backend server.", { kind: "embedded" });
    return "embedded-close";
  }
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
    rememberBackendEvent("simulated-failure", "Smoke killed child backend server.", { kind: "child" });
    return "child-kill";
  }
  return "";
}

async function waitForBackendDown(timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await serverIsReady())) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return false;
}

async function rendererBackendOk() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  return mainWindow.webContents.executeJavaScript("fetch('/api/roots').then((response) => response.ok).catch(() => false)");
}

async function rendererVisibleRows() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return 0;
  }
  return mainWindow.webContents.executeJavaScript(
    "new Promise((resolve) => { const done = () => resolve(document.querySelectorAll('[data-entry-path]').length); const started = Date.now(); const tick = () => { const rows = document.querySelectorAll('[data-entry-path]').length; if (rows || Date.now() - started > 5000) return resolve(rows); setTimeout(tick, 80); }; tick(); })"
  );
}

async function runNativeHelperSmoke() {
  const targetPath = process.env.EXPLORE_BETTER_NATIVE_SMOKE_PATH || __dirname;
  const response = await fetch(`${baseUrl}/api/size-analysis`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-explore-better-capability": backendApiCapability
    },
    body: JSON.stringify({ path: targetPath, maxEntries: 10000, followLinks: false })
  });
  const report = await response.json();
  console.log(
    `Explore Better packaged native helper: provider=${report?.allocationProvider || "missing"} accuracy=${
      report?.allocationAccuracy || "missing"
    } source=${report?.allocatedSource || "missing"} scanned=${report?.scanned || 0}`
  );
  return Boolean(
    response.ok &&
      report?.allocationProvider === "native-go-helper" &&
      report?.allocationAccuracy === "exact" &&
      report?.allocatedSource === "win32-get-compressed-file-size" &&
      Number(report?.scanned || 0) > 0
  );
}

async function runBackendRestartSmoke() {
  console.log("Explore Better backend recovery: starting");
  stopBackendMonitor();
  const before = await serverIsReady();
  const rendererBefore = await rendererBackendOk();
  const simulated = await simulateBackendFailureForSmoke();
  const wentDown = await waitForBackendDown();
  const recovery = await recoverBackend("smoke-backend-restart");
  startBackendMonitor();
  const after = await serverIsReady();
  const rendererAfter = await rendererBackendOk();
  const rows = await rendererVisibleRows();
  console.log(
    `Explore Better backend recovery: before=${before} rendererBefore=${rendererBefore} simulated=${simulated || "none"} down=${wentDown} after=${after} rendererAfter=${rendererAfter} rows=${rows} restarts=${recovery.restartCount}`
  );
  return Boolean(before && rendererBefore && simulated && wentDown && after && rendererAfter && rows > 0);
}

function closeEmbeddedServer() {
  return new Promise((resolve) => {
    if (!embeddedServer?.listening) {
      embeddedServer = null;
      resolve();
      return;
    }
    const server = embeddedServer;
    const timeout = setTimeout(() => {
      server.closeAllConnections?.();
      embeddedServer = null;
      resolve();
    }, 2500);
    server.close(() => {
      clearTimeout(timeout);
      embeddedServer = null;
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

async function stopServer() {
  stopBackendMonitor();
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
  await closeEmbeddedServer();
}

async function exitSmoke(code) {
  stopBackendMonitor();
  await stopServer();
  app.exit(code);
}

async function showLister(targetPath = null, shellMode = null) {
  await ensureServer();
  await ensureMcpBridge();
  startBackendMonitor();
  const targetUrl = listerUrl(targetPath, shellMode);
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
    await mainWindow.loadURL(targetUrl);
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 980,
    minHeight: 660,
    title: "Explore Better",
    backgroundColor: "#f1f3ee",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "electron-preload.cjs")
    }
  });
  const rendererWebContentsId = mainWindow.webContents.id;

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol;
      if (protocol === "https:" || protocol === "mailto:") {
        shell.openExternal(url).catch(() => {});
      }
    } catch {
      // Invalid external URLs are denied below.
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin === new URL(baseUrl).origin) {
        return;
      }
    } catch {
      // Invalid navigation targets are denied below.
    }
    event.preventDefault();
  });
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const action = desktopShortcutAction(input);
    if (!action) {
      return;
    }
    event.preventDefault();
    dispatchDesktopShortcut(mainWindow, action);
  });
  mainWindow.webContents.on("render-process-gone", () => {
    terminalService?.disposeWebContents(rendererWebContentsId);
  });
  mainWindow.once("ready-to-show", () => {
    if (!smokeMode) {
      mainWindow?.show();
    }
  });
  mainWindow.on("closed", () => {
    terminalService?.disposeWebContents(rendererWebContentsId);
    mainWindow = null;
    mcpRendererContext = { ...mcpRendererContext, live: false, selection: [], focusedPath: "" };
    handleMcpConnectionCount(mcpBridgeService?.status().clients || 0);
  });
  await mainWindow.loadURL(targetUrl);
}

async function rendererShellOpenSnapshot(targetPath, shellMode) {
  if (!mainWindow?.webContents || !targetPath) {
    return null;
  }
  return mainWindow.webContents.executeJavaScript(`(() => {
    const target = ${JSON.stringify(path.resolve(targetPath))};
    const targetParent = ${JSON.stringify(path.dirname(path.resolve(targetPath)))};
    const expectedMode = ${JSON.stringify(shellMode || "")};
    const normalize = (value) => String(value || "").replace(/\\\\+$/, "").toLowerCase();
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const leftInput = document.querySelector('[data-path-input="left"]');
        const rightInput = document.querySelector('[data-path-input="right"]');
        const activePane = document.querySelector('.pane.active')?.dataset?.pane || "";
        const activeInput = activePane === "right" ? rightInput : leftInput;
        const activePath = activeInput?.value || "";
        const leftPath = leftInput?.value || "";
        const rightPath = rightInput?.value || "";
        const paneSelector = \`.pane[data-pane="\${activePane || "left"}"]\`;
        const entryRows = [...document.querySelectorAll(\`\${paneSelector} [data-entry-path]\`)];
        const selectedRow = entryRows.find((row) => normalize(row.dataset.entryPath) === normalize(target));
        const selected = Boolean(
          selectedRow &&
          (selectedRow.classList.contains("selected") || selectedRow.getAttribute("aria-selected") === "true")
        );
        const pathMatched = normalize(activePath) === normalize(target) || normalize(leftPath) === normalize(target) || normalize(rightPath) === normalize(target);
        const parentMatched = normalize(activePath) === normalize(targetParent) || normalize(leftPath) === normalize(targetParent) || normalize(rightPath) === normalize(targetParent);
        const matched = pathMatched || (parentMatched && selected);
        if (matched || Date.now() - started > 10000) {
          resolve({
            target,
            targetParent,
            expectedMode,
            activePane,
            activePath,
            leftPath,
            rightPath,
            rows: entryRows.length,
            selected,
            selectedPath: selectedRow?.dataset.entryPath || "",
            parentMatched,
            matched
          });
          return;
        }
        setTimeout(tick, 120);
      };
      tick();
    });
  })()`);
}

async function waitForRendererValue(expression, predicate, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await mainWindow?.webContents?.executeJavaScript(expression).catch(() => null);
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return null;
}

async function runTerminalSmoke() {
  if (!mainWindow?.webContents || !terminalService || terminalService.sessionCount() !== 0) return false;
  const startupReady = await waitForRendererValue(
    `Boolean(window.__exploreBetterStartup?.completedAt && document.querySelector('[data-terminal-toggle="left"]'))`,
    (value) => value === true,
    15000
  );
  if (!startupReady) {
    console.log("Explore Better terminal smoke: renderer startup did not complete");
    return false;
  }
  const rendererPrewarmed = await waitForRendererValue(
    "Boolean(window.ExploreBetterTerminal?.createView)",
    (value) => value === true,
    10000
  );
  if (!rendererPrewarmed) {
    console.log("Explore Better terminal smoke: lazy renderer did not prewarm");
    return false;
  }
  const startedAt = performance.now();
  await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-terminal-toggle="left"]')?.click()`);
  const leftReady = await waitForRendererValue(
    `(() => ({ visible: !document.querySelector('[data-terminal-drawer="left"]')?.hidden, textarea: Boolean(document.querySelector('[data-terminal-drawer="left"] .xterm-helper-textarea')), title: document.querySelector('[data-terminal-title="left"]')?.textContent || '', text: document.querySelector('[data-terminal-drawer="left"] .xterm-rows')?.textContent || '' }))()`,
    (value) => value?.visible && value?.textarea && value?.title.includes("Ready") && terminalService.sessionCount() === 1,
    12000
  );
  if (!leftReady) {
    const snapshot = await mainWindow.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('[data-terminal-drawer="left"]');
      return { visible: !drawer?.hidden, classes: drawer?.className || '', title: document.querySelector('[data-terminal-title="left"]')?.textContent || '', text: drawer?.querySelector('.xterm-rows')?.textContent || '', placeholder: drawer?.querySelector('.terminal-placeholder')?.textContent || '', hasRenderer: Boolean(window.ExploreBetterTerminal), startup: window.__exploreBetterStartup || null };
    })()`).catch((error) => ({ error: error.message }));
    console.log(`Explore Better terminal smoke left failure: sessions=${terminalService.sessionCount()} snapshot=${JSON.stringify(snapshot)}`);
    terminalService.disposeAll();
    return false;
  }
  const firstPromptMs = Math.round(performance.now() - startedAt);
  const smokeProfile = terminalService.profileForSmoke();
  const outputSentinel = "EB_TERMINAL_OUTPUT_OK";
  const outputCommand = smokeProfile?.kind === "cmd"
    ? "for %A in (OK) do @echo EB_TERMINAL_OUTPUT_%A\r"
    : "Write-Output ('EB_TERMINAL_OUTPUT_' + 'OK')\r";
  terminalService.writeForSmoke(outputCommand);
  const commandOutput = await waitForRendererValue(
    `(() => ({ title: document.querySelector('[data-terminal-title="left"]')?.textContent || '', canvas: Boolean(document.querySelector('[data-terminal-drawer="left"] .xterm canvas')) }))()`,
    (value) => terminalService.outputForSmoke().includes(outputSentinel) && value?.title.includes("Ready") && value?.canvas,
    10000
  );
  if (!commandOutput) {
    const snapshot = await mainWindow.webContents.executeJavaScript(`(() => ({ title: document.querySelector('[data-terminal-title="left"]')?.textContent || '', text: document.querySelector('[data-terminal-drawer="left"] .xterm-rows')?.textContent || '' }))()`).catch((error) => ({ error: error.message }));
    console.log(`Explore Better terminal smoke command failure: ${JSON.stringify(snapshot)}`);
    terminalService.disposeAll();
    return false;
  }
  const queuedCommand = smokeProfile?.kind === "cmd"
    ? "ping -n 2 127.0.0.1 >nul & echo EB_TERMINAL_BUSY_DONE\r"
    : "Start-Sleep -Milliseconds 600; Write-Output ('EB_TERMINAL_BUSY_' + 'DONE')\r";
  const firstSyncPath = process.env.EXPLORE_BETTER_TERMINAL_SMOKE_FIRST_CWD || path.join(__dirname, "src");
  const latestSyncPath = process.env.EXPLORE_BETTER_TERMINAL_SMOKE_LATEST_CWD || path.join(__dirname, "public");
  terminalService.writeForSmoke(queuedCommand);
  const firstQueued = terminalService.syncForSmoke(firstSyncPath);
  const latestQueued = terminalService.syncForSmoke(latestSyncPath);
  const folderFollow = await waitForRendererValue(
    "true",
    () => terminalService.outputForSmoke().includes("EB_TERMINAL_BUSY_DONE") && path.normalize(terminalService.cwdForSmoke()) === path.normalize(latestSyncPath),
    10000
  );
  if (!firstQueued?.queued || !latestQueued?.queued || !folderFollow) {
    console.log(`Explore Better terminal smoke folder follow failure: first=${JSON.stringify(firstQueued)} latest=${JSON.stringify(latestQueued)} cwd=${terminalService.cwdForSmoke()}`);
    terminalService.disposeAll();
    return false;
  }
  await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-terminal-toggle="right"]')?.click()`);
  const dualReady = await waitForRendererValue(
    `Boolean(!document.querySelector('[data-terminal-drawer="left"]')?.hidden && !document.querySelector('[data-terminal-drawer="right"]')?.hidden && document.querySelector('[data-terminal-drawer="right"] .xterm-helper-textarea') && document.querySelector('[data-terminal-title="right"]')?.textContent?.includes('Ready'))`,
    (value) => value === true && terminalService.sessionCount() === 2,
    12000
  );
  if (!dualReady) {
    terminalService.disposeAll();
    return false;
  }
  await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-terminal-action="close"][data-pane="left"]')?.click(); document.querySelector('[data-terminal-action="close"][data-pane="right"]')?.click()`);
  const cleaned = await waitForRendererValue("true", () => terminalService.sessionCount() === 0, 6000);
  console.log(`Explore Better terminal smoke: profile=${smokeProfile?.id || "unknown"} firstPromptMs=${firstPromptMs} output=${Boolean(commandOutput)} folderFollow=${Boolean(folderFollow)} dual=${Boolean(dualReady)} cleaned=${Boolean(cleaned)}`);
  return Boolean(commandOutput && folderFollow && dualReady && cleaned);
}

async function runTerminalSecuritySmoke() {
  if (!mainWindow?.webContents || !terminalService || terminalService.sessionCount() !== 0) return false;
  const result = await mainWindow.webContents.executeJavaScript(`(async () => {
    const bridge = window.exploreBetterDesktop?.terminal;
    const capabilities = await bridge.capabilities();
    const rejects = async (task) => { try { await task(); return false; } catch { return true; } };
    const base = { tabId: 'security-probe-tab', cwd: ${JSON.stringify(__dirname)}, profileId: 'auto', elevation: 'standard', cols: 80, rows: 24 };
    const [profileRejected, pathRejected, dimensionsRejected, sessionRejected] = await Promise.all([
      rejects(() => bridge.create({ ...base, profileId: 'not-a-real-shell' })),
      rejects(() => bridge.create({ ...base, cwd: 'C:\\\\ExploreBetter-Missing-Terminal-Path' })),
      rejects(() => bridge.create({ ...base, cols: 1000000 })),
      rejects(() => bridge.dispose('forged-session-id'))
    ]);
    const httpProbe = await fetch('/api/terminal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return {
      profileRejected,
      pathRejected,
      dimensionsRejected,
      sessionRejected,
      httpRejected: httpProbe.status === 403 || httpProbe.status === 404 || httpProbe.status === 405,
      profilesBounded: Array.isArray(capabilities.profiles) && capabilities.profiles.length <= 3,
      noExecutablePaths: capabilities.profiles.every((profile) => Object.keys(profile).every((key) => key === 'id' || key === 'label'))
    };
  })()`);
  const passed = Object.values(result || {}).every(Boolean) && terminalService.sessionCount() === 0;
  console.log(`Explore Better terminal security smoke: passed=${passed} result=${JSON.stringify(result)} sessions=${terminalService.sessionCount()}`);
  return passed;
}

const hasSingleInstanceLock = terminalBrokerMode || smokeMode || app.requestSingleInstanceLock();
if (terminalBrokerMode) {
  app.on("ready", () => {
    runTerminalBroker(terminalBrokerManifest)
      .then(() => app.exit(0))
      .catch((error) => {
        console.error(error);
        app.exit(1);
      });
  });
} else if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.setAppUserModelId("ExploreBetter.LocalFileManager");
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--ai-host")) {
      ensureMcpBridge().catch(console.error);
      return;
    }
    showLister(shellTargetFromArgv(argv), shellModeFromArgv(argv)).catch((error) => {
      console.error(error);
    });
  });
  app.on("ready", () => {
    if (smokeMode) {
      ensureServer()
        .then(async () => {
          const smokeShellTarget = shellTargetFromArgv();
          const smokeShellMode = shellModeFromArgv();
          if (smokeWindowMode) {
            await showLister(smokeShellTarget, smokeShellMode);
            const hasDesktopBridge = await mainWindow.webContents.executeJavaScript(
              "Boolean(window.exploreBetterDesktop && window.exploreBetterDesktop.getPathForFile && window.exploreBetterDesktop.startFileDrag && window.exploreBetterDesktop.updateStatus && window.exploreBetterDesktop.checkForUpdates && window.exploreBetterDesktop.backendStatus && window.exploreBetterDesktop.appInfo && window.exploreBetterDesktop.restartBackend && window.exploreBetterDesktop.terminal?.capabilities && window.exploreBetterDesktop.terminal?.create && window.exploreBetterDesktop.terminal?.write && window.exploreBetterDesktop.terminal?.resize && window.exploreBetterDesktop.terminal?.restart && window.exploreBetterDesktop.terminal?.dispose && window.exploreBetterDesktop.aiBridge?.status && window.exploreBetterDesktop.aiBridge?.configure && window.exploreBetterDesktop.aiBridge?.upsertProfile && window.exploreBetterDesktop.aiBridge?.revokeProfile && window.exploreBetterDesktop.aiBridge?.installClient && window.exploreBetterDesktop.aiBridge?.removeClient)"
            );
            const updateStatus = await mainWindow.webContents.executeJavaScript("window.exploreBetterDesktop.updateStatus()");
            const backendStatus = await mainWindow.webContents.executeJavaScript("window.exploreBetterDesktop.backendStatus()");
            const hasNativeDragIcon = !dragIconImage().isEmpty();
            console.log(`Explore Better desktop bridge: ${hasDesktopBridge ? "ready" : "missing"}`);
            console.log(`Explore Better update bridge: ${updateStatus?.feedConfigured ? "configured" : "disabled"}`);
            console.log(`Explore Better backend bridge: ${backendStatus?.ready ? "ready" : "missing"}`);
            console.log(`Explore Better native drag icon: ${hasNativeDragIcon ? "ready" : "missing"}`);
            if (!hasDesktopBridge || updateStatus?.available !== true || backendStatus?.available !== true || !backendStatus?.ready || !hasNativeDragIcon) {
              return exitSmoke(1);
            }
            if (smokeShellTarget) {
              const shellOpenSnapshot = await rendererShellOpenSnapshot(smokeShellTarget, smokeShellMode);
              console.log(
                `Explore Better shell-open smoke: matched=${shellOpenSnapshot?.matched === true} selected=${shellOpenSnapshot?.selected === true} active=${shellOpenSnapshot?.activePane || ""} rows=${
                  shellOpenSnapshot?.rows || 0
                } target=${smokeShellTarget}`
              );
              if (shellOpenSnapshot?.matched !== true) {
                return exitSmoke(1);
              }
            }
            if (smokeBackendRestartMode && !(await runBackendRestartSmoke())) {
              return exitSmoke(1);
            }
            if (smokeNativeHelperMode && !(await runNativeHelperSmoke())) {
              return exitSmoke(1);
            }
            if (smokeTerminalMode && !(await runTerminalSmoke())) {
              return exitSmoke(1);
            }
            if (smokeTerminalSecurityMode && !(await runTerminalSecuritySmoke())) {
              return exitSmoke(1);
            }
            if (smokeUpdateFeedMode) {
              const updateCheck = await mainWindow.webContents.executeJavaScript("window.exploreBetterDesktop.checkForUpdates()");
              console.log(
                `Explore Better update check: event=${updateCheck?.lastEvent?.type || "missing"} version=${
                  updateCheck?.lastEvent?.version || updateCheck?.checkResult?.version || ""
                } available=${updateCheck?.checkResult?.isUpdateAvailable === true}`
              );
              if (updateCheck?.feedConfigured !== true || updateCheck?.lastEvent?.type !== expectedSmokeUpdateEvent) {
                return exitSmoke(1);
              }
            }
          }
          console.log(`Explore Better desktop smoke ready at ${baseUrl}/`);
          return exitSmoke(0);
        })
        .catch((error) => {
          console.error(error);
          return exitSmoke(1);
        });
      return;
    }
    if (aiHostMode) {
      ensureServer()
        .then(() => ensureMcpBridge())
        .catch((error) => {
          console.error(error);
          app.quit();
        });
    } else {
      showLister(shellTargetFromArgv(), shellModeFromArgv()).catch((error) => {
        console.error(error);
        app.quit();
      });
    }
  });
  app.on("activate", () => {
    if (!mainWindow) {
      showLister().catch((error) => console.error(error));
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !aiHostMode && !(mcpBridgeService?.status().clients > 0)) {
      app.quit();
    } else {
      scheduleMcpHeadlessExit();
    }
  });
  app.on("will-quit", () => {
    clearTimeout(mcpHeadlessExitTimer);
    for (const pending of mcpUiRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Explore Better is closing."));
    }
    mcpUiRequests.clear();
    mcpTray?.destroy();
    mcpTray = null;
    mcpBridgeService?.stop().catch((error) => console.error(error));
    terminalService?.disposeAll();
    stopBackendMonitor();
    stopServer().catch((error) => console.error(error));
  });
}
