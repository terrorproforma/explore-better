import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { pathSnapshot, encodeEditableText, readEditableTextFile } from "../filesystem-integrity.mjs";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await fs.mkdtemp(path.join(workspace, "artifacts", "backend-round-two-"));
const files = path.join(fixture, "files");
await fs.mkdir(files);
process.env.EXPLORE_BETTER_APP_DATA_ROOT = path.join(fixture, "appdata");
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
  catch (error) { checks.push({ name, pass: false, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); }
}

await test("Snapshot rejects a file changed after its own hash during sibling traversal", async () => {
  const tree = path.join(files, "snapshot-edit"); await fs.mkdir(tree);
  const first = path.join(tree, "a.txt"), last = path.join(tree, "z.txt");
  await fs.writeFile(first, "old bytes"); await fs.writeFile(last, "last file");
  const original = fs.lstat; let changed = false;
  fs.lstat = async (...args) => {
    if (!changed && args[0] === last) { changed = true; await fs.writeFile(first, "new bytes that must survive"); }
    return original(...args);
  };
  try { await assert.rejects(pathSnapshot(tree), /changed while verifying transaction/); }
  finally { fs.lstat = original; }
  assert.equal(await fs.readFile(first, "utf8"), "new bytes that must survive");
});

await test("Snapshot rejects directory entries added after enumeration", async () => {
  const tree = path.join(files, "snapshot-added"); await fs.mkdir(tree);
  const first = path.join(tree, "a.txt"); await fs.writeFile(first, "original");
  const original = fs.lstat; let changed = false;
  fs.lstat = async (...args) => {
    if (!changed && args[0] === first) { changed = true; await fs.writeFile(path.join(tree, "late.txt"), "new file"); }
    return original(...args);
  };
  try { await assert.rejects(pathSnapshot(tree), /changed while verifying transaction/); }
  finally { fs.lstat = original; }
});

await test("Content reads enforce physical byte limits for encoded text", async () => {
  const target = path.join(files, "bounded-content.txt");
  const content = "A bounded UTF-16 search fixture £42";
  const bytes = encodeEditableText(content, { encoding: "utf16le", bom: true });
  await fs.writeFile(target, bytes);
  await assert.rejects(readEditableTextFile(target, { maxBytes: bytes.length - 1 }), { code: "TEXT_TOO_LARGE" });
  const read = await readEditableTextFile(target, { maxBytes: bytes.length });
  assert.equal(read.content, content);
  assert.equal(read.bytes, bytes.length);
});

await test("Canceled content reads stop before opening a file", async () => {
  const controller = new AbortController();
  const reason = new Error("Fixture search canceled");
  controller.abort(reason);
  await assert.rejects(readEditableTextFile(path.join(files, "not-created.txt"), { maxBytes: 100, signal: controller.signal }), error => error === reason);
});

const legacyDirectory = path.join(files, "legacy-now-directory.txt");
const legacyFile = path.join(files, "legacy-current.txt");
const legacyTrash = path.join(process.env.EXPLORE_BETTER_APP_DATA_ROOT, "Trash");
await fs.mkdir(legacyDirectory); await fs.mkdir(legacyTrash, { recursive: true });
await fs.writeFile(path.join(legacyDirectory, "keep.txt"), "new directory contents");
await fs.writeFile(legacyFile, "later edits");
const legacyOperations = [];
for (const [id, target] of [["legacy-folder-undo", legacyDirectory], ["legacy-file-undo", legacyFile]]) {
  const backup = path.join(legacyTrash, `${id}.txt`); await fs.writeFile(backup, "original bytes");
  legacyOperations.push({ id, type: "text-write", status: "completed", createdAt: new Date().toISOString(), undo: { type: "text-write-restore", path: target, backup } });
}
await fs.writeFile(path.join(process.env.EXPLORE_BETTER_APP_DATA_ROOT, "state.json"), JSON.stringify({ operations: legacyOperations }));
const backend = await import("../server.mjs");
const server = await backend.startServer();
const base = `http://127.0.0.1:${server.address().port}`;
async function request(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
}
async function indexRoot(root, options = {}) {
  const created = await request("/api/background-indexes", { path: root, includeContent: true, includeLinks: false, recursive: true, watch: false, autoRebuild: false, start: true, ...options });
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = await request("/api/background-indexes");
    const record = state.roots.find(item => item.id === created.root.id);
    if (record?.job?.status === "error") throw new Error(record.job.error);
    if (!record?.job || record.job.status === "complete") return created.root.id;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Index fixture timed out");
}
try {
  await test("Legacy text Undo preserves a directory created at the former file path", async () => {
    const response = await fetch(`${base}/api/operation/undo`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: "legacy-folder-undo" }) });
    const data = await response.json();
    assert.equal(response.status, 500, JSON.stringify(data));
    assert.equal(await fs.readFile(path.join(legacyDirectory, "keep.txt"), "utf8"), "new directory contents");
    assert.equal(await fs.readFile(legacyOperations[0].undo.backup, "utf8"), "original bytes");
  });
  await test("Legacy text Undo retains later edits in a transactional backup", async () => {
    const result = await request("/api/operation/undo", { operationId: "legacy-file-undo" });
    assert.equal(await fs.readFile(legacyFile, "utf8"), "original bytes");
    assert.equal(result.operation.undo?.type, "replace-file-restore");
    assert.equal(await fs.readFile(result.operation.undo.backup, "utf8"), "later edits");
    await request("/api/operation/undo", { operationId: result.operation.id });
    assert.equal(await fs.readFile(legacyFile, "utf8"), "later edits");
  });
  const texts = path.join(files, "encoded-text"); await fs.mkdir(texts);
  const expected = [];
  for (const encoding of ["utf8", "utf16le", "utf16be"]) {
    const target = path.join(texts, `${encoding}.txt`); expected.push(target);
    await fs.writeFile(target, encodeEditableText("Quarterly borealis report £42\r\n", { encoding, bom: true }));
  }
  await test("Direct content search recognizes every supported editor encoding", async () => {
    const report = await request("/api/search", { path: texts, content: "borealis" });
    assert.deepEqual(report.entries.map(entry => entry.path).sort(), expected.sort());
    assert.ok(report.entries.every(entry => entry.matchSnippet.includes("borealis")));
  });
  await test("Indexed content search recognizes every supported editor encoding", async () => {
    const id = await indexRoot(texts);
    const report = await request(`/api/background-indexes/search?${new URLSearchParams({ rootId: id, q: "borealis" })}`);
    assert.deepEqual(report.results.map(entry => entry.path).sort(), expected.sort());
  });

  await test("Token planning preserves substring matches at query word boundaries", async () => {
    const root = path.join(files, "partial-tokens"); await fs.mkdir(root);
    const target = path.join(root, "prefixalpha betaSuffix.txt");
    for (const name of ["prefixalpha betaSuffix.txt", "alpha.txt", "beta.txt"]) await fs.writeFile(path.join(root, name), "fixture");
    const direct = await request("/api/search", { path: root, query: "alpha beta" });
    assert.deepEqual(direct.entries.map(entry => entry.path), [target]);
    const id = await indexRoot(root);
    const indexed = await request(`/api/background-indexes/search?${new URLSearchParams({ rootId: id, q: "alpha beta" })}`);
    assert.deepEqual(indexed.results.map(entry => entry.path), [target]);
    const folder = await request("/api/index/build", { path: root, wait: true });
    const folderSearch = () => request(`/api/index/search?${new URLSearchParams({ path: root, q: "alpha beta" })}`);
    assert.deepEqual((await folderSearch()).results.map(entry => entry.path), [target]);
    const storePath = path.join(process.env.EXPLORE_BETTER_APP_DATA_ROOT, "Index", `${folder.index.id}.json`);
    const store = JSON.parse(await fs.readFile(storePath, "utf8"));
    store.tokenIndex.version = 1; delete store.tokenIndex.fallbackEntries;
    await fs.writeFile(storePath, JSON.stringify(store));
    const legacy = await folderSearch();
    assert.deepEqual(legacy.results.map(entry => entry.path), [target]);
    assert.equal(legacy.timing.tokenNarrowed, false, "Legacy partial postings must fall back to a complete scan");
  });

  await test("Ordinary constructor filenames cannot collide with token storage properties", async () => {
    const root = path.join(files, "token-properties"); await fs.mkdir(root);
    const target = path.join(root, "constructor.txt"); await fs.writeFile(target, "constructor content");
    const id = await indexRoot(root);
    const report = await request(`/api/background-indexes/search?${new URLSearchParams({ rootId: id, q: "constructor content" })}`);
    assert.deepEqual(report.results.map(entry => entry.path), [target]);
  });

  await test("Token planning preserves content matches after the per-file token limit", async () => {
    const root = path.join(files, "long-token-content"); await fs.mkdir(root);
    const target = path.join(root, "long.txt");
    await fs.writeFile(target, Array.from({ length: 600 }, (_, i) => `filler${i}`).join(" ") + " lateword endword");
    await fs.writeFile(path.join(root, "lateword.txt"), "decoy");
    await fs.writeFile(path.join(root, "endword.txt"), "decoy");
    const direct = await request("/api/search", { path: root, content: "lateword endword" });
    assert.deepEqual(direct.entries.map(entry => entry.path), [target]);
    const id = await indexRoot(root);
    const indexed = await request(`/api/background-indexes/search?${new URLSearchParams({ rootId: id, q: "lateword endword" })}`);
    assert.deepEqual(indexed.results.map(entry => entry.path), [target]);
  });

  await test("Content-limit reporting includes omitted files in later folders", async () => {
    const root = path.join(files, "content-limit"); await fs.mkdir(root);
    const child = path.join(root, "child"); await fs.mkdir(child);
    await fs.writeFile(path.join(root, "first.txt"), "first content");
    await fs.writeFile(path.join(child, "second.txt"), "later content");
    const id = await indexRoot(root, { maxContentFiles: 1 });
    const overview = await request("/api/background-indexes");
    const stats = overview.roots.find(root => root.id === id).search;
    assert.equal(stats.contentIndexed, 1);
    assert.equal(stats.contentTruncated, true, JSON.stringify(stats));
    assert.equal(stats.contentSkipped, 1);
  });

  await test("Indexes that exclude hidden files remain fresh after building", async () => {
    const root = path.join(files, "hidden-freshness"); await fs.mkdir(root);
    await fs.writeFile(path.join(root, "visible.txt"), "visible marker");
    await fs.writeFile(path.join(root, ".hidden.txt"), "hidden marker");
    const id = await indexRoot(root, { showHidden: false });
    const report = await request(`/api/background-indexes/search?${new URLSearchParams({ rootId: id, q: "visible" })}`);
    assert.equal(report.freshness.stale, false, JSON.stringify(report.freshness));
    assert.equal(report.results.length, 1);
  });

  await test("Legacy background stores are marked for rebuild before serving results", async () => {
    const root = path.join(files, "legacy-index"); await fs.mkdir(root);
    const target = path.join(root, "encoded.txt");
    await fs.writeFile(target, encodeEditableText("migrationmarker", { encoding: "utf16le", bom: true }));
    const id = await indexRoot(root);
    const storePath = path.join(process.env.EXPLORE_BETTER_APP_DATA_ROOT, "Index", `background-${id}-search.json`);
    const store = JSON.parse(await fs.readFile(storePath, "utf8"));
    store.version = 1;
    store.entries[0].contentText = "legacy incorrectly decoded content";
    store.entries[0].searchText = store.entries[0].name;
    await fs.writeFile(storePath, JSON.stringify(store));
    const report = await request(`/api/background-indexes/search?${new URLSearchParams({ rootId: id, q: "encoded" })}`);
    assert.equal(report.indexed, false);
    assert.deepEqual(report.results, []);
    assert.equal(report.freshness.roots[0].reason, "search-store-outdated");
    assert.equal(report.freshness.stale, true);
    await indexRoot(root, { id });
    const migrated = await request(`/api/background-indexes/search?${new URLSearchParams({ rootId: id, q: "migrationmarker" })}`);
    assert.deepEqual(migrated.results.map(entry => entry.path), [target]);
    assert.equal(JSON.parse(await fs.readFile(storePath, "utf8")).version, 2);
  });

  await test("Recursive background indexes skip directory junction descendants", async () => {
    const root = path.join(files, "indexed-tree"), outside = path.join(files, "other-tree");
    await fs.mkdir(root); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "outside.txt"), "junctionmarker");
    await fs.symlink(outside, path.join(root, "shortcut"), process.platform === "win32" ? "junction" : "dir");
    const direct = await request("/api/search", { path: root, content: "junctionmarker" });
    assert.equal(direct.entries.length, 0);
    const id = await indexRoot(root);
    const indexed = await request(`/api/background-indexes/search?${new URLSearchParams({ rootId: id, q: "junctionmarker" })}`);
    assert.equal(indexed.results.length, 0, JSON.stringify(indexed.results));
  });
} finally {
  await backend.stopServer();
  await fs.writeFile(path.join(workspace, "artifacts", "backend-round-two-latest.json"), JSON.stringify({ fixture, checks }, null, 2));
}
console.log(`Backend round two: ${checks.filter(item => item.pass).length} passed, ${checks.filter(item => !item.pass).length} failed.`);
process.exit(checks.some(item => !item.pass) ? 1 : 0);
