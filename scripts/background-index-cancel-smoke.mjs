import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `background-index-cancel-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "background-index-cancel-latest.json");
const latestMdPath = path.join(artifactsDir, "background-index-cancel-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function numberOption(name, envName, fallback) {
  const value = Number(optionValue(name, process.env[envName] || String(fallback)));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_BACKGROUND_CANCEL_KEEP_FIXTURE === "1";
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

async function waitForJobStatus(baseUrl, jobId, statuses, timeoutMs = 30000) {
  const wanted = new Set(statuses);
  const started = performance.now();
  let lastOverview = null;
  while (performance.now() - started < timeoutMs) {
    const overview = await requestJson(baseUrl, "/api/background-indexes");
    lastOverview = overview;
    const job = (overview.jobs || []).find((item) => item.id === jobId);
    if (job && wanted.has(job.status)) {
      return { overview, job };
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Background index job ${jobId} did not reach ${statuses.join("/")} in time. Last overview: ${JSON.stringify(lastOverview)}`);
}

async function waitForRootComplete(baseUrl, rootId, timeoutMs = 60000) {
  const started = performance.now();
  let lastRoot = null;
  while (performance.now() - started < timeoutMs) {
    const overview = await requestJson(baseUrl, "/api/background-indexes");
    const root = (overview.roots || []).find((item) => item.id === rootId);
    lastRoot = root;
    if (!root) {
      throw new Error("Background index root disappeared.");
    }
    if (root.job?.status === "error") {
      throw new Error(root.job.error || "Background index failed.");
    }
    if (!root.job && root.search?.count > 0 && root.manifest?.count === root.search?.count) {
      return { overview, root };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Background index root ${rootId} did not complete in time. Last root: ${JSON.stringify(lastRoot)}`);
}

async function writeManyFiles(dir, count, token) {
  await fs.mkdir(dir, { recursive: true });
  const batchSize = 128;
  for (let offset = 0; offset < count; offset += batchSize) {
    const writes = [];
    for (let index = offset; index < Math.min(offset + batchSize, count); index += 1) {
      const name = `${token}-${String(index).padStart(5, "0")}.txt`;
      const text = [
        `${token} background cancel fixture ${index}`,
        "This text keeps the background content reader busy enough to cancel under load.",
        index === count - 1 ? "cancel restart final needle" : ""
      ].join("\n");
      writes.push(fs.writeFile(path.join(dir, name), text, "utf8"));
    }
    await Promise.all(writes);
  }
}

async function prepareFixture(folderCount, filesPerFolder) {
  await fs.mkdir(fixtureRoot, { recursive: true });
  for (let folderIndex = 0; folderIndex < folderCount; folderIndex += 1) {
    const dir = path.join(fixtureRoot, `folder-${String(folderIndex).padStart(4, "0")}`);
    await writeManyFiles(dir, filesPerFolder, `cancel-load-${String(folderIndex).padStart(4, "0")}`);
  }
  return {
    folderCount,
    filesPerFolder,
    expectedFiles: folderCount * filesPerFolder,
    needle: "cancel restart final needle"
  };
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Background Index Cancellation Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

Fixture folders: ${report.fixture.folderCount}
Fixture files: ${report.fixture.expectedFiles}
Canceled job: ${report.canceled.jobId}
Restarted job: ${report.restart.jobId}
Final indexed entries: ${report.restart.searchCount}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const folderCount = numberOption("--folders", "EB_BACKGROUND_CANCEL_FOLDERS", 96);
  const filesPerFolder = numberOption("--files-per-folder", "EB_BACKGROUND_CANCEL_FILES_PER_FOLDER", 64);
  const fixture = await prepareFixture(folderCount, filesPerFolder);
  const checks = [];
  const port = Number(optionValue("--port", process.env.PORT || 50000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      EXPLORE_BETTER_BACKGROUND_LIST_CONCURRENCY: process.env.EXPLORE_BETTER_BACKGROUND_LIST_CONCURRENCY || "1",
      EXPLORE_BETTER_CONTENT_INDEX_CONCURRENCY: process.env.EXPLORE_BETTER_CONTENT_INDEX_CONCURRENCY || "1"
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
  let canceledJob = null;
  let canceledRoot = null;
  let restartJobId = "";
  let completedRoot = null;
  let search = null;
  try {
    await waitForServer(baseUrl, server);
    const started = await requestJson(baseUrl, "/api/background-indexes/start", {
      method: "POST",
      body: JSON.stringify({
        path: fixtureRoot,
        recursive: true,
        includeContent: true,
        includeDimensions: false,
        includeLinks: false,
        maxContentBytes: 4096,
        maxContentFiles: fixture.expectedFiles,
        maxFolders: fixture.folderCount + 2,
        maxEntries: fixture.expectedFiles + fixture.folderCount + 10,
        watch: false,
        autoRebuild: false
      })
    });
    rootId = started.job?.rootId || started.roots?.[0]?.id || "";
    const firstJobId = started.job?.id || "";
    check(checks, "cancel-root-started", Boolean(rootId && firstJobId), `root=${rootId || "missing"}; job=${firstJobId || "missing"}.`);
    check(checks, "cancel-job-running", started.job?.status === "running", `status=${started.job?.status || "missing"}.`);

    const stopped = await requestJson(baseUrl, "/api/background-indexes/stop", {
      method: "POST",
      body: JSON.stringify({ id: rootId })
    });
    check(checks, "stop-request-accepted", stopped.stopped?.stopped === true, `stopped=${stopped.stopped?.stopped}.`);

    const canceled = await waitForJobStatus(baseUrl, firstJobId, ["canceled"]);
    canceledJob = canceled.job;
    canceledRoot = (canceled.overview.roots || []).find((item) => item.id === rootId) || null;
    check(checks, "cancel-job-recorded", canceledJob.status === "canceled", `status=${canceledJob.status}.`);
    check(checks, "cancel-job-has-finish", Boolean(canceledJob.finishedAt), `finishedAt=${canceledJob.finishedAt || "missing"}.`);
    check(
      checks,
      "cancel-left-no-complete-cache",
      !canceledRoot?.search && !canceledRoot?.manifest,
      `search=${Boolean(canceledRoot?.search)}; manifest=${Boolean(canceledRoot?.manifest)}.`
    );

    const restarted = await requestJson(baseUrl, "/api/background-indexes/start", {
      method: "POST",
      body: JSON.stringify({ id: rootId })
    });
    restartJobId = restarted.job?.id || "";
    check(checks, "restart-after-cancel-started", Boolean(restartJobId && restartJobId !== firstJobId), `restart=${restartJobId || "missing"}.`);
    const completed = await waitForRootComplete(baseUrl, rootId);
    completedRoot = completed.root;
    check(checks, "restart-completed-cache", completedRoot.search?.count >= fixture.expectedFiles, `count=${completedRoot.search?.count || 0}.`);
    check(checks, "restart-content-indexed", completedRoot.search?.contentIndexed >= fixture.expectedFiles, `content=${completedRoot.search?.contentIndexed || 0}.`);

    search = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: fixture.needle, rootId, limit: "20" })}`
    );
    check(checks, "restart-search-finds-needle", search.results?.length >= 1, `results=${search.results?.length || 0}.`);

    const summary = {
      pass: checks.filter((item) => item.status === "pass").length,
      warn: checks.filter((item) => item.status === "warn").length,
      fail: checks.filter((item) => item.status === "fail").length
    };
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      summary,
      runRoot,
      fixtureRoot,
      fixture,
      canceled: {
        rootId,
        jobId: canceledJob?.id || null,
        status: canceledJob?.status || null,
        progress: canceledJob?.progress || null,
        searchPresentAfterCancel: Boolean(canceledRoot?.search),
        manifestPresentAfterCancel: Boolean(canceledRoot?.manifest)
      },
      restart: {
        jobId: restartJobId,
        searchCount: completedRoot?.search?.count || 0,
        contentIndexed: completedRoot?.search?.contentIndexed || 0,
        folders: completedRoot?.search?.folders || 0,
        searchReturned: search?.results?.length || 0
      },
      checks,
      serverOutput: serverOutput.slice(-4000)
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`background index cancel: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
  console.error(serverOutput);
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
