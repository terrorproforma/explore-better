import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `operation-preview-scale-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "operation-preview-scale-latest.json");
const latestMdPath = path.join(artifactsDir, "operation-preview-scale-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function numberOption(name, envName, fallback) {
  const value = Number(optionValue(name, process.env[envName] || fallback));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_OPERATION_PREVIEW_SCALE_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail, data = {}) {
  checks.push({ id, status: ok ? "pass" : "fail", detail, ...data });
}

function budgetCheck(checks, id, actual, budget, detail) {
  const numeric = Number(actual);
  checks.push({
    id,
    status: Number.isFinite(numeric) && numeric <= Number(budget) ? "pass" : "fail",
    actual: Number.isFinite(numeric) ? Math.round(numeric * 10) / 10 : null,
    budget,
    detail
  });
}

function summaryFor(checks) {
  return {
    pass: checks.filter((item) => item.status === "pass").length,
    warn: checks.filter((item) => item.status === "warn").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
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

async function safeRemoveRunRoot() {
  const resolvedRunRoot = path.resolve(runRoot);
  const resolvedArtifacts = path.resolve(artifactsDir);
  if (!resolvedRunRoot.startsWith(`${resolvedArtifacts}${path.sep}`)) {
    throw new Error(`Refusing to remove run root outside artifacts: ${resolvedRunRoot}`);
  }
  await fs.rm(resolvedRunRoot, { recursive: true, force: true });
}

async function writeText(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function pathExists(itemPath) {
  try {
    await fs.access(itemPath);
    return true;
  } catch {
    return false;
  }
}

function actionCount(plan, action) {
  return Number(plan?.actionCounts?.[action] || 0);
}

function countsMatch(actual = {}, expected = {}) {
  return Object.entries(expected).every(([key, value]) => Number(actual?.[key] || 0) === Number(value));
}

async function directorySignature(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const itemPath = path.join(dir, entry.name);
    const stats = await fs.stat(itemPath);
    rows.push(`${entry.name}:${stats.size}:${Math.round(stats.mtimeMs)}`);
  }
  return rows.sort().join("\n");
}

async function timed(task) {
  const started = performance.now();
  const result = await task();
  return {
    result,
    wallMs: Math.round((performance.now() - started) * 10) / 10
  };
}

async function prepareTransferFixture({ directCount, renameCount, overwriteCount, skipCount }) {
  const source = path.join(fixtureRoot, "transfer-source");
  const target = path.join(fixtureRoot, "transfer-target");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(target, { recursive: true });
  const paths = [];
  const itemPolicies = {};
  const batches = [];
  function addWrite(filePath, text) {
    batches.push(writeText(filePath, text));
  }
  for (let index = 0; index < directCount; index += 1) {
    const name = `direct-${String(index).padStart(4, "0")}.txt`;
    const itemPath = path.join(source, name);
    paths.push(itemPath);
    addWrite(itemPath, `direct source ${index}\n`);
  }
  for (let index = 0; index < renameCount; index += 1) {
    const name = `rename-${String(index).padStart(4, "0")}.txt`;
    const itemPath = path.join(source, name);
    paths.push(itemPath);
    addWrite(itemPath, `rename source ${index}\n`);
    addWrite(path.join(target, name), `existing rename target ${index}\n`);
  }
  for (let index = 0; index < overwriteCount; index += 1) {
    const name = `overwrite-${String(index).padStart(4, "0")}.txt`;
    const itemPath = path.join(source, name);
    paths.push(itemPath);
    itemPolicies[itemPath] = "overwrite";
    addWrite(itemPath, `overwrite source ${index}\n`);
    addWrite(path.join(target, name), `existing overwrite target ${index}\n`);
  }
  for (let index = 0; index < skipCount; index += 1) {
    const name = `skip-${String(index).padStart(4, "0")}.txt`;
    const itemPath = path.join(source, name);
    paths.push(itemPath);
    itemPolicies[itemPath] = "skip";
    addWrite(itemPath, `skip source ${index}\n`);
    addWrite(path.join(target, name), `existing skip target ${index}\n`);
  }
  for (let offset = 0; offset < batches.length; offset += 512) {
    await Promise.all(batches.slice(offset, offset + 512));
  }
  return { source, target, paths, itemPolicies };
}

async function prepareSyncFixture({ copyCount, overwriteCount, mirrorDeleteCount, missingSourceCount }) {
  const left = path.join(fixtureRoot, "sync-left");
  const right = path.join(fixtureRoot, "sync-right");
  await fs.mkdir(left, { recursive: true });
  await fs.mkdir(right, { recursive: true });
  const items = [];
  const batches = [];
  function addWrite(filePath, text) {
    batches.push(writeText(filePath, text));
  }
  for (let index = 0; index < copyCount; index += 1) {
    const name = `copy-${String(index).padStart(4, "0")}.txt`;
    items.push(name);
    addWrite(path.join(left, name), `copy source ${index}\n`);
  }
  for (let index = 0; index < overwriteCount; index += 1) {
    const name = `overwrite-${String(index).padStart(4, "0")}.txt`;
    items.push(name);
    addWrite(path.join(left, name), `overwrite source ${index}\n`);
    addWrite(path.join(right, name), `existing overwrite target ${index}\n`);
  }
  for (let index = 0; index < mirrorDeleteCount; index += 1) {
    const name = `delete-${String(index).padStart(4, "0")}.txt`;
    items.push(name);
    addWrite(path.join(right, name), `right only target ${index}\n`);
  }
  for (let index = 0; index < missingSourceCount; index += 1) {
    items.push(`missing-${String(index).padStart(4, "0")}.txt`);
  }
  for (let offset = 0; offset < batches.length; offset += 512) {
    await Promise.all(batches.slice(offset, offset + 512));
  }
  return { left, right, items };
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${item.actual ?? ""} | ${item.budget ?? ""} | ${String(item.detail || "").replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Operation Preview Scale Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

Transfer preview: ${report.transfer.count} item(s), ${report.transfer.wallMs} ms.
Sync preview: ${report.sync.count} item(s), ${report.sync.wallMs} ms.

| Status | Check | Actual | Budget | Detail |
| --- | --- | ---: | ---: | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  const checks = [];
  const transferDirect = numberOption("--transfer-direct", "EB_OPERATION_PREVIEW_SCALE_TRANSFER_DIRECT", 125);
  const transferRename = numberOption("--transfer-rename", "EB_OPERATION_PREVIEW_SCALE_TRANSFER_RENAME", 125);
  const transferOverwrite = numberOption("--transfer-overwrite", "EB_OPERATION_PREVIEW_SCALE_TRANSFER_OVERWRITE", 125);
  const transferSkip = numberOption("--transfer-skip", "EB_OPERATION_PREVIEW_SCALE_TRANSFER_SKIP", 125);
  const syncCopy = numberOption("--sync-copy", "EB_OPERATION_PREVIEW_SCALE_SYNC_COPY", 250);
  const syncOverwrite = numberOption("--sync-overwrite", "EB_OPERATION_PREVIEW_SCALE_SYNC_OVERWRITE", 250);
  const syncMirrorDelete = numberOption("--sync-mirror-delete", "EB_OPERATION_PREVIEW_SCALE_SYNC_MIRROR_DELETE", 250);
  const syncMissingSource = numberOption("--sync-missing-source", "EB_OPERATION_PREVIEW_SCALE_SYNC_MISSING_SOURCE", 250);
  const transferBudgetMs = numberOption("--transfer-wall-ms", "EB_OPERATION_PREVIEW_SCALE_TRANSFER_WALL_MS", 6000);
  const syncBudgetMs = numberOption("--sync-wall-ms", "EB_OPERATION_PREVIEW_SCALE_SYNC_WALL_MS", 7000);

  const transferExpected = {
    copy: transferDirect,
    rename: transferRename,
    overwrite: transferOverwrite,
    skip: transferSkip,
    risky: transferOverwrite
  };
  const syncExpected = {
    copy: syncCopy,
    overwrite: syncOverwrite,
    "mirror-delete": syncMirrorDelete,
    "missing-source": syncMissingSource,
    risky: syncOverwrite + syncMirrorDelete
  };

  const transferFixture = await prepareTransferFixture({
    directCount: transferDirect,
    renameCount: transferRename,
    overwriteCount: transferOverwrite,
    skipCount: transferSkip
  });
  const syncFixture = await prepareSyncFixture({
    copyCount: syncCopy,
    overwriteCount: syncOverwrite,
    mirrorDeleteCount: syncMirrorDelete,
    missingSourceCount: syncMissingSource
  });
  const transferTargetBefore = await directorySignature(transferFixture.target);
  const syncRightBefore = await directorySignature(syncFixture.right);

  const port = Number(optionValue("--port", process.env.PORT || 51500 + Math.floor(Math.random() * 4000)));
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

  let report;
  try {
    await waitForServer(baseUrl, server);
    const transferTiming = await timed(() =>
      requestJson(baseUrl, "/api/transfer/preview", {
        method: "POST",
        body: JSON.stringify({
          paths: transferFixture.paths,
          targetDir: transferFixture.target,
          mode: "copy",
          conflictMode: "unique",
          itemPolicies: transferFixture.itemPolicies
        })
      })
    );
    const transferPlan = transferTiming.result;
    const syncTiming = await timed(() =>
      requestJson(baseUrl, "/api/operation/preview", {
        method: "POST",
        body: JSON.stringify({
          type: "sync",
          leftPath: syncFixture.left,
          rightPath: syncFixture.right,
          direction: "leftToRight",
          overwrite: true,
          mirrorDeletes: true,
          items: syncFixture.items
        })
      })
    );
    const syncPlan = syncTiming.result;

    const transferTargetAfter = await directorySignature(transferFixture.target);
    const syncRightAfter = await directorySignature(syncFixture.right);
    const firstRename = transferPlan.items.find((item) => item.action === "rename");
    const firstCopyDest = path.join(syncFixture.right, `copy-${String(0).padStart(4, "0")}.txt`);
    const firstDeleteDest = path.join(syncFixture.right, `delete-${String(0).padStart(4, "0")}.txt`);

    check(checks, "transfer-item-count", transferPlan.items.length === transferFixture.paths.length, `${transferPlan.items.length}/${transferFixture.paths.length} item(s).`);
    check(checks, "transfer-action-counts", countsMatch(transferPlan.actionCounts, transferExpected), `actual=${JSON.stringify(transferPlan.actionCounts)}, expected=${JSON.stringify(transferExpected)}.`);
    check(checks, "transfer-digest", /^[a-f0-9]{64}$/.test(transferPlan.planDigest || ""), transferPlan.planDigest || "missing");
    check(checks, "transfer-can-apply", transferPlan.canApply === true, `canApply=${transferPlan.canApply}.`);
    budgetCheck(checks, "transfer-wall-budget", transferTiming.wallMs, transferBudgetMs, `${transferPlan.items.length} item transfer preview.`);
    check(checks, "transfer-preview-non-mutating", transferTargetBefore === transferTargetAfter, "Target directory signature unchanged after preview.");
    check(
      checks,
      "transfer-rename-not-created",
      Boolean(firstRename?.dest) && !(await pathExists(firstRename.dest)),
      firstRename?.dest || "no rename item"
    );

    check(checks, "sync-item-count", syncPlan.items.length === syncFixture.items.length, `${syncPlan.items.length}/${syncFixture.items.length} item(s).`);
    check(checks, "sync-action-counts", countsMatch(syncPlan.actionCounts, syncExpected), `actual=${JSON.stringify(syncPlan.actionCounts)}, expected=${JSON.stringify(syncExpected)}.`);
    check(checks, "sync-digest", /^[a-f0-9]{64}$/.test(syncPlan.planDigest || ""), syncPlan.planDigest || "missing");
    check(checks, "sync-can-apply", syncPlan.canApply === true, `canApply=${syncPlan.canApply}.`);
    budgetCheck(checks, "sync-wall-budget", syncTiming.wallMs, syncBudgetMs, `${syncPlan.items.length} item sync preview.`);
    check(checks, "sync-preview-non-mutating", syncRightBefore === syncRightAfter, "Right directory signature unchanged after preview.");
    check(checks, "sync-copy-not-created", !(await pathExists(firstCopyDest)), firstCopyDest);
    check(checks, "sync-delete-not-removed", await pathExists(firstDeleteDest), firstDeleteDest);

    const summary = summaryFor(checks);
    report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixture: {
        transferSource: transferFixture.source,
        transferTarget: transferFixture.target,
        syncLeft: syncFixture.left,
        syncRight: syncFixture.right
      },
      budgets: {
        transferBudgetMs,
        syncBudgetMs
      },
      transfer: {
        count: transferPlan.items.length,
        wallMs: transferTiming.wallMs,
        planDigest: transferPlan.planDigest,
        expectedActionCounts: transferExpected,
        actionCounts: transferPlan.actionCounts,
        counts: transferPlan.counts,
        canApply: transferPlan.canApply,
        nonMutating: transferTargetBefore === transferTargetAfter,
        sample: transferPlan.items.slice(0, 12).map((item) => ({
          originalName: item.originalName,
          action: item.action,
          status: item.status,
          risky: item.risky,
          conflictMode: item.conflictMode,
          destName: path.basename(item.dest || "")
        }))
      },
      sync: {
        count: syncPlan.items.length,
        wallMs: syncTiming.wallMs,
        planDigest: syncPlan.planDigest,
        expectedActionCounts: syncExpected,
        actionCounts: syncPlan.actionCounts,
        counts: syncPlan.counts,
        canApply: syncPlan.canApply,
        nonMutating: syncRightBefore === syncRightAfter,
        sample: syncPlan.items.slice(0, 12).map((item) => ({
          relativePath: item.relativePath,
          action: item.action,
          status: item.status,
          risky: item.risky,
          reason: item.reason
        }))
      },
      checks,
      summary,
      serverOutput: serverOutput.slice(-4000)
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`operation preview scale: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`transfer preview: ${transferPlan.items.length} item(s), ${transferTiming.wallMs} ms`);
    console.log(`sync preview: ${syncPlan.items.length} item(s), ${syncTiming.wallMs} ms`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail > 0) {
      process.exitCode = 1;
    }
  } finally {
    await stopServer(server);
    if (!keepFixture()) {
      await safeRemoveRunRoot().catch(() => {});
    }
  }
}

main().catch(async (error) => {
  const checks = [{ id: "operation-preview-scale-error", status: "fail", detail: error.stack || error.message }];
  const summary = summaryFor(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    runRoot,
    checks,
    summary,
    serverOutput: serverOutput.slice(-4000)
  };
  await fs.mkdir(artifactsDir, { recursive: true }).catch(() => {});
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => {});
  await fs.writeFile(latestMdPath, markdownReport({ ...report, transfer: {}, sync: {} })).catch(() => {});
  console.error(error.stack || error.message);
  if (serverOutput) console.error(serverOutput);
  process.exitCode = 1;
});
