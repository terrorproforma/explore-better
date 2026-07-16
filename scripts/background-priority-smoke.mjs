import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `background-priority-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const foregroundRoot = path.join(fixtureRoot, "foreground");
const backgroundRoot = path.join(fixtureRoot, "background");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "background-priority-latest.json");
const latestMdPath = path.join(artifactsDir, "background-priority-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_BACKGROUND_PRIORITY_KEEP_FIXTURE === "1";
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
    throw new Error(data.error || `Request failed: ${response.status}`);
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

async function waitForBackgroundComplete(baseUrl, rootId) {
  const started = performance.now();
  while (performance.now() - started < 30000) {
    const overview = await requestJson(baseUrl, "/api/background-indexes");
    const root = overview.roots?.find((item) => item.id === rootId);
    if (!root) throw new Error("Background root disappeared.");
    if (root.job?.status === "error") throw new Error(root.job.error || "Background index failed.");
    if (!root.job || root.job.status === "complete") return root;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("Background index did not finish in time.");
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

async function writeFiles(dir, count, prefix) {
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const name = `${prefix}-${String(index).padStart(4, "0")}.txt`;
    const filePath = path.join(dir, name);
    const text =
      index === count - 1
        ? `${prefix} final file\npriority lane content needle\n`
        : `${prefix} file ${index}\nordinary priority smoke content\n`;
    files.push(fs.writeFile(filePath, text, "utf8"));
  }
  await Promise.all(files);
}

async function prepareFixture(count) {
  await writeFiles(foregroundRoot, count, "foreground");
  await writeFiles(backgroundRoot, count, "background");
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Background Priority Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

Foreground concurrency: ${report.foreground.concurrency}
Background list concurrency: ${JSON.stringify(report.background.listConcurrency)}
Background content concurrency: ${JSON.stringify(report.background.contentConcurrency)}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const count = Number(optionValue("--count", process.env.EB_BACKGROUND_PRIORITY_COUNT || "96"));
  await prepareFixture(Number.isFinite(count) && count >= 24 ? count : 96);
  const port = Number(optionValue("--port", process.env.PORT || 47600 + Math.floor(Math.random() * 2000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const foregroundConcurrency = Number(optionValue("--foreground-concurrency", "24"));
  const backgroundConcurrency = Number(optionValue("--background-concurrency", "3"));
  const contentConcurrency = Number(optionValue("--content-concurrency", "2"));
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      EXPLORE_BETTER_LIST_CONCURRENCY: String(foregroundConcurrency),
      EXPLORE_BETTER_BACKGROUND_LIST_CONCURRENCY: String(backgroundConcurrency),
      EXPLORE_BETTER_CONTENT_INDEX_CONCURRENCY: String(contentConcurrency),
      EXPLORE_BETTER_DISABLE_NATIVE_LISTING: "1"
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

  let foregroundIndex = null;
  let completedRoot = null;
  let backgroundSearch = null;
  try {
    await waitForServer(baseUrl, server);
    foregroundIndex = await requestJson(baseUrl, "/api/index/build", {
      method: "POST",
      body: JSON.stringify({
        path: foregroundRoot,
        wait: true,
        includeDimensions: false,
        includeLinks: false
      })
    });
    check(
      checks,
      "foreground-uses-high-concurrency",
      Number(foregroundIndex.index?.listTiming?.concurrency || 0) === foregroundConcurrency &&
        foregroundIndex.index?.listTiming?.priority === "foreground",
      `priority=${foregroundIndex.index?.listTiming?.priority}; concurrency=${foregroundIndex.index?.listTiming?.concurrency}.`
    );

    const started = await requestJson(baseUrl, "/api/background-indexes/start", {
      method: "POST",
      body: JSON.stringify({
        path: backgroundRoot,
        recursive: true,
        includeDimensions: false,
        includeLinks: false,
        includeContent: true,
        maxContentBytes: 2048,
        maxContentFiles: 200,
        maxFolders: 4,
        maxEntries: 400
      })
    });
    const rootId = started.job?.rootId || started.root?.id || started.roots?.[0]?.id;
    check(checks, "background-started", Boolean(rootId), `rootId=${rootId || "missing"}.`);
    completedRoot = await waitForBackgroundComplete(baseUrl, rootId);
    const manifest = completedRoot.manifest || {};
    check(checks, "background-manifest-priority", manifest.priority === "background", `priority=${manifest.priority || "missing"}.`);
    check(
      checks,
      "background-list-low-concurrency",
      Number(manifest.listConcurrency?.max || 0) === backgroundConcurrency,
      `list=${JSON.stringify(manifest.listConcurrency || null)}.`
    );
    check(
      checks,
      "background-content-bounded-concurrency",
      Number(manifest.contentConcurrency?.max || 0) === contentConcurrency,
      `content=${JSON.stringify(manifest.contentConcurrency || null)}.`
    );

    backgroundSearch = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "priority lane content needle", rootId, limit: "20" })}`
    );
    check(checks, "background-search-still-hits", (backgroundSearch.results || []).length >= 1, `returned=${backgroundSearch.results?.length || 0}.`);

    const summary = {
      pass: checks.filter((item) => item.status === "pass").length,
      warn: checks.filter((item) => item.status === "warn").length,
      fail: checks.filter((item) => item.status === "fail").length
    };
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixture: { foregroundRoot, backgroundRoot },
      foreground: {
        concurrency: Number(foregroundIndex.index?.listTiming?.concurrency || 0),
        priority: foregroundIndex.index?.listTiming?.priority || null,
        count: Number(foregroundIndex.index?.count || 0)
      },
      background: {
        rootId,
        count: Number(completedRoot.search?.count || completedRoot.manifest?.count || 0),
        contentIndexed: Number(completedRoot.search?.contentIndexed || completedRoot.manifest?.contentIndexed || 0),
        priority: completedRoot.manifest?.priority || null,
        listConcurrency: completedRoot.manifest?.listConcurrency || null,
        contentConcurrency: completedRoot.manifest?.contentConcurrency || null,
        searchReturned: backgroundSearch.results?.length || 0
      },
      checks,
      summary,
      serverOutput: serverOutput.slice(-4000)
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`background priority: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
