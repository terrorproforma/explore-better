import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `cache-maintenance-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const indexRoot = path.join(stateDir, "Index");
const dimensionsRoot = path.join(stateDir, "MetadataCache", "Dimensions");
const latestJsonPath = path.join(artifactsDir, "cache-maintenance-latest.json");
const latestMdPath = path.join(artifactsDir, "cache-maintenance-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_CACHE_MAINTENANCE_KEEP_FIXTURE === "1";
}

function pathIdentity(itemPath) {
  const resolved = path.resolve(itemPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function cacheIdForPath(targetPath) {
  return crypto.createHash("sha256").update(pathIdentity(targetPath)).digest("hex").slice(0, 32);
}

function folderIndexFile(folderPath) {
  return path.join(indexRoot, `${cacheIdForPath(folderPath)}.json`);
}

function dimensionsCacheFile(folderPath) {
  return path.join(dimensionsRoot, `${cacheIdForPath(folderPath)}.json`);
}

function backgroundManifestFile(rootId) {
  return path.join(indexRoot, `background-${rootId}.json`);
}

function backgroundSearchFile(rootId) {
  return path.join(indexRoot, `background-${rootId}-search.json`);
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
  if (!ok) {
    throw new Error(`${id}: ${detail}`);
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function folderIndexPayload(folderPath, entries = []) {
  return {
    version: 1,
    id: cacheIdForPath(folderPath),
    path: folderPath,
    pathKey: pathIdentity(folderPath),
    builtAt: new Date().toISOString(),
    count: entries.length,
    entries
  };
}

function metadataPayload(folderPath, entries = {}) {
  return {
    version: 1,
    path: folderPath,
    pathKey: pathIdentity(folderPath),
    updatedAt: new Date().toISOString(),
    entries
  };
}

function backgroundPayload(rootPath, extra = {}) {
  return {
    version: 1,
    rootPath,
    path: rootPath,
    builtAt: new Date().toISOString(),
    count: 1,
    entries: [],
    ...extra
  };
}

async function prepareFixture() {
  const activeRoot = path.join(fixtureRoot, "active-root");
  const freshFolder = path.join(fixtureRoot, "fresh-folder");
  const staleFolder = path.join(fixtureRoot, "missing-folder");
  const staleMetadataFolder = path.join(fixtureRoot, "missing-metadata-folder");
  await fs.mkdir(activeRoot, { recursive: true });
  await fs.mkdir(freshFolder, { recursive: true });
  await fs.mkdir(indexRoot, { recursive: true });
  await fs.mkdir(dimensionsRoot, { recursive: true });
  await fs.writeFile(path.join(activeRoot, "active.txt"), "active background root\n", "utf8");
  await fs.writeFile(path.join(freshFolder, "fresh.png"), "not a real png but good enough for cache maintenance\n", "utf8");

  const activeRootId = "bg-active-maintenance";
  const orphanRootId = "bg-orphan-maintenance";
  await writeJson(statePath, {
    version: 1,
    updatedAt: new Date().toISOString(),
    backgroundIndexes: [
      {
        id: activeRootId,
        name: "Active Maintenance Root",
        path: activeRoot,
        enabled: true,
        autoRebuild: true,
        watch: false,
        recursive: true
      }
    ],
    operations: []
  });

  const files = {
    activeManifest: backgroundManifestFile(activeRootId),
    activeSearch: backgroundSearchFile(activeRootId),
    orphanManifest: backgroundManifestFile(orphanRootId),
    orphanSearch: backgroundSearchFile(orphanRootId),
    staleFolderIndex: folderIndexFile(staleFolder),
    staleMetadata: dimensionsCacheFile(staleMetadataFolder),
    freshFolderIndex: folderIndexFile(freshFolder),
    freshMetadata: dimensionsCacheFile(freshFolder),
    corruptIndex: path.join(indexRoot, "corrupt-cache.json"),
    quarantinedIndex: path.join(indexRoot, "old-folder.json.corrupt-seed")
  };

  await writeJson(files.activeManifest, backgroundPayload(activeRoot, { rootId: activeRootId }));
  await writeJson(files.activeSearch, backgroundPayload(activeRoot, { rootId: activeRootId, entries: [{ name: "active.txt", path: path.join(activeRoot, "active.txt") }] }));
  await writeJson(files.orphanManifest, backgroundPayload(path.join(fixtureRoot, "orphan-root"), { rootId: orphanRootId }));
  await writeJson(files.orphanSearch, backgroundPayload(path.join(fixtureRoot, "orphan-root"), { rootId: orphanRootId }));
  await writeJson(files.staleFolderIndex, folderIndexPayload(staleFolder));
  await writeJson(files.staleMetadata, metadataPayload(staleMetadataFolder));
  await writeJson(files.freshFolderIndex, folderIndexPayload(freshFolder, [{ name: "fresh.png", path: path.join(freshFolder, "fresh.png") }]));
  await writeJson(files.freshMetadata, metadataPayload(freshFolder));
  await fs.writeFile(files.corruptIndex, "{ broken cache", "utf8");
  await fs.writeFile(files.quarantinedIndex, "{ already quarantined cache", "utf8");

  return {
    activeRoot,
    freshFolder,
    activeRootId,
    orphanRootId,
    files
  };
}

function reasonCount(report, reason) {
  return Number(report.byReason?.[reason] || 0);
}

async function allExist(paths) {
  const results = await Promise.all(paths.map(exists));
  return results.every(Boolean);
}

async function allMissing(paths) {
  const results = await Promise.all(paths.map(exists));
  return results.every((item) => !item);
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  const deleted = Object.entries(report.apply.byReason || {})
    .map(([reason, count]) => `| ${reason} | ${count} |`)
    .join("\n");
  return `# Cache Maintenance Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Apply Reasons

| Reason | Count |
| --- | ---: |
${deleted}

Dry-run eligible: ${report.dryRun.eligible}
Applied deletions: ${report.apply.deleted}
Freed bytes: ${report.apply.freedBytes}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const fixture = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 47200 + Math.floor(Math.random() * 2000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  let dryRun = null;
  let apply = null;
  let after = null;
  try {
    await waitForServer(baseUrl, server);
    dryRun = await requestJson(baseUrl, "/api/cache/maintenance?fileLimit=100");
    check(checks, "dry-run-default", dryRun.dryRun === true && dryRun.deleted === 0, `dryRun=${dryRun.dryRun}; deleted=${dryRun.deleted}.`);
    check(checks, "dry-run-finds-stale-cache", dryRun.eligible >= 6, `eligible=${dryRun.eligible}; reasons=${JSON.stringify(dryRun.byReason)}.`);
    check(checks, "dry-run-preserves-files", await allExist(Object.values(fixture.files)), "All seeded cache files still exist after dry-run.");
    check(checks, "dry-run-classifies-active-background", reasonCount(dryRun, "active-background-root") >= 2, `active=${reasonCount(dryRun, "active-background-root")}.`);

    apply = await requestJson(baseUrl, "/api/cache/maintenance", {
      method: "POST",
      body: JSON.stringify({ apply: true, fileLimit: 100 })
    });
    check(checks, "apply-deletes-eligible-cache", apply.dryRun === false && apply.deleted >= 6 && apply.errors === 0, `deleted=${apply.deleted}; errors=${apply.errors}.`);
    check(checks, "orphan-background-deleted", await allMissing([fixture.files.orphanManifest, fixture.files.orphanSearch]), "Orphan background cache files were deleted.");
    check(checks, "missing-path-caches-deleted", await allMissing([fixture.files.staleFolderIndex, fixture.files.staleMetadata]), "Missing-path folder and metadata caches were deleted.");
    check(checks, "corrupt-and-quarantined-deleted", await allMissing([fixture.files.corruptIndex, fixture.files.quarantinedIndex]), "Corrupt and quarantined cache files were deleted.");
    check(checks, "active-and-current-cache-preserved", await allExist([fixture.files.activeManifest, fixture.files.activeSearch, fixture.files.freshFolderIndex, fixture.files.freshMetadata]), "Active background and current warm-cache files remain.");

    after = await requestJson(baseUrl, "/api/cache/maintenance?fileLimit=100");
    check(checks, "post-cleanup-no-stale-eligible", after.eligible === 0, `eligible=${after.eligible}; reasons=${JSON.stringify(after.byReason)}.`);

    const summary = {
      pass: checks.filter((item) => item.status === "pass").length,
      warn: checks.filter((item) => item.status === "warn").length,
      fail: checks.filter((item) => item.status === "fail").length
    };
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixture,
      dryRun,
      apply,
      after,
      serverOutput: serverOutput.slice(-4000),
      checks,
      summary
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`cache maintenance: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail > 0) {
      process.exitCode = 1;
    }
  } finally {
    await stopServer(server);
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
