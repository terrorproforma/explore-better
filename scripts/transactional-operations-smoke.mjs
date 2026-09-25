import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const data = JSON.parse((await response.text()) || "{}");
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function startServer({ port, appData, env = {} }) {
  const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output.join("")}`);
    try {
      await requestJson(`http://127.0.0.1:${port}`, "/api/roots");
      return { child, output };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Server startup timed out: ${output.join("")}`);
}

async function stopServer(server) {
  const child = server?.child;
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}

async function partialPaths(directory) {
  const names = await fs.readdir(directory);
  return names.filter((name) => name.includes(".explore-better-") && name.endsWith(".partial"));
}

async function main() {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "explore-better-transactions-"));
  const appData = path.join(fixture, "appdata");
  const sourceRoot = path.join(fixture, "source");
  const targetRoot = path.join(fixture, "target");
  await fs.mkdir(path.join(sourceRoot, "project"), { recursive: true });
  await fs.mkdir(path.join(targetRoot, "project"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "project", "new.txt"), "new bytes\n");
  await fs.writeFile(path.join(targetRoot, "project", "original.txt"), "original bytes\n");
  const checks = [];
  let server;
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    server = await startServer({ port, appData, env: { EB_TEST_FAIL_STAGING_RENAME: "1" } });
    const transferBody = {
      paths: [path.join(sourceRoot, "project")],
      targetDir: targetRoot,
      mode: "copy",
      conflictMode: "overwrite"
    };
    const preview = await requestJson(baseUrl, "/api/transfer/preview", { method: "POST", body: JSON.stringify(transferBody) });
    await requestJson(baseUrl, "/api/transfer", {
      method: "POST",
      body: JSON.stringify({ ...transferBody, expectedPlanDigest: preview.planDigest })
    }).catch(() => null);
    const transferState = await requestJson(baseUrl, "/api/state");
    const failedTransfer = transferState.operations?.find((operation) => operation.type === "transfer");
    assert(failedTransfer?.status === "failed", "Injected staging rename should fail the transfer operation.");
    assert((await fs.readFile(path.join(targetRoot, "project", "original.txt"), "utf8")) === "original bytes\n", "Overwrite failure must restore original bytes.");
    assert(!(await fs.stat(path.join(targetRoot, "project", "new.txt")).then(() => true).catch(() => false)), "Failed overwrite must not expose staged bytes.");
    assert((await partialPaths(targetRoot)).length === 0, "Failed overwrite must remove sibling staging paths.");
    checks.push({ name: "directory overwrite rollback restores original byte-for-byte", pass: true });

    const stagedCopySource = path.join(sourceRoot, "staged-copy.txt");
    await fs.writeFile(stagedCopySource, "staged copy\n");
    await requestJson(baseUrl, "/api/copy", {
      method: "POST",
      body: JSON.stringify({ paths: [stagedCopySource], targetDir: targetRoot })
    }).catch(() => null);
    const stagedCopyState = await requestJson(baseUrl, "/api/state");
    const failedStagedCopy = stagedCopyState.operations?.find((operation) => operation.type === "copy");
    assert(failedStagedCopy?.status === "failed", "Injected staging rename should fail the copy operation.");
    assert(failedStagedCopy?.result?.transaction?.phase === "staging-failed", "Copy failure must keep the staging transaction record.");
    assert(failedStagedCopy?.result?.recovery?.remainingCount === 1, "Copy failure must report the remaining item.");
    assert((await partialPaths(targetRoot)).length === 0, "Failed copy must remove sibling staging paths.");
    checks.push({ name: "copy staging failure keeps transaction and recovery details", pass: true });
  } finally {
    await stopServer(server);
    server = null;
  }

  const moveSource = path.join(sourceRoot, "cross-volume.txt");
  const moveTarget = path.join(targetRoot, "cross-volume.txt");
  await fs.writeFile(moveSource, "move once\n");
  try {
    server = await startServer({
      port,
      appData,
      env: { EB_TEST_FORCE_CROSS_VOLUME_MOVE: "1", EB_TEST_FAIL_SOURCE_REMOVAL: "1" }
    });
    await requestJson(baseUrl, "/api/move", {
      method: "POST",
      body: JSON.stringify({ paths: [moveSource], targetDir: targetRoot })
    }).catch(() => null);
    const moveState = await requestJson(baseUrl, "/api/state");
    const failedMove = moveState.operations?.find((operation) => operation.type === "move");
    assert(failedMove?.status === "failed", "Injected source removal should fail the move operation.");
    assert(await fs.stat(moveSource).then(() => true).catch(() => false), "Pending move source must remain after failed removal.");
    assert((await fs.readFile(moveTarget, "utf8")) === "move once\n", "Committed move destination must remain intact.");
    assert(failedMove?.result?.recovery?.sourceRemovalPending === true, "Recovery must record source-removal-pending.");
    assert(failedMove?.result?.recovery?.retry?.type === "move-resume", "Recovery must retry removal instead of copying again.");
    const failedOperationId = failedMove.id;
    await stopServer(server);
    server = await startServer({ port, appData, env: { EB_TEST_FORCE_CROSS_VOLUME_MOVE: "1" } });
    const resumed = await requestJson(baseUrl, "/api/operation/retry-remaining", {
      method: "POST",
      body: JSON.stringify({ operationId: failedOperationId })
    });
    assert(resumed.operation?.status === "completed", "Source-removal resume should complete.");
    assert(!(await fs.stat(moveSource).then(() => true).catch(() => false)), "Resume must remove only the pending source.");
    assert((await fs.readFile(moveTarget, "utf8")) === "move once\n", "Resume must not recopy or alter the committed destination.");
    assert((await partialPaths(targetRoot)).length === 0, "Cross-volume move must leave no staging path.");
    checks.push({ name: "cross-volume retry removes source without recopying destination", pass: true });
  } finally {
    await stopServer(server);
    server = null;
  }

  const batchTarget = path.join(fixture, "copy-batch-target");
  const batchFirst = path.join(sourceRoot, "batch-first.txt");
  const batchSecond = path.join(sourceRoot, "batch-second.txt");
  const batchThird = path.join(sourceRoot, "batch-third.txt");
  await fs.mkdir(batchTarget, { recursive: true });
  await fs.writeFile(batchFirst, "first\n");
  await fs.writeFile(batchSecond, "second\n");
  await fs.writeFile(batchThird, "third\n");
  try {
    server = await startServer({
      port,
      appData,
      env: { EB_TEST_OPERATION_DELAY_MS: "2000", EB_TEST_OPERATION_DELAY_AFTER_ITEMS: "1" }
    });
    const copyRequest = requestJson(baseUrl, "/api/copy", {
      method: "POST",
      body: JSON.stringify({ paths: [batchFirst, batchSecond, batchThird], targetDir: batchTarget })
    }).catch(() => null);
    const firstCopied = path.join(batchTarget, "batch-first.txt");
    const deadline = Date.now() + 10000;
    while (!(await fs.stat(firstCopied).then(() => true).catch(() => false))) {
      assert(Date.now() < deadline, "First batch item was not copied in time.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await fs.rm(batchSecond);
    await copyRequest;
    const batchState = await requestJson(baseUrl, "/api/state");
    const failedCopy = batchState.operations?.find((operation) => operation.type === "copy" && operation.status === "failed" && operation.result?.recovery?.completedCount === 1);
    assert(failedCopy, "Mid-batch copy failure must record the completed item.");
    const recovery = failedCopy.result.recovery;
    assert(recovery.completed[0]?.dest === firstCopied, "Recovery must list the copied destination.");
    assert(recovery.failed?.path === batchSecond, "Recovery must name the failed item.");
    assert(recovery.remainingCount === 2 && recovery.retry?.body?.paths?.length === 2, "Recovery must offer retry for the remaining items.");
    assert(failedCopy.undo?.items?.[0]?.path === firstCopied, "Undo must cover the completed copy.");
    checks.push({ name: "mid-batch copy failure keeps completed list, undo, and retry", pass: true });
  } finally {
    await stopServer(server);
    server = null;
  }

  const crossRoot = path.join(fixture, "cross");
  const crossTarget = path.join(fixture, "cross-target");
  await fs.mkdir(path.join(crossRoot, "tree", "sub"), { recursive: true });
  await fs.mkdir(crossTarget, { recursive: true });
  await fs.writeFile(path.join(crossRoot, "tree", "a.txt"), "tree a\n");
  await fs.writeFile(path.join(crossRoot, "tree", "sub", "b.txt"), "tree b\n");
  await fs.writeFile(path.join(crossRoot, "trash-me.txt"), "trash me\n");
  await fs.writeFile(path.join(crossRoot, "replace.txt"), "replacement\n");
  await fs.writeFile(path.join(crossTarget, "replace.txt"), "replaced original\n");
  try {
    server = await startServer({ port, appData, env: { EB_TEST_FORCE_CROSS_VOLUME_MOVE: "1" } });
    const moved = await requestJson(baseUrl, "/api/move", {
      method: "POST",
      body: JSON.stringify({ paths: [path.join(crossRoot, "tree")], targetDir: crossTarget })
    });
    assert(moved.operation?.status === "completed", "Cross-volume folder move should complete.");
    assert(!(await fs.stat(path.join(crossRoot, "tree")).then(() => true).catch(() => false)), "Cross-volume move must remove the verified source.");
    assert((await fs.readFile(path.join(crossTarget, "tree", "sub", "b.txt"), "utf8")) === "tree b\n", "Cross-volume move must keep nested content.");
    assert((await partialPaths(crossTarget)).length === 0, "Cross-volume folder move must leave no staging path.");

    const trashed = await requestJson(baseUrl, "/api/trash", {
      method: "POST",
      body: JSON.stringify({ paths: [path.join(crossRoot, "trash-me.txt")] })
    });
    assert(trashed.operation?.status === "completed", "Cross-volume trash should complete.");
    assert((await fs.readFile(trashed.items[0].dest, "utf8")) === "trash me\n", "Cross-volume trash must keep the trashed bytes.");

    const replaceBody = { paths: [path.join(crossRoot, "replace.txt")], targetDir: crossTarget, mode: "copy", conflictMode: "overwrite" };
    const replacePreview = await requestJson(baseUrl, "/api/transfer/preview", { method: "POST", body: JSON.stringify(replaceBody) });
    const replaced = await requestJson(baseUrl, "/api/transfer", {
      method: "POST",
      body: JSON.stringify({ ...replaceBody, expectedPlanDigest: replacePreview.planDigest })
    });
    const backup = replaced.items?.[0]?.backup;
    assert(backup && (await fs.readFile(backup, "utf8")) === "replaced original\n", "Overwrite must back up the replaced file.");
    const appTrash = await requestJson(baseUrl, "/api/app-trash");
    const backupEntry = appTrash.items?.find((item) => item.path?.toLowerCase() === backup.toLowerCase());
    assert(backupEntry?.originalPath?.toLowerCase() === path.join(crossTarget, "replace.txt").toLowerCase(), "App Trash must show the original location of overwrite backups.");
    checks.push({ name: "cross-volume move/trash verify once and App Trash maps backups", pass: true });

    const zipped = await requestJson(baseUrl, "/api/archive/create", {
      method: "POST",
      body: JSON.stringify({ paths: [path.join(crossTarget, "tree")], targetDir: crossTarget, name: "tree.zip" })
    });
    const extracted = await requestJson(baseUrl, "/api/archive/extract", {
      method: "POST",
      body: JSON.stringify({ archive: zipped.archive, targetDir: crossTarget, folderName: "unzipped" })
    });
    assert((await fs.readFile(path.join(extracted.extractedDir, "tree", "sub", "b.txt"), "utf8")) === "tree b\n", "Extraction must produce archive contents.");
    const badZip = path.join(crossTarget, "broken.zip");
    await fs.writeFile(badZip, "not a zip archive");
    await requestJson(baseUrl, "/api/archive/extract", {
      method: "POST",
      body: JSON.stringify({ archive: badZip, targetDir: crossTarget, folderName: "broken-out" })
    }).catch(() => null);
    assert(!(await fs.stat(path.join(crossTarget, "broken-out")).then(() => true).catch(() => false)), "Failed extraction must not leave a partial folder.");
    assert((await partialPaths(crossTarget)).length === 0, "Failed extraction must remove its staging folder.");
    checks.push({ name: "archive extraction stages and leaves nothing on failure", pass: true });
  } finally {
    await stopServer(server);
  }

  const report = { generatedAt: new Date().toISOString(), fixture, checks, summary: { passed: checks.length, failed: 0 } };
  const artifactDir = path.join(root, "artifacts");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, "transactional-operations-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const check of checks) console.log(`PASS ${check.name}`);
  console.log(`Transactional operations: ${checks.length} pass, 0 fail`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
