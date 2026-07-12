import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `background-index-corruption-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const nested = path.join(fixtureRoot, "nested");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const indexRoot = path.join(appData, "ExploreBetter", "Index");
const latestJsonPath = path.join(artifactsDir, "background-index-corruption-latest.json");
const latestMdPath = path.join(artifactsDir, "background-index-corruption-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_BACKGROUND_INDEX_CORRUPTION_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
  if (!ok) {
    throw new Error(`${id}: ${detail}`);
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

async function waitForBackgroundComplete(baseUrl, rootId) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const overview = await requestJson(baseUrl, "/api/background-indexes");
    const root = overview.roots.find((item) => item.id === rootId);
    if (!root) throw new Error("Background root disappeared.");
    if (root.job?.status === "error") throw new Error(root.job.error || "Background index failed.");
    if (!root.job || root.job.status === "complete") return root;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Background index did not complete in time.");
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function backgroundManifestFile(rootId) {
  return path.join(indexRoot, `background-${rootId}.json`);
}

function backgroundSearchFile(rootId) {
  return path.join(indexRoot, `background-${rootId}-search.json`);
}

async function prepareFixture() {
  await fs.mkdir(nested, { recursive: true });
  const labelledPath = path.join(nested, "labelled.txt");
  const namePath = path.join(nested, "persistent-index-needle.log");
  const contentPath = path.join(nested, "content-target.md");
  await fs.writeFile(path.join(fixtureRoot, "root.txt"), "root\n", "utf8");
  await fs.writeFile(labelledPath, "label target\n", "utf8");
  await fs.writeFile(namePath, "name target\n", "utf8");
  await fs.writeFile(contentPath, "background corruption recovery phrase: obsidian invoice\n", "utf8");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        labels: [
          {
            path: labelledPath,
            name: "Corruption Label",
            color: "gold",
            notes: "aurora ledger"
          }
        ],
        operations: []
      },
      null,
      2
    ),
    "utf8"
  );
  return { labelledPath, namePath, contentPath };
}

async function startIndex(baseUrl) {
  const started = await requestJson(baseUrl, "/api/background-indexes/start", {
    method: "POST",
    body: JSON.stringify({
      path: fixtureRoot,
      recursive: true,
      includeDimensions: false,
      includeLinks: false,
      includeContent: true,
      maxContentBytes: 4096,
      maxContentFiles: 20,
      maxFolders: 10,
      maxEntries: 1000
    })
  });
  const rootId = started.job?.rootId || started.root?.id || started.roots?.[0]?.id;
  if (!rootId) throw new Error("Start response did not include a root id.");
  return { rootId, completed: await waitForBackgroundComplete(baseUrl, rootId) };
}

async function search(baseUrl, rootId, query) {
  return requestJson(baseUrl, `/api/background-indexes/search?${new URLSearchParams({ q: query, rootId, limit: "20" })}`);
}

function hasHit(searchResult, targetPath) {
  return (searchResult.results || []).some((item) => item.path === targetPath);
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Background Index Corruption Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

Root id: ${report.rootId}
Search-store quarantine: ${report.searchStoreCorruption?.quarantinedPath || "none"}
Manifest quarantine: ${report.manifestCorruption?.quarantinedPath || "none"}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const fixture = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 58600 + Math.floor(Math.random() * 4000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      EXPLORE_BETTER_BACKGROUND_AUTO_REBUILD_COOLDOWN_MS: "1000",
      EXPLORE_BETTER_BACKGROUND_FRESHNESS_TTL_MS: "500"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  let rootId = "";
  let initialSearch = null;
  let corruptedOverviewRoot = null;
  let rebuiltRoot = null;
  let rebuiltSearch = null;
  let manifestCorruptSearch = null;
  let manifestCorruptOverviewRoot = null;
  let finalRoot = null;
  let searchStoreCorruption = null;
  let manifestCorruption = null;
  try {
    await waitForServer(baseUrl, server);
    const started = await startIndex(baseUrl);
    rootId = started.rootId;
    check(checks, "initial-index-built", started.completed.search?.count >= 4 && started.completed.search?.contentIndexed >= 3, `count=${started.completed.search?.count}; content=${started.completed.search?.contentIndexed}.`);

    initialSearch = await search(baseUrl, rootId, "obsidian invoice");
    check(checks, "initial-content-search-hit", hasHit(initialSearch, fixture.contentPath), `returned=${initialSearch.results?.length || 0}.`);

    const searchFile = backgroundSearchFile(rootId);
    const manifestFile = backgroundManifestFile(rootId);
    await fs.writeFile(searchFile, "{ broken search store", "utf8");
    const corruptOverview = await requestJson(baseUrl, "/api/background-indexes");
    corruptedOverviewRoot = corruptOverview.roots.find((item) => item.id === rootId);
    searchStoreCorruption = {
      reason: corruptedOverviewRoot?.freshness?.reason || "",
      readError: corruptedOverviewRoot?.freshness?.readError || corruptedOverviewRoot?.indexRead?.searchError?.error || "",
      quarantinedPath: corruptedOverviewRoot?.freshness?.quarantinedPath || corruptedOverviewRoot?.indexRead?.searchError?.quarantinedPath || null,
      autoRebuild: corruptedOverviewRoot?.autoRebuild || null
    };
    check(checks, "corrupt-search-store-reported", corruptedOverviewRoot?.freshness?.stale === true && corruptedOverviewRoot?.freshness?.reason === "search-store-corrupt", `reason=${corruptedOverviewRoot?.freshness?.reason || "missing"}.`);
    check(checks, "corrupt-search-store-quarantined", Boolean(searchStoreCorruption.quarantinedPath), `quarantine=${searchStoreCorruption.quarantinedPath || "missing"}.`);
    check(checks, "corrupt-search-store-rebuild-started", corruptedOverviewRoot?.autoRebuild?.scheduled === true || corruptedOverviewRoot?.autoRebuild?.active === true || corruptedOverviewRoot?.job?.status === "running", `auto=${JSON.stringify(corruptedOverviewRoot?.autoRebuild || null)}.`);

    rebuiltRoot = await waitForBackgroundComplete(baseUrl, rootId);
    rebuiltSearch = await search(baseUrl, rootId, "obsidian invoice");
    check(checks, "corrupt-search-store-rebuilt", rebuiltRoot.search?.count >= 4 && hasHit(rebuiltSearch, fixture.contentPath), `count=${rebuiltRoot.search?.count}; hits=${rebuiltSearch.results?.length || 0}.`);

    await fs.writeFile(manifestFile, "{ broken manifest", "utf8");
    manifestCorruptSearch = await search(baseUrl, rootId, "aurora ledger");
    const afterManifestOverview = await requestJson(baseUrl, "/api/background-indexes");
    manifestCorruptOverviewRoot = afterManifestOverview.roots.find((item) => item.id === rootId);
    manifestCorruption = {
      searchIndexed: manifestCorruptSearch.indexed === true,
      hit: hasHit(manifestCorruptSearch, fixture.labelledPath),
      readError: manifestCorruptSearch.freshness?.roots?.[0]?.read?.manifestError?.error || manifestCorruptOverviewRoot?.indexRead?.manifestError?.error || "",
      quarantinedPath: manifestCorruptSearch.freshness?.roots?.[0]?.read?.manifestError?.quarantinedPath || manifestCorruptOverviewRoot?.indexRead?.manifestError?.quarantinedPath || null
    };
    check(checks, "corrupt-manifest-search-still-works", manifestCorruption.searchIndexed && manifestCorruption.hit, `indexed=${manifestCorruption.searchIndexed}; hit=${manifestCorruption.hit}.`);
    check(checks, "corrupt-manifest-quarantined", Boolean(manifestCorruption.quarantinedPath), `quarantine=${manifestCorruption.quarantinedPath || "missing"}.`);

    const restarted = await startIndex(baseUrl);
    finalRoot = restarted.completed;
    const finalManifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    const finalStore = JSON.parse(await fs.readFile(searchFile, "utf8"));
    check(checks, "manual-rebuild-restores-manifest", finalManifest.version === 1 && finalManifest.rootId === rootId, `version=${finalManifest.version}; root=${finalManifest.rootId}.`);
    check(checks, "manual-rebuild-restores-search-store", finalStore.version === 1 && Array.isArray(finalStore.entries) && finalStore.entries.length >= 4, `entries=${finalStore.entries?.length || 0}.`);

    const summary = {
      pass: checks.filter((item) => item.status === "pass").length,
      warn: checks.filter((item) => item.status === "warn").length,
      fail: checks.filter((item) => item.status === "fail").length
    };
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixtureRoot,
      rootId,
      paths: fixture,
      initialSearch: {
        indexed: initialSearch.indexed,
        returned: initialSearch.results?.length || 0
      },
      searchStoreCorruption,
      rebuilt: {
        count: rebuiltRoot.search?.count || 0,
        contentIndexed: rebuiltRoot.search?.contentIndexed || 0,
        searchReturned: rebuiltSearch.results?.length || 0
      },
      manifestCorruption,
      final: {
        count: finalRoot.search?.count || 0,
        contentIndexed: finalRoot.search?.contentIndexed || 0
      },
      serverOutput: serverOutput.slice(-4000),
      checks,
      summary
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`background index corruption: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail > 0) {
      process.exitCode = 1;
    }
  } finally {
    await stopServer(server);
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
