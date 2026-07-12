import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const latestJsonPath = path.join(artifactsDir, "shell-devices-latest.json");
const latestMdPath = path.join(artifactsDir, "shell-devices-latest.md");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `shell-devices-${stamp}`);
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_SHELL_DEVICES_KEEP_FIXTURE === "1";
}

function requireDevice() {
  return process.argv.includes("--require-device") || process.env.EB_SHELL_DEVICES_REQUIRE_DEVICE === "1";
}

function deviceQuery() {
  return optionValue("--device-query", process.env.EB_SHELL_DEVICE_QUERY || "").trim().toLowerCase();
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
  while (Date.now() - started < 10000) {
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

async function readNamespace(baseUrl, target, limit = 200) {
  const params = new URLSearchParams({ target, limit: String(limit) });
  const started = performance.now();
  const report = await requestJson(baseUrl, `/api/shell/namespace?${params}`);
  return { ...report, elapsedMs: Math.round(performance.now() - started) };
}

function deviceLike(item = {}) {
  const text = `${item.name || ""} ${item.type || ""} ${item.kind || ""} ${item.path || ""}`.toLowerCase();
  return Boolean(
    item.isPortableDevice ||
      item.kind === "portable-device" ||
      (item.isShellDevice && /device|phone|camera|tablet|mtp|ptp|android|iphone|ipad|portable|storage/.test(text))
  );
}

function queryMatches(item = {}, query = "") {
  if (!query) return true;
  const text = `${item.name || ""} ${item.type || ""} ${item.kind || ""} ${item.path || ""} ${item.parsingPath || ""}`.toLowerCase();
  return text.includes(query);
}

function isSimulatedDevice(item = {}) {
  const target = String(item.path || item.openTarget || item.parsingPath || "");
  return item.source === "ExploreBetter.DeviceSimulation" || target.startsWith("::ExploreBetterSimulatedPortableDevice");
}

function summarizeItem(item = {}) {
  return {
    name: item.name,
    path: item.path,
    parsingPath: item.parsingPath,
    type: item.type,
    kind: item.kind,
    isFolder: item.isFolder,
    isFileSystem: item.isFileSystem,
    isPortableDevice: item.isPortableDevice,
    isShellDevice: item.isShellDevice,
    shellOnly: item.shellOnly,
    canBrowse: item.canBrowse,
    canBrowseShell: item.canBrowseShell,
    canOpen: item.canOpen,
    canOpenPane: item.canOpenPane,
    openTarget: item.openTarget,
    source: item.source
  };
}

function tableValue(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function attachmentGuide(output = {}) {
  return {
    required: output.requireDevice === true,
    deviceQuery: output.deviceQuery || "",
    hardwareSnapshot: output.hardwareSnapshot
      ? {
          available: output.hardwareSnapshot.available === true,
          count: output.hardwareSnapshot.count || 0,
          elapsedMs: output.hardwareSnapshot.elapsedMs ?? null
        }
      : null,
    instructions: [
      "Attach an unlocked phone, camera, or MTP/PTP device to Windows.",
      "Allow file-transfer access on the device if Windows prompts for it.",
      "Confirm the device appears under This PC in Explorer.",
      "Run npm run verify:shell-devices -- --require-device.",
      "Optionally add --device-query=\"Pixel\" or EB_SHELL_DEVICE_QUERY=Pixel to target a specific attached device."
    ],
    strictCommand: "npm run verify:shell-devices -- --require-device",
    targetedCommand: "npm run verify:shell-devices -- --require-device --device-query=\"DEVICE NAME\""
  };
}

function parseJsonObject(text) {
  const trimmed = String(text || "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON object found in PowerShell output: ${trimmed.slice(0, 300)}`);
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

async function runPowerShellJson(script, timeoutMs = 6500) {
  const powershellPath = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
  return await new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(powershellPath, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      child.kill();
      resolve({
        ok: false,
        timedOut: true,
        elapsedMs: Math.round(performance.now() - started),
        stdout,
        stderr
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        error: error.message,
        elapsedMs: Math.round(performance.now() - started),
        stdout,
        stderr
      });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      let data = null;
      let parseError = "";
      try {
        data = parseJsonObject(stdout);
      } catch (error) {
        parseError = error.message;
      }
      resolve({
        ok: code === 0 && Boolean(data),
        code,
        data,
        parseError,
        elapsedMs: Math.round(performance.now() - started),
        stdout,
        stderr
      });
    });
  });
}

async function readWindowsHardwareSnapshot() {
  if (process.platform !== "win32") {
    return {
      available: false,
      skipped: true,
      reason: "non-windows",
      count: 0,
      elapsedMs: 0,
      sample: []
    };
  }
  const script = `
$ErrorActionPreference = "Stop"
try {
  $patterns = "(^|[^a-z0-9])(phone|camera|mtp|ptp|android|iphone|ipad|portable|wpd)([^a-z0-9]|$)"
  $classes = @("WPD", "Image", "Camera", "PortableDevice")
  $props = @(
    @{Name="name"; Expression={$_.Name}},
    @{Name="class"; Expression={$_.PNPClass}},
    @{Name="status"; Expression={$_.Status}},
    @{Name="manufacturer"; Expression={$_.Manufacturer}},
    @{Name="deviceId"; Expression={$_.DeviceID}}
  )
  $devices = @(Get-CimInstance Win32_PnPEntity | Where-Object {
    $text = "$($_.Name) $($_.Description) $($_.DeviceID)"
    ($classes -contains $_.PNPClass) -or
    ($text -match $patterns) -or
    ($_.DeviceID -match "(^|\\\\)(WPD|MTP|PTP)(\\\\|$)")
  } | Select-Object -First 80 -Property $props)
  [pscustomobject]@{
    available = $true
    source = "Get-CimInstance Win32_PnPEntity"
    count = $devices.Count
    devices = $devices
  } | ConvertTo-Json -Depth 5 -Compress
} catch {
  [pscustomobject]@{
    available = $false
    source = "Get-CimInstance Win32_PnPEntity"
    count = 0
    devices = @()
    error = $_.Exception.Message
  } | ConvertTo-Json -Depth 5 -Compress
}
`;
  const result = await runPowerShellJson(script);
  const data = result.data || {};
  const devices = Array.isArray(data.devices) ? data.devices : data.devices ? [data.devices] : [];
  return {
    available: result.ok && data.available === true,
    source: data.source || "Get-CimInstance Win32_PnPEntity",
    count: Number(data.count ?? devices.length ?? 0),
    elapsedMs: result.elapsedMs,
    timedOut: result.timedOut === true,
    error: data.error || result.error || result.parseError || result.stderr?.trim() || null,
    sample: devices.slice(0, 24).map((item) => ({
      name: item.name || "",
      class: item.class || "",
      status: item.status || "",
      manufacturer: item.manufacturer || "",
      deviceId: item.deviceId || ""
    }))
  };
}

function markdownReport(output = {}) {
  const lines = [
    "# Shell Devices Smoke",
    "",
    `Generated: ${output.generatedAt}`,
    `Status: ${output.status}`,
    `Platform: ${output.platform}`,
    `Summary: ${output.summary?.pass || 0} pass, ${output.summary?.warn || 0} warn, ${output.summary?.fail || 0} fail.`,
    "",
    "| Status | Check | Detail |",
    "| --- | --- | --- |"
  ];
  for (const check of output.checks || []) {
    lines.push(`| ${check.status.toUpperCase()} | ${tableValue(check.label)} | ${tableValue(check.detail)} |`);
  }
  lines.push(
    "",
    "## This PC",
    "",
    `Available: ${output.thisPc?.available}`,
    `Items: ${output.thisPc?.count}`,
    `Cold elapsed: ${output.thisPc?.elapsedMs} ms`,
    `Warm elapsed: ${output.thisPc?.warmElapsedMs} ms`,
    `Warm cached: ${output.thisPc?.warmCached}`,
    ""
  );
  if (output.hardwareSnapshot) {
    lines.push(
      "## Windows Hardware Snapshot",
      "",
      `Available: ${output.hardwareSnapshot.available}`,
      `Source: ${output.hardwareSnapshot.source || ""}`,
      `Portable candidates: ${output.hardwareSnapshot.count || 0}`,
      `Elapsed: ${output.hardwareSnapshot.elapsedMs ?? "n/a"} ms`,
      output.hardwareSnapshot.error ? `Error: ${output.hardwareSnapshot.error}` : "",
      ""
    );
    for (const item of output.hardwareSnapshot.sample || []) {
      lines.push(`- ${item.name || "(unnamed)"} | ${item.class || ""} | ${item.status || ""} | ${item.manufacturer || ""}`);
    }
    lines.push("");
  }
  if (output.devices?.count) {
    lines.push("## Physical Devices", "");
    for (const item of output.devices.sample || []) {
      lines.push(`- ${item.name || "(unnamed)"} | ${item.kind || ""} | ${item.type || ""} | pane=${item.canOpenPane}`);
    }
  } else {
    lines.push("## Device Attachment Needed", "");
    for (const step of output.attachmentGuide?.instructions || []) {
      lines.push(`- ${step}`);
    }
  }
  if (output.simulatedDevices?.count) {
    lines.push("", "## Simulated Device Safety", "");
    for (const item of output.simulatedDevices.sample || []) {
      lines.push(`- ${item.name || "(unnamed)"} | ${item.kind || ""} | ${item.type || ""} | pane=${item.canOpenPane}`);
    }
  }
  if (output.probe) {
    lines.push("", "## Physical Probe", "");
    lines.push(`Target: ${output.probe.target || ""}`);
    lines.push(`Dry-run open: ${output.probe.dryRunOpen ? "ok" : "skipped"}`);
    lines.push(`Browse: ${output.probe.browse ? `${output.probe.browse.available} / ${output.probe.browse.elapsedMs} ms` : "skipped"}`);
  }
  if (output.simulatedProbe) {
    lines.push("", "## Simulated Probe", "");
    lines.push(`Target: ${output.simulatedProbe.target || ""}`);
    lines.push(`Dry-run open: ${output.simulatedProbe.dryRunOpen ? "ok" : "skipped"}`);
    lines.push(`Browse: ${output.simulatedProbe.browse ? `${output.simulatedProbe.browse.available} / ${output.simulatedProbe.browse.elapsedMs} ms` : "skipped"}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function writeOutput(output) {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(latestJsonPath, JSON.stringify(output, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(output), "utf8");
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1500);
    server.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function main() {
  const checks = [];
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(artifactsDir, { recursive: true });
  const port = Number(optionValue("--port", process.env.PORT || 58500 + Math.floor(Math.random() * 3500)));
  const limit = Math.max(10, Math.min(Number(optionValue("--limit", process.env.EB_SHELL_DEVICES_LIMIT || 200)), 500));
  const query = deviceQuery();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      EB_SHELL_NAMESPACE_SIMULATE_DEVICES: "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  const output = {
    generatedAt: new Date().toISOString(),
    workspace,
    platform: process.platform,
    requireDevice: requireDevice(),
    deviceQuery: query,
    status: "fail",
    summary: { pass: 0, warn: 0, fail: 0 },
    checks,
    thisPc: null,
    hardwareSnapshot: null,
    invariants: {
      nonFilesystemNeverPaneOpen: false,
      portableDevicesMarkedShellDevices: false,
      filesystemTargetsRemainPaneOpenable: false
    },
    devices: {
      count: 0,
      sample: []
    },
    simulatedDevices: {
      count: 0,
      sample: []
    },
    classifications: {
      filesystemPaneTargets: 0,
      shellOnlyItems: 0,
      portableDeviceItems: 0,
      nonFilesystemItems: 0
    },
    probe: null,
    simulatedProbe: null,
    attachmentGuide: null
  };

  try {
    await waitForServer(baseUrl, server);
    output.hardwareSnapshot = await readWindowsHardwareSnapshot();
    (requireDevice() ? requireCheck : warnCheck)(
      checks,
      process.platform !== "win32" || output.hardwareSnapshot.available === true,
      "windows-hardware-snapshot",
      "Windows PnP hardware snapshot is captured without elevation",
      output.hardwareSnapshot.available === true
        ? `${output.hardwareSnapshot.count || 0} portable/camera candidate(s), ${output.hardwareSnapshot.elapsedMs} ms.`
        : output.hardwareSnapshot.reason || output.hardwareSnapshot.error || "snapshot unavailable",
      { hardwareSnapshot: output.hardwareSnapshot }
    );
    requireCheck(
      checks,
      process.platform !== "win32" || Number(output.hardwareSnapshot.elapsedMs || Infinity) < 6500,
      "windows-hardware-snapshot-bounded",
      "Windows PnP hardware snapshot is bounded",
      `${output.hardwareSnapshot.elapsedMs ?? "n/a"} ms.`
    );
    const locations = await requestJson(baseUrl, "/api/shell/locations");
    requireCheck(checks, locations.platform === process.platform, "shell-locations-platform", "Shell locations report current platform", locations.platform);
    requireCheck(
      checks,
      !locations.windows || locations.virtualFolders?.some((item) => item.id === "thisPc"),
      "shell-locations-this-pc",
      "Shell locations include This PC",
      locations.virtualFolders?.map((item) => item.id).join(", ") || "none"
    );

    const thisPc = await readNamespace(baseUrl, "thisPc", limit);
    const warmThisPc = await readNamespace(baseUrl, "thisPc", limit);
    requireCheck(checks, Array.isArray(thisPc.items), "this-pc-structured", "This PC namespace returns structured items", `${thisPc.items?.length || 0} item(s).`);
    requireCheck(checks, thisPc.elapsedMs < 6500, "this-pc-bounded", "This PC namespace enumeration is bounded", `${thisPc.elapsedMs} ms.`);
    requireCheck(checks, warmThisPc.cached === true && warmThisPc.elapsedMs <= Math.max(100, thisPc.elapsedMs), "this-pc-warm-cache", "This PC namespace uses warm cache", `cold=${thisPc.elapsedMs} ms, warm=${warmThisPc.elapsedMs} ms, cached=${warmThisPc.cached === true}.`);

    output.thisPc = {
      available: thisPc.available,
      reason: thisPc.reason,
      target: thisPc.target,
      count: thisPc.items.length,
      total: thisPc.total,
      truncated: thisPc.truncated,
      elapsedMs: thisPc.elapsedMs,
      warmElapsedMs: warmThisPc.elapsedMs,
      warmCached: warmThisPc.cached === true,
      sample: thisPc.items.slice(0, 12).map(summarizeItem)
    };

    if (process.platform === "win32") {
      requireCheck(checks, thisPc.available === true, "this-pc-available", "Windows This PC namespace is available", thisPc.reason || "available");
      requireCheck(checks, thisPc.items.length > 0, "this-pc-nonempty", "This PC contains shell items", `${thisPc.items.length} item(s).`);
    } else {
      requireCheck(checks, thisPc.available === false, "this-pc-unavailable-nonwindows", "Non-Windows shell namespace reports unavailable", thisPc.reason || "available");
    }

    const nonFilesystem = [];
    const portable = [];
    const shellOnly = [];
    const filesystemPaneTargets = [];
    const badPaneTargets = [];
    const badPortableFlags = [];
    for (const item of thisPc.items) {
      if (!item.isFileSystem) nonFilesystem.push(item);
      if (item.shellOnly || item.isShellDevice) shellOnly.push(item);
      if (item.isFileSystem && item.canOpenPane) filesystemPaneTargets.push(item);
      if (!item.isFileSystem || item.shellOnly || item.isPortableDevice || item.isShellDevice) {
        if (item.canOpenPane) badPaneTargets.push(item);
      }
      if (item.isPortableDevice) {
        portable.push(item);
        if (!item.isShellDevice) badPortableFlags.push(item);
      }
    }
    output.classifications = {
      filesystemPaneTargets: filesystemPaneTargets.length,
      shellOnlyItems: shellOnly.length,
      portableDeviceItems: portable.length,
      nonFilesystemItems: nonFilesystem.length
    };
    output.invariants.nonFilesystemNeverPaneOpen = badPaneTargets.length === 0;
    output.invariants.portableDevicesMarkedShellDevices = badPortableFlags.length === 0;
    output.invariants.filesystemTargetsRemainPaneOpenable = process.platform !== "win32" || filesystemPaneTargets.length > 0;
    requireCheck(
      checks,
      badPaneTargets.length === 0,
      "nonfilesystem-never-pane-open",
      "Shell-only and non-filesystem items never open as normal pane folders",
      badPaneTargets.length ? badPaneTargets.map((item) => item.name || item.path).join(", ") : `${nonFilesystem.length + shellOnly.length} shell-only/non-filesystem item observation(s).`
    );
    requireCheck(
      checks,
      badPortableFlags.length === 0,
      "portable-marked-shell-device",
      "Portable devices are marked as shell devices",
      badPortableFlags.length ? badPortableFlags.map((item) => item.name || item.path).join(", ") : `${portable.length} portable device observation(s).`
    );
    warnCheck(
      checks,
      process.platform !== "win32" || filesystemPaneTargets.length > 0,
      "filesystem-pane-targets",
      "Filesystem shell items remain pane-openable",
      filesystemPaneTargets.length ? `${filesystemPaneTargets.length} pane-openable filesystem item(s).` : "No filesystem This PC targets were observed."
    );

    const allDevices = thisPc.items.filter(deviceLike);
    const simulatedDevices = allDevices.filter(isSimulatedDevice);
    const physicalCandidates = allDevices.filter((item) => !isSimulatedDevice(item));
    const devices = physicalCandidates.filter((item) => queryMatches(item, query));
    output.devices.count = devices.length;
    output.devices.totalCandidates = physicalCandidates.length;
    output.devices.sample = devices.slice(0, 12).map(summarizeItem);
    output.simulatedDevices.count = simulatedDevices.length;
    output.simulatedDevices.totalCandidates = allDevices.length;
    output.simulatedDevices.sample = simulatedDevices.slice(0, 12).map(summarizeItem);
    if (output.hardwareSnapshot) {
      output.hardwareSnapshot.shellDeviceCandidates = devices.length;
      output.hardwareSnapshot.shellTotalCandidates = physicalCandidates.length;
    }
    const simulatedFlagsOk = simulatedDevices.every((item) => item.isPortableDevice && item.isShellDevice && item.shellOnly && !item.isFileSystem);
    const simulatedPaneOk = simulatedDevices.every((item) => !item.canOpenPane);
    requireCheck(
      checks,
      simulatedDevices.length >= 1,
      "simulated-device-present",
      "Simulated portable shell device is present for deterministic safety proof",
      simulatedDevices.length ? `${simulatedDevices.length} simulated device candidate(s).` : "No simulated portable shell device was injected."
    );
    requireCheck(
      checks,
      simulatedPaneOk,
      "simulated-device-not-pane-openable",
      "Simulated portable shell devices never open as normal pane folders",
      simulatedPaneOk ? `${simulatedDevices.length} simulated item(s) blocked from pane open.` : simulatedDevices.filter((item) => item.canOpenPane).map((item) => item.name || item.path).join(", ")
    );
    requireCheck(
      checks,
      simulatedFlagsOk,
      "simulated-device-shell-marked",
      "Simulated portable shell devices are shell-only non-filesystem items",
      simulatedFlagsOk ? `${simulatedDevices.length} simulated item(s) correctly classified.` : "One or more simulated items missed portable/shell-only/non-filesystem flags."
    );
    const hasDevice = devices.length > 0;
    if (requireDevice()) {
      requireCheck(
        checks,
        hasDevice,
        "attached-portable-device",
        "Attached phone/MTP/camera shell device observed",
        hasDevice ? `${devices.length} matching device candidate(s).` : query ? `No matching device for query "${query}".` : "No phone/MTP/camera shell device was attached."
      );
    } else {
      warnCheck(
        checks,
        hasDevice,
        "attached-portable-device",
        "Attached phone/MTP/camera shell device observed",
        hasDevice ? `${devices.length} matching device candidate(s).` : "No physical phone/MTP/camera device was attached; rerun with --require-device when hardware is available."
      );
    }

    const probe = devices.find((item) => item.openTarget || item.path);
    if (probe) {
      const target = probe.openTarget || probe.path;
      output.probe = {
        item: summarizeItem(probe),
        target,
        dryRunOpen: null,
        browse: null
      };
      requireCheck(checks, !probe.canOpenPane, "device-not-pane-openable", "Shell device is not treated as a filesystem pane target", probe.name || target);
      if (probe.canOpen) {
        const dryRun = await requestJson(baseUrl, "/api/shell/namespace/open", {
          method: "POST",
          body: JSON.stringify({ target, dryRun: true })
        });
        const dryRunOk = dryRun.ok === true && dryRun.dryRun === true;
        requireCheck(checks, dryRunOk, "device-dry-run-open", "Shell device handoff dry-run validates", dryRunOk ? dryRun.target : JSON.stringify(dryRun));
        output.probe.dryRunOpen = {
          ok: dryRun.ok,
          dryRun: dryRun.dryRun,
          target: dryRun.target
        };
      } else {
        addCheck(checks, "warn", "device-dry-run-open", "Shell device handoff dry-run validates", "Probe device did not expose a shell open target.");
      }
      if (probe.canBrowse) {
        const browsed = await readNamespace(baseUrl, target, 60);
        const browseOk = Array.isArray(browsed.items) && browsed.elapsedMs < 6500;
        requireCheck(checks, browseOk, "device-browse-bounded", "Shell device browse returns bounded structured children", browseOk ? `${browsed.items.length} item(s), ${browsed.elapsedMs} ms.` : `${browsed.reason || "unavailable"}, ${browsed.elapsedMs} ms.`);
        output.probe.browse = {
          available: browsed.available,
          reason: browsed.reason,
          target: browsed.target,
          count: browsed.items.length,
          total: browsed.total,
          truncated: browsed.truncated,
          elapsedMs: browsed.elapsedMs,
          sample: browsed.items.slice(0, 8).map(summarizeItem)
        };
      } else {
        addCheck(checks, "warn", "device-browse-bounded", "Shell device browse returns bounded structured children", "Probe device was not browsable through Shell.Application.");
      }
    }

    const simulatedProbe = simulatedDevices.find((item) => item.openTarget || item.path);
    if (simulatedProbe) {
      const target = simulatedProbe.openTarget || simulatedProbe.path;
      output.simulatedProbe = {
        item: summarizeItem(simulatedProbe),
        target,
        dryRunOpen: null,
        browse: null
      };
      const dryRun = await requestJson(baseUrl, "/api/shell/namespace/open", {
        method: "POST",
        body: JSON.stringify({ target, dryRun: true })
      });
      const dryRunOk = dryRun.ok === true && dryRun.dryRun === true && dryRun.target === target;
      requireCheck(
        checks,
        dryRunOk,
        "simulated-device-dry-run-open",
        "Simulated shell device handoff dry-run validates",
        dryRunOk ? dryRun.target : JSON.stringify(dryRun)
      );
      output.simulatedProbe.dryRunOpen = {
        ok: dryRun.ok,
        dryRun: dryRun.dryRun,
        target: dryRun.target
      };
      const browsed = await readNamespace(baseUrl, target, 60);
      const childItems = Array.isArray(browsed.items) ? browsed.items : [];
      const childrenShellSafe = childItems.every((item) => !item.canOpenPane && item.isPortableDevice && item.isShellDevice && item.shellOnly && !item.isFileSystem);
      const browseOk = Array.isArray(browsed.items) && childItems.length >= 1 && browsed.elapsedMs < 6500 && childrenShellSafe;
      requireCheck(
        checks,
        browseOk,
        "simulated-device-browse-bounded",
        "Simulated shell device browse returns bounded shell-safe children",
        browseOk ? `${childItems.length} item(s), ${browsed.elapsedMs} ms.` : `${childItems.length} item(s), shellSafe=${childrenShellSafe}, elapsed=${browsed.elapsedMs} ms.`
      );
      output.simulatedProbe.browse = {
        available: browsed.available,
        reason: browsed.reason,
        target: browsed.target,
        count: childItems.length,
        total: browsed.total,
        truncated: browsed.truncated,
        elapsedMs: browsed.elapsedMs,
        shellSafe: childrenShellSafe,
        sample: childItems.slice(0, 8).map(summarizeItem)
      };
    }

    output.attachmentGuide = attachmentGuide(output);
    output.summary = statusCounts(checks);
    output.status = output.summary.fail > 0 ? "fail" : output.summary.warn > 0 ? "warn" : "pass";
    await writeOutput(output);
    console.log(`shell devices: ${output.summary.pass} pass, ${output.summary.warn} warn, ${output.summary.fail} fail`);
    console.log(`This PC items: ${output.thisPc.count}`);
    console.log(`physical portable/shell devices: ${output.devices.count}`);
    console.log(`simulated portable/shell devices: ${output.simulatedDevices.count}`);
    if (output.probe) console.log(`probed shell device: ${output.probe.item.name || output.probe.target}`);
    if (output.simulatedProbe) console.log(`probed simulated shell device: ${output.simulatedProbe.item.name || output.simulatedProbe.target}`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (output.summary.fail > 0) {
      const failures = checks.filter((check) => check.status === "fail");
      console.error(`failures: ${failures.map((check) => `${check.id}: ${check.detail}`).join("; ")}`);
      process.exitCode = 1;
    }
  } finally {
    await stopServer(server);
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch(async (error) => {
  const checks = [
    {
      status: "fail",
      id: "shell-devices-error",
      label: "Shell devices verifier crashed",
      detail: error.stack || error.message
    }
  ];
  const summary = statusCounts(checks);
  const output = {
    generatedAt: new Date().toISOString(),
    workspace,
    platform: process.platform,
    status: "fail",
    summary,
    checks,
    thisPc: null,
    hardwareSnapshot: null,
    invariants: {
      nonFilesystemNeverPaneOpen: false,
      portableDevicesMarkedShellDevices: false,
      filesystemTargetsRemainPaneOpenable: false
    },
    devices: { count: 0, sample: [] },
    simulatedDevices: { count: 0, sample: [] },
    classifications: {},
    probe: null,
    simulatedProbe: null,
    attachmentGuide: attachmentGuide({ requireDevice: requireDevice(), deviceQuery: deviceQuery() }),
    serverOutput
  };
  await writeOutput(output).catch(() => {});
  console.error(error.stack || error.message);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
});
