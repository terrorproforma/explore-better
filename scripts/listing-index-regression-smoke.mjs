import assert from "node:assert/strict";
import { createWriteStream, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Regression checks for directory listing, metadata, zip browsing and background
// index storage fixes. Runs the backend in-process so fs/yauzl can be instrumented.
const require = createRequire(import.meta.url);
const yauzl = require("yauzl");
const yazl = require("yazl");
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await fs.mkdir(path.join(workspace, "artifacts"), { recursive: true });
const fixture = await fs.mkdtemp(path.join(workspace, "artifacts", "listing-index-regression-"));
const files = path.join(fixture, "files");
await fs.mkdir(files);
const appData = path.join(fixture, "appdata");
process.env.EXPLORE_BETTER_APP_DATA_ROOT = appData;
process.env.EXPLORE_BETTER_WORKSPACE_ROOT = files;
process.env.EXPLORE_BETTER_DISABLE_STATE_WATCH = "1";
process.env.EXPLORE_BETTER_DISABLE_NATIVE_LISTING = "1";
process.env.EXPLORE_BETTER_CACHE_MAINTENANCE = "0";
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
const sameKey = (left, right) => path.resolve(String(left)).toLowerCase() === path.resolve(String(right)).toLowerCase();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const backend = await import("../server.mjs");
const server = await backend.startServer();
const base = `http://127.0.0.1:${server.address().port}`;
async function raw(route, body, signal = AbortSignal.timeout(30000)) {
  const response = await fetch(base + route, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  return { status: response.status, data: await response.json() };
}
async function request(route, body) {
  const { status, data } = await raw(route, body);
  assert.equal(status, 200, JSON.stringify(data)); return data;
}
async function indexRoot(root, options = {}) {
  const created = await request("/api/background-indexes", { path: root, includeContent: false, recursive: true, watch: false, autoRebuild: false, start: true, ...options });
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await request("/api/background-indexes");
    const record = state.roots.find(item => item.id === created.root.id);
    if (record?.job?.status === "error") throw new Error(record.job.error);
    if (!record?.job || record.job.status === "complete") return created.root.id;
    await delay(50);
  }
  throw new Error("Index fixture timed out");
}
const listRoute = (dir) => `/api/list?${new URLSearchParams({ path: dir })}`;

try {
  await test("Access-denied directory reads return an accessError listing instead of failing", async () => {
    const denied = path.join(files, "denied"); await fs.mkdir(denied);
    const original = fs.readdir;
    fs.readdir = async (...args) => {
      if (sameKey(args[0], denied)) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      return original(...args);
    };
    try {
      const listing = await request(listRoute(denied));
      assert.equal(listing.accessError?.code, "EPERM", JSON.stringify(listing));
      assert.deepEqual(listing.entries, []);
      assert.equal(listing.showHidden, true);
    } finally { fs.readdir = original; }
  });

  await test("A coalesced listing survives the first requester aborting", async () => {
    const dir = path.join(files, "coalesced"); await fs.mkdir(dir);
    for (let index = 0; index < 5; index++) await fs.writeFile(path.join(dir, `item-${index}.txt`), "x");
    const original = fs.readdir;
    let started = null; const startedPromise = new Promise(resolve => { started = resolve; });
    let gated = true;
    fs.readdir = async (...args) => {
      if (gated && sameKey(args[0], dir) && args[1]?.withFileTypes) { gated = false; started(); await delay(400); }
      return original(...args);
    };
    try {
      const first = new AbortController();
      const firstRequest = raw(listRoute(dir), undefined, first.signal).catch(error => ({ aborted: error.name }));
      await startedPromise;
      const secondRequest = raw(listRoute(dir));
      await delay(80);
      first.abort();
      const second = await secondRequest;
      await firstRequest;
      assert.equal(second.status, 200, JSON.stringify(second.data));
      assert.equal(second.data.entries.length, 5);
    } finally { fs.readdir = original; }
  });

  await test("Bare drive letters resolve to the drive root, not the working directory", async () => {
    if (process.platform !== "win32") return;
    const drive = path.parse(fixture).root.slice(0, 2);
    const listing = await request(`/api/list?${new URLSearchParams({ path: drive, format: "" })}`);
    assert.equal(listing.path, `${drive.toUpperCase()}\\`);
  });

  await test("Aborting a zip listing while the archive is opening closes the archive", async () => {
    const archive = path.join(files, "open-abort.zip");
    await new Promise((resolve, reject) => {
      const zip = new yazl.ZipFile(); zip.addBuffer(Buffer.from("payload"), "inner/a.txt"); zip.end();
      zip.outputStream.pipe(createWriteStream(archive)).on("close", resolve).on("error", reject);
    });
    const realOpen = yauzl.open;
    let closed = 0; let opened = null; let release = null;
    const openedPromise = new Promise(resolve => { opened = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    yauzl.open = (file, options, callback) => realOpen.call(yauzl, file, options, (error, zipFile) => {
      if (zipFile) {
        const close = zipFile.close.bind(zipFile);
        zipFile.close = () => { closed += 1; return close(); };
      }
      opened();
      gate.then(() => callback(error, zipFile));
    });
    try {
      const controller = new AbortController();
      const pending = raw(`/api/archive/list?${new URLSearchParams({ path: archive })}`, undefined, controller.signal).catch(error => ({ aborted: error.name }));
      await openedPromise;
      controller.abort();
      await pending;
      await delay(150);
      release();
      await delay(150);
      assert.equal(closed, 1, "the archive opened after the abort must be closed");
    } finally { yauzl.open = realOpen; release(); }
    const listing = await request(`/api/archive/list?${new URLSearchParams({ path: archive })}`);
    assert.ok(listing.entries.some(entry => entry.name === "inner"), JSON.stringify(listing.entries));
  });

  await test("Background index ids cannot move store files outside the index folder", async () => {
    const root = path.join(files, "id-root"); await fs.mkdir(root);
    await fs.writeFile(path.join(root, "needle-escape.txt"), "x");
    const hostileId = await indexRoot(root, { id: "x/../../../wp5-escape" });
    assert.equal(hostileId, "x/../../../wp5-escape");
    for (const name of ["wp5-escape.json", "wp5-escape-search.json"]) {
      await assert.rejects(fs.access(path.join(fixture, name)), `${name} escaped the index folder`);
    }
    const indexFiles = await fs.readdir(path.join(appData, "Index"));
    assert.ok(indexFiles.some(name => /^background-h-[0-9a-f]{32}-search\.json$/.test(name)), indexFiles.join(", "));
    const search = await request(`/api/background-indexes/search?${new URLSearchParams({ rootId: hostileId, q: "needle-escape" })}`);
    assert.equal(search.results.length, 1, JSON.stringify(search.results));

    const plainRoot = path.join(files, "plain-id-root"); await fs.mkdir(plainRoot);
    await fs.writeFile(path.join(plainRoot, "needle-plain.txt"), "x");
    const plainId = await indexRoot(plainRoot, { id: "bg-wp5-plain_id" });
    await fs.access(path.join(appData, "Index", "background-bg-wp5-plain_id-search.json"));
    const overview = await request("/api/background-indexes");
    const record = overview.roots.find(item => item.id === plainId);
    assert.equal(record.search?.count, 1, JSON.stringify(record.search));
    const maintenance = await request("/api/cache/maintenance");
    assert.equal(maintenance.byReason["background-root-unregistered"] || 0, 0, JSON.stringify(maintenance.byReason));
  });

  await test("Mutations beside an index root do not mark it stale through their parent folder", async () => {
    const parent = path.join(files, "mutation-parent"); const root = path.join(parent, "indexed");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(parent, "sibling.txt"), "x");
    await fs.writeFile(path.join(root, "inside.txt"), "x");
    await indexRoot(root);
    const sibling = await request("/api/rename", { path: path.join(parent, "sibling.txt"), name: "sibling-renamed.txt" });
    assert.equal(sibling.operation.result.backgroundIndexInvalidation.affected, 0, JSON.stringify(sibling.operation.result.backgroundIndexInvalidation));
    const inside = await request("/api/rename", { path: path.join(root, "inside.txt"), name: "inside-renamed.txt" });
    assert.equal(inside.operation.result.backgroundIndexInvalidation.affected, 1);
    const moved = await request("/api/rename", { path: root, name: "indexed-renamed" });
    assert.equal(moved.operation.result.backgroundIndexInvalidation.affected, 1, "renaming the root itself still invalidates it");
  });

  await test("Attribute edits read flags of non-ASCII names correctly", async () => {
    if (process.platform !== "win32") return;
    const target = path.join(files, "hïdden-日本.txt"); await fs.writeFile(target, "x");
    const set = await request("/api/attributes/set", { paths: [target], attributes: { hidden: "set" } });
    const changed = set.operation.result.changed[0];
    assert.equal(changed.attributes.hidden, true, JSON.stringify(changed));
    assert.equal(changed.attributes.archive, true, JSON.stringify(changed));
    assert.equal(set.operation.undo.items[0].attributes.archive, true, "undo must restore the archive flag");
    const folder = path.join(files, "ünïcode-folder"); await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, "Ωmega.txt"), "x");
    await request("/api/attributes/set", { paths: [path.join(folder, "Ωmega.txt")], attributes: { hidden: "set" } });
    const listing = await request(`/api/list?${new URLSearchParams({ path: folder, showHidden: "false" })}`);
    assert.equal(listing.entries.length, 0, JSON.stringify(listing.entries.map(entry => entry.name)));
    assert.equal(listing.hiddenFiltered, 1);
  });
} finally {
  await backend.stopServer();
  await fs.writeFile(path.join(workspace, "artifacts", "listing-index-regression-latest.json"), JSON.stringify({ fixture, checks }, null, 2));
}
console.log(`Listing/index regression: ${checks.filter(item => item.pass).length} passed, ${checks.filter(item => !item.pass).length} failed.`);
process.exit(checks.some(item => !item.pass) ? 1 : 0);
