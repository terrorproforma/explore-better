import { createReadStream, createWriteStream, existsSync, watch } from "node:fs";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl");
const yazl = require("yazl");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const workspaceRoot = path.resolve(process.env.EXPLORE_BETTER_WORKSPACE_ROOT || process.cwd());
const workspaceLabel = String(process.env.EXPLORE_BETTER_WORKSPACE_LABEL || "Workspace").trim() || "Workspace";
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4627);
const desktopInstanceToken = process.env.EXPLORE_BETTER_DESKTOP_INSTANCE_TOKEN || "";
const apiCapability = process.env.EXPLORE_BETTER_API_CAPABILITY || crypto.randomBytes(32).toString("base64url");
const requireDirectApiCapability = process.env.EXPLORE_BETTER_REQUIRE_API_CAPABILITY === "1";
const apiCapabilityCookieName = "ExploreBetterCapability";
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'"
].join("; ");

function isLoopbackHostname(value) {
  const hostname = String(value || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

if (!isLoopbackHostname(host)) {
  throw new Error(`Explore Better only accepts a loopback HOST; received ${JSON.stringify(host)}.`);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Explore Better requires a valid TCP PORT; received ${JSON.stringify(process.env.PORT)}.`);
}
const localAppData =
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const appDataRoot = process.env.EXPLORE_BETTER_APP_DATA_ROOT
  ? path.resolve(process.env.EXPLORE_BETTER_APP_DATA_ROOT)
  : path.join(localAppData, "ExploreBetter");
const trashRoot = path.join(appDataRoot, "Trash");
const tempRoot = path.join(appDataRoot, "Temp");
const elevationRoot = path.join(appDataRoot, "Elevation");
const stateFile = path.join(appDataRoot, "state.json");
const stateBackupFile = path.join(appDataRoot, "state.json.bak");
const indexRoot = path.join(appDataRoot, "Index");
const metadataCacheRoot = path.join(appDataRoot, "MetadataCache");
const integrationRoot = path.join(appDataRoot, "Integration");
const installedAppRoot = path.join(appDataRoot, "App");
let desktopExecutablePath = null;
let operationChain = Promise.resolve();
let stateChain = Promise.resolve();
let stateCache = {
  key: null,
  state: null,
  labelMap: new Map(),
  dirty: false,
  watcher: null,
  contentHash: "",
  checkedAt: 0
};
let startupOperationRecoveryChecked = false;
let mcpResourceUpdatePublisher = null;
let mcpResourceRevision = 0;
const operationControls = new Map();
const operationChangeWaiters = new Set();
const operationPreviewTokens = new Map();
const folderIndexJobs = new Map();
const folderIndexCache = new Map();
const directoryListingCache = new Map();
const directoryListingInFlight = new Map();
const sizeAnalysisCache = new Map();
const sizeAnalysisInFlight = new Map();
const advancedSearchCache = new Map();
const advancedSearchInFlight = new Map();
const backgroundIndexJobs = new Map();
const backgroundIndexFreshnessCache = new Map();
const backgroundIndexAutoRebuilds = new Map();
const backgroundIndexWatchers = new Map();
const backgroundIndexSearchStoreCache = new Map();
const backgroundIndexSearchStoreInFlight = new Map();
const foregroundActivityState = {
  leases: new Map(),
  listeners: new Set(),
  pausedBackgroundJobs: 0,
  resumptions: 0,
  foregroundStarts: 0
};
let rendererSchedulerSnapshot = null;
const stateCacheContentCheckTtlMs = 1000;
const folderWatchers = new Map();
const folderWatcherMaxEntries = 32;
const folderWatcherTtlMs = 120000;
const folderIndexJobLimit = 40;
const backgroundIndexJobLimit = 20;
const dimensionsCacheEntryLimit = 100000;
const folderIndexCacheLimit = 8;
const folderIndexCacheMaxBytes = 128 * 1024 * 1024;
const directoryListingCacheLimit = 8;
const directoryListingCacheMaxEntries = 220000;
const directoryListingCacheMaxEntriesPerListing = 150000;
const directoryListingWindowMaxEntries = 5000;
const configuredNativeDirectoryListingThreshold = Number(
  process.env.EXPLORE_BETTER_NATIVE_LISTING_THRESHOLD || 2000
);
const nativeDirectoryListingThreshold = Number.isFinite(configuredNativeDirectoryListingThreshold)
  ? Math.max(500, Math.min(Math.floor(configuredNativeDirectoryListingThreshold), 100000))
  : 2000;
const sizeAnalysisCacheLimit = 6;
const sizeAnalysisCacheTtlMs = 30000;
const advancedSearchCacheTtlMs = 10000;
const listingCacheMutationPathKeys = new Set([
  "archive",
  "backup",
  "copied",
  "created",
  "deleted",
  "dest",
  "destination",
  "extracted",
  "from",
  "leftPath",
  "moved",
  "original",
  "output",
  "path",
  "paths",
  "recycled",
  "renamed",
  "restored",
  "rightPath",
  "source",
  "sources",
  "target",
  "targetDir",
  "targetPath",
  "to",
  "transferred",
  "trashDir"
]);
const backgroundSearchTokenPostingLimit = 2048;
const backgroundSearchTokenPerEntryLimit = 96;
const backgroundSearchTokenLengthLimit = 64;
const backgroundSearchStoreCacheLimit = 4;
const backgroundSearchStoreCacheMaxBytes = 160 * 1024 * 1024;
const operationHistoryLimit = 100;
const operationHistoryScanLimit = 2000;
const cacheMaintenanceDefaultMaxAgeDays = 30;
const cacheMaintenanceFileLimit = 2000;
const cancellableOperationTypes = new Set(["copy", "move", "delete", "recycle", "transfer", "sync", "script"]);
const interruptedOperationStatuses = new Set(["queued", "running", "paused"]);
const operationStatuses = new Set(["queued", "running", "paused", "completed", "failed", "canceled"]);
const testOperationDelayMs = Math.max(
  0,
  Math.min(Number(process.env.EB_TEST_OPERATION_DELAY_MS || 0), 30000)
);
const testOperationDelayAfterItems = Math.max(
  0,
  Math.min(Number(process.env.EB_TEST_OPERATION_DELAY_AFTER_ITEMS || 0), 100000)
);
const testStateWriteDelayMs = Math.max(
  0,
  Math.min(Number(process.env.EB_TEST_STATE_WRITE_DELAY_MS || 0), 30000)
);
const testForceCrossVolumeMove = process.env.EB_TEST_FORCE_CROSS_VOLUME_MOVE === "1";
const testFailSourceRemoval = process.env.EB_TEST_FAIL_SOURCE_REMOVAL === "1";
const testFailStagingRename = process.env.EB_TEST_FAIL_STAGING_RENAME === "1";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".png", "image/png"],
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".opus", "audio/opus"],
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".avi", "video/x-msvideo"],
  [".mkv", "video/x-matroska"],
  [".txt", "text/plain; charset=utf-8"]
]);

const imageExtensions = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp"
]);

const audioExtensions = new Set([".flac", ".m4a", ".mp3", ".oga", ".ogg", ".opus", ".wav"]);
const videoExtensions = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"]);
const previewDocumentExtensions = new Set([".pdf"]);

const textExtensions = new Set([
  ".bat",
  ".c",
  ".cmd",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".h",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".ps1",
  ".py",
  ".rs",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

const conflictModes = new Set(["unique", "overwrite", "skip"]);
const densityModes = new Set(["compact", "comfortable", "spacious"]);
const openGestureModes = new Set(["double", "single"]);
const startupModes = new Set(["last", "homeDownloads", "workspaceHome", "documentsDownloads", "savedLayout"]);
const shellOpenModes = new Set(["leftReplace", "rightReplace", "activeReplace", "activeNewTab"]);
const windowsShellNamespaces = [
  {
    id: "thisPc",
    name: "This PC",
    kind: "thisPc",
    detail: "Windows shell",
    openTarget: "shell:MyComputerFolder"
  },
  {
    id: "libraries",
    name: "Libraries",
    kind: "libraries",
    detail: "Windows libraries",
    openTarget: "shell:Libraries"
  },
  {
    id: "network",
    name: "Network",
    kind: "network",
    detail: "Network locations",
    openTarget: "shell:NetworkPlacesFolder"
  },
  {
    id: "recycleBin",
    name: "Recycle Bin",
    kind: "recycleBin",
    detail: "Windows Recycle Bin",
    openTarget: "shell:RecycleBinFolder"
  }
];
const shellNamespaceCache = new Map();
const shellNamespaceCacheTtlMs = 15000;
const shellNamespaceCacheMaxEntries = 64;
const shellNamespaceTimeoutMs = {
  network: 2500,
  recycleBin: 3500,
  default: 5000
};
const shellRegistrySnapshotSpec = [
  {
    id: "directoryShell",
    key: "HKCU\\Software\\Classes\\Directory\\shell",
    kind: "defaultOnly",
    values: [{ id: "default", name: null }]
  },
  {
    id: "driveShell",
    key: "HKCU\\Software\\Classes\\Drive\\shell",
    kind: "defaultOnly",
    values: [{ id: "default", name: null }]
  },
  {
    id: "directoryExploreBetter",
    key: "HKCU\\Software\\Classes\\Directory\\shell\\ExploreBetter",
    kind: "ownedKey",
    values: [
      { id: "default", name: null },
      { id: "icon", name: "Icon" }
    ]
  },
  {
    id: "directoryExploreBetterCommand",
    key: "HKCU\\Software\\Classes\\Directory\\shell\\ExploreBetter\\command",
    kind: "ownedKey",
    values: [{ id: "default", name: null }]
  },
  {
    id: "driveExploreBetter",
    key: "HKCU\\Software\\Classes\\Drive\\shell\\ExploreBetter",
    kind: "ownedKey",
    values: [
      { id: "default", name: null },
      { id: "icon", name: "Icon" }
    ]
  },
  {
    id: "driveExploreBetterCommand",
    key: "HKCU\\Software\\Classes\\Drive\\shell\\ExploreBetter\\command",
    kind: "ownedKey",
    values: [{ id: "default", name: null }]
  },
  {
    id: "directoryBackgroundExploreBetter",
    key: "HKCU\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter",
    kind: "ownedKey",
    values: [
      { id: "default", name: null },
      { id: "icon", name: "Icon" }
    ]
  },
  {
    id: "directoryBackgroundExploreBetterCommand",
    key: "HKCU\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter\\command",
    kind: "ownedKey",
    values: [{ id: "default", name: null }]
  },
  {
    id: "fileLocationExploreBetter",
    key: "HKCU\\Software\\Classes\\*\\shell\\ExploreBetterLocation",
    kind: "ownedKey",
    values: [
      { id: "default", name: null },
      { id: "icon", name: "Icon" }
    ]
  },
  {
    id: "fileLocationExploreBetterCommand",
    key: "HKCU\\Software\\Classes\\*\\shell\\ExploreBetterLocation\\command",
    kind: "ownedKey",
    values: [{ id: "default", name: null }]
  }
];
const retryableOperationTypes = new Set([
  "copy",
  "move",
  "move-resume",
  "delete",
  "recycle",
  "trash",
  "trash-restore",
  "trash-delete",
  "transfer",
  "sync",
  "archive-create",
  "archive-extract",
  "shortcut-create",
  "link-create",
  "attributes-set",
  "timestamps-set",
  "mkdir",
  "create-file",
  "rename",
  "bulk-rename"
]);
const elevatedRetryOperationTypes = new Set(["copy", "move", "delete"]);

function normalizeLaunchMode(value) {
  if (value === "native") {
    return "native";
  }
  return value === "browser" ? "browser" : "appWindow";
}

function normalizeShellOpenMode(value) {
  return shellOpenModes.has(value) ? value : "leftReplace";
}

function normalizeConflictMode(value) {
  return conflictModes.has(value) ? value : "unique";
}

function normalizeDensity(value) {
  return densityModes.has(value) ? value : "comfortable";
}

function normalizeOpenGesture(value) {
  return openGestureModes.has(value) ? value : "double";
}

function normalizeStartupMode(value) {
  return startupModes.has(value) ? value : "last";
}

function sanitizeReferenceId(value) {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function sanitizeToolbarActions(actions) {
  const clean = [];
  for (const action of Array.isArray(actions) ? actions : []) {
    const id = String(action || "").trim().slice(0, 60);
    if (/^[A-Za-z0-9_-]+$/.test(id) && !clean.includes(id)) {
      clean.push(id);
    }
  }
  return clean.slice(0, 80);
}

function sanitizeToolbarOrder(actions) {
  return sanitizeToolbarActions(actions);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function sanitizeLayoutSizes(source = {}) {
  const raw = source && typeof source === "object" ? source : {};
  return {
    navWidth: clampNumber(raw.navWidth, 150, 520, 236),
    inspectorWidth: clampNumber(raw.inspectorWidth, 180, 620, 300),
    leftPaneWeight: clampNumber(raw.leftPaneWeight, 0.45, 3.5, 1),
    rightPaneWeight: clampNumber(raw.rightPaneWeight, 0.45, 3.5, 1),
    topPaneWeight: clampNumber(raw.topPaneWeight, 0.45, 3.5, 1),
    bottomPaneWeight: clampNumber(raw.bottomPaneWeight, 0.45, 3.5, 1),
    dockHeight: clampNumber(raw.dockHeight, 34, 280, 44),
    leftTerminalHeight: clampNumber(raw.leftTerminalHeight, 140, 720, 220),
    rightTerminalHeight: clampNumber(raw.rightTerminalHeight, 140, 720, 220)
  };
}

function sanitizeSettings(settings) {
  const raw = settings && typeof settings === "object" ? settings : {};
  return {
    ...raw,
    density: normalizeDensity(raw.density),
    openGesture: normalizeOpenGesture(raw.openGesture),
    startupMode: normalizeStartupMode(raw.startupMode),
    startupLayoutId: sanitizeReferenceId(raw.startupLayoutId),
    navigator: raw.navigator !== false,
    inspector: raw.inspector !== false,
    inspectorAutoCollapse: raw.inspectorAutoCollapse !== false,
    confirmTrash: raw.confirmTrash !== false,
    launchMode: normalizeLaunchMode(raw.launchMode),
    shellOpenMode: normalizeShellOpenMode(raw.shellOpenMode),
    pasteConflictMode: normalizeConflictMode(raw.pasteConflictMode),
    autoRefresh: raw.autoRefresh !== false,
    showHidden: raw.showHidden !== false,
    linkedNavigation: raw.linkedNavigation === true,
    terminalDefaultProfile: String(raw.terminalDefaultProfile || "auto").slice(0, 80),
    terminalDefaultElevation: raw.terminalDefaultElevation === "administrator" ? "administrator" : "standard",
    terminalFollowDirectory: raw.terminalFollowDirectory !== false,
    terminalTheme: ["dark", "light", "high-contrast"].includes(raw.terminalTheme) ? raw.terminalTheme : "dark",
    terminalFontSize: Math.round(clampNumber(raw.terminalFontSize, 10, 20, 12)),
    terminalCursor: ["block", "bar", "underline"].includes(raw.terminalCursor) ? raw.terminalCursor : "block",
    terminalScrollback: Math.round(clampNumber(raw.terminalScrollback, 1000, 50000, 10000)),
    layoutSizes: sanitizeLayoutSizes(raw.layoutSizes),
    toolbarActions: sanitizeToolbarActions(raw.toolbarActions),
    toolbarOrder: sanitizeToolbarOrder(raw.toolbarOrder)
  };
}

function backgroundIndexIdForPath(targetPath) {
  return `bg-${crypto.createHash("sha256").update(pathIdentity(targetPath)).digest("hex").slice(0, 24)}`;
}

function sanitizeBackgroundIndexRoot(root) {
  const raw = root && typeof root === "object" ? root : {};
  const rawPath = String(raw.path || "").trim();
  const resolvedPath = rawPath ? resolveUserPath(rawPath) : "";
  const id = sanitizeReferenceId(raw.id) || (resolvedPath ? backgroundIndexIdForPath(resolvedPath) : crypto.randomUUID());
  const now = new Date().toISOString();
  return {
    id,
    name: String(raw.name || (resolvedPath ? labelFromPath(resolvedPath) : "Background Index")).slice(0, 120),
    path: resolvedPath,
    enabled: raw.enabled !== false,
    autoRebuild: raw.autoRebuild !== false,
    watch: raw.watch !== false,
    recursive: raw.recursive !== false,
    showHidden: raw.showHidden !== false,
    includeDimensions: raw.includeDimensions === true,
    includeLinks: raw.includeLinks === true,
    includeContent: raw.includeContent === true,
    maxFolders: Math.round(clampNumber(raw.maxFolders, 1, 5000, 500)),
    maxEntries: Math.round(clampNumber(raw.maxEntries, 100, 500000, 100000)),
    maxContentBytes: Math.round(clampNumber(raw.maxContentBytes, 1024, 1_000_000, 128_000)),
    maxContentFiles: Math.round(clampNumber(raw.maxContentFiles, 1, 100000, 1000)),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
    lastStartedAt: raw.lastStartedAt || null,
    lastCompletedAt: raw.lastCompletedAt || null,
    lastAutoRebuildAt: raw.lastAutoRebuildAt || null,
    lastAutoRebuildReason: raw.lastAutoRebuildReason || null,
    lastError: raw.lastError || null,
    lastStats: raw.lastStats && typeof raw.lastStats === "object" ? raw.lastStats : null
  };
}

function uniqueBackgroundIndexRoots(roots) {
  const seen = new Set();
  const clean = [];
  for (const root of Array.isArray(roots) ? roots : []) {
    const sanitized = sanitizeBackgroundIndexRoot(root);
    if (!sanitized.path) {
      continue;
    }
    const key = sanitized.id || pathIdentity(sanitized.path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    clean.push(sanitized);
  }
  return clean;
}

const serializedJsonBody = Symbol("serializedJsonBody");

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  const body = payload?.[serializedJsonBody] || JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendError(res, status, message, details) {
  sendJson(res, status, { error: message, details });
}

function beginForegroundActivity(kind = "request") {
  const id = crypto.randomUUID();
  foregroundActivityState.leases.set(id, { id, kind: String(kind).slice(0, 100), startedAt: Date.now() });
  foregroundActivityState.foregroundStarts += 1;
  for (const listener of foregroundActivityState.listeners) listener();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    foregroundActivityState.leases.delete(id);
    for (const listener of foregroundActivityState.listeners) listener();
  };
}

function foregroundActivitySnapshot() {
  return {
    activeForegroundLeases: foregroundActivityState.leases.size,
    pausedBackgroundJobs: foregroundActivityState.pausedBackgroundJobs,
    foregroundStarts: foregroundActivityState.foregroundStarts,
    resumptions: foregroundActivityState.resumptions,
    renderer: rendererSchedulerSnapshot
  };
}

function updateRendererSchedulerSnapshot(value = {}) {
  const number = (key) => Math.max(0, Math.min(1_000_000_000, Number(value[key] || 0)));
  rendererSchedulerSnapshot = {
    capturedAt: sanitizeOperationTimestamp(value.capturedAt, new Date().toISOString()),
    activeForegroundLeases: number("activeForegroundLeases"),
    queuedPrefetches: number("queuedPrefetches"),
    activePrefetches: number("activePrefetches"),
    paused: value.paused === true,
    aborts: number("aborts"),
    cacheHits: number("cacheHits"),
    resumptions: number("resumptions"),
    started: number("started"),
    foregroundStarts: number("foregroundStarts")
  };
  return rendererSchedulerSnapshot;
}

async function waitForForegroundIdle(signal) {
  if (!foregroundActivityState.leases.size) return false;
  foregroundActivityState.pausedBackgroundJobs += 1;
  try {
    while (foregroundActivityState.leases.size) {
      throwIfOperationCanceled(signal);
      await new Promise((resolve) => {
        let timeout = null;
        const done = () => {
          clearTimeout(timeout);
          foregroundActivityState.listeners.delete(done);
          resolve();
        };
        foregroundActivityState.listeners.add(done);
        timeout = setTimeout(done, 100);
      });
    }
    foregroundActivityState.resumptions += 1;
    return true;
  } finally {
    foregroundActivityState.pausedBackgroundJobs = Math.max(0, foregroundActivityState.pausedBackgroundJobs - 1);
  }
}

function requestIsForegroundWork(url, method = "GET") {
  const pathname = String(url?.pathname || "");
  if (pathname === "/api/list" || pathname === "/api/tree" || pathname === "/api/search" || pathname === "/api/size-analysis") return true;
  if (pathname.startsWith("/api/operation/") || pathname === "/api/transfer" || pathname === "/api/copy" || pathname === "/api/move") return true;
  return method !== "GET" && ["/api/rename", "/api/delete", "/api/recycle", "/api/trash", "/api/archive/create", "/api/archive/extract"].includes(pathname);
}

function cookieValue(req, name) {
  const prefix = `${name}=`;
  for (const part of String(req.headers.cookie || "").split(";")) {
    const candidate = part.trim();
    if (candidate.startsWith(prefix)) {
      return candidate.slice(prefix.length);
    }
  }
  return "";
}

function validateRequestBoundary(req) {
  const isApiRequest = String(req.url || "").split("?", 1)[0].startsWith("/api/");
  const authority = String(req.headers.host || "");
  let requestOrigin;
  try {
    requestOrigin = new URL(`http://${authority}`);
  } catch {
    return { status: 400, message: "A valid Host header is required." };
  }
  const requestPort = Number(requestOrigin.port || 80);
  if (!isLoopbackHostname(requestOrigin.hostname) || requestPort !== port) {
    return { status: 403, message: "The request Host is not the local application origin." };
  }

  const originHeader = String(req.headers.origin || "");
  if (originHeader) {
    let origin;
    try {
      origin = new URL(originHeader);
    } catch {
      return { status: 403, message: "The request Origin is invalid." };
    }
    if (origin.origin !== requestOrigin.origin) {
      return { status: 403, message: "Cross-origin API requests are not allowed." };
    }
  }

  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return { status: 403, message: "Cross-site API requests are not allowed." };
  }

  const method = String(req.method || "GET").toUpperCase();
  if (isApiRequest && !new Set(["GET", "POST", "DELETE"]).has(method)) {
    return { status: 405, message: "The HTTP method is not supported." };
  }
  if (isApiRequest && method === "POST") {
    const contentType = String(req.headers["content-type"] || "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      return { status: 415, message: "Mutation requests must use application/json." };
    }
  }

  const suppliedCapability = cookieValue(req, apiCapabilityCookieName) || String(req.headers["x-explore-better-capability"] || "");
  if (isApiRequest && (requireDirectApiCapability || originHeader || fetchSite) && suppliedCapability !== apiCapability) {
    return { status: 403, message: "The launch capability is missing or invalid." };
  }
  return null;
}

function boundedInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function listWindowOptions(searchParams) {
  const hasOffset = searchParams.has("offset");
  const hasLimit = searchParams.has("limit");
  if (!hasOffset && !hasLimit) {
    return null;
  }
  const offset = boundedInteger(searchParams.get("offset"), 0, { min: 0 });
  const limit = boundedInteger(searchParams.get("limit"), directoryListingWindowMaxEntries, {
    min: 1,
    max: directoryListingWindowMaxEntries
  });
  return { offset, limit };
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function abortError() {
  const error = new Error("Request aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function throwIfAborted(signal) {
  if (!signal?.aborted) {
    return;
  }
  throw isAbortError(signal.reason) ? signal.reason : abortError();
}

function requestAbortSignal(req, res) {
  const controller = new AbortController();
  const cleanup = () => {
    req.off("aborted", abort);
    res.off("close", onClose);
    res.off("finish", cleanup);
  };
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(abortError());
    }
    cleanup();
  };
  const onClose = () => {
    if (!res.writableEnded) {
      abort();
    } else {
      cleanup();
    }
  };
  req.on("aborted", abort);
  res.on("close", onClose);
  res.on("finish", cleanup);
  return controller.signal;
}

function defaultState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    layout: {
      activePane: "left",
      paneLayout: "vertical",
      panes: {
        left: { activeTab: 0, tabs: [{ path: workspaceRoot }] },
        right: { activeTab: 0, tabs: [{ path: os.homedir() }] }
      }
    },
    favorites: [],
    aliases: [],
    recentLocations: [],
    fileBasket: [],
    collections: [],
    paneSnapshots: [],
    selectionSets: [],
    labels: [],
    folderFormats: [],
    displayPresets: [],
    filterPresets: [],
    syncProfiles: [],
    openWithPresets: [],
    searchPresets: [],
    selectPresets: [],
    bulkRenamePresets: [],
    layouts: [],
    tabGroups: [],
    backgroundIndexes: [],
    scripts: [
      {
        id: "sample-active-listing",
        name: "Active Listing",
        description: "Returns the first eight files in the active pane.",
        showInToolbar: true,
        code: `console.log("Path:", context.path);
console.log("Other:", context.otherPath);
console.log("Selected:", context.selectedPaths);
await api.emit("sample:pane", { activePane: context.activePane });

const listing = await api.list(context.path);
return listing.entries
  .filter((item) => item.isFile)
  .slice(0, 8)
  .map((item) => ({ name: item.name, size: item.size }));`
      },
      {
        id: "selected-paths-json",
        name: "Selected Paths JSON",
        description: "Returns selected paths as structured JSON.",
        showInToolbar: false,
        code: `return {
  activePath: context.path,
  selectedCount: context.selectedPaths.length,
  selectedPaths: context.selectedPaths
};`
      }
    ],
    commands: [
      {
        id: "sample-list-selection",
        name: "List Selection",
        description: "Prints the active path and selected items.",
        kind: "powershell",
        command:
          "Write-Output \"Active: $env:EB_ACTIVE\"; $env:EB_SELECTED_LINES -split \"`n\" | Where-Object { $_ }",
        showInToolbar: true
      },
      {
        id: "open-terminal-here",
        name: "Terminal Here",
        description: "Opens Windows Terminal or PowerShell in the active pane path.",
        kind: "powershell",
        command:
          "if (Get-Command wt.exe -ErrorAction SilentlyContinue) { Start-Process wt.exe -ArgumentList @('-d', $env:EB_ACTIVE) } else { Start-Process powershell.exe -WorkingDirectory $env:EB_ACTIVE }",
        showInToolbar: true
      }
    ],
    settings: {
      density: "comfortable",
      openGesture: "double",
      startupMode: "last",
      startupLayoutId: "",
      navigator: true,
      inspector: true,
      inspectorAutoCollapse: true,
      confirmTrash: true,
      launchMode: "appWindow",
      shellOpenMode: "leftReplace",
      pasteConflictMode: "unique",
      autoRefresh: true,
      showHidden: true,
      linkedNavigation: false,
      terminalDefaultProfile: "auto",
      terminalDefaultElevation: "standard",
      terminalFollowDirectory: true,
      terminalTheme: "dark",
      terminalFontSize: 12,
      terminalCursor: "block",
      terminalScrollback: 10000,
      layoutSizes: sanitizeLayoutSizes(),
      toolbarActions: [],
      toolbarOrder: []
    },
    integration: {
      generatedAt: null,
      scriptPath: path.join(integrationRoot, "explore-better-open.ps1"),
      serverScriptPath: path.join(integrationRoot, "explore-better-server.ps1"),
      shortcutScriptPath: path.join(integrationRoot, "install-shortcuts.ps1"),
      shortcutRemoveScriptPath: path.join(integrationRoot, "remove-shortcuts.ps1"),
      winEHotkeyPath: path.join(integrationRoot, "explore-better-win-e.ps1"),
      winEInstallScriptPath: path.join(integrationRoot, "install-win-e-startup.ps1"),
      winERemoveScriptPath: path.join(integrationRoot, "remove-win-e-startup.ps1"),
      contextMenuRegPath: path.join(integrationRoot, "install-context-menu.reg"),
      contextMenuRemoveRegPath: path.join(integrationRoot, "remove-context-menu.reg"),
      folderDefaultRegPath: path.join(integrationRoot, "install-folder-default.reg"),
      folderDefaultRemoveRegPath: path.join(integrationRoot, "remove-folder-default.reg"),
      registryRestoreRegPath: path.join(integrationRoot, "restore-previous-shell.reg")
    },
    operations: []
  };
}

function boundedOperationText(value, fallback = "", maxLength = 240) {
  const text = String(value ?? fallback).replace(/\s+/g, " ").trim();
  const normalized = text || fallback;
  return String(normalized || "").slice(0, maxLength);
}

function sanitizeOperationTimestamp(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const text = String(value).trim().slice(0, 80);
  return Number.isFinite(Date.parse(text)) ? text : fallback;
}

function sanitizeOperationProgress(progress) {
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) {
    return null;
  }
  const total = clampNumber(progress.total, 0, 1_000_000, 0);
  const completed = clampNumber(progress.completed, 0, total || 1_000_000, 0);
  const clean = {
    unit: boundedOperationText(progress.unit || "items", "items", 40),
    total,
    completed,
    phase: boundedOperationText(progress.phase || "", "", 80),
    updatedAt: sanitizeOperationTimestamp(progress.updatedAt, null)
  };
  if (progress.current !== undefined) {
    clean.current = boundedOperationText(progress.current, "", 240);
  }
  if (progress.currentPath !== undefined) {
    clean.currentPath = String(progress.currentPath || "").slice(0, 2000);
  }
  return clean;
}

function sanitizeOperationPayload(value, fallback = null) {
  if (value === undefined) {
    return fallback;
  }
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value.length > 20_000 ? `${value.slice(0, 20_000)}\n... truncated` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return typeof value === "object" ? value : fallback;
}

function sanitizeOperationEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  return {
    at: sanitizeOperationTimestamp(event.at, new Date().toISOString()),
    kind: boundedOperationText(event.kind || "update", "update", 60),
    status: boundedOperationText(event.status || "", "", 40),
    phase: boundedOperationText(event.phase || "", "", 100),
    message: boundedOperationText(event.message || "", "", 500),
    completed:
      event.completed !== null && event.completed !== undefined && Number.isFinite(Number(event.completed))
        ? Math.max(0, Number(event.completed))
        : null,
    total:
      event.total !== null && event.total !== undefined && Number.isFinite(Number(event.total))
        ? Math.max(0, Number(event.total))
        : null,
    correlationId: sanitizeReferenceId(event.correlationId),
    relatedOperationId: sanitizeReferenceId(event.relatedOperationId)
  };
}

function appendOperationEvent(operation, event) {
  const clean = sanitizeOperationEvent({
    at: new Date().toISOString(),
    status: operation.status,
    phase: operation.progress?.phase || "",
    completed: operation.progress?.completed,
    total: operation.progress?.total,
    ...event
  });
  if (!clean) return false;
  const events = (Array.isArray(operation.events) ? operation.events : []).map(sanitizeOperationEvent).filter(Boolean);
  const previous = events.at(-1);
  if (previous && ["kind", "status", "phase", "message", "completed", "total", "correlationId", "relatedOperationId"].every((key) => previous[key] === clean[key])) {
    return false;
  }
  operation.events = [...events, clean].slice(-64);
  return true;
}

function sanitizeStoredOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    return null;
  }
  const id = sanitizeReferenceId(operation.id);
  if (!id) {
    return null;
  }
  const type = boundedOperationText(operation.type || "operation", "operation", 80);
  const rawStatus = String(operation.status || "").trim();
  const validStatus = operationStatuses.has(rawStatus);
  const status = validStatus ? rawStatus : "failed";
  const createdAt = sanitizeOperationTimestamp(operation.createdAt, new Date(0).toISOString());
  const error =
    operation.error === null || operation.error === undefined
      ? validStatus
        ? null
        : "Recovered malformed operation journal row."
      : boundedOperationText(operation.error, "", 2000);

  return {
    id,
    type,
    label: boundedOperationText(operation.label || type, type, 240),
    status,
    createdAt,
    startedAt: sanitizeOperationTimestamp(operation.startedAt, null),
    finishedAt: sanitizeOperationTimestamp(operation.finishedAt, null),
    interruptedAt: sanitizeOperationTimestamp(operation.interruptedAt, null),
    recoveredAt: sanitizeOperationTimestamp(operation.recoveredAt, null),
    result: sanitizeOperationPayload(operation.result, null),
    error,
    undo:
      operation.undo && typeof operation.undo === "object" && !Array.isArray(operation.undo)
        ? operation.undo
        : null,
    progress: sanitizeOperationProgress(operation.progress),
    cancelRequestedAt: sanitizeOperationTimestamp(operation.cancelRequestedAt, null),
    retry: sanitizeOperationRetry(operation.retry),
    retryOf: sanitizeReferenceId(operation.retryOf),
    relatedOperationId: sanitizeReferenceId(operation.relatedOperationId),
    mcpProfileId: sanitizeReferenceId(operation.mcpProfileId),
    mcpSessionId: sanitizeReferenceId(operation.mcpSessionId),
    pausedAt: sanitizeOperationTimestamp(operation.pausedAt, null),
    resumedAt: sanitizeOperationTimestamp(operation.resumedAt, null),
    events: (Array.isArray(operation.events) ? operation.events : []).map(sanitizeOperationEvent).filter(Boolean).slice(-64)
  };
}

function operationHasRemainingRecovery(operation) {
  const recovery = operation?.result?.recovery;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) {
    return false;
  }
  return (
    recovery.canRetryRemaining === true ||
    Number(recovery.remainingCount || 0) > 0 ||
    (Array.isArray(recovery.remaining) && recovery.remaining.length > 0) ||
    Boolean(recovery.retry)
  );
}

function operationRetentionPriority(operation) {
  if (!operation || typeof operation !== "object") {
    return false;
  }
  if (interruptedOperationStatuses.has(operation.status)) {
    return true;
  }
  if (operationHasRemainingRecovery(operation)) {
    return true;
  }
  if ((operation.status === "failed" || operation.status === "canceled") && operation.retry) {
    return true;
  }
  return false;
}

function retainOperationHistory(operations, limit = operationHistoryLimit) {
  const source = Array.isArray(operations) ? operations.filter(Boolean) : [];
  const max = Math.max(1, Math.round(limit || operationHistoryLimit));
  if (source.length <= max) {
    return source;
  }
  const selectedIds = new Set();
  const selected = [];
  for (const operation of source) {
    if (operationRetentionPriority(operation) && !selectedIds.has(operation.id)) {
      selectedIds.add(operation.id);
      selected.push(operation);
      if (selected.length >= max) {
        break;
      }
    }
  }
  for (const operation of source) {
    if (selected.length >= max) {
      break;
    }
    if (!selectedIds.has(operation.id)) {
      selectedIds.add(operation.id);
      selected.push(operation);
    }
  }
  return source.filter((operation) => selectedIds.has(operation.id));
}

function sanitizeStoredOperations(operations) {
  const clean = [];
  for (const operation of Array.isArray(operations) ? operations : []) {
    const sanitized = sanitizeStoredOperation(operation);
    if (sanitized) {
      clean.push(sanitized);
      if (clean.length >= operationHistoryScanLimit) {
        break;
      }
    }
  }
  return retainOperationHistory(clean);
}

function mergeState(rawState) {
  const base = defaultState();
  const raw = rawState && typeof rawState === "object" ? rawState : {};
  return {
    ...base,
    ...raw,
    layout: sanitizeLayoutSnapshot(raw.layout || base.layout),
    settings: sanitizeSettings({ ...base.settings, ...(raw.settings || {}) }),
    integration: { ...base.integration, ...(raw.integration || {}) },
    favorites: Array.isArray(raw.favorites) ? raw.favorites : base.favorites,
    aliases: Array.isArray(raw.aliases) ? uniquePathAliases(raw.aliases).slice(0, 100) : base.aliases,
    recentLocations: Array.isArray(raw.recentLocations)
      ? raw.recentLocations.map(sanitizeRecentLocation).slice(0, 20)
      : base.recentLocations,
    fileBasket: Array.isArray(raw.fileBasket) ? uniqueCollectionItems(raw.fileBasket).slice(0, 1000) : [],
    collections: Array.isArray(raw.collections)
      ? raw.collections.map(sanitizeSavedCollection).slice(0, 50)
      : [],
    paneSnapshots: Array.isArray(raw.paneSnapshots)
      ? raw.paneSnapshots.map(sanitizePaneSnapshot).slice(0, 50)
      : [],
    selectionSets: Array.isArray(raw.selectionSets)
      ? raw.selectionSets.map(sanitizeSelectionSet).slice(0, 100)
      : [],
    labels: Array.isArray(raw.labels) ? uniquePathLabels(raw.labels).slice(0, 2500) : [],
    folderFormats: Array.isArray(raw.folderFormats)
      ? raw.folderFormats.map(sanitizeFolderFormat).slice(0, 50)
      : [],
    displayPresets: Array.isArray(raw.displayPresets)
      ? raw.displayPresets.map(sanitizeDisplayPreset).slice(0, 50)
      : [],
    filterPresets: Array.isArray(raw.filterPresets)
      ? raw.filterPresets.map(sanitizeFilterPreset).slice(0, 50)
      : [],
    syncProfiles: Array.isArray(raw.syncProfiles)
      ? raw.syncProfiles.map(sanitizeSyncProfile).slice(0, 50)
      : [],
    openWithPresets: Array.isArray(raw.openWithPresets)
      ? raw.openWithPresets.map(sanitizeOpenWithPreset).slice(0, 50)
      : [],
    searchPresets: Array.isArray(raw.searchPresets)
      ? raw.searchPresets.map(sanitizeSearchPreset).slice(0, 50)
      : [],
    selectPresets: Array.isArray(raw.selectPresets)
      ? raw.selectPresets.map(sanitizeSelectPreset).slice(0, 50)
      : [],
    bulkRenamePresets: Array.isArray(raw.bulkRenamePresets)
      ? raw.bulkRenamePresets.map(sanitizeBulkRenamePreset).slice(0, 50)
      : [],
    layouts: Array.isArray(raw.layouts) ? raw.layouts.map(sanitizeSavedLayout).slice(0, 30) : [],
    tabGroups: Array.isArray(raw.tabGroups) ? raw.tabGroups.map(sanitizeTabGroup).slice(0, 50) : [],
    backgroundIndexes: Array.isArray(raw.backgroundIndexes)
      ? uniqueBackgroundIndexRoots(raw.backgroundIndexes).slice(0, 50)
      : [],
    scripts: Array.isArray(raw.scripts) ? raw.scripts.map(sanitizeScriptSnippet).slice(0, 100) : base.scripts,
    commands: Array.isArray(raw.commands) ? raw.commands.map(sanitizeCommand) : base.commands,
    operations: sanitizeStoredOperations(raw.operations)
  };
}

function stateCacheKeyFromStat(stat) {
  return stat
    ? `${Number(stat.mtimeMs) || 0}:${Number(stat.ctimeMs) || 0}:${Number(stat.size) || 0}`
    : "missing";
}

function cloneState(state) {
  return typeof structuredClone === "function" ? structuredClone(state) : JSON.parse(JSON.stringify(state));
}

function stateContentHash(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex");
}

function parseStateText(text) {
  return JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
}

async function updateStateBackupFromCurrent() {
  let text = "";
  try {
    text = await fs.readFile(stateFile, "utf8");
    parseStateText(text);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Skipping state backup because the current state is unreadable: ${error.message}`);
    }
    return false;
  }

  const tempFile = path.join(
    appDataRoot,
    `state.json.bak.${process.pid}.${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  try {
    await fs.writeFile(tempFile, text, "utf8");
    await renamePathWithRetry(tempFile, stateBackupFile);
    return true;
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => {});
    console.warn(`Could not update state backup: ${error.message}`);
    return false;
  }
}

function updateStateCache(state, stat = null, contentHash = "") {
  const cachedState = mergeState(state);
  stateCache = {
    key: stateCacheKeyFromStat(stat),
    state: cachedState,
    labelMap: labelMapFromState(cachedState),
    dirty: false,
    watcher: stateCache.watcher,
    contentHash: contentHash || stateContentHash(JSON.stringify(cachedState)),
    checkedAt: Date.now()
  };
  return cachedState;
}

function completedCountFromProgress(progress, total) {
  const completed = Number(progress?.completed || 0);
  if (!Number.isFinite(completed)) {
    return 0;
  }
  return Math.max(0, Math.min(Math.floor(completed), Math.max(0, total)));
}

function recoveryRetryFromStoredRetry(retry) {
  const sanitized = sanitizeOperationRetry(retry);
  return sanitized ? retryRequestForOperation(sanitized.type, sanitized.body) : null;
}

function safeRecoveryListItem(itemPath, index, extra = {}) {
  try {
    return recoveryListItem(itemPath, index, extra);
  } catch {
    const text = String(itemPath || "");
    return {
      index,
      path: text,
      name: labelFromPath(text),
      ...extra
    };
  }
}

function recoveryResultFromPathRetry(operation, retry, recoveredAt, reason) {
  const body = retry.body || {};
  const paths = Array.isArray(body.paths) ? body.paths : [];
  const completedCount = completedCountFromProgress(operation.progress, paths.length);
  const completedPaths = paths.slice(0, completedCount);
  const remainingPaths = paths.slice(completedCount);
  const retryRequest =
    retryRequestForOperation(retry.type, { ...body, paths: remainingPaths }) ||
    retryRequestForOperation(retry.type, body);

  return {
    ...(operation.result || {}),
    error: operation.result?.error || reason,
    recovery: {
      ...(operation.result?.recovery || {}),
      type: retry.type,
      targetDir: body.targetDir ? resolveUserPath(body.targetDir) : null,
      completedCount: completedPaths.length,
      remainingCount: remainingPaths.length,
      completed: completedPaths.map((itemPath, index) =>
        safeRecoveryListItem(itemPath, index, { unverified: true })
      ),
      failed: remainingPaths[0]
        ? safeRecoveryListItem(remainingPaths[0], completedCount, {
            reason,
            unverified: true
          })
        : null,
      remaining: remainingPaths.map((itemPath, offset) =>
        safeRecoveryListItem(itemPath, completedCount + offset, { unverified: true })
      ),
      retry: retryRequest,
      canRetryRemaining: Boolean(retryRequest),
      interrupted: true,
      interruptedAt: recoveredAt,
      recoveredAt,
      reason,
      partialCompletionUnverified: true
    }
  };
}

function syncRecoveryListItemFromRelative(relativePath, index, sourceRoot, destRoot, extra = {}) {
  try {
    const safePath = safeCompareRelativePath(relativePath);
    return {
      index,
      path: resolveRelativeUnderRoot(sourceRoot, safePath.rel),
      dest: resolveRelativeUnderRoot(destRoot, safePath.rel),
      name: safePath.relativePath,
      relativePath: safePath.relativePath,
      ...extra
    };
  } catch {
    const text = String(relativePath || "");
    return {
      index,
      path: text,
      dest: null,
      name: text,
      relativePath: text,
      ...extra
    };
  }
}

function recoveryResultFromSyncRetry(operation, retry, recoveredAt, reason) {
  const body = retry.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  const completedCount = completedCountFromProgress(operation.progress, items.length);
  const completedItems = items.slice(0, completedCount);
  const remainingItems = items.slice(completedCount);
  const direction = body.direction === "rightToLeft" ? "rightToLeft" : "leftToRight";
  const leftRoot = resolveUserPath(body.leftPath || "");
  const rightRoot = resolveUserPath(body.rightPath || "");
  const sourceRoot = direction === "leftToRight" ? leftRoot : rightRoot;
  const destRoot = direction === "leftToRight" ? rightRoot : leftRoot;
  const retryRequest =
    retryRequestForOperation("sync", { ...body, items: remainingItems }) ||
    retryRequestForOperation("sync", body);

  return {
    ...(operation.result || {}),
    error: operation.result?.error || reason,
    recovery: {
      ...(operation.result?.recovery || {}),
      type: "sync",
      direction,
      targetDir: null,
      completedCount: completedItems.length,
      remainingCount: remainingItems.length,
      completed: completedItems.map((item, index) =>
        syncRecoveryListItemFromRelative(item, index, sourceRoot, destRoot, { unverified: true })
      ),
      failed: remainingItems[0]
        ? syncRecoveryListItemFromRelative(remainingItems[0], completedCount, sourceRoot, destRoot, {
            reason,
            unverified: true
          })
        : null,
      remaining: remainingItems.map((item, offset) =>
        syncRecoveryListItemFromRelative(item, completedCount + offset, sourceRoot, destRoot, { unverified: true })
      ),
      retry: retryRequest,
      canRetryRemaining: Boolean(retryRequest),
      interrupted: true,
      interruptedAt: recoveredAt,
      recoveredAt,
      reason,
      partialCompletionUnverified: true
    }
  };
}

function fallbackInterruptedRecoveryResult(operation, retry, recoveredAt, reason) {
  const retryRequest = recoveryRetryFromStoredRetry(retry);
  return {
    ...(operation.result || {}),
    error: operation.result?.error || reason,
    recovery: {
      ...(operation.result?.recovery || {}),
      type: retry?.type || operation.type,
      targetDir: retry?.body?.targetDir ? resolveUserPath(retry.body.targetDir) : null,
      completedCount: Number(operation.progress?.completed || 0) || 0,
      remainingCount: retryRequest ? 1 : 0,
      completed: [],
      failed: null,
      remaining: [],
      retry: retryRequest,
      canRetryRemaining: Boolean(retryRequest),
      interrupted: true,
      interruptedAt: recoveredAt,
      recoveredAt,
      reason,
      partialCompletionUnverified: true
    }
  };
}

function interruptedRecoveryResult(operation, recoveredAt, reason) {
  const existingRecovery = operation.result?.recovery;
  const existingRetry = recoveryRetryFromStoredRetry(existingRecovery?.retry);
  const operationRetry = sanitizeOperationRetry(operation.retry);
  if (existingRecovery) {
    const hasExplicitRetry = Object.prototype.hasOwnProperty.call(existingRecovery, "retry");
    const retry = hasExplicitRetry
      ? existingRecovery.retry || null
      : existingRetry || (operationRetry ? retryRequestForOperation(operationRetry.type, operationRetry.body) : null);
    const canRetryRemaining = Object.prototype.hasOwnProperty.call(existingRecovery, "canRetryRemaining")
      ? existingRecovery.canRetryRemaining === true
      : Boolean(retry);
    return {
      ...(operation.result || {}),
      error: operation.result?.error || reason,
      recovery: {
        ...existingRecovery,
        retry,
        canRetryRemaining,
        interrupted: true,
        interruptedAt: existingRecovery.interruptedAt || recoveredAt,
        recoveredAt,
        reason,
        partialCompletionUnverified: existingRecovery.partialCompletionUnverified ?? true
      }
    };
  }

  if (!operationRetry) {
    return fallbackInterruptedRecoveryResult(operation, null, recoveredAt, reason);
  }
  if (operationRetry.type === "sync") {
    return recoveryResultFromSyncRetry(operation, operationRetry, recoveredAt, reason);
  }
  if (Array.isArray(operationRetry.body?.paths)) {
    return recoveryResultFromPathRetry(operation, operationRetry, recoveredAt, reason);
  }
  return fallbackInterruptedRecoveryResult(operation, operationRetry, recoveredAt, reason);
}

function recoverInterruptedOperationsOnStartup(state) {
  const nextState = mergeState(state);
  if (startupOperationRecoveryChecked) {
    return { state: nextState, changed: false };
  }
  startupOperationRecoveryChecked = true;
  const recoveredAt = new Date().toISOString();
  const reason = "Operation interrupted by app restart before completion.";
  let changed = false;
  nextState.operations = (nextState.operations || []).map((operation) => {
    if (!interruptedOperationStatuses.has(operation?.status)) {
      return operation;
    }
    changed = true;
    const progress = operation.progress
      ? {
          ...operation.progress,
          phase: "Interrupted",
          updatedAt: recoveredAt
        }
      : {
          unit: "items",
          total: 0,
          completed: 0,
          phase: "Interrupted",
          updatedAt: recoveredAt
        };
    const recovered = {
      ...operation,
      status: "failed",
      finishedAt: operation.finishedAt || recoveredAt,
      interruptedAt: operation.interruptedAt || recoveredAt,
      recoveredAt,
      error: reason,
      progress,
      result: interruptedRecoveryResult({ ...operation, progress }, recoveredAt, reason),
      retry: sanitizeOperationRetry(operation.retry),
      undo: operation.undo || null
    };
    appendOperationEvent(recovered, { at: recoveredAt, kind: "recovered", phase: "Interrupted", message: reason });
    return recovered;
  });
  if (changed) {
    nextState.updatedAt = recoveredAt;
  }
  return { state: nextState, changed };
}

function operationHistoryNeedsPersist(state, normalizedState) {
  const rawOperations = Array.isArray(state?.operations) ? state.operations : [];
  const normalizedOperations = Array.isArray(normalizedState?.operations) ? normalizedState.operations : [];
  return JSON.stringify(rawOperations) !== JSON.stringify(normalizedOperations);
}

async function cacheStateAfterStartupRecovery(state, stat = null, contentHash = "") {
  const recovery = recoverInterruptedOperationsOnStartup(state);
  if (recovery.changed || operationHistoryNeedsPersist(state, recovery.state)) {
    return writeState(recovery.state);
  }
  return updateStateCache(recovery.state, stat, contentHash);
}

async function ensureStateCacheWatcher() {
  if (stateCache.watcher || process.env.EXPLORE_BETTER_DISABLE_STATE_WATCH === "1") {
    return;
  }
  try {
    await fs.mkdir(appDataRoot, { recursive: true });
    const watcher = watch(appDataRoot, { persistent: false }, (eventType, filename) => {
      if (!filename || String(filename).toLowerCase() === "state.json") {
        stateCache.dirty = true;
      }
    });
    watcher.on("error", (error) => {
      console.warn(`Could not watch state file: ${error.message}`);
      stateCache.watcher = null;
      stateCache.dirty = true;
    });
    stateCache.watcher = watcher;
  } catch (error) {
    console.warn(`Could not watch state folder: ${error.message}`);
    stateCache.dirty = true;
  }
}

async function statStateFile() {
  try {
    return await fs.stat(stateFile);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not stat state file: ${error.message}`);
    }
    return null;
  }
}

async function restoreStateFromBackup(reason) {
  try {
    const text = await fs.readFile(stateBackupFile, "utf8");
    const backupState = parseStateText(text);
    console.warn(`Restoring state from backup after read failure: ${reason?.message || reason}`);
    await fs.mkdir(appDataRoot, { recursive: true });
    await fs.copyFile(stateBackupFile, stateFile).catch(() => {});
    const stat = await statStateFile();
    return cacheStateAfterStartupRecovery(backupState, stat, stateContentHash(text));
  } catch {
    return null;
  }
}

async function readCachedState() {
  await ensureStateCacheWatcher();
  const stat = await statStateFile();
  const key = stateCacheKeyFromStat(stat);
  if (stateCache.state && stateCache.key === key && !stateCache.dirty) {
    if (stat && Date.now() - Number(stateCache.checkedAt || 0) >= stateCacheContentCheckTtlMs) {
      try {
        const text = await fs.readFile(stateFile, "utf8");
        const contentHash = stateContentHash(text);
        if (contentHash !== stateCache.contentHash) {
          return cacheStateAfterStartupRecovery(parseStateText(text), stat, contentHash);
        }
        stateCache.checkedAt = Date.now();
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.warn(`Could not verify state file cache: ${error.message}`);
        }
        stateCache.dirty = true;
      }
    }
    if (!stateCache.dirty) {
      return stateCache.state;
    }
  }
  if (!stat) {
    const backupState = await restoreStateFromBackup(new Error("state file missing"));
    if (backupState) {
      return backupState;
    }
    return cacheStateAfterStartupRecovery(defaultState(), null);
  }
  try {
    const text = await fs.readFile(stateFile, "utf8");
    return cacheStateAfterStartupRecovery(parseStateText(text), stat, stateContentHash(text));
  } catch (error) {
    if (error.code === "ENOENT") {
      const backupState = await restoreStateFromBackup(error);
      if (backupState) {
        return backupState;
      }
      return cacheStateAfterStartupRecovery(defaultState(), null);
    }
    console.warn(`Could not read state file: ${error.message}`);
    const backupState = await restoreStateFromBackup(error);
    if (backupState) {
      return backupState;
    }
    const fallbackState = mergeState(defaultState());
    stateCache = {
      key: null,
      state: fallbackState,
      labelMap: labelMapFromState(fallbackState),
      dirty: true,
      watcher: stateCache.watcher,
      contentHash: stateContentHash(JSON.stringify(fallbackState)),
      checkedAt: Date.now()
    };
    return fallbackState;
  }
}

async function readState(options = {}) {
  const state = await readCachedState();
  return options.clone === false ? state : cloneState(state);
}

async function readLabelState() {
  await readCachedState();
  return {
    labelMap: stateCache.labelMap || new Map(),
    labelStamp: stateCache.contentHash || stateCache.key || ""
  };
}

async function readLabelMap() {
  return (await readLabelState()).labelMap;
}

async function writeState(state) {
  const nextState = mergeState({
    ...state,
    updatedAt: new Date().toISOString()
  });
  await fs.mkdir(appDataRoot, { recursive: true });
  const text = JSON.stringify(nextState, null, 2);
  const tempFile = path.join(
    appDataRoot,
    `state.json.${process.pid}.${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  await fs.writeFile(tempFile, text, "utf8");
  if (testStateWriteDelayMs) {
    await new Promise((resolve) => setTimeout(resolve, testStateWriteDelayMs));
  }
  await updateStateBackupFromCurrent();
  try {
    await renamePathWithRetry(tempFile, stateFile);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
  const stat = await statStateFile();
  return cloneState(updateStateCache(nextState, stat, stateContentHash(text)));
}

function transientPathRenameError(error) {
  return ["EBUSY", "EPERM", "EACCES"].includes(error?.code);
}

async function renamePathWithRetry(source, dest, attempts = 8) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fs.rename(source, dest);
      return;
    } catch (error) {
      lastError = error;
      if (!transientPathRenameError(error) || attempt === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function mutateState(mutator) {
  const run = async () => {
    const state = await readState();
    const result = await mutator(state);
    const saved = await writeState(state);
    return result === undefined ? saved : result;
  };
  stateChain = stateChain.then(run, run);
  return stateChain;
}

function sanitizeFavorite(favorite) {
  return {
    id: String(favorite.id || crypto.randomUUID()),
    name: String(favorite.name || labelFromPath(favorite.path)),
    path: resolveUserPath(favorite.path),
    color: String(favorite.color || "teal").slice(0, 24)
  };
}

function normalizeAliasName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function sanitizePathAlias(alias) {
  const source = alias && typeof alias === "object" ? alias : {};
  const name = normalizeAliasName(source.name || source.alias || source.id);
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name)) {
    throw new Error("Alias names must start with a letter and use 2-32 letters, numbers, hyphens, or underscores.");
  }
  const aliasPath = resolveUserPath(source.path);
  return {
    id: String(source.id || crypto.randomUUID()),
    name,
    path: aliasPath,
    description: String(source.description || source.notes || "").trim().slice(0, 160),
    updatedAt: source.updatedAt ? String(source.updatedAt).slice(0, 40) : new Date().toISOString()
  };
}

function uniquePathAliases(aliases) {
  const byName = new Map();
  for (const alias of (Array.isArray(aliases) ? aliases : []).slice(0, 150)) {
    try {
      const sanitized = sanitizePathAlias(alias);
      byName.set(sanitized.name, sanitized);
    } catch {
      // Ignore malformed saved aliases so one stale entry cannot reset the whole state file.
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function sanitizeRecentLocation(recent) {
  const source = recent && typeof recent === "object" ? recent : { path: recent };
  const locationPath = resolveUserPath(source.path);
  const visitedAt = Number.isFinite(Date.parse(source.visitedAt))
    ? new Date(source.visitedAt).toISOString()
    : new Date().toISOString();
  return {
    name: String(source.name || labelFromPath(locationPath)).trim().slice(0, 80),
    path: locationPath,
    visitedAt
  };
}

const labelColors = new Set(["teal", "gold", "ember", "violet", "green", "black"]);

function sanitizeLabelColor(value) {
  const color = String(value || "teal").toLowerCase();
  return labelColors.has(color) ? color : "teal";
}

function sanitizePathLabel(label) {
  const source = label && typeof label === "object" ? label : {};
  const labelPath = resolveUserPath(source.path);
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : new Date().toISOString();
  return {
    path: labelPath,
    name: String(source.name || "Marked").trim().slice(0, 40),
    color: sanitizeLabelColor(source.color),
    notes: String(source.notes || source.description || "").trim().slice(0, 240),
    updatedAt
  };
}

function uniquePathLabels(labels) {
  const byPath = new Map();
  const sources = Array.isArray(labels) ? labels : [];
  for (const label of sources.slice(0, 3000)) {
    if (!label?.path) {
      continue;
    }
    const sanitized = sanitizePathLabel(label);
    byPath.set(pathIdentity(sanitized.path), sanitized);
  }
  return [...byPath.values()].slice(0, 2500);
}

function pathShiftedByTransfer(labelPath, sourcePath, destPath) {
  const labelResolved = resolveUserPath(labelPath);
  const sourceResolved = resolveUserPath(sourcePath);
  const destResolved = resolveUserPath(destPath);
  if (!isInsidePath(labelResolved, sourceResolved)) {
    return null;
  }
  const relative = path.relative(sourceResolved, labelResolved);
  return relative ? path.join(destResolved, relative) : destResolved;
}

async function updateLabelsForTransfers(items, mode = "move") {
  const transfers = (Array.isArray(items) ? items : [])
    .filter((item) => item?.source && item?.dest)
    .map((item) => ({
      source: resolveUserPath(item.source),
      dest: resolveUserPath(item.dest)
    }));
  if (!transfers.length) {
    return;
  }

  await mutateState((state) => {
    const nextLabels = [];
    const copiedLabels = [];
    const now = new Date().toISOString();

    for (const label of state.labels || []) {
      const matchingTransfer = transfers.find((item) =>
        pathShiftedByTransfer(label.path, item.source, item.dest)
      );
      if (!matchingTransfer) {
        nextLabels.push(label);
        continue;
      }

      const shiftedPath = pathShiftedByTransfer(label.path, matchingTransfer.source, matchingTransfer.dest);
      const shiftedLabel = sanitizePathLabel({
        ...label,
        path: shiftedPath,
        updatedAt: now
      });

      if (mode === "copy") {
        nextLabels.push(label);
        copiedLabels.push(shiftedLabel);
      } else {
        nextLabels.push(shiftedLabel);
      }
    }

    state.labels = uniquePathLabels([...nextLabels, ...copiedLabels]);
  });
}

async function clearPathLabelsUnder(paths) {
  const roots = (Array.isArray(paths) ? paths : []).map(resolveUserPath).filter(Boolean);
  if (!roots.length) {
    return;
  }
  await mutateState((state) => {
    state.labels = (state.labels || []).filter((label) => {
      const labelPath = resolveUserPath(label.path);
      return !roots.some((root) => isInsidePath(labelPath, root));
    });
  });
}

function labelMapFromState(state) {
  return new Map((state.labels || []).map((label) => [pathIdentity(label.path), label]));
}

function attachPathLabels(entries, labelsOrState) {
  const labelMap =
    labelsOrState instanceof Map
      ? labelsOrState
      : labelMapFromState(Array.isArray(labelsOrState) ? { labels: labelsOrState } : labelsOrState || {});
  if (!labelMap.size) {
    return entries;
  }
  return entries.map((entry) => {
    const label = labelMap.get(pathIdentity(entry.path));
    if (!label) {
      return entry;
    }
    return {
      ...entry,
      label: {
        name: label.name,
        color: label.color,
        notes: label.notes,
        updatedAt: label.updatedAt
      }
    };
  });
}

function uniqueCollectionItems(items) {
  const seen = new Set();
  const unique = [];
  const sources = Array.isArray(items) ? items : [];
  for (const item of sources.slice(0, 2500)) {
    const source = item && typeof item === "object" ? item : { path: item };
    if (!source.path) {
      continue;
    }
    const itemPath = resolveUserPath(source.path);
    const key = pathIdentity(itemPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push({
      path: itemPath,
      addedAt: Number.isFinite(Date.parse(source.addedAt))
        ? new Date(source.addedAt).toISOString()
        : new Date().toISOString()
    });
  }
  return unique.slice(0, 2000);
}

function sanitizeSavedCollection(collection) {
  const source = collection && typeof collection === "object" ? collection : {};
  const now = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? new Date(source.createdAt).toISOString()
    : now;
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : now;
  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || "New Collection").trim().slice(0, 80),
    description: String(source.description || "").trim().slice(0, 240),
    color: String(source.color || "teal").slice(0, 24),
    createdAt,
    updatedAt,
    items: uniqueCollectionItems(source.items)
  };
}

function sanitizeSnapshotEntry(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  const entryPath = resolveUserPath(source.path);
  const parentPath = source.parent ? resolveUserPath(source.parent) : path.dirname(entryPath);
  const isDirectory = Boolean(source.isDirectory);
  const isFile = source.isFile === true || !isDirectory;
  const name = String(source.name || path.basename(entryPath) || entryPath).trim().slice(0, 260);
  const sourceAttributes = source.attributes && typeof source.attributes === "object" ? source.attributes : {};
  const attributeFlags =
    source.attributeText ||
    sourceAttributes.text ||
    sourceAttributes.flags ||
    [
      source.readonly || sourceAttributes.readonly ? "R" : "",
      source.hidden || sourceAttributes.hidden ? "H" : "",
      source.system || sourceAttributes.system ? "S" : "",
      source.archive || sourceAttributes.archive ? "A" : ""
    ].join("");
  const attributes = attributesForEntry(name, null, attributeFlags);
  return {
    name,
    path: entryPath,
    parent: parentPath,
    extension: String(source.extension || path.extname(entryPath)).trim().slice(0, 40),
    kind: String(source.kind || (isDirectory ? "Folder" : "File")).trim().slice(0, 40),
    isDirectory,
    isFile,
    size: source.size === null || source.size === undefined ? null : Number.isFinite(Number(source.size)) ? Number(source.size) : null,
    modified: Number.isFinite(Date.parse(source.modified)) ? new Date(source.modified).toISOString() : null,
    created: Number.isFinite(Date.parse(source.created)) ? new Date(source.created).toISOString() : null,
    accessed: Number.isFinite(Date.parse(source.accessed)) ? new Date(source.accessed).toISOString() : null,
    attributes,
    readonly: attributes.readonly,
    hidden: attributes.hidden,
    system: attributes.system,
    archive: attributes.archive,
    attributeText: attributes.text,
    isSymlink: source.isSymlink === true,
    linkType: String(source.linkType || "").trim().slice(0, 40),
    linkTarget: String(source.linkTarget || "").trim().slice(0, 1200),
    linkTargetRaw: String(source.linkTargetRaw || "").trim().slice(0, 1200),
    linkCount:
      source.linkCount === null || source.linkCount === undefined
        ? null
        : Number.isFinite(Number(source.linkCount))
          ? Number(source.linkCount)
          : null,
    unavailable: source.unavailable === true
  };
}

function sanitizePaneSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const now = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? new Date(source.createdAt).toISOString()
    : now;
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : now;
  const tab = sanitizeLayoutTab(
    {
      path: source.path || workspaceRoot,
      title: source.title,
      filter: source.filter,
      labelFilter: source.labelFilter,
      columns: source.columns,
      columnWidths: source.columnWidths,
      sortKey: source.sortKey,
      sortDir: source.sortDir,
      viewMode: source.viewMode,
      locked: source.locked
    },
    workspaceRoot
  );
  const selected = new Set(
    (Array.isArray(source.selected) ? source.selected : [])
      .slice(0, 1000)
      .filter(Boolean)
      .map((item) => pathIdentity(resolveUserPath(item)))
  );
  const entries = (Array.isArray(source.entries) ? source.entries : [])
    .slice(0, 2000)
    .filter((entry) => entry?.path)
    .map(sanitizeSnapshotEntry);
  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || "Pane Snapshot").trim().slice(0, 80),
    description: String(source.description || "").trim().slice(0, 240),
    sourcePane: source.sourcePane === "right" ? "right" : "left",
    createdAt,
    updatedAt,
    path: tab.path,
    title: tab.title,
    filter: tab.filter,
    labelFilter: tab.labelFilter,
    columns: tab.columns,
    columnWidths: tab.columnWidths,
    sortKey: tab.sortKey,
    sortDir: tab.sortDir,
    viewMode: tab.viewMode,
    locked: tab.locked,
    selected: entries.filter((entry) => selected.has(pathIdentity(entry.path))).map((entry) => entry.path),
    focusedPath: source.focusedPath ? resolveUserPath(source.focusedPath) : null,
    entries
  };
}

function sanitizeLayoutTab(tab, fallbackPath) {
  const source = tab && typeof tab === "object" ? tab : {};
  const itemPath = resolveUserPath(source.path || fallbackPath || workspaceRoot);
  const allowedSorts = new Set([
    "name",
    "kind",
    "extension",
    "size",
    "dimensions",
    "attributes",
    "linkType",
    "linkTarget",
    "modified",
    "created",
    "accessed",
    "label",
    "notes",
    "parent"
  ]);
  const allowedViews = new Set(["details", "compact", "tiles"]);
  const allowedKinds = new Set(["all", "folders", "files", "images", "text", "documents", "media", "archives", "apps"]);
  const allowedColumns = new Set([
    "name",
    "kind",
    "extension",
    "size",
    "dimensions",
    "attributes",
    "linkType",
    "linkTarget",
    "modified",
    "created",
    "accessed",
    "label",
    "notes",
    "parent"
  ]);
  const cleanPathList = (items) =>
    (Array.isArray(items) ? items : [])
      .filter(Boolean)
      .slice(-20)
      .map((item) => resolveUserPath(item));
  const cleanColumns = (items) => {
    const columns = [];
    for (const column of Array.isArray(items) ? items : ["name", "kind", "size", "modified"]) {
      if (allowedColumns.has(column) && !columns.includes(column)) {
        columns.push(column);
      }
    }
    if (!columns.includes("name")) {
      columns.unshift("name");
    }
    return columns.slice(0, allowedColumns.size);
  };
  const cleanColumnWidths = (items) => {
    const source = items && typeof items === "object" ? items : {};
    const widths = {};
    for (const [column, width] of Object.entries(source)) {
      if (allowedColumns.has(column)) {
        widths[column] = Math.round(clampNumber(width, 56, 860, 96));
      }
    }
    return widths;
  };

  return {
    path: itemPath,
    title: String(source.title || labelFromPath(itemPath)).trim().slice(0, 80),
    parent: source.parent ? resolveUserPath(source.parent) : null,
    history: cleanPathList(source.history),
    future: cleanPathList(source.future),
    filter: String(source.filter || "").slice(0, 200),
    kindFilter: allowedKinds.has(source.kindFilter) ? source.kindFilter : "all",
    labelFilter: String(source.labelFilter || "all").slice(0, 40),
    columns: cleanColumns(source.columns),
    columnWidths: cleanColumnWidths(source.columnWidths),
    sortKey: allowedSorts.has(source.sortKey) ? source.sortKey : "name",
    sortDir: source.sortDir === "desc" ? "desc" : "asc",
    viewMode: allowedViews.has(source.viewMode) ? source.viewMode : "details",
    locked: source.locked === true
  };
}

function sanitizeLayoutPane(pane, fallbackPath) {
  const source = pane && typeof pane === "object" ? pane : {};
  const rawTabs = Array.isArray(source.tabs) && source.tabs.length ? source.tabs : [{ path: fallbackPath }];
  const tabs = rawTabs.slice(0, 16).map((tab) => sanitizeLayoutTab(tab, fallbackPath));
  return {
    activeTab: Math.max(0, Math.min(Number(source.activeTab || 0), tabs.length - 1)),
    tabs
  };
}

function sanitizePaneLayout(layoutMode) {
  return ["vertical", "horizontal", "single"].includes(layoutMode) ? layoutMode : "vertical";
}

function sanitizeLayoutSnapshot(layout) {
  const source = layout && typeof layout === "object" ? layout : {};
  const panes = source.panes && typeof source.panes === "object" ? source.panes : {};
  return {
    activePane: source.activePane === "right" ? "right" : "left",
    paneLayout: sanitizePaneLayout(source.paneLayout || source.layoutMode || source.mode),
    panes: {
      left: sanitizeLayoutPane(panes.left, workspaceRoot),
      right: sanitizeLayoutPane(panes.right, os.homedir())
    }
  };
}

function sanitizeSavedLayout(savedLayout) {
  const source = savedLayout && typeof savedLayout === "object" ? savedLayout : {};
  const now = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? new Date(source.createdAt).toISOString()
    : now;
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : now;
  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || "Saved Layout").trim().slice(0, 80),
    description: String(source.description || "").trim().slice(0, 240),
    createdAt,
    updatedAt,
    layout: sanitizeLayoutSnapshot(source.layout)
  };
}

function sanitizeTabGroup(tabGroup) {
  const source = tabGroup && typeof tabGroup === "object" ? tabGroup : {};
  const now = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? new Date(source.createdAt).toISOString()
    : now;
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : now;
  const pane = sanitizeLayoutPane(source, workspaceRoot);
  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || "Tab Group").trim().slice(0, 80),
    description: String(source.description || "").trim().slice(0, 240),
    sourcePane: source.sourcePane === "right" ? "right" : "left",
    createdAt,
    updatedAt,
    activeTab: pane.activeTab,
    tabs: pane.tabs
  };
}

function sanitizeSelectionSet(selectionSet) {
  const source = selectionSet && typeof selectionSet === "object" ? selectionSet : {};
  const now = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? new Date(source.createdAt).toISOString()
    : now;
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : now;
  const rawPaths = Array.isArray(source.paths)
    ? source.paths
    : source.items?.map((item) => item.path) || [];
  const paths = [
    ...new Set(rawPaths.filter(Boolean).map((itemPath) => resolveUserPath(itemPath)))
  ].slice(0, 1000);
  const itemByPath = new Map(
    (Array.isArray(source.items) ? source.items : [])
      .filter((item) => item?.path)
      .map((item) => [pathIdentity(resolveUserPath(item.path)), item])
  );
  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || "Selection Set").trim().slice(0, 80),
    description: String(source.description || "").trim().slice(0, 240),
    path: resolveUserPath(source.path || workspaceRoot),
    createdAt,
    updatedAt,
    paths,
    items: paths.map((itemPath) => {
      const item = itemByPath.get(pathIdentity(itemPath)) || {};
      return {
        path: itemPath,
        name: String(item.name || path.basename(itemPath)).slice(0, 240),
        kind: String(item.kind || "").slice(0, 80),
        isDirectory: item.isDirectory === true,
        size: Number.isFinite(Number(item.size)) ? Number(item.size) : null
      };
    })
  };
}

function sanitizeFolderFormat(folderFormat) {
  const source = folderFormat && typeof folderFormat === "object" ? folderFormat : {};
  const now = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? new Date(source.createdAt).toISOString()
    : now;
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : now;
  const allowedMatches = new Set(["exact", "subtree"]);
  const format = source.format && typeof source.format === "object" ? source.format : {};
  const sanitizedTab = sanitizeLayoutTab(
    {
      path: source.path || workspaceRoot,
      viewMode: format.viewMode,
      sortKey: format.sortKey,
      sortDir: format.sortDir,
      columns: format.columns,
      columnWidths: format.columnWidths,
      kindFilter: format.kindFilter,
      labelFilter: format.labelFilter
    },
    workspaceRoot
  );

  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || "Folder Format").trim().slice(0, 80),
    description: String(source.description || "").trim().slice(0, 240),
    path: resolveUserPath(source.path || workspaceRoot),
    match: allowedMatches.has(source.match) ? source.match : "exact",
    createdAt,
    updatedAt,
    format: {
      viewMode: sanitizedTab.viewMode,
      sortKey: sanitizedTab.sortKey,
      sortDir: sanitizedTab.sortDir,
      columns: sanitizedTab.columns,
      columnWidths: sanitizedTab.columnWidths,
      kindFilter: sanitizedTab.kindFilter,
      labelFilter: sanitizedTab.labelFilter
    }
  };
}

function sanitizeDisplayPreset(displayPreset) {
  const source = displayPreset && typeof displayPreset === "object" ? displayPreset : {};
  const format = source.format && typeof source.format === "object" ? source.format : source;
  const now = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? new Date(source.createdAt).toISOString()
    : now;
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : now;
  const sanitizedTab = sanitizeLayoutTab(
    {
      path: source.path || workspaceRoot,
      viewMode: format.viewMode,
      sortKey: format.sortKey,
      sortDir: format.sortDir,
      columns: format.columns,
      columnWidths: format.columnWidths,
      kindFilter: format.kindFilter,
      labelFilter: format.labelFilter
    },
    workspaceRoot
  );

  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || "Display Preset").trim().slice(0, 80),
    description: String(source.description || "").trim().slice(0, 240),
    createdAt,
    updatedAt,
    format: {
      viewMode: sanitizedTab.viewMode,
      sortKey: sanitizedTab.sortKey,
      sortDir: sanitizedTab.sortDir,
      columns: sanitizedTab.columns,
      columnWidths: sanitizedTab.columnWidths,
      kindFilter: sanitizedTab.kindFilter,
      labelFilter: sanitizedTab.labelFilter
    }
  };
}

function sanitizeFilterPresetOptions(options) {
  const source = options && typeof options === "object" ? options : {};
  const allowedKinds = new Set(["all", "folders", "files", "images", "text", "documents", "media", "archives", "apps"]);
  return {
    filter: String(source.filter || source.text || "").trim().slice(0, 200),
    kindFilter: allowedKinds.has(source.kindFilter) ? source.kindFilter : "all",
    labelFilter: String(source.labelFilter || "all").trim().slice(0, 40) || "all"
  };
}

function sanitizeFilterPreset(filterPreset) {
  const source = filterPreset && typeof filterPreset === "object" ? filterPreset : {};
  const now = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? new Date(source.createdAt).toISOString()
    : now;
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : now;
  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || "Filter Preset").trim().slice(0, 80),
    description: String(source.description || "").trim().slice(0, 240),
    createdAt,
    updatedAt,
    options: sanitizeFilterPresetOptions(source.options || source)
  };
}

function sanitizeSearchPresetOptions(options) {
  const source = options && typeof options === "object" ? options : {};
  const allowedKinds = new Set(["all", "files", "folders", "text", "images", "documents"]);
  const allowedSizeOps = new Set(["any", "greater", "less", "equal"]);
  const allowedDateOps = new Set(["any", "newer", "older"]);
  const allowedAttributes = new Set([
    "any",
    "readonly",
    "hidden",
    "system",
    "archive",
    "compressed",
    "encrypted",
    "none"
  ]);
  const sizeOp = allowedSizeOps.has(source.sizeOp) ? source.sizeOp : "any";
  const dateOp = allowedDateOps.has(source.dateOp) ? source.dateOp : "any";
  const dateDays = Number(source.dateDays);
  return {
    path: resolveUserPath(source.path || workspaceRoot),
    query: String(source.query || "").trim().slice(0, 200),
    content: String(source.content || "").trim().slice(0, 200),
    kind: allowedKinds.has(source.kind) ? source.kind : "all",
    sizeOp,
    sizeValue: sizeOp === "any" ? "" : String(source.sizeValue || "").trim().slice(0, 40),
    dateField: source.dateField === "created" ? "created" : "modified",
    dateOp,
    dateDays: dateOp === "any" || !Number.isFinite(dateDays) ? "" : String(Math.max(0, Math.floor(dateDays))),
    attribute: allowedAttributes.has(source.attribute) ? source.attribute : "any",
    limit: Math.max(1, Math.min(Number(source.limit || 200), 1000)),
    maxScanned: Math.max(100, Math.min(Number(source.maxScanned || 8000), 50_000)),
    maxContentBytes: Math.max(1024, Math.min(Number(source.maxContentBytes || 512_000), 5_000_000)),
    includeHidden: Boolean(source.includeHidden)
  };
}

function sanitizeSearchPreset(searchPreset) {
  const source = searchPreset && typeof searchPreset === "object" ? searchPreset : {};
  const now = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? new Date(source.createdAt).toISOString()
    : now;
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : now;
  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || "Search Preset").trim().slice(0, 80),
    description: String(source.description || "").trim().slice(0, 240),
    createdAt,
    updatedAt,
    options: sanitizeSearchPresetOptions(source.options || source)
  };
}

function sanitizeSyncProfileOptions(options) {
  const source = options && typeof options === "object" ? options : {};
  const maxEntries = Number(source.maxEntries || 20000);
  return {
    leftPath: resolveUserPath(source.leftPath || workspaceRoot),
    rightPath: resolveUserPath(source.rightPath || os.homedir()),
    recursive: source.recursive !== false,
    includeHidden: Boolean(source.includeHidden),
    maxEntries: Number.isFinite(maxEntries) ? Math.max(100, Math.min(maxEntries, 100_000)) : 20000,
    overwrite: source.overwrite !== false,
    mirrorDeletes: Boolean(source.mirrorDeletes)
  };
}

function sanitizeSyncProfile(syncProfile) {
  const source = syncProfile && typeof syncProfile === "object" ? syncProfile : {};
  const now = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? new Date(source.createdAt).toISOString()
    : now;
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : now;
  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || "Sync Profile").trim().slice(0, 80),
    description: String(source.description || "").trim().slice(0, 240),
    createdAt,
    updatedAt,
    options: sanitizeSyncProfileOptions(source.options || source)
  };
}

function sanitizeOpenWithPreset(openWithPreset) {
  const source = openWithPreset && typeof openWithPreset === "object" ? openWithPreset : {};
  const now = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? new Date(source.createdAt).toISOString()
    : now;
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : now;
  const appPath = String(source.appPath || source.application || "").trim().slice(0, 1000);
  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || appPath || "Open With Preset").trim().slice(0, 80),
    description: String(source.description || "").trim().slice(0, 240),
    createdAt,
    updatedAt,
    appPath,
    argsTemplate: String(source.argsTemplate || source.args || "{path}").trim().slice(0, 2000) || "{path}",
    workingDirectory: String(source.workingDirectory || source.cwd || "").trim().slice(0, 1000),
    extensions: sanitizeOpenWithExtensions(source.extensions || source.extensionMatches || source.matchExtensions)
  };
}

function sanitizeOpenWithExtensions(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[,\s;]+/);
  const extensions = [];
  for (const item of items) {
    const text = String(item || "").trim().toLowerCase();
    if (!text) {
      continue;
    }
    const normalized = text === "*" || text === "folder" || text === "folders"
      ? text
      : `.${text.replace(/^\.+/, "")}`;
    if (/^(\*|folders?|[.][a-z0-9_-]{1,24})$/.test(normalized) && !extensions.includes(normalized)) {
      extensions.push(normalized);
    }
  }
  return extensions.slice(0, 40);
}

function sanitizeSelectPresetOptions(options) {
  const source = options && typeof options === "object" ? options : {};
  const allowedModes = new Set(["replace", "add", "remove", "keep"]);
  const allowedScopes = new Set(["all", "files", "folders"]);
  const allowedSizeOps = new Set(["any", "greater", "less", "equal"]);
  const allowedDateOps = new Set(["any", "newer", "older"]);
  const allowedAttributes = new Set([
    "any",
    "readonly",
    "hidden",
    "system",
    "archive",
    "compressed",
    "encrypted",
    "none"
  ]);
  const sizeOp = allowedSizeOps.has(source.sizeOp) ? source.sizeOp : "any";
  const dateOp = allowedDateOps.has(source.dateOp) ? source.dateOp : "any";
  const dateDays = Number(source.dateDays);
  return {
    pattern: String(source.pattern || "").trim().slice(0, 200),
    mode: allowedModes.has(source.mode) ? source.mode : "replace",
    scope: allowedScopes.has(source.scope) ? source.scope : "all",
    caseSensitive: Boolean(source.caseSensitive),
    sizeOp,
    sizeValue: sizeOp === "any" ? "" : String(source.sizeValue || "").trim().slice(0, 40),
    dateField: source.dateField === "created" ? "created" : "modified",
    dateOp,
    dateDays: dateOp === "any" || !Number.isFinite(dateDays) ? "" : String(Math.max(0, Math.floor(dateDays))),
    attribute: allowedAttributes.has(source.attribute) ? source.attribute : "any"
  };
}

function sanitizeSelectPreset(selectPreset) {
  const source = selectPreset && typeof selectPreset === "object" ? selectPreset : {};
  const now = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? new Date(source.createdAt).toISOString()
    : now;
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : now;
  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || "Select Preset").trim().slice(0, 80),
    description: String(source.description || "").trim().slice(0, 240),
    createdAt,
    updatedAt,
    options: sanitizeSelectPresetOptions(source.options || source)
  };
}

function sanitizeBulkRenamePresetOptions(options) {
  const source = options && typeof options === "object" ? options : {};
  const allowedCaseModes = new Set(["keep", "none", "lower", "upper", "title"]);
  const allowedNumberPositions = new Set(["none", "prefix", "suffix"]);
  const caseMode = allowedCaseModes.has(source.caseMode) ? source.caseMode : "keep";
  const numberPosition = allowedNumberPositions.has(source.numberPosition) ? source.numberPosition : "none";
  return {
    find: String(source.find || "").slice(0, 500),
    replace: String(source.replace || "").slice(0, 500),
    prefix: String(source.prefix || "").slice(0, 200),
    suffix: String(source.suffix || "").slice(0, 200),
    caseMode: caseMode === "none" ? "keep" : caseMode,
    numberPosition,
    numberStart: Number.isFinite(Number(source.numberStart)) ? Number(source.numberStart) : 1,
    numberPad: Math.max(1, Math.min(Number(source.numberPad || 2), 12)),
    numberSeparator: String(source.numberSeparator ?? "-").slice(0, 20),
    preserveExtension: source.preserveExtension !== false,
    useRegex: source.useRegex === true,
    matchCase: source.matchCase === true
  };
}

function sanitizeBulkRenamePreset(bulkRenamePreset) {
  const source = bulkRenamePreset && typeof bulkRenamePreset === "object" ? bulkRenamePreset : {};
  const now = new Date().toISOString();
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? new Date(source.createdAt).toISOString()
    : now;
  const updatedAt = Number.isFinite(Date.parse(source.updatedAt))
    ? new Date(source.updatedAt).toISOString()
    : now;
  return {
    id: String(source.id || crypto.randomUUID()),
    name: String(source.name || "Rename Preset").trim().slice(0, 80),
    description: String(source.description || "").trim().slice(0, 240),
    createdAt,
    updatedAt,
    options: sanitizeBulkRenamePresetOptions(source.options || source)
  };
}

function sanitizeCommand(command) {
  const allowedKinds = new Set(["powershell", "cmd"]);
  return {
    id: String(command.id || crypto.randomUUID()),
    name: String(command.name || "Untitled Command").trim().slice(0, 80),
    description: String(command.description || "").slice(0, 240),
    kind: allowedKinds.has(command.kind) ? command.kind : "powershell",
    command: String(command.command || "").slice(0, 8000),
    showInToolbar: Boolean(command.showInToolbar)
  };
}

function sanitizeScriptSnippet(snippet) {
  return {
    id: String(snippet.id || crypto.randomUUID()),
    name: String(snippet.name || "Untitled Script").trim().slice(0, 80),
    description: String(snippet.description || "").trim().slice(0, 240),
    code: String(snippet.code || "").slice(0, 12000),
    showInToolbar: Boolean(snippet.showInToolbar),
    updatedAt: snippet.updatedAt ? String(snippet.updatedAt).slice(0, 40) : new Date().toISOString()
  };
}

function labelFromPath(itemPath) {
  const resolved = resolveUserPath(itemPath);
  const withoutSlash = resolved.replace(/[\\/]+$/, "");
  return path.basename(withoutSlash) || resolved;
}

function itemCountText(count, noun = "item") {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function conflictModeText(value) {
  if (value === "overwrite") return "Replace existing items";
  if (value === "skip") return "Skip existing items";
  return "Rename if needed";
}

function operationLabel(type, body) {
  const paths = Array.isArray(body.paths) ? body.paths : body.path ? [body.path] : [];
  const count = paths.length || 1;
  if (type === "copy") return `Copy ${itemCountText(count)}`;
  if (type === "move") return `Move ${itemCountText(count)}`;
  if (type === "delete") return `Permanently delete ${itemCountText(count)}`;
  if (type === "recycle") return `Move ${itemCountText(count)} to Windows Recycle Bin`;
  if (type === "windows-recycle-restore") return `Restore ${itemCountText(count, "Windows Recycle Bin item")}`;
  if (type === "transfer") {
    const mode = body.mode === "move" ? "Move" : "Copy";
    return `${mode} ${itemCountText(count)} - ${conflictModeText(body.conflictMode)}`;
  }
  if (type === "trash") return `Move ${itemCountText(count)} to App Trash`;
  if (type === "trash-restore") return `Restore ${itemCountText(count, "App Trash item")}`;
  if (type === "trash-delete") return `Permanently delete ${itemCountText(count, "App Trash item")}`;
  if (type === "rename") return `Rename ${labelFromPath(body.path)}`;
  if (type === "bulk-rename") return `Bulk rename ${itemCountText(count)}`;
  if (type === "mkdir") return `Create ${body.name}`;
  if (type === "create-file") return `Create file ${body.name}`;
  if (type === "undo") return "Undo operation";
  if (type === "backup-recovery") {
    return `${body.action === "discard" ? "Keep replacement for" : "Restore original for"} ${itemCountText(
      Array.isArray(body.indexes) ? body.indexes.length : 0,
      "backup item"
    )}`;
  }
  if (type === "command") return `Run ${body.name || body.commandId || "command"}`;
  if (type === "script") return `Run script ${body.name || body.scriptId || "snippet"}`;
  if (type === "edit-text") return `Edit ${labelFromPath(body.path || "text file")}`;
  if (type === "sync") return `Sync ${body.direction || "panes"}`;
  if (type === "archive-create") return `Create ${body.name || "ZIP archive"}`;
  if (type === "archive-extract") return `Extract ${labelFromPath(body.archive || body.path || "ZIP")}`;
  if (type === "shortcut-create") return `Create shortcut${count === 1 ? "" : "s"} for ${itemCountText(count)}`;
  if (type === "link-create") return `Create link${count === 1 ? "" : "s"} for ${itemCountText(count)}`;
  if (type === "attributes-set") return `Set attributes for ${itemCountText(count)}`;
  if (type === "timestamps-set") return `Set timestamps for ${itemCountText(count)}`;
  return type;
}

function retryString(value, maxLength = 1200) {
  return String(value || "").trim().slice(0, maxLength);
}

function retryStringArray(value, maxItems = 500, maxLength = 1200) {
  return (Array.isArray(value) ? value : [])
    .map((item) => retryString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function retryItemPolicies(value) {
  const source = value && typeof value === "object" ? value : {};
  const policies = {};
  for (const [itemPath, policy] of Object.entries(source).slice(0, 500)) {
    if (conflictModes.has(policy)) {
      const cleanPath = retryString(itemPath);
      if (cleanPath) {
        policies[cleanPath] = policy;
      }
    }
  }
  return policies;
}

function retryBulkOptions(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    find: retryString(source.find, 500),
    replace: retryString(source.replace, 500),
    useRegex: source.useRegex === true,
    matchCase: source.matchCase === true,
    prefix: retryString(source.prefix, 200),
    suffix: retryString(source.suffix, 200),
    caseMode: ["lower", "upper", "title"].includes(source.caseMode) ? source.caseMode : "none",
    preserveExtension: source.preserveExtension !== false,
    numberPosition: ["prefix", "suffix"].includes(source.numberPosition) ? source.numberPosition : "none",
    numberStart: Number.isFinite(Number(source.numberStart)) ? Number(source.numberStart) : 1,
    numberPad: Number.isFinite(Number(source.numberPad)) ? Number(source.numberPad) : 2,
    numberSeparator: retryString(source.numberSeparator ?? "-", 20)
  };
}

function retryBodyForOperation(type, body = {}) {
  if (!retryableOperationTypes.has(type)) {
    return null;
  }
  const source = body && typeof body === "object" ? body : {};
  const paths = retryStringArray(source.paths);

  if (type === "copy" || type === "move") {
    const targetDir = retryString(source.targetDir);
    return paths.length && targetDir ? { paths, targetDir } : null;
  }
  if (type === "move-resume") {
    const pendingSource = retryString(source.source);
    const committedDest = retryString(source.dest);
    const targetDir = retryString(source.targetDir);
    return pendingSource && committedDest && targetDir
      ? { source: pendingSource, dest: committedDest, targetDir, paths }
      : null;
  }
  if (type === "delete" || type === "recycle" || type === "trash" || type === "trash-delete") {
    return paths.length ? { paths } : null;
  }
  if (type === "trash-restore") {
    const targetDir = retryString(source.targetDir);
    return paths.length && targetDir ? { paths, targetDir } : null;
  }
  if (type === "transfer") {
    const targetDir = retryString(source.targetDir);
    return paths.length && targetDir
      ? {
          paths,
          targetDir,
          mode: source.mode === "move" ? "move" : "copy",
          conflictMode: normalizeConflictMode(source.conflictMode),
          itemPolicies: retryItemPolicies(source.itemPolicies)
        }
      : null;
  }
  if (type === "sync") {
    const leftPath = retryString(source.leftPath);
    const rightPath = retryString(source.rightPath);
    const items = retryStringArray(source.items, 1000);
    return leftPath && rightPath && items.length
      ? {
          leftPath,
          rightPath,
          direction: source.direction === "rightToLeft" ? "rightToLeft" : "leftToRight",
          overwrite: source.overwrite === true,
          items
        }
      : null;
  }
  if (type === "archive-create") {
    const targetDir = retryString(source.targetDir);
    return paths.length
      ? {
          paths,
          targetDir,
          name: retryString(source.name, 240),
          overwrite: source.overwrite === true
        }
      : null;
  }
  if (type === "archive-extract") {
    const archive = retryString(source.archive || source.path || paths[0]);
    return archive
      ? {
          archive,
          path: archive,
          paths: [archive],
          targetDir: retryString(source.targetDir),
          folderName: retryString(source.folderName, 240)
        }
      : null;
  }
  if (type === "shortcut-create") {
    const targetDir = retryString(source.targetDir || source.path);
    return paths.length && targetDir
      ? {
          paths,
          targetDir,
          conflictMode: source.conflictMode === "fail" ? "fail" : "unique"
        }
      : null;
  }
  if (type === "link-create") {
    const targetDir = retryString(source.targetDir || source.path);
    return paths.length && targetDir
      ? {
          paths,
          targetDir,
          linkKind: normalizeLinkKind(source.linkKind),
          conflictMode: source.conflictMode === "fail" ? "fail" : "unique"
        }
      : null;
  }
  if (type === "attributes-set") {
    const attributes = normalizeAttributeModes(source.attributes);
    return paths.length && hasAttributeChanges(attributes) ? { paths, attributes } : null;
  }
  if (type === "timestamps-set") {
    const timestamps = normalizeTimestampUpdates(source.timestamps);
    return paths.length && hasTimestampChanges(timestamps) ? { paths, timestamps } : null;
  }
  if (type === "mkdir" || type === "rename") {
    const itemPath = retryString(source.path);
    const name = retryString(source.name, 240);
    return itemPath && name ? { path: itemPath, name } : null;
  }
  if (type === "create-file") {
    const itemPath = retryString(source.path);
    const name = retryString(source.name, 240);
    const content = String(source.content ?? "").slice(0, 500_000);
    return itemPath && name
      ? {
          path: itemPath,
          name,
          content,
          conflictMode: source.conflictMode === "fail" ? "fail" : "unique"
        }
      : null;
  }
  if (type === "bulk-rename") {
    return paths.length
      ? {
          paths,
          options: retryBulkOptions(source.options)
        }
      : null;
  }
  return null;
}

function sanitizeOperationRetry(retry) {
  const type = String(retry?.type || "");
  const body = retryBodyForOperation(type, retry?.body);
  if (!body) {
    return null;
  }
  return {
    type,
    body,
    createdAt: retry.createdAt || new Date().toISOString(),
    lastRetriedAt: retry.lastRetriedAt || null,
    lastRetryOperationId: retry.lastRetryOperationId || null
  };
}

function retryRequestForOperation(type, body) {
  const retryBody = retryBodyForOperation(type, body);
  return retryBody ? { type, body: retryBody } : null;
}

function boundedJsonValue(value, maxLength = 4000) {
  if (value === undefined) {
    return undefined;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxLength) {
    return value;
  }
  return `${text.slice(0, maxLength)}\n... truncated`;
}

function boundedLogLines(logs, maxLines = 50, maxLineLength = 1000) {
  return (Array.isArray(logs) ? logs : []).slice(0, maxLines).map((line) => {
    const text = String(line);
    return text.length > maxLineLength ? `${text.slice(0, maxLineLength)}... truncated` : text;
  });
}

async function saveOperation(operation) {
  await mutateState((state) => {
    const operations = Array.isArray(state.operations) ? state.operations : [];
    const index = operations.findIndex((item) => item.id === operation.id);
    if (index === -1) {
      operations.unshift(operation);
    } else {
      operations[index] = operation;
    }
    state.operations = retainOperationHistory(operations);
  });
  const revision = ++mcpResourceRevision;
  mcpResourceUpdatePublisher?.(`explore-better://operations/${encodeURIComponent(operation.id)}`, revision);
  mcpResourceUpdatePublisher?.("explore-better://health/current", revision);
  for (const waiter of [...operationChangeWaiters]) {
    if (waiter.operationId !== operation.id) continue;
    if (waiter.status && waiter.status !== operation.status) continue;
    waiter.finish(operation);
  }
}

async function waitForOperationCondition(operationId, status = "", timeoutMs = 10_000, signal = null) {
  const current = (await readState()).operations.find((operation) => operation.id === operationId) || null;
  if (current && (!status || current.status === status)) return current;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = null;
    const waiter = {
      operationId,
      status,
      finish(operation, error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener?.("abort", onAbort);
        operationChangeWaiters.delete(waiter);
        if (error) reject(error);
        else resolve(operation || null);
      }
    };
    const onAbort = () => {
      const error = new Error("The AI Bridge wait was canceled.");
      error.code = "REQUEST_CANCELED";
      error.retryable = true;
      waiter.finish(null, error);
    };
    timeout = setTimeout(() => waiter.finish(null), Math.max(100, Math.min(30_000, Number(timeoutMs || 10_000))));
    timeout.unref?.();
    operationChangeWaiters.add(waiter);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function operationCanceledError() {
  const error = new Error("Operation canceled.");
  error.name = "OperationCanceledError";
  error.code = "ERR_OPERATION_CANCELED";
  return error;
}

function isOperationCanceled(error) {
  return (
    error?.name === "AbortError" ||
    error?.name === "OperationCanceledError" ||
    error?.code === "ABORT_ERR" ||
    error?.code === "ERR_OPERATION_CANCELED"
  );
}

function throwIfOperationCanceled(signal) {
  if (signal?.aborted) {
    throw signal.reason || operationCanceledError();
  }
}

function markCanceledOperation(operation, finishedAt = new Date().toISOString()) {
  operation.status = "canceled";
  operation.finishedAt = finishedAt;
  operation.error = "Operation canceled.";
  operation.undo = null;
  operation.cancelRequestedAt = operation.cancelRequestedAt || finishedAt;
  if (operation.progress) {
    operation.progress.phase = "Canceled";
    operation.progress.updatedAt = finishedAt;
  }
}

function recoveryCompletedCount(details) {
  const count = Number(details?.recovery?.completedCount);
  return Number.isFinite(count) ? count : -1;
}

function bestCanceledOperationResult(currentResult, errorDetails) {
  if (!currentResult) {
    return errorDetails || null;
  }
  if (!errorDetails) {
    return currentResult;
  }
  return recoveryCompletedCount(currentResult) > recoveryCompletedCount(errorDetails) ? currentResult : errorDetails;
}

async function enqueueOperation(type, label, runner, options = {}) {
  const controller = new AbortController();
  const operation = {
    id: crypto.randomUUID(),
    type,
    label,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    undo: null,
    progress: null,
    cancelRequestedAt: null,
    retry: sanitizeOperationRetry(options.retry),
    retryOf: options.retryOf ? String(options.retryOf).slice(0, 120) : null,
    relatedOperationId: options.relatedOperationId ? String(options.relatedOperationId).slice(0, 120) : options.retryOf ? String(options.retryOf).slice(0, 120) : null,
    mcpProfileId: options.mcpProfileId ? String(options.mcpProfileId).slice(0, 120) : null,
    mcpSessionId: options.mcpSessionId ? String(options.mcpSessionId).slice(0, 120) : null,
    events: []
  };

  appendOperationEvent(operation, {
    kind: options.retryOf ? "retry-queued" : type === "undo" ? "undo-queued" : "queued",
    message: options.retryOf ? "Retry queued." : type === "undo" ? "Undo queued." : "Operation queued.",
    relatedOperationId: options.relatedOperationId || options.retryOf || null,
    correlationId: options.correlationId || null
  });

  await saveOperation(operation);
  const control = {
    controller,
    operation,
    paused: false,
    pauseStartedAt: null,
    waiters: [],
    lastProgressEventAt: 0,
    lastProgressPercent: -1,
    lastProgressPhase: ""
  };
  operationControls.set(operation.id, control);

  const waitIfPaused = async () => {
    throwIfOperationCanceled(controller.signal);
    while (control.paused) {
      await new Promise((resolve) => {
        control.waiters.push(resolve);
      });
      throwIfOperationCanceled(controller.signal);
    }
  };

  const run = async () => {
    if (controller.signal.aborted || operation.status === "canceled") {
      markCanceledOperation(operation);
      appendOperationEvent(operation, { kind: "canceled", phase: "Canceled", message: "Operation canceled before it started." });
      await saveOperation(operation);
      operationControls.delete(operation.id);
      return operation;
    }
    operation.status = "running";
    operation.startedAt = new Date().toISOString();
    appendOperationEvent(operation, {
      kind: "started",
      message: options.retryOf ? "Retry started." : type === "undo" ? "Undo started." : "Operation started.",
      relatedOperationId: options.relatedOperationId || options.retryOf || null,
      correlationId: options.correlationId || null
    });
    await saveOperation(operation);
    const updateProgress = async (progress) => {
      operation.progress = {
        ...(operation.progress || {}),
        ...(progress || {}),
        updatedAt: new Date().toISOString()
      };
      const now = Date.now();
      const total = Math.max(0, Number(operation.progress.total || 0));
      const completed = Math.max(0, Number(operation.progress.completed || 0));
      const percent = total > 0 ? Math.floor((completed / total) * 20) * 5 : -1;
      const phase = String(operation.progress.phase || "");
      if (phase !== control.lastProgressPhase || now - control.lastProgressEventAt >= 1000 || percent >= control.lastProgressPercent + 5) {
        appendOperationEvent(operation, {
          kind: phase !== control.lastProgressPhase ? "phase" : "progress",
          phase,
          message: phase || "Operation progress updated.",
          completed,
          total
        });
        control.lastProgressEventAt = now;
        control.lastProgressPercent = Math.max(control.lastProgressPercent, percent);
        control.lastProgressPhase = phase;
      }
      await saveOperation(operation);
    };
    const updateRecovery = async (details) => {
      if (!details || typeof details !== "object") {
        return;
      }
      if (Object.prototype.hasOwnProperty.call(details, "undo")) {
        operation.undo = details.undo || null;
        const { undo, ...resultDetails } = details;
        operation.result = resultDetails;
      } else {
        operation.result = details;
      }
      await saveOperation(operation);
    };
    try {
      const result = await runner({
        updateProgress,
        updateRecovery,
        signal: controller.signal,
        throwIfCanceled: () => throwIfOperationCanceled(controller.signal),
        waitIfPaused
      });
      operation.status = "completed";
      operation.finishedAt = new Date().toISOString();
      operation.result = result.result ?? result;
      operation.undo = result.undo ?? null;
      if (operation.progress) {
        operation.progress.phase = "Completed";
        if (Number.isFinite(operation.progress.total)) {
          operation.progress.completed = operation.progress.total;
        }
        operation.progress.updatedAt = operation.finishedAt;
      }
      appendOperationEvent(operation, {
        kind: type === "undo" ? "undo-completed" : options.retryOf ? "retry-completed" : "completed",
        phase: "Completed",
        message: type === "undo" ? "Undo completed." : options.retryOf ? "Retry completed." : "Operation completed.",
        relatedOperationId: options.relatedOperationId || options.retryOf || null
      });
      await saveOperation(operation);
      return operation;
    } catch (error) {
      operation.finishedAt = new Date().toISOString();
      if (controller.signal.aborted || isOperationCanceled(error)) {
        markCanceledOperation(operation, operation.finishedAt);
        operation.result = bestCanceledOperationResult(operation.result, error.details);
        appendOperationEvent(operation, { kind: "canceled", phase: "Canceled", message: "Operation canceled." });
        await saveOperation(operation);
        return operation;
      }
      operation.status = "failed";
      operation.error = error.message || "Operation failed.";
      operation.result = error.details || operation.result || null;
      if (operation.progress) {
        operation.progress.phase = "Failed";
        operation.progress.updatedAt = operation.finishedAt;
      }
      appendOperationEvent(operation, { kind: "failed", phase: "Failed", message: operation.error });
      await saveOperation(operation);
      throw error;
    } finally {
      operationControls.delete(operation.id);
    }
  };

  operationChain = operationChain.then(run, run);
  if (options.returnQueued === true) {
    operationChain.catch(() => {});
    return operation;
  }
  return operationChain;
}

async function writeTextTransaction(body, hooks = {}) {
  const target = resolveUserPath(body.path);
  const parent = path.dirname(target);
  const parentStats = await fs.stat(parent);
  if (!parentStats.isDirectory()) {
    throw new Error("Text write target parent must be a folder.");
  }
  const current = await fs.stat(target).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  if (current?.isDirectory()) {
    throw new Error("Text cannot be written over a folder.");
  }
  if (
    current &&
    Number.isFinite(Number(body.expectedModified)) &&
    Math.abs(current.mtimeMs - Number(body.expectedModified)) > 1 &&
    body.force !== true
  ) {
    const error = new Error("The text file changed after preview. Refresh the operation plan.");
    error.code = "PLAN_CHANGED";
    throw error;
  }

  const content = String(body.content ?? "").slice(0, 1_000_000);
  const transactionId = crypto.randomUUID();
  const staging = path.join(parent, `.explore-better-staging-${transactionId}-${path.basename(target)}`);
  const backup = current
    ? path.join(parent, `.explore-better-backup-${transactionId}-${path.basename(target)}`)
    : null;
  await hooks.updateProgress?.({ unit: "bytes", total: Buffer.byteLength(content), completed: 0, phase: "Staging", currentPath: target });

  let originalMoved = false;
  try {
    const handle = await fs.open(staging, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    hooks.throwIfCanceled?.();
    if (backup) {
      await fs.rename(target, backup);
      originalMoved = true;
      await hooks.updateRecovery?.({
        transaction: { phase: "backup-created", stagingPath: staging, destinationPath: target, backupPath: backup },
        undo: { type: "text-write-restore", path: target, backup }
      });
    }
    await fs.rename(staging, target);
    const stats = await fs.stat(target);
    await hooks.updateProgress?.({ unit: "bytes", total: stats.size, completed: stats.size, phase: "Committed", currentPath: target });
    return {
      result: {
        path: target,
        bytes: stats.size,
        modified: stats.mtimeMs,
        transaction: { phase: "complete", stagingPath: null, destinationPath: target, backupPath: backup }
      },
      undo: backup
        ? { type: "text-write-restore", path: target, backup }
        : { type: "trash-created", items: [{ path: target }] }
    };
  } catch (error) {
    await fs.rm(staging, { force: true }).catch(() => {});
    if (originalMoved && backup && (await pathExists(backup))) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      await fs.rename(backup, target).catch(() => {});
    }
    throw error;
  }
}

async function enqueueRetryableOperation(type, body, runner, options = {}) {
  return enqueueOperation(type, operationLabel(type, body), async (hooks) => {
    try {
      const output = await runner(hooks);
      const cacheInvalidation = invalidateDirectoryListingCachesForOperation(type, body, output);
      const backgroundIndexInvalidation = await safelyInvalidateBackgroundIndexesForOperation(type, body, output);
      if (output && typeof output === "object" && output.result && typeof output.result === "object") {
        output.result.cacheInvalidation = cacheInvalidation;
        output.result.backgroundIndexInvalidation = backgroundIndexInvalidation;
      }
      return output;
    } catch (error) {
      invalidateDirectoryListingCachesForOperation(type, body, null, error);
      await safelyInvalidateBackgroundIndexesForOperation(type, body, null, error);
      throw error;
    }
  }, {
    ...options,
    retry: retryRequestForOperation(type, body)
  });
}

async function runRetryableOperation(type, body, options = {}) {
  if (type === "copy") {
    const sources = Array.isArray(body.paths) ? body.paths : [];
    return enqueueRetryableOperation(type, body, (hooks) => copyPaths(sources, body.targetDir, hooks), options);
  }
  if (type === "move") {
    const sources = Array.isArray(body.paths) ? body.paths : [];
    return enqueueRetryableOperation(type, body, (hooks) => movePaths(sources, body.targetDir, hooks), options);
  }
  if (type === "move-resume") {
    const pendingSource = resolveUserPath(body.source);
    const committedDest = resolveUserPath(body.dest);
    const remainingPaths = Array.isArray(body.paths) ? body.paths : [];
    return enqueueRetryableOperation(type, body, async (hooks) => {
      if (!(await pathExists(committedDest))) {
        throw new Error("The committed move destination is missing; source removal was not attempted.");
      }
      await hooks.updateProgress?.({
        unit: "items",
        total: remainingPaths.length + 1,
        completed: 0,
        phase: "Removing committed source",
        currentPath: pendingSource
      });
      if (await pathExists(pendingSource)) {
        await removeCommittedMoveSource(pendingSource, committedDest);
      }
      if (!remainingPaths.length) {
        return {
          result: { sourceRemoved: pendingSource, destinationCommitted: committedDest, moved: [committedDest] },
          undo: { type: "move-back", items: [{ from: committedDest, to: pendingSource }] }
        };
      }
      return movePaths(remainingPaths, body.targetDir, hooks);
    }, options);
  }
  if (type === "delete") {
    const sources = Array.isArray(body.paths) ? body.paths : [];
    return enqueueRetryableOperation(type, body, (hooks) => deletePaths(sources, hooks), options);
  }
  if (type === "recycle") {
    const sources = Array.isArray(body.paths) ? body.paths : [];
    return enqueueRetryableOperation(type, body, (hooks) => recyclePaths(sources, hooks), options);
  }
  if (type === "trash") {
    const sources = Array.isArray(body.paths) ? body.paths : [];
    return enqueueRetryableOperation(type, body, (hooks) => trashPaths(sources, hooks), options);
  }
  if (type === "trash-restore") {
    return enqueueRetryableOperation(type, body, () => restoreAppTrashItems(body), options);
  }
  if (type === "trash-delete") {
    return enqueueRetryableOperation(type, body, () => deleteAppTrashItems(body), options);
  }
  if (type === "transfer") {
    return enqueueRetryableOperation(type, body, (hooks) => applyTransfer(body, hooks), options);
  }
  if (type === "sync") {
    return enqueueRetryableOperation(type, body, (hooks) => syncCompareItems(body, hooks), options);
  }
  if (type === "archive-create") {
    return enqueueRetryableOperation(type, body, () => createZipArchive(body), options);
  }
  if (type === "archive-extract") {
    return enqueueRetryableOperation(type, body, () => extractZipArchive(body), options);
  }
  if (type === "shortcut-create") {
    return enqueueRetryableOperation(type, body, () => createWindowsShortcuts(body), options);
  }
  if (type === "link-create") {
    return enqueueRetryableOperation(type, body, () => createFilesystemLinks(body), options);
  }
  if (type === "attributes-set") {
    return enqueueRetryableOperation(type, body, () => applyWindowsAttributes(body), options);
  }
  if (type === "timestamps-set") {
    return enqueueRetryableOperation(type, body, () => applyWindowsTimestamps(body), options);
  }
  if (type === "mkdir") {
    const dir = path.join(resolveUserPath(body.path), cleanEntryName(body.name));
    return enqueueRetryableOperation(type, body, async (hooks) => {
      await hooks.updateProgress?.({ unit: "items", total: 1, completed: 0, phase: "Creating folder", currentPath: dir });
      await fs.mkdir(dir);
      await hooks.updateProgress?.({ unit: "items", total: 1, completed: 1, phase: "Completed", currentPath: dir });
      return {
        result: { path: dir },
        undo: { type: "trash-created", items: [{ path: dir }] }
      };
    }, options);
  }
  if (type === "create-file") {
    const dir = resolveUserPath(body.path);
    const name = cleanEntryName(body.name || "New File.txt");
    const requested = path.join(dir, name);
    const content = String(body.content ?? "").slice(0, 500_000);
    const conflictMode = body.conflictMode === "fail" ? "fail" : "unique";
    return enqueueRetryableOperation(type, { ...body, name, conflictMode }, async (hooks) => {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) {
        throw new Error("Target must be a folder.");
      }
      const target = conflictMode === "unique" ? await uniquePath(dir, name) : requested;
      await hooks.updateProgress?.({ unit: "items", total: 1, completed: 0, phase: "Creating file", currentPath: target });
      await fs.writeFile(target, content, { encoding: "utf8", flag: "wx" });
      const fileStats = await fs.stat(target);
      await hooks.updateProgress?.({ unit: "items", total: 1, completed: 1, phase: "Completed", currentPath: target });
      return {
        result: { path: target, bytes: fileStats.size, modified: fileStats.mtimeMs },
        undo: { type: "trash-created", items: [{ path: target }] }
      };
    }, options);
  }
  if (type === "text-write") {
    return enqueueRetryableOperation(type, body, (hooks) => writeTextTransaction(body, hooks), options);
  }
  if (type === "rename") {
    const src = resolveUserPath(body.path);
    const dest = path.join(path.dirname(src), cleanEntryName(body.name));
    return enqueueRetryableOperation(type, body, async (hooks) => {
      await hooks.updateProgress?.({ unit: "items", total: 1, completed: 0, phase: "Renaming", currentPath: src });
      await fs.rename(src, dest);
      await hooks.updateProgress?.({ unit: "items", total: 1, completed: 1, phase: "Updating labels", currentPath: dest });
      await checkpointRecovery(hooks, {
        path: dest,
        source: src,
        renamed: [dest],
        undo: { type: "rename-back", from: dest, to: src },
        error: interruptedCheckpointError().message,
        recovery: {
          type: "rename",
          targetDir: path.dirname(src),
          completedCount: 1,
          remainingCount: 0,
          completed: [
            recoveryListItem(src, 0, {
              dest
            })
          ],
          failed: null,
          remaining: [],
          retry: null,
          canRetryRemaining: false
        }
      });
      await testOperationDelayAfterCheckpoint(hooks, "rename", 1);
      await updateLabelsForTransfers([{ source: src, dest }], "move");
      await hooks.updateProgress?.({ unit: "items", total: 1, completed: 1, phase: "Completed", currentPath: dest });
      return {
        result: { path: dest, source: src, renamed: [dest] },
        undo: { type: "rename-back", from: dest, to: src }
      };
    }, options);
  }
  if (type === "bulk-rename") {
    return enqueueRetryableOperation(type, body, () => applyBulkRename(body), options);
  }
  throw new Error("This operation cannot be retried.");
}

async function retryRecordedOperation(operationId, options = {}) {
  const id = String(operationId || "");
  if (!id) {
    throw new Error("Operation id is required.");
  }
  const state = await readState();
  const original = state.operations.find((item) => item.id === id);
  if (!original) {
    throw new Error("Operation not found.");
  }
  if (!["failed", "canceled"].includes(original.status)) {
    throw new Error("Only failed or canceled operations can be retried.");
  }
  const retry = sanitizeOperationRetry(original.retry);
  if (!retry) {
    throw new Error("This operation does not have retry metadata.");
  }
  const operation = await runRetryableOperation(retry.type, retry.body, { ...options, retryOf: original.id });
  const retriedAt = new Date().toISOString();
  await mutateState((nextState) => {
    const index = nextState.operations.findIndex((item) => item.id === original.id);
    if (index !== -1) {
      const previousRetry = sanitizeOperationRetry(nextState.operations[index].retry) || retry;
      nextState.operations[index] = {
        ...nextState.operations[index],
        retry: {
          ...previousRetry,
          lastRetriedAt: retriedAt,
          lastRetryOperationId: operation.id
        }
      };
    }
  });
  await recordRelatedOperation(original.id, operation, "retry", "Retry operation linked.");
  return operation;
}

async function retryRemainingRecordedOperation(operationId) {
  const id = String(operationId || "");
  if (!id) {
    throw new Error("Operation id is required.");
  }
  const state = await readState();
  const original = state.operations.find((item) => item.id === id);
  if (!original) {
    throw new Error("Operation not found.");
  }
  if (!["failed", "canceled"].includes(original.status)) {
    throw new Error("Only failed or canceled operations can retry remaining work.");
  }
  if (original.result?.recovery?.lastRetryOperationId) {
    throw new Error("Remaining work has already been retried from this operation.");
  }
  const retry = sanitizeOperationRetry(original.result?.recovery?.retry);
  if (!retry) {
    throw new Error("This operation does not have remaining-work recovery metadata.");
  }
  const operation = await runRetryableOperation(retry.type, retry.body, { retryOf: original.id });
  const retriedAt = new Date().toISOString();
  await mutateState((nextState) => {
    const index = nextState.operations.findIndex((item) => item.id === original.id);
    if (index !== -1) {
      const recovery = nextState.operations[index].result?.recovery || {};
      nextState.operations[index] = {
        ...nextState.operations[index],
        result: {
          ...(nextState.operations[index].result || {}),
          recovery: {
            ...recovery,
            lastRetriedAt: retriedAt,
            lastRetryOperationId: operation.id
          }
        }
      };
    }
  });
  await recordRelatedOperation(original.id, operation, "retry", "Remaining work retry linked.");
  return operation;
}

function selectedRecoveryIndexes(value) {
  const indexes = Array.isArray(value) ? value : [];
  return [
    ...new Set(
      indexes
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item >= 0)
        .slice(0, 500)
    )
  ];
}

function retryBodyForSelectedRecovery(retry, selectedItems) {
  const body = { ...(retry.body || {}) };
  if (retry.type === "sync") {
    return {
      ...body,
      items: selectedItems
        .map((item) => item.relativePath || item.item || item.path)
        .filter(Boolean)
    };
  }
  return {
    ...body,
    paths: selectedItems.map((item) => item.path).filter(Boolean)
  };
}

async function retrySelectedRemainingRecordedOperation(operationId, indexes) {
  const id = String(operationId || "");
  if (!id) {
    throw new Error("Operation id is required.");
  }
  const selectedIndexes = selectedRecoveryIndexes(indexes);
  if (!selectedIndexes.length) {
    throw new Error("Select at least one remaining item to retry.");
  }
  const state = await readState();
  const original = state.operations.find((item) => item.id === id);
  if (!original) {
    throw new Error("Operation not found.");
  }
  if (!["failed", "canceled"].includes(original.status)) {
    throw new Error("Only failed or canceled operations can retry selected remaining work.");
  }
  const recovery = original.result?.recovery;
  if (!recovery || recovery.lastRetryOperationId) {
    throw new Error("Remaining work is not available for selected retry.");
  }
  const retry = sanitizeOperationRetry(recovery.retry);
  if (!retry) {
    throw new Error("This operation does not have remaining-work recovery metadata.");
  }
  const wanted = new Set(selectedIndexes);
  const remaining = Array.isArray(recovery.remaining) ? recovery.remaining : [];
  const selectedItems = remaining.filter((item, offset) =>
    wanted.has(Number.isInteger(Number(item.index)) ? Number(item.index) : offset)
  );
  if (!selectedItems.length) {
    throw new Error("Selected recovery items are no longer available.");
  }
  const selectedRetry = sanitizeOperationRetry({
    type: retry.type,
    body: retryBodyForSelectedRecovery(retry, selectedItems)
  });
  if (!selectedRetry) {
    throw new Error("Selected recovery items cannot be retried for this operation.");
  }
  const operation = await runRetryableOperation(selectedRetry.type, selectedRetry.body, {
    retryOf: original.id
  });
  const retriedAt = new Date().toISOString();
  await mutateState((nextState) => {
    const index = nextState.operations.findIndex((item) => item.id === original.id);
    if (index !== -1) {
      const current = nextState.operations[index];
      const currentRecovery = current.result?.recovery || {};
      const selectedRetries = Array.isArray(currentRecovery.selectedRetries)
        ? currentRecovery.selectedRetries
        : [];
      nextState.operations[index] = {
        ...current,
        result: {
          ...(current.result || {}),
          recovery: {
            ...currentRecovery,
            selectedRetries: [
              {
                operationId: operation.id,
                retriedAt,
                indexes: selectedItems.map((item) => item.index).filter((item) => item !== undefined),
                count: selectedItems.length
              },
              ...selectedRetries
            ].slice(0, 20),
            lastSelectedRetryOperationId: operation.id,
            lastSelectedRetriedAt: retriedAt
          }
        }
      };
    }
  });
  await recordRelatedOperation(original.id, operation, "retry", "Selected retry operation linked.");
  return operation;
}

function recoveryItemStableIndex(item, offset) {
  const index = Number(item?.index);
  return Number.isInteger(index) && index >= 0 ? index : offset;
}

function selectedRecoveryItems(recovery, indexes) {
  const remaining = Array.isArray(recovery?.remaining) ? recovery.remaining : [];
  const selectedIndexes = selectedRecoveryIndexes(indexes);
  if (!selectedIndexes.length) {
    return remaining;
  }
  const wanted = new Set(selectedIndexes);
  return remaining.filter((item, offset) => wanted.has(recoveryItemStableIndex(item, offset)));
}

function elevatedRetrySourceForOperation(operation, indexes = []) {
  if (!operation) {
    throw new Error("Operation not found.");
  }
  if (!["failed", "canceled"].includes(operation.status)) {
    throw new Error("Only failed or canceled operations can be prepared for elevated retry.");
  }

  const selectedIndexes = selectedRecoveryIndexes(indexes);
  const recovery = operation.result?.recovery;
  if (recovery?.retry && !recovery.lastRetryOperationId) {
    const retry = sanitizeOperationRetry(recovery.retry);
    if (!retry) {
      throw new Error("This operation does not have remaining-work recovery metadata.");
    }
    const selectedItems = selectedRecoveryItems(recovery, selectedIndexes);
    if (!selectedItems.length) {
      throw new Error(
        selectedIndexes.length
          ? "Selected recovery items are no longer available."
          : "No remaining recovery items are available."
      );
    }
    const selectedRetry = sanitizeOperationRetry({
      type: retry.type,
      body: retryBodyForSelectedRecovery(retry, selectedItems)
    });
    if (!selectedRetry) {
      throw new Error("Selected recovery items cannot be prepared for elevated retry.");
    }
    return {
      source: "remaining",
      retry: selectedRetry,
      selectedIndexes: selectedItems.map((item, offset) => recoveryItemStableIndex(item, offset)),
      itemCount: selectedItems.length
    };
  }

  if (selectedIndexes.length) {
    throw new Error("Selected elevated retry requires remaining-work recovery metadata.");
  }

  const retry = sanitizeOperationRetry(operation.retry);
  if (!retry) {
    throw new Error("This operation does not have retry metadata.");
  }
  return {
    source: "operation",
    retry,
    selectedIndexes: [],
    itemCount: Array.isArray(retry.body?.paths) ? retry.body.paths.length : 1
  };
}

function elevatedRetryItems(type, body = {}) {
  if (!elevatedRetryOperationTypes.has(type)) {
    throw new Error("Elevated retry currently supports copy, move, and permanent delete recovery.");
  }
  const paths = retryStringArray(body.paths);
  if (!paths.length) {
    throw new Error("No paths are available for elevated retry.");
  }
  const targetDir = type === "copy" || type === "move" ? resolveUserPath(body.targetDir) : null;
  if ((type === "copy" || type === "move") && !targetDir) {
    throw new Error("Copy and move elevated retry require a target folder.");
  }
  return paths.map((itemPath, index) => {
    const resolved = resolveUserPath(itemPath);
    return {
      index,
      path: resolved,
      name: labelFromPath(resolved),
      plannedDest: targetDir ? path.join(targetDir, path.basename(resolved.replace(/[\\/]+$/, ""))) : null
    };
  });
}

function elevatedRetryWarnings(type) {
  const warnings = [];
  if (process.platform !== "win32") {
    warnings.push("Launching an elevated helper requires Windows PowerShell and UAC.");
  }
  if (type === "delete") {
    warnings.push("Permanent delete has no app-level restore path.");
  }
  return warnings;
}

function elevatedHelperScriptContent() {
  return `param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadPath
)
$ErrorActionPreference = "Stop"
$runDir = Split-Path -Parent $PayloadPath
$manifestPath = Join-Path -Path $runDir -ChildPath "manifest.json"
if (Test-Path -LiteralPath $manifestPath) {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $expectedHash = ([string]$manifest.payloadSha256).ToLowerInvariant()
  $actualHash = (Get-FileHash -LiteralPath $PayloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expectedHash -and $actualHash -ne $expectedHash) {
    throw "Payload hash mismatch. The elevated retry payload may have changed after preparation."
  }
}
$payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json

function Get-UniquePath {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if ([string]::IsNullOrWhiteSpace($Name)) {
    throw "Cannot derive a destination filename."
  }
  $candidate = Join-Path -Path $Parent -ChildPath $Name
  $index = 2
  while (Test-Path -LiteralPath $candidate) {
    $extension = [IO.Path]::GetExtension($Name)
    $stem = [IO.Path]::GetFileNameWithoutExtension($Name)
    if ([string]::IsNullOrWhiteSpace($extension)) {
      $nextName = "$Name copy $index"
    } else {
      $nextName = "$stem copy $index$extension"
    }
    $candidate = Join-Path -Path $Parent -ChildPath $nextName
    $index += 1
  }
  return $candidate
}

$results = @()
$errors = @()
$type = [string]$payload.type
$targetDir = [string]$payload.targetDir
foreach ($item in @($payload.items)) {
  $source = [string]$item.path
  try {
    if ($type -eq "delete") {
      Remove-Item -LiteralPath $source -Recurse -Force -ErrorAction Stop
      $results += [pscustomobject]@{ path = $source; action = "delete"; ok = $true }
      continue
    }
    if ($type -ne "copy" -and $type -ne "move") {
      throw "Unsupported elevated operation type: $type"
    }
    if (-not (Test-Path -LiteralPath $targetDir)) {
      New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    }
    $leafSource = $source -replace '[\\\\/]+$',''
    $dest = Get-UniquePath -Parent $targetDir -Name ([IO.Path]::GetFileName($leafSource))
    if ($type -eq "copy") {
      Copy-Item -LiteralPath $source -Destination $dest -Recurse -ErrorAction Stop
    } else {
      Move-Item -LiteralPath $source -Destination $dest -ErrorAction Stop
    }
    $results += [pscustomobject]@{ path = $source; dest = $dest; action = $type; ok = $true }
  } catch {
    $errors += [pscustomobject]@{ path = $source; action = $type; ok = $false; error = $_.Exception.Message }
  }
}

$logDir = [IO.Path]::GetDirectoryName([string]$payload.logPath)
if ($logDir) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}
$output = [pscustomobject]@{
  schema = "explore-better.elevated-retry-result.v1"
  operationId = $payload.operationId
  type = $type
  completedAt = (Get-Date).ToString("o")
  results = $results
  errors = $errors
}
$output | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $payload.logPath -Encoding UTF8
if ($errors.Count -gt 0) {
  exit 2
}
`;
}

function powerShellLiteral(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

async function writeElevatedRetryHelper(payload) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto
    .randomBytes(3)
    .toString("hex")}`;
  const runDir = path.join(elevationRoot, runId);
  const scriptPath = path.join(runDir, "run-elevated.ps1");
  const payloadPath = path.join(runDir, "payload.json");
  const manifestPath = path.join(runDir, "manifest.json");
  const launcherPath = path.join(runDir, "launch-elevated.ps1");
  const logPath = path.join(runDir, "result.json");
  const payloadWithLog = { ...payload, runId, logPath };
  const payloadText = JSON.stringify(payloadWithLog, null, 2);
  const payloadSha256 = crypto.createHash("sha256").update(payloadText).digest("hex");
  const manifest = {
    schema: "explore-better.elevated-retry-manifest.v1",
    runId,
    createdAt: payload.createdAt,
    operationId: payload.operationId,
    type: payload.type,
    itemCount: payload.items.length,
    payloadSha256
  };
  const launcher = `$ErrorActionPreference = "Stop"
$script = ${powerShellLiteral(scriptPath)}
$payload = ${powerShellLiteral(payloadPath)}
Start-Process -FilePath "powershell.exe" -Verb RunAs -WindowStyle Hidden -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script, "-PayloadPath", $payload)
`;

  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(scriptPath, elevatedHelperScriptContent(), "utf8");
  await fs.writeFile(payloadPath, payloadText, "utf8");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(launcherPath, launcher, "utf8");

  return {
    runId,
    runDir,
    scriptPath,
    payloadPath,
    manifestPath,
    launcherPath,
    logPath,
    payloadSha256,
    command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${launcherPath.replaceAll('"', '""')}"`
  };
}

async function launchElevatedRetryHelper(launcherPath) {
  if (process.platform !== "win32") {
    throw new Error("Launching an elevated helper requires Windows.");
  }
  const result = await runProcess("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    launcherPath
  ]);
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || "Elevated helper launch failed.").trim());
  }
  return result;
}

function elevatedRetryStateSummary(plan) {
  return {
    status: plan.launched ? "launched" : plan.prepared ? "prepared" : "planned",
    plannedAt: plan.createdAt,
    launchedAt: plan.launchedAt || null,
    runId: plan.runId || null,
    type: plan.type,
    source: plan.source,
    itemCount: plan.itemCount,
    selectedIndexes: plan.selectedIndexes || [],
    scriptPath: plan.scriptPath || null,
    payloadPath: plan.payloadPath || null,
    manifestPath: plan.manifestPath || null,
    launcherPath: plan.launcherPath || null,
    logPath: plan.logPath || null,
    command: plan.command || null
  };
}

async function rememberElevatedRetryPlan(operationId, plan) {
  const summary = elevatedRetryStateSummary(plan);
  return mutateState((nextState) => {
    const index = nextState.operations.findIndex((item) => item.id === operationId);
    if (index === -1) {
      return null;
    }
    const current = nextState.operations[index];
    const result = current.result && typeof current.result === "object" ? current.result : {};
    const recovery = result.recovery && typeof result.recovery === "object" ? result.recovery : {};
    nextState.operations[index] = {
      ...current,
      result: {
        ...result,
        recovery: {
          ...recovery,
          elevation: summary
        }
      }
    };
    return nextState.operations[index];
  });
}

async function prepareElevatedRetryOperation(operationId, options = {}) {
  const id = String(operationId || "");
  if (!id) {
    throw new Error("Operation id is required.");
  }
  const state = await readState();
  const operation = state.operations.find((item) => item.id === id);
  const source = elevatedRetrySourceForOperation(operation, options.indexes);
  const { retry } = source;
  if (!elevatedRetryOperationTypes.has(retry.type)) {
    throw new Error("Elevated retry currently supports copy, move, and permanent delete recovery.");
  }
  const items = elevatedRetryItems(retry.type, retry.body);
  const targetDir = retry.type === "copy" || retry.type === "move" ? resolveUserPath(retry.body.targetDir) : null;
  const createdAt = new Date().toISOString();
  const plan = {
    supported: true,
    dryRun: options.dryRun === true,
    prepared: false,
    launched: false,
    operationId: id,
    operationLabel: operation.label || operation.type,
    source: source.source,
    type: retry.type,
    label: `Elevated ${operationLabel(retry.type, retry.body)}`,
    createdAt,
    itemCount: items.length,
    selectedIndexes: source.selectedIndexes,
    targetDir,
    items,
    warnings: elevatedRetryWarnings(retry.type)
  };

  if (plan.dryRun || options.prepare === false) {
    return plan;
  }

  const payload = {
    schema: "explore-better.elevated-retry.v1",
    createdAt,
    operationId: id,
    retryOf: operation.retryOf || null,
    source: source.source,
    type: retry.type,
    targetDir,
    items: items.map((item) => ({
      index: item.index,
      path: item.path,
      name: item.name,
      plannedDest: item.plannedDest
    }))
  };
  Object.assign(plan, await writeElevatedRetryHelper(payload), { prepared: true });

  if (options.launch === true) {
    await launchElevatedRetryHelper(plan.launcherPath);
    plan.launched = true;
    plan.launchedAt = new Date().toISOString();
  }

  const updatedOperation = await rememberElevatedRetryPlan(id, plan);
  return {
    ...plan,
    operation: updatedOperation || operation
  };
}

async function cancelOperation(operationId) {
  const id = String(operationId || "");
  if (!id) {
    throw new Error("Operation id is required.");
  }
  const control = operationControls.get(id);
  if (!control) {
    const state = await readState();
    const saved = state.operations.find((item) => item.id === id);
    if (!saved) {
      throw new Error("Operation not found.");
    }
    if (saved.status === "queued" || saved.status === "running") {
      throw new Error("Operation is no longer connected to the active queue.");
    }
    throw new Error("Operation is no longer cancellable.");
  }

  const { controller, operation } = control;
  if (operation.status === "running" && !cancellableOperationTypes.has(operation.type)) {
    throw new Error("This operation type does not support running cancellation yet.");
  }
  const now = new Date().toISOString();
  operation.cancelRequestedAt = operation.cancelRequestedAt || now;
  appendOperationEvent(operation, { at: now, kind: "cancellation-requested", message: "Cancellation requested." });
  if (operation.status === "queued" || !operation.startedAt) {
    markCanceledOperation(operation, now);
    appendOperationEvent(operation, { at: now, kind: "canceled", phase: "Canceled", message: "Queued operation canceled." });
  } else if (operation.progress) {
    operation.progress.phase = "Cancel requested";
    operation.progress.updatedAt = now;
  }
  if (!controller.signal.aborted) {
    controller.abort(operationCanceledError());
  }
  for (const resolve of control.waiters.splice(0)) {
    resolve();
  }
  await saveOperation(operation);
  return operation;
}

async function pauseOperation(operationId) {
  const id = String(operationId || "");
  if (!id) {
    throw new Error("Operation id is required.");
  }
  const control = operationControls.get(id);
  if (!control) {
    throw new Error("Operation is no longer pausable.");
  }
  const { operation } = control;
  if (!cancellableOperationTypes.has(operation.type)) {
    throw new Error("This operation type does not support pause yet.");
  }
  if (operation.status !== "running") {
    throw new Error("Only running operations can be paused.");
  }
  const now = new Date().toISOString();
  control.paused = true;
  control.pauseStartedAt = now;
  operation.status = "paused";
  operation.pausedAt = now;
  operation.resumedAt = null;
  if (operation.progress) {
    operation.progress.phase = "Paused";
    operation.progress.updatedAt = now;
  }
  appendOperationEvent(operation, { at: now, kind: "paused", phase: "Paused", message: "Operation paused." });
  await saveOperation(operation);
  return operation;
}

async function resumeOperation(operationId) {
  const id = String(operationId || "");
  if (!id) {
    throw new Error("Operation id is required.");
  }
  const control = operationControls.get(id);
  if (!control) {
    throw new Error("Operation is no longer resumable.");
  }
  const { operation } = control;
  if (operation.status !== "paused") {
    throw new Error("Only paused operations can be resumed.");
  }
  const now = new Date().toISOString();
  control.paused = false;
  control.pauseStartedAt = null;
  operation.status = "running";
  operation.resumedAt = now;
  if (operation.progress) {
    operation.progress.phase = "Resuming";
    operation.progress.updatedAt = now;
  }
  appendOperationEvent(operation, { at: now, kind: "resumed", phase: "Resuming", message: "Operation resumed." });
  for (const resolve of control.waiters.splice(0)) {
    resolve();
  }
  await saveOperation(operation);
  return operation;
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2_000_000) {
      throw new Error("Request body is too large.");
    }
  }
  if (!body.trim()) {
    return {};
  }
  return JSON.parse(body);
}

function resolveUserPath(value) {
  if (!value || value === "~") {
    return os.homedir();
  }
  const text = String(value);
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return path.resolve(path.join(os.homedir(), text.slice(2)));
  }
  return path.resolve(text);
}

function denamespaceWindowsPath(value) {
  const text = String(value || "");
  if (process.platform !== "win32") {
    return text;
  }
  if (text.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${text.slice(8)}`;
  }
  if (text.startsWith("\\\\?\\")) {
    return text.slice(4);
  }
  return text;
}

function isAccessError(error) {
  return ["EACCES", "EPERM", "EBUSY", "UNKNOWN"].includes(String(error?.code || ""));
}

function normalizeResolvedPath(value) {
  return path.resolve(String(value || ""));
}

function sameResolvedPath(left, right) {
  return process.platform === "win32"
    ? normalizeResolvedPath(left).toLowerCase() === normalizeResolvedPath(right).toLowerCase()
    : normalizeResolvedPath(left) === normalizeResolvedPath(right);
}

async function readableDirectoryPath(itemPath) {
  try {
    const stats = await fs.stat(itemPath);
    if (!stats.isDirectory()) {
      return false;
    }
    await fs.access(itemPath);
    return true;
  } catch {
    return false;
  }
}

async function windowsLegacyFolderRedirectForPath(itemPath) {
  if (process.platform !== "win32") {
    return null;
  }
  const home = normalizeResolvedPath(os.homedir());
  const requested = normalizeResolvedPath(itemPath);
  if (!requested.toLowerCase().startsWith(`${home.toLowerCase()}\\`)) {
    return null;
  }
  const relativeParts = path.relative(home, requested).split(/[\\/]+/).filter(Boolean);
  const legacyMaps = new Map([
    ["my documents", ["Documents"]],
    ["documents\\my music", ["Music"]],
    ["documents\\my pictures", ["Pictures"]],
    ["documents\\my videos", ["Videos"]],
    ["application data", ["AppData", "Roaming"]],
    ["local settings", ["AppData", "Local"]],
    ["start menu", ["AppData", "Roaming", "Microsoft", "Windows", "Start Menu"]],
    ["sendto", ["AppData", "Roaming", "Microsoft", "Windows", "SendTo"]],
    ["templates", ["AppData", "Roaming", "Microsoft", "Windows", "Templates"]],
    ["recent", ["AppData", "Roaming", "Microsoft", "Windows", "Recent"]]
  ]);
  const key = relativeParts.join("\\").toLowerCase();
  const replacement = legacyMaps.get(key);
  if (!replacement) {
    return null;
  }
  const redirected = path.join(home, ...replacement);
  if (sameResolvedPath(redirected, requested) || !(await readableDirectoryPath(redirected))) {
    return null;
  }
  return redirected;
}

function cleanEntryName(name) {
  const text = String(name || "").trim();
  if (!text || text.includes("/") || text.includes("\\") || text.includes(":")) {
    throw new Error("Use a plain name without path separators.");
  }
  return text;
}

function isRoot(dir) {
  return path.dirname(dir) === dir;
}

function entryKind(name, isDirectory) {
  if (isDirectory) {
    return "Folder";
  }
  const ext = path.extname(name).toLowerCase();
  if (!ext) {
    return "File";
  }
  if (imageExtensions.has(ext)) {
    return "Image";
  }
  if (textExtensions.has(ext)) {
    return "Text";
  }
  if ([".zip", ".7z", ".rar", ".tar", ".gz"].includes(ext)) {
    return "Archive";
  }
  if ([".exe", ".msi", ".appx"].includes(ext)) {
    return "Application";
  }
  if (audioExtensions.has(ext)) {
    return "Audio";
  }
  if (videoExtensions.has(ext)) {
    return "Video";
  }
  if ([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"].includes(ext) || previewDocumentExtensions.has(ext)) {
    return "Document";
  }
  return ext.slice(1).toUpperCase();
}

async function readFileHeader(itemPath, maxBytes = 65536) {
  const handle = await fs.open(itemPath, "r");
  try {
    const stats = await handle.stat();
    const size = Math.max(0, Math.min(Number(stats.size || 0), maxBytes));
    if (!size) {
      return Buffer.alloc(0);
    }
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return bytesRead === size ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function dimensionsResult(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  const safeWidth = Math.floor(width);
  const safeHeight = Math.floor(height);
  if (safeWidth <= 0 || safeHeight <= 0 || safeWidth > 1_000_000 || safeHeight > 1_000_000) {
    return null;
  }
  return {
    width: safeWidth,
    height: safeHeight,
    text: `${safeWidth}x${safeHeight}`,
    pixels: safeWidth * safeHeight
  };
}

function parsePngDimensions(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return null;
  }
  return dimensionsResult(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

function parseGifDimensions(buffer) {
  const signature = buffer.subarray(0, 6).toString("ascii");
  if (buffer.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) {
    return null;
  }
  return dimensionsResult(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
}

function parseBmpDimensions(buffer) {
  if (buffer.length < 26 || buffer.subarray(0, 2).toString("ascii") !== "BM") {
    return null;
  }
  return dimensionsResult(buffer.readInt32LE(18), Math.abs(buffer.readInt32LE(22)));
}

function parseIcoDimensions(buffer) {
  if (buffer.length < 22 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    return null;
  }
  const count = Math.min(buffer.readUInt16LE(4), Math.floor((buffer.length - 6) / 16));
  let best = null;
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    const width = buffer[offset] || 256;
    const height = buffer[offset + 1] || 256;
    const dimensions = dimensionsResult(width, height);
    if (dimensions && (!best || dimensions.pixels > best.pixels)) {
      best = dimensions;
    }
  }
  return best;
}

function parseJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 9 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) {
      offset += 1;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda || offset + 2 > buffer.length) {
      break;
    }
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) {
      break;
    }
    if (sofMarkers.has(marker) && length >= 7) {
      return dimensionsResult(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
    }
    offset += length;
  }
  return null;
}

function parseWebpDimensions(buffer) {
  if (buffer.length < 30 || buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WEBP") {
    return null;
  }
  const chunk = buffer.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && buffer.length >= 30) {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return dimensionsResult(width, height);
  }
  if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return dimensionsResult(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return dimensionsResult((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  return null;
}

function parseSvgLength(value) {
  const text = String(value || "").trim();
  if (!text || text.endsWith("%")) {
    return null;
  }
  const match = /^([0-9]*\.?[0-9]+)/.exec(text);
  return match ? Number(match[1]) : null;
}

function parseSvgDimensions(buffer) {
  const text = buffer.subarray(0, Math.min(buffer.length, 65536)).toString("utf8");
  const svgMatch = /<svg\b[^>]*>/i.exec(text);
  if (!svgMatch) {
    return null;
  }
  const tag = svgMatch[0];
  const width = parseSvgLength(/\bwidth\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]);
  const height = parseSvgLength(/\bheight\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]);
  if (width && height) {
    return dimensionsResult(width, height);
  }
  const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length >= 4) {
      return dimensionsResult(parts[2], parts[3]);
    }
  }
  return null;
}

function parseAvifDimensions(buffer) {
  for (let offset = 0; offset + 20 <= buffer.length; offset += 1) {
    if (buffer.subarray(offset + 4, offset + 8).toString("ascii") !== "ispe") {
      continue;
    }
    const boxSize = buffer.readUInt32BE(offset);
    if (boxSize >= 20 && offset + 20 <= buffer.length) {
      return dimensionsResult(buffer.readUInt32BE(offset + 12), buffer.readUInt32BE(offset + 16));
    }
  }
  return null;
}

function metadataCacheIdForPath(targetPath) {
  return crypto.createHash("sha256").update(pathIdentity(targetPath)).digest("hex").slice(0, 32);
}

function folderDimensionsCacheFileForPath(targetPath) {
  return path.join(metadataCacheRoot, "Dimensions", `${metadataCacheIdForPath(targetPath)}.json`);
}

function dimensionsCacheStatStamp(stats) {
  return {
    size: Number(stats?.size || 0),
    modified: Math.round(Number(stats?.mtimeMs || 0))
  };
}

function normalizeCachedDimensions(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return dimensionsResult(Number(value.width), Number(value.height));
}

function sanitizeDimensionsCacheEntry(key, value) {
  if (typeof key !== "string" || !key || key.length > 32768 || !value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const size = Number(value.size);
  const modified = Number(value.modified);
  const extension = String(value.extension || "").toLowerCase();
  if (!Number.isFinite(size) || size < 0 || !Number.isFinite(modified) || modified < 0 || !imageExtensions.has(extension)) {
    return null;
  }
  let dimensions = null;
  if (value.dimensions !== null && value.dimensions !== undefined) {
    const normalized = normalizeCachedDimensions(value.dimensions);
    if (!normalized) {
      return null;
    }
    dimensions = {
      width: normalized.width,
      height: normalized.height
    };
  }
  return {
    size,
    modified,
    extension,
    dimensions,
    cachedAt: sanitizeOperationTimestamp(value.cachedAt, new Date().toISOString())
  };
}

function sanitizeDimensionsCacheEntries(entries) {
  const clean = {};
  const source = entries && typeof entries === "object" && !Array.isArray(entries) ? entries : {};
  const sourceEntries = Object.keys(source).length;
  let invalidEntries = 0;
  let truncatedEntries = 0;
  let keptEntries = 0;
  for (const [key, value] of Object.entries(source)) {
    if (keptEntries >= dimensionsCacheEntryLimit) {
      truncatedEntries += 1;
      continue;
    }
    const sanitized = sanitizeDimensionsCacheEntry(key, value);
    if (!sanitized) {
      invalidEntries += 1;
      continue;
    }
    clean[key] = sanitized;
    keptEntries += 1;
  }
  return {
    entries: clean,
    sourceEntries,
    invalidEntries,
    truncatedEntries,
    repaired: invalidEntries > 0 || truncatedEntries > 0 || sourceEntries !== keptEntries
  };
}

async function readFolderDimensionsCache(dir) {
  const readStart = monotonicMs();
  const resolved = resolveUserPath(dir);
  const file = folderDimensionsCacheFileForPath(resolved);
  const empty = {
    path: resolved,
    pathKey: pathIdentity(resolved),
    file,
    entries: {},
    dirty: false,
    hits: 0,
    misses: 0,
    updates: 0,
    stale: 0,
    pruned: 0,
    sourceEntries: 0,
    invalidEntries: 0,
    truncatedEntries: 0,
    repaired: false,
    readError: null,
    readMs: 0,
    writeMs: 0
  };
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (parsed?.version === 1 && parsed.pathKey === empty.pathKey && parsed.entries && typeof parsed.entries === "object") {
      const sanitized = sanitizeDimensionsCacheEntries(parsed.entries);
      empty.entries = sanitized.entries;
      empty.sourceEntries = sanitized.sourceEntries;
      empty.invalidEntries = sanitized.invalidEntries;
      empty.truncatedEntries = sanitized.truncatedEntries;
      empty.repaired = sanitized.repaired;
      empty.dirty = sanitized.repaired;
    } else {
      empty.dirty = true;
      empty.repaired = true;
      empty.readError = "invalid-cache-schema";
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      empty.dirty = true;
      empty.repaired = true;
      empty.readError = error.message;
    }
  }
  empty.readMs = elapsedMs(readStart);
  return empty;
}

function dimensionsCacheEntryFor(cache, itemPath, stats, extension) {
  if (!cache) {
    return { known: false, dimensions: null };
  }
  const entry = cache.entries[pathIdentity(itemPath)];
  if (!entry) {
    cache.misses += 1;
    return { known: false, dimensions: null };
  }
  const stamp = dimensionsCacheStatStamp(stats);
  if (entry.size !== stamp.size || entry.modified !== stamp.modified || entry.extension !== extension) {
    cache.stale += 1;
    cache.misses += 1;
    return { known: false, dimensions: null };
  }
  cache.hits += 1;
  return {
    known: true,
    dimensions: normalizeCachedDimensions(entry.dimensions)
  };
}

function rememberDimensionsCacheEntry(cache, itemPath, stats, extension, dimensions) {
  if (!cache) {
    return;
  }
  const stamp = dimensionsCacheStatStamp(stats);
  cache.entries[pathIdentity(itemPath)] = {
    size: stamp.size,
    modified: stamp.modified,
    extension,
    dimensions: dimensions ? { width: dimensions.width, height: dimensions.height } : null,
    cachedAt: new Date().toISOString()
  };
  cache.dirty = true;
  cache.updates += 1;
}

async function flushFolderDimensionsCache(cache, entries = []) {
  if (!cache) {
    return null;
  }
  const currentImageKeys = new Set(
    entries
      .filter((entry) => entry?.isFile && imageExtensions.has(String(entry.extension || "").toLowerCase()))
      .map((entry) => pathIdentity(entry.path))
  );
  for (const key of Object.keys(cache.entries)) {
    if (!currentImageKeys.has(key)) {
      delete cache.entries[key];
      cache.pruned += 1;
      cache.dirty = true;
    }
  }
  if (cache.dirty) {
    const writeStart = monotonicMs();
    await fs.mkdir(path.dirname(cache.file), { recursive: true });
    const payload = {
      version: 1,
      path: cache.path,
      pathKey: cache.pathKey,
      updatedAt: new Date().toISOString(),
      entries: cache.entries
    };
    const temp = `${cache.file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(temp, cache.file);
    cache.writeMs = elapsedMs(writeStart);
    cache.dirty = false;
  }
  return {
    root: metadataCacheRoot,
    file: cache.file,
    entries: Object.keys(cache.entries).length,
    hits: cache.hits,
    misses: cache.misses,
    updates: cache.updates,
    stale: cache.stale,
    pruned: cache.pruned,
    sourceEntries: cache.sourceEntries,
    invalidEntries: cache.invalidEntries,
    truncatedEntries: cache.truncatedEntries,
    repaired: cache.repaired,
    readError: cache.readError,
    readMs: cache.readMs,
    writeMs: cache.writeMs
  };
}

async function imageDimensionsForEntry(itemPath, stats, extension, dimensionsCache = null) {
  if (!stats?.isFile?.() || !imageExtensions.has(extension)) {
    return null;
  }
  const cached = dimensionsCacheEntryFor(dimensionsCache, itemPath, stats, extension);
  if (cached.known) {
    return cached.dimensions;
  }
  try {
    const header = await readFileHeader(itemPath);
    const parsersByExtension = new Map([
      [".png", parsePngDimensions],
      [".apng", parsePngDimensions],
      [".jpg", parseJpegDimensions],
      [".jpeg", parseJpegDimensions],
      [".gif", parseGifDimensions],
      [".bmp", parseBmpDimensions],
      [".ico", parseIcoDimensions],
      [".webp", parseWebpDimensions],
      [".svg", parseSvgDimensions],
      [".avif", parseAvifDimensions]
    ]);
    const parsers = [
      parsersByExtension.get(extension),
      parsePngDimensions,
      parseJpegDimensions,
      parseGifDimensions,
      parseBmpDimensions,
      parseIcoDimensions,
      parseWebpDimensions,
      parseSvgDimensions,
      parseAvifDimensions
    ].filter(Boolean);
    for (const parser of [...new Set(parsers)]) {
      const dimensions = parser(header);
      if (dimensions) {
        rememberDimensionsCacheEntry(dimensionsCache, itemPath, stats, extension, dimensions);
        return dimensions;
      }
    }
  } catch {
    return null;
  }
  rememberDimensionsCacheEntry(dimensionsCache, itemPath, stats, extension, null);
  return null;
}

function parseAttribLine(line) {
  const text = String(line || "").trimEnd();
  const pathMatch = /([A-Za-z]:\\.*|\\\\.*)$/.exec(text);
  if (!pathMatch) {
    return null;
  }
  return {
    path: pathMatch[1],
    flags: text.slice(0, pathMatch.index).replace(/[^A-Za-z]/g, "").toUpperCase()
  };
}

async function windowsAttributeMap(dir) {
  if (process.platform !== "win32") {
    return new Map();
  }
  const result = await runProcess("attrib.exe", ["/d", path.join(dir, "*")]);
  if (result.code !== 0 && !result.stdout) {
    return new Map();
  }
  const map = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const record = parseAttribLine(line);
    if (record?.path) {
      map.set(pathIdentity(record.path), record.flags);
    }
  }
  return map;
}

async function nativeWindowsAttributeMap(dir, signal = null) {
  if (
    process.platform !== "win32" ||
    String(dir || "").startsWith("\\\\") ||
    process.env.EXPLORE_BETTER_DISABLE_NATIVE_LISTING === "1" ||
    !nativeFilesystemHelperPath()
  ) {
    return null;
  }
  const result = await nativeFilesystemHelperRequest(
    "browse",
    { path: dir, maxEntries: 100000, compact: true },
    { signal, timeoutMs: 60000 }
  );
  if (result.data?.truncated) {
    return null;
  }
  const payload = result.data?.entries;
  const rowCount = nativeBrowseEntryCount(payload);
  const map = new Map();
  for (let index = 0; index < rowCount; index += 1) {
    const entry = entryFromNativeBrowseRow(dir, Array.isArray(payload) ? payload[index] : payload, index);
    map.set(pathIdentity(entry.path), entry.attributeText || "");
  }
  return map;
}

async function optionalWindowsAttributeMap(dir, includeAttributes, signal = null) {
  if (!includeAttributes) {
    return new Map();
  }
  try {
    const nativeMap = await nativeWindowsAttributeMap(dir, signal);
    if (nativeMap) {
      return nativeMap;
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
  }
  return windowsAttributeMap(dir);
}

function attributesForEntry(name, stats, flags = "") {
  const normalizedFlags = String(flags || "").toUpperCase();
  const isReadOnlyByMode = stats ? (stats.mode & 0o200) === 0 : false;
  const hidden = normalizedFlags.includes("H") || String(name || "").startsWith(".");
  const system = normalizedFlags.includes("S");
  const readonly = normalizedFlags.includes("R") || isReadOnlyByMode;
  const archive = normalizedFlags.includes("A");
  const reparse = normalizedFlags.includes("L");
  const compressed = normalizedFlags.includes("C");
  const encrypted = normalizedFlags.includes("E");
  const indexed = normalizedFlags.includes("I");
  const text = [
    readonly ? "R" : "",
    hidden ? "H" : "",
    system ? "S" : "",
    archive ? "A" : "",
    reparse ? "L" : "",
    compressed ? "C" : "",
    encrypted ? "E" : "",
    indexed ? "I" : ""
  ].join("");
  return {
    readonly,
    hidden,
    system,
    archive,
    reparse,
    compressed,
    encrypted,
    indexed,
    flags: normalizedFlags || text,
    text
  };
}

function displayPathFromLinkTarget(rawTarget, parent) {
  let target = String(rawTarget || "").trim();
  if (!target) {
    return "";
  }
  if (target.startsWith("\\\\?\\UNC\\")) {
    target = `\\\\${target.slice(8)}`;
  } else if (target.startsWith("\\\\?\\")) {
    target = target.slice(4);
  }
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(parent, target);
}

async function linkMetadataForEntry(itemPath, stats, lstat) {
  const linkCount = Number(stats?.nlink || 0);
  if (lstat?.isSymbolicLink?.()) {
    let rawTarget = "";
    try {
      rawTarget = await fs.readlink(itemPath);
    } catch {
      rawTarget = "";
    }
    return {
      isSymlink: true,
      linkType: stats?.isDirectory?.() ? "Folder Link" : stats?.isFile?.() ? "File Link" : "Link",
      linkTarget: displayPathFromLinkTarget(rawTarget, path.dirname(itemPath)),
      linkTargetRaw: rawTarget,
      linkCount: null
    };
  }
  if (stats?.isFile?.() && linkCount > 1) {
    return {
      isSymlink: false,
      linkType: "Hard Link",
      linkTarget: "",
      linkTargetRaw: "",
      linkCount
    };
  }
  return {
    isSymlink: false,
    linkType: "",
    linkTarget: "",
    linkTargetRaw: "",
    linkCount: linkCount > 1 ? linkCount : null
  };
}

function fastLinkMetadataForEntry(lstat) {
  return {
    isSymlink: Boolean(lstat?.isSymbolicLink?.()),
    linkType: "",
    linkTarget: "",
    linkTargetRaw: "",
    linkCount: null
  };
}

const editableAttributeFlags = {
  readonly: "R",
  hidden: "H",
  system: "S",
  archive: "A"
};

const editableTimestampFields = ["modified", "created", "accessed"];

function normalizeAttributeMode(value) {
  return value === "set" || value === "clear" ? value : "keep";
}

function normalizeAttributeModes(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    Object.keys(editableAttributeFlags).map((key) => [key, normalizeAttributeMode(source[key])])
  );
}

function hasAttributeChanges(attributes = {}) {
  return Object.keys(editableAttributeFlags).some((key) => normalizeAttributeMode(attributes[key]) !== "keep");
}

function modesFromAttributeState(attributes = {}) {
  return Object.fromEntries(
    Object.keys(editableAttributeFlags).map((key) => [key, attributes[key] ? "set" : "clear"])
  );
}

async function readEditableAttributes(itemPath) {
  const entry = await statPathEntry(itemPath);
  return {
    path: entry.path,
    attributes: Object.fromEntries(Object.keys(editableAttributeFlags).map((key) => [key, Boolean(entry[key])])),
    text: entry.attributeText
  };
}

async function setWindowsAttributesForPath(itemPath, attributes) {
  const modes = normalizeAttributeModes(attributes);
  const args = Object.entries(editableAttributeFlags)
    .map(([key, flag]) => {
      const mode = modes[key];
      if (mode === "set") return `+${flag}`;
      if (mode === "clear") return `-${flag}`;
      return null;
    })
    .filter(Boolean);
  if (!args.length) {
    return;
  }
  const result = await runProcess("attrib.exe", [...args, resolveUserPath(itemPath)]);
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || "Failed to update file attributes.").trim());
  }
}

function normalizeTimestampUpdates(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const timestamps = {};
  for (const key of editableTimestampFields) {
    const raw = source[key];
    if (raw === undefined || raw === null || raw === "" || raw === "keep") {
      continue;
    }
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid ${key} timestamp.`);
    }
    timestamps[key] = new Date(parsed).toISOString();
  }
  return timestamps;
}

function hasTimestampChanges(timestamps = {}) {
  return editableTimestampFields.some((key) => Boolean(timestamps[key]));
}

function timestampSnapshotFromStats(itemPath, stats) {
  return {
    path: resolveUserPath(itemPath),
    timestamps: {
      modified: new Date(stats.mtimeMs).toISOString(),
      created: new Date(stats.birthtimeMs).toISOString(),
      accessed: new Date(stats.atimeMs).toISOString()
    }
  };
}

async function readEditableTimestamps(itemPath) {
  const resolved = resolveUserPath(itemPath);
  const stats = await fs.stat(resolved);
  return timestampSnapshotFromStats(resolved, stats);
}

async function setWindowsTimestampsForItems(items) {
  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
$Payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
function Convert-Time($Value) {
  if ([string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
  return [DateTimeOffset]::Parse(
    [string]$Value,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind
  ).LocalDateTime
}
function Has-Property($Object, [string]$Name) {
  return $Object -and ($Object.PSObject.Properties.Name -contains $Name)
}
$Changed = @()
foreach ($Item in @($Payload.items)) {
  $Path = [string]$Item.path
  if (-not (Test-Path -LiteralPath $Path)) { throw "Missing path: $Path" }
  $IsDirectory = [System.IO.Directory]::Exists($Path)
  if (Has-Property $Item "created") {
    $Created = Convert-Time ([string]$Item.created)
    if ($IsDirectory) { [System.IO.Directory]::SetCreationTime($Path, $Created) } else { [System.IO.File]::SetCreationTime($Path, $Created) }
  }
  if (Has-Property $Item "modified") {
    $Modified = Convert-Time ([string]$Item.modified)
    if ($IsDirectory) { [System.IO.Directory]::SetLastWriteTime($Path, $Modified) } else { [System.IO.File]::SetLastWriteTime($Path, $Modified) }
  }
  if (Has-Property $Item "accessed") {
    $Accessed = Convert-Time ([string]$Item.accessed)
    if ($IsDirectory) { [System.IO.Directory]::SetLastAccessTime($Path, $Accessed) } else { [System.IO.File]::SetLastAccessTime($Path, $Accessed) }
  }
  $Info = Get-Item -LiteralPath $Path -Force
  $Changed += [pscustomobject]@{
    path = $Info.FullName
    modified = $Info.LastWriteTimeUtc.ToString("o")
    created = $Info.CreationTimeUtc.ToString("o")
    accessed = $Info.LastAccessTimeUtc.ToString("o")
  }
}
[pscustomobject]@{ changed = $Changed } | ConvertTo-Json -Compress -Depth 4
`;
  const result = await runPowerShellPayload(script, {
    items: items.map((item) => ({ path: item.path, ...normalizeTimestampUpdates(item.timestamps) }))
  });
  const parsed = parsePowerShellJson(result, { changed: [] });
  return Array.isArray(parsed.changed) ? parsed.changed : parsed.changed ? [parsed.changed] : [];
}

function visibleByHiddenSetting(entry, showHidden) {
  return showHidden || (!entry.hidden && !entry.system);
}

function listStatConcurrency(priority = "foreground") {
  const configured = Number(process.env.EXPLORE_BETTER_LIST_CONCURRENCY || 24);
  const foreground = Number.isFinite(configured) ? Math.max(4, Math.min(Math.floor(configured), 64)) : 24;
  if (priority !== "background") {
    return foreground;
  }
  const backgroundConfigured = Number(process.env.EXPLORE_BETTER_BACKGROUND_LIST_CONCURRENCY || "");
  if (Number.isFinite(backgroundConfigured) && backgroundConfigured > 0) {
    return Math.max(1, Math.min(Math.floor(backgroundConfigured), foreground, 32));
  }
  return Math.max(1, Math.min(Math.ceil(foreground / 3), 12));
}

async function mapConcurrent(items, limit, mapper, options = {}) {
  const { signal } = options;
  throwIfAborted(signal);
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index, signal);
      throwIfAborted(signal);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeStatEntryOptions(options = {}) {
  if (options?.aborted !== undefined && typeof options.addEventListener === "function") {
    return { signal: options, includeDimensions: true, includeLinks: true, includeAttributes: true, dimensionsCache: null };
  }
  return {
    signal: options?.signal || null,
    includeDimensions: options?.includeDimensions !== false,
    includeLinks: options?.includeLinks !== false,
    includeAttributes: options?.includeAttributes !== false,
    dimensionsCache: options?.dimensionsCache || null
  };
}

async function statEntry(parent, dirent, attributeMap = new Map(), options = {}) {
  const { signal, includeDimensions, includeLinks, includeAttributes, dimensionsCache } = normalizeStatEntryOptions(options);
  throwIfAborted(signal);
  const fullPath = path.join(parent, dirent.name);
  const lstat = await fs.lstat(fullPath);
  throwIfAborted(signal);
  const stats = lstat.isSymbolicLink() ? await fs.stat(fullPath) : lstat;
  throwIfAborted(signal);
  const isDirectory = stats.isDirectory();
  const extension = isDirectory ? "" : path.extname(dirent.name).toLowerCase();
  const linkMetadata = includeLinks
    ? await linkMetadataForEntry(fullPath, stats, lstat)
    : fastLinkMetadataForEntry(lstat);
  throwIfAborted(signal);
  const attributes = attributesForEntry(
    dirent.name,
    stats,
    includeAttributes ? attributeMap.get(pathIdentity(fullPath)) : ""
  );
  const dimensions = includeDimensions ? await imageDimensionsForEntry(fullPath, stats, extension, dimensionsCache) : null;
  throwIfAborted(signal);
  return {
    name: dirent.name,
    path: fullPath,
    parent,
    isDirectory,
    isFile: stats.isFile(),
    extension,
    kind: entryKind(dirent.name, isDirectory),
    size: isDirectory ? null : stats.size,
    dimensions,
    dimensionText: dimensions?.text || "",
    dimensionPixels: dimensions?.pixels || null,
    modified: stats.mtimeMs,
    created: stats.birthtimeMs,
    accessed: stats.atimeMs,
    mode: stats.mode,
    attributes,
    readonly: attributes.readonly,
    hidden: attributes.hidden,
    system: attributes.system,
    archive: attributes.archive,
    attributeText: attributes.text,
    ...linkMetadata
  };
}

function unavailableEntry(parent, dirent, attributeMap = new Map()) {
  const fullPath = path.join(parent, dirent.name);
  const attributes = attributesForEntry(dirent.name, null, attributeMap.get(pathIdentity(fullPath)));
  return {
    name: dirent.name,
    path: fullPath,
    parent,
    isDirectory: dirent.isDirectory(),
    isFile: dirent.isFile(),
    extension: "",
    kind: dirent.isDirectory() ? "Folder" : "Unavailable",
    size: null,
    dimensions: null,
    dimensionText: "",
    dimensionPixels: null,
    modified: null,
    created: null,
    accessed: null,
    attributes,
    readonly: attributes.readonly,
    hidden: attributes.hidden,
    system: attributes.system,
    archive: attributes.archive,
    attributeText: attributes.text,
    isSymlink: false,
    linkType: "",
    linkTarget: "",
    linkTargetRaw: "",
    linkCount: null,
    unavailable: true
  };
}

async function statPathEntry(itemPath) {
  const resolved = resolveUserPath(itemPath);
  const lstat = await fs.lstat(resolved);
  const stats = lstat.isSymbolicLink() ? await fs.stat(resolved) : lstat;
  const name = path.basename(resolved) || resolved;
  const isDirectory = stats.isDirectory();
  const extension = isDirectory ? "" : path.extname(name).toLowerCase();
  const attributeMap = await windowsAttributeMap(path.dirname(resolved));
  const attributes = attributesForEntry(name, stats, attributeMap.get(pathIdentity(resolved)));
  const linkMetadata = await linkMetadataForEntry(resolved, stats, lstat);
  const dimensions = await imageDimensionsForEntry(resolved, stats, extension);
  return {
    name,
    path: resolved,
    parent: path.dirname(resolved),
    isDirectory,
    isFile: stats.isFile(),
    extension,
    kind: entryKind(name, isDirectory),
    size: isDirectory ? null : stats.size,
    dimensions,
    dimensionText: dimensions?.text || "",
    dimensionPixels: dimensions?.pixels || null,
    modified: stats.mtimeMs,
    created: stats.birthtimeMs,
    accessed: stats.atimeMs,
    mode: stats.mode,
    attributes,
    readonly: attributes.readonly,
    hidden: attributes.hidden,
    system: attributes.system,
    archive: attributes.archive,
    attributeText: attributes.text,
    ...linkMetadata
  };
}

async function applyWindowsAttributes(body) {
  if (process.platform !== "win32") {
    throw new Error("Windows attribute editing is only available on Windows.");
  }
  const paths = (Array.isArray(body.paths) ? body.paths : [])
    .filter(Boolean)
    .map((item) => resolveUserPath(item))
    .slice(0, 500);
  if (!paths.length) {
    throw new Error("Select files or folders first.");
  }

  const attributes = normalizeAttributeModes(body.attributes);
  if (!hasAttributeChanges(attributes)) {
    throw new Error("Choose at least one attribute to set or clear.");
  }

  const before = [];
  for (const itemPath of paths) {
    before.push(await readEditableAttributes(itemPath));
  }

  for (const itemPath of paths) {
    await setWindowsAttributesForPath(itemPath, attributes);
  }

  const changed = [];
  for (const itemPath of paths) {
    changed.push(await readEditableAttributes(itemPath));
  }

  return {
    result: { changed, count: changed.length, attributes },
    undo: {
      type: "attributes-restore",
      items: before.map((item) => ({ path: item.path, attributes: item.attributes }))
    }
  };
}

async function applyWindowsTimestamps(body) {
  if (process.platform !== "win32") {
    throw new Error("Windows timestamp editing is only available on Windows.");
  }
  const paths = (Array.isArray(body.paths) ? body.paths : [])
    .filter(Boolean)
    .map((item) => resolveUserPath(item))
    .slice(0, 500);
  if (!paths.length) {
    throw new Error("Select files or folders first.");
  }

  const timestamps = normalizeTimestampUpdates(body.timestamps);
  if (!hasTimestampChanges(timestamps)) {
    throw new Error("Choose at least one timestamp to update.");
  }

  const before = [];
  for (const itemPath of paths) {
    before.push(await readEditableTimestamps(itemPath));
  }

  const changed = await setWindowsTimestampsForItems(paths.map((itemPath) => ({ path: itemPath, timestamps })));

  return {
    result: { changed, count: changed.length, timestamps },
    undo: {
      type: "timestamps-restore",
      items: before.map((item) => ({ path: item.path, timestamps: item.timestamps }))
    }
  };
}

function folderSignatureFromEntries(entries, { truncated = false } = {}) {
  const sorted = [...entries].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );
  const hash = crypto.createHash("sha1");
  const summary = {
    signature: "",
    count: sorted.length,
    files: 0,
    folders: 0,
    bytes: 0,
    unavailable: 0,
    truncated: Boolean(truncated)
  };

  for (const entry of sorted) {
    if (entry.isDirectory) {
      summary.folders += 1;
    } else if (entry.isFile) {
      summary.files += 1;
      summary.bytes += Number(entry.size || 0);
    }
    if (entry.unavailable) {
      summary.unavailable += 1;
    }
    hash.update(
      [
        entry.name,
        entry.isDirectory ? "d" : entry.isFile ? "f" : "x",
        entry.size ?? "",
        entry.dimensionText || "",
        Math.round(Number(entry.modified || 0)),
        entry.attributeText || "",
        entry.linkType || "",
        entry.linkTarget || "",
        entry.linkCount ?? "",
        entry.hidden ? "h" : "",
        entry.system ? "s" : "",
        entry.unavailable ? "u" : ""
      ].join("\0")
    );
    hash.update("\n");
  }

  hash.update(summary.truncated ? "truncated" : "complete");
  summary.signature = hash.digest("hex");
  return summary;
}

function monotonicMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function elapsedMs(start) {
  return Math.round(Math.max(0, monotonicMs() - start) * 10) / 10;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function requestEtagMatches(headerValue, etag) {
  const expected = String(etag || "").replace(/^W\//, "").replace(/^"|"$/g, "");
  return String(headerValue || "")
    .split(",")
    .map((item) => item.trim().replace(/\\"/g, '"').replace(/^W\//, "").replace(/^"|"$/g, ""))
    .some((item) => item && item === expected);
}

function accessDeniedListing(requested, error, timingStart, options = {}) {
  const dir = resolveUserPath(requested);
  const parent = isRoot(dir) ? null : path.dirname(dir);
  const code = String(error?.code || "ACCESS_DENIED");
  return {
    path: dir,
    requestedPath: options.redirectedFrom || dir,
    redirectedFrom: options.redirectedFrom || null,
    selectedPath: null,
    targetKind: "directory",
    name: isRoot(dir) ? dir : path.basename(dir),
    parent,
    folderSignature: folderSignatureFromEntries([], { truncated: false }),
    showHidden: options.showHidden !== false,
    hiddenFiltered: 0,
    includeDimensions: options.includeDimensions === true,
    includeLinks: options.includeLinks === true,
    includeAttributes: options.includeAttributes === true,
    includeSignature: options.includeSignature !== false,
    accessError: {
      code,
      message:
        code === "EPERM" || code === "EACCES"
          ? "Access denied. Explore Better is still running as your normal user; protected folders stay blocked unless Windows grants access."
          : error?.message || "Folder cannot be read.",
      path: dir
    },
    timing: {
      totalMs: elapsedMs(timingStart),
      targetMs: 0,
      readMs: 0,
      statMs: 0,
      dimensionsCacheMs: 0,
      filterMs: 0,
      signatureMs: 0,
      labelMs: 0,
      scanned: 0,
      returned: 0,
      concurrency: 0,
      priority: options.priority === "background" ? "background" : "foreground"
    },
    entries: []
  };
}

function directoryListingCacheEligible(targetStats, options = {}) {
  return (
    targetStats?.isDirectory?.() === true &&
    options.priority !== "background"
  );
}

function directoryListingCacheKey(dir, options = {}) {
  return [
    pathIdentity(dir),
    options.showHidden !== false ? "hidden" : "visible",
    options.includeAttributes === true ? "attrs" : "noattrs",
    options.includeSignature !== false ? "signature" : "nosignature",
    options.includeDimensions === true ? "dimensions" : "nodimensions",
    options.includeLinks === true ? "links" : "nolinks"
  ].join("\u001f");
}

function directoryListingCacheStamp(stats) {
  if (!stats) {
    return null;
  }
  return {
    mtimeUs: Math.round(Number(stats.mtimeMs || 0) * 1000),
    ctimeUs: Math.round(Number(stats.ctimeMs || 0) * 1000),
    size: Number(stats.size || 0)
  };
}

function directoryListingCacheStampMatches(left, right) {
  return (
    left &&
    right &&
    left.mtimeUs === right.mtimeUs &&
    left.ctimeUs === right.ctimeUs &&
    left.size === right.size
  );
}

function directoryListingCacheEntryTotal() {
  let total = 0;
  for (const entry of directoryListingCache.values()) {
    total += Number(entry.entryCount || 0);
  }
  return total;
}

function pruneDirectoryListingCache() {
  while (
    directoryListingCache.size > directoryListingCacheLimit ||
    directoryListingCacheEntryTotal() > directoryListingCacheMaxEntries
  ) {
    const oldest = [...directoryListingCache.entries()].sort(
      (left, right) => Number(left[1].lastAccess || 0) - Number(right[1].lastAccess || 0)
    )[0]?.[0];
    if (!oldest) {
      break;
    }
    directoryListingCache.delete(oldest);
  }
}

function directoryListingInFlightKey(context) {
  const stamp = context?.dirStamp || {};
  return [
    context?.cacheKey || "",
    context?.watchRecord?.key || "",
    context?.watchVersion ?? "",
    stamp.mtimeUs ?? "",
    stamp.ctimeUs ?? "",
    stamp.size ?? "",
    context?.labelStamp || "",
    context?.windowOptions?.offset ?? "full",
    context?.windowOptions?.limit ?? "full"
  ].join("\u001e");
}

function sizeAnalysisInFlightKey(context) {
  const stamp = context?.rootStamp || {};
  return [
    context?.cacheKey || "",
    pathIdentity(context?.rootPath || ""),
    stamp.mtimeUs ?? "",
    stamp.ctimeUs ?? "",
    stamp.size ?? "",
    stamp.directory === true ? "dir" : "node",
    stamp.file === true ? "file" : "node"
  ].join("\u001e");
}

function dropDirectoryListingInFlightForWatchKey(watchKey) {
  if (!watchKey) {
    return;
  }
  for (const [inFlightKey, entry] of directoryListingInFlight) {
    if (entry.watchKey === watchKey) {
      directoryListingInFlight.delete(inFlightKey);
    }
  }
}

function dropSizeAnalysisInFlightForMutationPath(mutationPath) {
  if (!mutationPath) {
    return 0;
  }
  let invalidated = 0;
  for (const [inFlightKey, entry] of [...sizeAnalysisInFlight.entries()]) {
    if (!entry?.rootPath) {
      continue;
    }
    try {
      if (isInsidePath(mutationPath, entry.rootPath) || isInsidePath(entry.rootPath, mutationPath)) {
        entry.invalidated = true;
        sizeAnalysisInFlight.delete(inFlightKey);
        invalidated += 1;
      }
    } catch {}
  }
  return invalidated;
}

function dropSizeAnalysisCacheForMutationPath(mutationPath) {
  if (!mutationPath) {
    return 0;
  }
  let invalidated = 0;
  for (const [cacheKey, cached] of [...sizeAnalysisCache.entries()]) {
    if (!cached?.rootPath) {
      continue;
    }
    try {
      if (isInsidePath(mutationPath, cached.rootPath) || isInsidePath(cached.rootPath, mutationPath)) {
        sizeAnalysisCache.delete(cacheKey);
        invalidated += 1;
      }
    } catch {}
  }
  return invalidated;
}

function invalidateSizeAnalysisCachesForDirs(dirs, reason = "mutation") {
  let invalidated = 0;
  let inFlightInvalidated = 0;
  let searchInvalidated = 0;
  const paths = [];
  for (const dir of dirs.values()) {
    if (!dir) {
      continue;
    }
    inFlightInvalidated += dropSizeAnalysisInFlightForMutationPath(dir);
    invalidated += dropSizeAnalysisCacheForMutationPath(dir);
    searchInvalidated += dropAdvancedSearchCacheForMutationPath(dir);
    paths.push(dir);
  }
  return {
    reason,
    invalidated,
    inFlightInvalidated,
    searchInvalidated,
    dirs: paths.slice(0, 40)
  };
}

function dropAdvancedSearchCacheForMutationPath(mutationPath) {
  let invalidated = 0;
  for (const [cacheKey, record] of advancedSearchCache) {
    try {
      if (isInsidePath(mutationPath, record.rootPath) || isInsidePath(record.rootPath, mutationPath)) {
        advancedSearchCache.delete(cacheKey);
        invalidated += 1;
      }
    } catch {}
  }
  for (const [cacheKey, record] of advancedSearchInFlight) {
    try {
      if (isInsidePath(mutationPath, record.rootPath) || isInsidePath(record.rootPath, mutationPath)) {
        record.invalidated = true;
        advancedSearchInFlight.delete(cacheKey);
      }
    } catch {}
  }
  return invalidated;
}

function dropDirectoryListingCacheForWatchKey(watchKey) {
  if (!watchKey) {
    return;
  }
  dropDirectoryListingInFlightForWatchKey(watchKey);
  for (const [cacheKey, cached] of directoryListingCache) {
    if (cached.watchKey === watchKey) {
      directoryListingCache.delete(cacheKey);
    }
  }
}

function addDirectoryListingMutationPath(dirs, itemPath) {
  if (typeof itemPath !== "string") {
    return;
  }
  const text = itemPath.trim();
  if (!text || text.length > 4096) {
    return;
  }
  try {
    const resolved = resolveUserPath(text);
    dirs.set(pathIdentity(resolved), resolved);
    if (!isRoot(resolved)) {
      const parent = path.dirname(resolved);
      dirs.set(pathIdentity(parent), parent);
    }
  } catch {}
}

function collectDirectoryListingMutationPaths(value, dirs, key = "") {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === "string") {
    if (listingCacheMutationPathKeys.has(key)) {
      addDirectoryListingMutationPath(dirs, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectDirectoryListingMutationPaths(item, dirs, key);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    if (listingCacheMutationPathKeys.has(childKey)) {
      collectDirectoryListingMutationPaths(childValue, dirs, childKey);
    } else if (childValue && typeof childValue === "object") {
      collectDirectoryListingMutationPaths(childValue, dirs, childKey);
    }
  }
}

function invalidateDirectoryListingCachesForDirs(dirs, reason = "mutation") {
  const now = Date.now();
  const invalidated = [];
  const sizeAnalysisInvalidation = invalidateSizeAnalysisCachesForDirs(dirs, reason);
  for (const [watchKey, dir] of dirs) {
    dropDirectoryListingCacheForWatchKey(watchKey);
    const record = folderWatchers.get(watchKey);
    if (record) {
      record.version += 1;
      record.changedAt = now;
      record.lastAccess = now;
    }
    invalidated.push(dir);
  }
  return {
    reason,
    invalidated: invalidated.length,
    dirs: invalidated.slice(0, 40),
    sizeAnalysisInvalidation
  };
}

function invalidateDirectoryListingCachesForOperation(type, body, output, error = null) {
  const dirs = new Map();
  collectDirectoryListingMutationPaths(body, dirs);
  collectDirectoryListingMutationPaths(output?.result ?? output, dirs);
  collectDirectoryListingMutationPaths(output?.undo, dirs);
  collectDirectoryListingMutationPaths(error?.details, dirs);
  if (!dirs.size) {
    return { reason: `operation:${type}`, invalidated: 0, dirs: [] };
  }
  return invalidateDirectoryListingCachesForDirs(dirs, `operation:${type}`);
}

function backgroundIndexRootMatchesMutation(root, mutationPath) {
  if (!root?.path || root.enabled === false || typeof mutationPath !== "string") {
    return false;
  }
  try {
    const rootPath = resolveUserPath(root.path);
    const itemPath = resolveUserPath(mutationPath);
    return isInsidePath(itemPath, rootPath) || isInsidePath(rootPath, itemPath);
  } catch {
    return false;
  }
}

async function invalidateBackgroundIndexesForDirs(dirs, reason = "mutation", source = "operation") {
  const affectedPaths = [...dirs.values()].filter(Boolean);
  if (!affectedPaths.length) {
    return { reason, affected: 0, roots: [] };
  }
  backgroundIndexFreshnessCache.clear();
  const state = await readState();
  const roots = Array.isArray(state.backgroundIndexes) ? state.backgroundIndexes : [];
  const affectedRoots = [];
  for (const root of roots) {
    const matches = affectedPaths.filter((itemPath) => backgroundIndexRootMatchesMutation(root, itemPath));
    if (!matches.length) {
      continue;
    }
    const freshness = freshnessStatus("stale", {
      reason,
      path: matches[0],
      affectedPaths: matches.slice(0, 10),
      affectedPathCount: matches.length,
      operationInvalidation: true
    });
    const watcher = backgroundIndexWatchers.get(root.id);
    if (watcher) {
      watcher.version += 1;
      watcher.eventCount += 1;
      watcher.changedAtMs = Date.now();
      watcher.lastEventPath = matches[0];
    }
    const autoRebuild = await maybeAutoRebuildBackgroundIndex(root, freshness, source);
    if (watcher) {
      if (autoRebuild?.scheduled || autoRebuild?.active || autoRebuild?.job) {
        watcher.lastAutoRebuild = autoRebuild;
        watcher.lastSkippedAutoRebuild = null;
      } else {
        watcher.lastSkippedAutoRebuild = autoRebuild;
      }
      watcher.error = autoRebuild?.error || null;
    }
    affectedRoots.push({
      id: root.id,
      name: root.name || labelFromPath(root.path),
      path: root.path,
      matchedPaths: matches.slice(0, 10),
      matchedPathCount: matches.length,
      autoRebuild
    });
  }
  return {
    reason,
    affected: affectedRoots.length,
    roots: affectedRoots
  };
}

async function invalidateBackgroundIndexesForOperation(type, body, output, error = null) {
  const dirs = new Map();
  collectDirectoryListingMutationPaths(body, dirs);
  collectDirectoryListingMutationPaths(output?.result ?? output, dirs);
  collectDirectoryListingMutationPaths(output?.undo, dirs);
  collectDirectoryListingMutationPaths(error?.details, dirs);
  return invalidateBackgroundIndexesForDirs(dirs, `operation:${type}`);
}

async function safelyInvalidateBackgroundIndexesForDirs(dirs, reason = "mutation", source = "operation") {
  try {
    return await invalidateBackgroundIndexesForDirs(dirs, reason, source);
  } catch (invalidationError) {
    return {
      reason,
      affected: 0,
      roots: [],
      error: invalidationError.message || String(invalidationError)
    };
  }
}

async function safelyInvalidateBackgroundIndexesForOperation(type, body, output, error = null) {
  const dirs = new Map();
  collectDirectoryListingMutationPaths(body, dirs);
  collectDirectoryListingMutationPaths(output?.result ?? output, dirs);
  collectDirectoryListingMutationPaths(output?.undo, dirs);
  collectDirectoryListingMutationPaths(error?.details, dirs);
  return safelyInvalidateBackgroundIndexesForDirs(dirs, `operation:${type}`, "operation");
}

function directoryListingCacheWatcherForDir(dir) {
  const watchKey = pathIdentity(dir);
  let record = folderWatchers.get(watchKey);
  if (!record) {
    record = createFolderWatcher(dir, watchKey);
  }
  record.lastAccess = Date.now();
  pruneFolderWatchers();
  return record;
}

function directoryListingCacheHitPayload(cached, context) {
  const now = Date.now();
  const entries = cached.listing?.entries || [];
  const cacheInfo = {
    hit: true,
    source: "server-listing-cache",
    ageMs: Math.max(0, now - Number(cached.cachedAt || now)),
    entries: entries.length,
    watcherAvailable: true,
    watcherVersion: context.watchRecord.version,
    includeDimensions: context.includeDimensions === true,
    includeLinks: context.includeLinks === true,
    includeAttributes: context.includeAttributes === true,
    includeSignature: context.includeSignature !== false,
    probeMs: context.probeMs,
    stampValidated: true,
    directoryStamp: cached.dirStamp || null,
    totalEntriesCached: directoryListingCacheEntryTotal()
  };
  cached.lastAccess = now;
  return {
    ...cached.listing,
    requestedPath: context.requestedOriginal,
    redirectedFrom: context.redirected ? context.requestedOriginal : null,
    selectedPath: null,
    targetKind: context.targetStats.isDirectory() ? "directory" : "other",
    timing: {
      totalMs: elapsedMs(context.timingStart),
      targetMs: context.targetMs,
      readMs: 0,
      statMs: 0,
      dimensionsCacheMs: 0,
      filterMs: 0,
      signatureMs: 0,
      labelMs: 0,
      scanned: 0,
      returned: entries.length,
      concurrency: 0,
      priority: context.priority,
      cache: cacheInfo
    },
    cache: cacheInfo,
    entries
  };
}

function directoryListingInFlightHitPayload(listing, context, entry, joinedAt) {
  const entries = listing?.entries || [];
  const originalCache = listing?.timing?.cache || listing?.cache || {};
  const cacheInfo = {
    ...originalCache,
    hit: true,
    source: "server-listing-inflight",
    coalesced: true,
    originSource: originalCache.source || "server-listing-cache",
    originStored: originalCache.stored === true,
    waitMs: elapsedMs(joinedAt),
    startedAgeMs: elapsedMs(entry.startedAt),
    joinedWaiters: Number(entry.joined || 0),
    watcherAvailable: true,
    watcherVersion: context.watchRecord.version,
    includeDimensions: context.includeDimensions === true,
    includeLinks: context.includeLinks === true,
    includeAttributes: context.includeAttributes === true,
    includeSignature: context.includeSignature !== false,
    probeMs: context.probeMs,
    directoryStamp: context.dirStamp || null,
    entries: entries.length,
    totalEntriesCached: directoryListingCacheEntryTotal()
  };
  return {
    ...listing,
    requestedPath: context.requestedOriginal,
    redirectedFrom: context.redirected ? context.requestedOriginal : null,
    selectedPath: null,
    targetKind: context.targetStats.isDirectory() ? "directory" : "other",
    timing: {
      ...(listing?.timing || {}),
      totalMs: elapsedMs(context.timingStart),
      targetMs: context.targetMs,
      readMs: 0,
      statMs: 0,
      dimensionsCacheMs: 0,
      filterMs: 0,
      signatureMs: 0,
      labelMs: 0,
      scanned: 0,
      returned: entries.length,
      concurrency: 0,
      priority: context.priority,
      coalescedFromInFlight: true,
      cache: cacheInfo
    },
    cache: cacheInfo,
    entries
  };
}

async function coalescedDirectoryListing(context, loader) {
  if (!context?.cacheKey || !context.watcherAvailable) {
    return loader();
  }
  const inFlightKey = directoryListingInFlightKey(context);
  const existing = directoryListingInFlight.get(inFlightKey);
  if (existing) {
    existing.joined += 1;
    const joinedAt = monotonicMs();
    const listing = await existing.promise;
    return directoryListingInFlightHitPayload(listing, context, existing, joinedAt);
  }
  const entry = {
    key: inFlightKey,
    cacheKey: context.cacheKey,
    watchKey: context.watchRecord.key,
    watchVersion: context.watchVersion,
    startedAt: monotonicMs(),
    joined: 0,
    promise: null
  };
  entry.promise = Promise.resolve().then(loader);
  directoryListingInFlight.set(inFlightKey, entry);
  try {
    return await entry.promise;
  } finally {
    if (directoryListingInFlight.get(inFlightKey) === entry) {
      directoryListingInFlight.delete(inFlightKey);
    }
  }
}

function readDirectoryListingCache(context) {
  const cached = directoryListingCache.get(context.cacheKey);
  if (!cached) {
    return null;
  }
  if (
    cached.watchKey !== context.watchRecord.key ||
    cached.watchVersion !== context.watchRecord.version
  ) {
    context.skipReason = "watcher-version-changed";
    dropDirectoryListingCacheForWatchKey(context.watchRecord.key);
    return null;
  }
  if (!directoryListingCacheStampMatches(cached.dirStamp, context.dirStamp)) {
    context.skipReason = "directory-stamp-changed";
    dropDirectoryListingCacheForWatchKey(context.watchRecord.key);
    return null;
  }
  if (cached.labelStamp !== context.labelStamp) {
    context.skipReason = "labels-changed";
    directoryListingCache.delete(context.cacheKey);
    return null;
  }
  return directoryListingCacheHitPayload(cached, context);
}

function rememberDirectoryListingCache(listing, context) {
  if (!context?.cacheKey || !context.watcherAvailable) {
    return { stored: false, reason: context?.skipReason || "not-eligible" };
  }
  if (Number(context.watchRecord?.version || 0) !== Number(context.watchVersion || 0)) {
    directoryListingCache.delete(context.cacheKey);
    return { stored: false, reason: "changed-during-list", entries: listing.entries?.length || 0 };
  }
  const entryCount = listing.entries?.length || 0;
  if (entryCount > directoryListingCacheMaxEntriesPerListing) {
    directoryListingCache.delete(context.cacheKey);
    return { stored: false, reason: "too-large", entries: entryCount };
  }
  const now = Date.now();
  directoryListingCache.set(context.cacheKey, {
    cacheKey: context.cacheKey,
    watchKey: context.watchRecord.key,
    watchVersion: context.watchVersion,
    dirStamp: context.dirStamp || null,
    labelStamp: context.labelStamp,
    cachedAt: now,
    lastAccess: now,
    entryCount,
    listing
  });
  pruneDirectoryListingCache();
  return {
    stored: true,
    reason: "stored",
    entries: entryCount,
    totalEntriesCached: directoryListingCacheEntryTotal()
  };
}

async function buildDirectoryListingFromDisk(params) {
  const {
    timingStart,
    signal,
    includeDimensions,
    includeLinks,
    includeSignature,
    showHidden,
    includeAttributes,
    priority,
    statConcurrency,
    requestedOriginal,
    redirected,
    targetStats,
    selectedPath,
    dir,
    targetMs,
    listingCacheContext,
    labelState
  } = params;
  const readStart = monotonicMs();
  let dirents;
  let attributeMap;
  let labelMap;
  let dimensionsCacheState;
  try {
    [dirents, attributeMap, labelMap, dimensionsCacheState] = await Promise.all([
      fs.readdir(dir, { withFileTypes: true }),
      optionalWindowsAttributeMap(dir, includeAttributes, signal),
      labelState ? Promise.resolve(labelState.labelMap) : readLabelMap(),
      includeDimensions ? readFolderDimensionsCache(dir) : Promise.resolve(null)
    ]);
  } catch (error) {
    if (isAccessError(error)) {
      return accessDeniedListing(dir, error, timingStart, { ...options, redirectedFrom: redirected ? requestedOriginal : null });
    }
    throw error;
  }
  throwIfAborted(signal);
  const readMs = elapsedMs(readStart);
  const entries = [];
  let hiddenFiltered = 0;

  const statStart = monotonicMs();
  let statResults;
  let listingProvider = "node";
  let nativeProviderFallback = null;
  let nativeProviderMetrics = null;
  if (
    nativeDirectoryListingEligible(dir, dirents.length, {
      includeDimensions,
      includeLinks
    })
  ) {
    try {
      const nativeListing = await nativeDirectoryListing(dir, dirents.length, signal);
      statResults = nativeListing.entries;
      listingProvider = "win32-find-files";
      nativeProviderMetrics = {
        helperPid: nativeListing.helperPid,
        clientReused: nativeListing.clientReused,
        requestMs: nativeListing.requestMs,
        helperStartupMs: nativeListing.helperStartupMs
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      nativeProviderFallback = String(error?.message || error).slice(0, 240);
    }
  }
  if (!statResults) {
    statResults = await mapConcurrent(dirents, statConcurrency, async (dirent, index, workerSignal) => {
      let entry;
      try {
        entry = await statEntry(dir, dirent, attributeMap, {
          signal: workerSignal,
          includeDimensions,
          includeLinks,
          includeAttributes,
          dimensionsCache: dimensionsCacheState
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        entry = unavailableEntry(dir, dirent, attributeMap);
      }
      return entry;
    }, { signal });
  }
  const statMs = elapsedMs(statStart);
  const dimensionsCacheStart = monotonicMs();
  const dimensionsCacheSummary = includeDimensions ? await flushFolderDimensionsCache(dimensionsCacheState, statResults) : null;
  const dimensionsCacheMs = includeDimensions ? elapsedMs(dimensionsCacheStart) : 0;

  throwIfAborted(signal);

  const filterStart = monotonicMs();
  for (const entry of statResults) {
    throwIfAborted(signal);
    if (visibleByHiddenSetting(entry, showHidden)) {
      entries.push(entry);
    } else {
      hiddenFiltered += 1;
    }
  }
  const filterMs = elapsedMs(filterStart);

  const signatureStart = monotonicMs();
  const folderSignature = includeSignature ? folderSignatureFromEntries(entries) : null;
  const signatureMs = includeSignature ? elapsedMs(signatureStart) : 0;

  const labelStart = monotonicMs();
  const labelledEntries = attachPathLabels(entries, labelMap);
  const labelMs = elapsedMs(labelStart);

  const cacheInfo = listingCacheContext
    ? {
        hit: false,
        source: "server-listing-cache",
        eligible: true,
        watcherAvailable: listingCacheContext.watcherAvailable,
        watcherVersion: listingCacheContext.watchVersion,
        includeDimensions,
        includeLinks,
        includeAttributes,
        includeSignature,
        probeMs: listingCacheContext.probeMs,
        stampValidated: false,
        directoryStamp: listingCacheContext.dirStamp || null,
        stored: false,
        missReason: listingCacheContext.skipReason || "miss",
        reason: listingCacheContext.skipReason || "miss",
        entries: labelledEntries.length,
        totalEntriesCached: directoryListingCacheEntryTotal()
      }
    : null;
  const listing = {
    path: dir,
    requestedPath: requestedOriginal,
    redirectedFrom: redirected ? requestedOriginal : null,
    selectedPath,
    targetKind: targetStats.isDirectory() ? "directory" : targetStats.isFile() ? "file" : "other",
    name: isRoot(dir) ? dir : path.basename(dir),
    parent: isRoot(dir) ? null : path.dirname(dir),
    folderSignature,
    showHidden,
    hiddenFiltered,
    includeDimensions,
    includeLinks,
    includeAttributes,
    includeSignature,
    dimensionsCache: dimensionsCacheSummary,
    timing: {
      totalMs: elapsedMs(timingStart),
      targetMs,
      readMs,
      statMs,
      dimensionsCacheMs,
      filterMs,
      signatureMs,
      labelMs,
      scanned: dirents.length,
      returned: labelledEntries.length,
      concurrency: listingProvider === "node" ? statConcurrency : 1,
      provider: listingProvider,
      ...(nativeProviderMetrics ? { native: nativeProviderMetrics } : {}),
      ...(nativeProviderFallback ? { nativeProviderFallback } : {}),
      priority,
      ...(cacheInfo ? { cache: cacheInfo } : {})
    },
    ...(cacheInfo ? { cache: cacheInfo } : {}),
    entries: labelledEntries
  };
  if (cacheInfo) {
    Object.assign(cacheInfo, rememberDirectoryListingCache(listing, listingCacheContext));
  }
  return listing;
}

async function listDirectory(targetPath, options = {}) {
  const timingStart = monotonicMs();
  const { signal = null } = options;
  const includeDimensions = options.includeDimensions === true;
  const includeLinks = options.includeLinks === true;
  const includeSignature = options.includeSignature !== false;
  const showHidden = options.showHidden !== false;
  const includeAttributes = options.includeAttributes === true || !showHidden;
  const bypassCache = options.bypassCache === true;
  const windowOptions = options.windowOptions || null;
  const priority = options.priority === "background" ? "background" : "foreground";
  const statConcurrency = listStatConcurrency(priority);
  throwIfAborted(signal);
  const targetStart = monotonicMs();
  const requestedOriginal = resolveUserPath(targetPath);
  const redirected = await windowsLegacyFolderRedirectForPath(requestedOriginal);
  const requested = redirected || requestedOriginal;
  let targetStats;
  try {
    targetStats = await fs.stat(requested);
  } catch (error) {
    if (isAccessError(error)) {
      return accessDeniedListing(requested, error, timingStart, { ...options, redirectedFrom: redirected ? requestedOriginal : null });
    }
    throw error;
  }
  throwIfAborted(signal);
  const selectedPath = targetStats.isDirectory() ? null : requested;
  const dir = selectedPath ? path.dirname(requested) : requested;
  const targetMs = elapsedMs(targetStart);
  let listingCacheContext = null;
  let labelState = null;
  if (
    directoryListingCacheEligible(targetStats, {
      priority,
      includeDimensions,
      includeLinks
    })
  ) {
    const cacheProbeStart = monotonicMs();
    const watchRecord = directoryListingCacheWatcherForDir(dir);
    const watcherAvailable = Boolean(watchRecord?.watcher && !watchRecord.error);
    listingCacheContext = {
      cacheKey: directoryListingCacheKey(dir, {
        showHidden,
        includeAttributes,
        includeSignature,
        includeDimensions,
        includeLinks
      }),
      dir,
      requestedOriginal,
      redirected,
      targetStats,
      timingStart,
      targetMs,
      priority,
      includeDimensions,
      includeLinks,
      includeAttributes,
      includeSignature,
      windowOptions,
      watchRecord,
      watchVersion: Number(watchRecord?.version || 0),
      dirStamp: directoryListingCacheStamp(targetStats),
      watcherAvailable,
      skipReason: watcherAvailable ? "miss" : watchRecord?.error || "watch-unavailable",
      probeMs: 0
    };
    if (watcherAvailable) {
      labelState = await readLabelState();
      listingCacheContext.labelStamp = labelState.labelStamp;
      listingCacheContext.probeMs = elapsedMs(cacheProbeStart);
      if (!bypassCache) {
        const cachedListing = readDirectoryListingCache(listingCacheContext);
        if (cachedListing) {
          return cachedListing;
        }
      } else {
        listingCacheContext.skipReason = "bypass";
      }
    } else {
      listingCacheContext.probeMs = elapsedMs(cacheProbeStart);
    }
  }
  if (
    streamingDirectoryWindowListingEligible(targetStats, {
      showHidden,
      includeDimensions,
      includeLinks,
      includeAttributes,
      includeSignature,
      windowOptions
    })
  ) {
    try {
      return await coalescedDirectoryListing(listingCacheContext, () =>
        streamingDirectoryWindowListing({
          timingStart,
          signal,
          priority,
          statConcurrency,
          requestedOriginal,
          redirected,
          targetStats,
          dir,
          targetMs,
          labelState,
          windowOptions
        })
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  }
  if (
    nativeDirectoryWindowListingEligible(dir, targetStats, {
      includeDimensions,
      includeLinks,
      includeSignature,
      windowOptions
    })
  ) {
    try {
      return await coalescedDirectoryListing(listingCacheContext, () =>
        nativeDirectoryWindowListing({
          timingStart,
          signal,
          showHidden,
          includeAttributes,
          priority,
          requestedOriginal,
          redirected,
          targetStats,
          dir,
          targetMs,
          labelState,
          windowOptions
        })
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  }
  if (
    nativeFullDirectoryListingEligible(dir, targetStats, {
      includeDimensions,
      includeLinks,
      windowOptions
    })
  ) {
    try {
      return await coalescedDirectoryListing(listingCacheContext, () =>
        nativeFullDirectoryListing({
          timingStart,
          signal,
          showHidden,
          includeAttributes,
          includeSignature,
          priority,
          requestedOriginal,
          redirected,
          targetStats,
          dir,
          targetMs,
          labelState,
          listingCacheContext
        })
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  }
  return coalescedDirectoryListing(listingCacheContext, () =>
    buildDirectoryListingFromDisk({
      timingStart,
      signal,
      includeDimensions,
      includeLinks,
      includeSignature,
      showHidden,
      includeAttributes,
      priority,
      statConcurrency,
      requestedOriginal,
      redirected,
      targetStats,
      selectedPath,
      dir,
      targetMs,
      listingCacheContext,
      labelState
    })
  );
}

function windowDirectoryListing(listing, options = null) {
  if (listing?.window?.nativeFastPath || listing?.window?.streamingFastPath) {
    return listing;
  }
  if (!options) {
    return listing;
  }
  const allEntries = Array.isArray(listing?.entries) ? listing.entries : [];
  const totalEntries = allEntries.length;
  const offset = Math.min(boundedInteger(options.offset, 0, { min: 0 }), totalEntries);
  const limit = boundedInteger(options.limit, directoryListingWindowMaxEntries, {
    min: 1,
    max: directoryListingWindowMaxEntries
  });
  const end = Math.min(totalEntries, offset + limit);
  const entries = allEntries.slice(offset, end);
  const windowInfo = {
    offset,
    limit,
    returned: entries.length,
    total: totalEntries,
    hasMore: end < totalEntries,
    maxLimit: directoryListingWindowMaxEntries
  };
  return {
    ...listing,
    entries,
    window: windowInfo,
    timing: {
      ...(listing?.timing || {}),
      returned: entries.length,
      totalEntries,
      window: windowInfo
    }
  };
}

function compactDirectoryEntryFlags(entry) {
  return (
    (entry.isDirectory ? 1 : 0) |
    (entry.isFile ? 2 : 0) |
    (entry.readonly ? 4 : 0) |
    (entry.hidden ? 8 : 0) |
    (entry.system ? 16 : 0) |
    (entry.archive ? 32 : 0) |
    (entry.isSymlink ? 64 : 0) |
    (entry.unavailable ? 128 : 0)
  );
}

function compactDirectoryListing(listing, format = "") {
  if (format !== "compact-v1") {
    return listing;
  }
  const { entries = [], ...metadata } = listing || {};
  return {
    ...metadata,
    entryFormat: "compact-v1",
    entryRows: entries.map((entry) => {
      const row = [
        entry.name,
        compactDirectoryEntryFlags(entry),
        entry.extension || "",
        entry.kind || "File",
        entry.size ?? null,
        entry.modified ?? null,
        entry.created ?? null,
        entry.accessed ?? null,
        entry.attributeText || entry.attributes?.text || "",
        entry.label || null,
        entry.dimensionText || entry.dimensions?.text || "",
        entry.dimensionPixels || entry.dimensions?.pixels || null,
        entry.linkType || "",
        entry.linkTarget || "",
        entry.linkTargetRaw || "",
        entry.linkCount ?? null,
        entry.mode ?? null
      ];
      while (row.length && (row.at(-1) === null || row.at(-1) === "" || row.at(-1) === undefined)) {
        row.pop();
      }
      return row;
    })
  };
}

const compactDirectoryV2Cache = new WeakMap();

function compactDirectoryTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestamp) ? Math.round(timestamp) : value;
}

function compactDirectoryListingV2(listing, format = "") {
  if (format !== "compact-v2") {
    return listing;
  }
  const { entries = [], ...metadata } = listing || {};
  const cached = compactDirectoryV2Cache.get(entries);
  if (cached) {
    return { ...metadata, ...cached };
  }
  const dictionaries = {
    extensions: [""],
    kinds: ["File"],
    attributes: [""],
    linkTypes: [""]
  };
  const dictionaryIndexes = Object.fromEntries(
    Object.entries(dictionaries).map(([key, values]) => [key, new Map(values.map((value, index) => [value, index]))])
  );
  const dictionaryIndex = (key, value, fallback) => {
    const normalized = String(value || fallback);
    const known = dictionaryIndexes[key].get(normalized);
    if (known !== undefined) {
      return known;
    }
    const index = dictionaries[key].length;
    dictionaries[key].push(normalized);
    dictionaryIndexes[key].set(normalized, index);
    return index;
  };
  const entryRows = entries.map((entry) => {
    const row = [
      entry.name,
      compactDirectoryEntryFlags(entry),
      dictionaryIndex("extensions", entry.extension, ""),
      dictionaryIndex("kinds", entry.kind, "File"),
      entry.size ?? null,
      compactDirectoryTimestamp(entry.modified),
      compactDirectoryTimestamp(entry.created),
      compactDirectoryTimestamp(entry.accessed),
      dictionaryIndex("attributes", entry.attributeText || entry.attributes?.text, "") || null,
      entry.label || null,
      entry.dimensionText || entry.dimensions?.text || "",
      entry.dimensionPixels || entry.dimensions?.pixels || null,
      dictionaryIndex("linkTypes", entry.linkType, "") || null,
      entry.linkTarget || "",
      entry.linkTargetRaw || "",
      entry.linkCount ?? null,
      entry.mode ?? null
    ];
    while (row.length && (row.at(-1) === null || row.at(-1) === "" || row.at(-1) === undefined)) {
      row.pop();
    }
    return row;
  });
  const compact = { entryFormat: "compact-v2", entryDictionaries: dictionaries, entryRows };
  compactDirectoryV2Cache.set(entries, compact);
  return { ...metadata, ...compact };
}

function verboseDirectoryEntry(entry) {
  if (entry?.attributes) {
    return entry;
  }
  const attributes = attributesForEntry(entry?.name, null, entry?.attributeText || "");
  return {
    ...entry,
    dimensions: null,
    dimensionText: entry?.dimensionText || "",
    dimensionPixels: entry?.dimensionPixels ?? null,
    mode: entry?.mode ?? (entry?.isDirectory ? 0o40777 : entry?.readonly ? 0o100444 : 0o100666),
    attributes,
    linkType: entry?.linkType || "",
    linkTarget: entry?.linkTarget || "",
    linkTargetRaw: entry?.linkTargetRaw || "",
    linkCount: entry?.linkCount ?? null
  };
}

function formattedDirectoryListing(listing, format = "") {
  if (format === "compact-v2") {
    return compactDirectoryListingV2(listing, format);
  }
  if (format === "compact-v1") {
    return compactDirectoryListing(listing, format);
  }
  if (!Array.isArray(listing?.entries) || listing.entries.every((entry) => entry?.attributes)) {
    return listing;
  }
  return {
    ...listing,
    entries: listing.entries.map(verboseDirectoryEntry)
  };
}

function folderIndexIdForPath(targetPath) {
  return crypto.createHash("sha256").update(pathIdentity(targetPath)).digest("hex").slice(0, 32);
}

function folderIndexFileForPath(targetPath) {
  return path.join(indexRoot, `${folderIndexIdForPath(targetPath)}.json`);
}

function normalizeIndexQuery(query) {
  return String(query || "").trim().toLowerCase();
}

function compactIndexEntry(entry) {
  const labelName = String(entry?.label?.name || entry?.labelName || "").trim();
  const labelNotes = String(entry?.label?.notes || entry?.labelNotes || "").trim();
  const dimensions = entry?.dimensionText || entry?.dimensions?.text || "";
  const searchText = [
    entry.name,
    entry.extension,
    entry.kind,
    entry.parent,
    labelName,
    labelNotes,
    entry.attributeText,
    entry.linkType,
    entry.linkTarget,
    dimensions
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return {
    name: entry.name,
    path: entry.path,
    parent: entry.parent,
    kind: entry.kind,
    extension: entry.extension || "",
    isDirectory: entry.isDirectory === true,
    isFile: entry.isFile === true,
    size: Number(entry.size || 0),
    modified: entry.modified || null,
    created: entry.created || null,
    accessed: entry.accessed || null,
    hidden: entry.hidden === true,
    system: entry.system === true,
    readonly: entry.readonly === true,
    archive: entry.archive === true,
    reparse: entry.reparse === true,
    compressed: entry.compressed === true,
    encrypted: entry.encrypted === true,
    labelName,
    labelNotes,
    attributeText: entry.attributeText || "",
    linkType: entry.linkType || "",
    linkTarget: entry.linkTarget || "",
    dimensions,
    dimensionPixels: Number(entry.dimensionPixels || entry.dimensions?.pixels || 0),
    searchText
  };
}

function folderIndexSummary(index = {}) {
  return {
    id: index.id || "",
    path: index.path || "",
    builtAt: index.builtAt || null,
    count: Number(index.count || index.entries?.length || 0),
    hiddenFiltered: Number(index.hiddenFiltered || 0),
    folderSignature: index.folderSignature || null,
    includeDimensions: index.includeDimensions === true,
    includeLinks: index.includeLinks === true,
    dimensionsCache: index.dimensionsCache || null,
    listTiming: index.listTiming || null,
    buildMs: Number(index.buildMs || 0),
    bytes: Number(index.bytes || 0),
    tokenIndex: index.tokenIndex
      ? {
          tokens: Number(index.tokenIndex.uniqueTokenCount || 0),
          postings: Number(index.tokenIndex.postingCount || 0),
          saturated: Number(index.tokenIndex.saturatedCount || 0),
          postingLimit: Number(index.tokenIndex.postingLimit || 0)
        }
      : null
  };
}

function folderIndexCacheStats() {
  let bytes = 0;
  for (const item of folderIndexCache.values()) {
    bytes += Number(item.bytes || 0);
  }
  return {
    entries: folderIndexCache.size,
    bytes
  };
}

function pruneFolderIndexCache() {
  let stats = folderIndexCacheStats();
  if (stats.entries <= folderIndexCacheLimit && stats.bytes <= folderIndexCacheMaxBytes) {
    return;
  }
  const entries = [...folderIndexCache.entries()].sort(
    (left, right) => Number(left[1].lastUsedMs || 0) - Number(right[1].lastUsedMs || 0)
  );
  for (const [key] of entries) {
    if (stats.entries <= folderIndexCacheLimit && stats.bytes <= folderIndexCacheMaxBytes) {
      break;
    }
    const item = folderIndexCache.get(key);
    folderIndexCache.delete(key);
    stats = {
      entries: Math.max(0, stats.entries - 1),
      bytes: Math.max(0, stats.bytes - Number(item?.bytes || 0))
    };
  }
}

function folderIndexCacheStamp(stat) {
  return {
    size: Number(stat?.size || 0),
    mtimeMs: Number(stat?.mtimeMs || 0)
  };
}

function folderIndexCacheMatches(entry, stamp) {
  return (
    entry &&
    Number(entry.size || 0) === Number(stamp.size || 0) &&
    Math.abs(Number(entry.mtimeMs || 0) - Number(stamp.mtimeMs || 0)) <= 1
  );
}

async function writeFolderIndex(index) {
  await fs.mkdir(indexRoot, { recursive: true });
  const target = folderIndexFileForPath(index.path);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  let text = "";
  let previousBytes = -1;
  for (let pass = 0; pass < 4; pass += 1) {
    text = JSON.stringify(index, null, 2);
    const bytes = Buffer.byteLength(text);
    if (bytes === previousBytes) break;
    index.bytes = bytes;
    previousBytes = bytes;
  }
  text = JSON.stringify(index, null, 2);
  await fs.writeFile(temp, text, "utf8");
  await fs.rename(temp, target);
  try {
    const stat = await fs.stat(target);
    const stamp = folderIndexCacheStamp(stat);
    folderIndexCache.set(target, {
      result: {
        data: index,
        missing: false,
        corrupt: false,
        error: null,
        quarantinedPath: null
      },
      size: stamp.size,
      mtimeMs: stamp.mtimeMs,
      bytes: stamp.size,
      lastUsedMs: Date.now()
    });
    pruneFolderIndexCache();
  } catch {
    folderIndexCache.delete(target);
  }
  return index;
}

async function readFolderIndex(targetPath) {
  return (await readFolderIndexResult(targetPath)).index;
}

async function readFolderIndexResult(targetPath) {
  if (!targetPath) {
    return {
      path: "",
      index: null,
      read: { missing: true, corrupt: false, error: null, quarantinedPath: null }
    };
  }
  const resolved = resolveUserPath(targetPath);
  const filePath = folderIndexFileForPath(resolved);
  let stat = null;
  try {
    stat = await fs.stat(filePath);
  } catch {
    folderIndexCache.delete(filePath);
  }
  const stamp = stat ? folderIndexCacheStamp(stat) : null;
  const cached = stamp ? folderIndexCache.get(filePath) : null;
  let result;
  let cacheInfo;
  if (stamp && folderIndexCacheMatches(cached, stamp)) {
    cached.lastUsedMs = Date.now();
    result = cached.result;
    cacheInfo = {
      hit: true,
      file: filePath,
      size: stamp.size,
      mtimeMs: stamp.mtimeMs,
      entries: folderIndexCache.size,
      bytes: folderIndexCacheStats().bytes
    };
  } else {
    folderIndexCache.delete(filePath);
    result = await readRepairableJsonFile(filePath);
    cacheInfo = {
      hit: false,
      file: filePath,
      size: stamp?.size || 0,
      mtimeMs: stamp?.mtimeMs || 0,
      entries: folderIndexCache.size,
      bytes: folderIndexCacheStats().bytes
    };
  }
  if (!result.data) {
    return {
      path: resolved,
      index: null,
      read: {
        file: filePath,
        missing: result.missing === true,
        corrupt: result.corrupt === true,
        error: result.error || null,
        quarantinedPath: result.quarantinedPath || null,
        cache: cacheInfo
      }
    };
  }
  const valid =
    result.data.version === 1 &&
    result.data.pathKey === pathIdentity(resolved) &&
    Array.isArray(result.data.entries);
  if (!valid) {
    folderIndexCache.delete(filePath);
    return {
      path: resolved,
      index: null,
      read: {
        file: filePath,
        missing: false,
        corrupt: true,
        error: "invalid-folder-index-schema",
        quarantinedPath: await quarantineCorruptJsonFile(filePath),
        cache: cacheInfo
      }
    };
  }
  if (!cacheInfo.hit && stamp) {
    folderIndexCache.set(filePath, {
      result,
      size: stamp.size,
      mtimeMs: stamp.mtimeMs,
      bytes: stamp.size,
      lastUsedMs: Date.now()
    });
    pruneFolderIndexCache();
    cacheInfo.entries = folderIndexCache.size;
    cacheInfo.bytes = folderIndexCacheStats().bytes;
  }
  return {
    path: resolved,
    index: result.data,
    read: {
      file: filePath,
      missing: false,
      corrupt: false,
      error: null,
      quarantinedPath: null,
      cache: cacheInfo
    }
  };
}

async function buildFolderIndex(targetPath, options = {}) {
  const buildStart = monotonicMs();
  const resolved = resolveUserPath(targetPath);
  const listing = await listDirectory(resolved, {
    signal: options.signal,
    showHidden: options.showHidden !== false,
    includeAttributes: true,
    includeDimensions: options.includeDimensions === true,
    includeLinks: options.includeLinks === true,
    includeSignature: true,
    priority: options.priority === "background" ? "background" : "foreground"
  });
  const entries = listing.entries.map(compactIndexEntry);
  const index = {
    version: 1,
    id: folderIndexIdForPath(listing.path),
    path: listing.path,
    pathKey: pathIdentity(listing.path),
    requestedPath: listing.requestedPath,
    builtAt: new Date().toISOString(),
    folderSignature: listing.folderSignature,
    showHidden: listing.showHidden,
    includeDimensions: listing.includeDimensions,
    includeLinks: listing.includeLinks,
    includeAttributes: listing.includeAttributes,
    priority: listing.timing?.priority || "foreground",
    dimensionsCache: listing.dimensionsCache,
    hiddenFiltered: listing.hiddenFiltered,
    count: entries.length,
    listTiming: listing.timing,
    buildMs: elapsedMs(buildStart),
    tokenIndex: buildBackgroundSearchTokenIndex(entries),
    entries
  };
  return writeFolderIndex(index);
}

function pruneFolderIndexJobs() {
  const jobs = [...folderIndexJobs.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  for (const job of jobs.slice(folderIndexJobLimit)) {
    folderIndexJobs.delete(job.id);
  }
}

function folderIndexJobSnapshot(job) {
  return job
    ? {
        id: job.id,
        path: job.path,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt || null,
        error: job.error || null,
        index: job.index || null
      }
    : null;
}

function activeFolderIndexJobForPath(targetPath) {
  const key = pathIdentity(targetPath);
  return [...folderIndexJobs.values()].find((job) => job.pathKey === key && job.status === "running") || null;
}

function startFolderIndexJob(targetPath, options = {}) {
  const resolved = resolveUserPath(targetPath);
  const existing = activeFolderIndexJobForPath(resolved);
  if (existing) {
    return existing;
  }
  const job = {
    id: crypto.randomUUID(),
    path: resolved,
    pathKey: pathIdentity(resolved),
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    index: null
  };
  folderIndexJobs.set(job.id, job);
  pruneFolderIndexJobs();
  buildFolderIndex(resolved, options)
    .then((index) => {
      job.status = "complete";
      job.finishedAt = new Date().toISOString();
      job.index = folderIndexSummary(index);
    })
    .catch((error) => {
      job.status = "error";
      job.finishedAt = new Date().toISOString();
      job.error = error.message || String(error);
    });
  return job;
}

async function folderIndexStatus(targetPath, jobId = "") {
  const job = jobId ? folderIndexJobs.get(jobId) : targetPath ? activeFolderIndexJobForPath(targetPath) : null;
  const indexResult = targetPath ? await readFolderIndexResult(targetPath) : null;
  const index = indexResult?.index || null;
  return {
    path: indexResult?.path || (targetPath ? resolveUserPath(targetPath) : ""),
    indexed: Boolean(index),
    index: index ? folderIndexSummary(index) : null,
    indexRead: indexResult?.read || null,
    job: folderIndexJobSnapshot(job),
    cacheRoot: indexRoot
  };
}

async function searchFolderIndex({ targetPath, query, limit = 120 } = {}) {
  const searchStart = monotonicMs();
  const q = normalizeIndexQuery(query);
  const indexResult = await readFolderIndexResult(targetPath);
  const index = indexResult.index;
  const max = Math.max(1, Math.min(Number(limit || 120), 1000));
  if (!index) {
    return {
      indexed: false,
      path: indexResult.path || (targetPath ? resolveUserPath(targetPath) : ""),
      query: q,
      indexRead: indexResult.read,
      results: [],
      timing: { searchMs: elapsedMs(searchStart), scanned: 0 }
    };
  }
  const entries = Array.isArray(index.entries) ? index.entries : [];
  const candidatePlan = backgroundSearchCandidatePlan(index, q);
  const candidateIndexes = Array.isArray(candidatePlan.indexes) ? candidatePlan.indexes : null;
  const candidates = candidateIndexes
    ? candidateIndexes.map((entryIndex) => entries[Number(entryIndex)]).filter(Boolean)
    : entries;
  const results = [];
  let scanned = 0;
  for (const entry of candidates) {
    scanned += 1;
    if (!q || String(entry.searchText || entry.name || "").includes(q)) {
      results.push({
        name: entry.name,
        path: entry.path,
        kind: entry.kind,
        extension: entry.extension,
        isDirectory: entry.isDirectory,
        isFile: entry.isFile,
        size: entry.size,
        modified: entry.modified,
        dimensions: entry.dimensions || "",
        dimensionPixels: entry.dimensionPixels || 0,
        labelName: entry.labelName,
        labelNotes: entry.labelNotes
      });
    }
    if (results.length >= max) {
      break;
    }
  }
  return {
    indexed: true,
    path: index.path,
    query: q,
    indexRead: indexResult.read,
    index: folderIndexSummary(index),
    results,
    timing: {
      searchMs: elapsedMs(searchStart),
      scanned,
      candidateEntries: candidates.length,
      tokenIndexed: index.tokenIndex?.version === 1,
      tokenNarrowed: candidatePlan.narrowed === true,
      tokenStrategy: candidatePlan.strategy || "scan",
      tokenReason: candidatePlan.reason || "",
      storeCacheHit: indexResult.read?.cache?.hit === true,
      storeCacheHits: indexResult.read?.cache?.hit === true ? 1 : 0,
      storeCacheMisses: indexResult.read?.cache?.hit === true ? 0 : 1,
      returned: results.length
    }
  };
}

function backgroundIndexStoreId(rootId) {
  return sanitizeReferenceId(rootId) || crypto.randomUUID();
}

function backgroundIndexManifestFile(rootId) {
  return path.join(indexRoot, `background-${backgroundIndexStoreId(rootId)}.json`);
}

function backgroundIndexSearchFile(rootId) {
  return path.join(indexRoot, `background-${backgroundIndexStoreId(rootId)}-search.json`);
}

async function writeJsonAtomic(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(temp, filePath);
  return payload;
}

async function quarantineCorruptJsonFile(filePath) {
  const quarantinedPath = `${filePath}.corrupt-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  try {
    await fs.rename(filePath, quarantinedPath);
    return quarantinedPath;
  } catch {
    return null;
  }
}

async function readJsonFile(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readRepairableJsonFile(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        data: null,
        missing: false,
        corrupt: true,
        error: "JSON root is not an object.",
        quarantinedPath: await quarantineCorruptJsonFile(filePath)
      };
    }
    return { data: parsed, missing: false, corrupt: false, error: null, quarantinedPath: null };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { data: null, missing: true, corrupt: false, error: null, quarantinedPath: null };
    }
    return {
      data: null,
      missing: false,
      corrupt: true,
      error: error.message || String(error),
      quarantinedPath: await quarantineCorruptJsonFile(filePath)
    };
  }
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

function clampDays(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(3650, Math.max(0, number));
}

async function readJsonForCacheMaintenance(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { data: null, corrupt: true, missing: false, error: "JSON root is not an object." };
    }
    return { data, corrupt: false, missing: false, error: null };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { data: null, corrupt: false, missing: true, error: null };
    }
    return { data: null, corrupt: true, missing: false, error: error.message || String(error) };
  }
}

async function statOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function readdirFilesOrEmpty(dirPath, limit) {
  try {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    return dirents
      .filter((dirent) => dirent.isFile())
      .slice(0, limit)
      .map((dirent) => path.join(dirPath, dirent.name));
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function cacheFileLooksMaintenanceEligible(filePath) {
  const name = path.basename(filePath);
  return name.endsWith(".json") || name.includes(".json.corrupt-") || name.endsWith(".tmp");
}

function cacheMaintenanceOptions(source = {}, method = "GET") {
  const raw = source && typeof source === "object" ? source : {};
  const dryRun = method === "GET" ? true : raw.dryRun !== false && raw.apply !== true;
  const maxAgeDays = clampDays(raw.maxAgeDays ?? raw.maxDays, cacheMaintenanceDefaultMaxAgeDays);
  return {
    dryRun,
    maxAgeDays,
    maxAgeMs: maxAgeDays * 24 * 60 * 60 * 1000,
    fileLimit: clampInteger(raw.fileLimit, 1, cacheMaintenanceFileLimit, cacheMaintenanceFileLimit),
    includeItems: raw.includeItems !== false
  };
}

function backgroundCacheRootIdFromName(filePath) {
  const name = path.basename(filePath);
  const match = /^background-(.+?)(?:-search)?\.json(?:\.corrupt-[A-Za-z0-9-]+)?$/.exec(name);
  return match ? match[1] : "";
}

function isBackgroundCacheFile(filePath) {
  return path.basename(filePath).startsWith("background-");
}

function cacheMaintenanceAge(stat, nowMs) {
  const modifiedMs = Number(stat?.mtimeMs || 0);
  const ageMs = Math.max(0, nowMs - modifiedMs);
  return {
    modifiedMs,
    modifiedAt: modifiedMs ? new Date(modifiedMs).toISOString() : null,
    ageMs,
    ageDays: Math.round((ageMs / (24 * 60 * 60 * 1000)) * 10) / 10
  };
}

function safeOwnedCacheFile(filePath, rootPath) {
  const resolved = resolveUserPath(filePath);
  const root = resolveUserPath(rootPath);
  return pathIdentity(resolved) !== pathIdentity(root) && isInsidePath(resolved, root);
}

async function deleteOwnedCacheFile(filePath, rootPath) {
  if (!safeOwnedCacheFile(filePath, rootPath)) {
    throw new Error("Refusing to delete a file outside Explore Better cache roots.");
  }
  await fs.rm(filePath, { force: true });
}

async function cacheMaintenanceDecision(filePath, cacheKind, rootPath, context) {
  const stat = await statOrNull(filePath);
  if (!stat?.isFile?.()) {
    return null;
  }
  const age = cacheMaintenanceAge(stat, context.nowMs);
  const base = {
    cache: cacheKind,
    file: filePath,
    bytes: Number(stat.size || 0),
    ...age,
    reason: "",
    delete: false,
    protected: false,
    readError: null
  };
  const name = path.basename(filePath);

  if (name.includes(".json.corrupt-")) {
    return { ...base, reason: "quarantined-cache", delete: true };
  }
  if (name.endsWith(".tmp")) {
    return { ...base, reason: "stale-temp-file", delete: age.ageMs >= Math.min(context.maxAgeMs, 60 * 60 * 1000) };
  }
  if (!name.endsWith(".json")) {
    return null;
  }

  const read = await readJsonForCacheMaintenance(filePath);
  if (read.corrupt) {
    return { ...base, reason: "corrupt-json", readError: read.error, delete: true };
  }
  if (!read.data) {
    return { ...base, reason: "missing-cache-file", delete: false };
  }

  if (cacheKind === "index" && isBackgroundCacheFile(filePath)) {
    const rootId = backgroundCacheRootIdFromName(filePath);
    const active = Boolean(rootId && context.activeBackgroundRootIds.has(rootId));
    if (!active) {
      return { ...base, reason: "background-root-unregistered", delete: true, rootId };
    }
    if (context.maxAgeMs > 0 && age.ageMs > context.maxAgeMs) {
      return { ...base, reason: "active-background-root-preserved", delete: false, protected: true, rootId };
    }
    return { ...base, reason: "active-background-root", delete: false, protected: true, rootId };
  }

  if (cacheKind === "index") {
    const valid =
      read.data.version === 1 &&
      typeof read.data.path === "string" &&
      read.data.pathKey === pathIdentity(read.data.path) &&
      Array.isArray(read.data.entries);
    if (!valid) {
      return { ...base, reason: "invalid-folder-index-schema", delete: true };
    }
    if (!(await pathExists(read.data.path))) {
      return { ...base, reason: "folder-path-missing", delete: true, targetPath: read.data.path };
    }
    if (context.maxAgeMs > 0 && age.ageMs > context.maxAgeMs) {
      return { ...base, reason: "folder-index-older-than-threshold", delete: true, targetPath: read.data.path };
    }
    return { ...base, reason: "folder-index-current", delete: false, targetPath: read.data.path };
  }

  const valid =
    read.data.version === 1 &&
    typeof read.data.path === "string" &&
    read.data.pathKey === pathIdentity(read.data.path) &&
    read.data.entries &&
    typeof read.data.entries === "object" &&
    !Array.isArray(read.data.entries);
  if (!valid) {
    return { ...base, reason: "invalid-metadata-cache-schema", delete: true };
  }
  if (!(await pathExists(read.data.path))) {
    return { ...base, reason: "metadata-folder-missing", delete: true, targetPath: read.data.path };
  }
  if (context.maxAgeMs > 0 && age.ageMs > context.maxAgeMs) {
    return { ...base, reason: "metadata-cache-older-than-threshold", delete: true, targetPath: read.data.path };
  }
  return { ...base, reason: "metadata-cache-current", delete: false, targetPath: read.data.path };
}

async function cacheMaintenanceReport(options = {}) {
  const opts = cacheMaintenanceOptions(options, options.method || "GET");
  const state = await readState();
  const activeBackgroundRootIds = new Set((state.backgroundIndexes || []).map((root) => root.id).filter(Boolean));
  const context = {
    nowMs: Date.now(),
    maxAgeMs: opts.maxAgeMs,
    activeBackgroundRootIds
  };
  const dimensionsRoot = path.join(metadataCacheRoot, "Dimensions");
  const indexFiles = (await readdirFilesOrEmpty(indexRoot, opts.fileLimit)).filter(cacheFileLooksMaintenanceEligible);
  const metadataFiles = (await readdirFilesOrEmpty(dimensionsRoot, opts.fileLimit)).filter(cacheFileLooksMaintenanceEligible);
  const decisions = [];
  for (const filePath of indexFiles) {
    const decision = await cacheMaintenanceDecision(filePath, "index", indexRoot, context);
    if (decision) {
      decisions.push(decision);
    }
  }
  for (const filePath of metadataFiles) {
    const decision = await cacheMaintenanceDecision(filePath, "metadata", metadataCacheRoot, context);
    if (decision) {
      decisions.push(decision);
    }
  }

  let deleted = 0;
  let freedBytes = 0;
  const appliedItems = [];
  for (const item of decisions) {
    if (!item.delete) {
      item.action = "keep";
      continue;
    }
    item.action = opts.dryRun ? "would-delete" : "delete";
    if (opts.dryRun) {
      continue;
    }
    try {
      await deleteOwnedCacheFile(item.file, item.cache === "index" ? indexRoot : metadataCacheRoot);
      item.deleted = true;
      deleted += 1;
      freedBytes += item.bytes;
      appliedItems.push(item);
    } catch (error) {
      item.deleted = false;
      item.deleteError = error.message || String(error);
    }
  }

  const byReason = {};
  const byCache = {};
  for (const item of decisions) {
    byReason[item.reason] = (byReason[item.reason] || 0) + 1;
    byCache[item.cache] = (byCache[item.cache] || 0) + 1;
  }
  const eligible = decisions.filter((item) => item.delete).length;
  const errors = decisions.filter((item) => item.deleteError).length;
  return {
    ok: errors === 0,
    dryRun: opts.dryRun,
    generatedAt: new Date().toISOString(),
    roots: {
      indexRoot,
      metadataCacheRoot,
      dimensionsRoot
    },
    limits: {
      maxAgeDays: opts.maxAgeDays,
      fileLimit: opts.fileLimit,
      activeBackgroundRoots: activeBackgroundRootIds.size
    },
    scanned: decisions.length,
    eligible,
    deleted,
    freedBytes,
    errors,
    byCache,
    byReason,
    items: opts.includeItems ? decisions.slice(0, opts.fileLimit) : undefined,
    appliedItems: opts.includeItems ? appliedItems : undefined
  };
}

function backgroundIndexJobSnapshot(job) {
  return job
    ? {
        id: job.id,
        rootId: job.rootId,
        path: job.path,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt || null,
        error: job.error || null,
        progress: job.progress || null,
        stats: job.stats || null
      }
    : null;
}

function pruneBackgroundIndexJobs() {
  const jobs = [...backgroundIndexJobs.values()].sort((a, b) =>
    String(b.startedAt).localeCompare(String(a.startedAt))
  );
  for (const job of jobs.slice(backgroundIndexJobLimit)) {
    backgroundIndexJobs.delete(job.id);
  }
}

function activeBackgroundIndexJob(rootId) {
  return [...backgroundIndexJobs.values()].find((job) => job.rootId === rootId && job.status === "running") || null;
}

function backgroundIndexAutoRebuildCooldownMs() {
  const configured = Number(process.env.EXPLORE_BETTER_BACKGROUND_AUTO_REBUILD_COOLDOWN_MS || 30000);
  return Number.isFinite(configured) ? Math.max(1000, Math.min(Math.round(configured), 600000)) : 30000;
}

function backgroundIndexWatchDebounceMs() {
  const configured = Number(process.env.EXPLORE_BETTER_BACKGROUND_WATCH_DEBOUNCE_MS || 1500);
  return Number.isFinite(configured) ? Math.max(250, Math.min(Math.round(configured), 60000)) : 1500;
}

function backgroundIndexWatchFolderLimit() {
  const configured = Number(process.env.EXPLORE_BETTER_BACKGROUND_WATCH_FOLDERS || 64);
  return Number.isFinite(configured) ? Math.max(1, Math.min(Math.round(configured), 512)) : 64;
}

async function readBackgroundIndexManifestResult(rootId) {
  return readRepairableJsonFile(backgroundIndexManifestFile(rootId));
}

function backgroundIndexSearchStoreCacheStats() {
  let bytes = 0;
  for (const item of backgroundIndexSearchStoreCache.values()) {
    bytes += Number(item.bytes || 0);
  }
  return {
    entries: backgroundIndexSearchStoreCache.size,
    bytes
  };
}

function pruneBackgroundIndexSearchStoreCache() {
  let stats = backgroundIndexSearchStoreCacheStats();
  if (stats.entries <= backgroundSearchStoreCacheLimit && stats.bytes <= backgroundSearchStoreCacheMaxBytes) {
    return;
  }
  const entries = [...backgroundIndexSearchStoreCache.entries()].sort(
    (left, right) => Number(left[1].lastUsedMs || 0) - Number(right[1].lastUsedMs || 0)
  );
  for (const [key] of entries) {
    if (stats.entries <= backgroundSearchStoreCacheLimit && stats.bytes <= backgroundSearchStoreCacheMaxBytes) {
      break;
    }
    const item = backgroundIndexSearchStoreCache.get(key);
    backgroundIndexSearchStoreCache.delete(key);
    stats = {
      entries: Math.max(0, stats.entries - 1),
      bytes: Math.max(0, stats.bytes - Number(item?.bytes || 0))
    };
  }
}

function backgroundIndexSearchStoreCacheStamp(stat) {
  return {
    size: Number(stat?.size || 0),
    mtimeMs: Number(stat?.mtimeMs || 0)
  };
}

function backgroundIndexSearchStoreCacheMatches(entry, stamp) {
  return (
    entry &&
    Number(entry.size || 0) === Number(stamp.size || 0) &&
    Math.abs(Number(entry.mtimeMs || 0) - Number(stamp.mtimeMs || 0)) <= 1
  );
}

function backgroundIndexSearchStoreInFlightKey(filePath, stamp) {
  return [filePath, Number(stamp?.size || 0), Number(stamp?.mtimeMs || 0)].join("\u001e");
}

function backgroundIndexSearchStoreInFlightHit(readResult, entry, joinedAt) {
  return {
    ...readResult,
    cache: {
      ...(readResult?.cache || {}),
      hit: true,
      source: "background-search-store-inflight",
      coalesced: true,
      originSource: readResult?.cache?.source || "background-search-store-file",
      originHit: readResult?.cache?.hit === true,
      waitMs: elapsedMs(joinedAt),
      startedAgeMs: elapsedMs(entry.startedAt),
      joinedWaiters: Number(entry.joined || 0),
      entries: backgroundIndexSearchStoreCache.size,
      bytes: backgroundIndexSearchStoreCacheStats().bytes
    }
  };
}

async function readBackgroundIndexSearchStoreFromDisk(filePath, stamp) {
  const result = await readRepairableJsonFile(filePath);
  if (result.data) {
    backgroundIndexSearchStoreCache.set(filePath, {
      result,
      size: stamp.size,
      mtimeMs: stamp.mtimeMs,
      bytes: stamp.size,
      lastUsedMs: Date.now()
    });
    pruneBackgroundIndexSearchStoreCache();
  }
  return {
    ...result,
    cache: {
      hit: false,
      source: "background-search-store-file",
      file: filePath,
      size: stamp.size,
      mtimeMs: stamp.mtimeMs,
      entries: backgroundIndexSearchStoreCache.size,
      bytes: backgroundIndexSearchStoreCacheStats().bytes
    }
  };
}

async function coalescedBackgroundIndexSearchStoreRead(filePath, stamp) {
  const inFlightKey = backgroundIndexSearchStoreInFlightKey(filePath, stamp);
  const existing = backgroundIndexSearchStoreInFlight.get(inFlightKey);
  if (existing) {
    existing.joined += 1;
    const joinedAt = monotonicMs();
    const readResult = await existing.promise;
    return backgroundIndexSearchStoreInFlightHit(readResult, existing, joinedAt);
  }
  const entry = {
    key: inFlightKey,
    filePath,
    stamp,
    startedAt: monotonicMs(),
    joined: 0,
    promise: null
  };
  entry.promise = readBackgroundIndexSearchStoreFromDisk(filePath, stamp);
  backgroundIndexSearchStoreInFlight.set(inFlightKey, entry);
  try {
    return await entry.promise;
  } finally {
    if (backgroundIndexSearchStoreInFlight.get(inFlightKey) === entry) {
      backgroundIndexSearchStoreInFlight.delete(inFlightKey);
    }
  }
}

async function readBackgroundIndexSearchStoreResult(rootId) {
  const filePath = backgroundIndexSearchFile(rootId);
  let stat = null;
  try {
    stat = await fs.stat(filePath);
  } catch {
    backgroundIndexSearchStoreCache.delete(filePath);
    const result = await readRepairableJsonFile(filePath);
    return {
      ...result,
      cache: {
        hit: false,
        reason: "missing-or-unavailable",
        entries: backgroundIndexSearchStoreCache.size,
        bytes: backgroundIndexSearchStoreCacheStats().bytes
      }
    };
  }
  const stamp = backgroundIndexSearchStoreCacheStamp(stat);
  const cached = backgroundIndexSearchStoreCache.get(filePath);
  if (backgroundIndexSearchStoreCacheMatches(cached, stamp)) {
    cached.lastUsedMs = Date.now();
    return {
      ...cached.result,
      cache: {
        hit: true,
        source: "background-search-store-cache",
        file: filePath,
        size: stamp.size,
        mtimeMs: stamp.mtimeMs,
        entries: backgroundIndexSearchStoreCache.size,
        bytes: backgroundIndexSearchStoreCacheStats().bytes
      }
    };
  }
  backgroundIndexSearchStoreCache.delete(filePath);
  return coalescedBackgroundIndexSearchStoreRead(filePath, stamp);
}

async function readBackgroundIndexManifest(rootId) {
  return (await readBackgroundIndexManifestResult(rootId)).data;
}

async function readBackgroundIndexSearchStore(rootId) {
  return (await readBackgroundIndexSearchStoreResult(rootId)).data;
}

function backgroundIndexReadSummary(manifestRead, searchRead) {
  const manifestError = manifestRead?.corrupt
    ? {
        error: manifestRead.error || "Unreadable manifest.",
        quarantinedPath: manifestRead.quarantinedPath || null
      }
    : null;
  const searchError = searchRead?.corrupt
    ? {
        error: searchRead.error || "Unreadable search store.",
        quarantinedPath: searchRead.quarantinedPath || null
      }
    : null;
  return {
    manifestMissing: manifestRead?.missing === true,
    searchMissing: searchRead?.missing === true,
    manifestError,
    searchError,
    searchCache: searchRead?.cache || null
  };
}

function backgroundIndexReadFreshness(root, manifest, searchRead) {
  if (searchRead?.corrupt) {
    return freshnessStatus("stale", {
      reason: "search-store-corrupt",
      readError: searchRead.error || "Unreadable search store.",
      quarantinedPath: searchRead.quarantinedPath || null,
      searchFile: backgroundIndexSearchFile(root.id)
    });
  }
  if (searchRead?.missing && manifest) {
    return freshnessStatus("stale", {
      reason: "search-store-missing",
      searchFile: backgroundIndexSearchFile(root.id)
    });
  }
  return null;
}

function backgroundIndexFreshnessTtlMs() {
  const configured = Number(process.env.EXPLORE_BETTER_BACKGROUND_FRESHNESS_TTL_MS || 5000);
  return Number.isFinite(configured) ? Math.max(500, Math.min(Math.round(configured), 60000)) : 5000;
}

function backgroundIndexFreshnessLimits() {
  const folderLimit = Number(process.env.EXPLORE_BETTER_BACKGROUND_FRESHNESS_FOLDERS || 200);
  const entryLimit = Number(process.env.EXPLORE_BETTER_BACKGROUND_FRESHNESS_ENTRIES || 500);
  return {
    folderLimit: Number.isFinite(folderLimit) ? Math.max(1, Math.min(Math.round(folderLimit), 5000)) : 200,
    entryLimit: Number.isFinite(entryLimit) ? Math.max(1, Math.min(Math.round(entryLimit), 10000)) : 500
  };
}

function backgroundIndexFreshnessCacheKey(root, store) {
  return [
    root?.id || "",
    store?.builtAt || "",
    store?.count || "",
    store?.bytes || "",
    store?.contentBytes || ""
  ].join("|");
}

function sameIndexTimestamp(left, right) {
  const leftValue = Number(left);
  const rightValue = Number(right);
  if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
    return true;
  }
  return Math.abs(leftValue - rightValue) <= 5;
}

function folderFreshnessStamps(manifest, store) {
  const fromStore = Array.isArray(store?.folderStamps) ? store.folderStamps : [];
  const fromManifest = Array.isArray(manifest?.folders) ? manifest.folders : [];
  return (fromStore.length ? fromStore : fromManifest)
    .filter((folder) => folder?.path)
    .map((folder) => ({
      path: folder.path,
      count: Number(folder.count),
      modified: folder.modified ?? folder.mtimeMs ?? null
    }));
}

function entryFreshnessStamps(store) {
  return (Array.isArray(store?.entries) ? store.entries : [])
    .filter((entry) => entry?.path && entry.isFile === true)
    .map((entry) => ({
      path: entry.path,
      isFile: entry.isFile === true,
      size: Number(entry.size || 0),
      modified: entry.modified ?? null
    }));
}

function freshnessStatus(status, detail = {}) {
  return {
    checkedAt: new Date().toISOString(),
    status,
    stale: status === "stale",
    ...detail
  };
}

async function backgroundIndexFreshness(root, store, manifest = null) {
  if (!store) {
    return freshnessStatus("missing", { reason: "search-store-missing" });
  }
  const cacheKey = backgroundIndexFreshnessCacheKey(root, store);
  const cached = backgroundIndexFreshnessCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.checkedAtMs < backgroundIndexFreshnessTtlMs()) {
    return { ...cached.result, cached: true };
  }

  const { folderLimit, entryLimit } = backgroundIndexFreshnessLimits();
  const folders = folderFreshnessStamps(manifest, store);
  const entries = entryFreshnessStamps(store);
  const limitedFolders = folders.slice(0, folderLimit);
  const limitedEntries = entries.slice(0, entryLimit);
  const base = {
    builtAt: store.builtAt || manifest?.builtAt || null,
    foldersChecked: 0,
    entriesChecked: 0,
    folderSamples: limitedFolders.length,
    entrySamples: limitedEntries.length,
    folderSampleLimit: folderLimit,
    entrySampleLimit: entryLimit,
    sampleLimited: folders.length > limitedFolders.length || entries.length > limitedEntries.length,
    checkedFoldersTotal: folders.length,
    checkedEntriesTotal: entries.length
  };

  let result;
  try {
    await fs.access(root.path);
  } catch (error) {
    result = freshnessStatus("stale", {
      ...base,
      reason: "root-unavailable",
      path: root.path,
      code: error.code || "unavailable"
    });
    backgroundIndexFreshnessCache.set(cacheKey, { checkedAtMs: now, result });
    return result;
  }

  for (const folder of limitedFolders) {
    try {
      const [stats, names] = await Promise.all([fs.stat(folder.path), fs.readdir(folder.path)]);
      base.foldersChecked += 1;
      if (Number.isFinite(folder.count) && names.length !== folder.count) {
        result = freshnessStatus("stale", {
          ...base,
          reason: "folder-count-changed",
          path: folder.path,
          expected: folder.count,
          actual: names.length
        });
        backgroundIndexFreshnessCache.set(cacheKey, { checkedAtMs: now, result });
        return result;
      }
      if (folder.modified !== null && !sameIndexTimestamp(stats.mtimeMs, folder.modified)) {
        result = freshnessStatus("stale", {
          ...base,
          reason: "folder-modified",
          path: folder.path,
          expected: folder.modified,
          actual: stats.mtimeMs
        });
        backgroundIndexFreshnessCache.set(cacheKey, { checkedAtMs: now, result });
        return result;
      }
    } catch (error) {
      result = freshnessStatus("stale", {
        ...base,
        reason: "folder-unavailable",
        path: folder.path,
        code: error.code || "unavailable"
      });
      backgroundIndexFreshnessCache.set(cacheKey, { checkedAtMs: now, result });
      return result;
    }
  }

  for (const entry of limitedEntries) {
    try {
      const stats = await fs.stat(entry.path);
      base.entriesChecked += 1;
      if (entry.isFile && Number.isFinite(entry.size) && Number(stats.size) !== entry.size) {
        result = freshnessStatus("stale", {
          ...base,
          reason: "entry-size-changed",
          path: entry.path,
          expected: entry.size,
          actual: stats.size
        });
        backgroundIndexFreshnessCache.set(cacheKey, { checkedAtMs: now, result });
        return result;
      }
      if (entry.modified !== null && !sameIndexTimestamp(stats.mtimeMs, entry.modified)) {
        result = freshnessStatus("stale", {
          ...base,
          reason: "entry-modified",
          path: entry.path,
          expected: entry.modified,
          actual: stats.mtimeMs
        });
        backgroundIndexFreshnessCache.set(cacheKey, { checkedAtMs: now, result });
        return result;
      }
    } catch (error) {
      result = freshnessStatus("stale", {
        ...base,
        reason: "entry-unavailable",
        path: entry.path,
        code: error.code || "unavailable"
      });
      backgroundIndexFreshnessCache.set(cacheKey, { checkedAtMs: now, result });
      return result;
    }
  }

  result = freshnessStatus("fresh", {
    ...base,
    reason: folders.length || entries.length ? "sample-current" : "no-samples"
  });
  backgroundIndexFreshnessCache.set(cacheKey, { checkedAtMs: now, result });
  return result;
}

function backgroundIndexStoreSummary(store = {}) {
  const folderCount = Array.isArray(store.folders)
    ? store.folders.length
    : Number(store.folders || store.manifest?.folders?.length || 0);
  const entryCount = Array.isArray(store.entries)
    ? store.entries.length
    : Number(store.count || 0);
  return store
    ? {
        rootId: store.rootId || "",
        path: store.path || "",
        builtAt: store.builtAt || null,
        recursive: store.recursive === true,
        includeDimensions: store.includeDimensions === true,
        includeLinks: store.includeLinks === true,
        includeContent: store.includeContent === true,
        priority: store.priority || null,
        listConcurrency: store.listConcurrency || null,
        contentConcurrency: store.contentConcurrency || null,
        folders: Number.isFinite(folderCount) ? folderCount : 0,
        count: Number.isFinite(entryCount) ? entryCount : 0,
        contentIndexed: Number(store.contentIndexed || 0),
        contentSkipped: Number(store.contentSkipped || 0),
        contentBytes: Number(store.contentBytes || 0),
        contentTruncated: store.contentTruncated === true,
        truncated: store.truncated === true,
        errors: Array.isArray(store.errors) ? store.errors.length : 0,
        buildMs: Number(store.buildMs || 0),
        bytes: Number(store.bytes || 0),
        tokenIndex: store.tokenIndex
          ? {
              tokens: Number(store.tokenIndex.uniqueTokenCount || 0),
              postings: Number(store.tokenIndex.postingCount || 0),
              saturated: Number(store.tokenIndex.saturatedCount || 0),
              postingLimit: Number(store.tokenIndex.postingLimit || 0)
            }
          : null
      }
    : null;
}

function backgroundSearchTokens(text) {
  const normalized = String(text || "").toLowerCase();
  const matches = normalized.match(/[a-z0-9]+/g) || [];
  const tokens = [];
  const seen = new Set();
  for (const match of matches) {
    if (match.length < 2) {
      continue;
    }
    const token = match.slice(0, backgroundSearchTokenLengthLimit);
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= backgroundSearchTokenPerEntryLimit) {
      break;
    }
  }
  return tokens;
}

function buildBackgroundSearchTokenIndex(entries = []) {
  const postings = {};
  const saturated = new Set();
  let postingCount = 0;
  entries.forEach((entry, index) => {
    for (const token of backgroundSearchTokens(entry?.searchText || entry?.name || "")) {
      if (saturated.has(token)) {
        continue;
      }
      const list = postings[token] || [];
      if (list.length >= backgroundSearchTokenPostingLimit) {
        postingCount -= list.length;
        delete postings[token];
        saturated.add(token);
        continue;
      }
      list.push(index);
      postings[token] = list;
      postingCount += 1;
    }
  });
  return {
    version: 1,
    postingLimit: backgroundSearchTokenPostingLimit,
    perEntryLimit: backgroundSearchTokenPerEntryLimit,
    tokenLengthLimit: backgroundSearchTokenLengthLimit,
    uniqueTokenCount: Object.keys(postings).length,
    saturatedCount: saturated.size,
    postingCount,
    saturated: [...saturated].slice(0, 10000),
    postings
  };
}

function backgroundSearchCandidatePlan(store, query) {
  const q = normalizeIndexQuery(query);
  if (!q) {
    return { strategy: "all", tokens: [], indexes: null, narrowed: false, reason: "empty-query" };
  }
  const tokens = backgroundSearchTokens(q);
  const index = store?.tokenIndex;
  const postings = index?.postings && typeof index.postings === "object" ? index.postings : null;
  if (tokens.length < 2 || !postings) {
    return { strategy: "scan", tokens, indexes: null, narrowed: false, reason: tokens.length < 2 ? "single-token-query" : "missing-token-index" };
  }
  const saturated = new Set(Array.isArray(index.saturated) ? index.saturated : []);
  const lists = [];
  for (const token of tokens) {
    const list = postings[token];
    if (Array.isArray(list)) {
      lists.push({ token, list });
    } else if (!saturated.has(token)) {
      return { strategy: "scan", tokens, indexes: null, narrowed: false, reason: "missing-token-posting" };
    }
  }
  if (!lists.length) {
    return { strategy: "scan", tokens, indexes: null, narrowed: false, reason: "only-saturated-tokens" };
  }
  lists.sort((left, right) => left.list.length - right.list.length);
  let indexes = lists[0].list.slice();
  for (const item of lists.slice(1)) {
    const allowed = new Set(item.list);
    indexes = indexes.filter((indexValue) => allowed.has(indexValue));
    if (!indexes.length) {
      break;
    }
  }
  return {
    strategy: "token-index",
    tokens,
    usedTokens: lists.map((item) => item.token),
    indexes,
    narrowed: true,
    reason: "intersection"
  };
}

async function writeBackgroundIndexStore(root, manifest, entries) {
  const tokenIndex = buildBackgroundSearchTokenIndex(entries);
  const searchStore = {
    version: 1,
    rootId: root.id,
    path: root.path,
    builtAt: manifest.builtAt,
    recursive: root.recursive === true,
    includeDimensions: root.includeDimensions === true,
    includeLinks: root.includeLinks === true,
    includeContent: root.includeContent === true,
    maxFolders: root.maxFolders,
    maxEntries: root.maxEntries,
    maxContentBytes: root.maxContentBytes,
    maxContentFiles: root.maxContentFiles,
    folderStamps: manifest.folders.map((folder) => ({
      path: folder.path,
      count: Number(folder.count || 0),
      modified: folder.modified ?? null
    })),
    contentIndexed: Number(manifest.contentIndexed || 0),
    contentSkipped: Number(manifest.contentSkipped || 0),
    contentBytes: Number(manifest.contentBytes || 0),
    contentTruncated: manifest.contentTruncated === true,
    folders: manifest.folders.length,
    count: entries.length,
    truncated: manifest.truncated === true,
    errors: manifest.errors,
    buildMs: manifest.buildMs,
    tokenIndex,
    entries
  };
  let text = "";
  let previousBytes = -1;
  for (let pass = 0; pass < 4; pass += 1) {
    text = JSON.stringify(searchStore, null, 2);
    const bytes = Buffer.byteLength(text);
    if (bytes === previousBytes) break;
    searchStore.bytes = bytes;
    previousBytes = bytes;
  }
  const searchFile = backgroundIndexSearchFile(root.id);
  await writeJsonAtomic(searchFile, searchStore);
  backgroundIndexSearchStoreCache.delete(searchFile);
  backgroundIndexFreshnessCache.clear();
  return writeJsonAtomic(backgroundIndexManifestFile(root.id), {
    ...manifest,
    searchFile,
    bytes: searchStore.bytes
  });
}

function backgroundContentSnippet(text, query) {
  const content = String(text || "");
  const needle = normalizeIndexQuery(query);
  if (!needle) {
    return "";
  }
  const haystack = content.toLowerCase();
  const index = haystack.indexOf(needle);
  if (index === -1) {
    return "";
  }
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + needle.length + 100);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

function backgroundContentReadConcurrency() {
  const configured = Number(process.env.EXPLORE_BETTER_CONTENT_INDEX_CONCURRENCY || 16);
  if (!Number.isFinite(configured)) {
    return 16;
  }
  return Math.max(1, Math.min(Math.round(configured), 64));
}

function summarizeNumberSamples(values = []) {
  const numbers = values.map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  if (!numbers.length) {
    return { count: 0, min: null, max: null, avg: null };
  }
  return {
    count: numbers.length,
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    avg: Math.round((numbers.reduce((sum, value) => sum + value, 0) / numbers.length) * 10) / 10
  };
}

async function backgroundIndexContentForEntry(root, entry, signal) {
  throwIfOperationCanceled(signal);
  if (!root.includeContent || !entry.isFile || !textExtensions.has(String(entry.extension || "").toLowerCase())) {
    return null;
  }
  const size = Number(entry.size || 0);
  if (!Number.isFinite(size) || size <= 0 || size > root.maxContentBytes) {
    return { skipped: true, reason: "content-too-large" };
  }
  try {
    const content = await fs.readFile(entry.path, "utf8");
    throwIfOperationCanceled(signal);
    const text = content.slice(0, root.maxContentBytes);
    return {
      indexed: true,
      bytes: Buffer.byteLength(text, "utf8"),
      text
    };
  } catch (error) {
    return { skipped: true, reason: error.code || "content-unreadable" };
  }
}

async function backgroundIndexContentForEntries(root, entries, remainingContentSlots, signal) {
  const resultByPath = new Map();
  let skipped = 0;
  let truncated = false;
  const candidates = [];
  if (!root.includeContent || remainingContentSlots <= 0) {
    return { resultByPath, indexed: 0, skipped, bytes: 0, truncated };
  }
  for (const entry of entries) {
    if (!entry.isFile || !textExtensions.has(String(entry.extension || "").toLowerCase())) {
      continue;
    }
    if (candidates.length >= remainingContentSlots) {
      skipped += 1;
      truncated = true;
      continue;
    }
    candidates.push(entry);
  }
  const concurrency = backgroundContentReadConcurrency();
  const results = await mapConcurrent(
    candidates,
    concurrency,
    (entry, index, workerSignal) => backgroundIndexContentForEntry(root, entry, workerSignal || signal),
    { signal }
  );
  let indexed = 0;
  let bytes = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const result = results[index];
    resultByPath.set(candidates[index].path, result);
    if (result?.indexed) {
      indexed += 1;
      bytes += Number(result.bytes || 0);
    } else if (result?.skipped) {
      skipped += 1;
    }
  }
  return { resultByPath, indexed, skipped, bytes, truncated, concurrency };
}

function backgroundIndexSearchEntry(root, folderPath, entry, content = null) {
  const contentText = content?.indexed ? String(content.text || "") : "";
  const searchText = [entry.searchText || "", contentText].filter(Boolean).join("\n").toLowerCase();
  return {
    rootId: root.id,
    rootName: root.name,
    rootPath: root.path,
    folderPath,
    name: entry.name,
    path: entry.path,
    parent: entry.parent,
    kind: entry.kind,
    extension: entry.extension || "",
    isDirectory: entry.isDirectory === true,
    isFile: entry.isFile === true,
    size: Number(entry.size || 0),
    modified: entry.modified || null,
    created: entry.created || null,
    accessed: entry.accessed || null,
    hidden: entry.hidden === true,
    system: entry.system === true,
    readonly: entry.readonly === true,
    archive: entry.archive === true,
    reparse: entry.reparse === true,
    compressed: entry.compressed === true,
    encrypted: entry.encrypted === true,
    labelName: entry.labelName || "",
    labelNotes: entry.labelNotes || "",
    attributeText: entry.attributeText || "",
    linkType: entry.linkType || "",
    linkTarget: entry.linkTarget || "",
    dimensions: entry.dimensions || "",
    dimensionPixels: Number(entry.dimensionPixels || 0),
    contentIndexed: content?.indexed === true,
    contentBytes: Number(content?.bytes || 0),
    contentText: contentText.toLowerCase(),
    searchText
  };
}

async function buildBackgroundIndexRoot(root, job, signal) {
  const buildStart = monotonicMs();
  const queue = [root.path];
  const visited = new Set();
  const folders = [];
  const aggregateEntries = [];
  const errors = [];
  let contentIndexed = 0;
  let contentSkipped = 0;
  let contentBytes = 0;
  let contentTruncated = false;
  let truncated = false;
  const listConcurrencySamples = [];
  const contentConcurrencySamples = [];

  while (queue.length) {
    throwIfOperationCanceled(signal);
    if (folders.length >= root.maxFolders || aggregateEntries.length >= root.maxEntries) {
      truncated = true;
      break;
    }

    const folderPath = queue.shift();
    const folderKey = pathIdentity(folderPath);
    if (visited.has(folderKey)) {
      continue;
    }
    visited.add(folderKey);

    job.progress = {
      phase: "Indexing",
      current: folderPath,
      indexedFolders: folders.length,
      indexedEntries: aggregateEntries.length,
      indexedContent: contentIndexed,
      skippedContent: contentSkipped,
      queuedFolders: queue.length,
      maxFolders: root.maxFolders,
      maxEntries: root.maxEntries,
      updatedAt: new Date().toISOString()
    };

    await waitForForegroundIdle(signal);

    let index;
    try {
      index = await buildFolderIndex(folderPath, {
        signal,
        showHidden: root.showHidden !== false,
        includeDimensions: root.includeDimensions === true,
        includeLinks: root.includeLinks === true,
        priority: "background"
      });
    } catch (error) {
      errors.push({
        path: folderPath,
        error: error.message || String(error)
      });
      if (pathIdentity(folderPath) === pathIdentity(root.path)) {
        throw error;
      }
      continue;
    }

    let folderModified = null;
    try {
      folderModified = (await fs.stat(index.path)).mtimeMs;
    } catch {}

    folders.push({
      id: index.id,
      path: index.path,
      builtAt: index.builtAt,
      count: index.count,
      modified: folderModified,
      bytes: index.bytes || 0,
      listMs: Number(index.listTiming?.totalMs || 0),
      listConcurrency: Number(index.listTiming?.concurrency || 0),
      priority: index.priority || index.listTiming?.priority || "background"
    });
    if (Number(index.listTiming?.concurrency) > 0) {
      listConcurrencySamples.push(Number(index.listTiming.concurrency));
    }

    const entries = Array.isArray(index.entries) ? index.entries : [];
    const entryCapacity = Math.max(0, root.maxEntries - aggregateEntries.length);
    const aggregateCandidates = entries.slice(0, entryCapacity);
    if (entries.length > aggregateCandidates.length) {
      truncated = true;
    }
    const contentResults = await backgroundIndexContentForEntries(
      root,
      aggregateCandidates,
      Math.max(0, root.maxContentFiles - contentIndexed),
      signal
    );
    contentIndexed += contentResults.indexed;
    contentSkipped += contentResults.skipped;
    contentBytes += contentResults.bytes;
    contentTruncated = contentTruncated || contentResults.truncated;
    if (Number(contentResults.concurrency) > 0) {
      contentConcurrencySamples.push(Number(contentResults.concurrency));
    }
    for (const entry of aggregateCandidates) {
      if (aggregateEntries.length >= root.maxEntries) {
        truncated = true;
        break;
      }
      const content = contentResults.resultByPath.get(entry.path) || null;
      aggregateEntries.push(backgroundIndexSearchEntry(root, index.path, entry, content));
      if (aggregateEntries.length % 2048 === 0) {
        await yieldToEventLoop();
        throwIfOperationCanceled(signal);
      }
    }

    if (root.recursive !== false && folders.length < root.maxFolders && aggregateEntries.length < root.maxEntries) {
      for (const entry of entries) {
        if (!entry.isDirectory || entry.linkType) {
          continue;
        }
        if (!isInsidePath(entry.path, root.path)) {
          continue;
        }
        const childKey = pathIdentity(entry.path);
        if (!visited.has(childKey)) {
          queue.push(entry.path);
        }
      }
    }
    await yieldToEventLoop();
  }

  if (queue.length) {
    truncated = true;
  }

  const builtAt = new Date().toISOString();
  const manifest = {
    version: 1,
    rootId: root.id,
    path: root.path,
    name: root.name,
    builtAt,
    recursive: root.recursive === true,
    includeDimensions: root.includeDimensions === true,
    includeLinks: root.includeLinks === true,
    includeContent: root.includeContent === true,
    priority: "background",
    listConcurrency: summarizeNumberSamples(listConcurrencySamples),
    contentConcurrency: summarizeNumberSamples(contentConcurrencySamples),
    maxFolders: root.maxFolders,
    maxEntries: root.maxEntries,
    maxContentBytes: root.maxContentBytes,
    maxContentFiles: root.maxContentFiles,
    folders,
    count: aggregateEntries.length,
    contentIndexed,
    contentSkipped,
    contentBytes,
    contentTruncated,
    truncated,
    errors: errors.slice(0, 100),
    buildMs: elapsedMs(buildStart)
  };
  await writeBackgroundIndexStore(root, manifest, aggregateEntries);
  return manifest;
}

async function updateBackgroundIndexRoot(rootId, patch) {
  return mutateState((state) => {
    const roots = Array.isArray(state.backgroundIndexes) ? state.backgroundIndexes : [];
    const index = roots.findIndex((root) => root.id === rootId);
    if (index === -1) {
      return null;
    }
    const next = sanitizeBackgroundIndexRoot({
      ...roots[index],
      ...patch,
      id: roots[index].id,
      path: roots[index].path,
      updatedAt: new Date().toISOString()
    });
    roots[index] = next;
    state.backgroundIndexes = roots;
    return next;
  });
}

async function upsertBackgroundIndexRoot(body = {}) {
  const requestedPath = String(body.path || "").trim();
  const existingId = sanitizeReferenceId(body.id);
  const now = new Date().toISOString();
  let savedRoot = null;
  const roots = await mutateState((state) => {
    const currentRoots = Array.isArray(state.backgroundIndexes) ? state.backgroundIndexes : [];
    const existing =
      (existingId && currentRoots.find((root) => root.id === existingId)) ||
      (requestedPath &&
        currentRoots.find((root) => pathIdentity(root.path) === pathIdentity(resolveUserPath(requestedPath))));
    if (!existing && !requestedPath) {
      throw new Error("Background index path is required.");
    }
    const root = sanitizeBackgroundIndexRoot({
      ...(existing || {}),
      ...body,
      id: existing?.id || existingId || undefined,
      path: requestedPath || existing?.path,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    });
    if (!root.path) {
      throw new Error("Background index path is required.");
    }
    savedRoot = root;
    state.backgroundIndexes = [
      root,
      ...currentRoots.filter((item) => item.id !== root.id && pathIdentity(item.path) !== pathIdentity(root.path))
    ].slice(0, 50);
    return state.backgroundIndexes;
  });
  return { root: savedRoot, roots };
}

async function deleteBackgroundIndexRoot(rootId) {
  const id = sanitizeReferenceId(rootId);
  if (!id) {
    throw new Error("Background index id is required.");
  }
  const job = activeBackgroundIndexJob(id);
  if (job) {
    job.controller.abort(operationCanceledError());
  }
  const roots = await mutateState((state) => {
    state.backgroundIndexes = (state.backgroundIndexes || []).filter((root) => root.id !== id);
    return state.backgroundIndexes;
  });
  closeBackgroundIndexWatcher(id);
  return { roots };
}

async function startBackgroundIndexJob(rootId) {
  const id = sanitizeReferenceId(rootId);
  if (!id) {
    throw new Error("Background index id is required.");
  }
  const state = await readState();
  const root = (state.backgroundIndexes || []).find((item) => item.id === id);
  if (!root) {
    throw new Error("Background index root not found.");
  }
  const existing = activeBackgroundIndexJob(root.id);
  if (existing) {
    return existing;
  }
  const controller = new AbortController();
  const job = {
    id: crypto.randomUUID(),
    rootId: root.id,
    path: root.path,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    progress: null,
    stats: null,
    controller
  };
  backgroundIndexJobs.set(job.id, job);
  pruneBackgroundIndexJobs();
  await updateBackgroundIndexRoot(root.id, {
    enabled: true,
    lastStartedAt: job.startedAt,
    lastError: null
  });
  buildBackgroundIndexRoot(root, job, controller.signal)
    .then(async (manifest) => {
      job.status = "complete";
      job.finishedAt = new Date().toISOString();
      job.stats = backgroundIndexStoreSummary(manifest);
      await updateBackgroundIndexRoot(root.id, {
        lastCompletedAt: job.finishedAt,
        lastError: null,
        lastStats: job.stats
      });
      await syncBackgroundIndexWatcher(root, manifest).catch(() => null);
    })
    .catch(async (error) => {
      const canceled = isOperationCanceled(error);
      job.status = canceled ? "canceled" : "error";
      job.finishedAt = new Date().toISOString();
      job.error = error.message || String(error);
      if (!canceled) {
        await updateBackgroundIndexRoot(root.id, {
          lastError: job.error
        }).catch(() => {});
      }
    });
  return job;
}

async function stopBackgroundIndexJob(rootId) {
  const id = sanitizeReferenceId(rootId);
  const job = id ? activeBackgroundIndexJob(id) : null;
  if (!job) {
    return { stopped: false, job: null };
  }
  job.controller.abort(operationCanceledError());
  return { stopped: true, job: backgroundIndexJobSnapshot(job) };
}

function backgroundIndexWatcherEnabled(root) {
  return Boolean(root?.path && root.enabled !== false && root.watch !== false && root.autoRebuild !== false);
}

function closeBackgroundIndexWatcher(rootId) {
  const id = sanitizeReferenceId(rootId);
  const record = id ? backgroundIndexWatchers.get(id) : null;
  if (!record) {
    return;
  }
  if (record.timer) {
    clearTimeout(record.timer);
  }
  if (record.cooldownTimer) {
    clearTimeout(record.cooldownTimer);
  }
  for (const item of record.watchers || []) {
    try {
      item.watcher?.close?.();
    } catch {}
  }
  backgroundIndexWatchers.delete(id);
}

function closeRemovedBackgroundIndexWatchers(roots = []) {
  const active = new Set(
    (Array.isArray(roots) ? roots : []).filter(backgroundIndexWatcherEnabled).map((root) => root.id)
  );
  for (const rootId of backgroundIndexWatchers.keys()) {
    if (!active.has(rootId)) {
      closeBackgroundIndexWatcher(rootId);
    }
  }
}

function backgroundIndexWatcherSnapshot(rootId) {
  const record = backgroundIndexWatchers.get(sanitizeReferenceId(rootId));
  return record
    ? {
        enabled: true,
        available: record.watchers.length > 0,
        rootId: record.rootId,
        path: record.path,
        watchedFolders: record.watchers.length,
        folderLimit: record.folderLimit,
        debounceMs: record.debounceMs,
        version: record.version,
        eventCount: record.eventCount,
        changedAt: record.changedAtMs ? new Date(record.changedAtMs).toISOString() : null,
        lastQueuedAt: record.lastQueuedAt || null,
        lastEventPath: record.lastEventPath || null,
        lastAutoRebuild: record.lastAutoRebuild || null,
        lastSkippedAutoRebuild: record.lastSkippedAutoRebuild || null,
        error: record.error || null
      }
    : null;
}

function backgroundIndexWatchFolders(root, manifest = null) {
  const folderLimit = backgroundIndexWatchFolderLimit();
  const seen = new Set();
  const folders = [];
  const sourceFolders = Array.isArray(manifest?.folders) && manifest.folders.length ? manifest.folders : [{ path: root.path }];
  for (const folder of sourceFolders) {
    const folderPath = String(folder?.path || "").trim();
    if (!folderPath) {
      continue;
    }
    const resolved = resolveUserPath(folderPath);
    const key = pathIdentity(resolved);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    folders.push(resolved);
    if (folders.length >= folderLimit) {
      break;
    }
  }
  return { folders, folderLimit };
}

function backgroundIndexWatcherSignature(root, folders) {
  return [
    root.id,
    pathIdentity(root.path),
    root.enabled !== false ? "1" : "0",
    root.watch !== false ? "1" : "0",
    root.autoRebuild !== false ? "1" : "0",
    folders.map(pathIdentity).join("|")
  ].join("::");
}

function scheduleBackgroundIndexWatchRebuild(record) {
  if (record.timer) {
    clearTimeout(record.timer);
  }
  record.timer = setTimeout(() => {
    record.timer = null;
    runBackgroundIndexWatchRebuild(record).catch((error) => {
      record.error = error.message || String(error);
    });
  }, record.debounceMs);
  record.timer.unref?.();
}

async function runBackgroundIndexWatchRebuild(record) {
  const state = await readState();
  const root = (state.backgroundIndexes || []).find((item) => item.id === record.rootId);
  if (!backgroundIndexWatcherEnabled(root)) {
    closeBackgroundIndexWatcher(record.rootId);
    return;
  }
  const freshness = freshnessStatus("stale", {
    reason: "watch-event",
    path: record.lastEventPath || root.path,
    watchVersion: record.version,
    watchedFolders: record.watchers.length
  });
  record.lastQueuedAt = new Date().toISOString();
  const result = await maybeAutoRebuildBackgroundIndex(root, freshness, "watch");
  if (result?.scheduled || result?.active || result?.job) {
    record.lastAutoRebuild = result;
    record.lastSkippedAutoRebuild = null;
  } else {
    record.lastSkippedAutoRebuild = result;
  }
  record.error = result?.error || null;
}

function createBackgroundIndexWatcher(root, folders, folderLimit) {
  const debounceMs = backgroundIndexWatchDebounceMs();
  const record = {
    rootId: root.id,
    path: root.path,
    signature: backgroundIndexWatcherSignature(root, folders),
    folderLimit,
    debounceMs,
    version: 0,
    eventCount: 0,
    changedAtMs: null,
    lastQueuedAt: null,
    lastEventPath: null,
    lastAutoRebuild: null,
    lastSkippedAutoRebuild: null,
    error: null,
    timer: null,
    cooldownTimer: null,
    watchers: []
  };
  for (const folderPath of folders) {
    try {
      const watcher = watch(folderPath, { persistent: false }, (_eventType, filename) => {
        record.version += 1;
        record.eventCount += 1;
        record.changedAtMs = Date.now();
        record.lastEventPath = filename ? path.join(folderPath, String(filename)) : folderPath;
        backgroundIndexFreshnessCache.clear();
        scheduleBackgroundIndexWatchRebuild(record);
      });
      watcher.on("error", (error) => {
        record.error = error.message || String(error);
      });
      watcher.unref?.();
      record.watchers.push({ path: folderPath, watcher });
    } catch (error) {
      record.error = error.message || String(error);
    }
  }
  backgroundIndexWatchers.set(root.id, record);
  return record;
}

async function syncBackgroundIndexWatcher(root, manifest = null) {
  if (!backgroundIndexWatcherEnabled(root)) {
    closeBackgroundIndexWatcher(root?.id);
    return { enabled: false, available: false, reason: "disabled" };
  }
  try {
    await fs.access(root.path);
  } catch (error) {
    closeBackgroundIndexWatcher(root.id);
    return {
      enabled: true,
      available: false,
      reason: "root-unavailable",
      error: error.code || error.message || "unavailable"
    };
  }
  const resolvedManifest = manifest || (await readBackgroundIndexManifest(root.id).catch(() => null));
  const { folders, folderLimit } = backgroundIndexWatchFolders(root, resolvedManifest);
  const signature = backgroundIndexWatcherSignature(root, folders);
  const existing = backgroundIndexWatchers.get(root.id);
  if (existing?.signature === signature) {
    return backgroundIndexWatcherSnapshot(root.id);
  }
  closeBackgroundIndexWatcher(root.id);
  createBackgroundIndexWatcher(root, folders, folderLimit);
  return backgroundIndexWatcherSnapshot(root.id);
}

async function syncBackgroundIndexWatchersFromState() {
  const state = await readState();
  const roots = state.backgroundIndexes || [];
  closeRemovedBackgroundIndexWatchers(roots);
  await Promise.all(roots.map((root) => syncBackgroundIndexWatcher(root).catch(() => null)));
}

async function maybeAutoRebuildBackgroundIndex(root, freshness, source) {
  if (!root || !freshness?.stale) {
    return null;
  }
  const reason = freshness.reason || "stale";
  if (root.enabled === false) {
    return { scheduled: false, skipped: "disabled", reason };
  }
  if (root.autoRebuild === false) {
    return { scheduled: false, skipped: "auto-rebuild-disabled", reason };
  }
  if (reason === "root-unavailable") {
    return { scheduled: false, skipped: "root-unavailable", reason };
  }
  const active = activeBackgroundIndexJob(root.id);
  if (active) {
    return { scheduled: false, active: true, source, reason, job: backgroundIndexJobSnapshot(active) };
  }
  const now = Date.now();
  const cooldownMs = backgroundIndexAutoRebuildCooldownMs();
  const previous = backgroundIndexAutoRebuilds.get(root.id);
  if (previous && now - previous.startedAtMs < cooldownMs) {
    return {
      scheduled: false,
      skipped: "cooldown",
      source,
      reason,
      cooldownMs,
      retryAfterMs: Math.max(0, cooldownMs - (now - previous.startedAtMs))
    };
  }

  backgroundIndexAutoRebuilds.set(root.id, { startedAtMs: now, reason, source });
  const queuedAt = new Date(now).toISOString();
  await updateBackgroundIndexRoot(root.id, {
    lastAutoRebuildAt: queuedAt,
    lastAutoRebuildReason: reason,
    lastError: null
  }).catch(() => null);

  try {
    const job = await startBackgroundIndexJob(root.id);
    return {
      scheduled: true,
      source,
      reason,
      queuedAt,
      cooldownMs,
      job: backgroundIndexJobSnapshot(job)
    };
  } catch (error) {
    const message = error.message || String(error);
    backgroundIndexAutoRebuilds.set(root.id, { startedAtMs: now, reason, source, error: message });
    await updateBackgroundIndexRoot(root.id, {
      lastError: message
    }).catch(() => null);
    return {
      scheduled: false,
      source,
      reason,
      error: message
    };
  }
}

async function backgroundIndexOverview() {
  const state = await readState();
  closeRemovedBackgroundIndexWatchers(state.backgroundIndexes || []);
  const roots = await Promise.all(
    (state.backgroundIndexes || []).map(async (root) => {
      const manifestRead = await readBackgroundIndexManifestResult(root.id);
      const searchRead = await readBackgroundIndexSearchStoreResult(root.id);
      const manifest = manifestRead.data;
      const store = searchRead.data;
      const watcher = await syncBackgroundIndexWatcher(root, manifest).catch((error) => ({
        enabled: backgroundIndexWatcherEnabled(root),
        available: false,
        error: error.message || String(error)
      }));
      const readFreshness = backgroundIndexReadFreshness(root, manifest, searchRead);
      const freshness = readFreshness || (store ? await backgroundIndexFreshness(root, store, manifest) : null);
      const autoRebuild = await maybeAutoRebuildBackgroundIndex(root, freshness, "overview");
      return {
        ...root,
        manifest: manifest ? backgroundIndexStoreSummary(manifest) : null,
        search: store ? backgroundIndexStoreSummary(store) : null,
        indexRead: backgroundIndexReadSummary(manifestRead, searchRead),
        watcher,
        freshness: freshness
          ? {
              ...freshness,
              autoRebuild: autoRebuild || undefined
            }
          : freshness,
        autoRebuild,
        job: backgroundIndexJobSnapshot(activeBackgroundIndexJob(root.id))
      };
    })
  );
  return {
    roots,
    jobs: [...backgroundIndexJobs.values()].map(backgroundIndexJobSnapshot),
    cacheRoot: indexRoot
  };
}

async function searchBackgroundIndexes({ query, limit = 200, rootId = "", rootPath = "", ...filters } = {}) {
  const searchStart = monotonicMs();
  const q = normalizeIndexQuery(query);
  const max = Math.max(1, Math.min(Number(limit || 200), 2000));
  const state = await readState();
  const wantedRootId = sanitizeReferenceId(rootId);
  const wantedRootPathText = String(rootPath || filters.path || "").trim();
  const wantedRootPath = wantedRootPathText ? resolveUserPath(wantedRootPathText) : "";
  const kind = String(filters.kind || "all");
  const criteria = normalizeSearchCriteria(filters);
  const includeHidden = Boolean(filters.includeHidden === true || filters.includeHidden === "true" || filters.includeHidden === "1");
  const roots = (state.backgroundIndexes || []).filter(
    (root) =>
      root.enabled !== false &&
      (!wantedRootId || root.id === wantedRootId) &&
      (!wantedRootPath || isInsidePath(root.path, wantedRootPath) || isInsidePath(wantedRootPath, root.path))
  );
  const results = [];
  const freshnessReports = [];
  let scanned = 0;
  let candidateEntries = 0;
  let tokenIndexedStores = 0;
  let tokenNarrowedStores = 0;
  let storeCacheHits = 0;
  let storeCacheMisses = 0;
  let stores = 0;
  let truncated = false;
  for (const root of roots) {
    const searchRead = await readBackgroundIndexSearchStoreResult(root.id);
    if (searchRead.cache?.hit) {
      storeCacheHits += 1;
    } else {
      storeCacheMisses += 1;
    }
    const store = searchRead.data;
    const manifestRead = await readBackgroundIndexManifestResult(root.id);
    const manifest = manifestRead.data;
    const readFreshness = backgroundIndexReadFreshness(root, manifest, searchRead);
    if (readFreshness) {
      const autoRebuild = await maybeAutoRebuildBackgroundIndex(root, readFreshness, "search");
      freshnessReports.push({
        rootId: root.id,
        rootName: root.name,
        rootPath: root.path,
        autoRebuild,
        read: backgroundIndexReadSummary(manifestRead, searchRead),
        ...readFreshness
      });
    }
    if (!store || !Array.isArray(store.entries)) {
      continue;
    }
    const freshness = await backgroundIndexFreshness(root, store, manifest);
    const autoRebuild = await maybeAutoRebuildBackgroundIndex(root, freshness, "search");
    freshnessReports.push({
      rootId: root.id,
      rootName: root.name,
      rootPath: root.path,
      autoRebuild,
      read: backgroundIndexReadSummary(manifestRead, searchRead),
      ...freshness
    });
    stores += 1;
    const entries = Array.isArray(store.entries) ? store.entries : [];
    const candidatePlan = backgroundSearchCandidatePlan(store, q);
    if (store.tokenIndex?.version === 1) {
      tokenIndexedStores += 1;
    }
    if (candidatePlan.narrowed) {
      tokenNarrowedStores += 1;
    }
    const candidateIndexes = Array.isArray(candidatePlan.indexes) ? candidatePlan.indexes : null;
    const candidates = candidateIndexes
      ? candidateIndexes
          .map((indexValue) => entries[Number(indexValue)])
          .filter(Boolean)
      : entries;
    candidateEntries += candidates.length;
    for (const entry of candidates) {
      scanned += 1;
      if (wantedRootPath && !isInsidePath(entry.path, wantedRootPath)) {
        continue;
      }
      if (!includeHidden && !visibleByHiddenSetting(entry, false)) {
        continue;
      }
      if (!searchKindMatches(entry, kind) || !searchCriteriaMatches(entry, criteria)) {
        continue;
      }
      const searchable = String(entry.searchText || entry.name || "");
      if (!q || searchable.includes(q)) {
        const contentHit = Boolean(q && entry.contentIndexed && String(entry.contentText || "").includes(q));
        results.push({
          rootId: root.id,
          rootName: root.name,
          rootPath: root.path,
          name: entry.name,
          path: entry.path,
          parent: entry.parent,
          kind: entry.kind,
          extension: entry.extension,
          isDirectory: entry.isDirectory,
          isFile: entry.isFile,
          size: entry.size,
          modified: entry.modified,
          created: entry.created,
          accessed: entry.accessed,
          hidden: entry.hidden === true,
          system: entry.system === true,
          readonly: entry.readonly === true,
          archive: entry.archive === true,
          reparse: entry.reparse === true,
          compressed: entry.compressed === true,
          encrypted: entry.encrypted === true,
          attributeText: entry.attributeText || "",
          dimensions: entry.dimensions || "",
          dimensionPixels: entry.dimensionPixels || 0,
          contentIndexed: entry.contentIndexed === true,
          matchSource: contentHit ? "content" : "metadata",
          matchSnippet: contentHit ? backgroundContentSnippet(entry.contentText, q) : "",
          labelName: entry.labelName,
          labelNotes: entry.labelNotes
        });
      }
      if (results.length >= max) {
        truncated = true;
        break;
      }
    }
    if (results.length >= max) {
      truncated = true;
      break;
    }
  }
  return {
    indexed: stores > 0,
    query: q,
    root: wantedRootPath || "",
    kind,
    criteria,
    criteriaSummary: criteria.labels.join(" / "),
    roots: roots.length,
    stores,
    freshness: {
      stale: freshnessReports.some((item) => item.stale),
      staleRoots: freshnessReports.filter((item) => item.stale).length,
      autoRebuilds: freshnessReports.filter((item) => item.autoRebuild?.scheduled).length,
      activeRebuilds: freshnessReports.filter((item) => item.autoRebuild?.active || item.autoRebuild?.job?.status === "running").length,
      roots: freshnessReports
    },
    truncated,
    results,
    timing: {
      searchMs: elapsedMs(searchStart),
      scanned,
      candidateEntries,
      tokenIndexedStores,
      tokenNarrowedStores,
      storeCacheHits,
      storeCacheMisses,
      returned: results.length
    }
  };
}

async function directorySignature(targetPath, options = {}) {
  const { signal = null } = options;
  const includeDimensions = options.includeDimensions === true;
  const includeLinks = options.includeLinks === true;
  const showHidden = options.showHidden !== false;
  const includeAttributes = options.includeAttributes === true || !showHidden;
  throwIfAborted(signal);
  const dir = resolveUserPath(targetPath);
  const limit = Math.max(50, Math.min(Number(options.limit || 1500), 5000));
  const [attributeMap, rawDirents] = await Promise.all([
    optionalWindowsAttributeMap(dir, includeAttributes),
    fs.readdir(dir, { withFileTypes: true })
  ]);
  throwIfAborted(signal);
  const dirents = rawDirents.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" })
  );
  const entries = [];
  const statResults = await mapConcurrent(dirents.slice(0, limit), listStatConcurrency(), async (dirent, index, workerSignal) => {
    let entry;
    try {
      entry = await statEntry(dir, dirent, attributeMap, {
        signal: workerSignal,
        includeDimensions,
        includeLinks,
        includeAttributes
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      entry = unavailableEntry(dir, dirent, attributeMap);
    }
    return entry;
  }, { signal });

  throwIfAborted(signal);

  for (const entry of statResults) {
    throwIfAborted(signal);
    if (visibleByHiddenSetting(entry, showHidden)) {
      entries.push(entry);
    }
  }
  return {
    path: dir,
    checkedAt: new Date().toISOString(),
    ...folderSignatureFromEntries(entries, { truncated: dirents.length > limit }),
    includeDimensions,
    includeLinks,
    includeAttributes,
    totalEntries: dirents.length
  };
}

function closeFolderWatcher(key) {
  const record = folderWatchers.get(key);
  if (!record) {
    return;
  }
  try {
    record.watcher?.close?.();
  } catch {}
  folderWatchers.delete(key);
  dropDirectoryListingCacheForWatchKey(key);
}

function pruneFolderWatchers() {
  const now = Date.now();
  for (const [key, record] of folderWatchers) {
    if (now - Number(record.lastAccess || 0) > folderWatcherTtlMs) {
      closeFolderWatcher(key);
    }
  }
  while (folderWatchers.size > folderWatcherMaxEntries) {
    const oldest = [...folderWatchers.entries()].sort(
      (left, right) => Number(left[1].lastAccess || 0) - Number(right[1].lastAccess || 0)
    )[0]?.[0];
    if (!oldest) {
      break;
    }
    closeFolderWatcher(oldest);
  }
}

function createFolderWatcher(dir, key) {
  const record = {
    key,
    path: dir,
    version: 0,
    changedAt: null,
    lastAccess: Date.now(),
    error: null,
    watcher: null
  };
  try {
    const watcher = watch(dir, { persistent: false }, () => {
      record.version += 1;
      record.changedAt = Date.now();
      dropDirectoryListingInFlightForWatchKey(key);
    });
    watcher.on("error", (error) => {
      record.error = error.message;
      record.version += 1;
      record.changedAt = Date.now();
      dropDirectoryListingInFlightForWatchKey(key);
    });
    watcher.unref?.();
    record.watcher = watcher;
  } catch (error) {
    record.error = error.message;
  }
  folderWatchers.set(key, record);
  pruneFolderWatchers();
  return record;
}

async function folderWatchStatus(targetPath, options = {}) {
  const requested = resolveUserPath(targetPath);
  const stats = await fs.stat(requested);
  const dir = stats.isDirectory() ? requested : path.dirname(requested);
  const key = pathIdentity(dir);
  let record = folderWatchers.get(key);
  if (!record) {
    record = createFolderWatcher(dir, key);
  }
  record.lastAccess = Date.now();
  pruneFolderWatchers();
  const since = Number(options.since);
  const hasSince = Number.isFinite(since) && since >= 0;
  return {
    path: dir,
    available: Boolean(record.watcher && !record.error),
    version: record.version,
    changed: hasSince ? record.version > since : false,
    changedAt: record.changedAt ? new Date(record.changedAt).toISOString() : null,
    error: record.error || null,
    watcherCount: folderWatchers.size
  };
}

async function directoryHasChildDirectory(dirPath, signal = null) {
  try {
    throwIfAborted(signal);
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    throwIfAborted(signal);
    return dirents.some((dirent) => dirent.isDirectory());
  } catch {
    throwIfAborted(signal);
    return false;
  }
}

async function listTreeChildren(targetPath, options = {}) {
  const { signal = null } = options;
  const includeStats = options.includeStats !== false;
  const includeChildState = options.includeChildState !== false;
  throwIfAborted(signal);
  const dir = resolveUserPath(targetPath);
  const limit = Math.max(1, Math.min(Number(options.limit || 80), 200));
  const showHidden = options.showHidden !== false;
  const includeAttributes = options.includeAttributes === true || !showHidden;
  const [attributeMap, dirents] = await Promise.all([
    optionalWindowsAttributeMap(dir, includeAttributes),
    fs.readdir(dir, { withFileTypes: true })
  ]);
  throwIfAborted(signal);
  const directoryDirents = dirents
    .filter((dirent) => dirent.isDirectory())
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true })
    );
  const directories = [];
  let skipped = 0;

  const childResults = await mapConcurrent(directoryDirents.slice(0, limit), Math.min(listStatConcurrency(), 16), async (dirent, index, workerSignal) => {
    const childPath = path.join(dir, dirent.name);
    try {
      throwIfAborted(workerSignal);
      const stats = includeStats ? await fs.stat(childPath) : null;
      throwIfAborted(workerSignal);
      const attributes = attributesForEntry(
        dirent.name,
        stats,
        includeAttributes ? attributeMap.get(pathIdentity(childPath)) : ""
      );
      const entry = {
        name: dirent.name,
        path: childPath,
        parent: dir,
        kind: "folder",
        modified: stats?.mtimeMs ?? null,
        attributes,
        readonly: attributes.readonly,
        hidden: attributes.hidden,
        system: attributes.system,
        archive: attributes.archive,
        attributeText: attributes.text
      };
      if (includeChildState) {
        entry.hasChildren = await directoryHasChildDirectory(childPath, workerSignal);
      }
      return { entry };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return { skipped: true };
    }
  }, { signal });

  throwIfAborted(signal);

  for (const result of childResults) {
    throwIfAborted(signal);
    if (result?.entry && visibleByHiddenSetting(result.entry, showHidden)) {
      directories.push(result.entry);
    } else {
      skipped += 1;
    }
  }

  return {
    path: dir,
    name: isRoot(dir) ? dir : path.basename(dir),
    parent: isRoot(dir) ? null : path.dirname(dir),
    entries: directories,
    skipped,
    showHidden,
    includeStats,
    includeChildState,
    includeAttributes,
    truncated: directoryDirents.length > limit
  };
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function driveSpaceForPath(rootPath) {
  try {
    const stats = await fs.statfs(rootPath);
    const blockSize = Number(stats.bsize || 0);
    const totalBytes = Math.max(0, Number(stats.blocks || 0) * blockSize);
    const freeBytes = Math.max(0, Number(stats.bavail ?? stats.bfree ?? 0) * blockSize);
    if (!totalBytes || !Number.isFinite(totalBytes) || !Number.isFinite(freeBytes)) {
      return { available: false };
    }
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      available: true,
      freeBytes,
      usedBytes,
      totalBytes,
      freePercent: Math.max(0, Math.min(100, (freeBytes / totalBytes) * 100)),
      usedPercent: Math.max(0, Math.min(100, (usedBytes / totalBytes) * 100))
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

function diagnosticTimeoutMs(value, fallback = 3500) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(250, Math.min(Math.round(numeric), 15000));
}

function diagnosticError(stage, error, ms = 0) {
  return {
    stage,
    code: error?.code || error?.name || "ERROR",
    message: error?.message || String(error || "Unknown error"),
    ms
  };
}

async function timedDiagnosticStep(stage, timeoutMs, task) {
  const started = monotonicMs();
  let timer = null;
  try {
    const result = await Promise.race([
      task(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${stage} timed out after ${timeoutMs}ms`);
          error.code = "ETIMEDOUT";
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
    return { ok: true, result, ms: elapsedMs(started) };
  } catch (error) {
    const ms = elapsedMs(started);
    return { ok: false, error: diagnosticError(stage, error, ms), ms };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function describeUserPath(value) {
  const requested = value === null || value === undefined || value === "" ? "~" : String(value);
  const resolveStart = monotonicMs();
  const resolved = resolveUserPath(requested);
  const normalized = path.normalize(resolved);
  const plain = denamespaceWindowsPath(normalized);
  const root = denamespaceWindowsPath(path.parse(plain).root || "");
  const uncMatch = plain.match(/^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/);
  const driveMatch = plain.match(/^([A-Za-z]):[\\/]/);
  const kind = uncMatch ? "unc" : driveMatch ? "drive" : path.isAbsolute(plain) ? "absolute" : "relative";
  const isRootPath = path.dirname(plain) === plain;
  return {
    requested,
    resolved,
    normalized,
    plain,
    kind,
    root,
    server: uncMatch?.[1] || null,
    share: uncMatch?.[2] || null,
    driveLetter: driveMatch?.[1]?.toUpperCase() || null,
    isNetwork: Boolean(uncMatch),
    isRoot: isRootPath,
    name: isRootPath ? plain : path.basename(plain),
    parent: isRootPath ? null : path.dirname(plain),
    timings: {
      resolveMs: elapsedMs(resolveStart)
    }
  };
}

function entrySampleKind(dirent) {
  if (dirent.isDirectory()) return "folder";
  if (dirent.isFile()) return "file";
  if (dirent.isSymbolicLink()) return "link";
  return "other";
}

function processOutputPreview(result) {
  return `${result?.stdout || ""}\n${result?.stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(" | ");
}

async function mappedDriveInfoForRoot(rootPath) {
  const driveMatch = String(rootPath || "").match(/^([A-Za-z]):\\?$/);
  if (process.platform !== "win32" || !driveMatch) {
    return null;
  }
  const drive = driveMatch[1].toUpperCase();
  const result = await runProcess("cmd.exe", ["/d", "/s", "/c", `net use ${drive}:`], { timeoutMs: 1500 });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const remoteMatch = output.match(/Remote name\s+(.+)/i);
  if (remoteMatch) {
    return {
      available: true,
      mapped: true,
      drive,
      remote: remoteMatch[1].trim(),
      isNetwork: true
    };
  }
  if (result.timedOut) {
    return {
      available: false,
      mapped: false,
      drive,
      timedOut: true,
      error: "Mapped drive check timed out."
    };
  }
  if (/network connection could not be found|there are no entries|not currently connected/i.test(output)) {
    return {
      available: true,
      mapped: false,
      drive,
      isNetwork: false
    };
  }
  return {
    available: result.code === 0,
    mapped: false,
    drive,
    isNetwork: false,
    code: result.code,
    error: result.code === 0 ? null : processOutputPreview(result)
  };
}

function probeFolderWatch(targetDir) {
  return new Promise((resolve, reject) => {
    let watcher = null;
    try {
      watcher = watch(targetDir, { persistent: false }, () => {});
      watcher.once("error", reject);
      setImmediate(() => {
        try {
          watcher.close();
        } catch {}
        resolve({ available: true });
      });
    } catch (error) {
      reject(error);
    }
  });
}

function addPathDiagnosticRecommendations(report) {
  const messages = [];
  const statError = report.errors.find((item) => item.stage === "stat");
  const readError = report.errors.find((item) => item.stage === "readDir");
  if (!report.check) {
    messages.push("Parse-only mode classified the path without touching the filesystem.");
  }
  if (report.isNetwork) {
    messages.push("Network path detected; build a Speed or Background Index when this location is used repeatedly.");
  }
  if (statError?.code === "ETIMEDOUT") {
    messages.push("The target did not answer before the diagnostic timeout; check VPN, server wake state, DNS, and credentials.");
  }
  if (statError && ["ENOENT", "ENOTDIR"].includes(statError.code)) {
    messages.push("The target path does not currently exist from this machine.");
  }
  if (statError && ["EACCES", "EPERM"].includes(statError.code)) {
    messages.push("Windows denied access; use native Properties/security settings or retry operations through the elevated helper where supported.");
  }
  if (readError) {
    messages.push("The target exists but could not be enumerated, so listing and search will be unavailable until the directory read succeeds.");
  }
  if (Number(report.timings?.readDirMs) > 1000 || Number(report.timings?.statMs) > 1000) {
    messages.push("This path is slow enough to benefit from warm indexes, reduced optional metadata columns, and background indexing.");
  }
  if (report.watch && report.watch.available === false) {
    messages.push("Directory watching is unavailable here; Auto Refresh will fall back to bounded signature checks.");
  }
  if (!messages.length) {
    messages.push("Path health looks normal.");
  }
  report.recommendations = [...new Set(messages)];
  return report;
}

async function diagnosePath(targetPath, options = {}) {
  const totalStart = monotonicMs();
  const timeoutMs = diagnosticTimeoutMs(options.timeoutMs);
  const sampleLimit = Math.max(1, Math.min(Number(options.sampleLimit || 20), 100));
  const check = options.check !== false;
  const report = {
    ...describeUserPath(targetPath),
    check,
    timeoutMs,
    exists: false,
    reachable: false,
    readable: false,
    targetKind: "unknown",
    isDirectory: false,
    isFile: false,
    selectedPath: null,
    directory: null,
    size: null,
    modified: null,
    created: null,
    entryCount: null,
    sample: [],
    sampleTruncated: false,
    space: null,
    watch: null,
    mappedDrive: null,
    errors: [],
    recommendations: []
  };

  const mappedStart = monotonicMs();
  report.mappedDrive = await mappedDriveInfoForRoot(report.root);
  report.timings.mappedDriveMs = elapsedMs(mappedStart);
  if (report.mappedDrive?.isNetwork) {
    report.isNetwork = true;
  }

  if (!check) {
    report.timings.totalMs = elapsedMs(totalStart);
    return addPathDiagnosticRecommendations(report);
  }

  const statStep = await timedDiagnosticStep("stat", timeoutMs, () => fs.stat(report.resolved));
  report.timings.statMs = statStep.ms;
  if (!statStep.ok) {
    report.errors.push(statStep.error);
    report.timings.totalMs = elapsedMs(totalStart);
    return addPathDiagnosticRecommendations(report);
  }

  const stats = statStep.result;
  report.exists = true;
  report.reachable = true;
  report.isDirectory = stats.isDirectory();
  report.isFile = stats.isFile();
  report.targetKind = report.isDirectory ? "directory" : report.isFile ? "file" : "other";
  report.selectedPath = report.isDirectory ? null : report.resolved;
  report.directory = report.isDirectory ? report.resolved : path.dirname(report.resolved);
  report.size = report.isFile ? stats.size : null;
  report.modified = stats.mtimeMs;
  report.created = stats.birthtimeMs;

  if (report.isDirectory) {
    const readStep = await timedDiagnosticStep("readDir", timeoutMs, () => fs.readdir(report.directory, { withFileTypes: true }));
    report.timings.readDirMs = readStep.ms;
    if (readStep.ok) {
      const dirents = readStep.result;
      report.readable = true;
      report.entryCount = dirents.length;
      report.sample = dirents.slice(0, sampleLimit).map((dirent) => ({
        name: dirent.name,
        kind: entrySampleKind(dirent)
      }));
      report.sampleTruncated = dirents.length > sampleLimit;
    } else {
      report.errors.push(readStep.error);
    }
  }

  if (report.root) {
    const spaceStep = await timedDiagnosticStep("statfs", Math.min(timeoutMs, 2500), () => driveSpaceForPath(report.root));
    report.timings.statfsMs = spaceStep.ms;
    if (spaceStep.ok) {
      report.space = spaceStep.result;
    } else {
      report.space = { available: false, error: spaceStep.error.message };
      report.errors.push(spaceStep.error);
    }
  }

  if (report.isDirectory && options.watch !== false) {
    const watchStep = await timedDiagnosticStep("watch", Math.min(timeoutMs, 1000), () => probeFolderWatch(report.directory));
    report.timings.watchMs = watchStep.ms;
    if (watchStep.ok) {
      report.watch = watchStep.result;
    } else {
      report.watch = { available: false, error: watchStep.error.message, code: watchStep.error.code };
    }
  }

  report.timings.totalMs = elapsedMs(totalStart);
  return addPathDiagnosticRecommendations(report);
}

async function uniquePath(parent, basename) {
  const parsed = path.parse(basename);
  let candidate = path.join(parent, basename);
  let index = 2;
  while (await pathExists(candidate)) {
    const suffix = parsed.ext
      ? `${parsed.name} copy ${index}${parsed.ext}`
      : `${basename} copy ${index}`;
    candidate = path.join(parent, suffix);
    index += 1;
  }
  return candidate;
}

function existingTargetError(dest) {
  const error = new Error(`Target already exists: ${dest}`);
  error.code = "EEXIST";
  return error;
}

async function scanCopyFootprint(itemPath, hooks = {}) {
  throwIfOperationCanceled(hooks.signal);
  await hooks.waitIfPaused?.();
  const stats = await fs.lstat(itemPath);
  if (stats.isFile()) {
    return { files: 1, bytes: stats.size };
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return { files: 0, bytes: 0 };
  }
  let files = 0;
  let bytes = 0;
  const entries = await fs.readdir(itemPath, { withFileTypes: true });
  for (const entry of entries) {
    const child = await scanCopyFootprint(path.join(itemPath, entry.name), hooks);
    files += child.files;
    bytes += child.bytes;
  }
  return { files, bytes };
}

async function scanCopyFootprints(paths, hooks = {}, onItem = null) {
  const total = { files: 0, bytes: 0 };
  for (const [index, itemPath] of paths.entries()) {
    onItem?.(itemPath, index);
    const footprint = await scanCopyFootprint(itemPath, hooks);
    total.files += footprint.files;
    total.bytes += footprint.bytes;
  }
  return total;
}

function recoveryListItem(itemPath, index, extra = {}) {
  const resolved = resolveUserPath(itemPath);
  return {
    index,
    path: resolved,
    name: labelFromPath(resolved),
    ...extra
  };
}

function operationRecoveryDetails({ type, body = {}, resolvedSources = [], completedItems = [], failedIndex = 0, error, result = {} }) {
  const paths = resolvedSources.map((itemPath) => resolveUserPath(itemPath));
  const numericFailedIndex = Number(failedIndex);
  const processedCount = Array.isArray(completedItems) ? completedItems.length : 0;
  const safeFailedIndex = paths.length
    ? Math.min(
        Math.max(processedCount, Math.min(Number.isFinite(numericFailedIndex) ? numericFailedIndex : 0, paths.length)),
        paths.length
      )
    : 0;
  const remainingPaths = paths.slice(safeFailedIndex);
  const retry = retryRequestForOperation(type, { ...body, paths: remainingPaths });
  const failedPath = remainingPaths[0] || null;
  const completed = completedItems.map((item, index) =>
    recoveryListItem(item.source || item.path || item.dest || "", index, {
      dest: item.dest || null
    })
  );

  return {
    ...result,
    error: error?.message || "Operation failed.",
    recovery: {
      type,
      targetDir: body.targetDir ? resolveUserPath(body.targetDir) : null,
      completedCount: completed.length,
      remainingCount: remainingPaths.length,
      completed,
      failed: failedPath
        ? recoveryListItem(failedPath, safeFailedIndex, {
            reason: error?.code || error?.message || "failed"
          })
        : null,
      remaining: remainingPaths.map((itemPath, offset) =>
        recoveryListItem(itemPath, safeFailedIndex + offset)
      ),
      retry,
      canRetryRemaining: Boolean(retry)
    }
  };
}

function syncOperationRecoveryDetails({ body = {}, tasks = [], completedItems = [], failedIndex = 0, error, result = {} }) {
  const numericFailedIndex = Number(failedIndex);
  const processedCount = Array.isArray(completedItems) ? completedItems.length : 0;
  const safeFailedIndex = tasks.length
    ? Math.min(
        Math.max(processedCount, Math.min(Number.isFinite(numericFailedIndex) ? numericFailedIndex : 0, tasks.length)),
        tasks.length
      )
    : 0;
  const remainingTasks = tasks.slice(safeFailedIndex);
  const retryItems = remainingTasks.map((task) => task.relativePath).filter(Boolean);
  const retry = retryRequestForOperation("sync", { ...body, items: retryItems });
  const failedTask = remainingTasks[0] || null;
  const completed = completedItems
    .filter((item) => !item.skipped)
    .map((item, index) =>
      recoveryListItem(item.source || item.dest || "", index, {
        dest: item.dest || null,
        relativePath: item.relativePath || normalizeRelativePath(path.basename(item.dest || item.source || ""))
      })
    );

  return {
    ...result,
    error: error?.message || "Sync failed.",
    recovery: {
      type: "sync",
      direction: body.direction === "rightToLeft" ? "rightToLeft" : "leftToRight",
      targetDir: null,
      completedCount: completed.length,
      remainingCount: remainingTasks.length,
      completed,
      failed: failedTask
        ? recoveryListItem(failedTask.source, safeFailedIndex, {
            dest: failedTask.dest,
            relativePath: failedTask.relativePath,
            reason: error?.code || error?.message || "failed"
          })
        : null,
      remaining: remainingTasks.map((task, offset) =>
        recoveryListItem(task.source, safeFailedIndex + offset, {
          dest: task.dest,
          relativePath: task.relativePath
        })
      ),
      retry,
      canRetryRemaining: Boolean(retry)
    }
  };
}

function interruptedCheckpointError() {
  const error = new Error("Operation interrupted before completion.");
  error.code = "INTERRUPTED_CHECKPOINT";
  return error;
}

async function checkpointRecovery(hooks, details) {
  if (!details || typeof hooks.updateRecovery !== "function") {
    return;
  }
  await hooks.updateRecovery(details);
}

async function testOperationDelayAfterCheckpoint(hooks, operationType, completedItems) {
  if (!testOperationDelayMs) {
    return;
  }
  const completed = Number(completedItems || 0);
  if (testOperationDelayAfterItems && completed < testOperationDelayAfterItems) {
    return;
  }
  await hooks.updateProgress?.({
    phase: "Test delay",
    testDelay: true,
    operationType,
    completed
  });
  await new Promise((resolve) => setTimeout(resolve, testOperationDelayMs));
  await hooks.throwIfCanceled?.();
}

function createCopyProgressState(footprint) {
  return {
    totalBytes: Number(footprint?.bytes || 0),
    completedBytes: 0,
    totalFiles: Number(footprint?.files || 0),
    completedFiles: 0,
    currentBytes: 0,
    currentTotalBytes: 0,
    startedAt: Date.now(),
    lastReportAt: 0,
    lastReportBytes: -1
  };
}

function copyProgressFields(state) {
  if (!state) {
    return {};
  }
  const elapsedSeconds = Math.max((Date.now() - state.startedAt) / 1000, 0);
  const rateSeconds = Math.max(elapsedSeconds, 0.05);
  const bytesPerSecond = state.completedBytes > 0 ? Math.round(state.completedBytes / rateSeconds) : 0;
  const remainingBytes = Math.max(0, state.totalBytes - state.completedBytes);
  return {
    totalBytes: state.totalBytes,
    completedBytes: state.completedBytes,
    totalFiles: state.totalFiles,
    completedFiles: state.completedFiles,
    currentBytes: state.currentBytes,
    currentTotalBytes: state.currentTotalBytes,
    bytesPerSecond,
    etaMs: bytesPerSecond > 0 ? Math.round((remainingBytes / bytesPerSecond) * 1000) : null
  };
}

async function updateCopyProgress(hooks, state, fields = {}) {
  await hooks.updateProgress?.({
    ...fields,
    ...copyProgressFields(state)
  });
}

function shouldReportCopyProgress(state) {
  const now = Date.now();
  return (
    state.lastReportAt === 0 ||
    now - state.lastReportAt >= 180 ||
    state.completedBytes - state.lastReportBytes >= 1_048_576 ||
    state.completedBytes >= state.totalBytes
  );
}

async function copyFileWithProgress(src, dest, stats, options = {}) {
  const { hooks = {}, progressState = null, progressFields = () => ({}) } = options;
  const signal = options.signal || hooks.signal;
  throwIfOperationCanceled(signal);
  await hooks.waitIfPaused?.();
  const force = options.force === true;
  const flags = force ? "w" : "wx";
  await fs.mkdir(path.dirname(dest), { recursive: true });
  if (!force && (await pathExists(dest))) {
    throw existingTargetError(dest);
  }
  if (force && (await pathExists(dest))) {
    await fs.rm(dest, { recursive: true, force: true });
  }

  if (progressState) {
    progressState.currentBytes = 0;
    progressState.currentTotalBytes = stats.size;
    await updateCopyProgress(hooks, progressState, progressFields());
  }

  const counter = new Transform({
    transform(chunk, encoding, callback) {
      const continueAfterPause = async () => {
        throwIfOperationCanceled(signal);
        await hooks.waitIfPaused?.();
        throwIfOperationCanceled(signal);
        if (!progressState) {
          return;
        }
        progressState.completedBytes += chunk.length;
        progressState.currentBytes += chunk.length;
        if (!shouldReportCopyProgress(progressState)) {
          return;
        }
        progressState.lastReportAt = Date.now();
        progressState.lastReportBytes = progressState.completedBytes;
        await updateCopyProgress(hooks, progressState, progressFields());
      };
      continueAfterPause().then(
        () => callback(null, chunk),
        (error) => callback(error)
      );
    }
  });

  try {
    await pipeline(
      createReadStream(src),
      counter,
      createWriteStream(dest, { flags, mode: stats.mode }),
      { signal }
    );
    await fs.utimes(dest, stats.atime, stats.mtime).catch(() => {});
    await fs.chmod(dest, stats.mode).catch(() => {});
  } catch (error) {
    if (error.code !== "EEXIST") {
      await fs.rm(dest, { force: true }).catch(() => {});
    }
    throw error;
  }

  if (progressState) {
    progressState.currentBytes = stats.size;
    progressState.currentTotalBytes = stats.size;
    progressState.completedFiles += 1;
    await updateCopyProgress(hooks, progressState, progressFields());
  }
}

async function copyPathWithProgress(source, dest, options = {}) {
  const signal = options.signal || options.hooks?.signal;
  throwIfOperationCanceled(signal);
  await options.hooks?.waitIfPaused?.();
  const src = resolveUserPath(source);
  const target = resolveUserPath(dest);
  const stats = await fs.lstat(src);
  const force = options.force === true;

  if (stats.isSymbolicLink()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (!force && (await pathExists(target))) {
      throw existingTargetError(target);
    }
    if (force && (await pathExists(target))) {
      await fs.rm(target, { recursive: true, force: true });
    }
    try {
      const linkTarget = await fs.readlink(src);
      const targetStats = await fs.stat(src).catch(() => null);
      await fs.symlink(linkTarget, target, targetStats?.isDirectory() ? "junction" : "file");
    } catch (error) {
      if (error.code !== "EPERM") {
        throw error;
      }
      await fs.cp(src, target, {
        recursive: true,
        force,
        errorOnExist: !force,
        verbatimSymlinks: true
      });
    }
    return target;
  }

  if (stats.isDirectory()) {
    if (!force && (await pathExists(target))) {
      throw existingTargetError(target);
    }
    await fs.mkdir(target, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      throwIfOperationCanceled(signal);
      await options.hooks?.waitIfPaused?.();
      await copyPathWithProgress(path.join(src, entry.name), path.join(target, entry.name), options);
    }
    await fs.utimes(target, stats.atime, stats.mtime).catch(() => {});
    await fs.chmod(target, stats.mode).catch(() => {});
    return target;
  }

  if (stats.isFile()) {
    await copyFileWithProgress(src, target, stats, options);
    return target;
  }

  await fs.cp(src, target, {
    recursive: true,
    force,
    errorOnExist: !force,
    verbatimSymlinks: true
  });
  return target;
}

function siblingStagingPath(target) {
  const resolved = resolveUserPath(target);
  const suffix = crypto.randomBytes(6).toString("hex");
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.explore-better-${suffix}.partial`);
}

async function copyToStagingAndCommit(source, dest, options = {}) {
  const src = resolveUserPath(source);
  const target = resolveUserPath(dest);
  const staging = siblingStagingPath(target);
  if (await pathExists(target)) {
    throw existingTargetError(target);
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await options.onTransactionPhase?.({ phase: "staging", source: src, staging, destination: target });
    await copyPathWithProgress(src, staging, { ...options, force: false });
    if (testFailStagingRename) {
      const injected = new Error("Injected staging rename failure.");
      injected.code = "EB_TEST_STAGING_RENAME";
      throw injected;
    }
    await fs.rename(staging, target);
    await options.onTransactionPhase?.({ phase: "destination-committed", source: src, staging, destination: target });
    return target;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    error.details = {
      ...(error.details || {}),
      transaction: {
        version: 1,
        phase: "staging-failed",
        source: src,
        stagingPath: staging,
        destinationPath: target
      }
    };
    throw error;
  }
}

async function removeCommittedMoveSource(source, dest) {
  const src = resolveUserPath(source);
  const target = resolveUserPath(dest);
  try {
    if (testFailSourceRemoval) {
      const injected = new Error("Injected source removal failure.");
      injected.code = "EB_TEST_SOURCE_REMOVE";
      throw injected;
    }
    await fs.rm(src, { recursive: true, force: false });
  } catch (error) {
    error.details = {
      ...(error.details || {}),
      sourceRemovalPending: true,
      destinationCommitted: true,
      source: src,
      dest: target,
      transaction: {
        version: 1,
        phase: "source-removal-pending",
        source: src,
        destinationPath: target,
        stagingPath: null
      }
    };
    throw error;
  }
}

async function copyOne(source, targetDir, options = {}) {
  const src = resolveUserPath(source);
  const destDir = resolveUserPath(targetDir);
  const dest = await uniquePath(destDir, path.basename(src));
  await copyToStagingAndCommit(src, dest, options);
  return dest;
}

async function moveOne(source, targetDir, options = {}) {
  const src = resolveUserPath(source);
  const destDir = resolveUserPath(targetDir);
  const dest = await uniquePath(destDir, path.basename(src));
  try {
    if (testForceCrossVolumeMove) {
      const injected = new Error("Injected cross-volume move.");
      injected.code = "EXDEV";
      throw injected;
    }
    await fs.rename(src, dest);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
    await copyToStagingAndCommit(src, dest, options);
    await removeCommittedMoveSource(src, dest);
  }
  return dest;
}

async function moveToExactOrUnique(source, requestedTarget, options = {}) {
  const src = resolveUserPath(source);
  const requested = resolveUserPath(requestedTarget);
  const dest = (await pathExists(requested))
    ? await uniquePath(path.dirname(requested), path.basename(requested))
    : requested;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    if (testForceCrossVolumeMove) {
      const injected = new Error("Injected cross-volume move.");
      injected.code = "EXDEV";
      throw injected;
    }
    await fs.rename(src, dest);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
    await copyToStagingAndCommit(src, dest, options);
    await removeCommittedMoveSource(src, dest);
  }
  return dest;
}

async function copyPaths(paths, targetDir, hooks = {}) {
  const copied = [];
  const total = paths.length;
  const resolvedSources = paths.map((source) => resolveUserPath(source));
  const resolvedTargetDir = resolveUserPath(targetDir);
  for (const source of resolvedSources) {
    const stats = await fs.lstat(source);
    if (stats.isDirectory() && isInsidePath(resolvedTargetDir, source)) {
      throw new Error("A folder cannot be copied into itself or one of its descendants.");
    }
  }
  let activeIndex = 0;
  try {
    await hooks.updateProgress?.({ unit: "items", total, completed: 0, phase: "Scanning" });
    const progressState = createCopyProgressState(
      await scanCopyFootprints(resolvedSources, hooks, (itemPath, index) => {
        activeIndex = index;
      })
    );
    await updateCopyProgress(hooks, progressState, { unit: "items", total, completed: 0, phase: "Preparing" });
    for (const [index, source] of paths.entries()) {
      activeIndex = index;
      const resolvedSource = resolvedSources[index];
      const progressFields = () => ({
        unit: "items",
        total,
        completed: index,
        phase: "Copying",
        current: labelFromPath(resolvedSource),
        currentPath: resolvedSource
      });
      await updateCopyProgress(hooks, progressState, progressFields());
      const dest = await copyOne(resolvedSource, targetDir, { hooks, progressState, progressFields });
      copied.push({ source: resolvedSource, dest });
      await updateCopyProgress(hooks, progressState, {
        unit: "items",
        total,
        completed: index + 1,
        phase: "Copied",
        current: labelFromPath(resolvedSource),
        currentPath: resolvedSource
      });
      await checkpointRecovery(
        hooks,
        {
          ...operationRecoveryDetails({
            type: "copy",
            body: { paths, targetDir },
            resolvedSources,
            completedItems: copied,
            failedIndex: index + 1,
            error: interruptedCheckpointError(),
            result: { copied: copied.map((item) => item.dest), items: copied }
          }),
          undo: { type: "trash-created", items: copied.map((item) => ({ path: item.dest })) }
        }
      );
      await testOperationDelayAfterCheckpoint(hooks, "copy", index + 1);
    }
    await updateCopyProgress(hooks, progressState, { unit: "items", total, completed: copied.length, phase: "Updating labels" });
    await updateLabelsForTransfers(copied, "copy");
    await updateCopyProgress(hooks, progressState, { unit: "items", total, completed: copied.length, phase: "Completed" });
    return {
      result: { copied: copied.map((item) => item.dest), items: copied },
      undo: { type: "trash-created", items: copied.map((item) => ({ path: item.dest })) }
    };
  } catch (error) {
    const transactionFailure = error.details;
    const details = operationRecoveryDetails({
      type: "copy",
      body: { paths, targetDir },
      resolvedSources,
      completedItems: copied,
      failedIndex: activeIndex,
      error,
      result: { copied: copied.map((item) => item.dest), items: copied }
    });
    throw error;
  }
}

async function movePaths(paths, targetDir, hooks = {}) {
  const moved = [];
  const total = paths.length;
  const resolvedSources = paths.map((source) => resolveUserPath(source));
  const resolvedTargetDir = resolveUserPath(targetDir);
  for (const source of resolvedSources) {
    const stats = await fs.lstat(source);
    if (stats.isDirectory() && isInsidePath(resolvedTargetDir, source)) {
      throw new Error("A folder cannot be moved into itself or one of its descendants.");
    }
  }
  let activeIndex = 0;
  try {
    await hooks.updateProgress?.({ unit: "items", total, completed: 0, phase: "Scanning" });
    const progressState = createCopyProgressState(
      await scanCopyFootprints(resolvedSources, hooks, (itemPath, index) => {
        activeIndex = index;
      })
    );
    await updateCopyProgress(hooks, progressState, { unit: "items", total, completed: 0, phase: "Preparing" });
    for (const [index, source] of paths.entries()) {
      activeIndex = index;
      const resolvedSource = resolvedSources[index];
      const progressFields = () => ({
        unit: "items",
        total,
        completed: index,
        phase: "Moving",
        current: labelFromPath(resolvedSource),
        currentPath: resolvedSource
      });
      await updateCopyProgress(hooks, progressState, progressFields());
      const dest = await moveOne(resolvedSource, targetDir, { hooks, progressState, progressFields });
      moved.push({ source: resolvedSource, dest });
      await updateCopyProgress(hooks, progressState, {
        unit: "items",
        total,
        completed: index + 1,
        phase: "Moved",
        current: labelFromPath(resolvedSource),
        currentPath: resolvedSource
      });
      await checkpointRecovery(
        hooks,
        {
          ...operationRecoveryDetails({
            type: "move",
            body: { paths, targetDir },
            resolvedSources,
            completedItems: moved,
            failedIndex: index + 1,
            error: interruptedCheckpointError(),
            result: { moved: moved.map((item) => item.dest), items: moved }
          }),
          undo: {
            type: "move-back",
            items: moved.map((item) => ({ from: item.dest, to: item.source }))
          }
        }
      );
      await testOperationDelayAfterCheckpoint(hooks, "move", index + 1);
    }
    await updateCopyProgress(hooks, progressState, { unit: "items", total, completed: moved.length, phase: "Updating labels" });
    await updateLabelsForTransfers(moved, "move");
    await updateCopyProgress(hooks, progressState, { unit: "items", total, completed: moved.length, phase: "Completed" });
    return {
      result: { moved: moved.map((item) => item.dest), items: moved },
      undo: {
        type: "move-back",
        items: moved.map((item) => ({ from: item.dest, to: item.source }))
      }
    };
  } catch (error) {
    const transactionFailure = error.details;
    const details = operationRecoveryDetails({
      type: "move",
      body: { paths, targetDir },
      resolvedSources,
      completedItems: moved,
      failedIndex: activeIndex,
      error,
      result: { moved: moved.map((item) => item.dest), items: moved }
    });
    if (transactionFailure?.sourceRemovalPending) {
      const remainingPaths = resolvedSources.slice(activeIndex + 1);
      const retry = retryRequestForOperation("move-resume", {
        source: transactionFailure.source,
        dest: transactionFailure.dest,
        targetDir,
        paths: remainingPaths
      });
      details.destinationCommitted = transactionFailure.dest;
      details.sourceRemovalPending = transactionFailure.source;
      details.transaction = transactionFailure.transaction;
      details.recovery = {
        ...details.recovery,
        sourceRemovalPending: true,
        destinationCommitted: true,
        pendingSource: transactionFailure.source,
        committedDestination: transactionFailure.dest,
        transaction: transactionFailure.transaction,
        retry,
        canRetryRemaining: Boolean(retry),
        reconciliationActions: ["remove-source", "keep-destination"]
      };
    }
    error.details = details;
    throw error;
  }
}

function assertSafePermanentDeletePath(itemPath) {
  const resolved = resolveUserPath(itemPath);
  if (sameResolvedPath(resolved, path.parse(resolved).root)) {
    throw new Error("Deleting a drive or filesystem root is not allowed.");
  }
  if (isInsidePath(resolved, appDataRoot) || isInsidePath(appDataRoot, resolved)) {
    throw new Error("Deleting Explore Better application state through the file operation API is not allowed.");
  }
}

async function deletePaths(paths, hooks = {}) {
  const deleted = [];
  const total = paths.length;
  const resolvedSources = paths.map((source) => resolveUserPath(source));
  for (const source of resolvedSources) {
    assertSafePermanentDeletePath(source);
  }
  let activeIndex = 0;
  try {
    await hooks.updateProgress?.({ unit: "items", total, completed: 0, phase: "Preparing" });
    for (const [index, itemPath] of resolvedSources.entries()) {
      activeIndex = index;
      await hooks.throwIfCanceled?.();
      await hooks.waitIfPaused?.();
      await hooks.updateProgress?.({
        unit: "items",
        total,
        completed: index,
        phase: "Deleting",
        current: labelFromPath(itemPath),
        currentPath: itemPath
      });
      const stats = await fs.lstat(itemPath);
      await fs.rm(itemPath, { recursive: true, force: false });
      deleted.push({
        path: itemPath,
        source: itemPath,
        isDirectory: stats.isDirectory(),
        size: stats.isFile() ? stats.size : null
      });
      await hooks.updateProgress?.({
        unit: "items",
        total,
        completed: index + 1,
        phase: "Deleted",
        current: labelFromPath(itemPath),
        currentPath: itemPath
      });
      await checkpointRecovery(
        hooks,
        operationRecoveryDetails({
          type: "delete",
          body: { paths },
          resolvedSources,
          completedItems: deleted.map((item) => ({ source: item.path })),
          failedIndex: index + 1,
          error: interruptedCheckpointError(),
          result: {
            deleted: deleted.map((item) => item.path),
            items: deleted,
            undoAvailable: false,
            restoreHint: "Permanent delete has no app-level restore."
          }
        })
      );
      await testOperationDelayAfterCheckpoint(hooks, "delete", index + 1);
    }
    await clearPathLabels({ paths: deleted.map((item) => item.path) }).catch(() => {});
    await hooks.updateProgress?.({ unit: "items", total, completed: deleted.length, phase: "Completed" });
    return {
      result: {
        deleted: deleted.map((item) => item.path),
        items: deleted,
        undoAvailable: false,
        restoreHint: "Permanent delete has no app-level restore."
      },
      undo: null
    };
  } catch (error) {
    error.details = operationRecoveryDetails({
      type: "delete",
      body: { paths },
      resolvedSources,
      completedItems: deleted.map((item) => ({ source: item.path })),
      failedIndex: activeIndex,
      error,
      result: {
        deleted: deleted.map((item) => item.path),
        items: deleted,
        undoAvailable: false,
        restoreHint: "Permanent delete has no app-level restore."
      }
    });
    throw error;
  }
}

async function recycleOnePath(itemPath) {
  const resolved = resolveUserPath(itemPath);
  const stats = await fs.stat(resolved);
  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName Microsoft.VisualBasic
$payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json
$ui = [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs
$recycle = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
if ($payload.isDirectory) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($payload.path, $ui, $recycle)
} else {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($payload.path, $ui, $recycle)
}
`;
  await runPowerShellPayload(script, { path: resolved, isDirectory: stats.isDirectory() });
  return { source: resolved, isDirectory: stats.isDirectory(), size: stats.isFile() ? stats.size : null };
}

async function recyclePaths(paths, hooks = {}) {
  const recycled = [];
  const total = paths.length;
  const resolvedSources = paths.map((source) => resolveUserPath(source));
  let activeIndex = 0;
  try {
    await hooks.updateProgress?.({ unit: "items", total, completed: 0, phase: "Preparing" });
    for (const [index, itemPath] of resolvedSources.entries()) {
      activeIndex = index;
      await hooks.throwIfCanceled?.();
      await hooks.waitIfPaused?.();
      await hooks.updateProgress?.({
        unit: "items",
        total,
        completed: index,
        phase: "Recycling",
        current: labelFromPath(itemPath),
        currentPath: itemPath
      });
      const item = await recycleOnePath(itemPath);
      recycled.push(item);
      await hooks.updateProgress?.({
        unit: "items",
        total,
        completed: index + 1,
        phase: "Recycled",
        current: labelFromPath(itemPath),
        currentPath: itemPath
      });
      await checkpointRecovery(
        hooks,
        operationRecoveryDetails({
          type: "recycle",
          body: { paths },
          resolvedSources,
          completedItems: recycled.map((item) => ({ source: item.source })),
          failedIndex: index + 1,
          error: interruptedCheckpointError(),
          result: {
            recycled: recycled.map((item) => item.source),
            items: recycled,
            undoAvailable: false,
            restoreHint: "Restore completed items from the Windows Recycle Bin."
          }
        })
      );
    }
    await hooks.updateProgress?.({ unit: "items", total, completed: recycled.length, phase: "Completed" });
    return {
      result: {
        recycled: recycled.map((item) => item.source),
        items: recycled,
        undoAvailable: false,
        restoreHint: "Restore from the Windows Recycle Bin."
      },
      undo: null
    };
  } catch (error) {
    error.details = operationRecoveryDetails({
      type: "recycle",
      body: { paths },
      resolvedSources,
      completedItems: recycled.map((item) => ({ source: item.source })),
      failedIndex: activeIndex,
      error,
      result: {
        recycled: recycled.map((item) => item.source),
        items: recycled,
        undoAvailable: false,
        restoreHint: "Restore completed items from the Windows Recycle Bin."
      }
    });
    throw error;
  }
}

async function trashPaths(paths, hooks = {}) {
  const batchName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto
    .randomBytes(3)
    .toString("hex")}`;
  const batchDir = path.join(trashRoot, batchName);
  await fs.mkdir(batchDir, { recursive: true });
  const moved = [];
  const total = paths.length;
  const resolvedSources = paths.map((source) => resolveUserPath(source));
  let activeIndex = 0;
  try {
    await hooks.updateProgress?.({ unit: "items", total, completed: 0, phase: "Preparing" });
    for (const [index, item] of paths.entries()) {
      activeIndex = index;
      const resolvedSource = resolvedSources[index];
      await hooks.updateProgress?.({
        unit: "items",
        total,
        completed: index,
        phase: "Trashing",
        current: labelFromPath(resolvedSource),
        currentPath: resolvedSource
      });
      const dest = await moveOne(resolvedSource, batchDir);
      moved.push({ source: resolvedSource, dest });
      await hooks.updateProgress?.({
        unit: "items",
        total,
        completed: index + 1,
        phase: "Trashed",
        current: labelFromPath(resolvedSource),
        currentPath: resolvedSource
      });
      await checkpointRecovery(
        hooks,
        {
          ...operationRecoveryDetails({
            type: "trash",
            body: { paths },
            resolvedSources,
            completedItems: moved,
            failedIndex: index + 1,
            error: interruptedCheckpointError(),
            result: { trashDir: batchDir, moved: moved.map((item) => item.dest), items: moved }
          }),
          undo: {
            type: "restore-trash",
            items: moved.map((item) => ({ from: item.dest, to: item.source }))
          }
        }
      );
      await testOperationDelayAfterCheckpoint(hooks, "trash", index + 1);
    }
    await hooks.updateProgress?.({ unit: "items", total, completed: moved.length, phase: "Updating labels" });
    await updateLabelsForTransfers(moved, "move");
    await hooks.updateProgress?.({ unit: "items", total, completed: moved.length, phase: "Completed" });
    return {
      result: { trashDir: batchDir, moved: moved.map((item) => item.dest), items: moved },
      undo: {
        type: "restore-trash",
        items: moved.map((item) => ({ from: item.dest, to: item.source }))
      }
    };
  } catch (error) {
    error.details = operationRecoveryDetails({
      type: "trash",
      body: { paths },
      resolvedSources,
      completedItems: moved,
      failedIndex: activeIndex,
      error,
      result: { trashDir: batchDir, moved: moved.map((item) => item.dest), items: moved }
    });
    throw error;
  }
}

function missingPathEntry(itemPath, reason = "missing") {
  const resolved = resolveUserPath(itemPath);
  return {
    name: path.basename(resolved) || resolved,
    path: resolved,
    parent: path.dirname(resolved),
    isDirectory: false,
    isFile: false,
    extension: path.extname(resolved).toLowerCase(),
    kind: "Missing",
    size: null,
    modified: null,
    created: null,
    hidden: path.basename(resolved).startsWith("."),
    unavailable: true,
    reason
  };
}

async function upsertCollection(body) {
  return mutateState((state) => {
    const existing = (state.collections || []).find((item) => item.id === body.id);
    const savedCollection = sanitizeSavedCollection({
      id: body.id || existing?.id,
      name: body.name || existing?.name,
      description: body.description ?? existing?.description,
      color: body.color || existing?.color,
      createdAt: existing?.createdAt || body.createdAt,
      updatedAt: new Date().toISOString(),
      items: Array.isArray(body.items) ? body.items : existing?.items || []
    });
    state.collections = [
      savedCollection,
      ...(state.collections || []).filter((item) => item.id !== savedCollection.id)
    ].slice(0, 50);
    return { collection: savedCollection, collections: state.collections };
  });
}

async function addToCollection(body) {
  const paths = Array.isArray(body.paths) ? body.paths : [];
  if (!paths.length) {
    throw new Error("Select items to add to a collection.");
  }
  return mutateState((state) => {
    const existing = (state.collections || []).find((item) => item.id === body.collectionId || item.id === body.id);
    const baseCollection =
      existing ||
      sanitizeSavedCollection({
        name: body.name || "New Collection",
        description: body.description || "",
        items: []
      });
    const addedAt = new Date().toISOString();
    const collection = sanitizeSavedCollection({
      ...baseCollection,
      name: body.name || baseCollection.name,
      description: body.description ?? baseCollection.description,
      updatedAt: addedAt,
      items: [
        ...(baseCollection.items || []),
        ...paths.map((itemPath) => ({ path: itemPath, addedAt }))
      ]
    });
    state.collections = [
      collection,
      ...(state.collections || []).filter((item) => item.id !== collection.id)
    ].slice(0, 50);
    return { collection, collections: state.collections };
  });
}

async function removeFromCollection(body) {
  const collectionId = body.collectionId || body.id;
  const paths = new Set((Array.isArray(body.paths) ? body.paths : []).map((itemPath) => pathIdentity(itemPath)));
  if (!collectionId) {
    throw new Error("Missing collection id.");
  }
  return mutateState((state) => {
    const existing = (state.collections || []).find((item) => item.id === collectionId);
    if (!existing) {
      throw new Error("Collection not found.");
    }
    const collection = sanitizeSavedCollection({
      ...existing,
      updatedAt: new Date().toISOString(),
      items: existing.items.filter((item) => !paths.has(pathIdentity(item.path)))
    });
    state.collections = [
      collection,
      ...(state.collections || []).filter((item) => item.id !== collection.id)
    ].slice(0, 50);
    return { collection, collections: state.collections };
  });
}

async function deleteCollection(collectionId) {
  if (!collectionId) {
    throw new Error("Missing collection id.");
  }
  return mutateState((state) => {
    state.collections = (state.collections || []).filter((item) => item.id !== collectionId);
    return { collections: state.collections };
  });
}

async function resolveCollection(body) {
  const state = await readState();
  const collection = (state.collections || []).find((item) => item.id === body.collectionId || item.id === body.id);
  const items = collection?.items || uniqueCollectionItems(body.items || body.paths);
  const entries = [];
  const missing = [];

  for (const item of items.slice(0, 2000)) {
    try {
      entries.push(await statPathEntry(item.path));
    } catch (error) {
      const entry = missingPathEntry(item.path, error.code || "unavailable");
      entries.push(entry);
      missing.push(entry);
    }
  }

  return {
    collection: collection || null,
    total: items.length,
    available: entries.length - missing.length,
    missing: missing.length,
    entries: attachPathLabels(entries, state)
  };
}

async function applyPathLabels(body) {
  const paths = Array.isArray(body.paths) ? body.paths.slice(0, 500).map(resolveUserPath) : [];
  if (!paths.length) {
    throw new Error("Select items to label.");
  }

  const now = new Date().toISOString();
  const labels = paths.map((itemPath) =>
    sanitizePathLabel({
      path: itemPath,
      name: body.name || "Marked",
      color: body.color,
      notes: body.notes,
      updatedAt: now
    })
  );

  return mutateState((state) => {
    const selectedKeys = new Set(labels.map((label) => pathIdentity(label.path)));
    state.labels = uniquePathLabels([
      ...(state.labels || []).filter((label) => !selectedKeys.has(pathIdentity(label.path))),
      ...labels
    ]);
    return { labels: state.labels, applied: labels };
  });
}

async function clearPathLabels(body) {
  const paths = Array.isArray(body.paths) ? body.paths.map(resolveUserPath) : [];
  if (!paths.length) {
    throw new Error("Select labeled items first.");
  }
  const keys = new Set(paths.map(pathIdentity));
  return mutateState((state) => {
    state.labels = (state.labels || []).filter((label) => !keys.has(pathIdentity(label.path)));
    return { labels: state.labels, cleared: paths };
  });
}

function defaultArchiveName(paths) {
  const resolvedPaths = Array.isArray(paths) ? paths.map(resolveUserPath) : [];
  if (resolvedPaths.length === 1) {
    const parsed = path.parse(path.basename(resolvedPaths[0]));
    return `${parsed.name || "Archive"}.zip`;
  }
  return "Archive.zip";
}

function cleanZipFileName(name, paths) {
  const fallback = defaultArchiveName(paths);
  const requested = String(name || fallback).trim() || fallback;
  const withExtension = requested.toLowerCase().endsWith(".zip") ? requested : `${requested}.zip`;
  return cleanEntryName(withExtension);
}

function assertZipPath(itemPath) {
  const archive = resolveUserPath(itemPath);
  if (path.extname(archive).toLowerCase() !== ".zip") {
    throw new Error("Select a .zip archive.");
  }
  return archive;
}

const zipListDefaultLimit = 10000;
const zipListMaxLimit = 100000;
const zipListDefaultScanLimit = 250000;
const zipListMaxScanLimit = 500000;

function zipListLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return zipListDefaultLimit;
  }
  return Math.max(1, Math.min(Math.floor(parsed), zipListMaxLimit));
}

function zipScanLimit(value, entryLimit) {
  const parsed = Number(value);
  const fallback = Math.max(entryLimit, zipListDefaultScanLimit);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.min(fallback, zipListMaxScanLimit);
  }
  return Math.max(entryLimit, Math.min(Math.floor(parsed), zipListMaxScanLimit));
}

function normalizeZipInnerPath(value) {
  const text = String(value || "")
    .replace(/\\/g, "/")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!text) {
    return "";
  }
  const parts = text.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) {
    throw new Error("Invalid ZIP folder path.");
  }
  return parts.join("/");
}

function safeZipEntryPath(value) {
  const text = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!text || text.includes("\0")) {
    return "";
  }
  const parts = text.split("/").filter(Boolean);
  if (!parts.length) {
    return "";
  }
  if (parts.some((part) => part === "." || part === "..")) {
    return null;
  }
  return parts.join("/");
}

function encodeZipInnerPath(innerPath) {
  const clean = normalizeZipInnerPath(innerPath);
  return clean
    ? clean
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")
    : "";
}

function zipVirtualPath(archive, innerPath = "") {
  const encodedInner = encodeZipInnerPath(innerPath);
  return `zip://${encodeURIComponent(archive)}!/${encodedInner}`;
}

function zipParentPath(archive, innerPath = "") {
  const clean = normalizeZipInnerPath(innerPath);
  if (!clean) {
    return path.dirname(archive);
  }
  const parentInner = clean.split("/").slice(0, -1).join("/");
  return zipVirtualPath(archive, parentInner);
}

function zipListingTitle(archive, innerPath = "") {
  const archiveName = path.basename(archive);
  const clean = normalizeZipInnerPath(innerPath);
  return clean ? `${archiveName}/${clean}` : archiveName;
}

function zipEntryModifiedMs(entry) {
  try {
    const date = entry.getLastModDate?.();
    const ms = date?.getTime?.();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function baseZipEntry(archive, parentVirtualPath, innerPath, name, isDirectory, sourceEntry = null) {
  const extension = isDirectory ? "" : path.extname(name).toLowerCase();
  const attributes = attributesForEntry(name, null, "");
  return {
    name,
    path: zipVirtualPath(archive, innerPath),
    parent: parentVirtualPath,
    archivePath: archive,
    zipArchive: archive,
    innerPath,
    virtualType: "zip",
    isDirectory,
    isFile: !isDirectory,
    extension,
    kind: entryKind(name, isDirectory),
    size: isDirectory ? null : numberOrNull(sourceEntry?.uncompressedSize),
    compressedSize: isDirectory ? null : numberOrNull(sourceEntry?.compressedSize),
    dimensions: null,
    dimensionText: "",
    dimensionPixels: null,
    modified: sourceEntry ? zipEntryModifiedMs(sourceEntry) : null,
    created: null,
    accessed: null,
    mode: null,
    attributes,
    readonly: false,
    hidden: attributes.hidden,
    system: false,
    archive: false,
    attributeText: attributes.text,
    isSymlink: false,
    linkType: "",
    linkTarget: "",
    linkTargetRaw: "",
    linkCount: null,
    unavailable: false,
    zipChildren: 0
  };
}

function updateZipDirectoryEntry(entry, sourceEntry) {
  entry.isDirectory = true;
  entry.isFile = false;
  entry.extension = "";
  entry.kind = "Folder";
  entry.size = null;
  entry.compressedSize = null;
  entry.zipChildren = Number(entry.zipChildren || 0) + 1;
  const modified = sourceEntry ? zipEntryModifiedMs(sourceEntry) : null;
  if (Number.isFinite(modified) && (!Number.isFinite(Number(entry.modified)) || modified > entry.modified)) {
    entry.modified = modified;
  }
}

function walkZipEntries(archive, options, onEntry) {
  const { signal = null, maxEntries = zipListDefaultScanLimit } = options || {};
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let zipFile = null;
    let settled = false;
    let scanned = 0;

    const cleanup = () => {
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ scanned, scanTruncated: scanned >= maxEntries });
    };
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      try {
        zipFile?.close();
      } catch {}
      reject(error);
    };
    const onAbort = () => {
      fail(isAbortError(signal?.reason) ? signal.reason : abortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    yauzl.open(archive, { lazyEntries: true, autoClose: true, decodeStrings: true }, (error, openedZip) => {
      if (error) {
        fail(error);
        return;
      }
      zipFile = openedZip;
      zipFile.on("error", fail);
      zipFile.on("end", finish);
      zipFile.on("entry", (entry) => {
        try {
          throwIfAborted(signal);
          scanned += 1;
          const shouldContinue = onEntry(entry, scanned);
          if (shouldContinue === false || scanned >= maxEntries) {
            finish();
            zipFile.close();
            return;
          }
          zipFile.readEntry();
        } catch (entryError) {
          fail(entryError);
        }
      });
      try {
        throwIfAborted(signal);
        zipFile.readEntry();
      } catch (readError) {
        fail(readError);
      }
    });
  });
}

async function listZipArchive(archivePath, options = {}) {
  const timingStart = monotonicMs();
  const { signal = null } = options;
  throwIfAborted(signal);
  const targetStart = monotonicMs();
  const archive = assertZipPath(archivePath);
  const innerPath = normalizeZipInnerPath(options.innerPath || options.prefix || "");
  const archiveStats = await fs.stat(archive);
  if (!archiveStats.isFile()) {
    throw new Error("Select a .zip archive file.");
  }
  throwIfAborted(signal);
  const targetMs = elapsedMs(targetStart);
  const limit = zipListLimit(options.limit);
  const maxEntries = zipScanLimit(options.scanLimit, limit);
  const parentVirtualPath = zipVirtualPath(archive, innerPath);
  const prefix = innerPath ? `${innerPath}/` : "";
  const children = new Map();
  let unsafeEntries = 0;
  let returnedTruncated = false;
  const scanStart = monotonicMs();
  const scan = await walkZipEntries(
    archive,
    { signal, maxEntries },
    (zipEntry) => {
      const safePath = safeZipEntryPath(zipEntry.fileName);
      if (safePath === null) {
        unsafeEntries += 1;
        return true;
      }
      if (!safePath) {
        return true;
      }
      if (innerPath) {
        if (safePath === innerPath) {
          return true;
        }
        if (!safePath.startsWith(prefix)) {
          return true;
        }
      }
      const relativePath = innerPath ? safePath.slice(prefix.length) : safePath;
      if (!relativePath) {
        return true;
      }
      const relativeParts = relativePath.split("/").filter(Boolean);
      const name = relativeParts[0];
      if (!name) {
        return true;
      }
      const childInnerPath = innerPath ? `${innerPath}/${name}` : name;
      const directoryLike = relativeParts.length > 1 || /[\\/]$/.test(String(zipEntry.fileName || ""));
      const key = childInnerPath.toLowerCase();
      const existing = children.get(key);
      if (!existing) {
        if (children.size >= limit) {
          returnedTruncated = true;
          return true;
        }
        const child = baseZipEntry(
          archive,
          parentVirtualPath,
          childInnerPath,
          name,
          directoryLike,
          directoryLike ? null : zipEntry
        );
        if (directoryLike) {
          updateZipDirectoryEntry(child, zipEntry);
        }
        children.set(key, child);
      } else if (directoryLike) {
        updateZipDirectoryEntry(existing, zipEntry);
      } else if (!existing.isDirectory) {
        existing.size = numberOrNull(zipEntry.uncompressedSize);
        existing.compressedSize = numberOrNull(zipEntry.compressedSize);
        existing.modified = zipEntryModifiedMs(zipEntry);
      }
      return true;
    }
  );
  const scanMs = elapsedMs(scanStart);
  throwIfAborted(signal);
  const labelStart = monotonicMs();
  const labelMap = await readLabelMap();
  const entries = attachPathLabels(
    [...children.values()].sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base", numeric: true });
    }),
    labelMap
  );
  const labelMs = elapsedMs(labelStart);

  return {
    path: parentVirtualPath,
    requestedPath: archive,
    archivePath: archive,
    innerPath,
    targetKind: "zip",
    virtual: true,
    virtualType: "zip",
    name: innerPath ? path.posix.basename(innerPath) : path.basename(archive),
    title: zipListingTitle(archive, innerPath),
    parent: zipParentPath(archive, innerPath),
    selectedPath: null,
    count: entries.length,
    totalEntries: scan.scanned,
    scannedEntries: scan.scanned,
    unsafeEntries,
    truncated: returnedTruncated || scan.scanTruncated,
    returnedTruncated,
    scanTruncated: scan.scanTruncated,
    limit,
    scanLimit: maxEntries,
    archiveSize: archiveStats.size,
    archiveModified: archiveStats.mtimeMs,
    folderSignature: folderSignatureFromEntries(entries),
    includeDimensions: false,
    includeLinks: false,
    includeAttributes: false,
    includeSignature: true,
    timing: {
      totalMs: elapsedMs(timingStart),
      targetMs,
      scanMs,
      labelMs,
      scanned: scan.scanned,
      returned: entries.length,
      limit,
      scanLimit: maxEntries
    },
    entries
  };
}

async function runPowerShellPayload(scriptContent, payload, options = {}) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto
    .randomBytes(3)
    .toString("hex")}`;
  const runDir = path.join(tempRoot, runId);
  const scriptPath = path.join(runDir, "task.ps1");
  const payloadPath = path.join(runDir, "payload.json");
  await fs.mkdir(runDir, { recursive: true });
  try {
    await fs.writeFile(scriptPath, scriptContent, "utf8");
    await fs.writeFile(payloadPath, JSON.stringify(payload, null, 2), "utf8");
    const result = await runProcess("powershell.exe", [
      "-NoProfile",
      ...(options.sta ? ["-Sta"] : []),
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      payloadPath
    ], { timeoutMs: options.timeoutMs });
    if (result.code !== 0) {
      const fallback = result.timedOut
        ? `PowerShell operation timed out after ${Number(options.timeoutMs || 0)}ms.`
        : "PowerShell operation failed.";
      const message = (result.stderr || result.stdout || fallback).trim();
      throw new Error(message);
    }
    return result;
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
}

function shortcutBaseName(sourcePath) {
  const clean = String(labelFromPath(sourcePath) || "Shortcut")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return clean || "Shortcut";
}

async function buildShortcutPlan(paths, targetDir, conflictMode = "unique") {
  const sources = (Array.isArray(paths) ? paths : [])
    .filter(Boolean)
    .map((item) => resolveUserPath(item))
    .slice(0, 200);
  if (!sources.length) {
    throw new Error("Select files or folders first.");
  }

  const destDir = resolveUserPath(targetDir);
  const stats = await fs.stat(destDir);
  if (!stats.isDirectory()) {
    throw new Error("Shortcut target folder must be a directory.");
  }

  for (const source of sources) {
    if (!(await pathExists(source))) {
      throw new Error(`Missing source: ${source}`);
    }
  }

  const reserved = new Set();
  const items = [];
  for (const source of sources) {
    const name = `${shortcutBaseName(source)} - Shortcut.lnk`;
    const requested = path.join(destDir, name);
    const dest =
      conflictMode === "fail" ? requested : await uniquePathWithReserved(destDir, name, reserved);
    if (conflictMode === "fail" && (await pathExists(dest))) {
      throw new Error(`Already exists: ${dest}`);
    }
    reserved.add(pathIdentity(dest));
    items.push({ source, dest, name: path.basename(dest) });
  }

  return { targetDir: destDir, items };
}

async function createWindowsShortcuts(body) {
  if (process.platform !== "win32") {
    throw new Error("Windows shortcuts are only available on Windows.");
  }

  const conflictMode = body.conflictMode === "fail" ? "fail" : "unique";
  const plan = await buildShortcutPlan(body.paths, body.targetDir || body.path, conflictMode);
  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
$Payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
$Shell = New-Object -ComObject WScript.Shell
$Created = @()
foreach ($Item in @($Payload.items)) {
  $SourceItem = Get-Item -LiteralPath ([string]$Item.source) -Force
  $Shortcut = $Shell.CreateShortcut([string]$Item.dest)
  $Shortcut.TargetPath = $SourceItem.FullName
  if ($SourceItem.PSIsContainer) {
    $Shortcut.WorkingDirectory = $SourceItem.FullName
  } else {
    $Shortcut.WorkingDirectory = Split-Path -Parent $SourceItem.FullName
  }
  $Shortcut.Description = "Shortcut to $($SourceItem.Name)"
  $Shortcut.IconLocation = $SourceItem.FullName
  $Shortcut.Save()
  $Created += [pscustomobject]@{
    source = $SourceItem.FullName
    dest = [string]$Item.dest
    name = [string]$Item.name
  }
}
[pscustomobject]@{ created = $Created } | ConvertTo-Json -Compress -Depth 4
`;
  const result = await runPowerShellPayload(script, { items: plan.items });
  const parsed = parsePowerShellJson(result, { created: plan.items });
  const created = (Array.isArray(parsed.created) ? parsed.created : [parsed.created])
    .filter(Boolean)
    .map((item, index) => ({
      source: String(item.source || plan.items[index]?.source || ""),
      dest: String(item.dest || plan.items[index]?.dest || ""),
      name: String(item.name || path.basename(item.dest || plan.items[index]?.dest || ""))
    }));

  return {
    result: {
      targetDir: plan.targetDir,
      created
    },
    undo: {
      type: "trash-created",
      items: plan.items.map((item) => ({ path: item.dest }))
    }
  };
}

function normalizeLinkKind(value) {
  return ["auto", "hardlink", "junction", "symlink"].includes(value) ? value : "auto";
}

function linkKindForSource(requestedKind, stats) {
  const kind = normalizeLinkKind(requestedKind);
  if (kind === "auto") {
    return stats.isDirectory() ? "junction" : "hardlink";
  }
  return kind;
}

function linkNameForSource(sourcePath) {
  const base = shortcutBaseName(sourcePath);
  const parsed = path.parse(base);
  if (parsed.ext) {
    return `${parsed.name} - Link${parsed.ext}`;
  }
  return `${base} - Link`;
}

async function buildFilesystemLinkPlan(paths, targetDir, linkKind = "auto", conflictMode = "unique") {
  const sources = (Array.isArray(paths) ? paths : [])
    .filter(Boolean)
    .map((item) => resolveUserPath(item))
    .slice(0, 200);
  if (!sources.length) {
    throw new Error("Select files or folders first.");
  }

  const destDir = resolveUserPath(targetDir);
  const destStats = await fs.stat(destDir);
  if (!destStats.isDirectory()) {
    throw new Error("Link target folder must be a directory.");
  }

  const reserved = new Set();
  const items = [];
  for (const source of sources) {
    const stats = await fs.stat(source);
    const resolvedKind = linkKindForSource(linkKind, stats);
    if (resolvedKind === "hardlink" && !stats.isFile()) {
      throw new Error(`Hard links can only target files: ${source}`);
    }
    if (resolvedKind === "junction" && !stats.isDirectory()) {
      throw new Error(`Junctions can only target folders: ${source}`);
    }
    const name = linkNameForSource(source);
    const requested = path.join(destDir, name);
    const dest =
      conflictMode === "fail" ? requested : await uniquePathWithReserved(destDir, name, reserved);
    if (conflictMode === "fail" && (await pathExists(dest))) {
      throw new Error(`Already exists: ${dest}`);
    }
    reserved.add(pathIdentity(dest));
    items.push({
      source,
      dest,
      name: path.basename(dest),
      linkKind: resolvedKind,
      isDirectory: stats.isDirectory()
    });
  }

  return { targetDir: destDir, items };
}

async function createFilesystemLinks(body) {
  const linkKind = normalizeLinkKind(body.linkKind);
  const conflictMode = body.conflictMode === "fail" ? "fail" : "unique";
  const plan = await buildFilesystemLinkPlan(body.paths, body.targetDir || body.path, linkKind, conflictMode);
  const created = [];
  for (const item of plan.items) {
    if (item.linkKind === "hardlink") {
      await fs.link(item.source, item.dest);
    } else if (item.linkKind === "junction") {
      await fs.symlink(item.source, item.dest, "junction");
    } else if (item.linkKind === "symlink") {
      await fs.symlink(item.source, item.dest, item.isDirectory ? "dir" : "file");
    } else {
      throw new Error(`Unsupported link type: ${item.linkKind}`);
    }
    created.push({ source: item.source, dest: item.dest, name: item.name, linkKind: item.linkKind });
  }

  return {
    result: { targetDir: plan.targetDir, created, count: created.length },
    undo: {
      type: "trash-created",
      items: created.map((item) => ({ path: item.dest }))
    }
  };
}

async function createZipArchive(body) {
  const sources = (Array.isArray(body.paths) ? body.paths : [])
    .filter(Boolean)
    .map((item) => resolveUserPath(item));
  if (!sources.length) {
    throw new Error("Select files or folders to archive.");
  }
  for (const source of sources) {
    if (!(await pathExists(source))) {
      throw new Error(`Missing source: ${source}`);
    }
  }

  const targetDir = resolveUserPath(body.targetDir || path.dirname(sources[0]));
  await fs.mkdir(targetDir, { recursive: true });
  const zipName = cleanZipFileName(body.name, sources);
  const requestedDest = path.join(targetDir, zipName);
  const dest = body.overwrite ? requestedDest : await uniquePath(targetDir, zipName);
  if (body.overwrite && (await pathExists(dest))) {
    await fs.rm(dest, { recursive: true, force: true });
  }

  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
$payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json
$paths = @($payload.sources)
Compress-Archive -LiteralPath $paths -DestinationPath $payload.dest -Force
`;
  await runPowerShellPayload(script, { sources, dest });
  return {
    result: { archive: dest, sources },
    undo: { type: "trash-created", items: [{ path: dest }] }
  };
}

async function extractZipArchive(body) {
  const archive = assertZipPath(body.archive || body.path || body.paths?.[0]);
  if (!(await pathExists(archive))) {
    throw new Error(`Missing archive: ${archive}`);
  }
  const targetDir = resolveUserPath(body.targetDir || path.dirname(archive));
  await fs.mkdir(targetDir, { recursive: true });
  const defaultFolder = path.parse(path.basename(archive)).name || "Extracted";
  const folderName = cleanEntryName(body.folderName || defaultFolder);
  const dest = await uniquePath(targetDir, folderName);
  await fs.mkdir(dest, { recursive: true });

  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
$payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json
Expand-Archive -LiteralPath $payload.archive -DestinationPath $payload.dest -Force
`;
  await runPowerShellPayload(script, { archive, dest });
  return {
    result: { archive, extractedDir: dest },
    undo: { type: "trash-created", items: [{ path: dest }] }
  };
}

function compareKey(relativePath) {
  return process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
}

function normalizeRelativePath(relativePath) {
  return String(relativePath).split(path.sep).join("/");
}

function denormalizeRelativePath(relativePath) {
  return String(relativePath).split("/").join(path.sep);
}

function safeCompareRelativePath(relativePath) {
  const normalized = String(relativePath ?? "").replace(/\\/g, "/").trim();
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid compare item path.");
  }
  const rel = parts.join(path.sep);
  if (path.isAbsolute(rel)) {
    throw new Error("Invalid compare item path.");
  }
  return { relativePath: parts.join("/"), rel };
}

function resolveRelativeUnderRoot(root, rel) {
  const resolved = path.resolve(root, rel);
  if (!isInsidePath(resolved, root)) {
    throw new Error("Compare item path escapes the selected root.");
  }
  return resolved;
}

async function scanCompareTree(rootPath, options = {}) {
  const root = resolveUserPath(rootPath);
  const recursive = options.recursive !== false;
  const includeHidden = Boolean(options.includeHidden);
  const maxEntries = Math.max(100, Math.min(Number(options.maxEntries || 20_000), 100_000));
  const entries = new Map();
  const stack = [root];
  let scanned = 0;
  const skipped = [];

  while (stack.length && scanned < maxEntries) {
    const current = stack.pop();
    let dirents;
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: current, reason: error.code || "unreadable" });
      continue;
    }

    for (const dirent of dirents) {
      if (scanned >= maxEntries) {
        break;
      }
      if (!includeHidden && dirent.name.startsWith(".")) {
        continue;
      }
      const lowerName = dirent.name.toLowerCase();
      if (dirent.isDirectory() && [".git", "node_modules", ".venv", "dist", "build"].includes(lowerName)) {
        skipped.push({ path: path.join(current, dirent.name), reason: "ignored" });
        continue;
      }

      const fullPath = path.join(current, dirent.name);
      const relative = normalizeRelativePath(path.relative(root, fullPath));
      try {
        const entry = await statEntry(current, dirent);
        entry.relative = relative;
        entries.set(compareKey(relative), entry);
        scanned += 1;
        if (recursive && dirent.isDirectory()) {
          stack.push(fullPath);
        }
      } catch (error) {
        skipped.push({ path: fullPath, reason: error.code || "unavailable" });
      }
    }
  }

  return {
    root,
    entries,
    scanned,
    truncated: stack.length > 0 || scanned >= maxEntries,
    skipped
  };
}

function comparePair(left, right, toleranceMs) {
  if (left && !right) return "leftOnly";
  if (right && !left) return "rightOnly";
  if (!left || !right) return "unknown";
  if (left.isDirectory !== right.isDirectory) return "typeMismatch";
  if (left.isDirectory && right.isDirectory) return "same";
  const sizeSame = Number(left.size || 0) === Number(right.size || 0);
  const modifiedDelta = Number(left.modified || 0) - Number(right.modified || 0);
  const timeSame = Math.abs(modifiedDelta) <= toleranceMs;
  if (sizeSame && timeSame) return "same";
  if (modifiedDelta > toleranceMs) return "newerLeft";
  if (modifiedDelta < -toleranceMs) return "newerRight";
  return "different";
}

async function compareDirectories(options) {
  const left = await scanCompareTree(options.leftPath, options);
  const right = await scanCompareTree(options.rightPath, options);
  const toleranceMs = Math.max(0, Number(options.toleranceMs || 2000));
  const keys = new Set([...left.entries.keys(), ...right.entries.keys()]);
  const statuses = new Map();
  const rows = [];

  for (const key of keys) {
    const leftEntry = left.entries.get(key) || null;
    const rightEntry = right.entries.get(key) || null;
    const relative = leftEntry?.relative || rightEntry?.relative || key;
    const status = comparePair(leftEntry, rightEntry, toleranceMs);
    statuses.set(status, (statuses.get(status) || 0) + 1);
    rows.push({
      relative,
      status,
      left: leftEntry,
      right: rightEntry,
      kind: leftEntry?.kind || rightEntry?.kind || "Unknown",
      sizeLeft: leftEntry?.size ?? null,
      sizeRight: rightEntry?.size ?? null,
      modifiedLeft: leftEntry?.modified ?? null,
      modifiedRight: rightEntry?.modified ?? null
    });
  }

  const visibleStatuses = new Set(options.statuses || []);
  const filtered = visibleStatuses.size
    ? rows.filter((row) => visibleStatuses.has(row.status))
    : rows.filter((row) => row.status !== "same");

  filtered.sort((a, b) =>
    `${a.status}:${a.relative}`.localeCompare(`${b.status}:${b.relative}`, undefined, {
      numeric: true,
      sensitivity: "base"
    })
  );

  return {
    leftRoot: left.root,
    rightRoot: right.root,
    recursive: options.recursive !== false,
    toleranceMs,
    scannedLeft: left.scanned,
    scannedRight: right.scanned,
    truncated: left.truncated || right.truncated,
    skipped: [...left.skipped, ...right.skipped].slice(0, 200),
    counts: Object.fromEntries(statuses),
    entries: filtered
  };
}

async function copyExactWithBackup(source, dest, backupDir, overwrite, options = {}) {
  const src = resolveUserPath(source);
  const target = resolveUserPath(dest);
  const existed = await pathExists(target);
  let backup = null;

  if (existed) {
    if (!overwrite) {
      return { source: src, dest: target, skipped: true, reason: "exists" };
    }
    await fs.mkdir(backupDir, { recursive: true });
    backup = await moveOne(target, backupDir);
    await updateLabelsForTransfers([{ source: target, dest: backup }], "move");
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    await copyToStagingAndCommit(src, target, options);
  } catch (error) {
    if (backup && (await pathExists(backup))) {
      await fs.rm(target, { recursive: true, force: true }).catch(() => {});
      await moveToExactOrUnique(backup, target);
      await updateLabelsForTransfers([{ source: backup, dest: target }], "move");
    }
    throw error;
  }

  return { source: src, dest: target, backup, skipped: false };
}

async function syncCompareItems(body, hooks = {}) {
  const expectedPlan = await buildSyncPreviewPlan(body);
  assertExpectedOperationPlan(expectedPlan, body, "Sync");
  const leftRoot = resolveUserPath(body.leftPath);
  const rightRoot = resolveUserPath(body.rightPath);
  const direction = body.direction === "rightToLeft" ? "rightToLeft" : "leftToRight";
  const overwrite = Boolean(body.overwrite);
  const mirrorDeletes = Boolean(body.mirrorDeletes);
  const relativePaths = Array.isArray(body.items) ? body.items : [];
  if (!relativePaths.length) {
    throw new Error("Select at least one compare item to sync.");
  }

  const backupDir = path.join(
    trashRoot,
    `sync-backups-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto
      .randomBytes(3)
      .toString("hex")}`
  );
  const copied = [];
  const deleted = [];
  const sourceRoot = direction === "leftToRight" ? leftRoot : rightRoot;
  const destRoot = direction === "leftToRight" ? rightRoot : leftRoot;
  const tasks = relativePaths.map((relativePath) => {
    const safePath = safeCompareRelativePath(relativePath);
    return {
      relativePath: safePath.relativePath,
      rel: safePath.rel,
      source: resolveRelativeUnderRoot(sourceRoot, safePath.rel),
      dest: resolveRelativeUnderRoot(destRoot, safePath.rel)
    };
  });
  const copyingTasks = [];
  for (const task of tasks) {
    if ((await pathExists(task.source)) && (overwrite || !(await pathExists(task.dest)))) {
      copyingTasks.push(task);
    }
  }
  let activeIndex = 0;
  try {
    await hooks.updateProgress?.({ unit: "items", total: tasks.length, completed: 0, phase: "Scanning" });
    const progressState = createCopyProgressState(
      await scanCopyFootprints(
        copyingTasks.map((task) => task.source),
        hooks,
        (itemPath) => {
          const index = tasks.findIndex((task) => pathIdentity(task.source) === pathIdentity(itemPath));
          if (index !== -1) {
            activeIndex = index;
          }
        }
      )
    );
    await updateCopyProgress(hooks, progressState, { unit: "items", total: tasks.length, completed: 0, phase: "Preparing" });

    for (const [index, task] of tasks.entries()) {
      activeIndex = index;
      const progressFields = () => ({
        unit: "items",
        total: tasks.length,
        completed: index,
        phase: "Syncing",
        current: task.rel,
        currentPath: task.source
      });
      await updateCopyProgress(hooks, progressState, progressFields());
      if (!(await pathExists(task.source))) {
        if (mirrorDeletes && (await pathExists(task.dest))) {
          await updateCopyProgress(hooks, progressState, {
            unit: "items",
            total: tasks.length,
            completed: index,
            phase: "Removing extra",
            current: task.rel,
            currentPath: task.dest
          });
          await fs.mkdir(backupDir, { recursive: true });
          const trashed = await moveOne(task.dest, backupDir);
          const deletedItem = {
            source: task.dest,
            dest: trashed,
            original: task.dest,
            relativePath: task.relativePath
          };
          deleted.push(deletedItem);
          copied.push({
            source: task.dest,
            dest: trashed,
            original: task.dest,
            deleted: true,
            relativePath: task.relativePath
          });
          await updateCopyProgress(hooks, progressState, {
            unit: "items",
            total: tasks.length,
            completed: index + 1,
            phase: "Removed extra",
            current: task.rel,
            currentPath: task.dest
          });
          await checkpointRecovery(
            hooks,
            syncOperationRecoveryDetails({
              body: { ...body, leftPath: leftRoot, rightPath: rightRoot, direction, overwrite, mirrorDeletes },
              tasks,
              completedItems: copied,
              failedIndex: index + 1,
              error: interruptedCheckpointError(),
              result: {
                direction,
                overwrite,
                mirrorDeletes,
                copied: copied.filter((item) => !item.skipped && !item.deleted).map((item) => item.dest),
                deleted: deleted.map((item) => item.source),
                skipped: copied.filter((item) => item.skipped),
                items: copied
              }
            })
          );
          await testOperationDelayAfterCheckpoint(hooks, "sync", index + 1);
          continue;
        }
        copied.push({ source: task.source, dest: task.dest, skipped: true, reason: "missing-source", relativePath: task.relativePath });
        await checkpointRecovery(
          hooks,
          syncOperationRecoveryDetails({
            body: { ...body, leftPath: leftRoot, rightPath: rightRoot, direction, overwrite, mirrorDeletes },
            tasks,
            completedItems: copied,
            failedIndex: index + 1,
            error: interruptedCheckpointError(),
            result: {
              direction,
              overwrite,
              mirrorDeletes,
              copied: copied.filter((item) => !item.skipped && !item.deleted).map((item) => item.dest),
              deleted: deleted.map((item) => item.source),
              skipped: copied.filter((item) => item.skipped),
              items: copied
            }
          })
        );
        await testOperationDelayAfterCheckpoint(hooks, "sync", index + 1);
        continue;
      }
      copied.push({
        ...(await copyExactWithBackup(task.source, task.dest, backupDir, overwrite, {
          hooks,
          progressState,
          progressFields
        })),
        relativePath: task.relativePath
      });
      await updateCopyProgress(hooks, progressState, {
        unit: "items",
        total: tasks.length,
        completed: index + 1,
        phase: "Synced",
        current: task.rel,
        currentPath: task.source
      });
      await checkpointRecovery(
        hooks,
        syncOperationRecoveryDetails({
          body: { ...body, leftPath: leftRoot, rightPath: rightRoot, direction, overwrite, mirrorDeletes },
          tasks,
          completedItems: copied,
          failedIndex: index + 1,
          error: interruptedCheckpointError(),
          result: {
            direction,
            overwrite,
            mirrorDeletes,
            copied: copied.filter((item) => !item.skipped && !item.deleted).map((item) => item.dest),
            deleted: deleted.map((item) => item.source),
            skipped: copied.filter((item) => item.skipped),
            items: copied
          }
        })
      );
      await testOperationDelayAfterCheckpoint(hooks, "sync", index + 1);
    }

    const applied = copied.filter((item) => !item.skipped && !item.deleted);
    await updateCopyProgress(hooks, progressState, { unit: "items", total: tasks.length, completed: tasks.length, phase: "Updating labels" });
    await updateLabelsForTransfers(applied, "copy");
    await updateLabelsForTransfers(deleted, "move");
    await updateCopyProgress(hooks, progressState, { unit: "items", total: tasks.length, completed: tasks.length, phase: "Completed" });
    return {
      result: {
        direction,
        overwrite,
        mirrorDeletes,
        copied: applied.map((item) => item.dest),
        deleted: deleted.map((item) => item.source),
        skipped: copied.filter((item) => item.skipped),
        items: copied
      },
      undo: applied.length || deleted.length
        ? {
            type: "sync-copy",
            items: applied.map((item) => ({ dest: item.dest, backup: item.backup })),
            deleted: deleted.map((item) => ({ from: item.dest, to: item.source }))
          }
      : null
    };
  } catch (error) {
    const applied = copied.filter((item) => !item.skipped && !item.deleted);
    error.details = syncOperationRecoveryDetails({
      body: { ...body, leftPath: leftRoot, rightPath: rightRoot, direction, overwrite, mirrorDeletes },
      tasks,
      completedItems: copied,
      failedIndex: activeIndex,
      error,
      result: {
        direction,
        overwrite,
        mirrorDeletes,
        copied: applied.map((item) => item.dest),
        deleted: deleted.map((item) => item.source),
        skipped: copied.filter((item) => item.skipped),
        items: copied
      }
    });
    throw error;
  }
}

function pathIdentity(itemPath) {
  const resolved = resolveUserPath(itemPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsidePath(candidatePath, parentPath) {
  const candidate = resolveUserPath(candidatePath);
  const parent = resolveUserPath(parentPath);
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveTrashItemPath(value) {
  const resolved = resolveUserPath(value);
  if (pathIdentity(resolved) === pathIdentity(trashRoot) || !isInsidePath(resolved, trashRoot)) {
    throw new Error("Path is not inside the Explore Better app trash.");
  }
  return resolved;
}

function originalPathLookupFromOperations(operations = []) {
  const lookup = new Map();
  for (const operation of operations) {
    const items = operation?.undo?.items || operation?.result?.items || [];
    for (const item of Array.isArray(items) ? items : []) {
      if (item?.from && item?.to) {
        lookup.set(pathIdentity(item.from), item.to);
      }
      if (item?.source && item?.dest) {
        lookup.set(pathIdentity(item.dest), item.source);
      }
    }
  }
  return lookup;
}

async function removeEmptyTrashBatch(batchPath) {
  if (pathIdentity(batchPath) === pathIdentity(trashRoot) || !isInsidePath(batchPath, trashRoot)) {
    return;
  }
  try {
    const remaining = await fs.readdir(batchPath);
    if (!remaining.length) {
      await fs.rm(batchPath, { recursive: true, force: true });
    }
  } catch {
    // The batch may already have been removed by another restore/delete.
  }
}

async function listAppTrash() {
  await fs.mkdir(trashRoot, { recursive: true });
  const state = await readState();
  const originalLookup = originalPathLookupFromOperations(state.operations || []);
  const batches = [];
  const items = [];
  const batchDirents = await fs.readdir(trashRoot, { withFileTypes: true });
  for (const batchDirent of batchDirents) {
    if (!batchDirent.isDirectory()) {
      continue;
    }
    const batchPath = path.join(trashRoot, batchDirent.name);
    let batchStats = null;
    let childDirents = [];
    try {
      batchStats = await fs.stat(batchPath);
      childDirents = await fs.readdir(batchPath, { withFileTypes: true });
    } catch {
      continue;
    }
    const batch = {
      name: batchDirent.name,
      path: batchPath,
      trashedAt: batchStats.birthtimeMs || batchStats.mtimeMs,
      count: 0,
      bytes: 0
    };
    for (const child of childDirents) {
      const itemPath = path.join(batchPath, child.name);
      try {
        const entry = await statPathEntry(itemPath);
        const size = Number(entry.size || 0);
        batch.count += 1;
        batch.bytes += size;
        items.push({
          ...entry,
          batchName: batch.name,
          batchPath,
          trashedAt: batch.trashedAt,
          originalPath: originalLookup.get(pathIdentity(itemPath)) || null
        });
      } catch {
        batch.count += 1;
        items.push({
          name: child.name,
          path: itemPath,
          parent: batchPath,
          isDirectory: child.isDirectory(),
          isFile: child.isFile(),
          kind: child.isDirectory() ? "Folder" : "Unavailable",
          size: null,
          modified: null,
          created: null,
          hidden: child.name.startsWith("."),
          unavailable: true,
          batchName: batch.name,
          batchPath,
          trashedAt: batch.trashedAt,
          originalPath: originalLookup.get(pathIdentity(itemPath)) || null
        });
      }
    }
    batches.push(batch);
  }
  items.sort((left, right) => Number(right.trashedAt || 0) - Number(left.trashedAt || 0));
  return {
    trashRoot,
    batches: batches.sort((left, right) => Number(right.trashedAt || 0) - Number(left.trashedAt || 0)),
    items,
    count: items.length,
    bytes: items.reduce((sum, item) => sum + Number(item.size || 0), 0)
  };
}

function normalizeWindowsShellDateText(value) {
  return String(value || "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWindowsRecycleItem(item, index) {
  const name = String(item?.name || "");
  const originalLocation = String(item?.originalLocation || "");
  const originalPath = String(item?.originalPath || "") || (originalLocation && name ? path.join(originalLocation, name) : "");
  const size = Number(item?.size || 0);
  return {
    id: String(item?.path || item?.id || ""),
    path: String(item?.path || ""),
    name,
    originalLocation,
    originalPath,
    dateDeletedText: normalizeWindowsShellDateText(item?.dateDeletedText),
    sizeText: String(item?.sizeText || ""),
    type: String(item?.type || ""),
    kind: item?.isDirectory ? "Folder" : String(item?.type || "File"),
    isDirectory: Boolean(item?.isDirectory),
    isFile: !item?.isDirectory,
    size: Number.isFinite(size) ? size : 0,
    modifiedText: String(item?.modifiedText || ""),
    index: Number(item?.index ?? index)
  };
}

async function listWindowsRecycleBin(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 1000), 5000));
  if (process.platform !== "win32") {
    return {
      available: false,
      reason: "Windows Recycle Bin is only available on Windows.",
      total: 0,
      count: 0,
      bytes: 0,
      truncated: false,
      items: []
    };
  }
  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
$Payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
$Limit = [Math]::Max(1, [int]$Payload.limit)
$Shell = New-Object -ComObject Shell.Application
$Bin = $Shell.Namespace(10)
if (-not $Bin) {
  [pscustomobject]@{
    available = $false
    reason = "Could not open Windows Recycle Bin namespace."
    total = 0
    count = 0
    bytes = 0
    truncated = $false
    items = @()
  } | ConvertTo-Json -Compress -Depth 6
  exit 0
}
function Get-DetailText($Folder, $Item, $Index) {
  try {
    return [string]$Folder.GetDetailsOf($Item, $Index)
  } catch {
    return ""
  }
}
function Get-RecycleItemName($Item) {
  $Name = [string]$Item.Name
  $Path = [string]$Item.Path
  if (-not [bool]$Item.IsFolder) {
    $Extension = [System.IO.Path]::GetExtension($Path)
    if ($Extension -and -not $Name.EndsWith($Extension, [System.StringComparison]::OrdinalIgnoreCase)) {
      $Name = $Name + $Extension
    }
  }
  return $Name
}
$Items = New-Object System.Collections.Generic.List[object]
$Total = 0
$Bytes = [int64]0
foreach ($Item in @($Bin.Items())) {
  $Total += 1
  $Size = [int64]0
  try { $Size = [int64]$Item.Size } catch { $Size = 0 }
  $Bytes += $Size
  if ($Items.Count -ge $Limit) {
    continue
  }
  $Name = Get-RecycleItemName $Item
  $Path = [string]$Item.Path
  $OriginalLocation = Get-DetailText $Bin $Item 1
  $OriginalPath = ""
  if ($OriginalLocation -and $Name) {
    try { $OriginalPath = [System.IO.Path]::Combine($OriginalLocation, $Name) } catch { $OriginalPath = "" }
  }
  $Items.Add([pscustomobject]@{
    id = $Path
    path = $Path
    name = $Name
    originalLocation = $OriginalLocation
    originalPath = $OriginalPath
    dateDeletedText = Get-DetailText $Bin $Item 2
    sizeText = Get-DetailText $Bin $Item 3
    type = [string]$Item.Type
    isDirectory = [bool]$Item.IsFolder
    size = $Size
    modifiedText = [string]$Item.ModifyDate
    index = $Total - 1
  }) | Out-Null
}
[pscustomobject]@{
  available = $true
  total = $Total
  count = $Items.Count
  bytes = $Bytes
  truncated = $Total -gt $Items.Count
  items = $Items
} | ConvertTo-Json -Compress -Depth 8
`;
  const result = await runPowerShellPayload(script, { limit }, { sta: true });
  const parsed = parsePowerShellJson(result, {});
  const sourceItems = Array.isArray(parsed.items) ? parsed.items : parsed.items ? [parsed.items] : [];
  const items = sourceItems.map(normalizeWindowsRecycleItem).filter((item) => item.path);
  return {
    available: parsed.available !== false,
    reason: parsed.reason ? String(parsed.reason) : "",
    total: Number(parsed.total || items.length),
    count: Number(parsed.count || items.length),
    bytes: Number(parsed.bytes || items.reduce((sum, item) => sum + Number(item.size || 0), 0)),
    truncated: Boolean(parsed.truncated),
    items
  };
}

async function restoreWindowsRecycleBinItems(body = {}, hooks = {}) {
  const paths = (Array.isArray(body.paths) ? body.paths : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 200);
  if (!paths.length) {
    throw new Error("Select Windows Recycle Bin items to restore.");
  }
  const dryRun = body.dryRun === true;
  if (process.platform !== "win32") {
    throw new Error("Windows Recycle Bin restore is only available on Windows.");
  }
  await hooks.updateProgress?.({ unit: "items", total: paths.length, completed: 0, phase: dryRun ? "Checking" : "Restoring" });
  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
$Payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
$Shell = New-Object -ComObject Shell.Application
$Bin = $Shell.Namespace(10)
if (-not $Bin) {
  throw "Could not open Windows Recycle Bin namespace."
}
$Requested = @($Payload.paths | ForEach-Object { [string]$_ })
$DryRun = [bool]$Payload.dryRun
$ByPath = @{}
foreach ($Item in @($Bin.Items())) {
  $ByPath[[string]$Item.Path] = $Item
}
function Get-RecycleItemName($Item) {
  $Name = [string]$Item.Name
  $Path = [string]$Item.Path
  if (-not [bool]$Item.IsFolder) {
    $Extension = [System.IO.Path]::GetExtension($Path)
    if ($Extension -and -not $Name.EndsWith($Extension, [System.StringComparison]::OrdinalIgnoreCase)) {
      $Name = $Name + $Extension
    }
  }
  return $Name
}
$Matched = New-Object System.Collections.Generic.List[object]
$Restored = New-Object System.Collections.Generic.List[object]
$Missing = New-Object System.Collections.Generic.List[string]
foreach ($Path in $Requested) {
  if (-not $ByPath.ContainsKey($Path)) {
    $Missing.Add($Path) | Out-Null
    continue
  }
  $Item = $ByPath[$Path]
  $Record = [pscustomobject]@{
    path = [string]$Item.Path
    name = Get-RecycleItemName $Item
    originalLocation = [string]$Bin.GetDetailsOf($Item, 1)
    dateDeletedText = [string]$Bin.GetDetailsOf($Item, 2)
  }
  $Matched.Add($Record) | Out-Null
  if (-not $DryRun) {
    $Verb = @($Item.Verbs()) | Where-Object { (($_.Name -replace "&", "").Trim()) -ieq "Restore" } | Select-Object -First 1
    if ($Verb) {
      $Verb.DoIt()
    } else {
      $Item.InvokeVerb("restore")
    }
    $Restored.Add($Record) | Out-Null
  }
}
[pscustomobject]@{
  dryRun = $DryRun
  requested = $Requested.Count
  matched = $Matched
  restored = $Restored
  missing = $Missing
} | ConvertTo-Json -Compress -Depth 8
`;
  const result = await runPowerShellPayload(script, { paths, dryRun }, { sta: true });
  const parsed = parsePowerShellJson(result, {});
  const matched = Array.isArray(parsed.matched) ? parsed.matched : parsed.matched ? [parsed.matched] : [];
  const restored = Array.isArray(parsed.restored) ? parsed.restored : parsed.restored ? [parsed.restored] : [];
  const missing = Array.isArray(parsed.missing) ? parsed.missing.map(String) : parsed.missing ? [String(parsed.missing)] : [];
  await hooks.updateProgress?.({
    unit: "items",
    total: paths.length,
    completed: dryRun ? matched.length : restored.length,
    phase: dryRun ? "Checked" : "Restored"
  });
  return {
    result: {
      dryRun,
      requested: paths.length,
      matched,
      restored,
      missing,
      undoAvailable: false,
      restoreHint: dryRun ? "" : "Restored through the Windows Recycle Bin shell namespace."
    },
    undo: null
  };
}

async function restoreAppTrashItems(body) {
  const paths = Array.isArray(body.paths) ? body.paths.slice(0, 200).map(resolveTrashItemPath) : [];
  if (!paths.length) {
    throw new Error("Select trash items to restore.");
  }
  const targetDir = resolveUserPath(body.targetDir);
  const targetStats = await fs.stat(targetDir);
  if (!targetStats.isDirectory()) {
    throw new Error("Restore target must be a folder.");
  }
  const restored = [];
  for (const itemPath of paths) {
    const dest = await moveToExactOrUnique(itemPath, path.join(targetDir, path.basename(itemPath)));
    restored.push({ from: itemPath, dest, batchPath: path.dirname(itemPath) });
  }
  await updateLabelsForTransfers(
    restored.map((item) => ({ source: item.from, dest: item.dest })),
    "move"
  );
  for (const batchPath of new Set(restored.map((item) => item.batchPath))) {
    await removeEmptyTrashBatch(batchPath);
  }
  return {
    result: { restored, targetDir },
    undo: {
      type: "move-back",
      items: restored.map((item) => ({ from: item.dest, to: item.from }))
    }
  };
}

async function deleteAppTrashItems(body) {
  const paths = Array.isArray(body.paths) ? body.paths.slice(0, 200).map(resolveTrashItemPath) : [];
  if (!paths.length) {
    throw new Error("Select trash items to delete.");
  }
  const deleted = [];
  for (const itemPath of paths) {
    await fs.rm(itemPath, { recursive: true, force: true });
    deleted.push(itemPath);
  }
  for (const batchPath of new Set(paths.map((itemPath) => path.dirname(itemPath)))) {
    await removeEmptyTrashBatch(batchPath);
  }
  return { deleted };
}

async function uniquePathWithReserved(parent, basename, reservedKeys) {
  const parsed = path.parse(basename);
  let candidate = path.join(parent, basename);
  let index = 2;
  while ((await pathExists(candidate)) || reservedKeys.has(pathIdentity(candidate))) {
    const suffix = parsed.ext
      ? `${parsed.name} copy ${index}${parsed.ext}`
      : `${basename} copy ${index}`;
    candidate = path.join(parent, suffix);
    index += 1;
  }
  return candidate;
}

function transferMode(value) {
  return value === "move" ? "move" : "copy";
}

function transferConflictMode(value) {
  return normalizeConflictMode(value);
}

function transferItemPolicies(value) {
  const source = value && typeof value === "object" ? value : {};
  const policies = new Map();
  for (const [key, policy] of Object.entries(source)) {
    if (conflictModes.has(policy)) {
      policies.set(resolveUserPath(key), policy);
    }
  }
  return policies;
}

function operationPlanDigest(plan) {
  const itemProjection = (plan.items || []).map((item) => ({
    index: item.index,
    relativePath: item.relativePath || "",
    source: item.source,
    dest: item.dest,
    status: item.status,
    action: item.action,
    risky: item.risky === true,
    conflictMode: item.conflictMode || "",
    existing: item.existing === true,
    destExists: item.destExists === true,
    size: item.size ?? null,
    modified: item.modified ?? null,
    isDirectory: item.isDirectory === true,
    destSize: item.destSize ?? null,
    destModified: item.destModified ?? null,
    destIsDirectory: item.destIsDirectory === true
  }));
  const stable = {
    type: plan.type,
    mode: plan.mode || "",
    direction: plan.direction || "",
    conflictMode: plan.conflictMode || "",
    overwrite: plan.overwrite === true,
    mirrorDeletes: plan.mirrorDeletes === true,
    targetDir: plan.targetDir || "",
    leftPath: plan.leftPath || "",
    rightPath: plan.rightPath || "",
    counts: plan.counts || {},
    actionCounts: plan.actionCounts || {},
    items: itemProjection
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function attachOperationPlanDigest(plan) {
  const planDigest = operationPlanDigest(plan);
  const now = Date.now();
  for (const [token, record] of operationPreviewTokens) {
    if (record.expiresAt <= now || operationPreviewTokens.size > 1000) operationPreviewTokens.delete(token);
  }
  const applyToken = crypto.randomBytes(24).toString("base64url");
  const applyTokenExpiresAt = now + 120000;
  operationPreviewTokens.set(applyToken, { planDigest, expiresAt: applyTokenExpiresAt });
  return { ...plan, planDigest, applyToken, applyTokenExpiresAt: new Date(applyTokenExpiresAt).toISOString() };
}

function expectedOperationPlanDigest(body) {
  const digest = String(body?.expectedPlanDigest || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(digest) ? digest : "";
}

function assertExpectedOperationPlan(plan, body, label = "Operation") {
  const applyToken = String(body?.applyToken || "").trim();
  if (applyToken) {
    const record = operationPreviewTokens.get(applyToken);
    operationPreviewTokens.delete(applyToken);
    if (!record || record.expiresAt <= Date.now()) {
      throw new Error(`${label} preview token expired. Refresh the preview before applying.`);
    }
    if (record.planDigest !== plan.planDigest) {
      throw new Error(`${label} preview changed. Refresh the preview before applying.`);
    }
    return;
  }
  const expectedPlanDigest = expectedOperationPlanDigest(body);
  if (!expectedPlanDigest) {
    return;
  }
  if (plan.planDigest !== expectedPlanDigest) {
    const error = new Error(`${label} preview changed. Refresh the preview before applying.`);
    error.details = {
      expectedPlanDigest,
      actualPlanDigest: plan.planDigest,
      actionCounts: plan.actionCounts,
      counts: plan.counts
    };
    throw error;
  }
}

function requireBrowserApplyToken(req, body) {
  const browserRequest = Boolean(req.headers.origin || req.headers["sec-fetch-site"]);
  if (browserRequest && !String(body?.applyToken || "").trim()) {
    const error = new Error("A current preview token is required before applying this operation.");
    error.status = 403;
    throw error;
  }
}

async function buildTransferPlan(body) {
  const paths = Array.isArray(body.paths) ? body.paths.slice(0, 500).map(resolveUserPath) : [];
  if (!paths.length) {
    throw new Error("Select at least one item to transfer.");
  }

  const targetDir = resolveUserPath(body.targetDir);
  const targetStats = await fs.stat(targetDir);
  if (!targetStats.isDirectory()) {
    throw new Error("Transfer target must be a folder.");
  }

  const mode = transferMode(body.mode);
  const conflictMode = transferConflictMode(body.conflictMode);
  const itemPolicies = transferItemPolicies(body.itemPolicies);
  const sourceKeys = new Set(paths.map(pathIdentity));
  const reservedTargets = new Set();
  const items = [];

  for (let index = 0; index < paths.length; index += 1) {
    const source = paths[index];
    const originalName = path.basename(source);
    const baseDest = path.join(targetDir, originalName);
    let dest = baseDest;
    let status = "ready";
    let reason = "";
    let stats = null;
    let destStats = null;
    let existing = false;
    let effectiveConflictMode = conflictMode;
    let action = mode;
    let risky = false;

    try {
      stats = await fs.stat(source);
      if (stats.isDirectory() && isInsidePath(targetDir, source)) {
        status = "invalid";
        reason = "Target is inside the selected folder.";
        action = "block";
      } else if (mode === "move" && pathIdentity(source) === pathIdentity(baseDest)) {
        status = "unchanged";
        reason = "Already in target folder.";
        action = "unchanged";
      } else {
        try {
          destStats = await fs.stat(baseDest);
          existing = true;
        } catch {
          existing = false;
        }
        effectiveConflictMode = existing ? itemPolicies.get(source) || conflictMode : conflictMode;
        if (existing && effectiveConflictMode === "skip") {
          status = "skip";
          reason = "Destination already exists.";
          action = "skip";
        } else if (existing && effectiveConflictMode === "unique") {
          dest = await uniquePathWithReserved(targetDir, originalName, reservedTargets);
          reason = `Will rename to ${path.basename(dest)}.`;
          action = "rename";
        } else if (existing && effectiveConflictMode === "overwrite") {
          if (sourceKeys.has(pathIdentity(baseDest))) {
            status = "invalid";
            reason = "Destination is also selected as a source.";
            action = "block";
          } else {
            reason = "Will replace existing destination.";
            action = "overwrite";
            risky = true;
          }
        }
      }
    } catch (error) {
      status = "missing";
      reason = error.message || "Source is unavailable.";
      action = "missing";
    }

    if (status === "ready") {
      const targetKey = pathIdentity(dest);
      if (reservedTargets.has(targetKey)) {
        status = "duplicate";
        reason = "Another selected item has the same destination.";
        action = "block";
        risky = false;
      } else {
        reservedTargets.add(targetKey);
      }
    }

    items.push({
      index,
      mode,
      source,
      originalName,
      targetDir,
      dest,
      existing,
      action,
      risky,
      conflictMode: effectiveConflictMode,
      defaultConflictMode: conflictMode,
      hasPolicyOverride: existing && effectiveConflictMode !== conflictMode,
      isDirectory: Boolean(stats?.isDirectory()),
      size: stats && !stats.isDirectory() ? stats.size : null,
      modified: stats ? stats.mtimeMs : null,
      destSize: destStats && !destStats.isDirectory() ? destStats.size : null,
      destModified: destStats ? destStats.mtimeMs : null,
      destIsDirectory: Boolean(destStats?.isDirectory()),
      status,
      reason
    });
  }

  const counts = items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  const actionCounts = items.reduce((acc, item) => {
    acc[item.action] = (acc[item.action] || 0) + 1;
    if (item.risky) {
      acc.risky = (acc.risky || 0) + 1;
    }
    return acc;
  }, {});
  const blockers = new Set(["invalid", "missing", "duplicate"]);

  return attachOperationPlanDigest({
    type: "transfer",
    mode,
    conflictMode,
    targetDir,
    counts,
    actionCounts,
    items,
    canApply: items.some((item) => item.status === "ready") &&
      !items.some((item) => blockers.has(item.status))
  });
}

async function buildSyncPreviewPlan(body) {
  const leftRoot = resolveUserPath(body.leftPath);
  const rightRoot = resolveUserPath(body.rightPath);
  const direction = body.direction === "rightToLeft" ? "rightToLeft" : "leftToRight";
  const overwrite = Boolean(body.overwrite);
  const mirrorDeletes = Boolean(body.mirrorDeletes);
  const relativePaths = Array.isArray(body.items) ? body.items.slice(0, 1000) : [];
  if (!relativePaths.length) {
    throw new Error("Select at least one compare item to sync.");
  }

  const sourceRoot = direction === "leftToRight" ? leftRoot : rightRoot;
  const destRoot = direction === "leftToRight" ? rightRoot : leftRoot;
  const items = [];
  for (let index = 0; index < relativePaths.length; index += 1) {
    const safePath = safeCompareRelativePath(relativePaths[index]);
    const relativePath = safePath.relativePath;
    const rel = safePath.rel;
    const source = resolveRelativeUnderRoot(sourceRoot, rel);
    const dest = resolveRelativeUnderRoot(destRoot, rel);
    let destStats = null;
    let destExists = false;
    try {
      destStats = await fs.stat(dest);
      destExists = true;
    } catch {
      destExists = false;
    }
    let sourceStats = null;
    let status = "ready";
    let action = "copy";
    let reason = destExists ? "Will copy into existing destination." : "Will copy new destination.";
    let risky = false;

    try {
      sourceStats = await fs.stat(source);
      if (destExists && !overwrite) {
        status = "skip";
        action = "skip";
        reason = "Destination exists and overwrite is off.";
      } else if (destExists && overwrite) {
        action = "overwrite";
        reason = "Will replace existing destination.";
        risky = true;
      }
    } catch {
      if (mirrorDeletes && destExists) {
        status = "ready";
        action = "mirror-delete";
        reason = "Source is missing; destination will be moved to App Trash.";
        risky = true;
      } else {
        status = "skip";
        action = "missing-source";
        reason = "Source is missing.";
      }
    }

    items.push({
      index,
      relativePath,
      rel,
      source,
      dest,
      destExists,
      overwrite,
      mirrorDeletes,
      action,
      risky,
      status,
      reason,
      isDirectory: Boolean(sourceStats?.isDirectory()),
      size: sourceStats && !sourceStats.isDirectory() ? sourceStats.size : null,
      modified: sourceStats ? sourceStats.mtimeMs : null,
      destSize: destStats && !destStats.isDirectory() ? destStats.size : null,
      destModified: destStats ? destStats.mtimeMs : null,
      destIsDirectory: Boolean(destStats?.isDirectory())
    });
  }

  const counts = items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  const actionCounts = items.reduce((acc, item) => {
    acc[item.action] = (acc[item.action] || 0) + 1;
    if (item.risky) {
      acc.risky = (acc.risky || 0) + 1;
    }
    return acc;
  }, {});

  return attachOperationPlanDigest({
    type: "sync",
    direction,
    overwrite,
    mirrorDeletes,
    leftPath: leftRoot,
    rightPath: rightRoot,
    sourceRoot,
    destRoot,
    counts,
    actionCounts,
    items,
    canApply: items.some((item) => item.status === "ready")
  });
}

async function buildOperationPreview(body) {
  const type = String(body?.type || "");
  if (type === "copy" || type === "move") {
    const plan = await buildTransferPlan({
      ...body,
      mode: type,
      conflictMode: body.conflictMode || "unique"
    });
    return attachOperationPlanDigest({ ...plan, type });
  }
  if (type === "transfer") {
    return buildTransferPlan(body);
  }
  if (type === "sync") {
    return buildSyncPreviewPlan(body);
  }
  throw new Error("Unsupported operation preview type.");
}

async function moveExact(source, dest, options = {}) {
  const src = resolveUserPath(source);
  const target = resolveUserPath(dest);
  await fs.mkdir(path.dirname(target), { recursive: true });
  try {
    if (testForceCrossVolumeMove) {
      const injected = new Error("Injected cross-volume move.");
      injected.code = "EXDEV";
      throw injected;
    }
    await fs.rename(src, target);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
    await copyToStagingAndCommit(src, target, options);
    await removeCommittedMoveSource(src, target);
  }
  return target;
}

async function applyTransfer(body, hooks = {}) {
  const plan = await buildTransferPlan(body);
  assertExpectedOperationPlan(plan, body, "Transfer");
  const blockers = plan.items.filter((item) => ["invalid", "missing", "duplicate"].includes(item.status));
  if (blockers.length) {
    const error = new Error("Transfer has conflicts. Review the preview before applying.");
    error.details = { blockers };
    throw error;
  }

  const ready = plan.items.filter((item) => item.status === "ready");
  if (!ready.length) {
    throw new Error("No selected items would be transferred.");
  }

  const backupDir = path.join(
    trashRoot,
    `transfer-backups-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto
      .randomBytes(3)
      .toString("hex")}`
  );
  const applied = [];
  let activeIndex = 0;
  try {
    await hooks.updateProgress?.({ unit: "items", total: ready.length, completed: 0, phase: "Scanning" });
    const progressState = createCopyProgressState(
      await scanCopyFootprints(
        ready.map((item) => item.source),
        hooks,
        (itemPath, index) => {
          activeIndex = index;
        }
      )
    );
    await updateCopyProgress(hooks, progressState, { unit: "items", total: ready.length, completed: 0, phase: "Preparing" });

    for (const [index, item] of ready.entries()) {
      activeIndex = index;
      const progressFields = () => ({
        unit: "items",
        total: ready.length,
        completed: index,
        phase: plan.mode === "copy" ? "Copying" : "Moving",
        current: item.originalName || labelFromPath(item.source),
        currentPath: item.source
      });
      await updateCopyProgress(hooks, progressState, progressFields());
      let backup = null;
      if (item.conflictMode === "overwrite" && (await pathExists(item.dest))) {
        await fs.mkdir(backupDir, { recursive: true });
        backup = await moveOne(item.dest, backupDir);
      }

      try {
        if (plan.mode === "copy") {
          await fs.mkdir(path.dirname(item.dest), { recursive: true });
          await copyToStagingAndCommit(item.source, item.dest, { hooks, progressState, progressFields });
        } else {
          await moveExact(item.source, item.dest, { hooks, progressState, progressFields });
        }
      } catch (error) {
        if (backup && (await pathExists(backup)) && !error.details?.sourceRemovalPending) {
          await fs.rm(item.dest, { recursive: true, force: true }).catch(() => {});
          await moveToExactOrUnique(backup, item.dest);
        }
        throw error;
      }

      applied.push({
        mode: plan.mode,
        source: item.source,
        dest: item.dest,
        backup,
        originalName: item.originalName
      });
      await updateCopyProgress(hooks, progressState, {
        unit: "items",
        total: ready.length,
        completed: index + 1,
        phase: plan.mode === "copy" ? "Copied" : "Moved",
        current: item.originalName || labelFromPath(item.source),
        currentPath: item.source
      });
      await checkpointRecovery(
        hooks,
        operationRecoveryDetails({
          type: "transfer",
          body,
          resolvedSources: ready.map((readyItem) => readyItem.source),
          completedItems: applied,
          failedIndex: index + 1,
          error: interruptedCheckpointError(),
          result: {
            mode: plan.mode,
            conflictMode: plan.conflictMode,
            transferred: applied.map((appliedItem) => appliedItem.dest),
            copied: plan.mode === "copy" ? applied.map((appliedItem) => appliedItem.dest) : [],
            moved: plan.mode === "move" ? applied.map((appliedItem) => appliedItem.dest) : [],
            items: applied
          }
        })
      );
    }

    await updateCopyProgress(hooks, progressState, { unit: "items", total: ready.length, completed: ready.length, phase: "Updating labels" });
    await updateLabelsForTransfers(applied, plan.mode);
    await updateCopyProgress(hooks, progressState, { unit: "items", total: ready.length, completed: ready.length, phase: "Completed" });
    const skipped = plan.items.filter((item) => item.status === "skip" || item.status === "unchanged");
    return {
      result: {
        mode: plan.mode,
        conflictMode: plan.conflictMode,
        transferred: applied.map((item) => item.dest),
        copied: plan.mode === "copy" ? applied.map((item) => item.dest) : [],
        moved: plan.mode === "move" ? applied.map((item) => item.dest) : [],
        skipped,
        items: applied
      },
      undo: {
        type: "transfer",
        items: applied.map((item) => ({
          mode: item.mode,
          source: item.source,
          dest: item.dest,
          backup: item.backup
        }))
      }
    };
  } catch (error) {
    const transactionFailure = error.details;
    const details = operationRecoveryDetails({
      type: "transfer",
      body,
      resolvedSources: ready.map((item) => item.source),
      completedItems: applied,
      failedIndex: activeIndex,
      error,
      result: {
        mode: plan.mode,
        conflictMode: plan.conflictMode,
        transferred: applied.map((item) => item.dest),
        copied: plan.mode === "copy" ? applied.map((item) => item.dest) : [],
        moved: plan.mode === "move" ? applied.map((item) => item.dest) : [],
        items: applied
      }
    });
    if (transactionFailure?.transaction) {
      details.transaction = transactionFailure.transaction;
      details.recovery = {
        ...details.recovery,
        transaction: transactionFailure.transaction,
        sourceRemovalPending: transactionFailure.sourceRemovalPending === true,
        destinationCommitted: transactionFailure.destinationCommitted === true,
        pendingSource: transactionFailure.source || null,
        committedDestination: transactionFailure.dest || null,
        reconciliationActions: transactionFailure.sourceRemovalPending
          ? ["remove-source", "keep-destination"]
          : ["restore-original", "retry"]
      };
    }
    error.details = details;
    throw error;
  }
}

function validateBulkName(name) {
  const text = String(name || "").trim();
  if (!text || text.includes("/") || text.includes("\\") || text.includes(":")) {
    return "Use a plain name without path separators.";
  }
  if (process.platform === "win32" && /[<>:"|?*\x00-\x1F]/.test(text)) {
    return "Name contains a Windows-reserved character.";
  }
  if ([".", ".."].includes(text)) {
    return "Name is reserved.";
  }
  return "";
}

function applyBulkCase(value, mode) {
  if (mode === "lower") return value.toLowerCase();
  if (mode === "upper") return value.toUpperCase();
  if (mode === "title") {
    return value.toLowerCase().replace(/\b([a-z])/g, (match) => match.toUpperCase());
  }
  return value;
}

function bulkNumber(index, options) {
  const start = Number.isFinite(Number(options.numberStart)) ? Number(options.numberStart) : 1;
  const width = Math.max(1, Math.min(Number(options.numberPad || 2), 12));
  return String(start + index).padStart(width, "0");
}

function transformBulkName(originalName, isDirectory, options, index) {
  const preserveExtension = options.preserveExtension !== false;
  const parsed = path.parse(originalName);
  const extension = preserveExtension && !isDirectory ? parsed.ext : "";
  const sourceStem = preserveExtension && !isDirectory ? parsed.name : originalName;
  let stem = sourceStem;
  const find = String(options.find || "");

  if (find) {
    const replacement = String(options.replace || "");
    if (options.useRegex) {
      const flags = options.matchCase ? "g" : "gi";
      stem = stem.replace(new RegExp(find, flags), replacement);
    } else {
      const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const flags = options.matchCase ? "g" : "gi";
      stem = stem.replace(new RegExp(escaped, flags), replacement);
    }
  }

  stem = applyBulkCase(stem, options.caseMode);
  stem = `${String(options.prefix || "")}${stem}${String(options.suffix || "")}`;

  const numberPosition = options.numberPosition === "prefix" || options.numberPosition === "suffix"
    ? options.numberPosition
    : "none";
  if (numberPosition !== "none") {
    const separator = String(options.numberSeparator ?? "-");
    const number = bulkNumber(index, options);
    stem = numberPosition === "prefix" ? `${number}${separator}${stem}` : `${stem}${separator}${number}`;
  }

  return `${stem}${extension}`;
}

async function uniqueTemporaryRenamePath(parent, index) {
  const token = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}-${index}`;
  return uniquePath(parent, `.~eb-rename-${token}.tmp`);
}

async function buildBulkRenamePlan(body) {
  const paths = Array.isArray(body.paths) ? body.paths.slice(0, 500) : [];
  if (!paths.length) {
    throw new Error("Select at least one item to rename.");
  }

  const options = body.options && typeof body.options === "object" ? body.options : {};
  const items = [];
  const targetCounts = new Map();
  const sourceKeys = new Set();

  for (let index = 0; index < paths.length; index += 1) {
    const source = resolveUserPath(paths[index]);
    const parent = path.dirname(source);
    const originalName = path.basename(source);
    sourceKeys.add(pathIdentity(source));
    let stats = null;
    let newName = originalName;
    let dest = source;
    let status = "ready";
    let reason = "";

    try {
      stats = await fs.stat(source);
      newName = transformBulkName(originalName, stats.isDirectory(), options, index);
      reason = validateBulkName(newName);
      dest = path.join(parent, newName);
      if (reason) {
        status = "invalid";
      } else if (pathIdentity(source) === pathIdentity(dest) && originalName === newName) {
        status = "unchanged";
      }
    } catch (error) {
      status = "missing";
      reason = error.message || "Item is unavailable.";
    }

    const targetKey = pathIdentity(dest);
    if (status === "ready") {
      targetCounts.set(targetKey, (targetCounts.get(targetKey) || 0) + 1);
    }

    items.push({
      index,
      source,
      parent,
      originalName,
      newName,
      dest,
      isDirectory: Boolean(stats?.isDirectory()),
      status,
      reason,
      size: stats && !stats.isDirectory() ? stats.size : null,
      modified: stats ? stats.mtimeMs : null
    });
  }

  for (const item of items) {
    if (item.status !== "ready") {
      continue;
    }
    const targetKey = pathIdentity(item.dest);
    if ((targetCounts.get(targetKey) || 0) > 1) {
      item.status = "duplicate";
      item.reason = "Another selected item has the same target name.";
      continue;
    }
    if ((await pathExists(item.dest)) && !sourceKeys.has(targetKey)) {
      item.status = "collision";
      item.reason = "A file or folder with that name already exists.";
    }
  }

  const counts = items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});

  return {
    options,
    counts,
    items,
    canApply: items.some((item) => item.status === "ready") &&
      !items.some((item) => ["invalid", "duplicate", "collision", "missing"].includes(item.status))
  };
}

async function applyBulkRename(body) {
  const plan = await buildBulkRenamePlan(body);
  const blockers = plan.items.filter((item) =>
    ["invalid", "duplicate", "collision", "missing"].includes(item.status)
  );
  if (blockers.length) {
    const error = new Error("Bulk rename has conflicts. Review the preview before applying.");
    error.details = { blockers };
    throw error;
  }

  const ready = plan.items.filter((item) => item.status === "ready");
  if (!ready.length) {
    throw new Error("No selected items would be renamed.");
  }

  const staged = [];
  const applied = [];
  try {
    for (const item of ready) {
      const temp = await uniqueTemporaryRenamePath(item.parent, item.index);
      await fs.rename(item.source, temp);
      staged.push({ ...item, temp });
    }

    for (const item of staged) {
      await fs.rename(item.temp, item.dest);
      applied.push({ source: item.source, dest: item.dest, originalName: item.originalName, newName: item.newName });
    }
  } catch (error) {
    for (const item of [...applied].reverse()) {
      if (await pathExists(item.dest)) {
        await moveToExactOrUnique(item.dest, item.source);
      }
    }
    for (const item of [...staged].reverse()) {
      if (await pathExists(item.temp)) {
        await moveToExactOrUnique(item.temp, item.source);
      }
    }
    throw error;
  }

  await updateLabelsForTransfers(applied, "move");
  return {
    result: { renamed: applied.map((item) => item.dest), items: applied, skipped: plan.items.filter((item) => item.status === "unchanged") },
    undo: {
      type: "bulk-rename-back",
      items: applied.map((item) => ({ from: item.dest, to: item.source }))
    }
  };
}

async function restoreBulkRenameItems(items) {
  const moves = Array.isArray(items) ? items : [];
  const sourceKeys = new Set(moves.map((item) => pathIdentity(item.from)));
  const staged = [];
  const restored = [];

  try {
    for (let index = 0; index < moves.length; index += 1) {
      const move = moves[index];
      const from = resolveUserPath(move.from);
      let to = resolveUserPath(move.to);
      if (!(await pathExists(from))) {
        continue;
      }
      if ((await pathExists(to)) && !sourceKeys.has(pathIdentity(to))) {
        to = await uniquePath(path.dirname(to), path.basename(to));
      }
      const temp = await uniqueTemporaryRenamePath(path.dirname(from), index);
      await fs.rename(from, temp);
      staged.push({ from, temp, to });
    }

    for (const item of staged) {
      await fs.rename(item.temp, item.to);
      restored.push({ from: item.from, dest: item.to });
    }
  } catch (error) {
    for (const item of [...restored].reverse()) {
      if (await pathExists(item.dest)) {
        await moveToExactOrUnique(item.dest, item.from);
      }
    }
    for (const item of [...staged].reverse()) {
      if (await pathExists(item.temp)) {
        await moveToExactOrUnique(item.temp, item.from);
      }
    }
    throw error;
  }

  await updateLabelsForTransfers(
    restored.map((item) => ({ source: item.from, dest: item.dest })),
    "move"
  );
  return restored;
}

function backupRecoveryAction(value) {
  return value === "discard" ? "discard" : "restore";
}

function backupRecoveryHandled(item) {
  const action = item?.backupRecovery?.action;
  return action === "restored" || action === "discarded";
}

function backupRecoveryOperationType(operation) {
  const type = operation?.undo?.type;
  return type === "transfer" || type === "sync-copy" ? type : null;
}

function selectedBackupRecoveryRefs(operation, indexes) {
  const undoType = backupRecoveryOperationType(operation);
  if (!undoType) {
    throw new Error("That operation does not have overwrite backups.");
  }
  if (operation.undo.appliedAt) {
    throw new Error("That operation has already been undone.");
  }
  const selected = new Set(
    (Array.isArray(indexes) ? indexes : [])
      .map((index) => Number(index))
      .filter((index) => Number.isInteger(index) && index >= 0)
  );
  if (!selected.size) {
    throw new Error("Select at least one backup item.");
  }
  return (operation.undo.items || [])
    .map((item, index) => ({ item, index, undoType }))
    .filter(({ item, index }) => selected.has(index) && item?.backup && !backupRecoveryHandled(item));
}

async function restoreOperationBackupItem(ref) {
  const { item, index, undoType } = ref;
  const backup = resolveUserPath(item.backup);
  const dest = resolveUserPath(item.dest);
  if (!(await pathExists(backup))) {
    return { index, action: "restore", backup, dest, error: "Backup is missing." };
  }

  const result = {
    index,
    action: "restore",
    mode: undoType === "transfer" ? item.mode || "copy" : "sync",
    backup,
    dest
  };

  if (undoType === "transfer" && item.mode === "move") {
    if (await pathExists(dest)) {
      const restoredSource = await moveToExactOrUnique(dest, item.source);
      await updateLabelsForTransfers([{ source: dest, dest: restoredSource }], "move");
      result.replacementRestoredTo = restoredSource;
    } else {
      result.replacementMissing = true;
    }
  } else if (await pathExists(dest)) {
    const trashed = await trashPaths([dest]);
    result.replacementTrashed = trashed.result.trashDir;
    result.replacementTrashItems = trashed.result.items;
  } else {
    result.replacementMissing = true;
  }

  const restored = await moveToExactOrUnique(backup, dest);
  await updateLabelsForTransfers([{ source: backup, dest: restored }], "move");
  result.restored = restored;
  item.backupRecovery = {
    ...result,
    action: "restored",
    handledAt: new Date().toISOString()
  };
  return result;
}

async function discardOperationBackupItem(ref) {
  const { item, index, undoType } = ref;
  const backup = resolveUserPath(item.backup);
  const result = {
    index,
    action: "discard",
    mode: undoType === "transfer" ? item.mode || "copy" : "sync",
    backup,
    dest: item.dest ? resolveUserPath(item.dest) : null
  };
  if (await pathExists(backup)) {
    await fs.rm(backup, { recursive: true, force: true });
    await clearPathLabelsUnder([backup]).catch(() => {});
    await removeEmptyTrashBatch(path.dirname(backup)).catch(() => {});
    result.discarded = backup;
  } else {
    result.backupMissing = true;
  }
  item.backupRecovery = {
    ...result,
    action: "discarded",
    handledAt: new Date().toISOString()
  };
  return result;
}

async function recoverOperationBackups(operation, body = {}, hooks = {}) {
  if (!operation || !operation.undo) {
    throw new Error("That operation does not have overwrite backups.");
  }
  const action = backupRecoveryAction(body.action);
  const refs = selectedBackupRecoveryRefs(operation, body.indexes);
  if (!refs.length) {
    throw new Error("Selected backup items have already been handled or are unavailable.");
  }

  await hooks.updateProgress?.({ unit: "items", total: refs.length, completed: 0, phase: "Recovering backups" });
  const items = [];
  for (const [offset, ref] of refs.entries()) {
    await hooks.updateProgress?.({
      unit: "items",
      total: refs.length,
      completed: offset,
      phase: action === "discard" ? "Keeping replacement" : "Restoring original",
      current: labelFromPath(ref.item.dest || ref.item.backup),
      currentPath: ref.item.dest || ref.item.backup
    });
    const result = action === "discard" ? await discardOperationBackupItem(ref) : await restoreOperationBackupItem(ref);
    items.push(result);
    await hooks.updateProgress?.({
      unit: "items",
      total: refs.length,
      completed: offset + 1,
      phase: result.error ? "Skipped backup" : "Recovered backup",
      current: labelFromPath(ref.item.dest || ref.item.backup),
      currentPath: ref.item.dest || ref.item.backup
    });
  }

  operation.undo.backupRecoveryUpdatedAt = new Date().toISOString();
  operation.undo.backupRecoveryHistory = [
    {
      action,
      at: operation.undo.backupRecoveryUpdatedAt,
      indexes: refs.map((ref) => ref.index),
      items
    },
    ...(operation.undo.backupRecoveryHistory || [])
  ].slice(0, 20);

  const failed = items.filter((item) => item.error);
  return {
    result: {
      operationId: operation.id,
      action,
      handled: items.length - failed.length,
      failed: failed.length,
      items
    },
    undo: null
  };
}

async function undoRecordedOperation(operation) {
  if (!operation || !operation.undo) {
    throw new Error("That operation does not have an undo action.");
  }

  if (operation.undo.appliedAt) {
    throw new Error("That operation has already been undone.");
  }

  const undo = operation.undo;
  const restored = [];

  if (undo.type === "trash-created") {
    const paths = undo.items.map((item) => item.path);
    const trashed = await trashPaths(paths);
    operation.undo.appliedAt = new Date().toISOString();
    operation.undo.result = trashed.result;
    return { result: { undone: operation.id, trashed: trashed.result }, undo: null };
  }

  if (undo.type === "text-write-restore") {
    const target = resolveUserPath(undo.path);
    const backup = resolveUserPath(undo.backup);
    if (!(await pathExists(backup))) {
      throw new Error("The transactional text backup is no longer available.");
    }
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(backup, target);
    operation.undo.appliedAt = new Date().toISOString();
    operation.undo.result = { restored: target };
    return { result: { undone: operation.id, restored: target }, undo: null };
  }

  if (undo.type === "move-back" || undo.type === "restore-trash") {
    for (const item of undo.items) {
      const dest = await moveToExactOrUnique(item.from, item.to);
      restored.push({ from: item.from, dest });
    }
    await updateLabelsForTransfers(
      restored.map((item) => ({ source: item.from, dest: item.dest })),
      "move"
    );
    operation.undo.appliedAt = new Date().toISOString();
    operation.undo.result = restored;
    return { result: { undone: operation.id, restored }, undo: null };
  }

  if (undo.type === "rename-back") {
    const dest = await moveToExactOrUnique(undo.from, undo.to);
    await updateLabelsForTransfers([{ source: undo.from, dest }], "move");
    operation.undo.appliedAt = new Date().toISOString();
    operation.undo.result = { dest };
    return { result: { undone: operation.id, restored: [{ from: undo.from, dest }] }, undo: null };
  }

  if (undo.type === "bulk-rename-back") {
    const restored = await restoreBulkRenameItems(undo.items);
    operation.undo.appliedAt = new Date().toISOString();
    operation.undo.result = restored;
    return { result: { undone: operation.id, restored }, undo: null };
  }

  if (undo.type === "attributes-restore") {
    const restored = [];
    for (const item of undo.items || []) {
      await setWindowsAttributesForPath(item.path, modesFromAttributeState(item.attributes));
      restored.push(await readEditableAttributes(item.path));
    }
    operation.undo.appliedAt = new Date().toISOString();
    operation.undo.result = restored;
    return { result: { undone: operation.id, restored }, undo: null };
  }

  if (undo.type === "timestamps-restore") {
    const restored = await setWindowsTimestampsForItems(
      (undo.items || []).map((item) => ({
        path: item.path,
        timestamps: normalizeTimestampUpdates(item.timestamps)
      }))
    );
    operation.undo.appliedAt = new Date().toISOString();
    operation.undo.result = restored;
    return { result: { undone: operation.id, restored }, undo: null };
  }

  if (undo.type === "transfer") {
    const reverted = [];
    for (const item of [...undo.items].reverse()) {
      if (backupRecoveryHandled(item)) {
        reverted.push({ dest: item.dest, backup: item.backup, skipped: item.backupRecovery.action });
        continue;
      }
      if (item.backup && !(await pathExists(item.backup))) {
        reverted.push({ dest: item.dest, backup: item.backup, missing: true });
        continue;
      }
      if (item.mode === "copy") {
        if (await pathExists(item.dest)) {
          const trashed = await trashPaths([item.dest]);
          reverted.push({ dest: item.dest, trashed: trashed.result.trashDir });
        }
      } else if (await pathExists(item.dest)) {
        const restored = await moveToExactOrUnique(item.dest, item.source);
        await updateLabelsForTransfers([{ source: item.dest, dest: restored }], "move");
        reverted.push({ dest: item.dest, restored });
      }

      if (item.backup) {
        const restoredBackup = await moveToExactOrUnique(item.backup, item.dest);
        await updateLabelsForTransfers([{ source: item.backup, dest: restoredBackup }], "move");
        reverted.push({ backup: item.backup, restored: restoredBackup });
      }
    }
    operation.undo.appliedAt = new Date().toISOString();
    operation.undo.result = reverted;
    return { result: { undone: operation.id, reverted }, undo: null };
  }

  if (undo.type === "sync-copy") {
    const reverted = [];
    for (const item of [...(undo.items || [])].reverse()) {
      if (backupRecoveryHandled(item)) {
        reverted.push({ dest: item.dest, backup: item.backup, skipped: item.backupRecovery.action });
        continue;
      }
      if (item.backup && !(await pathExists(item.backup))) {
        reverted.push({ dest: item.dest, backup: item.backup, missing: true });
        continue;
      }
      if (await pathExists(item.dest)) {
        const trashed = await trashPaths([item.dest]);
        reverted.push({ dest: item.dest, trashed: trashed.result.trashDir });
      }
      if (item.backup) {
        const restored = await moveToExactOrUnique(item.backup, item.dest);
        await updateLabelsForTransfers([{ source: item.backup, dest: restored }], "move");
        reverted.push({ backup: item.backup, restored });
      }
    }
    const restoredDeletes = [];
    for (const item of [...(undo.deleted || [])].reverse()) {
      if (await pathExists(item.from)) {
        const restored = await moveToExactOrUnique(item.from, item.to);
        restoredDeletes.push({ from: item.from, restored });
      }
    }
    if (restoredDeletes.length) {
      await updateLabelsForTransfers(
        restoredDeletes.map((item) => ({ source: item.from, dest: item.restored })),
        "move"
      );
      reverted.push(...restoredDeletes);
    }
    operation.undo.appliedAt = new Date().toISOString();
    operation.undo.result = reverted;
    return { result: { undone: operation.id, reverted }, undo: null };
  }

  if (undo.type === "restore-text") {
    const file = resolveUserPath(undo.path);
    await fs.writeFile(file, String(undo.content ?? ""), "utf8");
    const stats = await fs.stat(file);
    operation.undo.appliedAt = new Date().toISOString();
    operation.undo.result = { path: file, bytes: stats.size, modified: stats.mtimeMs };
    return { result: { undone: operation.id, restored: file }, undo: null };
  }

  throw new Error(`Unsupported undo action: ${undo.type}`);
}

function escapeReg(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function integrationPaths() {
  return defaultState().integration;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function restoreRegValueLine(name, snapshot) {
  const prefix = name ? `"${escapeReg(name)}"` : "@";
  if (snapshot?.valueExists && typeof snapshot.value === "string") {
    return `${prefix}="${escapeReg(snapshot.value)}"`;
  }
  return `${prefix}=-`;
}

function registryFileKey(key) {
  return String(key).replace(/^HKCU\\/i, "HKEY_CURRENT_USER\\");
}

async function registryKeyExists(key) {
  const result = await runProcess("reg.exe", ["query", key]);
  return result.code === 0;
}

function parseRegistryValue(stdout, name = null) {
  const label = name || "(Default)";
  const pattern = new RegExp(`^\\s*${escapeRegex(label)}\\s+(REG_\\w+)\\s*(.*)$`, "i");
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }
    const type = match[1];
    const value = (match[2] || "").trim();
    if (!value || value === "(value not set)") {
      return { valueExists: false, type, value: null };
    }
    return { valueExists: true, type, value };
  }
  return { valueExists: false, type: null, value: null };
}

async function readRegistryValueSnapshot(key, name = null) {
  const keyExists = await registryKeyExists(key);
  if (!keyExists) {
    return { keyExists: false, valueExists: false, type: null, value: null };
  }
  const args = ["query", key, name ? "/v" : "/ve"];
  if (name) {
    args.push(name);
  }
  const result = await runProcess("reg.exe", args);
  if (result.code !== 0) {
    return { keyExists: true, valueExists: false, type: null, value: null };
  }
  return { keyExists: true, ...parseRegistryValue(result.stdout, name) };
}

async function createShellRegistryEntry(spec) {
  const keyExists = await registryKeyExists(spec.key);
  const values = {};
  for (const valueSpec of spec.values) {
    values[valueSpec.id] = await readRegistryValueSnapshot(spec.key, valueSpec.name);
  }
  return {
    id: spec.id,
    key: spec.key,
    kind: spec.kind,
    keyExists,
    values
  };
}

function absentShellRegistryEntry(spec) {
  return {
    id: spec.id,
    key: spec.key,
    kind: spec.kind,
    keyExists: false,
    values: Object.fromEntries(
      spec.values.map((valueSpec) => [
        valueSpec.id,
        { keyExists: false, valueExists: false, type: null, value: null }
      ])
    )
  };
}

async function createShellRegistryBackup(mode = "manual") {
  const entries = [];
  for (const spec of shellRegistrySnapshotSpec) {
    entries.push(await createShellRegistryEntry(spec));
  }
  return {
    version: 2,
    id: crypto.randomUUID(),
    mode,
    createdAt: new Date().toISOString(),
    entries
  };
}

function shellRestoreRegistryContent(backup) {
  const lines = [
    "Windows Registry Editor Version 5.00",
    "",
    `; Explore Better shell restore backup ${backup?.id || "unknown"}`,
    `; Created ${backup?.createdAt || "unknown"} before ${backup?.mode || "manual"}`
  ];
  for (const entry of backup?.entries || []) {
    const spec = shellRegistrySnapshotSpec.find((item) => item.id === entry.id);
    if (!spec) {
      continue;
    }
    lines.push("");
    if (entry.kind === "ownedKey" && !entry.keyExists) {
      lines.push(`[-${registryFileKey(entry.key)}]`);
      continue;
    }
    lines.push(`[${registryFileKey(entry.key)}]`);
    for (const valueSpec of spec.values) {
      lines.push(restoreRegValueLine(valueSpec.name, entry.values?.[valueSpec.id]));
    }
  }
  lines.push("");
  return lines.join("\r\n");
}

async function writeShellRestoreFile(backup) {
  const paths = integrationPaths();
  await fs.mkdir(integrationRoot, { recursive: true });
  await fs.writeFile(paths.registryRestoreRegPath, shellRestoreRegistryContent(backup), "utf8");
  return paths.registryRestoreRegPath;
}

async function saveShellRegistryBackup(mode = "manual") {
  const backup = await createShellRegistryBackup(mode);
  const restoreRegPath = await writeShellRestoreFile(backup);
  const savedBackup = {
    ...backup,
    restoreRegPath
  };
  await mutateState((state) => {
    state.integration = {
      ...state.integration,
      registryBackup: savedBackup
    };
  });
  return savedBackup;
}

async function ensureShellRegistryBackup(mode = "integration") {
  const state = await readState();
  const existing = state.integration?.registryBackup;
  if (existing?.entries?.length && !existing.restoredAt) {
    const existingIds = new Set(existing.entries.map((entry) => entry.id));
    const missingSpecs = shellRegistrySnapshotSpec.filter((spec) => !existingIds.has(spec.id));
    if (!missingSpecs.length) return existing;
    const upgraded = {
      ...existing,
      version: 2,
      upgradedAt: new Date().toISOString(),
      entries: [...existing.entries]
    };
    for (const spec of missingSpecs) {
      upgraded.entries.push(await createShellRegistryEntry(spec));
    }
    upgraded.restoreRegPath = await writeShellRestoreFile(upgraded);
    await mutateState((nextState) => {
      nextState.integration = {
        ...nextState.integration,
        registryBackup: upgraded
      };
    });
    return upgraded;
  }
  return saveShellRegistryBackup(mode);
}

async function removeRegistryKeyWhenEmpty(key) {
  const query = await runProcess("reg.exe", ["query", key]);
  if (query.code !== 0) {
    return { key, removed: false, missing: true };
  }
  const canonicalKey = registryFileKey(key).toLowerCase();
  const remaining = String(query.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.toLowerCase() !== canonicalKey);
  if (remaining.length > 0) {
    return { key, removed: false, empty: false };
  }
  const removal = await runProcess("reg.exe", ["delete", key, "/f"]);
  if (removal.code !== 0) {
    throw new Error(removal.stderr || removal.stdout || `Unable to remove empty registry key ${key}.`);
  }
  return { key, removed: true, empty: true };
}

async function restoreShellRegistryBackup() {
  const state = await readState();
  let backup = state.integration?.registryBackup;
  if (!backup?.entries?.length) {
    throw new Error("No shell registry backup has been captured yet.");
  }
  const backupIds = new Set(backup.entries.map((entry) => entry.id));
  const legacyMissingSpecs = shellRegistrySnapshotSpec.filter((spec) => !backupIds.has(spec.id));
  if (legacyMissingSpecs.length) {
    const missingSharedKeys = legacyMissingSpecs.filter((spec) => spec.kind !== "ownedKey");
    if (missingSharedKeys.length) {
      throw new Error("The shell backup is missing shared Windows handler values and cannot be restored safely.");
    }
    backup = {
      ...backup,
      version: 2,
      upgradedAt: new Date().toISOString(),
      entries: [...backup.entries, ...legacyMissingSpecs.map(absentShellRegistryEntry)]
    };
  }
  const restoreRegPath = await writeShellRestoreFile(backup);
  const result = await importRegistryFile(restoreRegPath);
  const emptyKeyCleanup = [];
  for (const entry of backup.entries) {
    if (entry.kind === "defaultOnly" && !entry.keyExists) {
      emptyKeyCleanup.push(await removeRegistryKeyWhenEmpty(entry.key));
    }
  }
  const restoredAt = new Date().toISOString();
  await mutateState((nextState) => {
    nextState.integration = {
      ...nextState.integration,
      registryBackup: {
        ...backup,
        restoreRegPath,
        restoredAt
      }
    };
  });
  return {
    ...result,
    restoredAt,
    backupId: backup.id,
    emptyKeyCleanup
  };
}

function electronMainPath() {
  return path.join(__dirname, "electron-main.mjs");
}

function electronLauncherPath() {
  const executable = process.platform === "win32" ? "electron.cmd" : "electron";
  const candidate = path.join(__dirname, "node_modules", ".bin", executable);
  return existsSync(candidate) ? candidate : null;
}

function packagedAppCandidatePath() {
  const executable = process.platform === "win32" ? "Explore Better.exe" : "Explore Better";
  return path.join(__dirname, "dist", "win-unpacked", executable);
}

function installedAppPath() {
  const executable = process.platform === "win32" ? "Explore Better.exe" : "Explore Better";
  return path.join(installedAppRoot, executable);
}

function installedAppCandidatePath() {
  return installedAppPath();
}

function userDesktopPath() {
  const candidates = [
    process.env.OneDrive ? path.join(process.env.OneDrive, "Desktop") : null,
    process.env.ONEDRIVE ? path.join(process.env.ONEDRIVE, "Desktop") : null,
    path.join(os.homedir(), "OneDrive", "Desktop"),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "Desktop") : null,
    path.join(os.homedir(), "Desktop")
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || path.join(os.homedir(), "Desktop");
}

function installedAppCurrentPath() {
  const candidate = installedAppPath();
  return existsSync(candidate) ? candidate : null;
}

function desktopExecutableCurrentPath() {
  return desktopExecutablePath && existsSync(desktopExecutablePath) ? desktopExecutablePath : null;
}

export function setDesktopExecutablePath(value) {
  const candidate = String(value || "").trim();
  desktopExecutablePath = candidate && path.isAbsolute(candidate) ? path.resolve(candidate) : null;
}

function packagedAppPath() {
  const desktopExecutable = desktopExecutableCurrentPath();
  if (desktopExecutable) {
    return desktopExecutable;
  }
  const installed = installedAppCurrentPath();
  if (installed) {
    return installed;
  }
  if (process.versions.electron && process.execPath && !process.defaultApp) {
    return process.execPath;
  }
  const candidate = packagedAppCandidatePath();
  return existsSync(candidate) ? candidate : null;
}

function integrationShellCommand(launcherPath, launchMode, shellOpenMode, targetArgument = "%1") {
  const desktopExecutable = desktopExecutableCurrentPath();
  if (desktopExecutable) {
    return {
      command: `"${desktopExecutable}" "--shell-mode=${shellOpenMode}" "${targetArgument}"`,
      kind: "packaged",
      target: desktopExecutable
    };
  }
  const installed = launchMode === "native" ? installedAppCurrentPath() : null;
  if (installed) {
    return {
      command: `"${installed}" "--shell-mode=${shellOpenMode}" "${targetArgument}"`,
      kind: "installed",
      target: installed
    };
  }
  const packagedApp = launchMode === "native" ? packagedAppPath() : null;
  if (packagedApp) {
    return {
      command: `"${packagedApp}" "--shell-mode=${shellOpenMode}" "${targetArgument}"`,
      kind: "packaged",
      target: packagedApp
    };
  }
  return {
    command: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${launcherPath}" "${targetArgument}"`,
    kind: "launcher",
    target: launcherPath
  };
}

async function installPackagedApp() {
  const sourceRoot = path.dirname(packagedAppCandidatePath());
  if (!(await pathExists(packagedAppCandidatePath()))) {
    throw new Error("Build the unpacked desktop app first with npm run package:dir.");
  }
  const stagingRoot = `${installedAppRoot}.staging-${Date.now()}`;
  await fs.rm(stagingRoot, { recursive: true, force: true });
  await fs.mkdir(path.dirname(stagingRoot), { recursive: true });
  await fs.cp(sourceRoot, stagingRoot, {
    recursive: true,
    force: true,
    verbatimSymlinks: true
  });
  await fs.rm(installedAppRoot, { recursive: true, force: true });
  await renamePathWithRetry(stagingRoot, installedAppRoot, 12);
  const installed = installedAppPath();
  await mutateState((state) => {
    state.integration = {
      ...state.integration,
      installedAppPath: installed,
      installedAppAt: new Date().toISOString()
    };
  });
  await writeIntegrationFiles();
  return {
    ok: true,
    source: sourceRoot,
    installed,
    status: await getIntegrationStatus()
  };
}

async function removeInstalledApp() {
  await fs.rm(installedAppRoot, { recursive: true, force: true });
  await mutateState((state) => {
    state.integration = {
      ...state.integration,
      installedAppPath: null,
      installedAppAt: null,
      removedInstalledAppAt: new Date().toISOString()
    };
  });
  await writeIntegrationFiles();
  return {
    ok: true,
    removed: installedAppRoot,
    status: await getIntegrationStatus()
  };
}

async function writeIntegrationFiles() {
  const paths = integrationPaths();
  await fs.mkdir(integrationRoot, { recursive: true });
  const state = await readState();
  const settings = sanitizeSettings(state.settings || {});
  const launchMode = normalizeLaunchMode(settings.launchMode);
  const shellOpenMode = normalizeShellOpenMode(settings.shellOpenMode);
  const launcherPath = paths.scriptPath;
  const serverScriptPath = paths.serverScriptPath;
  const shortcutScriptPath = paths.shortcutScriptPath;
  const shortcutRemoveScriptPath = paths.shortcutRemoveScriptPath;
  const winEHotkeyPath = paths.winEHotkeyPath;
  const winEInstallScriptPath = paths.winEInstallScriptPath;
  const winERemoveScriptPath = paths.winERemoveScriptPath;
  const repoPath = __dirname;
  const desktopDir = userDesktopPath();
  const desktopExecutable = desktopExecutableCurrentPath();
  const shellCommand = integrationShellCommand(launcherPath, launchMode, shellOpenMode);
  const backgroundShellCommand = integrationShellCommand(launcherPath, launchMode, shellOpenMode, "%V");
  const shellIcon = shellCommand.kind === "launcher" ? "imageres.dll,-5302" : shellCommand.target;
  const scriptContent = `param(
  [string]$TargetPath = $PWD.Path,
  [switch]$DefaultBrowser
)

$ErrorActionPreference = "Stop"
$RepoPath = "${repoPath.replaceAll("\\", "\\\\")}"
$Port = ${port}
$DefaultLaunchMode = "${launchMode}"
$ShellOpenMode = "${shellOpenMode}"
$AppProfile = Join-Path $env:LOCALAPPDATA "ExploreBetter\\AppWindowProfile"
$DesktopApp = "${String(desktopExecutable || "").replaceAll("\\", "\\\\")}"
$InstalledApp = "${installedAppPath().replaceAll("\\", "\\\\")}"
$PackagedApp = Join-Path $RepoPath "dist\\win-unpacked\\Explore Better.exe"
$ElectronLauncher = Join-Path $RepoPath "node_modules\\.bin\\electron.cmd"
$ResolvedTarget = (Resolve-Path -LiteralPath $TargetPath).Path
$UrlPath = [uri]::EscapeDataString($ResolvedTarget)
$Url = "http://127.0.0.1:$Port/?open=$UrlPath&shellMode=$ShellOpenMode"

function Test-ExploreBetterServer {
  try {
    Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/roots" -TimeoutSec 1 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Start-ExploreBetterServer {
  if (Test-ExploreBetterServer) {
    return
  }
  Start-Process -FilePath "node" -ArgumentList "server.mjs" -WorkingDirectory $RepoPath -WindowStyle Hidden
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 200
    if (Test-ExploreBetterServer) {
      return
    }
  }
}

function Find-AppBrowser {
  $candidates = @(
    "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe",
    "\${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe",
    "$env:LOCALAPPDATA\\Microsoft\\Edge\\Application\\msedge.exe",
    "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",
    "\${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe",
    "$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }
  return $null
}

function Start-NativeWindow {
  if ($DesktopApp -and (Test-Path -LiteralPath $DesktopApp)) {
    Start-Process -FilePath $DesktopApp -ArgumentList @("--shell-mode=$ShellOpenMode", $ResolvedTarget)
    return $true
  }
  if (Test-Path -LiteralPath $InstalledApp) {
    Start-Process -FilePath $InstalledApp -ArgumentList @("--shell-mode=$ShellOpenMode", $ResolvedTarget)
    return $true
  }
  if (Test-Path -LiteralPath $PackagedApp) {
    Start-Process -FilePath $PackagedApp -ArgumentList @("--shell-mode=$ShellOpenMode", $ResolvedTarget)
    return $true
  }
  if (-not (Test-Path -LiteralPath $ElectronLauncher)) {
    return $false
  }
  Start-Process -FilePath $ElectronLauncher -ArgumentList @($RepoPath, "--shell-mode=$ShellOpenMode", $ResolvedTarget)
  return $true
}

if (-not $DefaultBrowser -and $DesktopApp -and (Test-Path -LiteralPath $DesktopApp)) {
  if (Start-NativeWindow) {
    exit
  }
}

if (-not $DefaultBrowser -and $DefaultLaunchMode -eq "native") {
  if (Start-NativeWindow) {
    exit
  }
}

Start-ExploreBetterServer

if (-not $DefaultBrowser -and $DefaultLaunchMode -eq "appWindow") {
  $browser = Find-AppBrowser
  if ($browser) {
    New-Item -ItemType Directory -Force -Path $AppProfile | Out-Null
    Start-Process -FilePath $browser -ArgumentList @("--app=$Url", "--new-window", "--user-data-dir=$AppProfile", "--no-first-run")
    exit
  }
}

Start-Process $Url
`;

  const serverScriptContent = `param(
  [switch]$Open
)

$ErrorActionPreference = "Stop"
$RepoPath = "${repoPath.replaceAll("\\", "\\\\")}"
$Port = ${port}
$Launcher = "${launcherPath.replaceAll("\\", "\\\\")}"

try {
  Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/roots" -TimeoutSec 1 | Out-Null
} catch {
  Start-Process -FilePath "node" -ArgumentList "server.mjs" -WorkingDirectory $RepoPath -WindowStyle Hidden
  Start-Sleep -Milliseconds 900
}

if ($Open) {
  & $Launcher $RepoPath
}
`;

  const shortcutScriptContent = `param(
  [switch]$Desktop
)

$ErrorActionPreference = "Stop"
$Launcher = "${launcherPath.replaceAll("\\", "\\\\")}"
$DesktopApp = "${String(desktopExecutable || "").replaceAll("\\", "\\\\")}"
$InstalledApp = "${installedAppPath().replaceAll("\\", "\\\\")}"
$PackagedApp = "${packagedAppCandidatePath().replaceAll("\\", "\\\\")}"
$BrandIcon = "${path.join(repoPath, "build", "icon.ico").replaceAll("\\", "\\\\")}"
$ShellOpenMode = "${shellOpenMode}"
$StartMenuDir = Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs\\Explore Better"
$DesktopDir = "${desktopDir.replaceAll("\\", "\\\\")}"
$Shell = New-Object -ComObject WScript.Shell

New-Item -ItemType Directory -Force -Path $StartMenuDir | Out-Null

function New-ExploreBetterShortcut {
  param(
    [string]$ShortcutPath,
    [string]$TargetPath
  )
  $shortcut = $Shell.CreateShortcut($ShortcutPath)
  if ($DesktopApp -and (Test-Path -LiteralPath $DesktopApp)) {
    $shortcut.TargetPath = $DesktopApp
    $shortcut.Arguments = "--shell-mode=$ShellOpenMode \`"$TargetPath\`""
    $shortcut.WorkingDirectory = Split-Path -Parent $DesktopApp
    $shortcut.IconLocation = $DesktopApp
  } elseif ("${launchMode}" -eq "native" -and (Test-Path -LiteralPath $InstalledApp)) {
    $shortcut.TargetPath = $InstalledApp
    $shortcut.Arguments = "--shell-mode=$ShellOpenMode \`"$TargetPath\`""
    $shortcut.WorkingDirectory = Split-Path -Parent $InstalledApp
    $shortcut.IconLocation = $InstalledApp
  } elseif ("${launchMode}" -eq "native" -and (Test-Path -LiteralPath $PackagedApp)) {
    $shortcut.TargetPath = $PackagedApp
    $shortcut.Arguments = "--shell-mode=$ShellOpenMode \`"$TargetPath\`""
    $shortcut.WorkingDirectory = Split-Path -Parent $PackagedApp
    $shortcut.IconLocation = $PackagedApp
  } else {
    $shortcut.TargetPath = "powershell.exe"
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \`"$Launcher\`" \`"$TargetPath\`""
    $shortcut.WorkingDirectory = Split-Path -Parent $Launcher
    $shortcut.IconLocation = if (Test-Path -LiteralPath $BrandIcon) { $BrandIcon } else { "imageres.dll,3" }
  }
  $shortcut.Description = "Open Explore Better"
  $shortcut.Save()
}

New-ExploreBetterShortcut -ShortcutPath (Join-Path $StartMenuDir "Explore Better.lnk") -TargetPath "${repoPath.replaceAll("\\", "\\\\")}"

if ($Desktop) {
  New-ExploreBetterShortcut -ShortcutPath (Join-Path $DesktopDir "Explore Better.lnk") -TargetPath "${repoPath.replaceAll("\\", "\\\\")}"
}

Write-Output "Shortcuts installed in $StartMenuDir"
`;

  const shortcutRemoveScriptContent = `$ErrorActionPreference = "Stop"
$StartMenuDir = Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs\\Explore Better"
$StartMenuShortcut = Join-Path $StartMenuDir "Explore Better.lnk"
$DesktopShortcut = Join-Path "${desktopDir.replaceAll("\\", "\\\\")}" "Explore Better.lnk"
$Removed = @()

foreach ($ShortcutPath in @($StartMenuShortcut, $DesktopShortcut)) {
  if (Test-Path -LiteralPath $ShortcutPath) {
    Remove-Item -LiteralPath $ShortcutPath -Force
    $Removed += $ShortcutPath
  }
}

if ((Test-Path -LiteralPath $StartMenuDir) -and -not (Get-ChildItem -LiteralPath $StartMenuDir -Force -ErrorAction SilentlyContinue)) {
  Remove-Item -LiteralPath $StartMenuDir -Force
}

if ($Removed.Count) {
  Write-Output "Removed shortcut(s):"
  $Removed | ForEach-Object { Write-Output $_ }
} else {
  Write-Output "Explore Better shortcuts were not installed."
}
`;

  const winEHotkeyContent = `$ErrorActionPreference = "Stop"
$Launcher = "${launcherPath.replaceAll("\\", "\\\\")}"
$DefaultTarget = [Environment]::GetFolderPath("UserProfile")
$HotkeyId = 4627
$ModWin = 0x0008
$VkE = 0x45
$Source = @"
using System;
using System.Runtime.InteropServices;

public static class ExploreBetterHotkey {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

  [DllImport("user32.dll")]
  public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

  [StructLayout(LayoutKind.Sequential)]
  public struct MSG {
    public IntPtr hwnd;
    public uint message;
    public IntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public int pt_x;
    public int pt_y;
  }
}
"@

Add-Type $Source
$registered = [ExploreBetterHotkey]::RegisterHotKey([IntPtr]::Zero, $HotkeyId, $ModWin, $VkE)
if (-not $registered) {
  throw "Could not register Win+E. Another process may already own that hotkey."
}

try {
  $msg = New-Object ExploreBetterHotkey+MSG
  while ([ExploreBetterHotkey]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0) -ne 0) {
    if ($msg.message -eq 0x0312 -and $msg.wParam.ToInt32() -eq $HotkeyId) {
      Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $Launcher, $DefaultTarget) -WindowStyle Hidden
    }
  }
} finally {
  [ExploreBetterHotkey]::UnregisterHotKey([IntPtr]::Zero, $HotkeyId) | Out-Null
}
`;

  const winEInstallScriptContent = `$ErrorActionPreference = "Stop"
$HotkeyScript = "${winEHotkeyPath.replaceAll("\\", "\\\\")}"
$BrandIcon = "${path.join(repoPath, "build", "icon.ico").replaceAll("\\", "\\\\")}"
$RoamingRoot = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE "AppData\\Roaming" }
$StartupDir = Join-Path $RoamingRoot "Microsoft\\Windows\\Start Menu\\Programs\\Startup"
$ShortcutPath = Join-Path $StartupDir "Explore Better Win+E.lnk"
$Shell = New-Object -ComObject WScript.Shell

New-Item -ItemType Directory -Force -Path $StartupDir | Out-Null
$shortcut = $Shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$HotkeyScript\`""
$shortcut.WorkingDirectory = Split-Path -Parent $HotkeyScript
$shortcut.IconLocation = if (Test-Path -LiteralPath $BrandIcon) { $BrandIcon } else { "imageres.dll,3" }
$shortcut.Description = "Explore Better Win+E helper"
$shortcut.Save()

Write-Output "Win+E startup helper installed at $ShortcutPath"
`;

  const winERemoveScriptContent = `$ErrorActionPreference = "Stop"
$RoamingRoot = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $env:USERPROFILE "AppData\\Roaming" }
$StartupDir = Join-Path $RoamingRoot "Microsoft\\Windows\\Start Menu\\Programs\\Startup"
$ShortcutPath = Join-Path $StartupDir "Explore Better Win+E.lnk"
if (Test-Path -LiteralPath $ShortcutPath) {
  Remove-Item -LiteralPath $ShortcutPath -Force
  Write-Output "Removed $ShortcutPath"
} else {
  Write-Output "Win+E startup helper was not installed."
}
`;

  const contextMenuReg = `Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\ExploreBetter]
@="Open in Explore Better"
"Icon"="${escapeReg(shellIcon)}"

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\ExploreBetter\\command]
@="${escapeReg(shellCommand.command)}"

[HKEY_CURRENT_USER\\Software\\Classes\\Drive\\shell\\ExploreBetter]
@="Open in Explore Better"
"Icon"="${escapeReg(shellIcon)}"

[HKEY_CURRENT_USER\\Software\\Classes\\Drive\\shell\\ExploreBetter\\command]
@="${escapeReg(shellCommand.command)}"

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter]
@="Open this folder in Explore Better"
"Icon"="${escapeReg(shellIcon)}"

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter\\command]
@="${escapeReg(backgroundShellCommand.command)}"

[HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\ExploreBetterLocation]
@="Open file location in Explore Better"
"Icon"="${escapeReg(shellIcon)}"

[HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\ExploreBetterLocation\\command]
@="${escapeReg(shellCommand.command)}"
`;

  const removeContextMenuReg = `Windows Registry Editor Version 5.00

[-HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\ExploreBetter]
[-HKEY_CURRENT_USER\\Software\\Classes\\Drive\\shell\\ExploreBetter]
[-HKEY_CURRENT_USER\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter]
[-HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\ExploreBetterLocation]
`;

  const folderDefaultReg = `Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\ExploreBetter]
@="Open in Explore Better"
"Icon"="${escapeReg(shellIcon)}"

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\ExploreBetter\\command]
@="${escapeReg(shellCommand.command)}"

[HKEY_CURRENT_USER\\Software\\Classes\\Drive\\shell\\ExploreBetter]
@="Open in Explore Better"
"Icon"="${escapeReg(shellIcon)}"

[HKEY_CURRENT_USER\\Software\\Classes\\Drive\\shell\\ExploreBetter\\command]
@="${escapeReg(shellCommand.command)}"

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell]
@="ExploreBetter"

[HKEY_CURRENT_USER\\Software\\Classes\\Drive\\shell]
@="ExploreBetter"

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter]
@="Open this folder in Explore Better"
"Icon"="${escapeReg(shellIcon)}"

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter\\command]
@="${escapeReg(backgroundShellCommand.command)}"

[HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\ExploreBetterLocation]
@="Open file location in Explore Better"
"Icon"="${escapeReg(shellIcon)}"

[HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\ExploreBetterLocation\\command]
@="${escapeReg(shellCommand.command)}"
`;

  const removeFolderDefaultReg = `Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell]
@=-

[HKEY_CURRENT_USER\\Software\\Classes\\Drive\\shell]
@=-

[-HKEY_CURRENT_USER\\Software\\Classes\\Directory\\shell\\ExploreBetter]
[-HKEY_CURRENT_USER\\Software\\Classes\\Drive\\shell\\ExploreBetter]
[-HKEY_CURRENT_USER\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter]
[-HKEY_CURRENT_USER\\Software\\Classes\\*\\shell\\ExploreBetterLocation]
`;

  const readme = `Explore Better integration files

Launcher:
${launcherPath}

Server helper:
${serverScriptPath}

Shortcut installer:
${shortcutScriptPath}

Shortcut remover:
${shortcutRemoveScriptPath}

Registry files:
1. install-context-menu.reg adds "Open in Explore Better" to folder and drive context menus.
2. install-folder-default.reg makes Explore Better the default folder/drive open handler for the current user. This is the closest prototype-level Explorer replacement mode and is intentionally separate.
3. remove-context-menu.reg and remove-folder-default.reg undo those registry changes.
4. restore-previous-shell.reg is generated from the last Shell Backup snapshot and restores previous current-user folder/drive shell ownership.
Generated shell command:
${shellCommand.kind}: ${shellCommand.target}

Win+E helper:
${winEHotkeyPath}
${winEInstallScriptPath}
${winERemoveScriptPath}
The Win+E helper is optional. It installs a current-user Startup shortcut to a resident PowerShell hotkey listener and can be removed without touching registry defaults.

Launch behavior:
Native Window mode opens the installed current-user app from ${installedAppRoot.replaceAll("\\", "\\\\")} when available, then a packaged Explore Better desktop app from dist\\win-unpacked, then the optional Electron development launcher at node_modules\\.bin\\electron.cmd. App Window mode starts the local Node server if needed and opens Edge/Chrome app mode when available. Browser Tab mode or missing optional launchers fall back to the default browser.
Shell-open mode:
The generated launcher currently uses shell mode "${shellOpenMode}". Change this from the Explorer Integration dialog and regenerate files.
`;

  await fs.writeFile(launcherPath, scriptContent, "utf8");
  await fs.writeFile(serverScriptPath, serverScriptContent, "utf8");
  await fs.writeFile(shortcutScriptPath, shortcutScriptContent, "utf8");
  await fs.writeFile(shortcutRemoveScriptPath, shortcutRemoveScriptContent, "utf8");
  await fs.writeFile(winEHotkeyPath, winEHotkeyContent, "utf8");
  await fs.writeFile(winEInstallScriptPath, winEInstallScriptContent, "utf8");
  await fs.writeFile(winERemoveScriptPath, winERemoveScriptContent, "utf8");
  await fs.writeFile(paths.contextMenuRegPath, contextMenuReg, "utf8");
  await fs.writeFile(paths.contextMenuRemoveRegPath, removeContextMenuReg, "utf8");
  await fs.writeFile(paths.folderDefaultRegPath, folderDefaultReg, "utf8");
  await fs.writeFile(paths.folderDefaultRemoveRegPath, removeFolderDefaultReg, "utf8");
  await fs.writeFile(path.join(integrationRoot, "README.txt"), readme, "utf8");

  const generatedAt = new Date().toISOString();
  await mutateState((state) => {
    state.integration = {
      ...state.integration,
      ...paths,
      generatedAt
    };
  });

  return { ...paths, generatedAt, integrationRoot };
}

function hasBinaryBytes(buffer) {
  const sampleLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

async function previewFile(targetPath) {
  const file = resolveUserPath(targetPath);
  const stats = await fs.stat(file);
  const ext = path.extname(file).toLowerCase();

  if (stats.isDirectory()) {
    const listing = await listDirectory(file);
    return {
      type: "folder",
      name: path.basename(file) || file,
      path: file,
      count: listing.entries.length
    };
  }

  if (imageExtensions.has(ext)) {
    return {
      type: "image",
      name: path.basename(file),
      path: file,
      size: stats.size,
      modified: stats.mtimeMs,
      url: `/api/raw?path=${encodeURIComponent(file)}`
    };
  }

  if (previewDocumentExtensions.has(ext)) {
    return {
      type: "pdf",
      name: path.basename(file),
      path: file,
      size: stats.size,
      modified: stats.mtimeMs,
      mime: mimeTypes.get(ext) || "application/pdf",
      url: `/api/raw?path=${encodeURIComponent(file)}`
    };
  }

  if (audioExtensions.has(ext)) {
    return {
      type: "audio",
      name: path.basename(file),
      path: file,
      size: stats.size,
      modified: stats.mtimeMs,
      mime: mimeTypes.get(ext) || "audio/mpeg",
      url: `/api/raw?path=${encodeURIComponent(file)}`
    };
  }

  if (videoExtensions.has(ext)) {
    return {
      type: "video",
      name: path.basename(file),
      path: file,
      size: stats.size,
      modified: stats.mtimeMs,
      mime: mimeTypes.get(ext) || "video/mp4",
      url: `/api/raw?path=${encodeURIComponent(file)}`
    };
  }

  if (stats.size > 750_000) {
    return {
      type: "large",
      name: path.basename(file),
      path: file,
      size: stats.size,
      modified: stats.mtimeMs
    };
  }

  const buffer = await fs.readFile(file);
  if (!textExtensions.has(ext) && hasBinaryBytes(buffer)) {
    return {
      type: "binary",
      name: path.basename(file),
      path: file,
      size: stats.size,
      modified: stats.mtimeMs
    };
  }

  return {
    type: "text",
    name: path.basename(file),
    path: file,
    size: stats.size,
    modified: stats.mtimeMs,
    extension: ext,
    content: buffer.toString("utf8")
  };
}

async function editableTextSnapshot(targetPath, maxBytes = 1_000_000) {
  const file = resolveUserPath(targetPath);
  const stats = await fs.stat(file);
  if (!stats.isFile()) {
    throw new Error("Select a file to edit.");
  }
  const byteLimit = Math.max(1024, Math.min(Number(maxBytes || 1_000_000), 2_000_000));
  if (stats.size > byteLimit) {
    throw new Error(`Text editor limit is ${byteLimit} bytes.`);
  }
  const buffer = await fs.readFile(file);
  const ext = path.extname(file).toLowerCase();
  if (!textExtensions.has(ext) && hasBinaryBytes(buffer)) {
    throw new Error("Only text files can be edited here.");
  }
  return {
    path: file,
    name: path.basename(file),
    size: stats.size,
    modified: stats.mtimeMs,
    content: buffer.toString("utf8")
  };
}

async function saveTextFile(body) {
  const snapshot = await editableTextSnapshot(body.path);
  const content = String(body.content ?? "");
  const maxBytes = Math.max(1024, Math.min(Number(body.maxBytes || 1_000_000), 2_000_000));
  const nextBytes = Buffer.byteLength(content, "utf8");
  if (nextBytes > maxBytes) {
    throw new Error(`Text editor limit is ${maxBytes} bytes.`);
  }
  const expectedModified = Number(body.expectedModified || 0);
  if (expectedModified && Math.abs(snapshot.modified - expectedModified) > 2 && !body.force) {
    throw new Error("File changed on disk. Reload before saving, or save again with force.");
  }
  await fs.writeFile(snapshot.path, content, "utf8");
  const stats = await fs.stat(snapshot.path);
  const output = {
    result: {
      path: snapshot.path,
      bytes: stats.size,
      previousBytes: snapshot.size,
      modified: stats.mtimeMs
    },
    undo: {
      type: "restore-text",
      path: snapshot.path,
      content: snapshot.content,
      bytes: snapshot.size,
      modified: snapshot.modified
    }
  };
  output.result.cacheInvalidation = invalidateDirectoryListingCachesForOperation("edit-text", body, output);
  output.result.backgroundIndexInvalidation = await safelyInvalidateBackgroundIndexesForOperation("edit-text", body, output);
  return output;
}

async function hashFile(file, algorithm, maxHashBytes) {
  const stats = await fs.stat(file);
  if (!stats.isFile()) {
    return null;
  }
  if (stats.size > maxHashBytes) {
    return {
      algorithm,
      skipped: true,
      reason: `Larger than ${formatBytesForSummary(maxHashBytes)}`
    };
  }

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => {
      resolve({
        algorithm,
        value: hash.digest("hex"),
        skipped: false
      });
    });
  });
}

async function scanFolderProperties(rootPath, options = {}) {
  const root = resolveUserPath(rootPath);
  const maxEntries = Math.max(1, Math.min(Number(options.maxEntries || 20_000), 100_000));
  const stack = [root];
  const skipped = [];
  let scanned = 0;
  let bytes = 0;
  let files = 0;
  let folders = 0;
  let truncated = false;

  while (stack.length) {
    if (scanned >= maxEntries) {
      truncated = true;
      break;
    }
    const current = stack.pop();
    let dirents;
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: current, reason: error.code || "unreadable" });
      continue;
    }

    for (const dirent of dirents) {
      if (scanned >= maxEntries) {
        truncated = true;
        break;
      }
      const fullPath = path.join(current, dirent.name);
      try {
        const stats = await fs.stat(fullPath);
        scanned += 1;
        if (stats.isDirectory()) {
          folders += 1;
          stack.push(fullPath);
        } else {
          files += 1;
          bytes += stats.size;
        }
      } catch (error) {
        skipped.push({ path: fullPath, reason: error.code || "unavailable" });
      }
    }
  }

  return {
    bytes,
    files,
    folders,
    scanned,
    skipped,
    truncated: truncated || stack.length > 0
  };
}

async function propertiesForPath(targetPath, options = {}, index = 0) {
  const itemPath = resolveUserPath(targetPath);
  const lstat = await fs.lstat(itemPath);
  const stats = lstat.isSymbolicLink() ? await fs.stat(itemPath) : lstat;
  const isDirectory = stats.isDirectory();
  const ext = isDirectory ? "" : path.extname(itemPath).toLowerCase();
  const linkMetadata = await linkMetadataForEntry(itemPath, stats, lstat);
  const item = {
    index,
    name: path.basename(itemPath) || itemPath,
    path: itemPath,
    parent: path.dirname(itemPath),
    kind: entryKind(path.basename(itemPath), isDirectory),
    extension: ext,
    isDirectory,
    isFile: stats.isFile(),
    size: isDirectory ? 0 : stats.size,
    created: stats.birthtimeMs,
    modified: stats.mtimeMs,
    accessed: stats.atimeMs,
    mode: stats.mode,
    fileCount: stats.isFile() ? 1 : 0,
    folderCount: 0,
    scanned: 0,
    skipped: [],
    truncated: false,
    hash: null,
    ...linkMetadata
  };

  if (isDirectory && options.recursive !== false) {
    const scan = await scanFolderProperties(itemPath, options);
    item.size = scan.bytes;
    item.fileCount = scan.files;
    item.folderCount = scan.folders;
    item.scanned = scan.scanned;
    item.skipped = scan.skipped.slice(0, 20);
    item.truncated = scan.truncated;
  }

  if (stats.isFile() && options.hash) {
    const algorithm = ["sha1", "sha256", "md5"].includes(options.hashAlgorithm)
      ? options.hashAlgorithm
      : "sha256";
    const maxHashBytes = Math.max(1, Math.min(Number(options.maxHashBytes || 134_217_728), 1_073_741_824));
    item.hash = await hashFile(itemPath, algorithm, maxHashBytes);
  }

  return item;
}

async function propertiesReport(body) {
  const paths = Array.isArray(body.paths)
    ? body.paths.slice(0, 200)
    : body.path
      ? [body.path]
      : [];
  if (!paths.length) {
    throw new Error("Select at least one item.");
  }

  const options = {
    recursive: body.recursive !== false,
    hash: Boolean(body.hash),
    hashAlgorithm: String(body.hashAlgorithm || "sha256").toLowerCase(),
    maxEntries: Number(body.maxEntries || 20_000),
    maxHashBytes: Number(body.maxHashBytes || 134_217_728)
  };
  const items = [];
  const skipped = [];

  for (let index = 0; index < paths.length; index += 1) {
    try {
      items.push(await propertiesForPath(paths[index], options, index));
    } catch (error) {
      skipped.push({
        index,
        path: resolveUserPath(paths[index]),
        reason: error.message || "Unavailable"
      });
    }
  }

  const summary = items.reduce(
    (acc, item) => {
      acc.bytes += Number(item.size || 0);
      acc.files += Number(item.fileCount || 0);
      acc.folders += Number(item.folderCount || 0) + (item.isDirectory ? 1 : 0);
      acc.scanned += Number(item.scanned || 0);
      acc.truncated = acc.truncated || item.truncated;
      acc.skipped += item.skipped.length;
      return acc;
    },
    {
      selected: paths.length,
      available: items.length,
      bytes: 0,
      files: 0,
      folders: 0,
      scanned: 0,
      skipped: skipped.length,
      truncated: false
    }
  );

  return {
    generatedAt: new Date().toISOString(),
    options,
    summary,
    items,
    skipped
  };
}

function sizeAnalysisOptionNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.floor(number), max));
}

function makeSizeNode(itemPath, parent = null, depth = 0) {
  return {
    id: crypto.createHash("sha1").update(pathIdentity(itemPath)).digest("hex").slice(0, 16),
    name: path.basename(itemPath) || itemPath,
    path: itemPath,
    parent,
    depth,
    size: 0,
    allocated: 0,
    files: 0,
    folders: 0,
    modified: null,
    children: []
  };
}

function addFileToSizeNode(node, bytes, allocated = bytes, modified = null) {
  let current = node;
  while (current) {
    current.size += bytes;
    current.allocated += allocated;
    current.files += 1;
    current.modified = Math.max(Number(current.modified || 0), Number(modified || 0)) || current.modified;
    current = current.parent;
  }
}

function addFolderToSizeNode(node) {
  let current = node;
  while (current) {
    current.folders += 1;
    current = current.parent;
  }
}

function rememberTopFile(topFiles, file, limit = 1200) {
  topFiles.push(file);
  if (topFiles.length > limit * 2) {
    topFiles.sort((left, right) => Number(right.size || 0) - Number(left.size || 0));
    topFiles.length = limit;
  }
}

function extensionBucketFor(fileName) {
  return path.extname(fileName).toLowerCase() || "(none)";
}

function allocatedBytesForSize(bytes, clusterSize = 4096) {
  const value = Math.max(0, Number(bytes || 0));
  if (!value) {
    return 0;
  }
  const cluster = Math.max(1, Number(clusterSize || 4096));
  return Math.ceil(value / cluster) * cluster;
}

function nativeFilesystemHelperPath() {
  const executable = process.platform === "win32" ? "explore-better-fs.exe" : "explore-better-fs";
  const candidates = [
    process.env.EXPLORE_BETTER_FS_HELPER,
    process.resourcesPath ? path.join(process.resourcesPath, "native", executable) : null,
    path.join(__dirname, "native", "bin", executable)
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

const windowsBrowseAttributeFlags = [
  [0x00000001, "R"],
  [0x00000002, "H"],
  [0x00000004, "S"],
  [0x00000020, "A"],
  [0x00000400, "L"],
  [0x00000800, "C"],
  [0x00002000, "I"],
  [0x00004000, "E"]
];

function nativeBrowseFlags(mask) {
  const value = Number(mask || 0);
  return windowsBrowseAttributeFlags
    .filter(([bit]) => (value & bit) !== 0)
    .map(([, flag]) => flag)
    .join("");
}

function nativeBrowseEntryCount(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (payload?.format === "columns-v1" && Array.isArray(payload.n)) return payload.n.length;
  return 0;
}

function nativeBrowseField(payload, index, key) {
  if (payload?.format === "columns-v1") {
    return payload[key]?.[index];
  }
  return payload?.[key];
}

function entryFromNativeBrowseRow(parent, row, index = 0) {
  const name = String(nativeBrowseField(row, index, "n") || "");
  const separator = parent.endsWith("\\") || parent.endsWith("/") ? "" : path.sep;
  const fullPath = `${parent}${separator}${name}`;
  const attributeMask = Number(nativeBrowseField(row, index, "a") || 0);
  const isDirectory = (attributeMask & 0x00000010) !== 0;
  const flags = nativeBrowseFlags(attributeMask);
  const readonly = flags.includes("R");
  const hidden = flags.includes("H") || name.startsWith(".");
  const system = flags.includes("S");
  const archive = flags.includes("A");
  const isSymlink = flags.includes("L");
  return {
    name,
    path: fullPath,
    parent,
    isDirectory,
    isFile: !isDirectory,
    extension: isDirectory ? "" : path.extname(name).toLowerCase(),
    kind: entryKind(name, isDirectory),
    size: isDirectory ? null : Number(nativeBrowseField(row, index, "s") || 0),
    modified: Number(nativeBrowseField(row, index, "m") || 0) || null,
    created: Number(nativeBrowseField(row, index, "c") || 0) || null,
    accessed: Number(nativeBrowseField(row, index, "x") || 0) || null,
    readonly,
    hidden,
    system,
    archive,
    attributeText: flags,
    isSymlink
  };
}

function nativeDirectoryListingEligible(dir, entryCount, options = {}) {
  return (
    process.platform === "win32" &&
    process.env.EXPLORE_BETTER_DISABLE_NATIVE_LISTING !== "1" &&
    Number(entryCount || 0) >= nativeDirectoryListingThreshold &&
    !String(dir || "").startsWith("\\\\") &&
    options.includeDimensions !== true &&
    options.includeLinks !== true &&
    Boolean(nativeFilesystemHelperPath())
  );
}

let nativeFilesystemHelperClientState = null;

function failNativeFilesystemHelperClient(client, error) {
  if (!client || client.failed) return;
  client.failed = true;
  if (nativeFilesystemHelperClientState === client) {
    nativeFilesystemHelperClientState = null;
  }
  const failure = error instanceof Error ? error : new Error(String(error || "Native filesystem helper failed."));
  for (const pending of [...client.pending.values()]) {
    pending.complete(failure);
  }
  client.pending.clear();
}

function ensureNativeFilesystemHelperClient() {
  const helperPath = nativeFilesystemHelperPath();
  if (!helperPath) {
    throw new Error("Native filesystem helper is unavailable.");
  }
  const current = nativeFilesystemHelperClientState;
  if (current && !current.failed && current.helperPath === helperPath && current.child.exitCode === null) {
    return current;
  }
  if (current && current.child.exitCode === null) {
    current.child.kill();
  }
  const spawnStartedAt = monotonicMs();
  const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const client = {
    child,
    helperPath,
    stdout: "",
    stderr: "",
    pending: new Map(),
    requests: 0,
    startedAt: spawnStartedAt,
    spawnedAt: null,
    failed: false
  };
  nativeFilesystemHelperClientState = client;
  child.once("spawn", () => {
    client.spawnedAt = monotonicMs();
  });
  child.stdout.on("data", (chunk) => {
    client.stdout += chunk.toString();
    let index;
    while ((index = client.stdout.indexOf("\n")) !== -1) {
      const line = client.stdout.slice(0, index).trim();
      client.stdout = client.stdout.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        failNativeFilesystemHelperClient(client, error);
        if (child.exitCode === null) child.kill();
        return;
      }
      const pending = client.pending.get(message.id);
      if (!pending) continue;
      if (message.type === "progress") {
        pending.onProgress?.(message.data || {});
        continue;
      }
      if (!message.ok) {
        pending.complete(new Error(message.error?.message || "Native filesystem helper request failed."));
        continue;
      }
      pending.complete(null, message.data || {});
    }
  });
  child.stderr.on("data", (chunk) => {
    client.stderr = `${client.stderr}${chunk.toString()}`.slice(-8192);
  });
  child.once("error", (error) => failNativeFilesystemHelperClient(client, error));
  child.once("exit", (code) => {
    failNativeFilesystemHelperClient(
      client,
      new Error(`Native filesystem helper exited ${code}: ${client.stderr.trim()}`)
    );
  });
  return client;
}

function nativeFilesystemHelperRequest(op, payload = {}, options = {}) {
  const { signal = null, timeoutMs = 60000, onProgress = null } = options;
  if (signal?.aborted) {
    return Promise.reject(signal.reason || operationCanceledError());
  }
  let client;
  try {
    client = ensureNativeFilesystemHelperClient();
  } catch (error) {
    return Promise.reject(error);
  }
  const requestId = crypto.randomUUID();
  const requestStartedAt = monotonicMs();
  const reused = client.requests > 0;
  client.requests += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const sendCancel = () => {
      if (client.failed || client.child.exitCode !== null || !client.child.stdin.writable) return;
      client.child.stdin.write(
        `${JSON.stringify({ version: 1, id: crypto.randomUUID(), op: "cancel", targetId: requestId })}\n`
      );
    };
    const onAbort = () => {
      sendCancel();
      complete(signal.reason || operationCanceledError());
    };
    const complete = (error, data = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      client.pending.delete(requestId);
      if (error) {
        reject(error);
        return;
      }
      resolve({
        data,
        helperPath: client.helperPath,
        helperPid: client.child.pid || null,
        clientReused: reused,
        requestMs: elapsedMs(requestStartedAt),
        helperStartupMs: client.spawnedAt ? Math.max(0, client.spawnedAt - client.startedAt) : null
      });
    };
    const timeout = setTimeout(() => {
      sendCancel();
      complete(new Error(`Native filesystem helper ${op} timed out.`));
    }, Math.max(100, Number(timeoutMs || 60000)));
    client.pending.set(requestId, { complete, onProgress });
    signal?.addEventListener("abort", onAbort, { once: true });
    client.child.stdin.write(
      `${JSON.stringify({ version: 1, id: requestId, op, ...payload })}\n`,
      (error) => {
        if (error) complete(error);
      }
    );
  });
}

function stopNativeFilesystemHelperClient() {
  const client = nativeFilesystemHelperClientState;
  nativeFilesystemHelperClientState = null;
  if (!client) return;
  failNativeFilesystemHelperClient(client, new Error("Native filesystem helper stopped."));
  if (client.child.exitCode === null) {
    client.child.stdin.end();
    client.child.kill();
  }
}

function shouldWarmNativeFilesystemHelper() {
  const configured = process.env.EXPLORE_BETTER_NATIVE_HELPER_WARMUP;
  return (
    process.platform === "win32" &&
    configured !== "0" &&
    (configured === "1" || Boolean(process.versions.electron)) &&
    Boolean(nativeFilesystemHelperPath())
  );
}

async function warmNativeFilesystemHelper() {
  if (!shouldWarmNativeFilesystemHelper()) return null;
  return nativeFilesystemHelperRequest("hello", {}, { timeoutMs: 5000 });
}

async function nativeDirectoryListing(dir, expectedEntries, signal) {
  const result = await nativeFilesystemHelperRequest(
    "browse",
    { path: dir, maxEntries: expectedEntries, compact: true },
    { signal, timeoutMs: 60000 }
  );
  const payload = result.data?.entries;
  const rowCount = nativeBrowseEntryCount(payload);
  if (result.data?.truncated || rowCount !== Number(expectedEntries || 0)) {
    throw new Error(`Native directory browse returned ${rowCount} of ${expectedEntries} entries.`);
  }
  return {
    entries: Array.from({ length: rowCount }, (_, index) =>
      entryFromNativeBrowseRow(dir, Array.isArray(payload) ? payload[index] : payload, index)
    ),
    helperPath: result.helperPath,
    helperPid: result.helperPid,
    clientReused: result.clientReused,
    requestMs: result.requestMs,
    helperStartupMs: result.helperStartupMs,
    returned: rowCount
  };
}

function streamingDirectoryWindowListingEligible(targetStats, options = {}) {
  const windowOptions = options.windowOptions;
  return (
    process.env.EXPLORE_BETTER_STREAMING_WINDOW !== "0" &&
    targetStats?.isDirectory?.() === true &&
    options.showHidden === true &&
    options.includeDimensions !== true &&
    options.includeLinks !== true &&
    options.includeAttributes !== true &&
    options.includeSignature !== true &&
    windowOptions &&
    Number(windowOptions.offset || 0) === 0 &&
    Number(windowOptions.limit || 0) > 0
  );
}

async function streamingDirectoryWindowListing(params) {
  const {
    timingStart,
    signal,
    priority,
    statConcurrency,
    requestedOriginal,
    redirected,
    targetStats,
    dir,
    targetMs,
    labelState,
    windowOptions
  } = params;
  const limit = boundedInteger(windowOptions?.limit, directoryListingWindowMaxEntries, {
    min: 1,
    max: directoryListingWindowMaxEntries
  });
  const readStart = monotonicMs();
  const sampled = [];
  const directory = await fs.opendir(dir, { bufferSize: Math.min(1024, Math.max(32, limit + 1)) });
  try {
    for await (const dirent of directory) {
      throwIfAborted(signal);
      sampled.push(dirent);
      if (sampled.length > limit) break;
    }
  } finally {
    await directory.close().catch(() => {});
  }
  const hasMore = sampled.length > limit;
  const dirents = sampled.slice(0, limit);
  const readMs = elapsedMs(readStart);
  const statStart = monotonicMs();
  const statResults = await mapConcurrent(
    dirents,
    statConcurrency,
    async (dirent, index, workerSignal) => {
      try {
        return await statEntry(dir, dirent, null, {
          signal: workerSignal,
          includeDimensions: false,
          includeLinks: false,
          includeAttributes: false,
          dimensionsCache: null
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        return unavailableEntry(dir, dirent, null);
      }
    },
    { signal }
  );
  const statMs = elapsedMs(statStart);
  const labelStart = monotonicMs();
  const labelMap = labelState ? labelState.labelMap : await readLabelMap();
  const entries = attachPathLabels(statResults, labelMap);
  const labelMs = elapsedMs(labelStart);
  const totalEntries = hasMore ? null : entries.length;
  const windowInfo = {
    offset: 0,
    limit,
    returned: entries.length,
    total: totalEntries,
    totalKnown: !hasMore,
    hasMore,
    maxLimit: directoryListingWindowMaxEntries,
    streamingFastPath: true
  };
  return {
    path: dir,
    requestedPath: requestedOriginal,
    redirectedFrom: redirected ? requestedOriginal : null,
    selectedPath: null,
    targetKind: targetStats.isDirectory() ? "directory" : targetStats.isFile() ? "file" : "other",
    name: isRoot(dir) ? dir : path.basename(dir),
    parent: isRoot(dir) ? null : path.dirname(dir),
    folderSignature: null,
    showHidden: true,
    hiddenFiltered: 0,
    includeDimensions: false,
    includeLinks: false,
    includeAttributes: false,
    includeSignature: false,
    dimensionsCache: null,
    window: windowInfo,
    timing: {
      totalMs: elapsedMs(timingStart),
      targetMs,
      readMs,
      statMs,
      dimensionsCacheMs: 0,
      filterMs: 0,
      signatureMs: 0,
      labelMs,
      scanned: sampled.length,
      returned: entries.length,
      totalEntries,
      concurrency: statConcurrency,
      provider: "node-stream-window",
      priority,
      window: windowInfo
    },
    entries
  };
}

function nativeFullDirectoryListingEligible(dir, targetStats, options = {}) {
  return (
    process.platform === "win32" &&
    process.env.EXPLORE_BETTER_DISABLE_NATIVE_LISTING !== "1" &&
    process.env.EXPLORE_BETTER_NATIVE_FULL_LISTING !== "0" &&
    targetStats?.isDirectory?.() === true &&
    !String(dir || "").startsWith("\\\\") &&
    options.includeDimensions !== true &&
    options.includeLinks !== true &&
    !options.windowOptions &&
    Boolean(nativeFilesystemHelperPath())
  );
}

async function nativeFullDirectoryListing(params) {
  const {
    timingStart,
    signal,
    showHidden,
    includeAttributes,
    includeSignature,
    priority,
    requestedOriginal,
    redirected,
    targetStats,
    dir,
    targetMs,
    labelState,
    listingCacheContext
  } = params;
  const nativeResult = await nativeFilesystemHelperRequest(
    "browse",
    { path: dir, maxEntries: 500000, showHidden, compact: true },
    { signal, timeoutMs: 60000 }
  );
  const payload = nativeResult.data?.entries;
  const rowCount = nativeBrowseEntryCount(payload);
  const totalEntries = Math.max(rowCount, Number(nativeResult.data?.total ?? rowCount));
  if (nativeResult.data?.truncated || rowCount !== totalEntries) {
    throw new Error(`Native full browse returned ${rowCount} of ${totalEntries} entries.`);
  }
  throwIfAborted(signal);

  const mapStart = monotonicMs();
  const mappedEntries = Array.from({ length: rowCount }, (_, index) =>
    entryFromNativeBrowseRow(dir, Array.isArray(payload) ? payload[index] : payload, index)
  );
  const mapMs = elapsedMs(mapStart);
  const signatureStart = monotonicMs();
  const folderSignature = includeSignature ? folderSignatureFromEntries(mappedEntries) : null;
  const signatureMs = includeSignature ? elapsedMs(signatureStart) : 0;
  const labelStart = monotonicMs();
  const labelMap = labelState ? labelState.labelMap : await readLabelMap();
  const entries = attachPathLabels(mappedEntries, labelMap);
  const labelMs = elapsedMs(labelStart);
  const hiddenFiltered = Number(nativeResult.data?.hiddenFiltered || 0);
  const cacheInfo = listingCacheContext
    ? {
        hit: false,
        source: "server-listing-cache",
        eligible: true,
        watcherAvailable: listingCacheContext.watcherAvailable,
        watcherVersion: listingCacheContext.watchVersion,
        includeDimensions: false,
        includeLinks: false,
        includeAttributes,
        includeSignature,
        probeMs: listingCacheContext.probeMs,
        stampValidated: false,
        directoryStamp: listingCacheContext.dirStamp || null,
        stored: false,
        missReason: listingCacheContext.skipReason || "miss",
        reason: listingCacheContext.skipReason || "miss",
        entries: entries.length,
        totalEntriesCached: directoryListingCacheEntryTotal()
      }
    : null;
  const listing = {
    path: dir,
    requestedPath: requestedOriginal,
    redirectedFrom: redirected ? requestedOriginal : null,
    selectedPath: null,
    targetKind: targetStats.isDirectory() ? "directory" : "other",
    name: isRoot(dir) ? dir : path.basename(dir),
    parent: isRoot(dir) ? null : path.dirname(dir),
    folderSignature,
    showHidden,
    hiddenFiltered,
    includeDimensions: false,
    includeLinks: false,
    includeAttributes,
    includeSignature,
    dimensionsCache: null,
    timing: {
      totalMs: elapsedMs(timingStart),
      targetMs,
      readMs: 0,
      statMs: nativeResult.requestMs,
      mapMs,
      dimensionsCacheMs: 0,
      filterMs: 0,
      signatureMs,
      labelMs,
      scanned: totalEntries + hiddenFiltered,
      returned: entries.length,
      concurrency: 1,
      provider: "win32-find-files-full",
      priority,
      native: {
        helperPid: nativeResult.helperPid,
        clientReused: nativeResult.clientReused,
        requestMs: nativeResult.requestMs,
        helperStartupMs: nativeResult.helperStartupMs,
        serializedEntries: rowCount,
        wireFormat: payload?.format || "objects-v1"
      },
      ...(cacheInfo ? { cache: cacheInfo } : {})
    },
    ...(cacheInfo ? { cache: cacheInfo } : {}),
    entries
  };
  if (cacheInfo) {
    Object.assign(cacheInfo, rememberDirectoryListingCache(listing, listingCacheContext));
  }
  return listing;
}

function nativeDirectoryWindowListingEligible(dir, targetStats, options = {}) {
  const windowOptions = options.windowOptions;
  return (
    process.platform === "win32" &&
    process.env.EXPLORE_BETTER_DISABLE_NATIVE_LISTING !== "1" &&
    process.env.EXPLORE_BETTER_NATIVE_LISTING_FASTPATH !== "0" &&
    targetStats?.isDirectory?.() === true &&
    !String(dir || "").startsWith("\\\\") &&
    options.includeDimensions !== true &&
    options.includeLinks !== true &&
    options.includeSignature !== true &&
    windowOptions &&
    Number(windowOptions.offset || 0) === 0 &&
    Number(windowOptions.limit || 0) > 0 &&
    Boolean(nativeFilesystemHelperPath())
  );
}

async function nativeDirectoryWindowListing(params) {
  const {
    timingStart,
    signal,
    showHidden,
    includeAttributes,
    priority,
    requestedOriginal,
    redirected,
    targetStats,
    dir,
    targetMs,
    labelState,
    windowOptions
  } = params;
  const limit = boundedInteger(windowOptions?.limit, directoryListingWindowMaxEntries, {
    min: 1,
    max: directoryListingWindowMaxEntries
  });
  const nativeResult = await nativeFilesystemHelperRequest(
    "browse",
    { path: dir, maxEntries: limit, showHidden, compact: true },
    { signal, timeoutMs: 60000 }
  );
  const payload = nativeResult.data?.entries;
  const rowCount = nativeBrowseEntryCount(payload);
  const totalEntries = Math.max(rowCount, Number(nativeResult.data?.total ?? rowCount));
  if (rowCount > limit || (nativeResult.data?.truncated && rowCount !== Math.min(limit, totalEntries))) {
    throw new Error(`Native window browse returned an invalid ${rowCount}/${totalEntries} entry window.`);
  }
  const labelStart = monotonicMs();
  const labelMap = labelState ? labelState.labelMap : await readLabelMap();
  const entries = attachPathLabels(
    Array.from({ length: rowCount }, (_, index) =>
      entryFromNativeBrowseRow(dir, Array.isArray(payload) ? payload[index] : payload, index)
    ),
    labelMap
  );
  const labelMs = elapsedMs(labelStart);
  const hiddenFiltered = Number(nativeResult.data?.hiddenFiltered || 0);
  const windowInfo = {
    offset: 0,
    limit,
    returned: entries.length,
    total: totalEntries,
    hasMore: entries.length < totalEntries,
    maxLimit: directoryListingWindowMaxEntries,
    nativeFastPath: true
  };
  return {
    path: dir,
    requestedPath: requestedOriginal,
    redirectedFrom: redirected ? requestedOriginal : null,
    selectedPath: null,
    targetKind: targetStats.isDirectory() ? "directory" : targetStats.isFile() ? "file" : "other",
    name: isRoot(dir) ? dir : path.basename(dir),
    parent: isRoot(dir) ? null : path.dirname(dir),
    folderSignature: null,
    showHidden,
    hiddenFiltered,
    includeDimensions: false,
    includeLinks: false,
    includeAttributes,
    includeSignature: false,
    dimensionsCache: null,
    window: windowInfo,
    timing: {
      totalMs: elapsedMs(timingStart),
      targetMs,
      readMs: 0,
      statMs: nativeResult.requestMs,
      dimensionsCacheMs: 0,
      filterMs: 0,
      signatureMs: 0,
      labelMs,
      scanned: totalEntries + hiddenFiltered,
      returned: entries.length,
      totalEntries,
      concurrency: 1,
      provider: "win32-find-files-window",
      priority,
      window: windowInfo,
      native: {
        helperPid: nativeResult.helperPid,
        clientReused: nativeResult.clientReused,
        requestMs: nativeResult.requestMs,
        helperStartupMs: nativeResult.helperStartupMs,
        serializedEntries: rowCount,
        wireFormat: payload?.format || "objects-v1"
      }
    },
    entries
  };
}

async function nativeAllocationSnapshot(rootPath, maxEntries, signal) {
  if (process.platform !== "win32" || String(rootPath).startsWith("\\\\")) {
    return null;
  }
  if (!nativeFilesystemHelperPath()) {
    return null;
  }
  const result = await nativeFilesystemHelperRequest(
    "scan-tree",
    { path: rootPath, maxEntries, compact: true },
    { signal, timeoutMs: 120000 }
  );
  const payload = result.data?.entries;
  const rows = Array.isArray(payload)
    ? payload
    : payload?.format === "columns-v1" && Array.isArray(payload.p)
      ? payload.p.map((itemPath, index) => ({
          path: path.isAbsolute(itemPath) ? itemPath : path.join(String(payload.root || rootPath), itemPath),
          directory: Number(payload.d?.[index] || 0) === 1,
          logicalBytes: Number(payload.s?.[index] || 0),
          allocatedBytes: Number(payload.a?.[index] || 0),
          modifiedMs: Number(payload.m?.[index] || 0)
        }))
      : [];
  const entries = new Map();
  for (const entry of rows) {
    if (!entry.directory) {
      entries.set(pathIdentity(entry.path), Number(entry.allocatedBytes || 0));
    }
  }
  return {
    entries,
    rows,
    completeEntries: result.data?.entryLimitMode === "all-entries",
    truncated: result.data?.truncated === true,
    allocatedSource: result.data?.volume?.allocatedSource || "win32-get-compressed-file-size",
    allocationAccuracy: result.data?.volume?.allocationAccuracy || "exact",
    clusterSize: Number(result.data?.volume?.clusterSize || 0),
    helperPath: result.helperPath,
    helperPid: result.helperPid,
    clientReused: result.clientReused,
    requestMs: result.requestMs,
    helperFiles: Number(result.data?.files || 0),
    helperFolders: Number(result.data?.folders || 0),
    helperScannedEntries: Number(result.data?.scannedEntries || rows.length || 0),
    wireFormat: result.data?.wireFormat || payload?.format || "objects-v1",
    timing: result.data?.timing || null,
    skipped: Number(result.data?.skipped || 0)
  };
}

function allocatedBytesForPath(itemPath, bytes, allocationSnapshot) {
  const key = pathIdentity(itemPath);
  if (allocationSnapshot?.entries?.has(key)) {
    return allocationSnapshot.entries.get(key);
  }
  return allocatedBytesForSize(bytes, allocationSnapshot?.clusterSize || 4096);
}

const sizeAnalysisCategoryExtensions = [
  ["Video", new Set([".mkv", ".mp4", ".mov", ".avi", ".wmv", ".webm", ".m4v", ".mpg", ".mpeg"])],
  ["Audio", new Set([".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".wma"])],
  ["Images", new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".raw"])],
  ["Archives", new Set([".zip", ".7z", ".rar", ".tar", ".gz", ".bz2", ".xz", ".iso"])],
  ["Applications", new Set([".exe", ".msi", ".appx", ".msix", ".bat", ".cmd", ".ps1"])],
  ["System", new Set([".dll", ".sys", ".drv", ".ocx", ".mui"])],
  ["Documents", new Set([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".md", ".rtf", ".csv"])],
  ["Code", new Set([".js", ".jsx", ".ts", ".tsx", ".json", ".css", ".html", ".htm", ".mjs", ".cjs", ".py", ".cs", ".cpp", ".c", ".h"])]
];

function sizeAnalysisCategoryForExtension(extension) {
  const value = String(extension || "").trim().toLowerCase();
  const label = value.startsWith(".") && !value.includes("/") && !value.includes("\\")
    ? value
    : extensionBucketFor(value);
  if (label === "(none)") {
    return "No Extension";
  }
  for (const [category, extensions] of sizeAnalysisCategoryExtensions) {
    if (extensions.has(label)) {
      return category;
    }
  }
  return "Other";
}

function rememberExtensionStat(extensionStats, fileName, bytes, allocated = bytes) {
  const extension = extensionBucketFor(fileName);
  const current =
    extensionStats.get(extension) || {
      extension,
      kind: extension === "(none)" ? "No Extension" : entryKind(fileName, false),
      category: sizeAnalysisCategoryForExtension(extension),
      files: 0,
      size: 0,
      allocated: 0
    };
  current.files += 1;
  current.size += bytes;
  current.allocated += allocated;
  extensionStats.set(extension, current);
}

function rememberCategoryStat(categoryStats, fileName, bytes, allocated = bytes) {
  const extension = extensionBucketFor(fileName);
  const category = sizeAnalysisCategoryForExtension(extension);
  const current =
    categoryStats.get(category) || {
      category,
      files: 0,
      size: 0,
      allocated: 0
    };
  current.files += 1;
  current.size += bytes;
  current.allocated += allocated;
  categoryStats.set(category, current);
}

async function sizeAnalysisSpaceForPath(rootPath) {
  const spaceRoot = path.parse(rootPath).root || rootPath;
  return {
    root: spaceRoot,
    ...(await driveSpaceForPath(spaceRoot))
  };
}

function compactSizeTree(node, options = {}) {
  const maxDepth = sizeAnalysisOptionNumber(options.maxDepth, 5, 1, 12);
  const maxChildren = sizeAnalysisOptionNumber(options.maxChildren, 36, 4, 120);
  const visit = (source, depth) => {
    const children = depth < maxDepth ? [...source.children].sort((left, right) => right.size - left.size) : [];
    const visible = children.slice(0, maxChildren).map((child) => visit(child, depth + 1));
    const hidden = children.slice(maxChildren);
    if (hidden.length) {
      visible.push({
      id: `${source.id}-other-${depth}`,
      name: "Other",
      path: source.path,
      size: hidden.reduce((total, child) => total + child.size, 0),
      allocated: hidden.reduce((total, child) => total + Number(child.allocated || 0), 0),
      files: hidden.reduce((total, child) => total + child.files, 0),
      folders: hidden.reduce((total, child) => total + child.folders + 1, 0),
      depth: depth + 1,
      modified: null,
      children: []
      });
    }
    return {
      id: source.id,
      name: source.name,
      path: source.path,
      size: source.size,
      allocated: source.allocated,
      files: source.files,
      folders: source.folders,
      depth: source.depth,
      modified: source.modified,
      children: visible
    };
  };
  return visit(node, 0);
}

function sizeAnalysisCacheStamp(stats) {
  if (!stats) {
    return null;
  }
  return {
    mtimeUs: Math.round(Number(stats.mtimeMs || 0) * 1000),
    ctimeUs: Math.round(Number(stats.ctimeMs || 0) * 1000),
    size: Number(stats.size || 0),
    directory: stats.isDirectory?.() === true,
    file: stats.isFile?.() === true
  };
}

function sizeAnalysisCacheStampMatches(left, right) {
  return (
    left &&
    right &&
    left.mtimeUs === right.mtimeUs &&
    left.ctimeUs === right.ctimeUs &&
    left.size === right.size &&
    left.directory === right.directory &&
    left.file === right.file
  );
}

function sizeAnalysisCacheKey(rootPath, options = {}) {
  return [
    pathIdentity(rootPath),
    options.followLinks === true ? "links" : "nolinks",
    Number(options.maxEntries || 0),
    Number(options.maxDepth || 0),
    Number(options.maxChildren || 0)
  ].join("\u001f");
}

function pruneSizeAnalysisCache() {
  while (sizeAnalysisCache.size > sizeAnalysisCacheLimit) {
    const oldest = [...sizeAnalysisCache.entries()].sort(
      (left, right) => Number(left[1].lastAccess || 0) - Number(right[1].lastAccess || 0)
    )[0]?.[0];
    if (!oldest) {
      break;
    }
    sizeAnalysisCache.delete(oldest);
  }
}

function cachedSizeAnalysisReport(cached, startedAt) {
  const now = Date.now();
  cached.lastAccess = now;
  const summary = {
    ...(cached.report.summary || {}),
    elapsedMs: elapsedMs(startedAt)
  };
  const report = {
    ...cached.report,
    summary,
    cache: {
      hit: true,
      source: "size-analysis-cache",
      ageMs: Math.max(0, now - Number(cached.cachedAt || now)),
      ttlMs: sizeAnalysisCacheTtlMs,
      originalElapsedMs: cached.report.summary?.elapsedMs ?? null,
      cacheKey: cached.cacheKey
    }
  };
  if (cached.serializedBody) {
    Object.defineProperty(report, serializedJsonBody, { value: cached.serializedBody });
  }
  return report;
}

function readSizeAnalysisCache(context, startedAt) {
  const cached = sizeAnalysisCache.get(context.cacheKey);
  if (!cached) {
    return null;
  }
  const ageMs = Math.max(0, Date.now() - Number(cached.cachedAt || 0));
  if (ageMs > sizeAnalysisCacheTtlMs) {
    sizeAnalysisCache.delete(context.cacheKey);
    return null;
  }
  if (!sizeAnalysisCacheStampMatches(cached.rootStamp, context.rootStamp)) {
    sizeAnalysisCache.delete(context.cacheKey);
    return null;
  }
  return cachedSizeAnalysisReport(cached, startedAt);
}

function rememberSizeAnalysisCache(report, context) {
  if (!context?.cacheKey || report?.accessError || context?.inFlightEntry?.invalidated === true) {
    return {
      stored: false,
      reason: context?.inFlightEntry?.invalidated === true ? "invalidated-during-scan" : "not-cacheable"
    };
  }
  const { cache, ...cacheableReport } = report;
  const now = Date.now();
  const serializedBody = JSON.stringify({
    ...cacheableReport,
    summary: {
      ...(cacheableReport.summary || {}),
      elapsedMs: 0
    },
    cache: {
      hit: true,
      source: "size-analysis-cache",
      ageMs: 0,
      ttlMs: sizeAnalysisCacheTtlMs,
      originalElapsedMs: cacheableReport.summary?.elapsedMs ?? null,
      cacheKey: context.cacheKey
    }
  });
  sizeAnalysisCache.set(context.cacheKey, {
    cacheKey: context.cacheKey,
    rootPath: context.rootPath,
    rootStamp: context.rootStamp,
    report: cacheableReport,
    serializedBody,
    cachedAt: now,
    lastAccess: now
  });
  pruneSizeAnalysisCache();
  return { stored: true, entries: Number(report.scanned || 0) };
}

function sizeAnalysisInFlightHitReport(report, context, entry, startedAt, joinedAt) {
  const originalCache = report?.cache || {};
  const summary = {
    ...(report?.summary || {}),
    elapsedMs: elapsedMs(startedAt)
  };
  return {
    ...report,
    requestedPath: context.requestedPath || report?.requestedPath,
    redirectedFrom: context.redirectedFrom ?? report?.redirectedFrom ?? null,
    summary,
    cache: {
      ...originalCache,
      hit: true,
      source: "size-analysis-inflight",
      coalesced: true,
      originSource: originalCache.source || "filesystem",
      originStored: originalCache.stored === true,
      waitMs: elapsedMs(joinedAt),
      startedAgeMs: elapsedMs(entry.startedAt),
      joinedWaiters: Number(entry.joined || 0),
      joinedScanned: 0,
      ttlMs: sizeAnalysisCacheTtlMs,
      cacheKey: context.cacheKey
    }
  };
}

async function coalescedSizeAnalysisReport(context, loader, startedAt) {
  if (!context?.cacheKey) {
    return loader();
  }
  const inFlightKey = sizeAnalysisInFlightKey(context);
  const existing = sizeAnalysisInFlight.get(inFlightKey);
  if (existing) {
    existing.joined += 1;
    const joinedAt = monotonicMs();
    let report;
    try {
      report = await existing.promise;
    } catch (error) {
      if (isAbortError(error) && !context?.signal?.aborted) {
        existing.invalidated = true;
        context.restartedAfterAbortedInFlight = Number(context.restartedAfterAbortedInFlight || 0) + 1;
        if (sizeAnalysisInFlight.get(inFlightKey) === existing) {
          sizeAnalysisInFlight.delete(inFlightKey);
        }
        return coalescedSizeAnalysisReport(context, loader, startedAt);
      }
      throw error;
    }
    if (existing.invalidated === true) {
      return coalescedSizeAnalysisReport(context, loader, startedAt);
    }
    return sizeAnalysisInFlightHitReport(report, context, existing, startedAt, joinedAt);
  }
  const entry = {
    key: inFlightKey,
    cacheKey: context.cacheKey,
    rootPath: context.rootPath,
    rootStamp: context.rootStamp,
    startedAt: monotonicMs(),
    joined: 0,
    invalidated: false,
    promise: null
  };
  context.inFlightEntry = entry;
  entry.promise = Promise.resolve().then(loader);
  sizeAnalysisInFlight.set(inFlightKey, entry);
  try {
    const report = await entry.promise;
    if (entry.invalidated === true) {
      if (report?.cache) {
        report.cache.invalidatedDuringScan = true;
        report.cache.stored = false;
        report.cache.storeReason = report.cache.storeReason || "invalidated-during-scan";
      }
    }
    if (Number(context.restartedAfterAbortedInFlight || 0) > 0 && report?.cache) {
      report.cache.restartedAfterAbortedInFlight = Number(context.restartedAfterAbortedInFlight || 0);
    }
    return report;
  } finally {
    if (sizeAnalysisInFlight.get(inFlightKey) === entry) {
      sizeAnalysisInFlight.delete(inFlightKey);
    }
    if (context.inFlightEntry === entry) {
      delete context.inFlightEntry;
    }
  }
}

async function sizeAnalysisReport(body = {}, options = {}) {
  const signal = options.signal || null;
  const requested = resolveUserPath(body.path || os.homedir());
  const redirected = await windowsLegacyFolderRedirectForPath(requested);
  const rootPath = redirected || requested;
  const followLinks = body.followLinks === true;
  const maxEntries = sizeAnalysisOptionNumber(body.maxEntries, 100_000, 100, 500_000);
  const maxDepth = sizeAnalysisOptionNumber(body.maxDepth, 5, 1, 12);
  const maxChildren = sizeAnalysisOptionNumber(body.maxChildren, 36, 4, 120);
  const startedAt = monotonicMs();
  const skipped = [];
  const extensionStats = new Map();
  const categoryStats = new Map();
  const topFiles = [];
  const folders = [];
  let scanned = 0;
  let truncated = false;

  throwIfAborted(signal);
  const rootNode = makeSizeNode(rootPath);
  let rootLstat;
  let rootStats;
  try {
    rootLstat = await fs.lstat(rootPath);
    rootStats = rootLstat.isSymbolicLink() ? await fs.stat(rootPath) : rootLstat;
  } catch (error) {
    if (!isAccessError(error)) {
      throw error;
    }
    skipped.push({ path: rootPath, reason: error.code || error.message || "unreadable" });
    return {
      generatedAt: new Date().toISOString(),
      path: rootPath,
      requestedPath: requested,
      redirectedFrom: redirected ? requested : null,
      followLinks,
      maxEntries,
      scanned,
      truncated: false,
      skipped,
      accessError: {
        code: String(error.code || "ACCESS_DENIED"),
        message: error.message || "Folder cannot be read.",
        path: rootPath
      },
      space: null,
      allocatedSource: "unavailable",
      clusterSize: null,
      allocationAccuracy: "unknown",
      summary: {
        bytes: 0,
        allocated: 0,
        files: 0,
        folders: 0,
        extensions: 0,
        categories: 0,
        skipped: skipped.length,
        elapsedMs: elapsedMs(startedAt)
      },
      tree: compactSizeTree(rootNode, { maxDepth, maxChildren }),
      topFolders: [],
      topFiles: [],
      extensions: [],
      categories: []
      };
  }

  const cacheContext = {
    cacheKey: sizeAnalysisCacheKey(rootPath, { followLinks, maxEntries, maxDepth, maxChildren }),
    rootPath,
    rootStamp: sizeAnalysisCacheStamp(rootStats),
    requestedPath: requested,
    redirectedFrom: redirected ? requested : null,
    signal
  };
  const cachedReport = readSizeAnalysisCache(cacheContext, startedAt);
  if (cachedReport) {
    return cachedReport;
  }

  return coalescedSizeAnalysisReport(cacheContext, async () => {
    const space = await sizeAnalysisSpaceForPath(rootPath);
    throwIfAborted(signal);
    const allocationSnapshot = await nativeAllocationSnapshot(rootPath, maxEntries, signal).catch((error) => {
      if (isAbortError(error)) throw error;
      return null;
    });
    const clusterSize = allocationSnapshot?.clusterSize || 4096;
    const allocatedSource = allocationSnapshot?.allocatedSource || "cluster-size-estimate";
    const allocationAccuracy = allocationSnapshot?.allocationAccuracy || "estimated";

  if (rootStats.isFile()) {
    const bytes = Number(rootStats.size || 0);
    const allocated = allocatedBytesForPath(rootPath, bytes, allocationSnapshot);
    addFileToSizeNode(rootNode, bytes, allocated, rootStats.mtimeMs);
    rememberExtensionStat(extensionStats, rootPath, bytes, allocated);
    rememberCategoryStat(categoryStats, rootPath, bytes, allocated);
    rememberTopFile(topFiles, {
      name: path.basename(rootPath),
      path: rootPath,
      parent: path.dirname(rootPath),
      extension: extensionBucketFor(rootPath),
      kind: entryKind(rootPath, false),
      category: sizeAnalysisCategoryForExtension(rootPath),
      size: bytes,
      allocated,
      modified: rootStats.mtimeMs
    });
  } else if (rootStats.isDirectory()) {
    folders.push(rootNode);
    if (allocationSnapshot?.completeEntries && !followLinks) {
      const nodesByPath = new Map([[pathIdentity(rootPath), rootNode]]);
      const nativeRows = allocationSnapshot.rows.slice(0, maxEntries);
      for (const row of nativeRows.filter((item) => item.directory === true)) {
        throwIfAborted(signal);
        const fullPath = String(row.path || "");
        const current = nodesByPath.get(pathIdentity(path.dirname(fullPath)));
        if (!fullPath || !current) {
          skipped.push({ path: fullPath || rootPath, reason: "native parent unavailable" });
          continue;
        }
        const child = makeSizeNode(fullPath, current, current.depth + 1);
        child.modified = Number(row.modifiedMs || 0) || null;
        current.children.push(child);
        folders.push(child);
        nodesByPath.set(pathIdentity(fullPath), child);
        addFolderToSizeNode(current);
        scanned += 1;
      }
      for (const row of nativeRows.filter((item) => item.directory !== true)) {
        throwIfAborted(signal);
        const fullPath = String(row.path || "");
        const fileName = String(row.name || path.basename(fullPath));
        const current = nodesByPath.get(pathIdentity(path.dirname(fullPath)));
        if (!fullPath || !current) {
          skipped.push({ path: fullPath || rootPath, reason: "native parent unavailable" });
          continue;
        }
        const bytes = Number(row.logicalBytes || 0);
        const allocated = Number(row.allocatedBytes || allocatedBytesForPath(fullPath, bytes, allocationSnapshot));
        const modified = Number(row.modifiedMs || 0) || null;
        addFileToSizeNode(current, bytes, allocated, modified);
        rememberExtensionStat(extensionStats, fileName, bytes, allocated);
        rememberCategoryStat(categoryStats, fileName, bytes, allocated);
        rememberTopFile(topFiles, {
          name: fileName,
          path: fullPath,
          parent: current.path,
          extension: extensionBucketFor(fileName),
          kind: entryKind(fileName, false),
          category: sizeAnalysisCategoryForExtension(fileName),
          size: bytes,
          allocated,
          modified
        });
        scanned += 1;
      }
      scanned = Math.max(scanned, allocationSnapshot.helperScannedEntries);
      truncated = allocationSnapshot.truncated || scanned >= maxEntries;
    } else {
      const stack = [rootNode];
      while (stack.length) {
        throwIfAborted(signal);
        if (scanned >= maxEntries) {
          truncated = true;
          break;
        }
        const current = stack.pop();
        let dirents;
        try {
          dirents = await fs.readdir(current.path, { withFileTypes: true });
          throwIfAborted(signal);
        } catch (error) {
          skipped.push({ path: current.path, reason: error.code || error.message || "unreadable" });
          continue;
        }
        for (const dirent of dirents) {
          throwIfAborted(signal);
          if (scanned >= maxEntries) {
            truncated = true;
            break;
          }
          const fullPath = path.join(current.path, dirent.name);
          try {
            const lstat = await fs.lstat(fullPath);
            throwIfAborted(signal);
            scanned += 1;
            if (lstat.isSymbolicLink() && !followLinks) {
              skipped.push({ path: fullPath, reason: "link skipped" });
              continue;
            }
            const stats = lstat.isSymbolicLink() ? await fs.stat(fullPath) : lstat;
            throwIfAborted(signal);
            if (stats.isDirectory()) {
              const child = makeSizeNode(fullPath, current, current.depth + 1);
              current.children.push(child);
              folders.push(child);
              addFolderToSizeNode(current);
              stack.push(child);
            } else if (stats.isFile()) {
              const bytes = Number(stats.size || 0);
              const allocated = allocatedBytesForPath(fullPath, bytes, allocationSnapshot);
              addFileToSizeNode(current, bytes, allocated, stats.mtimeMs);
              rememberExtensionStat(extensionStats, dirent.name, bytes, allocated);
              rememberCategoryStat(categoryStats, dirent.name, bytes, allocated);
              rememberTopFile(topFiles, {
                name: dirent.name,
                path: fullPath,
                parent: current.path,
                extension: extensionBucketFor(dirent.name),
                kind: entryKind(dirent.name, false),
                category: sizeAnalysisCategoryForExtension(dirent.name),
                size: bytes,
                allocated,
                modified: stats.mtimeMs
              });
            }
          } catch (error) {
            if (isAbortError(error)) {
              throw error;
            }
            skipped.push({ path: fullPath, reason: error.code || error.message || "unavailable" });
          }
        }
        if (scanned > 0 && scanned % 1500 === 0) {
          await yieldToEventLoop();
          throwIfAborted(signal);
        }
      }
    }
  } else {
    skipped.push({ path: rootPath, reason: "not file or folder" });
  }

  throwIfAborted(signal);

  topFiles.sort((left, right) => Number(right.size || 0) - Number(left.size || 0));
  const topFolders = folders
    .filter((folder) => folder !== rootNode)
    .sort((left, right) => Number(right.size || 0) - Number(left.size || 0))
    .slice(0, 200)
    .map((folder) => ({
      name: folder.name,
      path: folder.path,
      parent: folder.parent?.path || "",
      parentSize: Number(folder.parent?.size || 0),
      parentAllocated: Number(folder.parent?.allocated || 0),
      size: folder.size,
      allocated: folder.allocated,
      files: folder.files,
      folders: folder.folders,
      modified: folder.modified
    }));
  const extensions = [...extensionStats.values()]
    .sort((left, right) => Number(right.size || 0) - Number(left.size || 0))
    .slice(0, 200);
  const categories = [...categoryStats.values()]
    .sort((left, right) => Number(right.size || 0) - Number(left.size || 0))
    .slice(0, 40);
  const nativeSkipped = allocationSnapshot?.completeEntries ? Number(allocationSnapshot.skipped || 0) : 0;

  const report = {
    generatedAt: new Date().toISOString(),
    path: rootPath,
    requestedPath: requested,
    redirectedFrom: redirected ? requested : null,
    followLinks,
    maxEntries,
    scanned,
    truncated: truncated || scanned >= maxEntries,
    skipped: skipped.slice(0, 500),
    space,
    allocatedSource,
    clusterSize,
    allocationAccuracy,
    allocationProvider: allocationSnapshot ? "native-go-helper" : "node-fallback",
    scanProvider: allocationSnapshot?.completeEntries ? "native-go-helper-single-pass" : "node-walk",
    native: allocationSnapshot
      ? {
          requestMs: allocationSnapshot.requestMs,
          helperPid: allocationSnapshot.helperPid,
          clientReused: allocationSnapshot.clientReused,
          scannedEntries: allocationSnapshot.helperScannedEntries,
          files: allocationSnapshot.helperFiles,
          folders: allocationSnapshot.helperFolders,
          wireFormat: allocationSnapshot.wireFormat,
          timing: allocationSnapshot.timing,
          singlePass: allocationSnapshot.completeEntries === true
        }
      : null,
    summary: {
      bytes: rootNode.size,
      allocated: rootNode.allocated,
      files: rootNode.files,
      folders: rootNode.folders,
      extensions: extensionStats.size,
      categories: categoryStats.size,
      skipped: skipped.length + nativeSkipped,
      elapsedMs: elapsedMs(startedAt)
    },
    tree: compactSizeTree(rootNode, { maxDepth, maxChildren }),
    topFolders,
    topFiles: topFiles.slice(0, 1200),
    extensions,
    categories,
    cache: {
      hit: false,
      source: "filesystem",
      ttlMs: sizeAnalysisCacheTtlMs,
      cacheKey: cacheContext.cacheKey
    }
  };
  const cacheStore = rememberSizeAnalysisCache(report, cacheContext);
  report.cache.stored = cacheStore?.stored === true;
  if (cacheStore?.reason) {
    report.cache.storeReason = cacheStore.reason;
  }
  return report;
  }, startedAt);
}

function normalizeChecksumOptions(body = {}) {
  const algorithm = ["sha1", "sha256", "md5"].includes(String(body.algorithm || "").toLowerCase())
    ? String(body.algorithm).toLowerCase()
    : "sha256";
  const format = ["manifest", "csv", "json"].includes(String(body.format || "").toLowerCase())
    ? String(body.format).toLowerCase()
    : "manifest";
  return {
    algorithm,
    format,
    maxHashBytes: Math.max(1, Math.min(Number(body.maxHashBytes || 134_217_728), 1_073_741_824))
  };
}

function commonParentForPaths(paths) {
  if (!paths.length) {
    return workspaceRoot;
  }
  const parents = paths.map((itemPath) => path.dirname(itemPath));
  const firstRoot = path.parse(parents[0]).root.toLowerCase();
  if (parents.some((parent) => path.parse(parent).root.toLowerCase() !== firstRoot)) {
    return "";
  }
  let common = parents[0];
  for (const parent of parents.slice(1)) {
    while (common && common !== path.dirname(common)) {
      const relative = path.relative(common, parent);
      if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        break;
      }
      common = path.dirname(common);
    }
  }
  return common || path.parse(paths[0]).root || workspaceRoot;
}

function checksumManifestName(itemPath, rootPath) {
  if (!rootPath) {
    return itemPath.replaceAll(path.sep, "/");
  }
  const relative = path.relative(rootPath, itemPath) || path.basename(itemPath);
  return relative.replaceAll(path.sep, "/");
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function checksumTextForReport(report) {
  if (report.format === "json") {
    return `${JSON.stringify(
      {
        generatedAt: report.generatedAt,
        algorithm: report.algorithm,
        basePath: report.basePath,
        summary: report.summary,
        items: report.items,
        skipped: report.skipped
      },
      null,
      2
    )}\n`;
  }

  if (report.format === "csv") {
    const rows = [["algorithm", "hash", "name", "path", "size"]].concat(
      report.items.map((item) => [report.algorithm, item.hash, item.name, item.path, item.size])
    );
    return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
  }

  return report.items.map((item) => `${item.hash} *${item.name}`).join("\n") + (report.items.length ? "\n" : "");
}

async function checksumReport(body) {
  const paths = Array.isArray(body.paths)
    ? body.paths.slice(0, 500)
    : body.path
      ? [body.path]
      : [];
  if (!paths.length) {
    throw new Error("Select at least one item.");
  }

  const options = normalizeChecksumOptions(body);
  const selected = paths.map((itemPath) => resolveUserPath(itemPath));
  const basePath = commonParentForPaths(selected);
  const items = [];
  const skipped = [];

  for (let index = 0; index < selected.length; index += 1) {
    const itemPath = selected[index];
    try {
      const stats = await fs.stat(itemPath);
      if (!stats.isFile()) {
        skipped.push({
          index,
          path: itemPath,
          name: checksumManifestName(itemPath, basePath),
          reason: stats.isDirectory() ? "Folders are skipped" : "Not a regular file"
        });
        continue;
      }
      const hash = await hashFile(itemPath, options.algorithm, options.maxHashBytes);
      if (!hash || hash.skipped) {
        skipped.push({
          index,
          path: itemPath,
          name: checksumManifestName(itemPath, basePath),
          size: stats.size,
          reason: hash?.reason || "Hash skipped"
        });
        continue;
      }
      items.push({
        index,
        path: itemPath,
        parent: path.dirname(itemPath),
        name: checksumManifestName(itemPath, basePath),
        fileName: path.basename(itemPath),
        size: stats.size,
        modified: stats.mtimeMs,
        algorithm: options.algorithm,
        hash: hash.value
      });
    } catch (error) {
      skipped.push({
        index,
        path: itemPath,
        name: checksumManifestName(itemPath, basePath),
        reason: error.message || "Unavailable"
      });
    }
  }

  const summary = {
    selected: selected.length,
    hashed: items.length,
    skipped: skipped.length,
    bytes: items.reduce((total, item) => total + Number(item.size || 0), 0),
    maxHashBytes: options.maxHashBytes
  };
  const report = {
    generatedAt: new Date().toISOString(),
    algorithm: options.algorithm,
    format: options.format,
    basePath,
    summary,
    items,
    skipped
  };
  return {
    ...report,
    text: checksumTextForReport(report)
  };
}

function checksumAlgorithmForHash(hash, fallback = "sha256") {
  const normalized = String(hash || "").trim().toLowerCase();
  if (/^[a-f0-9]{32}$/.test(normalized)) return "md5";
  if (/^[a-f0-9]{40}$/.test(normalized)) return "sha1";
  if (/^[a-f0-9]{64}$/.test(normalized)) return "sha256";
  return ["md5", "sha1", "sha256"].includes(fallback) ? fallback : null;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  row.push(cell);
  if (row.length > 1 || row[0]) {
    rows.push(row);
  }
  return rows;
}

function checksumTargetPath(reference, manifestDir) {
  const text = String(reference || "").trim().replace(/^["']|["']$/g, "");
  if (!text) {
    return "";
  }
  return path.isAbsolute(text) ? resolveUserPath(text) : resolveUserPath(path.join(manifestDir, denormalizeRelativePath(text)));
}

function parseChecksumJson(text, manifestDir, fallbackAlgorithm) {
  const parsed = JSON.parse(text);
  const sourceItems = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
  return sourceItems
    .map((item, index) => {
      const expectedHash = String(item.hash || item.value || item.checksum || "").trim().toLowerCase();
      const name = String(item.name || item.fileName || item.path || "").trim();
      const algorithm = checksumAlgorithmForHash(expectedHash, String(item.algorithm || parsed.algorithm || fallbackAlgorithm).toLowerCase());
      return {
        index,
        line: index + 1,
        name,
        path: checksumTargetPath(name || item.path, manifestDir),
        expectedHash,
        algorithm
      };
    })
    .filter((item) => item.expectedHash || item.name);
}

function parseChecksumCsv(text, manifestDir, fallbackAlgorithm) {
  const rows = parseCsvRows(text).filter((row) => row.some((cell) => String(cell).trim()));
  if (!rows.length) return [];
  const headers = rows[0].map((cell) => String(cell || "").trim().toLowerCase());
  const indexOf = (names) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0);
  const hashIndex = indexOf(["hash", "checksum", "value"]);
  const nameIndex = indexOf(["name", "file", "filename", "path"]);
  const pathIndex = headers.indexOf("path");
  const algorithmIndex = indexOf(["algorithm", "algo"]);
  if (hashIndex === undefined || (nameIndex === undefined && pathIndex < 0)) {
    return [];
  }

  return rows.slice(1).map((row, index) => {
    const expectedHash = String(row[hashIndex] || "").trim().toLowerCase();
    const name = String(row[nameIndex] || row[pathIndex] || "").trim();
    const algorithm = checksumAlgorithmForHash(expectedHash, String(row[algorithmIndex] || fallbackAlgorithm).toLowerCase());
    return {
      index,
      line: index + 2,
      name,
      path: checksumTargetPath(name, manifestDir),
      expectedHash,
      algorithm
    };
  });
}

function parseChecksumManifest(text, manifestDir, fallbackAlgorithm) {
  const entries = [];
  const skipped = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const match = line.match(/^([a-fA-F0-9]{32}|[a-fA-F0-9]{40}|[a-fA-F0-9]{64})\s+[\* ]?(.+)$/);
    if (!match) {
      skipped.push({
        index,
        line: index + 1,
        name: raw.slice(0, 120),
        path: "",
        status: "skipped",
        reason: "Unrecognized checksum line"
      });
      continue;
    }
    const expectedHash = match[1].toLowerCase();
    const name = match[2].trim().replace(/^["']|["']$/g, "");
    entries.push({
      index,
      line: index + 1,
      name,
      path: checksumTargetPath(name, manifestDir),
      expectedHash,
      algorithm: checksumAlgorithmForHash(expectedHash, fallbackAlgorithm)
    });
  }

  return { entries, skipped };
}

function parseChecksumEntries(text, manifestPath, fallbackAlgorithm) {
  const manifestDir = path.dirname(manifestPath);
  const trimmed = text.trim();
  if (!trimmed) {
    return { entries: [], skipped: [] };
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return { entries: parseChecksumJson(trimmed, manifestDir, fallbackAlgorithm), skipped: [] };
  }

  const csvEntries = parseChecksumCsv(text, manifestDir, fallbackAlgorithm);
  if (csvEntries.length) {
    return { entries: csvEntries, skipped: [] };
  }

  return parseChecksumManifest(text, manifestDir, fallbackAlgorithm);
}

function checksumVerificationText(report) {
  const lines = report.items.map((item) => {
    if (item.status === "ok") return `OK ${item.expectedHash} *${item.name}`;
    if (item.status === "mismatch") return `MISMATCH expected ${item.expectedHash} actual ${item.actualHash || ""} *${item.name}`;
    if (item.status === "missing") return `MISSING ${item.expectedHash || ""} *${item.name}`;
    return `SKIP ${item.reason || "Skipped"} *${item.name || item.path || ""}`;
  });
  return `${lines.join("\n")}${lines.length ? "\n" : ""}`;
}

async function verifyChecksumManifest(body = {}) {
  const paths = Array.isArray(body.paths)
    ? body.paths
    : body.manifestPath
      ? [body.manifestPath]
      : body.path
        ? [body.path]
        : [];
  const manifestPath = paths.length ? resolveUserPath(paths[0]) : "";
  if (!manifestPath) {
    throw new Error("Select a checksum manifest file.");
  }

  const stats = await fs.stat(manifestPath);
  if (!stats.isFile()) {
    throw new Error("Checksum manifest must be a file.");
  }
  const maxManifestBytes = Math.max(1, Math.min(Number(body.maxManifestBytes || 5_242_880), 20_971_520));
  if (stats.size > maxManifestBytes) {
    throw new Error(`Checksum manifest is larger than ${maxManifestBytes} bytes.`);
  }

  const options = normalizeChecksumOptions(body);
  const content = await fs.readFile(manifestPath, "utf8");
  const parsed = parseChecksumEntries(content, manifestPath, options.algorithm);
  const entries = parsed.entries.slice(0, 2_000);
  const items = [...parsed.skipped];
  if (!entries.length && !items.length) {
    throw new Error("No checksum entries found.");
  }

  for (const entry of entries) {
    const item = {
      index: entry.index,
      line: entry.line,
      name: entry.name,
      path: entry.path,
      expectedHash: entry.expectedHash,
      actualHash: "",
      algorithm: entry.algorithm,
      size: 0,
      status: "skipped",
      reason: ""
    };

    if (!entry.expectedHash || !entry.algorithm) {
      item.reason = "Unsupported checksum";
      items.push(item);
      continue;
    }
    if (!entry.path) {
      item.reason = "Missing target path";
      items.push(item);
      continue;
    }

    try {
      const targetStats = await fs.stat(entry.path);
      if (!targetStats.isFile()) {
        item.status = targetStats.isDirectory() ? "skipped" : "missing";
        item.reason = targetStats.isDirectory() ? "Folders are skipped" : "Not a file";
        items.push(item);
        continue;
      }
      item.size = targetStats.size;
      const hash = await hashFile(entry.path, entry.algorithm, options.maxHashBytes);
      if (!hash || hash.skipped) {
        item.status = "skipped";
        item.reason = hash?.reason || "Hash skipped";
      } else {
        item.actualHash = hash.value;
        item.status = item.actualHash.toLowerCase() === entry.expectedHash.toLowerCase() ? "ok" : "mismatch";
      }
    } catch (error) {
      item.status = "missing";
      item.reason =
        error.code === "ENOENT"
          ? "File not found"
          : ["EACCES", "EPERM"].includes(error.code)
            ? "Access denied"
            : error.message || "Unavailable";
    }
    items.push(item);
  }

  items.sort((left, right) => Number(left.line || 0) - Number(right.line || 0));
  const summary = items.reduce(
    (acc, item) => {
      acc.total += 1;
      acc[item.status] = (acc[item.status] || 0) + 1;
      acc.bytes += Number(item.status === "ok" || item.status === "mismatch" ? item.size || 0 : 0);
      return acc;
    },
    { total: 0, ok: 0, mismatch: 0, missing: 0, skipped: 0, bytes: 0 }
  );
  const report = {
    generatedAt: new Date().toISOString(),
    verification: true,
    manifestPath,
    basePath: path.dirname(manifestPath),
    algorithm: options.algorithm,
    format: "verify",
    summary,
    items
  };
  return {
    ...report,
    text: checksumVerificationText(report)
  };
}

async function getRoots() {
  const shortcuts = [
    { name: "Home", path: os.homedir(), kind: "home" },
    { name: "Desktop", path: path.join(os.homedir(), "Desktop"), kind: "desktop" },
    { name: "Documents", path: path.join(os.homedir(), "Documents"), kind: "documents" },
    { name: "Downloads", path: path.join(os.homedir(), "Downloads"), kind: "downloads" },
    { name: workspaceLabel, path: workspaceRoot, kind: "workspace" }
  ];

  const availableShortcuts = [];
  for (const shortcut of shortcuts) {
    if (await pathExists(shortcut.path)) {
      availableShortcuts.push(shortcut);
    }
  }

  const drives = [];
  if (process.platform === "win32") {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${letter}:\\`;
      if (await pathExists(root)) {
        drives.push({ name: root, path: root, kind: "drive", space: await driveSpaceForPath(root) });
      }
    }
  } else {
    drives.push({ name: "/", path: "/", kind: "drive", space: await driveSpaceForPath("/") });
  }

  return {
    cwd: workspaceRoot,
    home: os.homedir(),
    appDataRoot,
    stateFile,
    trashRoot,
    shortcuts: uniqueExistingPathItems(availableShortcuts),
    drives
  };
}

function uniqueExistingPathItems(items) {
  const seen = new Set();
  const clean = [];
  for (const item of items) {
    if (!item?.path) {
      continue;
    }
    const key = String(item.path).replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    clean.push(item);
  }
  return clean;
}

function windowsRoamingAppData() {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

function shellLibrariesDir() {
  return path.join(windowsRoamingAppData(), "Microsoft", "Windows", "Libraries");
}

function specialFolderCandidates() {
  const home = os.homedir();
  const userProfile = process.env.USERPROFILE || home;
  const candidates = [
    { id: "home", name: "Home", kind: "home", path: home },
    { id: "desktop", name: "Desktop", kind: "desktop", path: path.join(userProfile, "Desktop") },
    { id: "documents", name: "Documents", kind: "documents", path: path.join(userProfile, "Documents") },
    { id: "downloads", name: "Downloads", kind: "downloads", path: path.join(userProfile, "Downloads") },
    { id: "pictures", name: "Pictures", kind: "pictures", path: path.join(userProfile, "Pictures") },
    { id: "music", name: "Music", kind: "music", path: path.join(userProfile, "Music") },
    { id: "videos", name: "Videos", kind: "videos", path: path.join(userProfile, "Videos") },
    { id: "public", name: "Public", kind: "public", path: path.join(path.dirname(userProfile), "Public") },
    { id: "appData", name: "AppData", kind: "appData", path: windowsRoamingAppData() },
    { id: "localAppData", name: "Local AppData", kind: "localAppData", path: localAppData },
    { id: "appTrash", name: "App Trash", kind: "appTrash", path: trashRoot }
  ];
  for (const [id, envName, name] of [
    ["oneDrive", "OneDrive", "OneDrive"],
    ["oneDriveConsumer", "OneDriveConsumer", "OneDrive"],
    ["oneDriveCommercial", "OneDriveCommercial", "OneDrive Work"]
  ]) {
    if (process.env[envName]) {
      candidates.push({ id, name, kind: "oneDrive", path: process.env[envName] });
    }
  }
  return uniqueExistingPathItems(candidates);
}

async function existingSpecialFolders() {
  const folders = [];
  for (const candidate of specialFolderCandidates()) {
    if (await pathExists(candidate.path)) {
      folders.push({ ...candidate, detail: candidate.path, supportsPane: true });
    }
  }
  return folders;
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function libraryDisplayName(fileName) {
  return path.basename(fileName, path.extname(fileName)).replace(/[-_]+/g, " ").trim() || fileName;
}

function libraryId(fileName) {
  const slug =
    path
      .basename(fileName, path.extname(fileName))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "library";
  return `library:${slug}`;
}

function fileUrlToPathMaybe(value) {
  const text = decodeXmlEntities(value).trim();
  if (!text) {
    return "";
  }
  if (/^file:/i.test(text)) {
    try {
      return fileURLToPath(text);
    } catch {
      return "";
    }
  }
  return /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith("\\\\") ? text : "";
}

function parseLibraryTargetFolders(text) {
  const targets = [];
  const seen = new Set();
  const matches = String(text || "").matchAll(/<url>([\s\S]*?)<\/url>/gi);
  for (const match of matches) {
    const target = fileUrlToPathMaybe(match[1]);
    if (!target) {
      continue;
    }
    const key = target.replace(/[\\/]+$/, "").toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push(target);
  }
  return targets;
}

function libraryDetail(targetFolders, libraryPath) {
  if (!targetFolders.length) {
    return libraryPath;
  }
  const first = targetFolders[0];
  const suffix = targetFolders.length > 1 ? ` +${targetFolders.length - 1}` : "";
  return `${first}${suffix}`;
}

async function discoverWindowsLibraries() {
  if (process.platform !== "win32") {
    return [];
  }
  const dir = shellLibrariesDir();
  let dirents = [];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const libraries = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith(".library-ms")) {
      continue;
    }
    const libraryPath = path.join(dir, dirent.name);
    let targetFolders = [];
    try {
      targetFolders = parseLibraryTargetFolders(await fs.readFile(libraryPath, "utf8"));
    } catch {
      targetFolders = [];
    }
    libraries.push({
      id: libraryId(dirent.name),
      name: libraryDisplayName(dirent.name),
      kind: "library",
      detail: libraryDetail(targetFolders, libraryPath),
      path: targetFolders[0] || null,
      libraryPath,
      targetFolders,
      openTarget: libraryPath,
      supportsPane: targetFolders.length > 0
    });
  }
  libraries.sort((left, right) => left.name.localeCompare(right.name));
  return libraries;
}

function shellNamespaceItems() {
  return windowsShellNamespaces.map((item) => ({
    ...item,
    supportsPane: false,
    shellOnly: true
  }));
}

function shellNetworkSummary(drives) {
  const mappedDrives = drives.filter((drive) => String(drive.path || "").startsWith("\\\\"));
  return {
    root: shellNamespaceItems().find((item) => item.id === "network"),
    mappedDrives,
    mappedCount: mappedDrives.length
  };
}

async function getShellLocations() {
  const roots = await getRoots();
  const specialFolders = await existingSpecialFolders();
  const libraries = await discoverWindowsLibraries();
  const virtualFolders = shellNamespaceItems();
  const navigation = [
    ...virtualFolders,
    ...specialFolders.filter((item) =>
      ["pictures", "music", "videos", "oneDrive", "public", "appTrash"].includes(item.kind)
    ),
    ...libraries
  ];
  return {
    platform: process.platform,
    windows: process.platform === "win32",
    generatedAt: new Date().toISOString(),
    specialFolders,
    drives: roots.drives,
    virtualFolders,
    libraries,
    network: shellNetworkSummary(roots.drives),
    recycleBin: virtualFolders.find((item) => item.id === "recycleBin"),
    thisPc: virtualFolders.find((item) => item.id === "thisPc"),
    appTrash: specialFolders.find((item) => item.id === "appTrash") || null,
    navigation
  };
}

async function shellOpenItemById(id) {
  const cleanId = sanitizeReferenceId(id);
  if (!cleanId) {
    return null;
  }
  const locations = await getShellLocations();
  const items = [
    ...(locations.virtualFolders || []),
    ...(locations.libraries || []).filter((item) => item.openTarget),
    ...(locations.specialFolders || []).filter((item) => item.openTarget)
  ];
  return items.find((item) => item.id === cleanId && item.openTarget) || null;
}

function launchShellTarget(openTarget) {
  return new Promise((resolve, reject) => {
    const child = spawn("explorer.exe", [openTarget], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ file: "explorer.exe", args: [openTarget], processStarted: true });
    });
  });
}

function knownShellNamespaceTarget(value) {
  const text = String(value || "").trim();
  if (!text) {
    return windowsShellNamespaces[0];
  }
  return windowsShellNamespaces.find(
    (item) => item.id === text || item.openTarget.toLowerCase() === text.toLowerCase()
  ) || null;
}

function shellNamespaceTarget(value) {
  const text = String(value || "").trim();
  const known = knownShellNamespaceTarget(text);
  if (known) {
    return {
      id: known.id,
      name: known.name,
      target: known.openTarget,
      kind: known.kind,
      trusted: true
    };
  }
  if (!text) {
    const fallback = windowsShellNamespaces[0];
    return {
      id: fallback.id,
      name: fallback.name,
      target: fallback.openTarget,
      kind: fallback.kind,
      trusted: true
    };
  }
  if (/^shell:/i.test(text)) {
    throw new Error("Unknown shell namespace target.");
  }
  if (text.startsWith("::") || text.startsWith("\\\\") || path.isAbsolute(text)) {
    return {
      id: "",
      name: text.startsWith("::") ? "Shell Item" : labelFromPath(text),
      target: text,
      kind: text.startsWith("::") ? "virtual" : "folder",
      trusted: false
    };
  }
  const resolved = resolveUserPath(text);
  return {
    id: "",
    name: labelFromPath(resolved),
    target: resolved,
    kind: "folder",
    trusted: false
  };
}

function portableShellDeviceFromText({ name = "", type = "", path: itemPath = "" } = {}) {
  const text = `${name} ${type} ${itemPath}`.toLowerCase();
  return [
    "portable device",
    "portable media",
    "media device",
    "mobile device",
    "digital camera",
    "camera",
    "phone",
    "tablet",
    "mtp",
    "ptp",
    "android",
    "iphone",
    "ipad",
    "internal storage"
  ].some((token) => text.includes(token));
}

const simulatedPortableDeviceTarget = "::ExploreBetterSimulatedPortableDevice";
const simulatedPortableStorageTarget = "::ExploreBetterSimulatedPortableDevice\\Internal Storage";

function shellNamespaceDeviceSimulationEnabled() {
  return process.env.EB_SHELL_NAMESPACE_SIMULATE_DEVICES === "1";
}

function isThisPcShellTarget(targetInfo = {}) {
  const target = String(targetInfo.target || "").toLowerCase();
  return targetInfo.id === "thisPc" || target === "shell:mycomputerfolder";
}

function simulatedPortableDeviceItem(index = 0) {
  return normalizeShellNamespaceItem(
    {
      id: `sim-device-${index}`,
      index,
      name: "Explore Better Simulated Phone",
      path: simulatedPortableDeviceTarget,
      parsingPath: simulatedPortableDeviceTarget,
      type: "Portable Device",
      kind: "portable-device",
      isFolder: true,
      isFileSystem: false,
      isDirectory: false,
      isFile: false,
      isPortableDevice: true,
      isShellDevice: true,
      shellOnly: true,
      canBrowse: true,
      canOpen: true,
      canOpenPane: true,
      canBrowseShell: true,
      openTarget: simulatedPortableDeviceTarget,
      detail: "Simulated MTP/PTP shell provider",
      source: "ExploreBetter.DeviceSimulation"
    },
    index
  );
}

function simulatedPortableDeviceReport(targetInfo = {}, limit = 120) {
  if (!shellNamespaceDeviceSimulationEnabled()) {
    return null;
  }
  const target = String(targetInfo.target || "").toLowerCase();
  if (target !== simulatedPortableDeviceTarget.toLowerCase()) {
    return null;
  }
  const items = [
    normalizeShellNamespaceItem(
      {
        id: "sim-storage-0",
        index: 0,
        name: "Internal Storage",
        path: simulatedPortableStorageTarget,
        parsingPath: simulatedPortableStorageTarget,
        type: "Portable Device Storage",
        kind: "portable-device",
        isFolder: true,
        isFileSystem: false,
        isDirectory: false,
        isFile: false,
        isPortableDevice: true,
        isShellDevice: true,
        shellOnly: true,
        canBrowse: false,
        canOpen: true,
        canOpenPane: true,
        canBrowseShell: false,
        openTarget: simulatedPortableStorageTarget,
        detail: "Simulated portable storage root",
        source: "ExploreBetter.DeviceSimulation"
      },
      0
    )
  ].slice(0, limit);
  return normalizeShellNamespaceList(
    {
      available: true,
      name: "Explore Better Simulated Phone",
      target: simulatedPortableDeviceTarget,
      total: 1,
      count: items.length,
      truncated: limit < 1,
      items
    },
    {
      id: "",
      name: "Explore Better Simulated Phone",
      target: simulatedPortableDeviceTarget,
      kind: "portable-device"
    }
  );
}

function appendSimulatedPortableDevice(report = {}, targetInfo = {}, limit = 120) {
  if (!shellNamespaceDeviceSimulationEnabled() || !isThisPcShellTarget(targetInfo)) {
    return report;
  }
  const existing = Array.isArray(report.items) ? report.items : [];
  if (existing.some((item) => item.path === simulatedPortableDeviceTarget || item.openTarget === simulatedPortableDeviceTarget)) {
    return report;
  }
  const total = Number(report.total || existing.length) + 1;
  const canShow = existing.length < limit;
  const items = canShow ? [...existing, simulatedPortableDeviceItem(existing.length)] : existing;
  return {
    ...report,
    total,
    count: items.length,
    truncated: Boolean(report.truncated || total > items.length),
    items,
    simulatedDevices: true
  };
}

function normalizeShellNamespaceItem(item, index) {
  const name = String(item?.name || item?.path || `Item ${index + 1}`);
  const itemPath = String(item?.path || "");
  const isFolder = Boolean(item?.isFolder);
  const isFileSystem = Boolean(item?.isFileSystem);
  const isDirectory = Boolean(item?.isDirectory);
  const isFile = Boolean(item?.isFile);
  const isPortableDevice = Boolean(
    item?.isPortableDevice || (!isFileSystem && isFolder && portableShellDeviceFromText({ name, type: item?.type, path: itemPath }))
  );
  const shellOnly = Boolean(item?.shellOnly || (itemPath && !isFileSystem && isFolder));
  const isShellDevice = Boolean(item?.isShellDevice || isPortableDevice || (shellOnly && !String(item?.kind || "").includes("library")));
  return {
    id: String(item?.id ?? index),
    index: Number(item?.index ?? index),
    name,
    path: itemPath,
    parsingPath: String(item?.parsingPath || ""),
    type: String(item?.type || ""),
    kind: String(item?.kind || (isPortableDevice ? "portable-device" : isFolder ? "folder" : "item")),
    isFolder,
    isFileSystem,
    isDirectory,
    isFile,
    isPortableDevice,
    isShellDevice,
    shellOnly,
    canBrowse: Boolean(item?.canBrowse && itemPath),
    canOpen: Boolean(item?.canOpen && itemPath),
    canOpenPane: Boolean(item?.canOpenPane && isFileSystem && itemPath),
    canBrowseShell: Boolean((item?.canBrowseShell || item?.canBrowse) && itemPath && !isFileSystem),
    openTarget: String(item?.openTarget || itemPath),
    detail: String(item?.detail || item?.type || itemPath || ""),
    source: String(item?.source || "Shell.Application")
  };
}

function normalizeShellNamespaceList(parsed = {}, targetInfo = {}) {
  const sourceItems = Array.isArray(parsed.items) ? parsed.items : parsed.items ? [parsed.items] : [];
  const items = sourceItems.map(normalizeShellNamespaceItem).filter((item) => item.name || item.path);
  return {
    available: parsed.available !== false,
    platform: process.platform,
    id: String(targetInfo.id || parsed.id || ""),
    name: String(parsed.name || targetInfo.name || targetInfo.target || ""),
    target: String(parsed.target || targetInfo.target || ""),
    kind: String(targetInfo.kind || parsed.kind || "shell"),
    total: Number(parsed.total || items.length),
    count: Number(parsed.count || items.length),
    truncated: Boolean(parsed.truncated),
    items,
    reason: parsed.reason ? String(parsed.reason) : ""
  };
}

function cloneShellNamespaceReport(report) {
  return JSON.parse(JSON.stringify(report || {}));
}

function shellNamespaceCacheKey(targetInfo = {}, limit = 120) {
  return `${String(targetInfo.target || "").toLowerCase()}|${Math.max(1, Math.min(Number(limit || 120), 500))}`;
}

function shellNamespaceTimeoutFor(targetInfo = {}) {
  const envKey =
    targetInfo.id === "network"
      ? "EB_SHELL_NAMESPACE_NETWORK_TIMEOUT_MS"
      : targetInfo.id === "recycleBin"
      ? "EB_SHELL_NAMESPACE_RECYCLE_TIMEOUT_MS"
      : "EB_SHELL_NAMESPACE_TIMEOUT_MS";
  const envValue = Number(process.env[envKey] || process.env.EB_SHELL_NAMESPACE_TIMEOUT_MS || 0);
  if (Number.isFinite(envValue) && envValue > 0) {
    return Math.max(500, Math.min(envValue, 15000));
  }
  return shellNamespaceTimeoutMs[targetInfo.id] || shellNamespaceTimeoutMs.default;
}

function cachedShellNamespaceReport(cacheKey) {
  const cached = shellNamespaceCache.get(cacheKey);
  if (!cached || cached.expiresAt <= Date.now()) {
    shellNamespaceCache.delete(cacheKey);
    return null;
  }
  return { ...cloneShellNamespaceReport(cached.report), cached: true, cacheTtlMs: cached.expiresAt - Date.now() };
}

function pruneShellNamespaceCache(now = Date.now()) {
  for (const [key, cached] of shellNamespaceCache) {
    if (!cached || cached.expiresAt <= now) {
      shellNamespaceCache.delete(key);
    }
  }
  while (shellNamespaceCache.size >= shellNamespaceCacheMaxEntries) {
    const oldestKey = shellNamespaceCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    shellNamespaceCache.delete(oldestKey);
  }
}

function rememberShellNamespaceReport(cacheKey, report) {
  pruneShellNamespaceCache();
  shellNamespaceCache.set(cacheKey, {
    expiresAt: Date.now() + shellNamespaceCacheTtlMs,
    report: cloneShellNamespaceReport(report)
  });
  return report;
}

function unavailableShellNamespaceList(targetInfo = {}, reason = "Shell namespace enumeration failed.") {
  return normalizeShellNamespaceList(
    {
      available: false,
      name: targetInfo.name,
      target: targetInfo.target,
      total: 0,
      count: 0,
      truncated: false,
      items: [],
      reason
    },
    targetInfo
  );
}

async function listShellNamespace(body = {}) {
  const targetInfo = shellNamespaceTarget(body.target || body.id || body.path || "thisPc");
  const limit = Math.max(1, Math.min(Number(body.limit || 120), 500));
  const cacheKey = shellNamespaceCacheKey(targetInfo, limit);
  const cached = cachedShellNamespaceReport(cacheKey);
  if (cached) {
    return cached;
  }
  const simulatedReport = simulatedPortableDeviceReport(targetInfo, limit);
  if (simulatedReport) {
    return rememberShellNamespaceReport(cacheKey, simulatedReport);
  }
  if (process.platform !== "win32") {
    return rememberShellNamespaceReport(cacheKey, {
      available: false,
      platform: process.platform,
      id: targetInfo.id,
      name: targetInfo.name,
      target: targetInfo.target,
      kind: targetInfo.kind,
      total: 0,
      count: 0,
      truncated: false,
      items: [],
      reason: "Shell namespaces are only available on Windows."
    });
  }
  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
$Payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
$Target = [string]$Payload.target
$Limit = [Math]::Max(1, [int]$Payload.limit)
$Shell = New-Object -ComObject Shell.Application
$Folder = $Shell.Namespace($Target)
if (-not $Folder) {
  throw "Could not open shell namespace: $Target"
}
function Test-IsFileSystem([string]$Path) {
  if (-not $Path) { return $false }
  try { return [System.IO.Directory]::Exists($Path) -or [System.IO.File]::Exists($Path) } catch { return $false }
}
function Test-IsDirectory([string]$Path) {
  if (-not $Path) { return $false }
  try { return [System.IO.Directory]::Exists($Path) } catch { return $false }
}
function Test-IsFile([string]$Path) {
  if (-not $Path) { return $false }
  try { return [System.IO.File]::Exists($Path) } catch { return $false }
}
function Test-IsPortableShellDevice([string]$Name, [string]$Type, [string]$Path, [bool]$IsFileSystem, [bool]$IsFolder) {
  if (-not $IsFolder -or $IsFileSystem) { return $false }
  $Text = "$Name $Type $Path".ToLowerInvariant()
  foreach ($Token in @(
    "portable device",
    "portable media",
    "media device",
    "mobile device",
    "digital camera",
    "camera",
    "phone",
    "tablet",
    "mtp",
    "ptp",
    "android",
    "iphone",
    "ipad",
    "internal storage"
  )) {
    if ($Text.Contains($Token)) { return $true }
  }
  return $false
}
function Shell-Kind([object]$Item, [string]$Path, [bool]$IsFileSystem, [bool]$IsDirectory, [bool]$IsFile, [bool]$IsPortableDevice) {
  if ($IsDirectory) { return "directory" }
  if ($IsFile) { return "file" }
  if ([bool]$Item.IsFolder) {
    if ($IsPortableDevice) { return "portable-device" }
    if ($Path.StartsWith("\\\\")) { return "network" }
    if ($Path.StartsWith("::")) { return "virtual-folder" }
    if (-not $IsFileSystem) { return "virtual-folder" }
    return "folder"
  }
  if ($Path.StartsWith("::")) { return "virtual-item" }
  if ($IsFileSystem) { return "filesystem" }
  return "item"
}
$Items = New-Object System.Collections.Generic.List[object]
$Total = 0
foreach ($Item in @($Folder.Items())) {
  $Index = $Total
  $Total += 1
  if ($Items.Count -ge $Limit) {
    continue
  }
  $Path = ""
  $ParsingPath = ""
  $Type = ""
  $Name = ""
  try { $Path = [string]$Item.Path } catch { $Path = "" }
  try { $ParsingPath = [string]$Item.ExtendedProperty("System.ParsingPath") } catch { $ParsingPath = "" }
  if (-not $Path -and $ParsingPath) { $Path = $ParsingPath }
  if ($Path.StartsWith("shell:::")) { $Path = $Path.Substring(5) }
  try { $Type = [string]$Item.Type } catch { $Type = "" }
  try { $Name = [string]$Item.Name } catch { $Name = $Path }
  $IsFileSystem = Test-IsFileSystem $Path
  $IsDirectory = Test-IsDirectory $Path
  $IsFile = Test-IsFile $Path
  $IsFolder = [bool]$Item.IsFolder
  $IsPortableDevice = Test-IsPortableShellDevice $Name $Type $Path $IsFileSystem $IsFolder
  $Kind = Shell-Kind $Item $Path $IsFileSystem $IsDirectory $IsFile $IsPortableDevice
  $CanBrowse = $IsFolder -and $Path
  $CanOpenPane = $IsFileSystem -and $Path
  $ShellOnly = [bool]($Path -and -not $IsFileSystem -and $IsFolder)
  $Items.Add([pscustomobject]@{
    id = [string]$Index
    index = $Index
    name = $Name
    path = $Path
    parsingPath = $ParsingPath
    type = $Type
    kind = $Kind
    isFolder = $IsFolder
    isFileSystem = $IsFileSystem
    isDirectory = $IsDirectory
    isFile = $IsFile
    isPortableDevice = $IsPortableDevice
    isShellDevice = [bool]($IsPortableDevice -or $ShellOnly)
    shellOnly = $ShellOnly
    canBrowse = $CanBrowse
    canOpen = [bool]$Path
    canOpenPane = $CanOpenPane
    canBrowseShell = [bool]($CanBrowse -and -not $IsFileSystem)
    openTarget = $Path
    detail = $(if ($Type) { $Type } elseif ($Path) { $Path } else { $Kind })
    source = "Shell.Application"
  }) | Out-Null
}
$Title = ""
try { $Title = [string]$Folder.Title } catch { $Title = "" }
if (-not $Title) {
  try { $Title = [string]$Folder.Self.Name } catch { $Title = "" }
}
[pscustomobject]@{
  available = $true
  name = $Title
  target = $Target
  total = $Total
  count = $Items.Count
  truncated = $Total -gt $Items.Count
  items = $Items
} | ConvertTo-Json -Compress -Depth 8
`;
  try {
    const timeoutMs = shellNamespaceTimeoutFor(targetInfo);
    const result = await runPowerShellPayload(script, { target: targetInfo.target, limit }, { sta: true, timeoutMs });
    return rememberShellNamespaceReport(
      cacheKey,
      appendSimulatedPortableDevice(normalizeShellNamespaceList(parsePowerShellJson(result, {}), targetInfo), targetInfo, limit)
    );
  } catch (error) {
    return rememberShellNamespaceReport(
      cacheKey,
      unavailableShellNamespaceList(targetInfo, error.message || "Shell namespace enumeration failed.")
    );
  }
}

async function recordRelatedOperation(sourceOperationId, relatedOperation, kind, message) {
  if (!sourceOperationId || !relatedOperation?.id) return;
  const state = await readState();
  const source = (state.operations || []).find((item) => item.id === sourceOperationId);
  if (!source) return;
  appendOperationEvent(source, {
    kind,
    message,
    relatedOperationId: relatedOperation.id,
    status: source.status
  });
  await saveOperation(source);
}

async function windowsDriveInventory() {
  if (process.platform !== "win32") return [];
  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
@([System.IO.DriveInfo]::GetDrives() | ForEach-Object {
  $Ready = $false
  try { $Ready = $_.IsReady } catch { $Ready = $false }
  $Total = $null
  $Free = $null
  $Label = ""
  if ($Ready) {
    try { $Total = [int64]$_.TotalSize } catch { $Total = $null }
    try { $Free = [int64]$_.AvailableFreeSpace } catch { $Free = $null }
    try { $Label = [string]$_.VolumeLabel } catch { $Label = "" }
  }
  [pscustomobject]@{
    name = [string]$_.Name
    driveType = [string]$_.DriveType
    ready = [bool]$Ready
    totalBytes = $Total
    freeBytes = $Free
    label = $Label
  }
}) | ConvertTo-Json -Compress -Depth 5`;
  try {
    const parsed = parsePowerShellJson(await runPowerShellPayload(script, {}, { timeoutMs: 1800 }), []);
    return (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).map((item) => ({
      name: String(item.name || ""),
      driveType: String(item.driveType || "Unknown"),
      ready: item.ready === true,
      totalBytes: Number.isFinite(Number(item.totalBytes)) ? Number(item.totalBytes) : null,
      freeBytes: Number.isFinite(Number(item.freeBytes)) ? Number(item.freeBytes) : null,
      label: String(item.label || "")
    }));
  } catch {
    return [];
  }
}

function deviceCapabilities({ browseInApp = false, browseShell = false, openInExplorer = false } = {}) {
  return { browseInApp: Boolean(browseInApp), browseShell: Boolean(browseShell), openInExplorer: Boolean(openInExplorer) };
}

function normalizedDeviceItem(item = {}, fallback = {}) {
  const capacity = Number.isFinite(Number(item.totalBytes)) && Number(item.totalBytes) > 0
    ? {
        totalBytes: Number(item.totalBytes),
        freeBytes: Number.isFinite(Number(item.freeBytes)) ? Number(item.freeBytes) : null
      }
    : null;
  return {
    id: String(item.id || fallback.id || crypto.createHash("sha256").update(String(item.path || item.openTarget || item.name || "device")).digest("hex").slice(0, 20)),
    name: String(item.name || fallback.name || "Windows location"),
    kind: String(item.kind || fallback.kind || "location"),
    detail: String(item.detail || fallback.detail || item.type || ""),
    connectionState: item.connectionState || (item.ready === false ? "unavailable" : "connected"),
    path: item.path ? String(item.path) : null,
    openTarget: item.openTarget ? String(item.openTarget) : item.path ? String(item.path) : null,
    capacity,
    capabilities: item.capabilities || deviceCapabilities(fallback.capabilities)
  };
}

async function getWindowsDevices({ refresh = false, includeNetwork = false } = {}) {
  if (refresh) shellNamespaceCache.clear();
  if (process.platform !== "win32") {
    return {
      schemaVersion: "1",
      platform: process.platform,
      generatedAt: new Date().toISOString(),
      status: "unavailable",
      warnings: ["Devices & Windows locations are available on Windows."],
      counts: { connectedDevices: 0, removableDrives: 0, mappedNetworkLocations: 0, fixedDrives: 0, windowsLocations: 0 },
      groups: { connectedDevices: [], drives: [], network: [], libraries: [], windowsLocations: [] },
      networkLoaded: false
    };
  }
  const [roots, locations, thisPc, driveInventory] = await Promise.all([
    getRoots(),
    getShellLocations(),
    listShellNamespace({ target: "thisPc", limit: 200 }),
    windowsDriveInventory()
  ]);
  const warnings = [];
  if (thisPc.available === false) warnings.push(thisPc.reason || "Connected device provider is unavailable.");
  const driveByName = new Map(driveInventory.map((drive) => [String(drive.name || "").toLowerCase(), drive]));
  const drives = (roots.drives || []).map((drive) => {
    const detail = driveByName.get(String(drive.path || drive.name || "").toLowerCase()) || {};
    const driveType = String(detail.driveType || "Fixed").toLowerCase();
    const kind = driveType === "removable" ? "removable-drive" : driveType === "network" ? "mapped-network" : driveType === "cdrom" ? "optical-drive" : "fixed-drive";
    return normalizedDeviceItem({
      ...drive,
      id: `drive:${String(drive.path || drive.name || "").toLowerCase()}`,
      name: detail.label ? `${detail.label} (${drive.name})` : drive.name,
      kind,
      detail: `${String(detail.driveType || "Fixed")} drive`,
      ready: detail.ready !== false,
      totalBytes: detail.totalBytes ?? drive.space?.totalBytes,
      freeBytes: detail.freeBytes ?? drive.space?.freeBytes,
      capabilities: deviceCapabilities({ browseInApp: true, openInExplorer: true })
    });
  });
  const connectedDevices = (thisPc.items || [])
    .filter((item) => item.isPortableDevice || (item.isShellDevice && !item.isFileSystem))
    .map((item) => normalizedDeviceItem({
      ...item,
      id: `shell-device:${crypto.createHash("sha256").update(String(item.path || item.openTarget || item.name || item.kind)).digest("hex").slice(0, 16)}`,
      kind: item.isPortableDevice ? "portable-device" : item.kind || "connected-device",
      capabilities: deviceCapabilities({
        browseInApp: item.canOpenPane,
        browseShell: item.canBrowseShell,
        openInExplorer: item.canOpen
      })
    }));
  const libraries = (locations.libraries || []).map((item) => normalizedDeviceItem({
    ...item,
    id: item.id,
    capabilities: deviceCapabilities({ browseInApp: item.supportsPane, openInExplorer: Boolean(item.openTarget) })
  }));
  const windowsLocations = (locations.virtualFolders || [])
    .filter((item) => !["thisPc", "network"].includes(item.id))
    .map((item) => normalizedDeviceItem({
      ...item,
      id: item.id,
      capabilities: deviceCapabilities({ browseInApp: false, browseShell: true, openInExplorer: Boolean(item.openTarget) })
    }));
  const mappedDrives = drives.filter((item) => item.kind === "mapped-network");
  let providerNetwork = [];
  if (includeNetwork) {
    const report = await listShellNamespace({ target: "network", limit: 200 });
    if (report.available === false) warnings.push(report.reason || "Network provider is unavailable.");
    providerNetwork = (report.items || []).map((item) => normalizedDeviceItem({
      ...item,
      id: `network:${crypto.createHash("sha256").update(String(item.path || item.openTarget || item.name || item.kind)).digest("hex").slice(0, 16)}`,
      kind: item.kind || "network-location",
      capabilities: deviceCapabilities({ browseInApp: item.canOpenPane, browseShell: item.canBrowseShell, openInExplorer: item.canOpen })
    }));
  }
  const network = [...mappedDrives, ...providerNetwork.filter((item) => !mappedDrives.some((drive) => drive.path && item.path && drive.path.toLowerCase() === item.path.toLowerCase()))];
  const meaningfulDrives = drives.filter((item) => item.kind !== "fixed-drive");
  return {
    schemaVersion: "1",
    platform: process.platform,
    generatedAt: new Date().toISOString(),
    status: warnings.length ? (connectedDevices.length || drives.length || libraries.length ? "partial" : "unavailable") : "ready",
    warnings: warnings.slice(0, 20),
    counts: {
      connectedDevices: connectedDevices.length,
      removableDrives: drives.filter((item) => item.kind === "removable-drive" || item.kind === "optical-drive").length,
      mappedNetworkLocations: network.length,
      fixedDrives: drives.filter((item) => item.kind === "fixed-drive").length,
      windowsLocations: libraries.length + windowsLocations.length
    },
    groups: { connectedDevices, drives, network, libraries, windowsLocations },
    meaningfulDevices: [...connectedDevices, ...meaningfulDrives].length,
    networkLoaded: includeNetwork === true,
    cacheTtlMs: shellNamespaceCacheTtlMs
  };
}

async function openShellNamespaceTarget(body = {}) {
  const targetInfo = shellNamespaceTarget(body.target || body.path || body.id);
  if (!targetInfo.target) {
    throw new Error("Choose a shell namespace item first.");
  }
  if (body.dryRun === true) {
    return {
      dryRun: true,
      target: targetInfo.target,
      name: targetInfo.name,
      launched: null
    };
  }
  if (process.platform !== "win32") {
    throw new Error("Shell namespace open is only available on Windows.");
  }
  return {
    dryRun: false,
    target: targetInfo.target,
    name: targetInfo.name,
    launched: await launchShellTarget(targetInfo.target)
  };
}

function searchKindMatches(entry, kind) {
  if (!kind || kind === "all") {
    return true;
  }
  if (kind === "folders") {
    return entry.isDirectory;
  }
  if (kind === "files") {
    return entry.isFile;
  }
  if (kind === "text") {
    return entry.kind === "Text";
  }
  if (kind === "images") {
    return entry.kind === "Image";
  }
  if (kind === "documents") {
    return entry.kind === "Document";
  }
  return true;
}

function parseSearchSizeValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (Number.isFinite(Number(value))) {
    return Number(value);
  }
  const match = String(value || "").trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?b?|bytes?)?$/i);
  if (!match) {
    return NaN;
  }
  const units = {
    "": 1,
    b: 1,
    byte: 1,
    bytes: 1,
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4
  };
  return Number(match[1]) * (units[String(match[2] || "").toLowerCase()] || 1);
}

function searchDateTimestamp(entry, field) {
  const value = field === "created" ? entry.created : entry.modified;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function searchAttributeMatches(entry, attribute) {
  if (!attribute || attribute === "any") {
    return true;
  }
  const attrs = entry.attributes || {};
  if (attribute === "none") {
    return !entry.attributeText;
  }
  if (attribute === "readonly") {
    return Boolean(attrs.readonly || entry.readonly);
  }
  if (attribute === "hidden") {
    return Boolean(attrs.hidden || entry.hidden);
  }
  if (attribute === "system") {
    return Boolean(attrs.system || entry.system);
  }
  return Boolean(attrs[attribute] || entry[attribute]);
}

function normalizeSearchCriteria(options = {}) {
  const sizeOp = ["greater", "less", "equal"].includes(options.sizeOp) ? options.sizeOp : "any";
  const dateOp = ["newer", "older"].includes(options.dateOp) ? options.dateOp : "any";
  const dateField = options.dateField === "created" ? "created" : "modified";
  const attribute = [
    "any",
    "readonly",
    "hidden",
    "system",
    "archive",
    "compressed",
    "encrypted",
    "none"
  ].includes(options.attribute)
    ? options.attribute
    : "any";
  const rawSize = options.sizeBytes ?? options.sizeValue ?? null;
  const sizeBytes = sizeOp === "any" ? null : parseSearchSizeValue(rawSize);
  const dateDays = dateOp === "any" ? null : Number(options.dateDays);
  if (sizeOp !== "any" && (!Number.isFinite(sizeBytes) || sizeBytes < 0)) {
    throw Object.assign(new Error("Enter a valid search size"), { status: 400 });
  }
  if (dateOp !== "any" && (!Number.isFinite(dateDays) || dateDays < 0)) {
    throw Object.assign(new Error("Enter a valid search day count"), { status: 400 });
  }
  const labels = [];
  if (sizeOp !== "any") labels.push(`${sizeOp} ${formatBytesForSummary(sizeBytes)}`);
  if (dateOp !== "any") labels.push(`${dateField} ${dateOp} ${dateDays}d`);
  if (attribute !== "any") labels.push(`attr:${attribute}`);
  return { sizeOp, sizeBytes, dateOp, dateField, dateDays, attribute, labels };
}

function formatBytesForSummary(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) {
    return "";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[index]}`;
}

function searchCriteriaMatches(entry, criteria) {
  if (criteria.sizeOp !== "any") {
    const size = Number(entry.size);
    if (!entry.isFile || !Number.isFinite(size)) {
      return false;
    }
    if (criteria.sizeOp === "greater" && size <= criteria.sizeBytes) return false;
    if (criteria.sizeOp === "less" && size >= criteria.sizeBytes) return false;
    if (criteria.sizeOp === "equal" && size !== criteria.sizeBytes) return false;
  }
  if (criteria.dateOp !== "any") {
    const timestamp = searchDateTimestamp(entry, criteria.dateField);
    if (timestamp === null) {
      return false;
    }
    const cutoff = Date.now() - criteria.dateDays * 24 * 60 * 60 * 1000;
    if (criteria.dateOp === "newer" && timestamp < cutoff) return false;
    if (criteria.dateOp === "older" && timestamp >= cutoff) return false;
  }
  return searchAttributeMatches(entry, criteria.attribute);
}

function containsText(content, query) {
  return content.toLowerCase().includes(String(query || "").toLowerCase());
}

function contentSnippet(content, query) {
  const needle = String(query || "").toLowerCase();
  const haystack = content.toLowerCase();
  const index = haystack.indexOf(needle);
  if (index === -1) {
    return "";
  }
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + needle.length + 100);
  return content.slice(start, end).replace(/\s+/g, " ").trim();
}

async function advancedSearchUncached(options) {
  const root = resolveUserPath(options.path || options.root || workspaceRoot);
  const nameNeedle = String(options.query || options.name || "").toLowerCase();
  const contentNeedle = String(options.content || "").trim();
  const kind = String(options.kind || "all");
  const limit = Math.max(1, Math.min(Number(options.limit || 200), 1000));
  const maxScanned = Math.max(100, Math.min(Number(options.maxScanned || 8000), 50_000));
  const maxContentBytes = Math.max(
    1024,
    Math.min(Number(options.maxContentBytes || 512_000), 5_000_000)
  );
  const criteria = normalizeSearchCriteria({
    ...options,
    sizeOp:
      options.sizeOp ||
      (options.minSize !== undefined ? "greater" : options.maxSize !== undefined ? "less" : "any"),
    sizeBytes:
      options.sizeBytes ??
      (options.minSize !== undefined ? options.minSize : options.maxSize !== undefined ? options.maxSize : null)
  });
  const includeHidden = Boolean(options.includeHidden);
  const results = [];
  const skipped = [];
  const stack = [root];
  let scanned = 0;
  let contentScanned = 0;

  while (stack.length && results.length < limit && scanned < maxScanned) {
    const current = stack.pop();
    let listing;
    try {
      listing = await listDirectory(current, {
        showHidden: true,
        includeAttributes: false,
        includeSignature: true,
        priority: "foreground"
      });
    } catch (error) {
      skipped.push({ path: current, reason: error.code || "unreadable" });
      continue;
    }
    if (listing?.accessDenied) {
      skipped.push({ path: current, reason: listing.errorCode || "unreadable" });
      continue;
    }

    for (const listedEntry of listing?.entries || []) {
      if (results.length >= limit || scanned >= maxScanned) {
        break;
      }
      scanned += 1;
      const entry = listedEntry;
      const fullPath = entry.path || path.join(current, entry.name || "");
      const lowerName = String(entry.name || "").toLowerCase();

      if (!includeHidden && !visibleByHiddenSetting(entry, false)) {
        continue;
      }

      const nameOk = !nameNeedle || lowerName.includes(nameNeedle);
      const kindOk = searchKindMatches(entry, kind);
      const criteriaOk = searchCriteriaMatches(entry, criteria);
      let contentOk = !contentNeedle;

      if (contentNeedle && entry.isFile && textExtensions.has(entry.extension)) {
        if (Number(entry.size || 0) <= maxContentBytes) {
          try {
            const content = await fs.readFile(entry.path, "utf8");
            contentScanned += 1;
            contentOk = containsText(content, contentNeedle);
            if (contentOk) {
              entry.matchSnippet = contentSnippet(content, contentNeedle);
            }
          } catch (error) {
            skipped.push({ path: entry.path, reason: error.code || "content-unreadable" });
          }
        } else {
          skipped.push({ path: entry.path, reason: "content-too-large" });
        }
      }

      if (nameOk && kindOk && criteriaOk && contentOk) {
        results.push(entry);
      }

      if (
        entry.isDirectory &&
        (includeHidden || visibleByHiddenSetting(entry, false)) &&
        ![".git", "node_modules", ".venv", "dist", "build"].includes(lowerName)
      ) {
        stack.push(fullPath);
      }
    }
  }

  const labelMap = await readLabelMap();
  return {
    root,
    query: options.query || options.name || "",
    content: contentNeedle,
    kind,
    scanned,
    contentScanned,
    limit,
    maxScanned,
    criteria,
    criteriaSummary: criteria.labels.join(" / "),
    truncated: stack.length > 0 || scanned >= maxScanned || results.length >= limit,
    skipped: skipped.slice(0, 100),
    entries: attachPathLabels(results, labelMap)
  };
}

function advancedSearchCacheKey(options = {}) {
  const root = resolveUserPath(options.path || options.root || workspaceRoot);
  const ordered = {};
  for (const key of Object.keys(options).sort()) {
    ordered[key] = options[key];
  }
  return `${pathIdentity(root)}\u001f${crypto.createHash("sha256").update(JSON.stringify(ordered)).digest("hex")}`;
}

async function advancedSearch(options = {}) {
  const rootPath = resolveUserPath(options.path || options.root || workspaceRoot);
  const cacheKey = advancedSearchCacheKey(options);
  const now = Date.now();
  const cached = advancedSearchCache.get(cacheKey);
  if (cached && now - cached.createdAt <= advancedSearchCacheTtlMs) {
    cached.lastAccess = now;
    return { ...cached.report, searchCache: { hit: true, coalesced: false, ageMs: now - cached.createdAt } };
  }
  if (cached) advancedSearchCache.delete(cacheKey);
  const existing = advancedSearchInFlight.get(cacheKey);
  if (existing) {
    const report = await existing.promise;
    return { ...report, searchCache: { hit: false, coalesced: true } };
  }
  const record = { rootPath, invalidated: false, promise: null };
  record.promise = advancedSearchUncached(options).then((report) => {
    if (!record.invalidated) {
      advancedSearchCache.set(cacheKey, { rootPath, report, createdAt: Date.now(), lastAccess: Date.now() });
      while (advancedSearchCache.size > 24) {
        const oldest = [...advancedSearchCache.entries()].sort((left, right) => left[1].lastAccess - right[1].lastAccess)[0];
        if (!oldest) break;
        advancedSearchCache.delete(oldest[0]);
      }
    }
    return report;
  });
  advancedSearchInFlight.set(cacheKey, record);
  try {
    const report = await record.promise;
    return { ...report, searchCache: { hit: false, coalesced: false } };
  } finally {
    if (advancedSearchInFlight.get(cacheKey) === record) advancedSearchInFlight.delete(cacheKey);
  }
}

async function searchDirectory(rootPath, query, limit = 200) {
  return advancedSearch({ path: rootPath, query, limit });
}

async function flatView(options = {}) {
  const root = resolveUserPath(options.path || options.root || workspaceRoot);
  const mode = ["all", "files", "folders"].includes(options.mode) ? options.mode : "files";
  const limit = Math.max(1, Math.min(Number(options.limit || 1000), 10_000));
  const maxScanned = Math.max(100, Math.min(Number(options.maxScanned || 20_000), 100_000));
  const includeHidden = Boolean(options.includeHidden);
  const includeIgnored = Boolean(options.includeIgnored);
  const skipped = [];
  const entries = [];
  const stack = [root];
  let scanned = 0;

  while (stack.length && entries.length < limit && scanned < maxScanned) {
    const current = stack.pop();
    let dirents;
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: current, reason: error.code || "unreadable" });
      continue;
    }

    for (const dirent of dirents) {
      if (entries.length >= limit || scanned >= maxScanned) {
        break;
      }
      if (!includeHidden && dirent.name.startsWith(".")) {
        continue;
      }

      const fullPath = path.join(current, dirent.name);
      const lowerName = dirent.name.toLowerCase();
      const ignored =
        dirent.isDirectory() &&
        !includeIgnored &&
        [".git", "node_modules", ".venv", "dist", "build"].includes(lowerName);

      if (ignored) {
        skipped.push({ path: fullPath, reason: "ignored" });
        continue;
      }

      scanned += 1;
      let entry;
      try {
        entry = await statEntry(current, dirent);
      } catch (error) {
        skipped.push({ path: fullPath, reason: error.code || "unavailable" });
        continue;
      }

      entry.relative = normalizeRelativePath(path.relative(root, entry.path));
      const includeEntry =
        mode === "all" || (mode === "files" && entry.isFile) || (mode === "folders" && entry.isDirectory);
      if (includeEntry) {
        entries.push(entry);
      }

      if (dirent.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }

  const labelMap = await readLabelMap();
  return {
    root,
    mode,
    scanned,
    limit,
    maxScanned,
    truncated: stack.length > 0 || scanned >= maxScanned || entries.length >= limit,
    skipped: skipped.slice(0, 100),
    entries: attachPathLabels(entries, labelMap)
  };
}

async function duplicateFiles(options = {}) {
  const root = resolveUserPath(options.path || options.root || workspaceRoot);
  const mode = options.mode === "hash" ? "hash" : "size";
  const recursive = options.recursive !== false;
  const includeHidden = Boolean(options.includeHidden);
  const includeIgnored = Boolean(options.includeIgnored);
  const maxEntries = Math.max(100, Math.min(Number(options.maxEntries || 20_000), 100_000));
  const maxHashBytes = Math.max(1, Math.min(Number(options.maxHashBytes || 134_217_728), 1_073_741_824));
  const skipped = [];
  const sizeGroups = new Map();
  const stack = [root];
  let scanned = 0;
  let files = 0;
  let folders = 0;
  let hashScanned = 0;

  while (stack.length && scanned < maxEntries) {
    const current = stack.pop();
    let dirents;
    try {
      dirents = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      skipped.push({ path: current, reason: error.code || "unreadable" });
      continue;
    }

    for (const dirent of dirents) {
      if (scanned >= maxEntries) {
        break;
      }
      if (!includeHidden && dirent.name.startsWith(".")) {
        continue;
      }

      const fullPath = path.join(current, dirent.name);
      const lowerName = dirent.name.toLowerCase();
      const ignored =
        dirent.isDirectory() &&
        !includeIgnored &&
        [".git", "node_modules", ".venv", "dist", "build"].includes(lowerName);

      if (ignored) {
        skipped.push({ path: fullPath, reason: "ignored" });
        continue;
      }

      scanned += 1;
      try {
        const entry = await statEntry(current, dirent);
        entry.relative = normalizeRelativePath(path.relative(root, entry.path));
        if (entry.isFile) {
          files += 1;
          const sizeKey = String(Number(entry.size || 0));
          if (!sizeGroups.has(sizeKey)) {
            sizeGroups.set(sizeKey, { size: Number(entry.size || 0), items: [] });
          }
          sizeGroups.get(sizeKey).items.push(entry);
        }
        if (entry.isDirectory) {
          folders += 1;
          if (recursive) {
            stack.push(fullPath);
          }
        }
      } catch (error) {
        skipped.push({ path: fullPath, reason: error.code || "unavailable" });
      }
    }
  }

  const candidateGroups = [...sizeGroups.values()].filter((group) => group.items.length > 1);
  let groups = [];

  if (mode === "hash") {
    for (const sizeGroup of candidateGroups) {
      const hashGroups = new Map();
      for (const item of sizeGroup.items) {
        try {
          const digest = await hashFile(item.path, "sha256", maxHashBytes);
          if (!digest || digest.skipped) {
            skipped.push({
              path: item.path,
              reason: digest?.reason || "hash-skipped"
            });
            continue;
          }
          hashScanned += 1;
          item.hash = digest.value;
          if (!hashGroups.has(digest.value)) {
            hashGroups.set(digest.value, []);
          }
          hashGroups.get(digest.value).push(item);
        } catch (error) {
          skipped.push({ path: item.path, reason: error.code || error.message || "hash-unavailable" });
        }
      }

      for (const [hash, items] of hashGroups) {
        if (items.length > 1) {
          groups.push({
            key: `sha256:${hash}`,
            hash,
            size: sizeGroup.size,
            count: items.length,
            wastedBytes: sizeGroup.size * (items.length - 1),
            items
          });
        }
      }
    }
  } else {
    groups = candidateGroups.map((group) => ({
      key: `size:${group.size}`,
      hash: null,
      size: group.size,
      count: group.items.length,
      wastedBytes: group.size * (group.items.length - 1),
      items: group.items
    }));
  }

  groups.sort((a, b) => {
    const wastedDelta = Number(b.wastedBytes || 0) - Number(a.wastedBytes || 0);
    if (wastedDelta) {
      return wastedDelta;
    }
    return Number(b.size || 0) - Number(a.size || 0);
  });

  const labelMap = await readLabelMap();
  const labelledGroups = groups.map((group, index) => {
    const groupNumber = index + 1;
    const items = attachPathLabels(group.items, labelMap).map((item) => ({
      ...item,
      duplicateGroup: groupNumber,
      duplicateKey: group.key,
      duplicateHash: group.hash,
      matchSnippet:
        mode === "hash"
          ? `Duplicate group ${groupNumber} / confirmed SHA-256 match`
          : `Duplicate group ${groupNumber} / same file size`
    }));
    return {
      ...group,
      index: groupNumber,
      items
    };
  });

  const duplicateFilesCount = labelledGroups.reduce((sum, group) => sum + group.count, 0);
  const duplicateBytes = labelledGroups.reduce((sum, group) => sum + group.size * group.count, 0);
  const wastedBytes = labelledGroups.reduce((sum, group) => sum + group.wastedBytes, 0);

  return {
    root,
    mode,
    algorithm: mode === "hash" ? "sha256" : null,
    recursive,
    scanned,
    files,
    folders,
    hashScanned,
    maxEntries,
    maxHashBytes,
    truncated: stack.length > 0 || scanned >= maxEntries,
    skipped: skipped.slice(0, 200),
    groupCount: labelledGroups.length,
    duplicateFiles: duplicateFilesCount,
    duplicateBytes,
    wastedBytes,
    groups: labelledGroups,
    entries: labelledGroups.flatMap((group) => group.items)
  };
}

function launchExplorer(target, reveal = false) {
  const item = resolveUserPath(target);
  const args = reveal ? ["/select,", item] : [item];
  const child = spawn("explorer.exe", args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function launchDetached(file, args = [], cwd = undefined) {
  const lowerFile = String(file || "").toLowerCase();
  const isBatchFile = lowerFile.endsWith(".cmd") || lowerFile.endsWith(".bat");
  const launchFile = isBatchFile ? "cmd.exe" : file;
  const launchArgs = isBatchFile
    ? ["/d", "/s", "/c", [file, ...args].map((item) => `"${String(item).replaceAll('"', '""')}"`).join(" ")]
    : args;
  const child = spawn(launchFile, launchArgs, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return {
    file,
    args,
    cwd: cwd || null
  };
}

function splitArgumentTemplate(template) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (const char of String(template || "")) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function applicationPathForLaunch(appPath) {
  const value = String(appPath || "").trim();
  if (!value) {
    throw new Error("Choose an application first.");
  }
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("~") || value.startsWith(".") || value.includes("\\") || value.includes("/")) {
    return resolveUserPath(value);
  }
  return value;
}

function applyOpenWithTemplate(token, targetPath, allPaths) {
  const folder = path.dirname(targetPath);
  const values = {
    path: targetPath,
    folder,
    name: path.basename(targetPath),
    stem: path.parse(targetPath).name
  };
  return String(token || "").replace(/\{([a-zA-Z]+)\}/g, (match, name) => {
    if (name === "paths") {
      return allPaths.join(" ");
    }
    return name in values ? values[name] : match;
  });
}

function buildOpenWithArgs(template, targetPath, allPaths) {
  const tokens = splitArgumentTemplate(template || "{path}");
  const expanded = [];
  for (const token of tokens) {
    if (token === "{paths}") {
      expanded.push(...allPaths);
    } else {
      expanded.push(applyOpenWithTemplate(token, targetPath, allPaths));
    }
  }
  return expanded;
}

async function openWithTerminal(targetPath) {
  const item = resolveUserPath(targetPath);
  const stats = await fs.stat(item);
  const dir = stats.isDirectory() ? item : path.dirname(item);
  const script = `param([string]$PayloadPath)
$Payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
$Dir = $Payload.dir
if (Get-Command wt.exe -ErrorAction SilentlyContinue) {
  Start-Process wt.exe -ArgumentList @("-d", $Dir)
} else {
  Start-Process powershell.exe -WorkingDirectory $Dir
}
`;
  await runPowerShellPayload(script, { dir });
  return { mode: "terminal", path: item, cwd: dir };
}

async function openWithLaunch(body) {
  const mode = String(body.mode || "default");
  const paths = (Array.isArray(body.paths) ? body.paths : [body.path])
    .filter(Boolean)
    .map((item) => resolveUserPath(item))
    .slice(0, 64);
  if (!paths.length) {
    throw new Error("Select something to open first.");
  }
  if (mode === "default") {
    const launched = paths.map((item) => {
      launchExplorer(item, false);
      return { mode, path: item, file: "explorer.exe", args: [item] };
    });
    return { launched };
  }
  if (mode === "reveal") {
    const item = paths[0];
    launchExplorer(item, true);
    return { launched: [{ mode, path: item, file: "explorer.exe", args: ["/select,", item] }] };
  }
  if (mode === "terminal") {
    return { launched: [await openWithTerminal(paths[0])] };
  }
  if (mode === "custom") {
    const appPath = applicationPathForLaunch(body.appPath);
    const argsTemplate = String(body.argsTemplate || "{path}");
    const cwd = body.workingDirectory ? resolveUserPath(body.workingDirectory) : path.dirname(paths[0]);
    const tokens = splitArgumentTemplate(argsTemplate);
    const launchTogether = tokens.includes("{paths}");
    const targets = launchTogether ? [paths[0]] : paths;
    const launched = targets.map((targetPath) => {
      const args = buildOpenWithArgs(argsTemplate, targetPath, paths);
      return { mode, path: targetPath, ...launchDetached(appPath, args, cwd) };
    });
    return { launched };
  }
  throw new Error("Unsupported open-with mode.");
}

async function openWindowsProperties(body = {}) {
  const candidates = Array.isArray(body.paths) ? body.paths : [body.path];
  const target = candidates.map((item) => resolveUserPath(item)).find(Boolean);
  if (!target) {
    throw new Error("Select something to inspect first.");
  }
  if (!(await pathExists(target))) {
    throw new Error(`Missing target: ${target}`);
  }
  if (body.dryRun) {
    return { path: target, launched: false, dryRun: true, method: "validated" };
  }
  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
$Payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
$Target = [string]$Payload.path
if (-not (Test-Path -LiteralPath $Target)) {
  throw "Missing target: $Target"
}
$Item = Get-Item -LiteralPath $Target -Force
try {
  Start-Process -FilePath $Item.FullName -Verb Properties
  [pscustomobject]@{
    path = $Item.FullName
    launched = $true
    method = "Start-Process"
  } | ConvertTo-Json -Compress
  exit 0
} catch {
  $StartError = $_.Exception.Message
}
$Shell = New-Object -ComObject Shell.Application
$FullName = [string]$Item.FullName
$Root = [System.IO.Path]::GetPathRoot($FullName)
$IsDriveRoot = $Root -and ($FullName.TrimEnd("\\") -ieq $Root.TrimEnd("\\"))
if ($IsDriveRoot) {
  $FolderItem = $Shell.Namespace($FullName).Self
} else {
  $Parent = [System.IO.Path]::GetDirectoryName($FullName)
  $Name = [System.IO.Path]::GetFileName($FullName)
  $Folder = $Shell.Namespace($Parent)
  if (-not $Folder) {
    throw "Could not open shell namespace for $Parent. Start-Process error: $StartError"
  }
  $FolderItem = $Folder.ParseName($Name)
}
if (-not $FolderItem) {
  throw "Could not resolve shell item for $FullName. Start-Process error: $StartError"
}
$FolderItem.InvokeVerb("properties")
[pscustomobject]@{
  path = $FullName
  launched = $true
  method = "Shell.Application"
} | ConvertTo-Json -Compress
`;
  const result = await runPowerShellPayload(script, { path: target });
  return parsePowerShellJson(result, { path: target, launched: true, method: "unknown" });
}

function shellVerbTargetFromBody(body = {}) {
  const candidates = Array.isArray(body.paths) ? body.paths : [body.path];
  return candidates.map((item) => (item ? resolveUserPath(item) : "")).find(Boolean) || "";
}

function normalizeShellVerbItem(item, index) {
  const name = String(item?.name || item?.canonical || "").trim();
  const rawName = String(item?.rawName || name).trim();
  const id = String(item?.id ?? item?.rawIndex ?? index);
  const canonical = String(item?.canonical || name)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return {
    id,
    index: Number(item?.index ?? index),
    rawIndex: Number(item?.rawIndex ?? index),
    name,
    rawName,
    canonical,
    isDefault: Boolean(item?.isDefault),
    isDangerous: Boolean(item?.isDangerous),
    isProperties: canonical === "properties",
    source: String(item?.source || "Shell.Application")
  };
}

function normalizeShellVerbList(parsed = {}, target = "") {
  const sourceItems = Array.isArray(parsed.verbs) ? parsed.verbs : parsed.verbs ? [parsed.verbs] : [];
  const verbs = sourceItems
    .map(normalizeShellVerbItem)
    .filter((item) => item.id && item.name)
    .filter((item, index, all) => {
      const key = `${item.rawIndex}:${item.canonical}`;
      return all.findIndex((candidate) => `${candidate.rawIndex}:${candidate.canonical}` === key) === index;
    });
  return {
    available: parsed.available !== false,
    platform: process.platform,
    path: String(parsed.path || target),
    name: String(parsed.name || path.basename(target) || target),
    targetKind: String(parsed.targetKind || "unknown"),
    count: verbs.length,
    verbs,
    reason: parsed.reason ? String(parsed.reason) : ""
  };
}

function shellVerbsPowerShellScript(invoke = false) {
  return `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
$Payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
$Target = [string]$Payload.path
if (-not (Test-Path -LiteralPath $Target)) {
  throw "Missing target: $Target"
}
function Normalize-VerbName([string]$Value) {
  return (($Value -replace "&", "") -replace "\\.\\.\\.$", "").Trim()
}
function Verb-IsDangerous([string]$Canonical) {
  return $Canonical -match "(^|\\s)(delete|remove|cut|rename|format|encrypt|wipe|shred|compress|extract)(\\s|$)"
}
$Shell = New-Object -ComObject Shell.Application
$Item = Get-Item -LiteralPath $Target -Force
$FullName = [string]$Item.FullName
$Root = [System.IO.Path]::GetPathRoot($FullName)
$IsDriveRoot = $Root -and ($FullName.TrimEnd("\\") -ieq $Root.TrimEnd("\\"))
if ($IsDriveRoot) {
  $Folder = $Shell.Namespace($FullName)
  if (-not $Folder) {
    throw "Could not open shell namespace for $FullName."
  }
  $FolderItem = $Folder.Self
} else {
  $Parent = [System.IO.Path]::GetDirectoryName($FullName)
  $Name = [System.IO.Path]::GetFileName($FullName)
  $Folder = $Shell.Namespace($Parent)
  if (-not $Folder) {
    throw "Could not open shell namespace for $Parent."
  }
  $FolderItem = $Folder.ParseName($Name)
}
if (-not $FolderItem) {
  throw "Could not resolve shell item for $FullName."
}
$VerbList = New-Object System.Collections.Generic.List[object]
$RawIndex = 0
$SelectedVerb = $null
$SelectedRecord = $null
$RequestedId = [string]$Payload.verbId
$RequestedName = Normalize-VerbName ([string]$Payload.verbName)
foreach ($Verb in @($FolderItem.Verbs())) {
  $Raw = [string]$Verb.Name
  $Name = Normalize-VerbName $Raw
  if (-not $Name) {
    $RawIndex += 1
    continue
  }
  $Canonical = $Name.ToLowerInvariant()
  $Record = [pscustomobject]@{
    id = [string]$RawIndex
    index = $VerbList.Count
    rawIndex = $RawIndex
    name = $Name
    rawName = $Raw
    canonical = $Canonical
    isDefault = $VerbList.Count -eq 0
    isDangerous = Verb-IsDangerous $Canonical
    source = "Shell.Application"
  }
  $VerbList.Add($Record) | Out-Null
  if ($RequestedId -ne "" -and $RequestedId -eq [string]$RawIndex) {
    if ($RequestedName -eq "" -or $RequestedName.ToLowerInvariant() -eq $Canonical) {
      $SelectedVerb = $Verb
      $SelectedRecord = $Record
    }
  }
  if (-not $SelectedVerb -and $RequestedId -eq "" -and $RequestedName -ne "" -and $RequestedName.ToLowerInvariant() -eq $Canonical) {
    $SelectedVerb = $Verb
    $SelectedRecord = $Record
  }
  $RawIndex += 1
}
${invoke ? `if (-not $SelectedVerb) {
  throw "Shell verb was not found for $FullName."
}
$DryRun = [bool]$Payload.dryRun
if (-not $DryRun) {
  $SelectedVerb.DoIt()
}
[pscustomobject]@{
  available = $true
  path = $FullName
  name = [string]$FolderItem.Name
  targetKind = $(if ($Item.PSIsContainer) { "directory" } else { "file" })
  dryRun = $DryRun
  invoked = -not $DryRun
  verb = $SelectedRecord
} | ConvertTo-Json -Compress -Depth 8` : `[pscustomobject]@{
  available = $true
  path = $FullName
  name = [string]$FolderItem.Name
  targetKind = $(if ($Item.PSIsContainer) { "directory" } else { "file" })
  verbs = $VerbList
} | ConvertTo-Json -Compress -Depth 8`}
`;
}

async function listShellVerbs(body = {}) {
  const target = shellVerbTargetFromBody(body);
  if (!target) {
    throw new Error("Select a filesystem item first.");
  }
  if (process.platform !== "win32") {
    return {
      available: false,
      platform: process.platform,
      path: target,
      name: path.basename(target),
      targetKind: "unknown",
      count: 0,
      verbs: [],
      reason: "Shell verbs are only available on Windows."
    };
  }
  if (!(await pathExists(target))) {
    throw new Error(`Missing target: ${target}`);
  }
  const result = await runPowerShellPayload(shellVerbsPowerShellScript(false), { path: target }, { sta: true, timeoutMs: 5000 });
  return normalizeShellVerbList(parsePowerShellJson(result, {}), target);
}

async function invokeShellVerb(body = {}) {
  const target = shellVerbTargetFromBody(body);
  const verbId = String(body.verbId ?? body.id ?? "").trim();
  const verbName = String(body.verbName || body.name || "").trim();
  if (!target) {
    throw new Error("Select a filesystem item first.");
  }
  if (!verbId && !verbName) {
    throw new Error("Choose a shell verb first.");
  }
  if (process.platform !== "win32") {
    throw new Error("Shell verbs are only available on Windows.");
  }
  if (!(await pathExists(target))) {
    throw new Error(`Missing target: ${target}`);
  }
  const result = await runPowerShellPayload(
    shellVerbsPowerShellScript(true),
    {
      path: target,
      verbId,
      verbName,
      dryRun: body.dryRun === true
    },
    { sta: true, timeoutMs: body.dryRun === true ? 5000 : 15000 }
  );
  const parsed = parsePowerShellJson(result, {});
  const verb = normalizeShellVerbItem(parsed.verb || {}, 0);
  return {
    path: String(parsed.path || target),
    name: String(parsed.name || path.basename(target)),
    targetKind: String(parsed.targetKind || "unknown"),
    dryRun: Boolean(parsed.dryRun),
    invoked: Boolean(parsed.invoked),
    verb
  };
}

async function writeClipboardText(text) {
  const value = String(text ?? "");
  if (value.length > 1_000_000) {
    throw new Error("Clipboard text is too large.");
  }
  const script = `param([string]$PayloadPath)
$Payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
$Text = [string]$Payload.text
Set-Clipboard -Value $Text
Write-Output $Text.Length
`;
  await runPowerShellPayload(script, { text: value });
  return {
    chars: value.length,
    lines: value ? value.split(/\r\n|\r|\n/).length : 0
  };
}

function parsePowerShellJson(result, fallback = {}) {
  const text = String(result.stdout || "").trim();
  if (!text) {
    return fallback;
  }
  return JSON.parse(text.split(/\r?\n/).filter(Boolean).at(-1));
}

function normalizeClipboardFileMode(mode) {
  return String(mode || "").toLowerCase() === "move" ? "move" : "copy";
}

async function resolveClipboardFilePaths(paths) {
  const sourcePaths = Array.isArray(paths) ? paths : [];
  if (!sourcePaths.length) {
    throw new Error("Select files or folders first.");
  }
  if (sourcePaths.length > 1000) {
    throw new Error("Clipboard file selection is too large.");
  }
  const resolved = sourcePaths.map((item) => resolveUserPath(item)).filter(Boolean);
  for (const itemPath of resolved) {
    if (!(await pathExists(itemPath))) {
      throw new Error(`Missing source: ${itemPath}`);
    }
  }
  return resolved;
}

async function writeClipboardFiles(body = {}) {
  const paths = await resolveClipboardFilePaths(body.paths);
  const mode = normalizeClipboardFileMode(body.mode);
  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
$Payload = Get-Content -Raw -LiteralPath $PayloadPath | ConvertFrom-Json
$Collection = New-Object System.Collections.Specialized.StringCollection
foreach ($ItemPath in @($Payload.paths)) {
  if ($null -ne $ItemPath -and [string]$ItemPath -ne "") {
    [void]$Collection.Add([string]$ItemPath)
  }
}
if ($Collection.Count -eq 0) {
  throw "No clipboard files were provided."
}
$Data = New-Object System.Windows.Forms.DataObject
$Data.SetFileDropList($Collection)
$Effect = if ([string]$Payload.mode -eq "move") { 2 } else { 5 }
$Bytes = [BitConverter]::GetBytes([int]$Effect)
$Stream = New-Object System.IO.MemoryStream
$Stream.Write($Bytes, 0, $Bytes.Length)
$Stream.Position = 0
$Data.SetData("Preferred DropEffect", $Stream)
$Attempts = 0
while ($true) {
  try {
    [System.Windows.Forms.Clipboard]::SetDataObject($Data, $true)
    break
  } catch {
    $Attempts += 1
    if ($Attempts -ge 8) {
      throw
    }
    Start-Sleep -Milliseconds 80
  }
}
[pscustomobject]@{
  paths = @($Payload.paths)
  mode = [string]$Payload.mode
  count = $Collection.Count
} | ConvertTo-Json -Compress
`;
  const result = await runPowerShellPayload(script, { paths, mode }, { sta: true });
  const parsed = parsePowerShellJson(result, {});
  return {
    paths,
    mode,
    count: Number(parsed.count || paths.length)
  };
}

async function readClipboardFiles() {
  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
$Paths = @()
$Mode = "copy"
$Effect = $null
$Data = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($Data -and $Data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
  $DropList = $Data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
  if ($DropList) {
    $Paths = @($DropList | ForEach-Object { [string]$_ })
  }
}
if ($Data -and $Data.GetDataPresent("Preferred DropEffect")) {
  $RawEffect = $Data.GetData("Preferred DropEffect")
  if ($RawEffect -is [System.IO.Stream]) {
    $Bytes = New-Object byte[] 4
    $RawEffect.Position = 0
    [void]$RawEffect.Read($Bytes, 0, 4)
    $Effect = [BitConverter]::ToInt32($Bytes, 0)
  } elseif ($RawEffect -is [byte[]] -and $RawEffect.Length -ge 4) {
    $Effect = [BitConverter]::ToInt32($RawEffect, 0)
  } elseif ($RawEffect -is [int]) {
    $Effect = [int]$RawEffect
  }
}
if ($Effect -eq 2) {
  $Mode = "move"
}
[pscustomobject]@{
  paths = $Paths
  mode = $Mode
  count = $Paths.Count
  effect = $Effect
} | ConvertTo-Json -Compress
`;
  const result = await runPowerShellPayload(script, {}, { sta: true });
  const parsed = parsePowerShellJson(result, {});
  const paths = Array.isArray(parsed.paths)
    ? parsed.paths.map((item) => String(item || "")).filter(Boolean)
    : [];
  return {
    paths,
    mode: normalizeClipboardFileMode(parsed.mode),
    count: paths.length,
    effect: parsed.effect ?? null
  };
}

async function clearClipboardFiles() {
  const script = `param([string]$PayloadPath)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
$Attempts = 0
while ($true) {
  try {
    [System.Windows.Forms.Clipboard]::Clear()
    break
  } catch {
    $Attempts += 1
    if ($Attempts -ge 8) {
      throw
    }
    Start-Sleep -Milliseconds 80
  }
}
[pscustomobject]@{ cleared = $true } | ConvertTo-Json -Compress
`;
  const result = await runPowerShellPayload(script, {}, { sta: true });
  return parsePowerShellJson(result, { cleared: true });
}

function findInstalledAppBrowser() {
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const candidates = [
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFilesX86 || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86 || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")
  ];
  return candidates.find((candidate) => candidate && pathExistsSync(candidate)) || null;
}

function pathExistsSync(target) {
  return Boolean(target) && existsSync(target);
}

function runProcess(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout = null;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(result);
    };
    const timeoutMs = Number(options.timeoutMs || 0);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeout = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish({ code: -1, stdout, stderr, timedOut: true });
      }, timeoutMs);
      timeout.unref?.();
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish({ code: -1, stdout, stderr: error.message });
    });
    child.on("exit", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

function shellQuote(value, kind) {
  const text = String(value ?? "");
  if (kind === "cmd") {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return `'${text.replaceAll("'", "''")}'`;
}

function applyCommandTemplate(commandText, commandKind, context) {
  const selected = context.selectedPaths || [];
  const values = {
    active: context.activePath,
    other: context.otherPath,
    first: selected[0] || "",
    selected: selected.map((item) => shellQuote(item, commandKind)).join(" "),
    selectedLines: selected.join("\n"),
    selectedJson: JSON.stringify(selected),
    activeRaw: context.activePath,
    otherRaw: context.otherPath,
    firstRaw: selected[0] || ""
  };

  return String(commandText || "").replace(/\{([a-zA-Z]+)\}/g, (match, name) => {
    if (!(name in values)) {
      return match;
    }
    if (name.endsWith("Raw") || name === "selected") {
      return values[name];
    }
    return shellQuote(values[name], commandKind);
  });
}

function limitedAppend(current, chunk, limit = 200_000) {
  if (current.length >= limit) {
    return current;
  }
  const next = current + chunk.toString();
  return next.length > limit ? `${next.slice(0, limit)}\n[output truncated]` : next;
}

async function buildCommandContext(body) {
  const activePath = resolveUserPath(body.activePath || body.contextPath || workspaceRoot);
  const otherPath = resolveUserPath(body.otherPath || activePath);
  const selectedPaths = Array.isArray(body.selectedPaths)
    ? body.selectedPaths.map(resolveUserPath)
    : [];
  const cwd = (await pathExists(activePath)) ? activePath : workspaceRoot;
  return {
    activePath,
    otherPath,
    selectedPaths,
    cwd
  };
}

async function runExternalCommand(savedCommand, context) {
  const command = sanitizeCommand(savedCommand);
  if (!command.command.trim()) {
    throw new Error("Command text is empty.");
  }

  const rendered = applyCommandTemplate(command.command, command.kind, context);
  const env = {
    ...process.env,
    EB_ACTIVE: context.activePath,
    EB_OTHER: context.otherPath,
    EB_SELECTED_JSON: JSON.stringify(context.selectedPaths),
    EB_SELECTED_LINES: context.selectedPaths.join("\n"),
    EB_FIRST_SELECTED: context.selectedPaths[0] || ""
  };
  const file = command.kind === "cmd" ? "cmd.exe" : "powershell.exe";
  const args =
    command.kind === "cmd"
      ? ["/d", "/s", "/c", rendered]
      : ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", rendered];

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: context.cwd,
      env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`Command timed out after 60 seconds: ${command.name}`));
    }, 60_000);

    child.stdout.on("data", (chunk) => {
      stdout = limitedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = limitedAppend(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const result = {
        commandId: command.id,
        name: command.name,
        kind: command.kind,
        exitCode: code,
        cwd: context.cwd,
        stdout,
        stderr,
        rendered
      };
      if (code === 0) {
        resolve({ result, undo: null });
      } else {
        const error = new Error(`Command exited with ${code}: ${command.name}`);
        error.details = result;
        reject(error);
      }
    });
  });
}

async function readRegistryDefault(key) {
  const result = await runProcess("reg.exe", ["query", key, "/ve"]);
  if (result.code !== 0) {
    return null;
  }
  const match = result.stdout.match(/\(Default\)\s+REG_\w+\s+(.+)/i);
  return match ? match[1].trim() : "";
}

function preflightItem(id, label, state, detail, action = "") {
  return { id, label, state, detail, action };
}

function preflightSummaryState(items) {
  if (items.some((item) => item.state === "block")) {
    return "block";
  }
  if (items.some((item) => item.state === "warn")) {
    return "warn";
  }
  return "ready";
}

function preflightSummaryLabel(state) {
  if (state === "block") {
    return "Blocked until generated assets are fixed";
  }
  if (state === "warn") {
    return "Ready with review";
  }
  return "Ready for current-user shell integration";
}

function shellDefaultText(value) {
  return value ? value : "No current-user override";
}

function buildShellPreflight({ paths, files, registry, shortcuts, handler }) {
  const generatedReady = [
    files.launcher,
    files.server,
    files.shortcuts,
    files.shortcutRemove,
    files.winEHotkey,
    files.winEInstall,
    files.winERemove,
    files.contextMenuReg,
    files.contextMenuRemoveReg,
    files.folderDefaultReg,
    files.folderDefaultRemoveReg
  ].every(Boolean);
  const cleanupReady = [
    files.shortcutRemove,
    files.winERemove,
    files.contextMenuRemoveReg,
    files.folderDefaultRemoveReg
  ].every(Boolean);
  const stableHandler = handler.kind === "installed" || handler.kind === "packaged";
  const directoryDefault = registry.directoryDefault || "";
  const driveDefault = registry.driveDefault || "";
  const hasForeignDefault = [directoryDefault, driveDefault].some(
    (value) => value && value !== "ExploreBetter"
  );
  const canRestore = Boolean(registry.shellBackup?.available);
  const currentDefaults = `Directory: ${shellDefaultText(directoryDefault)} / Drive: ${shellDefaultText(
    driveDefault
  )}`;
  const handlerDetail = handler.target
    ? `${handler.kind || "launcher"}: ${handler.target}`
    : handler.command || "No shell command generated yet.";
  const items = [
    preflightItem(
      "target",
      "Shell target",
      stableHandler ? "ready" : "warn",
      handlerDetail,
      stableHandler
        ? "Registry handlers will point at a stable EXE target."
        : "Install the app for the most stable default-folder target."
    ),
    preflightItem(
      "generated",
      "Generated integration kit",
      generatedReady ? "ready" : "block",
      generatedReady ? paths.scriptPath : "Missing one or more generated scripts or registry files.",
      generatedReady ? "Install and removal files are present." : "Run Generate."
    ),
    preflightItem(
      "restore",
      "Shell backup",
      canRestore ? "ready" : "warn",
      canRestore
        ? registry.shellBackup.restoreRegPath
        : `No captured shell backup yet. Next install captures one at ${paths.registryRestoreRegPath}.`,
      canRestore ? "Previous shell state can be restored." : "Run Backup Now or let install capture a backup."
    ),
    preflightItem(
      "defaults",
      "Current HKCU defaults",
      hasForeignDefault ? "warn" : "ready",
      currentDefaults,
      hasForeignDefault
        ? "Review the existing current-user default before replacing it."
        : "No competing current-user default folder handler."
    ),
    preflightItem(
      "context",
      "Context menu",
      files.contextMenuReg ? "ready" : "block",
      registry.contextMenuInstalled
        ? `Installed command: ${registry.directoryCommand || registry.driveCommand || ""}`
        : paths.contextMenuRegPath,
      registry.contextMenuInstalled ? "Already installed." : "Ready for optional menu install."
    ),
    preflightItem(
      "default",
      "Default folder handler",
      files.folderDefaultReg ? (hasForeignDefault && !registry.folderDefaultEnabled ? "warn" : "ready") : "block",
      registry.folderDefaultEnabled ? currentDefaults : paths.folderDefaultRegPath,
      registry.folderDefaultEnabled ? "Already default." : "Ready for confirmed default-handler install."
    ),
    preflightItem(
      "winE",
      "Win+E helper",
      files.winEHotkey && files.winEInstall && files.winERemove ? "ready" : "block",
      shortcuts.winEStartup
        ? `Installed: ${shortcuts.winEStartupShortcut || ""}`
        : paths.winEHotkeyPath,
      "Optional current-user startup hotkey listener."
    ),
    preflightItem(
      "cleanup",
      "Cleanup route",
      cleanupReady ? "ready" : "warn",
      cleanupReady
        ? "Shortcut, Win+E, context-menu, and default-handler removers found."
        : "One or more removal files are missing.",
      cleanupReady
        ? "Clean Integrations can remove current-user shell wiring."
        : "Regenerate before cleanup."
    )
  ];
  const state = preflightSummaryState(items);
  const summary = preflightSummaryLabel(state);
  return {
    state,
    label: summary,
    summary,
    installTarget: handler.kind || "launcher",
    currentDefaults: {
      directory: directoryDefault || null,
      drive: driveDefault || null
    },
    items
  };
}

async function getIntegrationStatus() {
  const paths = integrationPaths();
  const state = await readState();
  const settings = sanitizeSettings(state.settings || {});
  const launchMode = normalizeLaunchMode(settings.launchMode);
  const shellOpenMode = normalizeShellOpenMode(settings.shellOpenMode);
  const nativeMain = electronMainPath();
  const nativeLauncher = electronLauncherPath();
  const packagedCandidate = packagedAppCandidatePath();
  const packagedApp = desktopExecutableCurrentPath() || (existsSync(packagedCandidate) ? packagedCandidate : null);
  const installedCandidate = installedAppCandidatePath();
  const installedApp = installedAppCurrentPath();
  const nativeTarget = packagedAppPath();
  const shellBackup = state.integration?.registryBackup || null;
  const shellBackupReady = Boolean(shellBackup?.entries?.length);
  const handler = integrationShellCommand(paths.scriptPath, launchMode, shellOpenMode);
  const startMenuShortcut = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Explore Better",
    "Explore Better.lnk"
  );
  const desktopShortcut = path.join(userDesktopPath(), "Explore Better.lnk");
  const startupShortcut = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "Explore Better Win+E.lnk"
  );
  const directoryCommand = await readRegistryDefault(
    "HKCU\\Software\\Classes\\Directory\\shell\\ExploreBetter\\command"
  );
  const driveCommand = await readRegistryDefault(
    "HKCU\\Software\\Classes\\Drive\\shell\\ExploreBetter\\command"
  );
  const directoryBackgroundCommand = await readRegistryDefault(
    "HKCU\\Software\\Classes\\Directory\\Background\\shell\\ExploreBetter\\command"
  );
  const fileLocationCommand = await readRegistryDefault(
    "HKCU\\Software\\Classes\\*\\shell\\ExploreBetterLocation\\command"
  );
  const directoryDefault = await readRegistryDefault("HKCU\\Software\\Classes\\Directory\\shell");
  const driveDefault = await readRegistryDefault("HKCU\\Software\\Classes\\Drive\\shell");
  const files = {
    launcher: await pathExists(paths.scriptPath),
    server: await pathExists(paths.serverScriptPath),
    nativeMain: await pathExists(nativeMain),
    nativeLauncher: Boolean(nativeLauncher),
    installedApp: Boolean(installedApp),
    packagedApp: Boolean(packagedApp),
    shortcuts: await pathExists(paths.shortcutScriptPath),
    shortcutRemove: await pathExists(paths.shortcutRemoveScriptPath),
    winEHotkey: await pathExists(paths.winEHotkeyPath),
    winEInstall: await pathExists(paths.winEInstallScriptPath),
    winERemove: await pathExists(paths.winERemoveScriptPath),
    contextMenuReg: await pathExists(paths.contextMenuRegPath),
    contextMenuRemoveReg: await pathExists(paths.contextMenuRemoveRegPath),
    folderDefaultReg: await pathExists(paths.folderDefaultRegPath),
    folderDefaultRemoveReg: await pathExists(paths.folderDefaultRemoveRegPath),
    registryRestoreReg: await pathExists(paths.registryRestoreRegPath)
  };
  const registry = {
    contextMenuInstalled: Boolean(
      directoryCommand && driveCommand && directoryBackgroundCommand && fileLocationCommand
    ),
    folderDefaultEnabled: directoryDefault === "ExploreBetter" && driveDefault === "ExploreBetter",
    directoryCommand,
    driveCommand,
    directoryBackgroundCommand,
    fileLocationCommand,
    directoryDefault,
    driveDefault,
    shellBackup: shellBackupReady
      ? {
          available: true,
          id: shellBackup.id,
          mode: shellBackup.mode,
          createdAt: shellBackup.createdAt,
          restoredAt: shellBackup.restoredAt || null,
          restoreRegPath: shellBackup.restoreRegPath || paths.registryRestoreRegPath
        }
      : {
          available: false,
          restoreRegPath: paths.registryRestoreRegPath
        }
  };
  const shortcuts = {
    startMenu: await pathExists(startMenuShortcut),
    desktop: await pathExists(desktopShortcut),
    winEStartup: await pathExists(startupShortcut),
    startMenuShortcut,
    desktopShortcut,
    winEStartupShortcut: startupShortcut
  };
  const nativeReady = Boolean(nativeLauncher) && (await pathExists(nativeMain));
  const installedReady = Boolean(installedApp);
  const packagedReady = Boolean(packagedApp);
  const steps = [
    {
      id: "kit",
      label: "Replacement kit",
      ready: files.launcher && files.server && files.winEHotkey,
      detail: paths.scriptPath
    },
    {
      id: "native",
      label: "Native window",
      ready: nativeReady,
      detail: nativeReady ? nativeLauncher : "Run npm install to enable Electron"
    },
    {
      id: "backup",
      label: "Shell backup",
      ready: shellBackupReady,
      detail: shellBackupReady ? shellBackup.restoreRegPath || paths.registryRestoreRegPath : paths.registryRestoreRegPath
    },
    {
      id: "installed",
      label: "Installed app",
      ready: installedReady,
      detail: installedReady ? installedApp : installedCandidate
    },
    {
      id: "packaged",
      label: "Packaged app",
      ready: packagedReady,
      detail: packagedReady ? packagedApp : packagedCandidate
    },
    {
      id: "shortcuts",
      label: "App shortcuts",
      ready: shortcuts.startMenu,
      detail: shortcuts.desktop ? "Start Menu and Desktop" : "Start Menu"
    },
    {
      id: "context",
      label: "Context menu",
      ready: registry.contextMenuInstalled,
      detail: registry.contextMenuInstalled ? "Folder and drive menu installed" : paths.contextMenuRegPath
    },
    {
      id: "default",
      label: "Default folder handler",
      ready: registry.folderDefaultEnabled,
      detail: registry.folderDefaultEnabled ? "Directory and drive default" : paths.folderDefaultRegPath
    },
    {
      id: "winE",
      label: "Win+E helper",
      ready: shortcuts.winEStartup,
      detail: shortcuts.winEStartup ? shortcuts.winEStartupShortcut : paths.winEHotkeyPath
    }
  ];
  const ready = steps.filter((step) => step.ready).length;
  const replacementLevel = registry.folderDefaultEnabled
    ? shortcuts.winEStartup
      ? installedReady
        ? "Full installed prototype replacement"
        : packagedReady
          ? "Full packaged prototype replacement"
          : nativeReady
            ? "Full native prototype replacement"
            : "Full prototype replacement"
      : installedReady
        ? "Installed default folder handler"
        : packagedReady
          ? "Packaged default folder handler"
          : nativeReady
            ? "Native default folder handler"
            : "Default folder handler"
    : registry.contextMenuInstalled
      ? installedReady
        ? "Installed context menu integrated"
        : packagedReady
          ? "Packaged context menu integrated"
          : nativeReady
            ? "Native context menu integrated"
            : "Context menu integrated"
      : files.launcher && files.server
        ? installedReady
          ? "Installed app, shell not installed"
          : packagedReady
            ? "Packaged, not installed"
            : nativeReady
              ? "Native generated, not installed"
              : "Generated, not installed"
        : installedReady
          ? "Installed app, kit not generated"
          : "Not configured";

  return {
    browser: findInstalledAppBrowser(),
    native: {
      available: nativeReady || packagedReady || installedReady,
      installed: installedApp,
      installedCandidate,
      packaged: packagedApp,
      packagedCandidate,
      devLauncher: nativeLauncher,
      launcher: nativeTarget || nativeLauncher,
      main: nativeMain
    },
    handler,
    files,
    registry,
    shortcuts,
    preflight: buildShellPreflight({ paths, files, registry, shortcuts, handler }),
    replacement: {
      level: replacementLevel,
      ready,
      total: steps.length,
      percent: Math.round((ready / steps.length) * 100),
      steps,
      winEManaged: "startup-hotkey"
    }
  };
}

function normalizedShellCommand(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isLegacyExploreBetterShellCommand(value) {
  const command = normalizedShellCommand(value);
  return (
    !command ||
    command.includes("powershell.exe") ||
    command.includes("explore-better-open.ps1") ||
    command.includes("electron.cmd") ||
    command.includes("app.asar")
  );
}

export async function repairCurrentUserShellIntegrationTarget() {
  if (process.platform !== "win32") {
    return { ok: true, repaired: false, reason: "unsupported-platform" };
  }
  const desktopExecutable = desktopExecutableCurrentPath();
  if (!desktopExecutable) {
    return { ok: true, repaired: false, reason: "desktop-executable-unavailable" };
  }

  const before = await getIntegrationStatus();
  const ownsFolderDefault = before.registry?.folderDefaultEnabled === true;
  const ownsContextMenu = before.registry?.contextMenuInstalled === true;
  if (!ownsFolderDefault && !ownsContextMenu) {
    return { ok: true, repaired: false, reason: "integration-not-owned" };
  }

  const paths = integrationPaths();
  const settings = sanitizeSettings((await readState()).settings || {});
  const launchMode = normalizeLaunchMode(settings.launchMode);
  const shellOpenMode = normalizeShellOpenMode(settings.shellOpenMode);
  const expectedCommand = integrationShellCommand(paths.scriptPath, launchMode, shellOpenMode).command;
  const expectedBackgroundCommand = integrationShellCommand(
    paths.scriptPath,
    launchMode,
    shellOpenMode,
    "%V"
  ).command;
  const commandPairs = [
    [before.registry?.directoryCommand, expectedCommand],
    [before.registry?.driveCommand, expectedCommand],
    [before.registry?.directoryBackgroundCommand, expectedBackgroundCommand],
    [before.registry?.fileLocationCommand, expectedCommand]
  ];
  const needsRepair = commandPairs.some(
    ([current, expected]) =>
      normalizedShellCommand(current) !== normalizedShellCommand(expected) &&
      isLegacyExploreBetterShellCommand(current)
  );
  if (!needsRepair) {
    return {
      ok: true,
      repaired: false,
      reason: "already-current",
      target: desktopExecutable,
      folderDefaultPreserved: ownsFolderDefault
    };
  }

  await writeIntegrationFiles();
  const registryFile = ownsFolderDefault ? paths.folderDefaultRegPath : paths.contextMenuRegPath;
  await importRegistryFile(registryFile);
  const after = await getIntegrationStatus();
  if (ownsFolderDefault && !after.registry?.folderDefaultEnabled) {
    throw new Error("Explore Better could not preserve the existing folder and drive default during handler repair.");
  }
  return {
    ok: true,
    repaired: true,
    reason: "legacy-handler-replaced",
    mode: ownsFolderDefault ? "folderDefault" : "contextMenu",
    target: desktopExecutable,
    folderDefaultPreserved: ownsFolderDefault && after.registry?.folderDefaultEnabled === true
  };
}

async function importRegistryFile(filePath) {
  const regFile = resolveUserPath(filePath);
  if (!regFile.startsWith(integrationRoot)) {
    throw new Error("Only generated Explore Better registry files can be imported.");
  }
  await fs.access(regFile);
  return new Promise((resolve, reject) => {
    const child = spawn("reg.exe", ["import", regFile], {
      windowsHide: true
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ ok: true, file: regFile });
      } else {
        reject(new Error(stderr.trim() || `reg import exited with ${code}`));
      }
    });
  });
}

function integrationProcessSummary(result = {}) {
  return {
    code: result.code,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim()
  };
}

async function runIntegrationPowerShellScript(scriptPath, args = [], label = "Integration script") {
  const script = resolveUserPath(scriptPath);
  if (!script.startsWith(integrationRoot)) {
    throw new Error("Only generated Explore Better integration scripts can be run.");
  }
  if (!(await pathExists(script))) {
    await writeIntegrationFiles();
  }
  const result = await runProcess("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    ...args
  ]);
  if (result.code !== 0) {
    const summary = integrationProcessSummary(result);
    const error = new Error(`${label} failed.`);
    error.details = summary;
    throw error;
  }
  return {
    ok: true,
    script,
    ...integrationProcessSummary(result)
  };
}

async function removeShortcutIntegration(paths = integrationPaths()) {
  return runIntegrationPowerShellScript(paths.shortcutRemoveScriptPath, [], "Shortcut removal");
}

async function installShortcutIntegration(body = {}, paths = integrationPaths()) {
  const args = body.desktop ? ["-Desktop"] : [];
  return runIntegrationPowerShellScript(paths.shortcutScriptPath, args, "Shortcut install");
}

async function updateWinEIntegration(mode = "install", paths = integrationPaths()) {
  const script = mode === "remove" ? paths.winERemoveScriptPath : paths.winEInstallScriptPath;
  return runIntegrationPowerShellScript(script, [], "Win+E helper update");
}

async function removeGeneratedShellHandlers(paths = integrationPaths()) {
  if (!(await pathExists(paths.contextMenuRemoveRegPath)) || !(await pathExists(paths.folderDefaultRemoveRegPath))) {
    await writeIntegrationFiles();
  }
  const results = [];
  results.push({ id: "folderDefault", ...(await importRegistryFile(paths.folderDefaultRemoveRegPath)) });
  results.push({ id: "contextMenu", ...(await importRegistryFile(paths.contextMenuRemoveRegPath)) });
  return results;
}

async function cleanupCurrentUserIntegration(body = {}) {
  const paths = integrationPaths();
  await writeIntegrationFiles();
  const before = await getIntegrationStatus();
  const steps = [];

  const shortcutsResult = await removeShortcutIntegration(paths);
  steps.push({ id: "shortcuts", label: "Shortcuts", ...shortcutsResult });

  const winEResult = await updateWinEIntegration("remove", paths);
  steps.push({ id: "winE", label: "Win+E helper", ...winEResult });

  if (before.registry?.contextMenuInstalled || before.registry?.folderDefaultEnabled) {
    if (body.restoreBackup !== false && before.registry?.shellBackup?.available) {
      const restore = await restoreShellRegistryBackup();
      steps.push({ id: "shellRestore", label: "Shell restore", ...restore });
    } else {
      const registryResults = await removeGeneratedShellHandlers(paths);
      steps.push({ id: "shellHandlers", label: "Shell handlers", ok: true, results: registryResults });
    }
  } else {
    steps.push({
      id: "shellHandlers",
      label: "Shell handlers",
      ok: true,
      skipped: true,
      reason: "No Explore Better context menu or default folder handler is installed."
    });
  }

  return {
    ok: true,
    steps,
    before: {
      shortcuts: before.shortcuts,
      registry: before.registry
    },
    status: await getIntegrationStatus()
  };
}

function formatForScript(value) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function scriptProgressFields(input, completed, total) {
  const source = input && typeof input === "object" ? input : {};
  const phase = typeof input === "string" ? input : source.phase || source.label || "Script";
  const nextCompleted = completed ?? source.completed;
  const nextTotal = total ?? source.total;
  const fields = {
    unit: String(source.unit || "steps").slice(0, 40),
    phase: String(phase || "Script").slice(0, 80)
  };
  if (Number.isFinite(Number(nextCompleted))) {
    fields.completed = Math.max(0, Number(nextCompleted));
  }
  if (Number.isFinite(Number(nextTotal))) {
    fields.total = Math.max(0, Number(nextTotal));
  }
  if (source.current) {
    fields.current = String(source.current).slice(0, 160);
  }
  if (source.currentPath) {
    fields.currentPath = resolveUserPath(source.currentPath);
  }
  return fields;
}

function normalizeScriptPaneName(value) {
  return value === "right" ? "right" : "left";
}

function sanitizeScriptPathList(paths) {
  return Array.isArray(paths) ? paths.filter(Boolean).map(resolveUserPath).slice(0, 1000) : [];
}

function scriptPaneContext(source = {}, fallbackPath = workspaceRoot, fallbackSelected = []) {
  const panePath = resolveUserPath(source.path || fallbackPath || workspaceRoot);
  return {
    path: panePath,
    selectedPaths: sanitizeScriptPathList(
      Array.isArray(source.selectedPaths) ? source.selectedPaths : fallbackSelected
    ),
    focusedPath: source.focusedPath ? resolveUserPath(source.focusedPath) : null
  };
}

async function runTrustedScript(body, hooks = {}) {
  const logs = [];
  const events = [];
  const mutationPaths = new Map();
  const rememberScriptMutationPath = (itemPath) => addDirectoryListingMutationPath(mutationPaths, itemPath);
  const rememberScriptMutationPaths = (...items) => {
    for (const itemPath of items.flat(Infinity)) {
      rememberScriptMutationPath(itemPath);
    }
  };
  const activePane = normalizeScriptPaneName(body.activePane);
  const activePath = resolveUserPath(body.activePath || body.contextPath || workspaceRoot);
  const otherPath = resolveUserPath(body.otherPath || activePath);
  const explicitSelectedPaths = sanitizeScriptPathList(body.selectedPaths);
  const leftDefaults =
    activePane === "left"
      ? { path: activePath, selectedPaths: explicitSelectedPaths }
      : { path: otherPath, selectedPaths: [] };
  const rightDefaults =
    activePane === "right"
      ? { path: activePath, selectedPaths: explicitSelectedPaths }
      : { path: otherPath, selectedPaths: [] };
  const panes = {
    left: scriptPaneContext(body.panes?.left, leftDefaults.path, leftDefaults.selectedPaths),
    right: scriptPaneContext(body.panes?.right, rightDefaults.path, rightDefaults.selectedPaths)
  };
  const contextPath = resolveUserPath(body.contextPath || panes[activePane].path || activePath);
  const selectedPaths = explicitSelectedPaths.length ? explicitSelectedPaths : [...panes[activePane].selectedPaths];
  const timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs || 30000), 120000));
  const checkpoint = async (progress = null) => {
    hooks.throwIfCanceled?.();
    await hooks.waitIfPaused?.();
    hooks.throwIfCanceled?.();
    if (progress) {
      await hooks.updateProgress?.(progress);
    }
    hooks.throwIfCanceled?.();
    return true;
  };

  const api = {
    cwd: () => contextPath,
    selected: () => [...selectedPaths],
    checkpoint: () => checkpoint(),
    progress: async (progress, completed, total) => {
      const fields = scriptProgressFields(progress, completed, total);
      await checkpoint(fields);
      return fields;
    },
    emit: async (name, detail = null) => {
      const event = {
        name: String(name || "event").trim().slice(0, 80) || "event",
        detail: boundedJsonValue(detail, 1000),
        at: new Date().toISOString()
      };
      events.push(event);
      await checkpoint();
      return event;
    },
    sleep: async (ms = 0) => {
      const end = Date.now() + Math.max(0, Math.min(Number(ms) || 0, 120000));
      do {
        await checkpoint();
        const remaining = end - Date.now();
        if (remaining <= 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 250)));
      } while (Date.now() < end);
      return true;
    },
    list: async (target = contextPath) => {
      await checkpoint({ unit: "steps", total: 1, completed: 0, phase: "Listing", currentPath: target });
      const result = await listDirectory(target);
      await checkpoint({ unit: "steps", total: 1, completed: 1, phase: "Listed", currentPath: result.path });
      return result;
    },
    mkdir: async (parent, name) => {
      await checkpoint({ unit: "steps", total: 1, completed: 0, phase: "Creating folder", currentPath: parent });
      const dir = path.join(resolveUserPath(parent), cleanEntryName(name));
      await fs.mkdir(dir, { recursive: false });
      rememberScriptMutationPath(dir);
      await checkpoint({ unit: "steps", total: 1, completed: 1, phase: "Created folder", currentPath: dir });
      return dir;
    },
    rename: async (target, newName) => {
      await checkpoint({ unit: "steps", total: 1, completed: 0, phase: "Renaming", currentPath: target });
      const src = resolveUserPath(target);
      const dest = path.join(path.dirname(src), cleanEntryName(newName));
      await fs.rename(src, dest);
      rememberScriptMutationPaths(src, dest);
      await checkpoint({ unit: "steps", total: 1, completed: 1, phase: "Renamed", currentPath: dest });
      return dest;
    },
    copy: async (sources, targetDir) => {
      const list = Array.isArray(sources) ? sources : [sources];
      const copied = [];
      for (const [index, source] of list.entries()) {
        await checkpoint({
          unit: "items",
          total: list.length,
          completed: index,
          phase: "Copying",
          currentPath: source
        });
        const copiedPath = await copyOne(source, targetDir, { hooks });
        copied.push(copiedPath);
        rememberScriptMutationPaths(source, copiedPath);
      }
      await checkpoint({ unit: "items", total: list.length, completed: copied.length, phase: "Copied" });
      return copied;
    },
    move: async (sources, targetDir) => {
      const list = Array.isArray(sources) ? sources : [sources];
      const moved = [];
      for (const [index, source] of list.entries()) {
        await checkpoint({
          unit: "items",
          total: list.length,
          completed: index,
          phase: "Moving",
          currentPath: source
        });
        const movedPath = await moveOne(source, targetDir, { hooks });
        moved.push(movedPath);
        rememberScriptMutationPaths(source, movedPath);
      }
      await checkpoint({ unit: "items", total: list.length, completed: moved.length, phase: "Moved" });
      return moved;
    },
    trash: async (sources) => {
      const list = Array.isArray(sources) ? sources : [sources];
      await checkpoint({ unit: "items", total: list.length, completed: 0, phase: "Trashing" });
      const result = await trashPaths(list, hooks);
      rememberScriptMutationPaths(list);
      collectDirectoryListingMutationPaths(result, mutationPaths);
      await checkpoint({ unit: "items", total: list.length, completed: list.length, phase: "Trashed" });
      return result;
    },
    writeText: async (target, content) => {
      await checkpoint({ unit: "steps", total: 1, completed: 0, phase: "Writing text", currentPath: target });
      const dest = resolveUserPath(target);
      await fs.writeFile(dest, String(content ?? ""), "utf8");
      rememberScriptMutationPath(dest);
      await checkpoint({ unit: "steps", total: 1, completed: 1, phase: "Wrote text", currentPath: dest });
      return dest;
    }
  };

  const sandbox = {
    api,
    context: {
      path: contextPath,
      activePath: contextPath,
      activePane,
      otherPath,
      selectedPaths,
      panes,
      timeoutMs
    },
    console: {
      log: (...args) => logs.push(args.map(formatForScript).join(" "))
    },
    path: {
      basename: path.basename,
      dirname: path.dirname,
      extname: path.extname,
      join: path.join,
      resolve: path.resolve
    }
  };

  const code = String(body.code || "");
  const script = new vm.Script(`"use strict"; (async () => {\n${code}\n})()`, {
    filename: "ExploreBetterScript.vm"
  });

  const resultPromise = script.runInNewContext(sandbox, {
    timeout: 1000,
    displayErrors: true
  });

  let cacheInvalidation = { reason: "script", invalidated: 0, dirs: [] };
  let backgroundIndexInvalidation = { reason: "script", affected: 0, roots: [] };
  let result;
  try {
    result = await Promise.race([
      resultPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Script timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs)
      )
    ]);
  } finally {
    if (mutationPaths.size) {
      cacheInvalidation = invalidateDirectoryListingCachesForDirs(mutationPaths, "script");
      backgroundIndexInvalidation = await safelyInvalidateBackgroundIndexesForDirs(mutationPaths, "script", "script");
    }
  }

  return { logs, events: events.slice(0, 100), result, cacheInvalidation, backgroundIndexInvalidation };
}

function healthComponent(id, status, summary, metrics = {}, suggestedAction = "") {
  return { id, status, summary, metrics, suggestedAction };
}

async function healthCheckWithTimeout(id, task, timeoutMs, signal) {
  if (signal?.aborted) throw signal.reason || operationCanceledError();
  let timeout = null;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error(`${id} probe timed out.`);
          error.code = "HEALTH_TIMEOUT";
          reject(error);
        }, timeoutMs);
      }),
      new Promise((_, reject) => signal?.addEventListener?.("abort", () => reject(operationCanceledError()), { once: true }))
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function healthCacheMetrics() {
  return {
    directoryListings: directoryListingCache.size,
    directoryEntries: directoryListingCacheEntryTotal(),
    directoryInFlight: directoryListingInFlight.size,
    folderIndexes: folderIndexCacheStats().entries,
    folderIndexBytes: folderIndexCacheStats().bytes,
    sizeAnalyses: sizeAnalysisCache.size,
    searches: advancedSearchCache.size,
    backgroundSearchStores: backgroundIndexSearchStoreCache.size
  };
}

export async function healthReport({ probe = false, signal = null } = {}) {
  const startedAt = Date.now();
  const state = await readState();
  const nativeHelper = nativeFilesystemHelperPath();
  const packageInfo = await fs.readFile(path.join(__dirname, "package.json"), "utf8").then(JSON.parse).catch(() => ({}));
  const operationCounts = (state.operations || []).reduce((counts, operation) => {
    counts[operation.status] = (counts[operation.status] || 0) + 1;
    return counts;
  }, {});
  const components = [
    healthComponent("backend", "healthy", "Local backend is responding.", { uptimeSeconds: Math.round(process.uptime()) }),
    healthComponent("renderer", "healthy", "Renderer-to-backend API boundary is available."),
    healthComponent("nativeHelper", nativeHelper ? "healthy" : "attention", nativeHelper ? "Native filesystem helper is available." : "Native filesystem helper is missing; Node fallbacks remain available.", {}, nativeHelper ? "" : "Reinstall or rebuild the native helper."),
    healthComponent("mcpBridge", "healthy", "AI Bridge configuration is readable.", { configuredProfiles: 0 }),
    healthComponent("shellProvider", process.platform === "win32" ? "healthy" : "attention", process.platform === "win32" ? "Windows shell provider is available for on-demand checks." : "Windows shell provider is unavailable on this platform."),
    healthComponent("cache", "healthy", "Caches are within bounded in-memory limits.", healthCacheMetrics()),
    healthComponent("index", backgroundIndexJobs.size ? "attention" : "healthy", backgroundIndexJobs.size ? "Background indexing is active." : "No background index job is active.", { configured: (state.backgroundIndexes || []).length, activeJobs: [...backgroundIndexJobs.values()].filter((job) => job.status === "running").length }),
    healthComponent("operationQueue", operationControls.size ? "attention" : "healthy", operationControls.size ? "File operations are active." : "Operation queue is idle.", { active: operationControls.size, ...operationCounts }),
    healthComponent("updateConfiguration", process.env.EXPLORE_BETTER_UPDATE_URL || process.env.EB_UPDATE_URL ? "healthy" : "attention", process.env.EXPLORE_BETTER_UPDATE_URL || process.env.EB_UPDATE_URL ? "An update feed is configured." : "No explicit update feed is configured for this build."),
    healthComponent("package", packageInfo.version ? "healthy" : "attention", packageInfo.version ? "Package metadata is readable." : "Package metadata could not be read.", { version: packageInfo.version || "unknown" })
  ];
  try {
    const configuration = await getMcpBridgeConfiguration();
    const component = components.find((item) => item.id === "mcpBridge");
    component.status = configuration.enabled ? "healthy" : "attention";
    component.summary = configuration.enabled ? "AI Bridge is enabled." : "AI Bridge is disabled.";
    component.metrics = { configuredProfiles: configuration.profiles?.length || 0, enabled: configuration.enabled === true };
  } catch (error) {
    const component = components.find((item) => item.id === "mcpBridge");
    component.status = "error";
    component.summary = `AI Bridge configuration failed: ${String(error.message || error).slice(0, 240)}`;
    component.suggestedAction = "Restart Explore Better and inspect the AI Bridge profile configuration.";
  }
  if (probe) {
    const probeResults = await Promise.allSettled([
      healthCheckWithTimeout("state", () => readState(), 1500, signal),
      healthCheckWithTimeout("nativeHelper", () => nativeHelper ? fs.stat(nativeHelper) : Promise.reject(new Error("Native helper is missing.")), 1500, signal),
      healthCheckWithTimeout("shellProvider", () => getWindowsDevices({ refresh: true, includeNetwork: false }), 4500, signal)
    ]);
    const [stateProbe, nativeProbe, shellProbe] = probeResults;
    if (stateProbe.status === "rejected") components.find((item) => item.id === "backend").status = "error";
    if (nativeProbe.status === "rejected") {
      const component = components.find((item) => item.id === "nativeHelper");
      component.status = "attention";
      component.summary = String(nativeProbe.reason?.message || "Native helper probe failed.").slice(0, 240);
    }
    if (shellProbe.status === "fulfilled") {
      const component = components.find((item) => item.id === "shellProvider");
      component.status = shellProbe.value.status === "ready" ? "healthy" : shellProbe.value.status === "partial" ? "attention" : "error";
      component.summary = shellProbe.value.status === "ready" ? "Windows shell and device provider responded." : (shellProbe.value.warnings?.[0] || "Windows shell provider returned a partial result.");
      component.metrics = shellProbe.value.counts;
    } else if (process.platform === "win32") {
      const component = components.find((item) => item.id === "shellProvider");
      component.status = shellProbe.reason?.code === "HEALTH_TIMEOUT" ? "attention" : "error";
      component.summary = String(shellProbe.reason?.message || "Windows shell provider probe failed.").slice(0, 240);
    }
  }
  const overall = components.some((item) => item.status === "error") ? "error" : components.some((item) => item.status === "attention") ? "attention" : "healthy";
  return {
    schemaVersion: "1",
    version: String(packageInfo.version || "unknown"),
    platform: process.platform,
    generatedAt: new Date().toISOString(),
    probe: probe === true,
    overall,
    durationMs: Date.now() - startedAt,
    components,
    scheduler: foregroundActivitySnapshot()
  };
}

function supportBundleRedactor(includePaths = false) {
  const pathIds = new Map();
  const omittedKeys = [];
  const truncated = [];
  const sensitiveKey = /(token|nonce|capabilit|credential|password|secret|clipboard|terminalOutput|fileContent|environment)/i;
  const replacePath = (value) => {
    const text = String(value || "");
    if (includePaths) return text;
    const patterns = [/[A-Za-z]:[\\/][^\r\n"']+/g, /\\\\[^\r\n"']+/g, /\/(?:mnt|home|Users|tmp|var|etc)\/[^\r\n"']+/g];
    let output = text;
    for (const pattern of patterns) {
      output = output.replace(pattern, (match) => {
        if (!pathIds.has(match)) pathIds.set(match, `PATH-${String(pathIds.size + 1).padStart(4, "0")}`);
        return `[${pathIds.get(match)}]`;
      });
    }
    return output;
  };
  const clean = (value, key = "") => {
    if (sensitiveKey.test(key)) {
      omittedKeys.push(key);
      return "[omitted]";
    }
    if (typeof value === "string") {
      const output = replacePath(value);
      if (output.length > 20_000) truncated.push({ key: key || "text", originalLength: output.length, kept: 20_000 });
      return output.slice(0, 20_000);
    }
    if (Array.isArray(value)) {
      if (value.length > 1000) truncated.push({ key: key || "array", originalLength: value.length, kept: 1000 });
      return value.slice(0, 1000).map((item) => clean(item, key));
    }
    if (value && typeof value === "object") {
      const pairs = Object.entries(value);
      if (pairs.length > 1000) truncated.push({ key: key || "object", originalLength: pairs.length, kept: 1000 });
      return Object.fromEntries(pairs.slice(0, 1000).map(([childKey, child]) => [childKey, clean(child, childKey)]));
    }
    return value;
  };
  return { clean, pathIds, omittedKeys, truncated };
}

async function streamSupportBundle(res, { includePaths = false } = {}) {
  const redactor = supportBundleRedactor(includePaths);
  const state = await readState();
  const health = await healthReport({ probe: false });
  const audit = await listMcpAudit(200).catch(() => []);
  const operationSummary = (state.operations || []).slice(0, 100).map((operation) => ({
    id: operation.id,
    type: operation.type,
    status: operation.status,
    createdAt: operation.createdAt,
    startedAt: operation.startedAt,
    finishedAt: operation.finishedAt,
    progress: operation.progress ? { unit: operation.progress.unit, total: operation.progress.total, completed: operation.progress.completed, phase: operation.progress.phase } : null,
    eventCount: operation.events?.length || 0,
    retryOf: operation.retryOf || null,
    relatedOperationId: operation.relatedOperationId || null
  }));
  const settingsSummary = {
    settings: state.settings || {},
    counts: {
      favorites: state.favorites?.length || 0,
      aliases: state.aliases?.length || 0,
      collections: state.collections?.length || 0,
      backgroundIndexes: state.backgroundIndexes?.length || 0
    }
  };
  const performance = { cache: healthCacheMetrics(), scheduler: foregroundActivitySnapshot(), indexJobs: [...backgroundIndexJobs.values()].map(backgroundIndexJobSnapshot) };
  const entries = new Map([
    ["health.json", JSON.stringify(redactor.clean(health), null, 2)],
    ["runtime-settings.json", JSON.stringify(redactor.clean(settingsSummary), null, 2)],
    ["operations.json", JSON.stringify(redactor.clean(operationSummary), null, 2)],
    ["mcp-audit.json", JSON.stringify(redactor.clean(audit), null, 2)],
    ["performance.json", JSON.stringify(redactor.clean(performance), null, 2)]
  ]);
  const maxBundleBytes = 10 * 1024 * 1024;
  let totalBytes = 0;
  const omitted = [];
  for (const [name, text] of [...entries]) {
    const buffer = Buffer.from(text);
    if (buffer.length > 2 * 1024 * 1024 || totalBytes + buffer.length > maxBundleBytes - 256 * 1024) {
      entries.delete(name);
      omitted.push({ name, reason: "size-limit", bytes: buffer.length });
    } else {
      totalBytes += buffer.length;
      entries.set(name, buffer);
    }
  }
  const summary = `# Explore Better support bundle\n\nOverall health: ${health.overall}\n\nGenerated locally. Local paths ${includePaths ? "were included by explicit opt-in" : "were replaced with opaque IDs"}.\n`;
  const summaryBuffer = Buffer.from(summary);
  const manifest = {
    schemaVersion: "1",
    createdAt: new Date().toISOString(),
    includeLocalPaths: includePaths === true,
    maximumBytes: maxBundleBytes,
    uncompressedBytes: 0,
    files: [...entries.keys(), "summary.md", "manifest.json"],
    omitted,
    truncated: redactor.truncated.slice(0, 100),
    redactions: { opaquePathCount: redactor.pathIds.size, omittedSensitiveKeys: [...new Set(redactor.omittedKeys)].slice(0, 100) },
    exclusions: ["file contents", "terminal output", "clipboard data", "environment secrets", "bridge nonces", "capabilities", "apply tokens", "credentials"]
  };
  let manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));
  for (let index = 0; index < 2; index += 1) {
    manifest.uncompressedBytes = totalBytes + summaryBuffer.length + manifestBuffer.length;
    manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));
  }
  if (manifest.uncompressedBytes > maxBundleBytes) throw new Error("Support bundle exceeded the 10 MB safety limit.");
  entries.set("summary.md", summaryBuffer);
  entries.set("manifest.json", manifestBuffer);
  const zip = new yazl.ZipFile();
  for (const [name, buffer] of entries) zip.addBuffer(buffer, name, { compress: true });
  const fileName = `explore-better-support-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${fileName}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  zip.outputStream.pipe(res);
  zip.end();
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/desktop/health") {
    return sendJson(res, 200, { ok: true, desktopInstanceToken });
  }

  if (route === "GET /api/health/report") {
    const signal = requestAbortSignal(req, res);
    return sendJson(res, 200, await healthReport({ probe: url.searchParams.get("probe") === "1", signal }));
  }

  if (route === "POST /api/health/renderer-scheduler") {
    return sendJson(res, 200, { ok: true, scheduler: updateRendererSchedulerSnapshot(await readJson(req)) });
  }

  if (route === "POST /api/health/support-bundle") {
    const body = await readJson(req);
    return streamSupportBundle(res, { includePaths: body.includePaths === true });
  }

  if (route === "GET /api/manual") {
    const manualPath = path.join(__dirname, "USER_MANUAL.md");
    const text = await fs.readFile(manualPath, "utf8");
    return sendJson(res, 200, { text });
  }

  if (route === "GET /api/roots") {
    return sendJson(res, 200, await getRoots());
  }

  if (route === "GET /api/shell/locations") {
    return sendJson(res, 200, await getShellLocations());
  }

  if (route === "GET /api/windows/devices") {
    return sendJson(res, 200, await getWindowsDevices({
      refresh: url.searchParams.get("refresh") === "1",
      includeNetwork: url.searchParams.get("includeNetwork") === "1"
    }));
  }

  if (route === "POST /api/shell/open") {
    const body = await readJson(req);
    const item = await shellOpenItemById(body.id);
    if (!item) {
      return sendError(res, 400, "Unknown shell location.");
    }
    if (body.dryRun === true) {
      return sendJson(res, 200, {
        ok: true,
        dryRun: true,
        id: item.id,
        name: item.name,
        target: item.openTarget
      });
    }
    if (process.platform !== "win32") {
      return sendError(res, 400, "Windows shell locations are only available on Windows.");
    }
    return sendJson(res, 200, {
      ok: true,
      id: item.id,
      name: item.name,
      launched: await launchShellTarget(item.openTarget)
    });
  }

  if (route === "GET /api/shell/namespace") {
    return sendJson(
      res,
      200,
      await listShellNamespace({
        target: url.searchParams.get("target") || url.searchParams.get("id") || url.searchParams.get("path"),
        limit: url.searchParams.get("limit")
      })
    );
  }

  if (route === "POST /api/shell/namespace/open") {
    const body = await readJson(req);
    return sendJson(res, 200, { ok: true, ...(await openShellNamespaceTarget(body)) });
  }

  if (route === "GET /api/shell/verbs") {
    return sendJson(res, 200, await listShellVerbs({ path: url.searchParams.get("path") }));
  }

  if (route === "POST /api/shell/verb") {
    const body = await readJson(req);
    return sendJson(res, 200, { ok: true, ...(await invokeShellVerb(body)) });
  }

  if (route === "GET /api/state") {
    return sendJson(res, 200, await readState());
  }

  if (route === "POST /api/state") {
    const body = await readJson(req);
    const saved = await mutateState((state) => {
      if (body.layout && typeof body.layout === "object") {
        state.layout = body.layout;
      }
      if (Array.isArray(body.favorites)) {
        state.favorites = body.favorites.map(sanitizeFavorite);
      }
      if (Array.isArray(body.aliases)) {
        state.aliases = uniquePathAliases(body.aliases);
      }
      if (Array.isArray(body.recentLocations)) {
        state.recentLocations = body.recentLocations.map(sanitizeRecentLocation).slice(0, 20);
      }
      if (Array.isArray(body.fileBasket)) {
        state.fileBasket = uniqueCollectionItems(body.fileBasket).slice(0, 1000);
      }
      if (Array.isArray(body.commands)) {
        state.commands = body.commands.map(sanitizeCommand);
      }
      if (body.settings && typeof body.settings === "object") {
        state.settings = sanitizeSettings({ ...state.settings, ...body.settings });
      }
      if (Array.isArray(body.layouts)) {
        state.layouts = body.layouts.map(sanitizeSavedLayout).slice(0, 30);
      }
      if (Array.isArray(body.tabGroups)) {
        state.tabGroups = body.tabGroups.map(sanitizeTabGroup).slice(0, 50);
      }
      if (Array.isArray(body.scripts)) {
        state.scripts = body.scripts.map(sanitizeScriptSnippet).slice(0, 100);
      }
      if (Array.isArray(body.collections)) {
        state.collections = body.collections.map(sanitizeSavedCollection).slice(0, 50);
      }
      if (Array.isArray(body.paneSnapshots)) {
        state.paneSnapshots = body.paneSnapshots.map(sanitizePaneSnapshot).slice(0, 50);
      }
      if (Array.isArray(body.selectionSets)) {
        state.selectionSets = body.selectionSets.map(sanitizeSelectionSet).slice(0, 100);
      }
      if (Array.isArray(body.labels)) {
        state.labels = uniquePathLabels(body.labels);
      }
      if (Array.isArray(body.folderFormats)) {
        state.folderFormats = body.folderFormats.map(sanitizeFolderFormat).slice(0, 50);
      }
      if (Array.isArray(body.displayPresets)) {
        state.displayPresets = body.displayPresets.map(sanitizeDisplayPreset).slice(0, 50);
      }
      if (Array.isArray(body.filterPresets)) {
        state.filterPresets = body.filterPresets.map(sanitizeFilterPreset).slice(0, 50);
      }
      if (Array.isArray(body.syncProfiles)) {
        state.syncProfiles = body.syncProfiles.map(sanitizeSyncProfile).slice(0, 50);
      }
      if (Array.isArray(body.openWithPresets)) {
        state.openWithPresets = body.openWithPresets.map(sanitizeOpenWithPreset).slice(0, 50);
      }
      if (Array.isArray(body.searchPresets)) {
        state.searchPresets = body.searchPresets.map(sanitizeSearchPreset).slice(0, 50);
      }
      if (Array.isArray(body.selectPresets)) {
        state.selectPresets = body.selectPresets.map(sanitizeSelectPreset).slice(0, 50);
      }
      if (Array.isArray(body.bulkRenamePresets)) {
        state.bulkRenamePresets = body.bulkRenamePresets.map(sanitizeBulkRenamePreset).slice(0, 50);
      }
    });
    return sendJson(res, 200, saved);
  }

  if (route === "GET /api/labels") {
    const state = await readState();
    return sendJson(res, 200, { labels: state.labels || [] });
  }

  if (route === "POST /api/labels/apply") {
    const body = await readJson(req);
    return sendJson(res, 200, await applyPathLabels(body));
  }

  if (route === "POST /api/labels/clear") {
    const body = await readJson(req);
    return sendJson(res, 200, await clearPathLabels(body));
  }

  if (route === "GET /api/collections") {
    const state = await readState();
    return sendJson(res, 200, { collections: state.collections || [] });
  }

  if (route === "POST /api/collections") {
    const body = await readJson(req);
    return sendJson(res, 200, await upsertCollection(body));
  }

  if (route === "POST /api/collections/add") {
    const body = await readJson(req);
    return sendJson(res, 200, await addToCollection(body));
  }

  if (route === "POST /api/collections/remove") {
    const body = await readJson(req);
    return sendJson(res, 200, await removeFromCollection(body));
  }

  if (route === "POST /api/collections/resolve") {
    const body = await readJson(req);
    return sendJson(res, 200, await resolveCollection(body));
  }

  if (route === "DELETE /api/collections") {
    const id = url.searchParams.get("id");
    return sendJson(res, 200, await deleteCollection(id));
  }

  if (route === "GET /api/layouts") {
    const state = await readState();
    return sendJson(res, 200, { layouts: state.layouts || [] });
  }

  if (route === "POST /api/layouts") {
    const body = await readJson(req);
    const result = await mutateState((state) => {
      const existing = (state.layouts || []).find((item) => item.id === body.id);
      const savedLayout = sanitizeSavedLayout({
        id: body.id || existing?.id,
        name: body.name || existing?.name,
        description: body.description ?? existing?.description,
        createdAt: existing?.createdAt || body.createdAt,
        updatedAt: new Date().toISOString(),
        layout: body.layout || existing?.layout || state.layout
      });
      state.layouts = [
        savedLayout,
        ...(state.layouts || []).filter((item) => item.id !== savedLayout.id)
      ].slice(0, 30);
      return { layout: savedLayout, layouts: state.layouts };
    });
    return sendJson(res, 200, result);
  }

  if (route === "DELETE /api/layouts") {
    const id = url.searchParams.get("id");
    if (!id) {
      return sendError(res, 400, "Missing layout id.");
    }
    const result = await mutateState((state) => {
      state.layouts = (state.layouts || []).filter((item) => item.id !== id);
      if (state.settings?.startupLayoutId === id) {
        state.settings = sanitizeSettings({
          ...state.settings,
          startupMode: "last",
          startupLayoutId: ""
        });
      }
      return { layouts: state.layouts, settings: state.settings };
    });
    return sendJson(res, 200, result);
  }

  if (route === "POST /api/integration/generate") {
    return sendJson(res, 200, await writeIntegrationFiles());
  }

  if (route === "GET /api/integration/status") {
    return sendJson(res, 200, await getIntegrationStatus());
  }

  if (route === "POST /api/integration/backup") {
    const body = await readJson(req);
    const backup = await saveShellRegistryBackup(body.mode || "manual");
    return sendJson(res, 200, {
      ok: true,
      backup,
      status: await getIntegrationStatus()
    });
  }

  if (route === "POST /api/integration/restore") {
    const result = await restoreShellRegistryBackup();
    return sendJson(res, 200, {
      ok: true,
      ...result,
      status: await getIntegrationStatus()
    });
  }

  if (route === "POST /api/integration/app-package") {
    const body = await readJson(req);
    if (body.mode === "remove") {
      return sendJson(res, 200, await removeInstalledApp());
    }
    if (body.mode === "install") {
      return sendJson(res, 200, await installPackagedApp());
    }
    return sendError(res, 400, "Unknown packaged app mode.");
  }

  if (route === "POST /api/integration/shortcuts") {
    const body = await readJson(req);
    const paths = integrationPaths();
    const mode = body.mode === "remove" ? "remove" : "install";
    const result =
      mode === "remove"
        ? await removeShortcutIntegration(paths)
        : await installShortcutIntegration(body, paths);
    return sendJson(res, 200, {
      ok: true,
      mode,
      ...result,
      status: await getIntegrationStatus()
    });
  }

  if (route === "POST /api/integration/win-e") {
    const body = await readJson(req);
    const mode = body.mode === "remove" ? "remove" : "install";
    const result = await updateWinEIntegration(mode);
    return sendJson(res, 200, {
      ok: true,
      mode,
      stdout: result.stdout,
      status: await getIntegrationStatus()
    });
  }

  if (route === "POST /api/integration/cleanup") {
    const body = await readJson(req);
    return sendJson(res, 200, await cleanupCurrentUserIntegration(body));
  }

  if (route === "GET /api/background-indexes") {
    return sendJson(res, 200, await backgroundIndexOverview());
  }

  if (route === "POST /api/background-indexes") {
    const body = await readJson(req);
    const saved = await upsertBackgroundIndexRoot(body);
    let job = null;
    if (body.start === true) {
      job = await startBackgroundIndexJob(saved.root.id);
    }
    return sendJson(res, 200, {
      ...(await backgroundIndexOverview()),
      root: saved.root,
      job: backgroundIndexJobSnapshot(job)
    });
  }

  if (route === "DELETE /api/background-indexes") {
    await deleteBackgroundIndexRoot(url.searchParams.get("id"));
    return sendJson(res, 200, await backgroundIndexOverview());
  }

  if (route === "POST /api/background-indexes/start") {
    const body = await readJson(req);
    let rootId = sanitizeReferenceId(body.id);
    if (!rootId && body.path) {
      const saved = await upsertBackgroundIndexRoot({ ...body, enabled: true });
      rootId = saved.root.id;
    }
    const job = await startBackgroundIndexJob(rootId);
    return sendJson(res, 200, {
      ...(await backgroundIndexOverview()),
      job: backgroundIndexJobSnapshot(job)
    });
  }

  if (route === "POST /api/background-indexes/stop") {
    const body = await readJson(req);
    const stopped = await stopBackgroundIndexJob(body.id);
    return sendJson(res, 200, {
      ...(await backgroundIndexOverview()),
      stopped
    });
  }

  if (route === "GET /api/background-indexes/search") {
    return sendJson(
      res,
      200,
      await searchBackgroundIndexes({
        query: url.searchParams.get("q"),
        limit: url.searchParams.get("limit"),
        rootId: url.searchParams.get("rootId"),
        rootPath: url.searchParams.get("path") || url.searchParams.get("rootPath"),
        kind: url.searchParams.get("kind"),
        sizeOp: url.searchParams.get("sizeOp"),
        sizeValue: url.searchParams.get("sizeValue"),
        sizeBytes: url.searchParams.get("sizeBytes"),
        dateField: url.searchParams.get("dateField"),
        dateOp: url.searchParams.get("dateOp"),
        dateDays: url.searchParams.get("dateDays"),
        attribute: url.searchParams.get("attribute"),
        includeHidden: url.searchParams.get("includeHidden")
      })
    );
  }

  if (route === "GET /api/cache/maintenance") {
    return sendJson(
      res,
      200,
      await cacheMaintenanceReport({
        method: "GET",
        maxAgeDays: url.searchParams.get("maxAgeDays"),
        fileLimit: url.searchParams.get("fileLimit"),
        includeItems: url.searchParams.get("includeItems") !== "false"
      })
    );
  }

  if (route === "POST /api/cache/maintenance") {
    const body = await readJson(req);
    return sendJson(res, 200, await cacheMaintenanceReport({ ...body, method: "POST" }));
  }

  if (route === "GET /api/index/status") {
    return sendJson(res, 200, await folderIndexStatus(url.searchParams.get("path"), url.searchParams.get("jobId")));
  }

  if (route === "POST /api/index/build") {
    const body = await readJson(req);
    if (body.wait === true) {
      const index = await buildFolderIndex(body.path, {
        showHidden: body.showHidden !== false,
        includeDimensions: body.includeDimensions === true,
        includeLinks: body.includeLinks === true
      });
      return sendJson(res, 200, {
        job: {
          status: "complete",
          path: index.path,
          index: folderIndexSummary(index)
        },
        index: folderIndexSummary(index)
      });
    }
    const job = startFolderIndexJob(body.path, {
      showHidden: body.showHidden !== false,
      includeDimensions: body.includeDimensions === true,
      includeLinks: body.includeLinks === true
    });
    return sendJson(res, 200, { job: folderIndexJobSnapshot(job) });
  }

  if (route === "GET /api/index/search") {
    return sendJson(
      res,
      200,
      await searchFolderIndex({
        targetPath: url.searchParams.get("path"),
        query: url.searchParams.get("q"),
        limit: url.searchParams.get("limit")
      })
    );
  }

  if (route === "POST /api/integration/test-open") {
    const body = await readJson(req);
    const paths = integrationPaths();
    if (!(await pathExists(paths.scriptPath))) {
      await writeIntegrationFiles();
    }
    const targetPath = resolveUserPath(body.path || __dirname);
    const result = await runProcess("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      paths.scriptPath,
      targetPath
    ]);
    if (result.code !== 0) {
      return sendError(res, 500, "Launcher test failed.", {
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
    return sendJson(res, 200, {
      ok: true,
      path: targetPath,
      stdout: result.stdout,
      status: await getIntegrationStatus()
    });
  }

  if (route === "POST /api/integration/apply") {
    const body = await readJson(req);
    const paths = integrationPaths();
    if (body.mode === "removeFolderDefault") {
      const status = await getIntegrationStatus();
      if (status.registry?.shellBackup?.available) {
        const restored = await restoreShellRegistryBackup();
        return sendJson(res, 200, {
          ...restored,
          restoredBackup: true,
          status: await getIntegrationStatus()
        });
      }
    }
    const modeToFile = {
      contextMenu: paths.contextMenuRegPath,
      removeContextMenu: paths.contextMenuRemoveRegPath,
      folderDefault: paths.folderDefaultRegPath,
      removeFolderDefault: paths.folderDefaultRemoveRegPath
    };
    const file = modeToFile[body.mode];
    if (!file) {
      return sendError(res, 400, "Unknown integration mode.");
    }
    if (!(await pathExists(file))) {
      await writeIntegrationFiles();
    }
    const backup = ["contextMenu", "folderDefault"].includes(body.mode)
      ? await ensureShellRegistryBackup(body.mode)
      : null;
    const result = await importRegistryFile(file);
    return sendJson(res, 200, { ...result, backup, status: await getIntegrationStatus() });
  }

  if (route === "GET /api/list") {
    const signal = requestAbortSignal(req, res);
    const windowOptions = listWindowOptions(url.searchParams);
    const listing = await listDirectory(url.searchParams.get("path"), {
      signal,
      showHidden: url.searchParams.get("showHidden") !== "false",
      includeDimensions: url.searchParams.get("includeDimensions") === "true",
      includeLinks: url.searchParams.get("includeLinks") === "true",
      includeAttributes: url.searchParams.get("includeAttributes") === "true",
      includeSignature: url.searchParams.get("includeSignature") === "true",
      bypassCache: url.searchParams.get("bypassCache") === "true",
      windowOptions
    });
    return sendJson(
      res,
      200,
      formattedDirectoryListing(
        windowDirectoryListing(listing, windowOptions),
        url.searchParams.get("format") || ""
      )
    );
  }

  if (route === "GET /api/path/diagnostics") {
    return sendJson(
      res,
      200,
      await diagnosePath(url.searchParams.get("path"), {
        check: url.searchParams.get("check") !== "false",
        watch: url.searchParams.get("watch") !== "false",
        timeoutMs: url.searchParams.get("timeoutMs"),
        sampleLimit: url.searchParams.get("sampleLimit")
      })
    );
  }

  if (route === "GET /api/archive/list") {
    const signal = requestAbortSignal(req, res);
    return sendJson(
      res,
      200,
      await listZipArchive(url.searchParams.get("path") || url.searchParams.get("archive"), {
        signal,
        innerPath: url.searchParams.get("innerPath") || url.searchParams.get("prefix") || "",
        limit: url.searchParams.get("limit"),
        scanLimit: url.searchParams.get("scanLimit")
      })
    );
  }

  if (route === "GET /api/folder-signature") {
    const signal = requestAbortSignal(req, res);
    return sendJson(
      res,
      200,
      await directorySignature(url.searchParams.get("path"), {
        signal,
        limit: url.searchParams.get("limit"),
        showHidden: url.searchParams.get("showHidden") !== "false",
        includeDimensions: url.searchParams.get("includeDimensions") === "true",
        includeLinks: url.searchParams.get("includeLinks") === "true",
        includeAttributes: url.searchParams.get("includeAttributes") === "true"
      })
    );
  }

  if (route === "GET /api/folder-watch") {
    return sendJson(
      res,
      200,
      await folderWatchStatus(url.searchParams.get("path"), {
        since: url.searchParams.get("since")
      })
    );
  }

  if (route === "GET /api/tree") {
    const signal = requestAbortSignal(req, res);
    return sendJson(
      res,
      200,
      await listTreeChildren(url.searchParams.get("path"), {
        signal,
        limit: url.searchParams.get("limit"),
        showHidden: url.searchParams.get("showHidden") !== "false",
        includeStats: url.searchParams.get("includeStats") !== "false",
        includeChildState: url.searchParams.get("includeChildState") !== "false",
        includeAttributes: url.searchParams.get("includeAttributes") === "true"
      })
    );
  }

  if (route === "GET /api/preview") {
    return sendJson(res, 200, await previewFile(url.searchParams.get("path")));
  }

  if (route === "POST /api/text/save") {
    const body = await readJson(req);
    const operation = await enqueueOperation("edit-text", operationLabel("edit-text", body), () =>
      saveTextFile(body)
    );
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/properties") {
    const body = await readJson(req);
    return sendJson(res, 200, await propertiesReport(body));
  }

  if (route === "POST /api/size-analysis") {
    const signal = requestAbortSignal(req, res);
    const body = await readJson(req);
    return sendJson(res, 200, await sizeAnalysisReport(body, { signal }));
  }

  if (route === "POST /api/checksums") {
    const body = await readJson(req);
    return sendJson(res, 200, await checksumReport(body));
  }

  if (route === "POST /api/checksums/verify") {
    const body = await readJson(req);
    return sendJson(res, 200, await verifyChecksumManifest(body));
  }

  if (route === "GET /api/search") {
    return sendJson(
      res,
      200,
      await searchDirectory(
        url.searchParams.get("path"),
        url.searchParams.get("q"),
        Number(url.searchParams.get("limit") || 200)
      )
    );
  }

  if (route === "POST /api/search") {
    const body = await readJson(req);
    return sendJson(res, 200, await advancedSearch(body));
  }

  if (route === "POST /api/flat") {
    const body = await readJson(req);
    return sendJson(res, 200, await flatView(body));
  }

  if (route === "POST /api/duplicates") {
    const body = await readJson(req);
    return sendJson(res, 200, await duplicateFiles(body));
  }

  if (route === "POST /api/compare") {
    const body = await readJson(req);
    return sendJson(res, 200, await compareDirectories(body));
  }

  if (route === "POST /api/sync") {
    const body = await readJson(req);
    requireBrowserApplyToken(req, body);
    const operation = await runRetryableOperation("sync", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "GET /api/raw") {
    const file = resolveUserPath(url.searchParams.get("path"));
    const stats = await fs.stat(file);
    if (!stats.isFile()) {
      return sendError(res, 400, "Only files can be streamed.");
    }
    const ext = path.extname(file).toLowerCase();
    const contentType = mimeTypes.get(ext) || "application/octet-stream";
    const versioned = url.searchParams.has("v");
    const etag = `"${crypto
      .createHash("sha1")
      .update(`${pathIdentity(file)}\0${stats.size}\0${Math.round(stats.mtimeMs)}`)
      .digest("hex")
      .slice(0, 24)}"`;
    const lastModified = stats.mtime.toUTCString();
    const cacheControl = versioned ? "private, max-age=604800, immutable" : "private, max-age=0, must-revalidate";
    const commonHeaders = {
      "content-type": contentType,
      "accept-ranges": "bytes",
      "cache-control": cacheControl,
      etag,
      "last-modified": lastModified
    };
    if (!req.headers.range && requestEtagMatches(req.headers["if-none-match"], etag)) {
      res.writeHead(304, commonHeaders);
      return res.end();
    }
    if (!req.headers.range && req.headers["if-modified-since"]) {
      const since = Date.parse(req.headers["if-modified-since"]);
      if (Number.isFinite(since) && since >= Math.floor(stats.mtimeMs / 1000) * 1000) {
        res.writeHead(304, commonHeaders);
        return res.end();
      }
    }
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start;
      let end;
      if (match) {
        if (match[1]) {
          start = Number(match[1]);
          end = match[2] ? Number(match[2]) : stats.size - 1;
        } else if (match[2]) {
          const suffixLength = Number(match[2]);
          start = Math.max(stats.size - suffixLength, 0);
          end = stats.size - 1;
        }
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        start >= stats.size
      ) {
        res.writeHead(416, {
          "content-range": `bytes */${stats.size}`,
          "cache-control": cacheControl,
          etag,
          "last-modified": lastModified
        });
        return res.end();
      }
      end = Math.min(end, stats.size - 1);
      res.writeHead(206, {
        ...commonHeaders,
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${stats.size}`
      });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, {
      ...commonHeaders,
      "content-length": stats.size
    });
    return createReadStream(file).pipe(res);
  }

  if (route === "POST /api/mkdir") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("mkdir", body);
    return sendJson(res, 200, { path: operation.result.path, operation });
  }

  if (route === "POST /api/file/create") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("create-file", body);
    return sendJson(res, 200, { path: operation.result.path, operation });
  }

  if (route === "POST /api/shortcut/create") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("shortcut-create", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/link/create") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("link-create", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/attributes/set") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("attributes-set", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/timestamps/set") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("timestamps-set", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/rename") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("rename", body);
    return sendJson(res, 200, { path: operation.result.path, operation });
  }

  if (route === "POST /api/bulk-rename/preview") {
    const body = await readJson(req);
    return sendJson(res, 200, await buildBulkRenamePlan(body));
  }

  if (route === "POST /api/bulk-rename") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("bulk-rename", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/operation/preview") {
    const body = await readJson(req);
    return sendJson(res, 200, await buildOperationPreview(body));
  }

  if (route === "POST /api/transfer/preview") {
    const body = await readJson(req);
    return sendJson(res, 200, await buildTransferPlan(body));
  }

  if (route === "POST /api/transfer") {
    const body = await readJson(req);
    requireBrowserApplyToken(req, body);
    const operation = await runRetryableOperation("transfer", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/archive/create") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("archive-create", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/archive/extract") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("archive-extract", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/copy") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("copy", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/move") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("move", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/delete") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("delete", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/recycle") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("recycle", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/trash") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("trash", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "GET /api/app-trash") {
    return sendJson(res, 200, await listAppTrash());
  }

  if (route === "GET /api/windows-recycle-bin") {
    return sendJson(
      res,
      200,
      await listWindowsRecycleBin({
        limit: url.searchParams.get("limit")
      })
    );
  }

  if (route === "POST /api/windows-recycle-bin/restore") {
    const body = await readJson(req);
    if (body.dryRun === true) {
      const dryRun = await restoreWindowsRecycleBinItems({ ...body, dryRun: true });
      return sendJson(res, 200, dryRun.result);
    }
    const operation = await enqueueOperation(
      "windows-recycle-restore",
      operationLabel("windows-recycle-restore", body),
      (hooks) => restoreWindowsRecycleBinItems(body, hooks)
    );
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/app-trash/restore") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("trash-restore", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/app-trash/delete") {
    const body = await readJson(req);
    const operation = await runRetryableOperation("trash-delete", body);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/operation/undo") {
    const body = await readJson(req);
    const sourceState = await readState();
    const sourceOperation = sourceState.operations.find((item) => item.id === body.operationId);
    const undoLabel = sourceOperation?.label ? `Undo ${sourceOperation.label}` : operationLabel("undo", body);
    const operation = await enqueueOperation("undo", undoLabel, async (hooks) => {
      const state = await readState();
      const original = state.operations.find((item) => item.id === body.operationId);
      await hooks.updateProgress?.({
        unit: "items",
        total: 1,
        completed: 0,
        phase: "Undoing",
        current: original?.label || body.operationId,
        currentPath: original?.undo?.items?.[0]?.path || original?.undo?.items?.[0]?.from || original?.undo?.from || ""
      });
      const result = await undoRecordedOperation(original);
      await mutateState((nextState) => {
        const index = nextState.operations.findIndex((item) => item.id === original.id);
        if (index !== -1) {
          nextState.operations[index] = original;
        }
      });
      await hooks.updateProgress?.({
        unit: "items",
        total: 1,
        completed: 1,
        phase: "Completed",
        current: original?.label || body.operationId
      });
      return result;
    }, { relatedOperationId: body.operationId });
    await recordRelatedOperation(body.operationId, operation, "undo", "Undo operation linked.");
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/operation/backup-recovery") {
    const body = await readJson(req);
    const operation = await enqueueOperation("backup-recovery", operationLabel("backup-recovery", body), async (hooks) => {
      const state = await readState();
      const original = state.operations.find((item) => item.id === body.operationId);
      const result = await recoverOperationBackups(original, body, hooks);
      await mutateState((nextState) => {
        const index = nextState.operations.findIndex((item) => item.id === original.id);
        if (index !== -1) {
          nextState.operations[index] = original;
        }
      });
      return result;
    });
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/operation/cancel") {
    const body = await readJson(req);
    return sendJson(res, 200, { operation: await cancelOperation(body.operationId) });
  }

  if (route === "POST /api/operation/pause") {
    const body = await readJson(req);
    return sendJson(res, 200, { operation: await pauseOperation(body.operationId) });
  }

  if (route === "POST /api/operation/resume") {
    const body = await readJson(req);
    return sendJson(res, 200, { operation: await resumeOperation(body.operationId) });
  }

  if (route === "POST /api/operation/retry") {
    const body = await readJson(req);
    const operation = await retryRecordedOperation(body.operationId);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/operation/retry-remaining") {
    const body = await readJson(req);
    const operation = await retryRemainingRecordedOperation(body.operationId);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/operation/retry-selected") {
    const body = await readJson(req);
    const operation = await retrySelectedRemainingRecordedOperation(body.operationId, body.indexes);
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/operation/elevated-retry") {
    const body = await readJson(req);
    return sendJson(
      res,
      200,
      await prepareElevatedRetryOperation(body.operationId, {
        indexes: body.indexes,
        dryRun: body.dryRun === true,
        prepare: body.prepare !== false,
        launch: body.launch === true
      })
    );
  }

  if (route === "POST /api/operations/clear") {
    const saved = await mutateState((state) => {
      state.operations = [];
    });
    return sendJson(res, 200, saved);
  }

  if (route === "POST /api/command/run") {
    const body = await readJson(req);
    const state = await readState();
    const savedCommand = body.commandId
      ? state.commands.find((command) => command.id === body.commandId)
      : body.command;
    if (!savedCommand) {
      return sendError(res, 404, "Command not found.");
    }
    const command = sanitizeCommand(savedCommand);
    const context = await buildCommandContext(body);
    const operation = await enqueueOperation(
      "command",
      operationLabel("command", { ...body, name: command.name }),
      () => runExternalCommand(command, context)
    );
    return sendJson(res, 200, { ...operation.result, operation });
  }

  if (route === "POST /api/open") {
    const body = await readJson(req);
    launchExplorer(body.path, Boolean(body.reveal));
    return sendJson(res, 200, { ok: true });
  }

  if (route === "POST /api/open-with") {
    const body = await readJson(req);
    return sendJson(res, 200, { ok: true, ...(await openWithLaunch(body)) });
  }

  if (route === "POST /api/windows-properties") {
    const body = await readJson(req);
    return sendJson(res, 200, { ok: true, ...(await openWindowsProperties(body)) });
  }

  if (route === "GET /api/clipboard/files") {
    return sendJson(res, 200, { ok: true, ...(await readClipboardFiles()) });
  }

  if (route === "POST /api/clipboard/files") {
    const body = await readJson(req);
    return sendJson(res, 200, { ok: true, ...(await writeClipboardFiles(body)) });
  }

  if (route === "POST /api/clipboard/files/clear") {
    return sendJson(res, 200, { ok: true, ...(await clearClipboardFiles()) });
  }

  if (route === "POST /api/clipboard/text") {
    const body = await readJson(req);
    return sendJson(res, 200, { ok: true, ...(await writeClipboardText(body.text)) });
  }

  if (route === "POST /api/script") {
    const body = await readJson(req);
    const scriptName = String(body.name || body.scriptName || "").trim().slice(0, 80);
    const operation = await enqueueOperation(
      "script",
      operationLabel("script", { ...body, name: scriptName }),
      async (hooks) => {
        await hooks.updateProgress?.({
          unit: "steps",
          total: 1,
          completed: 0,
          phase: "Starting script"
        });
        const output = await runTrustedScript(body, hooks);
        await hooks.updateProgress?.({
          unit: "steps",
          total: 1,
          completed: 1,
          phase: "Script complete"
        });
        return {
          result: {
            scriptId: body.scriptId ? String(body.scriptId).slice(0, 120) : null,
            name: scriptName || "Ad hoc script",
            contextPath: resolveUserPath(body.contextPath || body.activePath || workspaceRoot),
            selectedCount: Array.isArray(body.selectedPaths) ? body.selectedPaths.length : 0,
            logs: boundedLogLines(output.logs),
            events: Array.isArray(output.events) ? output.events.slice(0, 100) : [],
            result: boundedJsonValue(output.result),
            cacheInvalidation: output.cacheInvalidation,
            backgroundIndexInvalidation: output.backgroundIndexInvalidation
          },
          undo: null
        };
      }
    );
    return sendJson(res, 200, { ...operation.result, operation });
  }

  return sendError(res, 404, "Unknown API route.");
}

function safeStaticPath(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const decoded = decodeURIComponent(requested);
  const file = path.normalize(path.join(publicDir, decoded));
  const relative = path.relative(publicDir, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return file;
}

async function serveStatic(req, res, url) {
  let file = safeStaticPath(url.pathname);
  if (!file) {
    return sendError(res, 403, "Static path is outside the public directory.");
  }
  try {
    let stats;
    try {
      stats = await fs.stat(file);
    } catch (error) {
      if (error.code !== "ENOENT" || url.pathname !== "/generated/app-runtime.js") throw error;
      file = path.join(publicDir, "app.js");
      stats = await fs.stat(file);
    }
    if (!stats.isFile()) {
      return sendError(res, 404, "Static file not found.");
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "content-type": mimeTypes.get(ext) || "application/octet-stream",
      "content-length": stats.size,
      "cache-control": "no-store",
      "content-security-policy": contentSecurityPolicy,
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy": "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "set-cookie": `${apiCapabilityCookieName}=${apiCapability}; HttpOnly; SameSite=Strict; Path=/`
    });
    return createReadStream(file).pipe(res);
  } catch {
    return sendError(res, 404, "Static file not found.");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const boundaryError = validateRequestBoundary(req);
    if (boundaryError) {
      return sendError(res, boundaryError.status, boundaryError.message);
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      const releaseForeground = requestIsForegroundWork(url, req.method) ? beginForegroundActivity(`${req.method} ${url.pathname}`) : null;
      try {
        await handleApi(req, res, url);
      } finally {
        releaseForeground?.();
      }
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    if (isAbortError(error) || res.destroyed || res.writableEnded) {
      return;
    }
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    sendError(res, status, error.message || "Unexpected server error.", {
      name: error.name,
      code: error.code
    });
  }
});

let serverStartPromise = null;

export async function startServer() {
  if (server.listening) {
    return server;
  }
  if (serverStartPromise) return serverStartPromise;
  serverStartPromise = (async () => {
    await readCachedState();
    warmNativeFilesystemHelper().catch((error) => {
      console.warn(`Could not warm native filesystem helper: ${error.message}`);
    });
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        console.log(`Explore Better running at http://${host}:${port}`);
        syncBackgroundIndexWatchersFromState().catch((error) => {
          console.warn(`Could not start background index watchers: ${error.message}`);
        });
        resolve(server);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
  })();
  try {
    return await serverStartPromise;
  } finally {
    serverStartPromise = null;
  }
}

export function stopServer() {
  if (!server.listening) {
    stopNativeFilesystemHelperClient();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      stopNativeFilesystemHelperClient();
      resolve();
    });
  });
}

let mcpAutomationServicePromise = null;

function persistedMcpContextFromState(state) {
  const layout = state?.layout || defaultState().layout;
  const panes = {};
  for (const paneId of ["left", "right"]) {
    const pane = layout.panes?.[paneId] || { activeTab: 0, tabs: [] };
    const tabs = (pane.tabs || []).map((tab, index) => ({
      id: `persisted-${paneId}-${crypto.createHash("sha1").update(`${index}:${tab.path}`).digest("hex").slice(0, 16)}`,
      path: tab.path,
      title: tab.title || labelFromPath(tab.path)
    }));
    const activeTab = tabs[Math.max(0, Math.min(Number(pane.activeTab || 0), tabs.length - 1))] || null;
    panes[paneId] = {
      activeTabId: activeTab?.id || "",
      path: activeTab?.path || "",
      tabs
    };
  }
  return {
    live: false,
    activePane: layout.activePane === "right" ? "right" : "left",
    paneLayout: layout.paneLayout || "vertical",
    panes,
    selection: [],
    focusedPath: "",
    ui: {
      status: "",
      toast: { visible: false, text: "" },
      openDialogs: [],
      activeControl: null,
      lastInteraction: null,
      navigator: { visible: false, sections: [] },
      terminals: [],
      update: { visible: false, title: "", message: "" }
    },
    contextRevision: 0
  };
}

async function startMcpUndoOperation(operationId, principal) {
  const body = { operationId };
  const operation = await enqueueOperation("undo", operationLabel("undo", body), async (hooks) => {
    const state = await readState();
    const original = state.operations.find((item) => item.id === operationId);
    if (!original) {
      throw new Error("Operation not found.");
    }
    await hooks.updateProgress?.({
      unit: "items",
      total: 1,
      completed: 0,
      phase: "Undoing",
      current: original.label,
      currentPath: original?.undo?.items?.[0]?.path || original?.undo?.items?.[0]?.from || original?.undo?.from || ""
    });
    const result = await undoRecordedOperation(original);
    await mutateState((nextState) => {
      const index = nextState.operations.findIndex((item) => item.id === original.id);
      if (index !== -1) nextState.operations[index] = original;
    });
    await hooks.updateProgress?.({ unit: "items", total: 1, completed: 1, phase: "Completed", current: original.label });
    return result;
  }, {
    returnQueued: true,
    relatedOperationId: operationId,
    mcpProfileId: principal.profileId,
    mcpSessionId: principal.sessionId
  });
  await recordRelatedOperation(operationId, operation, "undo", "Undo operation linked.");
  return operation;
}

async function getMcpAutomationService() {
  if (!mcpAutomationServicePromise) {
    mcpAutomationServicePromise = (async () => {
      const { createMcpAutomationService } = await import("./mcp/automation-service.mjs");
      return createMcpAutomationService({
        appDataRoot,
        internalRoots: [appDataRoot],
        workspaceRoot,
        resolveUserPath,
        readState,
        listDirectory: async (targetPath, options = {}) =>
          windowDirectoryListing(await listDirectory(targetPath, options), options.windowOptions),
        advancedSearch,
        propertiesReport,
        checksumReport,
        getRoots,
        getShellLocations,
        healthReport,
        indexStatus: (targetPath) => folderIndexStatus(targetPath || "", ""),
        sizeAnalysisReport,
        duplicateFiles,
        compareDirectories,
        buildOperationPreview,
        persistedContext: async () => persistedMcpContextFromState(await readState()),
        upsertCollection,
        addToCollection,
        removeFromCollection,
        deleteCollection,
        applyPathLabels,
        clearPathLabels,
        startOperation: (type, body, principal) => runRetryableOperation(type, body, {
          returnQueued: true,
          mcpProfileId: principal.profileId,
          mcpSessionId: principal.sessionId
        }),
        getOperation: async (operationId) => {
          const state = await readState();
          return state.operations.find((operation) => operation.id === operationId) || null;
        },
        waitForOperation: waitForOperationCondition,
        controlOperation: async (operationId, action, principal = {}) => {
          if (action === "cancel") return cancelOperation(operationId);
          if (action === "pause") return pauseOperation(operationId);
          if (action === "resume") return resumeOperation(operationId);
          if (action === "retry") return retryRecordedOperation(operationId, {
            returnQueued: true,
            mcpProfileId: principal.profileId,
            mcpSessionId: principal.sessionId
          });
          throw new Error("Unsupported operation control action.");
        },
        undoOperation: startMcpUndoOperation
      });
    })().catch((error) => {
      mcpAutomationServicePromise = null;
      throw error;
    });
  }
  return mcpAutomationServicePromise;
}

export async function getMcpContract() {
  return cloneState((await getMcpAutomationService()).contract);
}

export async function getMcpProfileContract(profileId) {
  return (await getMcpAutomationService()).getProfileContract(profileId);
}

export async function getMcpBridgeConfiguration() {
  return (await getMcpAutomationService()).getConfiguration();
}

export async function configureMcpBridge(patch) {
  return (await getMcpAutomationService()).configure(patch);
}

export async function upsertMcpProfile(profile) {
  return (await getMcpAutomationService()).upsertProfile(profile);
}

export async function revokeMcpProfile(profileId) {
  return (await getMcpAutomationService()).revokeProfile(profileId);
}

export async function listMcpAudit(limit) {
  return (await getMcpAutomationService()).listAudit(limit);
}

export async function invokeMcpAutomation(request) {
  return (await getMcpAutomationService()).invoke(request);
}

export async function readMcpAutomationResource(request) {
  return (await getMcpAutomationService()).readResource(request);
}

export async function setMcpUiDispatcher(dispatcher) {
  (await getMcpAutomationService()).setUiDispatcher(dispatcher);
}

export function setMcpResourceUpdatePublisher(publisher) {
  mcpResourceUpdatePublisher = typeof publisher === "function" ? publisher : null;
}

export { host, port };

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));

if (invokedPath === modulePath) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
