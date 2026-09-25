import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import vm from "node:vm";

// Exercises the renderer's folder auto-refresh poller in isolation: the watcher
// fallback must not reload a pane forever, and the watcher baseline must come
// from the listing rather than the first poll.
const root = process.cwd();
const source = await fs.readFile(path.join(root, "public", "app.js"), "utf8");
const start = source.indexOf("async function folderWatchForPath(");
const end = source.indexOf("function startAutoRefresh(", start);
assert.ok(start > 0 && end > start, "auto-refresh poller source markers not found");

function harness({ watch, signatures, tab: tabOverrides = {} }) {
  const tab = {
    path: "C:\\Fixture",
    folderSignature: null,
    folderWatchVersion: null,
    lastLoadTiming: null,
    ...tabOverrides
  };
  const calls = { refresh: 0, signature: 0, watchSince: [] };
  let signatureIndex = 0;
  const context = vm.createContext({
    URLSearchParams,
    Date,
    Number,
    String,
    Boolean,
    app: { state: {}, autoRefreshBusy: false, lastEntryClick: null },
    document: { hidden: false },
    autoRefreshEnabled: () => true,
    watchablePaneNames: () => ["left"],
    paneLoadInFlight: () => false,
    tabOf: () => tab,
    tabNeedsDimensions: () => false,
    tabNeedsLinks: () => false,
    tabNeedsAttributes: () => false,
    showHiddenEntriesEnabled: () => true,
    setStatus: () => {},
    folderSignatureForPath: async () => {
      calls.signature += 1;
      return signatures[Math.min(signatureIndex++, signatures.length - 1)];
    },
    request: async (url) => {
      const query = new URL(url, "http://local").searchParams;
      calls.watchSince.push(query.has("since") ? Number(query.get("since")) : null);
      return typeof watch === "function" ? watch(query) : watch;
    },
    refreshPane: async () => {
      calls.refresh += 1;
      return true;
    }
  });
  vm.runInContext(source.slice(start, end), context);
  return { tab, calls, poll: () => vm.runInContext("pollAutoRefresh()", context) };
}

const checks = [];
async function check(id, callback) {
  try {
    await callback();
    checks.push({ id, ok: true });
  } catch (error) {
    checks.push({ id, ok: false, detail: error.stack });
  }
}

await check("fallback-refreshes-once-per-change", async () => {
  const before = { signature: "a", truncated: false };
  const after = { signature: "b", truncated: false };
  const { tab, calls, poll } = harness({
    watch: { available: false },
    signatures: [before, after, after, after, after]
  });
  await poll(); // baseline
  assert.equal(calls.refresh, 0);
  await poll(); // change detected
  assert.equal(calls.refresh, 1);
  await poll();
  await poll();
  await poll();
  assert.equal(calls.refresh, 1, "unchanged folder must not be reloaded on every poll");
  assert.equal(tab.folderSignature.signature, "b");
});

await check("fallback-baseline-resets-on-path-change", async () => {
  const { tab, calls, poll } = harness({
    watch: { available: false },
    signatures: [{ signature: "a" }, { signature: "other-folder" }, { signature: "other-folder" }]
  });
  await poll();
  tab.path = "C:\\Other";
  await poll();
  await poll();
  assert.equal(calls.refresh, 0, "a different folder's signature must not count as a change");
});

await check("watcher-baseline-comes-from-listing", async () => {
  const { tab, calls, poll } = harness({
    watch: (query) => ({ available: true, version: 7, changed: Number(query.get("since")) < 7 }),
    signatures: [],
    tab: { lastLoadTiming: { cache: { watcherAvailable: true, watcherVersion: 5 } } }
  });
  await poll();
  assert.deepEqual(calls.watchSince, [5]);
  assert.equal(calls.refresh, 1, "changes between listing and first poll must refresh");
  assert.equal(tab.folderWatchVersion, 7);
  await poll();
  assert.equal(calls.refresh, 1);
});

await check("watcher-version-regression-refreshes", async () => {
  const { calls, poll } = harness({
    watch: { available: true, version: 1, changed: false },
    signatures: [],
    tab: { folderWatchVersion: 9 }
  });
  await poll();
  assert.equal(calls.refresh, 1, "a recreated watcher may have missed changes");
});

await check("one-pane-error-does-not-stop-the-other", async () => {
  const tabs = {
    left: { path: "C:\\Broken", folderWatchVersion: 1 },
    right: { path: "C:\\Fine", folderWatchVersion: 1 }
  };
  let refreshed = [];
  const context = vm.createContext({
    URLSearchParams,
    Date,
    Number,
    String,
    Boolean,
    app: { state: {}, autoRefreshBusy: false, lastEntryClick: null },
    document: { hidden: false },
    autoRefreshEnabled: () => true,
    watchablePaneNames: () => ["left", "right"],
    paneLoadInFlight: () => false,
    tabOf: (paneName) => tabs[paneName],
    setStatus: () => {},
    request: async (url) => {
      if (url.includes("Broken")) throw new Error("gone");
      return { available: true, version: 2, changed: true };
    },
    refreshPane: async (paneName) => {
      refreshed.push(paneName);
      return true;
    }
  });
  vm.runInContext(source.slice(start, end), context);
  await vm.runInContext("pollAutoRefresh()", context);
  assert.deepEqual(refreshed, ["right"]);
  assert.equal(context.app.autoRefreshBusy, false);
});

console.log(`Auto refresh fallback: ${checks.filter((item) => item.ok).length} pass, ${checks.filter((item) => !item.ok).length} fail`);
checks.filter((item) => !item.ok).forEach((item) => console.error(`${item.id}: ${item.detail}`));
if (checks.some((item) => !item.ok)) process.exitCode = 1;
