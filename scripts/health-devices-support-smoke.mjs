import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl");
const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(root, "artifacts", `health-devices-${stamp}`);
const appData = path.join(runRoot, "appdata");
const fixture = path.join(runRoot, "Private Folder");
const secretContent = "SUPPORT_BUNDLE_MUST_NOT_INCLUDE_THIS_FILE_CONTENT";
const port = Number(process.env.PORT || 54_000 + Math.floor(Math.random() * 5_000));
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer(child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (child.exitCode !== null) throw new Error(`Health test server exited with ${child.exitCode}.`);
    try {
      if ((await fetch(`${baseUrl}/api/health/report?probe=0`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Health test server did not become ready.");
}

async function json(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

function readZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zip) => {
      if (openError) return reject(openError);
      const entries = new Map();
      zip.on("error", reject);
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(entries));
      zip.readEntry();
    });
  });
}

async function supportBundle(includePaths) {
  const response = await fetch(`${baseUrl}/api/health/support-bundle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ includePaths })
  });
  assert(response.ok && response.headers.get("content-type") === "application/zip", `Support bundle failed: ${response.status}.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  assert(buffer.length <= 10 * 1024 * 1024, `Support bundle exceeded 10 MB: ${buffer.length}.`);
  return { buffer, entries: await readZip(buffer) };
}

await fs.mkdir(fixture, { recursive: true });
await fs.mkdir(appData, { recursive: true });
await fs.writeFile(path.join(fixture, "private-name.txt"), secretContent, "utf8");
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData, EXPLORE_BETTER_WORKSPACE_ROOT: fixture },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let output = "";
server.stdout.on("data", (chunk) => { output += chunk; });
server.stderr.on("data", (chunk) => { output += chunk; });

try {
  await waitForServer(server);
  const devicesStartedAt = performance.now();
  const devices = await json("/api/windows/devices?refresh=0&includeNetwork=0");
  const devicesMs = performance.now() - devicesStartedAt;
  assert(["ready", "partial", "unavailable"].includes(devices.status), "Devices endpoint returned an invalid status.");
  assert(devices.networkLoaded === false && devices.groups && devices.counts, "Default Devices loading probed Network or omitted normalized groups.");
  assert(Object.values(devices.groups).flat().every((item) => item.id && item.name && item.kind && item.capabilities && ["browseInApp", "browseShell", "openInExplorer"].every((key) => typeof item.capabilities[key] === "boolean")), "Device items do not expose stable normalized capabilities.");

  await json("/api/health/renderer-scheduler", {
    method: "POST",
    body: JSON.stringify({ capturedAt: new Date().toISOString(), activeForegroundLeases: 1, queuedPrefetches: 2, activePrefetches: 1, paused: true, aborts: 3, cacheHits: 4, resumptions: 5, started: 6, foregroundStarts: 7 })
  });
  const health = await json("/api/health/report?probe=0");
  assert(["healthy", "attention", "error"].includes(health.overall) && health.schemaVersion === "1", "Health report has an invalid envelope.");
  assert(["backend", "renderer", "nativeHelper", "mcpBridge", "shellProvider", "cache", "index", "operationQueue", "updateConfiguration", "package"].every((id) => health.components.some((item) => item.id === id)), "Health report omitted a required component.");
  assert(health.scheduler?.renderer?.queuedPrefetches === 2 && health.scheduler.renderer.aborts === 3, "Health report omitted renderer scheduler counters.");
  const probed = await json("/api/health/report?probe=1");
  assert(probed.probe === true && Number.isFinite(probed.durationMs), "Active health probes did not return partial-safe timing.");

  const redacted = await supportBundle(false);
  for (const required of ["manifest.json", "summary.md", "health.json", "runtime-settings.json", "operations.json", "mcp-audit.json", "performance.json"]) {
    assert(redacted.entries.has(required), `Support bundle is missing ${required}.`);
  }
  const redactedText = [...redacted.entries.values()].map((value) => value.toString("utf8")).join("\n");
  const manifest = JSON.parse(redacted.entries.get("manifest.json").toString("utf8"));
  assert(manifest.includeLocalPaths === false && manifest.maximumBytes === 10 * 1024 * 1024, "Support manifest did not record redaction and size policy.");
  assert(!redactedText.includes(fixture) && !redactedText.includes("private-name.txt") && !redactedText.includes(secretContent), "Default support bundle leaked a path, filename, or file content.");
  assert(manifest.exclusions.includes("terminal output") && manifest.exclusions.includes("credentials"), "Support manifest omitted permanent exclusion categories.");

  const optedIn = await supportBundle(true);
  const optedManifest = JSON.parse(optedIn.entries.get("manifest.json").toString("utf8"));
  assert(optedManifest.includeLocalPaths === true, "Explicit path opt-in was not recorded in the support manifest.");

  console.log(`Health/devices/support smoke passed: devices ${devices.status} in ${devicesMs.toFixed(1)} ms, ${health.components.length} health components, redacted ZIP ${redacted.buffer.length} bytes.`);
} finally {
  if (server.exitCode === null) server.kill();
  await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 1500);
    server.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  if (server.exitCode && output) process.stderr.write(output);
  await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
}
