import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `operation-listing-cache-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "operation-listing-cache-latest.json");
const latestMdPath = path.join(artifactsDir, "operation-listing-cache-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_OPERATION_LISTING_CACHE_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
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
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function timed(task) {
  const started = performance.now();
  const result = await task();
  return {
    wallMs: Math.round((performance.now() - started) * 10) / 10,
    result
  };
}

async function waitForServer(baseUrl, child) {
  const started = performance.now();
  while (performance.now() - started < 10000) {
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

async function writeText(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function prepareFixture() {
  const dirs = {
    target: path.join(fixtureRoot, "target"),
    copySource: path.join(fixtureRoot, "copy-source"),
    moveSource: path.join(fixtureRoot, "move-source"),
    moveTarget: path.join(fixtureRoot, "move-target"),
    renameDir: path.join(fixtureRoot, "rename"),
    deleteDir: path.join(fixtureRoot, "delete"),
    syncLeft: path.join(fixtureRoot, "sync-left"),
    syncRight: path.join(fixtureRoot, "sync-right")
  };
  for (const dir of Object.values(dirs)) {
    await fs.mkdir(dir, { recursive: true });
  }
  await writeText(path.join(dirs.target, "baseline.txt"), "baseline\n");
  await writeText(path.join(dirs.copySource, "copy-me.txt"), "copy me\n");
  await writeText(path.join(dirs.moveSource, "move-me.txt"), "move me\n");
  await writeText(path.join(dirs.renameDir, "before.txt"), "rename me\n");
  await writeText(path.join(dirs.deleteDir, "delete-me.txt"), "delete me\n");
  await writeText(path.join(dirs.syncLeft, "fresh.txt"), "fresh sync\n");
  return dirs;
}

function listRoute(dir) {
  return `/api/list?${new URLSearchParams({ path: dir, showHidden: "true", includeSignature: "true" })}`;
}

function summarizeList(timing) {
  const data = timing.result || {};
  return {
    wallMs: timing.wallMs,
    returned: data.entries?.length || 0,
    scanned: data.timing?.scanned ?? null,
    cache: data.timing?.cache || data.cache || null,
    names: (data.entries || []).map((entry) => entry.name)
  };
}

async function warmFolder(baseUrl, dir) {
  await timed(() => requestJson(baseUrl, listRoute(dir)));
  return summarizeList(await timed(() => requestJson(baseUrl, listRoute(dir))));
}

async function listFolder(baseUrl, dir) {
  return summarizeList(await timed(() => requestJson(baseUrl, listRoute(dir))));
}

function operationInvalidated(operation) {
  return Number(operation?.result?.cacheInvalidation?.invalidated || 0) >= 1;
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Operation Listing Cache Invalidation Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const dirs = await prepareFixture();
  await fs.mkdir(appData, { recursive: true });

  const port = Number(optionValue("--port", process.env.PORT || 52500 + Math.floor(Math.random() * 4000)));
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

  try {
    await waitForServer(baseUrl, server);
    const snapshots = {};

    snapshots.targetWarmBeforeCreate = await warmFolder(baseUrl, dirs.target);
    const create = await requestJson(baseUrl, "/api/file/create", {
      method: "POST",
      body: JSON.stringify({ path: dirs.target, name: "created.txt", content: "created through api\n" })
    });
    snapshots.targetAfterCreate = await listFolder(baseUrl, dirs.target);
    snapshots.targetWarmAfterCreate = await listFolder(baseUrl, dirs.target);

    snapshots.targetWarmBeforeCopy = await warmFolder(baseUrl, dirs.target);
    const copy = await requestJson(baseUrl, "/api/copy", {
      method: "POST",
      body: JSON.stringify({ paths: [path.join(dirs.copySource, "copy-me.txt")], targetDir: dirs.target })
    });
    snapshots.targetAfterCopy = await listFolder(baseUrl, dirs.target);
    snapshots.targetWarmAfterCopy = await listFolder(baseUrl, dirs.target);

    snapshots.moveSourceWarmBefore = await warmFolder(baseUrl, dirs.moveSource);
    snapshots.moveTargetWarmBefore = await warmFolder(baseUrl, dirs.moveTarget);
    const move = await requestJson(baseUrl, "/api/move", {
      method: "POST",
      body: JSON.stringify({ paths: [path.join(dirs.moveSource, "move-me.txt")], targetDir: dirs.moveTarget })
    });
    snapshots.moveSourceAfter = await listFolder(baseUrl, dirs.moveSource);
    snapshots.moveTargetAfter = await listFolder(baseUrl, dirs.moveTarget);

    snapshots.renameWarmBefore = await warmFolder(baseUrl, dirs.renameDir);
    const rename = await requestJson(baseUrl, "/api/rename", {
      method: "POST",
      body: JSON.stringify({ path: path.join(dirs.renameDir, "before.txt"), name: "after.txt" })
    });
    snapshots.renameAfter = await listFolder(baseUrl, dirs.renameDir);

    snapshots.deleteWarmBefore = await warmFolder(baseUrl, dirs.deleteDir);
    const deleteResult = await requestJson(baseUrl, "/api/delete", {
      method: "POST",
      body: JSON.stringify({ paths: [path.join(dirs.deleteDir, "delete-me.txt")] })
    });
    snapshots.deleteAfter = await listFolder(baseUrl, dirs.deleteDir);

    snapshots.syncRightWarmBefore = await warmFolder(baseUrl, dirs.syncRight);
    const sync = await requestJson(baseUrl, "/api/sync", {
      method: "POST",
      body: JSON.stringify({
        leftPath: dirs.syncLeft,
        rightPath: dirs.syncRight,
        direction: "leftToRight",
        overwrite: false,
        mirrorDeletes: false,
        items: ["fresh.txt"]
      })
    });
    snapshots.syncRightAfter = await listFolder(baseUrl, dirs.syncRight);

    check(checks, "warm-cache-established", snapshots.targetWarmBeforeCreate.cache?.hit === true, `hit=${snapshots.targetWarmBeforeCreate.cache?.hit}.`);
    check(checks, "create-active-invalidation", operationInvalidated(create.operation), JSON.stringify(create.operation?.result?.cacheInvalidation || null));
    check(checks, "create-next-list-miss", snapshots.targetAfterCreate.cache?.hit !== true && snapshots.targetAfterCreate.names.includes("created.txt"), `hit=${snapshots.targetAfterCreate.cache?.hit}; names=${snapshots.targetAfterCreate.names.join(",")}.`);
    check(checks, "create-rewarm-hit", snapshots.targetWarmAfterCreate.cache?.hit === true, `hit=${snapshots.targetWarmAfterCreate.cache?.hit}.`);

    check(checks, "copy-active-invalidation", operationInvalidated(copy.operation), JSON.stringify(copy.operation?.result?.cacheInvalidation || null));
    check(checks, "copy-next-list-miss", snapshots.targetAfterCopy.cache?.hit !== true && snapshots.targetAfterCopy.names.includes("copy-me.txt"), `hit=${snapshots.targetAfterCopy.cache?.hit}; names=${snapshots.targetAfterCopy.names.join(",")}.`);
    check(checks, "copy-rewarm-hit", snapshots.targetWarmAfterCopy.cache?.hit === true, `hit=${snapshots.targetWarmAfterCopy.cache?.hit}.`);

    check(checks, "move-active-invalidation", operationInvalidated(move.operation), JSON.stringify(move.operation?.result?.cacheInvalidation || null));
    check(checks, "move-source-next-list-miss", snapshots.moveSourceAfter.cache?.hit !== true && !snapshots.moveSourceAfter.names.includes("move-me.txt"), `hit=${snapshots.moveSourceAfter.cache?.hit}; names=${snapshots.moveSourceAfter.names.join(",")}.`);
    check(checks, "move-target-next-list-miss", snapshots.moveTargetAfter.cache?.hit !== true && snapshots.moveTargetAfter.names.includes("move-me.txt"), `hit=${snapshots.moveTargetAfter.cache?.hit}; names=${snapshots.moveTargetAfter.names.join(",")}.`);

    check(checks, "rename-active-invalidation", operationInvalidated(rename.operation), JSON.stringify(rename.operation?.result?.cacheInvalidation || null));
    check(checks, "rename-next-list-miss", snapshots.renameAfter.cache?.hit !== true && snapshots.renameAfter.names.includes("after.txt") && !snapshots.renameAfter.names.includes("before.txt"), `hit=${snapshots.renameAfter.cache?.hit}; names=${snapshots.renameAfter.names.join(",")}.`);

    check(checks, "delete-active-invalidation", operationInvalidated(deleteResult.operation), JSON.stringify(deleteResult.operation?.result?.cacheInvalidation || null));
    check(checks, "delete-next-list-miss", snapshots.deleteAfter.cache?.hit !== true && !snapshots.deleteAfter.names.includes("delete-me.txt"), `hit=${snapshots.deleteAfter.cache?.hit}; names=${snapshots.deleteAfter.names.join(",")}.`);

    check(checks, "sync-active-invalidation", operationInvalidated(sync.operation), JSON.stringify(sync.operation?.result?.cacheInvalidation || null));
    check(checks, "sync-next-list-miss", snapshots.syncRightAfter.cache?.hit !== true && snapshots.syncRightAfter.names.includes("fresh.txt"), `hit=${snapshots.syncRightAfter.cache?.hit}; names=${snapshots.syncRightAfter.names.join(",")}.`);

    const summary = summaryFor(checks);
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixture: dirs,
      operations: {
        create: create.operation?.result?.cacheInvalidation || null,
        copy: copy.operation?.result?.cacheInvalidation || null,
        move: move.operation?.result?.cacheInvalidation || null,
        rename: rename.operation?.result?.cacheInvalidation || null,
        delete: deleteResult.operation?.result?.cacheInvalidation || null,
        sync: sync.operation?.result?.cacheInvalidation || null
      },
      snapshots,
      checks,
      summary
    };

    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`operation listing cache invalidation: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
  const checks = [{ id: "operation-listing-cache-error", status: "fail", detail: error.stack || error.message }];
  const summary = summaryFor(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    runRoot,
    serverOutput: serverOutput.slice(-4000),
    checks,
    summary
  };
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => {});
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8").catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
