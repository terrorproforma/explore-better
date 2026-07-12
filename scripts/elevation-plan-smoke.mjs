import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `elevation-plan-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_ELEVATION_KEEP_FIXTURE === "1";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function pathExists(itemPath) {
  try {
    await fs.access(itemPath);
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
      throw new Error(`Server exited early with ${child.exitCode}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}`);
}

function recoveryItem(itemPath, index, reason = "Access is denied.") {
  return {
    index,
    path: itemPath,
    name: path.basename(itemPath),
    reason
  };
}

async function seedState() {
  const deleteDir = path.join(fixtureRoot, "protected-delete");
  const copySource = path.join(fixtureRoot, "copy-source");
  const copyTarget = path.join(fixtureRoot, "copy-target");
  await fs.mkdir(deleteDir, { recursive: true });
  await fs.mkdir(copySource, { recursive: true });
  await fs.mkdir(copyTarget, { recursive: true });
  const deletePaths = ["locked-a.txt", "locked-b.txt"].map((name) => path.join(deleteDir, name));
  const copyPaths = ["admin-copy.txt"].map((name) => path.join(copySource, name));
  for (const itemPath of [...deletePaths, ...copyPaths]) {
    await fs.writeFile(itemPath, `${path.basename(itemPath)}\n`);
  }

  const now = new Date().toISOString();
  const state = {
    version: 1,
    updatedAt: now,
    operations: [
      {
        id: "failed-delete-elevation",
        type: "delete",
        label: "Delete protected files",
        status: "failed",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        result: {
          error: "Access is denied.",
          recovery: {
            type: "delete",
            targetDir: null,
            completedCount: 0,
            remainingCount: deletePaths.length,
            completed: [],
            failed: recoveryItem(deletePaths[0], 0),
            remaining: deletePaths.map((itemPath, index) => recoveryItem(itemPath, index)),
            retry: {
              type: "delete",
              body: { paths: deletePaths }
            },
            canRetryRemaining: true
          }
        },
        error: "Access is denied.",
        undo: null,
        progress: null,
        retry: {
          type: "delete",
          body: { paths: deletePaths },
          createdAt: now
        },
        retryOf: null
      },
      {
        id: "failed-copy-elevation",
        type: "copy",
        label: "Copy protected file",
        status: "failed",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        result: {
          error: "Access is denied.",
          recovery: {
            type: "copy",
            targetDir: copyTarget,
            completedCount: 0,
            remainingCount: copyPaths.length,
            completed: [],
            failed: recoveryItem(copyPaths[0], 0),
            remaining: copyPaths.map((itemPath, index) => recoveryItem(itemPath, index)),
            retry: {
              type: "copy",
              body: { paths: copyPaths, targetDir: copyTarget }
            },
            canRetryRemaining: true
          }
        },
        error: "Access is denied.",
        undo: null,
        progress: null,
        retry: {
          type: "copy",
          body: { paths: copyPaths, targetDir: copyTarget },
          createdAt: now
        },
        retryOf: null
      }
    ]
  };
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return { deletePaths, copyPaths, copyTarget };
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixture = await seedState();
  const port = Number(optionValue("--port", process.env.PORT || 49000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServer(baseUrl, server);

    const dryRun = await requestJson(baseUrl, "/api/operation/elevated-retry", {
      method: "POST",
      body: JSON.stringify({ operationId: "failed-copy-elevation", dryRun: true })
    });
    assert(dryRun.dryRun === true, "Dry run should be marked as dryRun.");
    assert(dryRun.prepared === false, "Dry run should not write helper files.");
    assert(dryRun.type === "copy", "Dry run should preserve the retry type.");
    assert(dryRun.targetDir === fixture.copyTarget, "Copy dry run should resolve the target folder.");
    assert(dryRun.items[0]?.plannedDest === path.join(fixture.copyTarget, "admin-copy.txt"), "Copy dry run should show the planned destination.");

    const prepared = await requestJson(baseUrl, "/api/operation/elevated-retry", {
      method: "POST",
      body: JSON.stringify({ operationId: "failed-delete-elevation", indexes: [1], launch: false })
    });
    assert(prepared.prepared === true, "Launch-free elevated retry should prepare helper files.");
    assert(prepared.launched === false, "Launch-free elevated retry must not start UAC.");
    assert(prepared.type === "delete", "Prepared helper should preserve delete type.");
    assert(prepared.itemCount === 1, "Selected helper should contain exactly one remaining item.");
    assert(prepared.selectedIndexes.length === 1 && prepared.selectedIndexes[0] === 1, "Selected index should be recorded.");
    for (const filePath of [prepared.scriptPath, prepared.payloadPath, prepared.manifestPath, prepared.launcherPath]) {
      assert(await pathExists(filePath), `Expected helper file to exist: ${filePath}`);
    }

    const payloadText = await fs.readFile(prepared.payloadPath, "utf8");
    const payload = JSON.parse(payloadText);
    const manifest = JSON.parse(await fs.readFile(prepared.manifestPath, "utf8"));
    const payloadHash = crypto.createHash("sha256").update(payloadText).digest("hex");
    assert(manifest.payloadSha256 === payloadHash, "Manifest should hash the exact payload JSON.");
    assert(payload.items.length === 1, "Payload should include one selected item.");
    assert(payload.items[0].path === fixture.deletePaths[1], "Payload should target the selected remaining path.");
    assert(payload.logPath === prepared.logPath, "Payload should point to the reported log path.");
    assert((await fs.readFile(prepared.scriptPath, "utf8")).includes("Payload hash mismatch"), "Elevated script should verify payload integrity.");
    assert((await fs.readFile(prepared.launcherPath, "utf8")).includes("Start-Process"), "Launcher should use Start-Process for UAC.");
    assert(await pathExists(fixture.deletePaths[1]), "Preparing an elevated helper must not delete fixture files.");

    const state = await requestJson(baseUrl, "/api/state");
    const savedOperation = state.operations.find((item) => item.id === "failed-delete-elevation");
    const elevation = savedOperation?.result?.recovery?.elevation;
    assert(elevation?.status === "prepared", "Prepared helper should be recorded in operation recovery.");
    assert(elevation.itemCount === 1, "Recorded elevation summary should preserve item count.");
    assert(elevation.payloadPath === prepared.payloadPath, "Recorded elevation summary should preserve payload path.");

    const report = {
      generatedAt: new Date().toISOString(),
      fixtureRoot,
      baseUrl,
      dryRun: {
        type: dryRun.type,
        itemCount: dryRun.itemCount,
        plannedDest: dryRun.items[0]?.plannedDest
      },
      prepared: {
        runId: prepared.runId,
        type: prepared.type,
        itemCount: prepared.itemCount,
        selectedIndexes: prepared.selectedIndexes,
        scriptPath: prepared.scriptPath,
        payloadPath: prepared.payloadPath,
        manifestPath: prepared.manifestPath,
        launcherPath: prepared.launcherPath,
        logPath: prepared.logPath
      }
    };
    const outputPath = path.join(artifactsDir, "elevation-plan-latest.json");
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`dry-run ${dryRun.type}: ${dryRun.itemCount} item(s)`);
    console.log(`prepared ${prepared.type}: ${prepared.itemCount} item(s)`);
    console.log(`wrote ${outputPath}`);
  } finally {
    server.kill();
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(serverOutput);
  console.error(error);
  process.exit(1);
});
