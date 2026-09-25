import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "eb-rename-retry-"));
const files = path.join(fixture, "files");
const appData = path.join(fixture, "appdata");
await fs.mkdir(files);
await fs.mkdir(appData);
process.env.EXPLORE_BETTER_APP_DATA_ROOT = appData;
process.env.EXPLORE_BETTER_WORKSPACE_ROOT = files;
process.env.EXPLORE_BETTER_DISABLE_STATE_WATCH = "1";
process.env.HOST = "127.0.0.1";
process.env.PORT = String(await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
}));

const checks = [];
async function test(name, task) {
  try { await task(); checks.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { checks.push({ name, pass: false, error: error.stack }); console.error(`FAIL ${name}: ${error.stack}`); }
}

const now = new Date().toISOString();
const retryDir = path.join(files, "retry-source");
const retryBlocker = path.join(files, "retry-blocker.txt");
await fs.mkdir(retryDir); await fs.writeFile(retryBlocker, "not a folder");
const retryPaths = [];
for (let index = 0; index < 1200; index += 1) {
  const itemPath = path.join(retryDir, `item-${String(index).padStart(4, "0")}.txt`);
  await fs.writeFile(itemPath, String(index));
  retryPaths.push(itemPath);
}
const smallTarget = path.join(files, "small-target");
await fs.mkdir(smallTarget);
const smallPaths = retryPaths.slice(0, 5);
const undoDir = path.join(files, "undo-partial");
await fs.mkdir(undoDir);
const undoMoved = path.join(undoDir, "moved-elsewhere.txt");
const undoOriginal = path.join(undoDir, "original.txt");
await fs.writeFile(undoMoved, "restore me");
const createdGone = path.join(undoDir, "created-already-trashed");
const createdPresent = path.join(undoDir, "created-present");
await fs.mkdir(createdPresent);
const elevationDir = path.join(files, "elevation");
const doomed = path.join(elevationDir, "doomed");
const victim = path.join(elevationDir, "victim");
const tampered = path.join(elevationDir, "tampered");
await fs.mkdir(doomed, { recursive: true }); await fs.mkdir(victim); await fs.mkdir(tampered);
await fs.writeFile(path.join(victim, "keep.txt"), "must survive");
await fs.writeFile(path.join(doomed, "own.txt"), "delete me");
await fs.mkdir(path.join(doomed, "nested"));
await fs.writeFile(path.join(doomed, "nested", "readonly.txt"), "read only");
await fs.chmod(path.join(doomed, "nested", "readonly.txt"), 0o444);
await fs.symlink(victim, path.join(doomed, "link-to-victim"), process.platform === "win32" ? "junction" : "dir");
await fs.writeFile(path.join(tampered, "keep.txt"), "tamper target");

function failedOperation(id, type, body, recoveryRetry) {
  return {
    id, type, label: id, status: "failed", createdAt: now, startedAt: now, finishedAt: now, error: "Access is denied.", undo: null, progress: null,
    retry: { type, body, createdAt: now }, retryOf: null,
    result: recoveryRetry ? {
      error: "Access is denied.",
      recovery: { type, completedCount: 0, remainingCount: body.paths.length, completed: [], remaining: body.paths.map((itemPath, index) => ({ index, path: itemPath, name: path.basename(itemPath) })), retry: { type, body }, canRetryRemaining: true }
    } : null
  };
}
await fs.writeFile(path.join(appData, "state.json"), JSON.stringify({
  operations: [
    failedOperation("failed-large-copy", "copy", { paths: retryPaths, targetDir: path.join(retryBlocker, "inside") }, true),
    failedOperation("failed-small-copy", "copy", { paths: smallPaths, targetDir: smallTarget }, true),
    failedOperation("failed-junction-delete", "delete", { paths: [doomed] }),
    failedOperation("failed-tampered-delete", "delete", { paths: [tampered] }),
    { id: "partial-move-back", type: "move", label: "move", status: "completed", createdAt: now, undo: { type: "move-back", items: [
      { from: path.join(undoDir, "already-restored.txt"), to: path.join(undoDir, "already-restored-original.txt") },
      { from: undoMoved, to: undoOriginal }
    ] } },
    { id: "partial-trash-created", type: "mkdir", label: "mkdir", status: "completed", createdAt: now, undo: { type: "trash-created", items: [{ path: createdGone }, { path: createdPresent }] } }
  ]
}));

const backend = await import("../server.mjs");
const server = await backend.startServer();
const base = `http://127.0.0.1:${server.address().port}`;
async function post(route, body) {
  const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  return { status: response.status, data: await response.json() };
}
async function ok(route, body) {
  const { status, data } = await post(route, body);
  assert.equal(status, 200, JSON.stringify(data));
  return data;
}

try {
  await test("Rename refuses to replace an existing file", async () => {
    const source = path.join(files, "a.txt"), target = path.join(files, "b.txt");
    await fs.writeFile(source, "A"); await fs.writeFile(target, "B");
    const { status, data } = await post("/api/rename", { path: source, name: "b.txt" });
    assert.notEqual(status, 200);
    assert.match(data.error, /already exists/);
    assert.equal(await fs.readFile(target, "utf8"), "B");
    assert.equal(await fs.readFile(source, "utf8"), "A");
  });

  await test("Rename refuses to replace an existing folder with a folder", async () => {
    const source = path.join(files, "folder-a"), target = path.join(files, "folder-b");
    await fs.mkdir(source); await fs.mkdir(target); await fs.writeFile(path.join(target, "inside.txt"), "kept");
    const { status } = await post("/api/rename", { path: source, name: "folder-b" });
    assert.notEqual(status, 200);
    assert.equal(await fs.readFile(path.join(target, "inside.txt"), "utf8"), "kept");
  });

  await test("Case-only rename succeeds and its undo restores the original case", async () => {
    const source = path.join(files, "case.txt");
    await fs.writeFile(source, "case");
    const renamed = await ok("/api/rename", { path: source, name: "CASE.txt" });
    assert.ok((await fs.readdir(files)).includes("CASE.txt"));
    await ok("/api/operation/undo", { operationId: renamed.operation.id });
    const names = await fs.readdir(files);
    assert.ok(names.includes("case.txt"), names.join(","));
    assert.ok(!names.some((name) => /^case copy/i.test(name)), names.join(","));
  });

  await test("Rename undo does not replace a file created at the original name", async () => {
    const source = path.join(files, "undo-src.txt");
    await fs.writeFile(source, "renamed bytes");
    const renamed = await ok("/api/rename", { path: source, name: "undo-dest.txt" });
    await fs.writeFile(source, "newer bytes");
    await ok("/api/operation/undo", { operationId: renamed.operation.id });
    assert.equal(await fs.readFile(source, "utf8"), "newer bytes");
    assert.equal(await fs.readFile(path.join(files, "undo-src copy 2.txt"), "utf8"), "renamed bytes");
  });

  await test("Bulk rename refuses a target owned by a selected unchanged item", async () => {
    const dir = path.join(files, "bulk"); await fs.mkdir(dir);
    const x = path.join(dir, "x.txt"), y = path.join(dir, "y.txt");
    await fs.writeFile(x, "X"); await fs.writeFile(y, "Y");
    const body = { paths: [x, y], options: { find: "x", replace: "y" } };
    const preview = await ok("/api/bulk-rename/preview", body);
    assert.equal(preview.canApply, false);
    assert.equal(preview.items.find((item) => item.source === x).status, "collision");
    assert.equal(preview.items.find((item) => item.source === y).status, "unchanged");
    const { status } = await post("/api/bulk-rename", body);
    assert.notEqual(status, 200);
    assert.equal(await fs.readFile(y, "utf8"), "Y");
    assert.equal(await fs.readFile(x, "utf8"), "X");
  });

  await test("Bulk rename still allows chained renames into vacated names", async () => {
    const dir = path.join(files, "bulk-chain"); await fs.mkdir(dir);
    const one = path.join(dir, "1.txt"), two = path.join(dir, "2.txt");
    await fs.writeFile(one, "one"); await fs.writeFile(two, "two");
    await ok("/api/bulk-rename", { paths: [one, two], options: { numberPosition: "prefix", numberStart: 2, numberPad: 1, numberSeparator: "", find: "^\\d+", replace: "", useRegex: true } });
    assert.equal(await fs.readFile(path.join(dir, "2.txt"), "utf8"), "one");
    assert.equal(await fs.readFile(path.join(dir, "3.txt"), "utf8"), "two");
  });

  await test("Retry metadata keeps every path beyond 500 items", async () => {
    const { status } = await post("/api/operation/retry-remaining", { operationId: "failed-large-copy" });
    assert.equal(status, 500);
    const state = await (await fetch(`${base}/api/state`)).json();
    const retried = state.operations.find((item) => item.retryOf === "failed-large-copy");
    assert.equal(retried?.status, "failed");
    assert.equal(retried.retry.body.paths.length, 1200);
    assert.deepEqual(retried.retry.body.paths, retryPaths);
    const indexes = Array.from({ length: 700 }, (_, index) => index);
    assert.equal((await post("/api/operation/retry-selected", { operationId: "failed-large-copy", indexes })).status, 500);
    const selected = (await (await fetch(`${base}/api/state`)).json()).operations.find((item) => item.retryOf === "failed-large-copy" && item.id !== retried.id);
    assert.equal(selected?.retry.body.paths.length, 700);
  });

  await test("Concurrent retry-remaining requests queue only one retry", async () => {
    const [first, second] = await Promise.all([
      post("/api/operation/retry-remaining", { operationId: "failed-small-copy" }),
      post("/api/operation/retry-remaining", { operationId: "failed-small-copy" })
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 500], JSON.stringify([first.data.error, second.data.error]));
    assert.match((first.status === 200 ? second : first).data.error, /already in progress/);
    const copied = await fs.readdir(smallTarget);
    assert.deepEqual(copied.sort(), smallPaths.map((itemPath) => path.basename(itemPath)).sort());
    const again = await post("/api/operation/retry-remaining", { operationId: "failed-small-copy" });
    assert.equal(again.status, 500);
    assert.match(again.data.error, /already been retried/);
  });

  await test("Undo move-back skips items that were already restored", async () => {
    await ok("/api/operation/undo", { operationId: "partial-move-back" });
    assert.equal(await fs.readFile(undoOriginal, "utf8"), "restore me");
  });

  await test("Undo trash-created skips items that are already gone", async () => {
    await ok("/api/operation/undo", { operationId: "partial-trash-created" });
    await assert.rejects(fs.lstat(createdPresent), { code: "ENOENT" });
  });

  if (process.platform === "win32") {
    const runHelper = (plan, hash = plan.payloadSha256) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", plan.scriptPath, "-PayloadPath", plan.payloadPath, "-PayloadSha256", hash], { encoding: "utf8", windowsHide: true, timeout: 60000 });

    await test("Elevated delete helper removes junctions without deleting their targets", async () => {
      const plan = await ok("/api/operation/elevated-retry", { operationId: "failed-junction-delete", launch: false });
      assert.match(await fs.readFile(plan.launcherPath, "utf8"), new RegExp(plan.payloadSha256));
      const run = runHelper(plan);
      assert.equal(run.status, 0, run.stderr || run.stdout);
      await assert.rejects(fs.lstat(doomed), { code: "ENOENT" });
      assert.equal(await fs.readFile(path.join(victim, "keep.txt"), "utf8"), "must survive");
      const log = JSON.parse((await fs.readFile(plan.logPath, "utf8")).replace(/^﻿/, ""));
      assert.equal(log.errors?.length ?? 0, 0, JSON.stringify(log.errors));
    });

    await test("Elevated helper refuses a payload that no longer matches the command-line hash", async () => {
      const plan = await ok("/api/operation/elevated-retry", { operationId: "failed-tampered-delete", launch: false });
      const payload = JSON.parse(await fs.readFile(plan.payloadPath, "utf8"));
      payload.items[0].path = victim;
      await fs.writeFile(plan.payloadPath, JSON.stringify(payload, null, 2));
      await fs.rm(plan.manifestPath);
      const run = runHelper(plan);
      assert.notEqual(run.status, 0);
      assert.match(run.stderr + run.stdout, /hash mismatch/);
      assert.equal(await fs.readFile(path.join(victim, "keep.txt"), "utf8"), "must survive");
      assert.equal(await fs.readFile(path.join(tampered, "keep.txt"), "utf8"), "tamper target");
    });
  }
} finally {
  await backend.stopServer();
  await fs.rm(fixture, { recursive: true, force: true }).catch(() => {});
}
console.log(`Rename/retry safety: ${checks.filter((item) => item.pass).length} passed, ${checks.filter((item) => !item.pass).length} failed.`);
process.exit(checks.some((item) => !item.pass) ? 1 : 0);
