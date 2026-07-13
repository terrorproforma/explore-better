import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `release-readiness-${stamp}`);
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const latestJsonPath = path.join(artifactsDir, "release-readiness-latest.json");
const latestMdPath = path.join(artifactsDir, "release-readiness-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_RELEASE_KEEP_FIXTURE === "1";
}

function skipDesktopSmoke() {
  return process.argv.includes("--skip-desktop-smoke") || process.env.EB_RELEASE_SKIP_DESKTOP_SMOKE === "1";
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function isRetryableDesktopBindFailure(result) {
  return /EACCES|EADDRINUSE|permission denied|address already in use/i.test(
    `${result?.error || ""}\n${result?.stderr || ""}\n${result?.stdout || ""}`
  );
}

function limitedAppend(current, chunk, limit = 24000) {
  const next = current + chunk.toString();
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function statusCounts(checks) {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length
  };
}

function addCheck(checks, status, id, label, detail = "", data = {}) {
  checks.push({ status, id, label, detail, ...data });
}

function requireCheck(checks, condition, id, label, detail = "", data = {}) {
  addCheck(checks, condition ? "pass" : "fail", id, label, detail, data);
  return Boolean(condition);
}

function warnCheck(checks, condition, id, label, detail = "", data = {}) {
  addCheck(checks, condition ? "pass" : "warn", id, label, detail, data);
  return Boolean(condition);
}

function buildArchName() {
  if (process.arch === "x64") return "x64";
  if (process.arch === "ia32") return "ia32";
  if (process.arch === "arm64") return "arm64";
  return process.arch;
}

function renderArtifactName(template, pkg, ext) {
  return String(template || "")
    .replaceAll("${productName}", pkg.build?.productName || pkg.productName || pkg.name || "ExploreBetter")
    .replaceAll("${name}", pkg.name || "explore-better")
    .replaceAll("${version}", pkg.version || "0.0.0")
    .replaceAll("${arch}", buildArchName())
    .replaceAll("${ext}", ext);
}

async function pathExists(itemPath) {
  try {
    await fs.access(itemPath);
    return true;
  } catch {
    return false;
  }
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function readJsonFile(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function newestMtimeMs(itemPath) {
  let stat = null;
  try {
    stat = await fs.stat(itemPath);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) {
    return Number(stat.mtimeMs) || 0;
  }
  let newest = Number(stat.mtimeMs) || 0;
  const entries = await fs.readdir(itemPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "artifacts") {
      continue;
    }
    newest = Math.max(newest, await newestMtimeMs(path.join(itemPath, entry.name)));
  }
  return newest;
}

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 12000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${serverOutput}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}: ${serverOutput}`);
}

function startServer(port) {
  serverOutput = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => {
    serverOutput = limitedAppend(serverOutput, chunk);
  });
  child.stderr.on("data", (chunk) => {
    serverOutput = limitedAppend(serverOutput, chunk);
  });
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function runCommand(command, args, { timeoutMs = 60000, env = {} } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    try {
      child = spawn(command, args, {
        cwd: workspace,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      resolve({ code: null, error: error.message, stdout, stderr });
      return;
    }
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = limitedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = limitedAppend(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: null, error: error.message, stdout, stderr });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

async function seedReleaseState() {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        settings: {
          launchMode: "native",
          shellOpenMode: "activeNewTab"
        },
        operations: []
      },
      null,
      2
    ),
    "utf8"
  );
}

async function readPackageJson(checks) {
  const packagePath = path.join(workspace, "package.json");
  try {
    const text = await fs.readFile(packagePath, "utf8");
    const pkg = JSON.parse(text);
    requireCheck(checks, pkg.name === "explore-better", "pkg-name", "Package identity", pkg.name || "missing");
    requireCheck(
      checks,
      Boolean(pkg.author),
      "pkg-author",
      "Package author metadata",
      typeof pkg.author === "string" ? pkg.author : JSON.stringify(pkg.author || null)
    );
    requireCheck(checks, Boolean(pkg.main), "pkg-main", "Electron entrypoint declared", pkg.main || "missing");
    requireCheck(checks, Boolean(pkg.build?.appId), "pkg-app-id", "Electron appId declared", pkg.build?.appId || "missing");
    requireCheck(
      checks,
      pkg.build?.productName === "Explore Better",
      "pkg-product-name",
      "Desktop product name",
      pkg.build?.productName || "missing"
    );
    requireCheck(
      checks,
      Boolean(pkg.scripts?.["package:dir"] && pkg.scripts?.["package:win"]),
      "pkg-package-scripts",
      "Desktop package scripts",
      `package:dir=${pkg.scripts?.["package:dir"] || "missing"}; package:win=${pkg.scripts?.["package:win"] || "missing"}`
    );
    const buildFiles = Array.isArray(pkg.build?.files) ? pkg.build.files : [];
    const requiredBuildFiles = [
      "electron-main.mjs",
      "electron-preload.cjs",
      "server.mjs",
      "public/**/*",
      "README.md",
      "USER_MANUAL.md",
      "package.json"
    ];
    const missingBuildFiles = requiredBuildFiles.filter((entry) => !buildFiles.includes(entry));
    requireCheck(
      checks,
      missingBuildFiles.length === 0,
      "pkg-build-files",
      "Packaged app file manifest",
      missingBuildFiles.length ? `Missing ${missingBuildFiles.join(", ")}` : buildFiles.join(", ")
    );
    const winIcon = pkg.build?.win?.icon || pkg.build?.icon || "";
    const iconPath = winIcon ? path.join(workspace, winIcon) : "";
    const iconPresent = Boolean(iconPath) && (await pathExists(iconPath));
    const iconStat = iconPresent ? await fs.stat(iconPath) : null;
    requireCheck(
      checks,
      iconPresent && path.extname(iconPath).toLowerCase() === ".ico" && iconStat.size > 1024,
      "pkg-win-icon",
      "Windows app icon configured",
      iconPresent
        ? path.extname(iconPath).toLowerCase() === ".ico" && iconStat.size > 1024
          ? `${winIcon} (${iconStat.size} bytes)`
          : `${winIcon} is present but does not look like a real Windows .ico asset.`
        : "Missing build.win.icon; electron-builder will use the default Electron icon."
    );
    const targets = Array.isArray(pkg.build?.win?.target) ? pkg.build.win.target : [];
    const installerName = renderArtifactName(
      pkg.build?.nsis?.artifactName || pkg.build?.win?.artifactName || "ExploreBetter-${version}-${arch}-setup.${ext}",
      pkg,
      "exe"
    );
    requireCheck(
      checks,
      targets.includes("dir") && targets.includes("portable"),
      "pkg-win-targets",
      "Windows package targets",
      targets.length ? targets.join(", ") : "missing"
    );
    warnCheck(
      checks,
      pkg.build?.win?.signAndEditExecutable !== false,
      "release-code-signing",
      "Code signing configured",
      pkg.build?.win?.signAndEditExecutable === false
        ? "build.win.signAndEditExecutable is false; production shell replacement still needs a code-signing certificate."
        : "Code signing is not explicitly disabled."
    );
    const codeSigningReportPath = path.join(artifactsDir, "code-signing-rehearsal-latest.json");
    let codeSigningRehearsalOk = false;
    let codeSigningRehearsalDetail = "Missing artifacts\\code-signing-rehearsal-latest.json; run npm run verify:code-signing after packaging.";
    try {
      const codeSigningReport = await readJsonFile(codeSigningReportPath);
      const installerPath = path.join(workspace, "dist", installerName);
      const installerHash = (await pathExists(installerPath)) ? await hashFile(installerPath) : "";
      codeSigningRehearsalOk =
        codeSigningReport.status === "pass" &&
        codeSigningReport.signing?.removedCertificate === true &&
        codeSigningReport.signing?.verifyStatus !== "NotSigned" &&
        codeSigningReport.signing?.signerThumbprint &&
        codeSigningReport.sourceBefore?.sha256 === installerHash &&
        codeSigningReport.sourceAfter?.sha256 === installerHash &&
        codeSigningReport.signedCopy?.sha256 &&
        codeSigningReport.signedCopy.sha256 !== installerHash;
      codeSigningRehearsalDetail = codeSigningRehearsalOk
        ? `Temporary certificate signing rehearsal passed for ${installerName}.`
        : "Code-signing rehearsal is missing, stale, failed, or did not clean up its temporary certificate.";
    } catch {
      codeSigningRehearsalOk = false;
    }
    warnCheck(
      checks,
      codeSigningRehearsalOk,
      "release-code-signing-rehearsal",
      "Code-signing rehearsal",
      codeSigningRehearsalDetail
    );
    const hasInstallerTarget = targets.some((target) => ["nsis", "msi", "msiWrapped"].includes(target));
    warnCheck(
      checks,
      hasInstallerTarget,
      "release-installer-target",
      "Installer target configured",
      hasInstallerTarget
        ? targets.join(", ")
        : "Current build targets are unpacked dir/portable only; add NSIS/MSI for a real installer."
    );
    if (hasInstallerTarget) {
      const installerPath = path.join(workspace, "dist", installerName);
      const installerPresent = await pathExists(installerPath);
      const installerMtime = installerPresent ? await newestMtimeMs(installerPath) : 0;
      const sourceMtimes = await Promise.all(
        [
          "electron-main.mjs",
          "electron-preload.cjs",
          "server.mjs",
          "public",
          "README.md",
          "USER_MANUAL.md",
          "package.json"
        ].map((entry) => newestMtimeMs(path.join(workspace, entry)))
      );
      const newestSource = Math.max(...sourceMtimes);
      warnCheck(
        checks,
        installerPresent && installerMtime + 1000 >= newestSource,
        "release-installer-artifact",
        "Setup installer artifact is current",
        installerPresent
          ? installerMtime + 1000 >= newestSource
            ? `${installerPath} is current.`
            : `Installer is older than packaged sources; run npm run package:installer. Installer ${new Date(
                installerMtime
              ).toISOString()}, source ${new Date(newestSource).toISOString()}.`
          : `Missing ${installerPath}; run npm run package:installer.`
      );
    }
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const [mainText, preloadText] = await Promise.all([
      fs.readFile(path.join(workspace, "electron-main.mjs"), "utf8").catch(() => ""),
      fs.readFile(path.join(workspace, "electron-preload.cjs"), "utf8").catch(() => "")
    ]);
    const updaterRuntime =
      Boolean(deps["electron-updater"]) &&
      mainText.includes("electron-updater") &&
      mainText.includes("explore-better:check-for-updates") &&
      preloadText.includes("checkForUpdates");
    requireCheck(
      checks,
      updaterRuntime,
      "release-auto-update-runtime",
      "Auto-update runtime bridge",
      updaterRuntime ? "electron-updater dependency and desktop update bridge are present." : "Missing electron-updater dependency or desktop update bridge."
    );
    const updateFeedConfigured = Boolean(pkg.build?.publish || process.env.EXPLORE_BETTER_UPDATE_URL || process.env.EB_UPDATE_URL);
    const staticFeedPath = path.join(workspace, "dist", "update-feed", "latest.yml");
    const staticInstallerPath = path.join(workspace, "dist", "update-feed", installerName);
    const staticBlockmapPath = path.join(workspace, "dist", "update-feed", `${installerName}.blockmap`);
    const staticFeedPresent = await pathExists(staticFeedPath);
    const staticInstallerPresent = await pathExists(staticInstallerPath);
    const staticBlockmapPresent = await pathExists(staticBlockmapPath);
    const staticFeedText = staticFeedPresent ? await fs.readFile(staticFeedPath, "utf8").catch(() => "") : "";
    const staticFeedOk =
      staticFeedPresent &&
      staticInstallerPresent &&
      staticBlockmapPresent &&
      staticFeedText.includes(`version: ${pkg.version}`) &&
      staticFeedText.includes(`path: ${installerName}`) &&
      staticFeedText.includes("sha512:");
    warnCheck(
      checks,
      staticFeedOk,
      "release-static-update-feed",
      "Static update feed artifact",
      staticFeedOk
        ? `${staticFeedPath} references ${installerName}.`
        : "Missing or stale dist\\update-feed\\latest.yml; run npm run build:update-feed after packaging."
    );
    warnCheck(
      checks,
      updateFeedConfigured,
      "release-auto-update-feed",
      "Auto-update feed configured",
      updateFeedConfigured
        ? "Publish config or update feed environment variable found."
        : "Updater runtime and static feed artifacts are present, but production still needs a hosted publish config or EXPLORE_BETTER_UPDATE_URL feed."
    );
    const releaseFeedDesktopPath = path.join(artifactsDir, "release-update-feed-desktop-latest.json");
    let releaseFeedDesktopOk = false;
    let releaseFeedDesktopDetail =
      "Missing artifacts\\release-update-feed-desktop-latest.json; run npm run verify:release-update-feed-desktop after packaging.";
    try {
      const releaseFeedDesktopReport = await readJsonFile(releaseFeedDesktopPath);
      releaseFeedDesktopOk =
        releaseFeedDesktopReport.status === "pass" &&
        releaseFeedDesktopReport.updateCheck?.event === "not-available" &&
        releaseFeedDesktopReport.updateCheck?.version === pkg.version &&
        (releaseFeedDesktopReport.feed?.requests || []).some((request) => request.path === "/latest.yml");
      releaseFeedDesktopDetail = releaseFeedDesktopOk
        ? `Desktop updater consumed generated release feed and reported current version ${pkg.version}.`
        : "Generated release-feed desktop smoke is missing, stale, or did not report not-available for the current version.";
    } catch {
      releaseFeedDesktopOk = false;
    }
    warnCheck(
      checks,
      releaseFeedDesktopOk,
      "release-update-feed-desktop-smoke",
      "Generated update feed desktop smoke",
      releaseFeedDesktopDetail
    );
    return pkg;
  } catch (error) {
    addCheck(checks, "fail", "pkg-readable", "package.json readable", error.message);
    return null;
  }
}

async function verifyPackageArtifact(checks) {
  const executable = process.platform === "win32" ? "Explore Better.exe" : "Explore Better";
  const packagedApp = path.join(workspace, "dist", "win-unpacked", executable);
  const present = await pathExists(packagedApp);
  warnCheck(
    checks,
    present,
    "release-packaged-artifact",
    "Unpacked desktop artifact present",
    present ? packagedApp : `Missing ${packagedApp}; run npm run package:dir before install/release testing.`,
    { path: packagedApp }
  );
  if (present) {
    const sourceMtimes = await Promise.all(
      [
        "electron-main.mjs",
        "electron-preload.cjs",
        "server.mjs",
        "public",
        "README.md",
        "USER_MANUAL.md",
        "package.json"
      ].map((entry) => newestMtimeMs(path.join(workspace, entry)))
    );
    const newestSource = Math.max(...sourceMtimes);
    const artifactMtime = await newestMtimeMs(packagedApp);
    warnCheck(
      checks,
      artifactMtime + 1000 >= newestSource,
      "release-packaged-freshness",
      "Unpacked desktop artifact is current",
      artifactMtime + 1000 >= newestSource
        ? `Artifact mtime ${new Date(artifactMtime).toISOString()} covers packaged sources.`
        : `Artifact is older than packaged sources; run npm run package:dir. Artifact ${new Date(
            artifactMtime
          ).toISOString()}, source ${new Date(newestSource).toISOString()}.`
    );
  }
  return packagedApp;
}

async function verifyGeneratedFileContent(checks, files) {
  const contentChecks = [
    {
      path: files.scriptPath,
      id: "kit-launcher-content",
      label: "Generated launcher targets shell opens",
      includes: ["$ShellOpenMode", "Start-ExploreBetterServer", "Start-NativeWindow"]
    },
    {
      path: files.contextMenuRegPath,
      id: "kit-context-reg-content",
      label: "Context-menu registry content",
      includes: ["Open in Explore Better", "Directory\\shell\\ExploreBetter", "Drive\\shell\\ExploreBetter"]
    },
    {
      path: files.folderDefaultRegPath,
      id: "kit-default-reg-content",
      label: "Default-folder registry content",
      includes: ["Directory\\shell", "Drive\\shell", "ExploreBetter"]
    },
    {
      path: files.folderDefaultRemoveRegPath,
      id: "kit-default-remove-content",
      label: "Default-folder removal content",
      includes: ["Directory\\shell", "Drive\\shell", "@=-"]
    }
  ];
  for (const check of contentChecks) {
    try {
      const text = await fs.readFile(check.path, "utf8");
      const missing = check.includes.filter((needle) => !text.includes(needle));
      requireCheck(
        checks,
        missing.length === 0,
        check.id,
        check.label,
        missing.length ? `Missing ${missing.join(", ")} in ${check.path}` : check.path
      );
    } catch (error) {
      addCheck(checks, "fail", check.id, check.label, error.message);
    }
  }
}

async function verifyIntegrationKit(checks, baseUrl) {
  const generated = await requestJson(baseUrl, "/api/integration/generate", { method: "POST" });
  const generatedFiles = {
    scriptPath: generated.scriptPath,
    serverScriptPath: generated.serverScriptPath,
    shortcutScriptPath: generated.shortcutScriptPath,
    shortcutRemoveScriptPath: generated.shortcutRemoveScriptPath,
    winEHotkeyPath: generated.winEHotkeyPath,
    winEInstallScriptPath: generated.winEInstallScriptPath,
    winERemoveScriptPath: generated.winERemoveScriptPath,
    contextMenuRegPath: generated.contextMenuRegPath,
    contextMenuRemoveRegPath: generated.contextMenuRemoveRegPath,
    folderDefaultRegPath: generated.folderDefaultRegPath,
    folderDefaultRemoveRegPath: generated.folderDefaultRemoveRegPath
  };
  const missingGenerated = [];
  for (const [key, filePath] of Object.entries(generatedFiles)) {
    if (!filePath || !(await pathExists(filePath))) missingGenerated.push(key);
  }
  const readmePath = path.join(generated.integrationRoot || path.dirname(generated.scriptPath || stateDir), "README.txt");
  const readmePresent = await pathExists(readmePath);
  requireCheck(
    checks,
    missingGenerated.length === 0 && readmePresent,
    "kit-generated-files",
    "Generated integration kit files",
    missingGenerated.length
      ? `Missing ${missingGenerated.join(", ")}`
      : `Generated ${Object.keys(generatedFiles).length} files plus README at ${generated.integrationRoot}`,
    { integrationRoot: generated.integrationRoot }
  );
  await verifyGeneratedFileContent(checks, generatedFiles);

  const statusBeforeBackup = await requestJson(baseUrl, "/api/integration/status");
  const requiredStatusFiles = [
    "launcher",
    "server",
    "nativeMain",
    "nativeLauncher",
    "shortcuts",
    "shortcutRemove",
    "winEHotkey",
    "winEInstall",
    "winERemove",
    "contextMenuReg",
    "contextMenuRemoveReg",
    "folderDefaultReg",
    "folderDefaultRemoveReg"
  ];
  const missingStatusFiles = requiredStatusFiles.filter((key) => !statusBeforeBackup.files?.[key]);
  requireCheck(
    checks,
    missingStatusFiles.length === 0,
    "kit-status-files",
    "Integration status sees generated assets",
    missingStatusFiles.length ? `Missing status flags: ${missingStatusFiles.join(", ")}` : "All expected file flags are ready."
  );
  requireCheck(
    checks,
    ["ready", "warn"].includes(statusBeforeBackup.preflight?.state),
    "kit-preflight-not-blocked",
    "Shell preflight is not blocked",
    `${statusBeforeBackup.preflight?.state || "missing"}: ${statusBeforeBackup.preflight?.summary || ""}`
  );
  const stepIds = new Set((statusBeforeBackup.replacement?.steps || []).map((step) => step.id));
  const requiredSteps = ["kit", "native", "backup", "installed", "packaged", "shortcuts", "context", "default", "winE"];
  const missingSteps = requiredSteps.filter((id) => !stepIds.has(id));
  requireCheck(
    checks,
    missingSteps.length === 0,
    "kit-replacement-steps",
    "Replacement readiness steps",
    missingSteps.length ? `Missing ${missingSteps.join(", ")}` : `${statusBeforeBackup.replacement?.ready}/${statusBeforeBackup.replacement?.total} ready`
  );
  warnCheck(
    checks,
    ["installed", "packaged"].includes(statusBeforeBackup.handler?.kind),
    "kit-stable-shell-target",
    "Stable native shell target",
    ["installed", "packaged"].includes(statusBeforeBackup.handler?.kind)
      ? `${statusBeforeBackup.handler.kind}: ${statusBeforeBackup.handler.target}`
      : `${statusBeforeBackup.handler?.kind || "unknown"}: ${statusBeforeBackup.handler?.target || statusBeforeBackup.handler?.command || "missing"}`
  );

  const backup = await requestJson(baseUrl, "/api/integration/backup", {
    method: "POST",
    body: JSON.stringify({ mode: "release-readiness" })
  });
  const restorePath = backup.backup?.restoreRegPath || backup.status?.registry?.shellBackup?.restoreRegPath;
  requireCheck(
    checks,
    Boolean(backup.ok && restorePath && (await pathExists(restorePath))),
    "kit-shell-backup",
    "Shell backup restore file",
    restorePath || "missing"
  );
  requireCheck(
    checks,
    backup.status?.registry?.shellBackup?.available === true,
    "kit-shell-backup-status",
    "Shell backup visible in status",
    backup.status?.registry?.shellBackup?.available ? backup.status.registry.shellBackup.id : "missing"
  );

  return { generated, statusBeforeBackup, backup };
}

async function verifyDesktopSmoke(checks) {
  if (skipDesktopSmoke()) {
    addCheck(
      checks,
      "warn",
      "desktop-smoke-window",
      "Electron desktop bridge smoke",
      "Skipped by --skip-desktop-smoke or EB_RELEASE_SKIP_DESKTOP_SMOKE=1."
    );
    return null;
  }
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args =
    process.platform === "win32" ? ["/d", "/s", "/c", "npm run desktop:smoke-window"] : ["run", "desktop:smoke-window"];
  let result = null;
  let attempts = 0;
  for (; attempts < 4; attempts += 1) {
    const port = await freeLoopbackPort();
    result = await runCommand(command, args, {
      timeoutMs: 90000,
      env: {
        HOST: "127.0.0.1",
        PORT: String(port),
        LOCALAPPDATA: appData,
        APPDATA: appData,
        EXPLORE_BETTER_USER_DATA_DIR: path.join(appData, "ElectronUserData")
      }
    });
    if (!isRetryableDesktopBindFailure(result)) break;
  }
  const ok = result.code === 0 && !result.timedOut && !result.error;
  requireCheck(
    checks,
    ok,
    "desktop-smoke-window",
    "Electron desktop bridge smoke",
    ok
      ? `desktop:smoke-window exited cleanly after ${attempts + 1} attempt(s).`
      : result.timedOut
        ? "desktop:smoke-window timed out."
        : result.error || `Exit ${result.code}: ${result.stderr || result.stdout}`
  );
  return result;
}

function tableValue(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function markdownReport(report) {
  const counts = report.summary;
  const lines = [
    "# Explore Better Release Readiness",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Summary: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail.`,
    "",
    "| Status | Check | Detail |",
    "| --- | --- | --- |"
  ];
  for (const check of report.checks) {
    lines.push(`| ${check.status.toUpperCase()} | ${tableValue(check.label)} | ${tableValue(check.detail)} |`);
  }
  const warnings = report.checks.filter((check) => check.status === "warn");
  if (warnings.length) {
    lines.push("", "## Remaining Production Gaps", "");
    for (const warning of warnings) {
      lines.push(`- ${warning.label}: ${warning.detail}`);
    }
  }
  const failures = report.checks.filter((check) => check.status === "fail");
  if (failures.length) {
    lines.push("", "## Failures", "");
    for (const failure of failures) {
      lines.push(`- ${failure.label}: ${failure.detail}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const checks = [];
  await fs.mkdir(artifactsDir, { recursive: true });
  await seedReleaseState();
  await readPackageJson(checks);
  const packagedApp = await verifyPackageArtifact(checks);
  const configuredPort = optionValue("--port", process.env.PORT || "");
  const port = configuredPort ? Number(configuredPort) : await freeLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port);
  let integration = null;
  let desktopSmoke = null;
  try {
    await waitForServer(baseUrl, server);
    integration = await verifyIntegrationKit(checks, baseUrl);
  } catch (error) {
    addCheck(checks, "fail", "integration-server", "Integration readiness API", error.stack || error.message);
  } finally {
    await stopServer(server);
  }
  desktopSmoke = await verifyDesktopSmoke(checks);
  const summary = statusCounts(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    runRoot,
    appData,
    packageArtifact: packagedApp,
    summary,
    checks,
    integration,
    desktopSmoke: desktopSmoke
      ? {
          code: desktopSmoke.code,
          timedOut: desktopSmoke.timedOut || false,
          error: desktopSmoke.error || null,
          stdout: desktopSmoke.stdout,
          stderr: desktopSmoke.stderr
        }
      : null
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  if (!keepFixture()) {
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`release readiness: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  const warnings = checks.filter((check) => check.status === "warn");
  if (warnings.length) {
    console.log(`warnings: ${warnings.map((check) => check.id).join(", ")}`);
  }
  if (summary.fail > 0) {
    const failures = checks.filter((check) => check.status === "fail");
    console.error(`failures: ${failures.map((check) => `${check.id}: ${check.detail}`).join("; ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (serverOutput) {
    console.error(serverOutput);
  }
  process.exitCode = 1;
});
