import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `background-index-operation-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const nested = path.join(fixtureRoot, "nested");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "background-index-operation-latest.json");
const latestMdPath = path.join(artifactsDir, "background-index-operation-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_BACKGROUND_INDEX_OPERATION_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

function summaryFor(checks) {
  return {
    pass: checks.filter((item) => item.status === "pass").length,
    warn: checks.filter((item) => item.status === "warn").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
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

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1500);
    server.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForBackgroundComplete(baseUrl, rootId) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < 30000) {
    const overview = await requestJson(baseUrl, "/api/background-indexes");
    latest = overview.roots.find((item) => item.id === rootId);
    if (!latest) {
      throw new Error("Background root disappeared.");
    }
    if (latest.job?.status === "error") {
      throw new Error(latest.job.error || "Background index failed.");
    }
    if (!latest.job || latest.job.status === "complete") {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Background index did not complete in time. Last root: ${JSON.stringify(latest)}`);
}

async function safeRemoveRunRoot() {
  const resolvedRunRoot = path.resolve(runRoot);
  const resolvedArtifacts = path.resolve(artifactsDir);
  if (!resolvedRunRoot.startsWith(`${resolvedArtifacts}${path.sep}`)) {
    throw new Error(`Refusing to remove run root outside artifacts: ${resolvedRunRoot}`);
  }
  await fs.rm(resolvedRunRoot, { recursive: true, force: true });
}

async function prepareFixture() {
  await fs.mkdir(nested, { recursive: true });
  const initialPath = path.join(nested, "initial-indexed.txt");
  await fs.writeFile(path.join(fixtureRoot, "root.txt"), "root background operation fixture\n", "utf8");
  await fs.writeFile(initialPath, "initial operation index target: amber ledger\n", "utf8");
  return { initialPath };
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Background Index Operation Invalidation Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixture = await prepareFixture();
  await fs.mkdir(appData, { recursive: true });
  const port = Number(optionValue("--port", process.env.PORT || 53500 + Math.floor(Math.random() * 4000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      EXPLORE_BETTER_BACKGROUND_FRESHNESS_TTL_MS: "60000",
      EXPLORE_BETTER_BACKGROUND_AUTO_REBUILD_COOLDOWN_MS: "1000"
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
  let initialOverview = null;
  let createResult = null;
  let rebuiltOverview = null;
  let rebuiltSearch = null;
  const createdName = "operation-created-indexed.txt";
  const createdPath = path.join(nested, createdName);
  try {
    await waitForServer(baseUrl, server);
    const started = await requestJson(baseUrl, "/api/background-indexes/start", {
      method: "POST",
      body: JSON.stringify({
        path: fixtureRoot,
        recursive: true,
        watch: false,
        autoRebuild: true,
        includeContent: true,
        maxContentBytes: 4096,
        maxContentFiles: 20,
        maxFolders: 10,
        maxEntries: 1000
      })
    });
    rootId = started.job?.rootId || started.root?.id || started.roots?.[0]?.id;
    if (!rootId) {
      throw new Error("Start response did not include a root id.");
    }
    initialOverview = await waitForBackgroundComplete(baseUrl, rootId);
    check(
      checks,
      "initial-index-fresh-without-watcher",
      initialOverview.freshness?.status === "fresh" && initialOverview.watcher?.enabled === false,
      `fresh=${initialOverview.freshness?.status}; watcher=${JSON.stringify(initialOverview.watcher || null)}.`
    );

    createResult = await requestJson(baseUrl, "/api/file/create", {
      method: "POST",
      body: JSON.stringify({
        path: nested,
        name: createdName,
        content: "operation owned background index target: sapphire receipt\n",
        conflictMode: "fail"
      })
    });
    const invalidation = createResult.operation?.result?.backgroundIndexInvalidation;
    const affectedRoot = (invalidation?.roots || []).find((root) => root.id === rootId);
    check(
      checks,
      "operation-result-reports-background-index-invalidation",
      invalidation?.affected >= 1 && affectedRoot,
      JSON.stringify(invalidation || null)
    );
    check(
      checks,
      "operation-auto-rebuild-scheduled-without-watcher",
      affectedRoot?.autoRebuild?.scheduled === true || affectedRoot?.autoRebuild?.active === true,
      JSON.stringify(affectedRoot?.autoRebuild || null)
    );
    check(
      checks,
      "operation-create-path-returned",
      createResult.path === createdPath && createResult.operation?.status === "completed",
      `path=${createResult.path}; status=${createResult.operation?.status}.`
    );

    rebuiltOverview = await waitForBackgroundComplete(baseUrl, rootId);
    rebuiltSearch = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "sapphire receipt", rootId, limit: "20" })}`
    );
    check(
      checks,
      "operation-rebuild-recorded-on-root",
      rebuiltOverview.lastAutoRebuildReason === "operation:create-file" && rebuiltOverview.lastAutoRebuildAt,
      `reason=${rebuiltOverview.lastAutoRebuildReason}; at=${rebuiltOverview.lastAutoRebuildAt}.`
    );
    check(
      checks,
      "operation-rebuild-fresh-without-watcher",
      rebuiltOverview.freshness?.status === "fresh" && rebuiltOverview.watcher?.enabled === false,
      `fresh=${rebuiltOverview.freshness?.status}; watcher=${JSON.stringify(rebuiltOverview.watcher || null)}.`
    );
    check(
      checks,
      "operation-rebuild-search-finds-created-file",
      rebuiltSearch.freshness?.stale === false && rebuiltSearch.results.some((item) => item.path === createdPath),
      `stale=${rebuiltSearch.freshness?.stale}; returned=${rebuiltSearch.results?.length || 0}.`
    );
  } catch (error) {
    check(checks, "smoke-execution", false, error.stack || error.message);
  } finally {
    await stopServer(server);
    if (!keepFixture()) {
      await safeRemoveRunRoot().catch(() => {});
    }
  }

  const summary = summaryFor(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    status: summary.fail ? "fail" : "pass",
    runRoot,
    fixtureRoot,
    rootId,
    paths: { ...fixture, createdPath },
    initialOverview,
    createOperation: createResult?.operation || null,
    rebuiltOverview,
    rebuiltSearch: rebuiltSearch
      ? {
          freshness: rebuiltSearch.freshness,
          timing: rebuiltSearch.timing,
          returned: rebuiltSearch.results?.length || 0,
          hit: rebuiltSearch.results?.some((item) => item.path === createdPath) || false
        }
      : null,
    serverOutput: serverOutput.slice(-4000),
    checks,
    summary
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`background index operation invalidation: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  const checks = [{ id: "background-index-operation-error", status: "fail", detail: error.stack || error.message }];
  const summary = summaryFor(checks);
  const report = {
    generatedAt: new Date().toISOString(),
    status: "fail",
    runRoot,
    serverOutput: serverOutput.slice(-4000),
    checks,
    summary
  };
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8").catch(() => {});
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8").catch(() => {});
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
