import { app, BrowserWindow, ipcMain, nativeImage, shell } from "electron";
import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || randomInt(43000, 62000));
const desktopInstanceToken =
  process.env.EXPLORE_BETTER_DESKTOP_INSTANCE_TOKEN || randomBytes(24).toString("base64url");
process.env.HOST = host;
process.env.PORT = String(port);
process.env.EXPLORE_BETTER_DESKTOP_INSTANCE_TOKEN = desktopInstanceToken;
if (app.isPackaged && !process.env.EXPLORE_BETTER_WORKSPACE_ROOT) {
  process.env.EXPLORE_BETTER_WORKSPACE_ROOT = app.getPath("desktop");
  process.env.EXPLORE_BETTER_WORKSPACE_LABEL = "Desktop";
}
const baseUrl = `http://${host}:${port}`;
const dragIconPath = path.join(__dirname, "public", "drag-file.png");
const updateFeedUrl = process.env.EXPLORE_BETTER_UPDATE_URL || process.env.EB_UPDATE_URL || "";
const userDataDir = process.env.EXPLORE_BETTER_USER_DATA_DIR || process.env.EB_USER_DATA_DIR || "";

if (userDataDir) {
  const resolvedUserData = path.resolve(userDataDir);
  app.setPath("userData", resolvedUserData);
  app.setPath("sessionData", path.join(resolvedUserData, "Session"));
}

let mainWindow = null;
let serverProcess = null;
let embeddedServer = null;
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
const noUpdatesMode = process.argv.includes("--no-updates");
const disableGpuMode =
  smokeMode ||
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
    const request = http.get(`${baseUrl}/api/desktop/health`, (response) => {
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

ipcMain.handle("explore-better:restart-backend", () => {
  return recoverBackend("desktop-ipc");
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
  if (await serverIsReady()) {
    rememberBackendEvent("ready", "Backend already answered health check.", { kind: "existing" });
    return;
  }
  rememberBackendEvent("starting", "Starting embedded backend server.", { kind: "embedded" });
  try {
    const serverModule = await import("./server.mjs");
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
    headers: { "content-type": "application/json" },
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
  mainWindow.once("ready-to-show", () => {
    if (!smokeMode) {
      mainWindow?.show();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(targetUrl);
}

async function rendererShellOpenSnapshot(targetPath, shellMode) {
  if (!mainWindow?.webContents || !targetPath) {
    return null;
  }
  return mainWindow.webContents.executeJavaScript(`(() => {
    const target = ${JSON.stringify(path.resolve(targetPath))};
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
        const rows = document.querySelectorAll(\`.pane[data-pane="\${activePane || "left"}"] [data-entry-path]\`).length;
        const matched = normalize(activePath) === normalize(target) || normalize(leftPath) === normalize(target) || normalize(rightPath) === normalize(target);
        if (matched || Date.now() - started > 10000) {
          resolve({ target, expectedMode, activePane, activePath, leftPath, rightPath, rows, matched });
          return;
        }
        setTimeout(tick, 120);
      };
      tick();
    });
  })()`);
}

const hasSingleInstanceLock = smokeMode || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.setAppUserModelId("ExploreBetter.LocalFileManager");
  app.on("second-instance", (_event, argv) => {
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
              "Boolean(window.exploreBetterDesktop && window.exploreBetterDesktop.getPathForFile && window.exploreBetterDesktop.startFileDrag && window.exploreBetterDesktop.updateStatus && window.exploreBetterDesktop.checkForUpdates && window.exploreBetterDesktop.backendStatus && window.exploreBetterDesktop.restartBackend)"
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
                `Explore Better shell-open smoke: matched=${shellOpenSnapshot?.matched === true} active=${shellOpenSnapshot?.activePane || ""} rows=${
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
    showLister(shellTargetFromArgv(), shellModeFromArgv()).catch((error) => {
      console.error(error);
      app.quit();
    });
  });
  app.on("activate", () => {
    if (!mainWindow) {
      showLister().catch((error) => console.error(error));
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
  app.on("will-quit", () => {
    stopBackendMonitor();
    stopServer().catch((error) => console.error(error));
  });
}
