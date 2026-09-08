import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { durableWrite, encodeEditableText, replaceFileTransaction } from "../filesystem-integrity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
const fixture = await fs.mkdtemp(path.join(root, "artifacts", "backend-integrity-"));
const files = path.join(fixture, "files");
const appData = path.join(fixture, "appdata");
await fs.mkdir(files);
const checks = [];
let child;
let serverOutput = "";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => { const next = probe.address().port; probe.close(() => resolve(next)); });
});
const base = `http://127.0.0.1:${port}`;
const exists = target => fs.lstat(target).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error));
async function request(route, body) {
  const response = await fetch(base + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  return { status: response.status, data: await response.json() };
}
async function start(extra = {}) {
  child = spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), EXPLORE_BETTER_APP_DATA_ROOT: appData, EXPLORE_BETTER_WORKSPACE_ROOT: files, EXPLORE_BETTER_DISABLE_STATE_WATCH: "1", ...extra }
  });
  child.stdout.on("data", chunk => serverOutput += chunk);
  child.stderr.on("data", chunk => serverOutput += chunk);
  for (let count = 0; count < 120; count++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${serverOutput}`);
    try { if ((await request("/api/roots")).status === 200) return; } catch {}
    await delay(100);
  }
  throw new Error("Server startup timed out");
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const finished = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGKILL");
  await Promise.race([finished, delay(3000)]);
  child = null;
}
function pass(name, evidence = {}) { checks.push({ name, pass: true, ...evidence }); console.log(`PASS ${name}`); }
async function undo(operationId) { const result = await request("/api/operation/undo", { operationId }); assert.equal(result.status, 200, JSON.stringify(result)); return result; }

try {
  await start();
  for (const encoding of ["utf8", "utf16le", "utf16be"]) {
    const target = path.join(files, `${encoding}.txt`);
    const original = encodeEditableText("Invoice £42\r\n", { encoding, bom: true });
    await fs.writeFile(target, original);
    const preview = await request(`/api/preview?path=${encodeURIComponent(target)}`);
    assert.equal(preview.data.content, "Invoice £42\r\n");
    const unchanged = await request("/api/text/save", { path: target, content: preview.data.content, expectedModified: preview.data.modified });
    assert.equal(unchanged.status, 200, JSON.stringify(unchanged));
    assert.deepEqual(await fs.readFile(target), original);
    const edit = await request("/api/text/save", { path: target, content: "Updated £84\r\n", expectedModified: unchanged.data.modified });
    assert.equal(edit.status, 200, JSON.stringify(edit));
    assert.deepEqual(await fs.readFile(target), encodeEditableText("Updated £84\r\n", { encoding, bom: true }));
    await undo(edit.data.operation.id);
    assert.deepEqual(await fs.readFile(target), original);
    pass(`${encoding} BOM survives unchanged save, edit and byte-exact Undo`);
  }

  const malformed = path.join(files, "invalid-encoding.txt");
  const malformedBytes = Buffer.from([0xff, 0x81, 0x42]);
  await fs.writeFile(malformed, malformedBytes);
  assert.equal((await request(`/api/preview?path=${encodeURIComponent(malformed)}`)).data.type, "binary");
  assert.equal((await request("/api/text/save", { path: malformed, content: "replacement" })).status, 500);
  assert.deepEqual(await fs.readFile(malformed), malformedBytes);
  pass("Unsupported text encoding cannot silently overwrite original bytes");

  const conflictText = path.join(files, "undo-conflict.txt");
  await fs.writeFile(conflictText, "original");
  const saved = await request("/api/text/save", { path: conflictText, content: "saved" });
  await fs.writeFile(conflictText, "external edit");
  assert.equal((await request("/api/operation/undo", { operationId: saved.data.operation.id })).status, 500);
  assert.equal(await fs.readFile(conflictText, "utf8"), "external edit");
  assert.equal(await fs.readFile(saved.data.operation.undo.backup, "utf8"), "original");
  pass("Undo preserves a later external edit and original backup");
  assert.equal((await fs.readdir(files)).some(name => name.startsWith(".explore-better-backup-")), false);
  assert.ok(saved.data.operation.undo.backup.startsWith(path.join(appData, "Trash")));
  pass("Retained file backups stay in managed App Trash instead of cluttering the folder");

  const emptyZip = Buffer.from("504b0506000000000000000000000000000000000000", "hex");
  const archive = path.join(files, "archive.zip");
  await fs.writeFile(archive, emptyZip);
  assert.equal((await request("/api/archive/create", { paths: [archive], targetDir: files, name: "archive.zip", overwrite: true })).status, 500);
  assert.deepEqual(await fs.readFile(archive), emptyZip);
  pass("ZIP overwrite rejects using the selected source as destination");
  const zippedSource = path.join(files, "archive-input-東京-£.txt");
  await fs.writeFile(zippedSource, "archive contents");
  const created = await request("/api/archive/create", { paths: [zippedSource], targetDir: files, name: "archive.zip", overwrite: true });
  assert.equal(created.status, 200, JSON.stringify(created));
  const zipListing = await request(`/api/archive/list?path=${encodeURIComponent(archive)}`);
  assert.equal(zipListing.status, 200);
  assert.ok(zipListing.data.entries.some(entry => entry.name === path.basename(zippedSource)));
  await undo(created.data.operation.id);
  assert.deepEqual(await fs.readFile(archive), emptyZip);
  pass("ZIP overwrite preserves Unicode input names and keeps a byte-exact original for Undo");

  const directoryZip = path.join(files, "directory.zip");
  await fs.mkdir(directoryZip);
  await fs.writeFile(path.join(directoryZip, "keep.txt"), "keep");
  assert.equal((await request("/api/archive/create", { paths: [zippedSource], targetDir: files, name: "directory.zip", overwrite: true })).status, 500);
  assert.equal(await fs.readFile(path.join(directoryZip, "keep.txt"), "utf8"), "keep");
  pass("ZIP overwrite never recursively removes a directory");

  for (const extension of ["html", "svg"]) {
    const inert = path.join(files, `inert.${extension}`);
    await fs.writeFile(inert, extension === "html" ? "<!doctype html><p>Inert fixture</p>" : '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const response = await fetch(`${base}/api/raw?path=${encodeURIComponent(inert)}`);
    const policy = response.headers.get("content-security-policy");
    assert.match(policy, /(?:^|;)\s*sandbox(?:;|$)/);
    assert.doesNotMatch(policy, /allow-scripts|allow-same-origin/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    if (extension === "html") assert.equal(response.headers.get("content-disposition"), "attachment");
    await response.body.cancel();
  }
  pass("Raw HTML/SVG response headers isolate active content (header assertions only)");

  const searchRoot = path.join(files, "search");
  const outsideRoot = path.join(files, "outside");
  await fs.mkdir(searchRoot); await fs.mkdir(outsideRoot);
  await Promise.all(Array.from({ length: 20 }, (_, index) => fs.writeFile(path.join(searchRoot, `document-${index}.txt`), "needle ".repeat(1000))));
  await fs.writeFile(path.join(outsideRoot, "outside.txt"), "outside needle");
  await fs.symlink(outsideRoot, path.join(searchRoot, "shortcut"), process.platform === "win32" ? "junction" : "dir");
  const searched = await request("/api/search", { path: searchRoot, query: "no-filename-can-match", content: "needle" });
  assert.equal(searched.status, 200, JSON.stringify(searched));
  assert.equal(searched.data.contentScanned, 0);
  assert.equal(searched.data.entries.length, 0);
  pass("Combined search skips all content reads for excluded filenames");
  for (const [route, body] of [
    ["/api/search", { path: searchRoot, content: "needle" }],
    ["/api/duplicates", { path: searchRoot, mode: "hash" }],
    ["/api/properties", { paths: [searchRoot], recursive: true }],
    ["/api/compare", { leftPath: searchRoot, rightPath: outsideRoot }]
  ]) {
    const response = await request(route, body);
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(JSON.stringify(response.data).includes("shortcut\\\\outside.txt"), false);
    if (route === "/api/properties") assert.equal(response.data.summary.files, 20);
  }
  pass("Recursive reports skip junction descendants instead of escaping the selected tree");

  const folder = path.join(files, "copy-root");
  await fs.mkdir(folder); await fs.writeFile(path.join(folder, "keep.txt"), "keep");
  const alias = path.join(files, "copy-alias");
  await fs.symlink(folder, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await request("/api/copy", { paths: [folder], targetDir: alias })).status, 500);
  assert.deepEqual(await fs.readdir(folder), ["keep.txt"]);
  pass("Copy rejects a junction target resolving inside its own source");

  const moveTarget = path.join(files, "same-volume-target"); await fs.mkdir(moveTarget);
  const moveFolder = path.join(files, "same-volume-folder"); await fs.mkdir(moveFolder);
  for (let start = 0; start < 2000; start += 50) await Promise.all(Array.from({ length: 50 }, (_, offset) => fs.writeFile(path.join(moveFolder, `file-${start + offset}.txt`), "")));
  const started = performance.now();
  const moved = await request("/api/move", { paths: [moveFolder], targetDir: moveTarget });
  const moveMs = performance.now() - started;
  assert.equal(moved.status, 200, JSON.stringify(moved));
  assert.equal(moved.data.operation.events.some(event => event.phase === "Scanning"), false);
  pass("Same-volume folder move avoids the recursive prescan", { files: 2000, moveMs });

  await stop();
  await start({ EB_TEST_FAIL_STAGING_RENAME: "1" });
  assert.equal((await request("/api/text/save", { path: conflictText, content: "failed write" })).status, 500);
  assert.equal(await fs.readFile(conflictText, "utf8"), "external edit");
  assert.equal((await request("/api/archive/create", { paths: [zippedSource], targetDir: files, name: "archive.zip", overwrite: true })).status, 500);
  assert.deepEqual(await fs.readFile(archive), emptyZip);
  pass("Injected editor and ZIP commit failures preserve the prior files");
  await stop();

  await start({ EB_TEST_FORCE_CROSS_VOLUME_MOVE: "1", EB_TEST_FAIL_SOURCE_REMOVAL: "1" });
  const pending = [];
  for (const scenario of ["unchanged", "source-changed", "destination-changed", "directory-added"]) {
    const scenarioRoot = path.join(files, scenario); await fs.mkdir(scenarioRoot);
    const destDir = path.join(scenarioRoot, "destination"); await fs.mkdir(destDir);
    const source = path.join(scenarioRoot, scenario === "directory-added" ? "folder" : "source.txt");
    if (scenario === "directory-added") { await fs.mkdir(source); await fs.writeFile(path.join(source, "original.txt"), "original"); }
    else await fs.writeFile(source, "original");
    assert.equal((await request("/api/move", { paths: [source], targetDir: destDir })).status, 500);
    const state = (await request("/api/state")).data;
    const operation = state.operations.find(item => item.type === "move" && item.retry?.body?.paths?.[0] === source);
    assert.equal(operation.result.recovery.retry.body.moveSnapshot.source.version, 1);
    pending.push({ scenario, source, dest: path.join(destDir, path.basename(source)), operationId: operation.id });
  }
  await stop();
  await fs.writeFile(pending[1].source, "external source change");
  await fs.writeFile(pending[2].dest, "external destination change");
  await fs.writeFile(path.join(pending[3].source, "added-after-copy.txt"), "new contents");
  await start();
  for (const item of pending) {
    const resumed = await request("/api/operation/retry-remaining", { operationId: item.operationId });
    assert.equal(resumed.status, item.scenario === "unchanged" ? 200 : 500, JSON.stringify(resumed));
    assert.equal(await exists(item.source), item.scenario !== "unchanged");
  }
  pass("Restart recovery removes only unchanged committed move sources; changed files and added descendants survive");
  await stop();

  const renameRoot = path.join(files, "rename"); await fs.mkdir(renameRoot);
  const renamePaths = [path.join(renameRoot, "a.txt"), path.join(renameRoot, "b.txt")];
  await fs.writeFile(renamePaths[0], "original A"); await fs.writeFile(renamePaths[1], "original B");
  await start();
  assert.equal((await request("/api/bulk-rename", { paths: [renameRoot, renamePaths[0]], options: { prefix: "new-" } })).status, 500);
  assert.equal(await fs.readFile(renamePaths[0], "utf8"), "original A");
  pass("Bulk rename rejects overlapping parent/child selections before staging");
  await stop();
  await start({ EB_TEST_OPERATION_DELAY_MS: "30000", EB_TEST_OPERATION_DELAY_AFTER_ITEMS: "1" });
  const inFlight = request("/api/bulk-rename", { paths: renamePaths, options: { prefix: "new-" } }).catch(() => null);
  let interrupted;
  for (let count = 0; count < 100; count++) {
    const state = (await request("/api/state")).data;
    interrupted = state.operations.find(item => item.type === "bulk-rename" && item.undo?.type === "bulk-rename-recover" && item.undo.items.some(entry => entry.phase === "staged"));
    if (interrupted) break;
    await delay(50);
  }
  assert.ok(interrupted, "Bulk rename must persist its mapping before the crash point");
  await stop(); await inFlight;
  await start();
  await undo(interrupted.id);
  assert.equal(await fs.readFile(renamePaths[0], "utf8"), "original A");
  assert.equal(await fs.readFile(renamePaths[1], "utf8"), "original B");
  assert.deepEqual((await fs.readdir(renameRoot)).sort(), ["a.txt", "b.txt"]);
  pass("Bulk rename crash journal restores original names and bytes after restart");
  await stop();

  const writerTarget = path.join(files, "writer-failure.txt"); await fs.writeFile(writerTarget, "preserve");
  await assert.rejects(replaceFileTransaction(writerTarget, async staging => { await durableWrite(staging, Buffer.from("partial")); throw new Error("injected writer failure"); }), /injected writer failure/);
  assert.equal(await fs.readFile(writerTarget, "utf8"), "preserve");
  pass("A staging writer failure never truncates the destination");

  process.env.HOST = "127.0.0.1"; process.env.PORT = String(port);
  process.env.EXPLORE_BETTER_APP_DATA_ROOT = path.join(fixture, "direct-appdata");
  process.env.EXPLORE_BETTER_WORKSPACE_ROOT = files;
  process.env.EXPLORE_BETTER_DISABLE_STATE_WATCH = "1";
  const backend = await import("../server.mjs");
  try {
    const large = path.join(files, "cancel-hash.bin"); await fs.writeFile(large, Buffer.alloc(16 * 1024 * 1024, 7));
    const controller = new AbortController();
    const hashing = backend.checksumReport({ paths: [large] }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 1);
    await assert.rejects(hashing, error => error.name === "AbortError");
    for (const task of [
      signal => backend.advancedSearch({ path: searchRoot, query: "cancel-unique", signal }),
      signal => backend.duplicateFiles({ path: searchRoot, mode: "hash" }, { signal }),
      signal => backend.compareDirectories({ leftPath: searchRoot, rightPath: outsideRoot }, { signal }),
      signal => backend.propertiesReport({ paths: [searchRoot] }, { signal })
    ]) {
      const canceled = new AbortController(); canceled.abort();
      await assert.rejects(task(canceled.signal), error => error.name === "AbortError");
    }
    pass("Hashing cancels in flight and canceled report calls do not continue work");
  } finally { await backend.stopServer(); }
} catch (error) {
  checks.push({ name: "Unexpected failure", pass: false, error: error.stack || String(error) });
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  await stop();
  const report = { generatedAt: new Date().toISOString(), fixture, checks, summary: { passed: checks.filter(item => item.pass).length, failed: checks.filter(item => !item.pass).length }, serverOutput: serverOutput.slice(-4000) };
  await fs.writeFile(path.join(root, "artifacts", "backend-integrity-latest.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`Backend integrity: ${report.summary.passed} pass, ${report.summary.failed} fail`);
}
