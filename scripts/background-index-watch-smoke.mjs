import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `background-index-watch-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const nested = path.join(fixtureRoot, "nested");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "background-index-watch-latest.json");
const latestMdPath = path.join(artifactsDir, "background-index-watch-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
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
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function waitForServer(baseUrl, child, outputRef) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${outputRef()}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}: ${outputRef()}`);
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

async function waitForWatcherRecovery(baseUrl, rootId, options = {}) {
  const {
    query = "marigold docket",
    expectedPaths = [],
    afterQueuedAt = "",
    expectedJobIncreaseFrom = null,
    maxJobIncrease = 1
  } = options;
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 30000) {
    const overview = await requestJson(baseUrl, "/api/background-indexes");
    const root = overview.roots.find((item) => item.id === rootId);
    if (!root) throw new Error("Background root disappeared.");
    if (root.job?.status === "error") throw new Error(root.job.error || "Background index failed.");
    const watcher = root.watcher || {};
    const watchRepair = watcher.lastAutoRebuild?.source === "watch";
    const queuedAfter = !afterQueuedAt || String(watcher.lastQueuedAt || "") > String(afterQueuedAt);
    const jobs = (overview.jobs || []).filter((job) => job.rootId === rootId);
    const jobIncreaseOk =
      expectedJobIncreaseFrom === null || jobs.length - Number(expectedJobIncreaseFrom || 0) <= maxJobIncrease;
    if (watchRepair && queuedAfter && jobIncreaseOk && (!root.job || root.job.status === "complete")) {
      const search = await requestJson(
        baseUrl,
        `/api/background-indexes/search?${new URLSearchParams({ q: query, rootId, limit: "50" })}`
      );
      const foundPaths = new Set((search.results || []).map((item) => item.path));
      if (expectedPaths.every((expectedPath) => foundPaths.has(expectedPath))) {
        return { root, search, jobs };
      }
      last = { watcher, jobs: jobs.length, searchReturned: search.results?.length || 0 };
    } else {
      last = { watcher, jobs: jobs.length, jobIncreaseOk, job: root.job?.status || "none" };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Watcher recovery did not complete: ${JSON.stringify(last)}`);
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function prepareFixture() {
  await fs.mkdir(nested, { recursive: true });
  const initialPath = path.join(nested, "initial-watch-indexed.txt");
  await fs.writeFile(path.join(fixtureRoot, "root.txt"), "root\n", "utf8");
  await fs.writeFile(initialPath, "initial proactive watch target\n", "utf8");
  return { initialPath };
}

function startTestServer(port, appDataPath, label) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appDataPath,
      APPDATA: appDataPath,
      EXPLORE_BETTER_BACKGROUND_FRESHNESS_TTL_MS: "500",
      EXPLORE_BETTER_BACKGROUND_AUTO_REBUILD_COOLDOWN_MS: "1000",
      EXPLORE_BETTER_BACKGROUND_WATCH_DEBOUNCE_MS: "300",
      EXPLORE_BETTER_BACKGROUND_WATCH_FOLDERS: "16"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const record = { label, child, output: "" };
  child.stdout.on("data", (chunk) => {
    record.output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    record.output += chunk.toString();
  });
  return record;
}

async function stopTestServer(record) {
  if (!record?.child || record.child.exitCode !== null) return;
  const exited = new Promise((resolve) => record.child.once("exit", resolve));
  record.child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (record.child.exitCode === null) {
    record.child.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}

function combinedServerOutput(records) {
  return records
    .map((record) => `--- ${record.label} ---\n${record.output}`)
    .join("\n")
    .slice(-4000);
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Background Index Watch Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Watcher

| Field | Value |
| --- | --- |
| Watched folders | ${report.initialOverview?.watcher?.watchedFolders || 0} |
| Watch events | ${report.rebuiltOverview?.watcher?.eventCount || 0} |
| Burst events | ${report.burstOverview?.watcher?.eventCount || 0} |
| Delete/rename events | ${report.deleteRenameOverview?.watcher?.eventCount || 0} |
| Restart events | ${report.restartOverview?.watcher?.eventCount || 0} |
| Last repair source | ${report.rebuiltOverview?.watcher?.lastAutoRebuild?.source || "n/a"} |
| Burst job count | ${report.burstJobs?.length || 0} |
| Delete/rename job count | ${report.deleteRenameJobs?.length || 0} |
| Restart repair source | ${report.restartOverview?.watcher?.lastAutoRebuild?.source || "n/a"} |
| Restart job count | ${report.restartJobs?.length || 0} |
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixture = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 51000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const serverRuns = [];
  let server = startTestServer(port, appData, "initial");
  serverRuns.push(server);

  let rootId = "";
  let initialOverview = null;
  let rebuiltOverview = null;
  let rebuiltSearch = null;
  let burstOverview = null;
  let burstSearch = null;
  let burstJobs = [];
  let deleteRenameOverview = null;
  let deleteRenameSearch = null;
  let deleteRenameJobs = [];
  let restartOverview = null;
  let restartSearch = null;
  let restartJobs = [];
  let newPath = "";
  let burstPaths = [];
  let deletedPath = "";
  let renamedOldPath = "";
  let renamedPath = "";
  let restartPath = "";
  try {
    await waitForServer(baseUrl, server.child, () => server.output);
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
    rootId = started.job?.rootId || started.root?.id || started.roots?.[0]?.id;
    if (!rootId) throw new Error("Start response did not include a root id.");
    initialOverview = await waitForBackgroundComplete(baseUrl, rootId);
    check(
      checks,
      "initial-index-fresh",
      initialOverview.freshness?.status === "fresh" && initialOverview.search?.count >= 2,
      `status=${initialOverview.freshness?.status}; count=${initialOverview.search?.count || 0}.`
    );
    check(
      checks,
      "watcher-active",
      initialOverview.watcher?.available === true && Number(initialOverview.watcher?.watchedFolders || 0) >= 2,
      `available=${initialOverview.watcher?.available}; watched=${initialOverview.watcher?.watchedFolders || 0}.`
    );

    newPath = path.join(nested, "post-build-watch-new-file.txt");
    await fs.writeFile(newPath, "proactive watch target: marigold docket\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const recovered = await waitForWatcherRecovery(baseUrl, rootId, {
      query: "marigold docket",
      expectedPaths: [newPath]
    });
    rebuiltOverview = recovered.root;
    rebuiltSearch = recovered.search;
    const singleJobCount = recovered.jobs.length;
    const singleQueuedAt = rebuiltOverview.watcher?.lastQueuedAt || "";
    const singleEventCount = Number(rebuiltOverview.watcher?.eventCount || 0);
    check(
      checks,
      "watch-auto-rebuild-started",
      rebuiltOverview.watcher?.lastAutoRebuild?.source === "watch" && Number(rebuiltOverview.watcher?.eventCount || 0) >= 1,
      `source=${rebuiltOverview.watcher?.lastAutoRebuild?.source || "missing"}; events=${rebuiltOverview.watcher?.eventCount || 0}.`
    );
    check(
      checks,
      "watch-rebuild-clears-stale",
      rebuiltOverview.freshness?.status === "fresh" && rebuiltOverview.search?.count >= 3,
      `status=${rebuiltOverview.freshness?.status}; count=${rebuiltOverview.search?.count || 0}.`
    );
    check(
      checks,
      "watch-search-finds-new-file",
      rebuiltSearch.freshness?.stale === false && rebuiltSearch.results.some((item) => item.path === newPath),
      `stale=${rebuiltSearch.freshness?.stale}; returned=${rebuiltSearch.results?.length || 0}.`
    );

    burstPaths = [];
    for (let index = 0; index < 8; index += 1) {
      const burstPath = path.join(nested, `burst-watch-${String(index).padStart(2, "0")}.txt`);
      burstPaths.push(burstPath);
      await fs.writeFile(burstPath, `burst docket ${index}: calendula schedule\n`, "utf8");
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const burstRecovered = await waitForWatcherRecovery(baseUrl, rootId, {
      query: "burst docket",
      expectedPaths: burstPaths,
      afterQueuedAt: singleQueuedAt,
      expectedJobIncreaseFrom: singleJobCount,
      maxJobIncrease: 1
    });
    burstOverview = burstRecovered.root;
    burstSearch = burstRecovered.search;
    burstJobs = burstRecovered.jobs;
    const burstEventIncrease = Number(burstOverview.watcher?.eventCount || 0) - singleEventCount;
    const burstJobIncrease = burstJobs.length - singleJobCount;
    check(
      checks,
      "watch-burst-debounced",
      burstEventIncrease >= 2 && burstJobIncrease === 1,
      `events+${burstEventIncrease}; jobs+${burstJobIncrease}; totalJobs=${burstJobs.length}.`
    );
    check(
      checks,
      "watch-burst-search-finds-all-files",
      burstSearch.freshness?.stale === false && burstPaths.every((item) => burstSearch.results.some((result) => result.path === item)),
      `returned=${burstSearch.results?.length || 0}; expected=${burstPaths.length}.`
    );

    const burstQueuedAt = burstOverview.watcher?.lastQueuedAt || "";
    const burstEventCount = Number(burstOverview.watcher?.eventCount || 0);
    const burstJobCount = burstJobs.length;
    deletedPath = burstPaths[0];
    renamedOldPath = burstPaths[1];
    renamedPath = path.join(nested, "renamed-watch-survivor.txt");
    const deleteRenameExpectedPaths = [renamedPath, ...burstPaths.slice(2)];
    await fs.rm(deletedPath, { force: true });
    await fs.rename(renamedOldPath, renamedPath);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const deleteRenameRecovered = await waitForWatcherRecovery(baseUrl, rootId, {
      query: "burst docket",
      expectedPaths: deleteRenameExpectedPaths,
      afterQueuedAt: burstQueuedAt,
      expectedJobIncreaseFrom: burstJobCount,
      maxJobIncrease: 1
    });
    deleteRenameOverview = deleteRenameRecovered.root;
    deleteRenameSearch = deleteRenameRecovered.search;
    deleteRenameJobs = deleteRenameRecovered.jobs;
    const deleteRenameEventIncrease = Number(deleteRenameOverview.watcher?.eventCount || 0) - burstEventCount;
    const deleteRenameJobIncrease = deleteRenameJobs.length - burstJobCount;
    const deleteRenameResults = deleteRenameSearch.results || [];
    check(
      checks,
      "watch-delete-rename-debounced",
      deleteRenameEventIncrease >= 2 && deleteRenameJobIncrease === 1,
      `events+${deleteRenameEventIncrease}; jobs+${deleteRenameJobIncrease}; totalJobs=${deleteRenameJobs.length}.`
    );
    check(
      checks,
      "watch-delete-rename-removes-stale-hit",
      deleteRenameSearch.freshness?.stale === false &&
        !deleteRenameResults.some((result) => result.path === deletedPath || result.path === renamedOldPath) &&
        deleteRenameResults.some((result) => result.path === renamedPath),
      `returned=${deleteRenameResults.length}; deletedPresent=${deleteRenameResults.some((result) => result.path === deletedPath)}; oldNamePresent=${deleteRenameResults.some((result) => result.path === renamedOldPath)}; renamedPresent=${deleteRenameResults.some((result) => result.path === renamedPath)}.`
    );
    check(
      checks,
      "watch-delete-rename-keeps-remaining-hits",
      deleteRenameExpectedPaths.every((item) => deleteRenameResults.some((result) => result.path === item)),
      `hits=${deleteRenameExpectedPaths.filter((item) => deleteRenameResults.some((result) => result.path === item)).length}/${deleteRenameExpectedPaths.length}.`
    );

    await stopTestServer(server);
    server = startTestServer(port, appData, "restart");
    serverRuns.push(server);
    await waitForServer(baseUrl, server.child, () => server.output);
    await new Promise((resolve) => setTimeout(resolve, 900));
    restartPath = path.join(nested, "post-restart-watch-new-file.txt");
    await fs.writeFile(restartPath, "restart watcher target: heliotrope ledger\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const restartRecovered = await waitForWatcherRecovery(baseUrl, rootId, {
      query: "heliotrope ledger",
      expectedPaths: [restartPath],
      expectedJobIncreaseFrom: 0,
      maxJobIncrease: 1
    });
    restartOverview = restartRecovered.root;
    restartSearch = restartRecovered.search;
    restartJobs = restartRecovered.jobs;
    check(
      checks,
      "watch-restart-auto-rebuild-started",
      restartOverview.watcher?.lastAutoRebuild?.source === "watch" && Number(restartOverview.watcher?.watchedFolders || 0) >= 2,
      `source=${restartOverview.watcher?.lastAutoRebuild?.source || "missing"}; watched=${restartOverview.watcher?.watchedFolders || 0}; events=${restartOverview.watcher?.eventCount || 0}.`
    );
    check(
      checks,
      "watch-restart-search-finds-new-file",
      restartSearch.freshness?.stale === false && restartSearch.results.some((item) => item.path === restartPath),
      `stale=${restartSearch.freshness?.stale}; returned=${restartSearch.results?.length || 0}.`
    );
    check(
      checks,
      "watch-restart-job-bounded",
      restartJobs.length <= 1,
      `jobs=${restartJobs.length}.`
    );
  } catch (error) {
    check(checks, "smoke-execution", false, error.message);
  } finally {
    await stopTestServer(server);
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }

  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    warn: checks.filter((item) => item.status === "warn").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
  const report = {
    generatedAt: new Date().toISOString(),
    status: summary.fail ? "fail" : "pass",
    fixtureRoot,
    rootId,
    paths: { ...fixture, newPath, burstPaths, deletedPath, renamedOldPath, renamedPath, restartPath },
    initialOverview,
    rebuiltOverview,
    rebuiltSearch: rebuiltSearch
      ? {
          freshness: rebuiltSearch.freshness,
          timing: rebuiltSearch.timing,
          returned: rebuiltSearch.results?.length || 0,
          hit: rebuiltSearch.results?.some((item) => item.path === newPath) || false
        }
      : null,
    burstOverview,
    burstJobs,
    burstSearch: burstSearch
      ? {
          freshness: burstSearch.freshness,
          timing: burstSearch.timing,
          returned: burstSearch.results?.length || 0,
          hits: burstPaths.filter((item) => burstSearch.results?.some((result) => result.path === item)).length
        }
      : null,
    deleteRenameOverview,
    deleteRenameJobs,
    deleteRenameSearch: deleteRenameSearch
      ? {
          freshness: deleteRenameSearch.freshness,
          timing: deleteRenameSearch.timing,
          returned: deleteRenameSearch.results?.length || 0,
          deletedPresent: deleteRenameSearch.results?.some((item) => item.path === deletedPath) || false,
          oldNamePresent: deleteRenameSearch.results?.some((item) => item.path === renamedOldPath) || false,
          renamedPresent: deleteRenameSearch.results?.some((item) => item.path === renamedPath) || false,
          hits: [renamedPath, ...burstPaths.slice(2)].filter((item) => deleteRenameSearch.results?.some((result) => result.path === item))
            .length
        }
      : null,
    restartOverview,
    restartJobs,
    restartSearch: restartSearch
      ? {
          freshness: restartSearch.freshness,
          timing: restartSearch.timing,
          returned: restartSearch.results?.length || 0,
          hit: restartSearch.results?.some((item) => item.path === restartPath) || false
        }
      : null,
    serverOutput: combinedServerOutput(serverRuns),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`background index watch: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
