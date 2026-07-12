import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `operation-preview-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_OPERATION_PREVIEW_KEEP_FIXTURE === "1";
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function count(plan, action) {
  return Number(plan.actionCounts?.[action] || 0);
}

async function pathExists(itemPath) {
  try {
    await fs.access(itemPath);
    return true;
  } catch {
    return false;
  }
}

async function prepareFixture() {
  const transferSource = path.join(fixtureRoot, "transfer-source");
  const transferTarget = path.join(fixtureRoot, "transfer-target");
  const syncLeft = path.join(fixtureRoot, "sync-left");
  const syncRight = path.join(fixtureRoot, "sync-right");
  await fs.mkdir(transferSource, { recursive: true });
  await fs.mkdir(transferTarget, { recursive: true });
  await fs.mkdir(syncLeft, { recursive: true });
  await fs.mkdir(syncRight, { recursive: true });
  await fs.writeFile(path.join(transferSource, "alpha.txt"), "source alpha\n");
  await fs.writeFile(path.join(transferSource, "beta.txt"), "source beta\n");
  await fs.writeFile(path.join(transferTarget, "alpha.txt"), "existing alpha\n");
  await fs.writeFile(path.join(syncLeft, "fresh.txt"), "fresh from left\n");
  await fs.writeFile(path.join(syncLeft, "replace.txt"), "replacement from left\n");
  await fs.writeFile(path.join(syncRight, "replace.txt"), "right old content\n");
  await fs.writeFile(path.join(syncRight, "remove.txt"), "right-only content\n");
  return { transferSource, transferTarget, syncLeft, syncRight };
}

async function assertRejectedPreview(baseUrl, body) {
  try {
    await requestJson(baseUrl, "/api/operation/preview", {
      method: "POST",
      body: JSON.stringify(body)
    });
  } catch (error) {
    assert(error.status >= 400, "Unsafe preview should return an error status.");
    return error.data?.error || error.message;
  }
  throw new Error("Unsafe preview unexpectedly succeeded.");
}

async function assertRejectedApply(baseUrl, route, body) {
  try {
    await requestJson(baseUrl, route, {
      method: "POST",
      body: JSON.stringify(body)
    });
  } catch (error) {
    assert(error.status >= 400, "Stale apply should return an error status.");
    return error.data?.error || error.message;
  }
  throw new Error("Stale apply unexpectedly succeeded.");
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  const fixture = await prepareFixture();
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
    const transferPlan = await requestJson(baseUrl, "/api/transfer/preview", {
      method: "POST",
      body: JSON.stringify({
        paths: [path.join(fixture.transferSource, "alpha.txt"), path.join(fixture.transferSource, "beta.txt")],
        targetDir: fixture.transferTarget,
        mode: "copy",
        conflictMode: "unique"
      })
    });
    const renamed = transferPlan.items.find((item) => item.originalName === "alpha.txt");
    assert(transferPlan.type === "transfer" && transferPlan.mode === "copy", "Transfer preview should report copy mode.");
    assert(/^[a-f0-9]{64}$/.test(transferPlan.planDigest || ""), "Copy preview should include a stable plan digest.");
    assert(count(transferPlan, "rename") === 1, "Copy preview should plan one unique rename.");
    assert(count(transferPlan, "copy") === 1, "Copy preview should plan one direct copy.");
    assert(renamed?.dest && renamed.dest !== path.join(fixture.transferTarget, "alpha.txt"), "Conflict should plan a unique destination.");
    assert(!(await pathExists(renamed.dest)), "Preview must not create the planned unique destination.");
    assert((await fs.readFile(path.join(fixture.transferTarget, "alpha.txt"), "utf8")) === "existing alpha\n", "Preview must not overwrite existing files.");
    await fs.writeFile(path.join(fixture.transferTarget, "beta.txt"), "late beta conflict\n");
    const staleTransferMessage = await assertRejectedApply(baseUrl, "/api/transfer", {
      paths: [path.join(fixture.transferSource, "alpha.txt"), path.join(fixture.transferSource, "beta.txt")],
      targetDir: fixture.transferTarget,
      mode: "copy",
      conflictMode: "unique",
      expectedPlanDigest: transferPlan.planDigest
    });
    assert(/preview changed/i.test(staleTransferMessage), "Stale transfer apply should ask for a refreshed preview.");
    assert((await fs.readFile(path.join(fixture.transferTarget, "alpha.txt"), "utf8")) === "existing alpha\n", "Stale apply must not overwrite alpha.");
    assert((await fs.readFile(path.join(fixture.transferTarget, "beta.txt"), "utf8")) === "late beta conflict\n", "Stale apply must not overwrite beta.");
    assert(!(await pathExists(renamed.dest)), "Stale apply must not create the old planned rename destination.");
    const gammaSource = path.join(fixture.transferSource, "gamma.txt");
    const gammaTarget = path.join(fixture.transferTarget, "gamma.txt");
    await fs.writeFile(gammaSource, "source gamma\n");
    const freshTransferPlan = await requestJson(baseUrl, "/api/transfer/preview", {
      method: "POST",
      body: JSON.stringify({
        paths: [gammaSource],
        targetDir: fixture.transferTarget,
        mode: "copy",
        conflictMode: "unique"
      })
    });
    const freshTransferResult = await requestJson(baseUrl, "/api/transfer", {
      method: "POST",
      body: JSON.stringify({
        paths: [gammaSource],
        targetDir: fixture.transferTarget,
        mode: "copy",
        conflictMode: "unique",
        expectedPlanDigest: freshTransferPlan.planDigest
      })
    });
    assert(freshTransferResult.operation?.status === "completed", "Fresh transfer digest apply should complete.");
    assert((await fs.readFile(gammaTarget, "utf8")) === "source gamma\n", "Fresh transfer digest apply should copy gamma.");

    const syncPlan = await requestJson(baseUrl, "/api/operation/preview", {
      method: "POST",
      body: JSON.stringify({
        type: "sync",
        leftPath: fixture.syncLeft,
        rightPath: fixture.syncRight,
        direction: "leftToRight",
        overwrite: true,
        mirrorDeletes: true,
        items: ["fresh.txt", "replace.txt", "remove.txt"]
      })
    });
    assert(syncPlan.type === "sync", "Sync preview should report sync type.");
    assert(/^[a-f0-9]{64}$/.test(syncPlan.planDigest || ""), "Sync preview should include a stable plan digest.");
    assert(count(syncPlan, "copy") === 1, "Sync preview should plan one new copy.");
    assert(count(syncPlan, "overwrite") === 1, "Sync preview should plan one overwrite.");
    assert(count(syncPlan, "mirror-delete") === 1, "Sync preview should plan one mirror delete.");
    assert(count(syncPlan, "risky") === 2, "Sync preview should mark overwrite and mirror delete as risky.");
    assert(syncPlan.canApply, "Sync preview should be applyable when at least one ready item exists.");
    assert(!(await pathExists(path.join(fixture.syncRight, "fresh.txt"))), "Preview must not copy sync files.");
    assert((await fs.readFile(path.join(fixture.syncRight, "replace.txt"), "utf8")) === "right old content\n", "Preview must not overwrite sync destinations.");
    assert(await pathExists(path.join(fixture.syncRight, "remove.txt")), "Preview must not mirror-delete destinations.");
    await fs.writeFile(path.join(fixture.syncRight, "replace.txt"), "late right conflict\n");
    const staleSyncMessage = await assertRejectedApply(baseUrl, "/api/sync", {
      leftPath: fixture.syncLeft,
      rightPath: fixture.syncRight,
      direction: "leftToRight",
      overwrite: true,
      mirrorDeletes: true,
      items: ["fresh.txt", "replace.txt", "remove.txt"],
      expectedPlanDigest: syncPlan.planDigest
    });
    assert(/preview changed/i.test(staleSyncMessage), "Stale sync apply should ask for a refreshed preview.");
    assert(!(await pathExists(path.join(fixture.syncRight, "fresh.txt"))), "Stale sync must not copy new files.");
    assert((await fs.readFile(path.join(fixture.syncRight, "replace.txt"), "utf8")) === "late right conflict\n", "Stale sync must not overwrite changed destinations.");
    assert(await pathExists(path.join(fixture.syncRight, "remove.txt")), "Stale sync must not mirror-delete destinations.");
    const freshSyncPlan = await requestJson(baseUrl, "/api/operation/preview", {
      method: "POST",
      body: JSON.stringify({
        type: "sync",
        leftPath: fixture.syncLeft,
        rightPath: fixture.syncRight,
        direction: "leftToRight",
        overwrite: false,
        mirrorDeletes: false,
        items: ["fresh.txt"]
      })
    });
    const freshSyncResult = await requestJson(baseUrl, "/api/sync", {
      method: "POST",
      body: JSON.stringify({
        leftPath: fixture.syncLeft,
        rightPath: fixture.syncRight,
        direction: "leftToRight",
        overwrite: false,
        mirrorDeletes: false,
        items: ["fresh.txt"],
        expectedPlanDigest: freshSyncPlan.planDigest
      })
    });
    assert(freshSyncResult.operation?.status === "completed", "Fresh sync digest apply should complete.");
    assert((await fs.readFile(path.join(fixture.syncRight, "fresh.txt"), "utf8")) === "fresh from left\n", "Fresh sync digest apply should copy fresh.txt.");

    const unsafeMessage = await assertRejectedPreview(baseUrl, {
      type: "sync",
      leftPath: fixture.syncLeft,
      rightPath: fixture.syncRight,
      direction: "leftToRight",
      overwrite: true,
      mirrorDeletes: true,
      items: ["../escape.txt"]
    });
    assert(/Invalid compare item path|escapes/.test(unsafeMessage), "Unsafe relative paths should be rejected clearly.");

    const report = {
      generatedAt: new Date().toISOString(),
      fixtureRoot,
      baseUrl,
      transfer: {
        planDigest: transferPlan.planDigest,
        staleApplyRejected: staleTransferMessage,
        freshDigestApply: {
          planDigest: freshTransferPlan.planDigest,
          operationStatus: freshTransferResult.operation?.status,
          copied: freshTransferResult.transferred?.includes(gammaTarget) || false
        },
        actionCounts: transferPlan.actionCounts,
        items: transferPlan.items.map((item) => ({
          originalName: item.originalName,
          action: item.action,
          status: item.status,
          reason: item.reason
        }))
      },
      sync: {
        planDigest: syncPlan.planDigest,
        staleApplyRejected: staleSyncMessage,
        freshDigestApply: {
          planDigest: freshSyncPlan.planDigest,
          operationStatus: freshSyncResult.operation?.status,
          copied: freshSyncResult.copied?.includes(path.join(fixture.syncRight, "fresh.txt")) || false
        },
        actionCounts: syncPlan.actionCounts,
        items: syncPlan.items.map((item) => ({
          relativePath: item.relativePath,
          action: item.action,
          status: item.status,
          risky: item.risky,
          reason: item.reason
        }))
      },
      unsafePathRejected: unsafeMessage
    };
    const outputPath = path.join(artifactsDir, "operation-preview-latest.json");
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2));
    console.log(`copy preview: ${JSON.stringify(transferPlan.actionCounts)}`);
    console.log(`sync preview: ${JSON.stringify(syncPlan.actionCounts)}`);
    console.log(`unsafe path rejected: ${unsafeMessage}`);
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
  process.exitCode = 1;
});
