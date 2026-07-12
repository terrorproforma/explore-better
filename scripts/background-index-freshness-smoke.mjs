import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `background-index-freshness-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const nested = path.join(fixtureRoot, "nested");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "background-index-freshness-latest.json");
const latestMdPath = path.join(artifactsDir, "background-index-freshness-latest.md");

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

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function prepareFixture() {
  await fs.mkdir(nested, { recursive: true });
  const initialPath = path.join(nested, "initial-indexed.txt");
  await fs.writeFile(path.join(fixtureRoot, "root.txt"), "root\n", "utf8");
  await fs.writeFile(initialPath, "initial warm index target: aurora ledger\n", "utf8");
  return { initialPath };
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Background Index Freshness Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Freshness

| Stage | Status | Reason |
| --- | --- | --- |
| Initial | ${report.initialOverview?.freshness?.status || "n/a"} | ${report.initialOverview?.freshness?.reason || ""} |
| After Mutation | ${report.staleOverview?.freshness?.status || "n/a"} | ${report.staleOverview?.freshness?.reason || ""} |
| After Auto Rebuild | ${report.rebuiltOverview?.freshness?.status || "n/a"} | ${report.rebuiltOverview?.freshness?.reason || ""} |
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixture = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 50000 + Math.floor(Math.random() * 10000)));
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
      EXPLORE_BETTER_BACKGROUND_FRESHNESS_TTL_MS: "500",
      EXPLORE_BETTER_BACKGROUND_AUTO_REBUILD_COOLDOWN_MS: "1000"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  let rootId = "";
  let initialOverview = null;
  let staleOverview = null;
  let staleSearch = null;
  let rebuiltOverview = null;
  let rebuiltSearch = null;
  let newPath = "";
  try {
    await waitForServer(baseUrl, server, () => serverOutput);
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

    newPath = path.join(nested, "post-build-new-file.txt");
    await fs.writeFile(newPath, "post build freshness target: chrysanthemum invoice\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 750));

    const afterMutation = await requestJson(baseUrl, "/api/background-indexes");
    staleOverview = afterMutation.roots.find((item) => item.id === rootId);
    staleSearch = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "chrysanthemum invoice", rootId, limit: "20" })}`
    );
    check(
      checks,
      "mutation-reported-stale",
      staleOverview?.freshness?.stale === true && ["folder-count-changed", "folder-modified"].includes(staleOverview.freshness.reason),
      `status=${staleOverview?.freshness?.status}; reason=${staleOverview?.freshness?.reason}.`
    );
    const autoRebuild = staleOverview?.autoRebuild || staleOverview?.freshness?.autoRebuild || null;
    check(
      checks,
      "auto-rebuild-started",
      autoRebuild?.scheduled === true || autoRebuild?.active === true || staleOverview?.job?.status === "running",
      `scheduled=${autoRebuild?.scheduled === true}; active=${autoRebuild?.active === true}; job=${staleOverview?.job?.status || "none"}.`
    );

    rebuiltOverview = await waitForBackgroundComplete(baseUrl, autoRebuild?.job?.rootId || rootId);
    rebuiltSearch = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "chrysanthemum invoice", rootId, limit: "20" })}`
    );
    check(
      checks,
      "auto-rebuild-clears-stale",
      rebuiltOverview.freshness?.status === "fresh" && rebuiltOverview.search?.count >= 3,
      `status=${rebuiltOverview.freshness?.status}; count=${rebuiltOverview.search?.count || 0}.`
    );
    check(
      checks,
      "auto-rebuild-search-finds-new-file",
      rebuiltSearch.freshness?.stale === false && rebuiltSearch.results.some((item) => item.path === newPath),
      `stale=${rebuiltSearch.freshness?.stale}; returned=${rebuiltSearch.results.length}.`
    );
  } catch (error) {
    check(checks, "smoke-execution", false, error.message);
  } finally {
    server.kill();
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
    paths: { ...fixture, newPath },
    initialOverview,
    staleOverview,
    autoRebuild: staleOverview?.autoRebuild || staleOverview?.freshness?.autoRebuild || null,
    staleSearch: staleSearch
      ? {
          freshness: staleSearch.freshness,
          timing: staleSearch.timing,
          returned: staleSearch.results?.length || 0
        }
      : null,
    rebuiltOverview,
    rebuiltSearch: rebuiltSearch
      ? {
          freshness: rebuiltSearch.freshness,
          timing: rebuiltSearch.timing,
          returned: rebuiltSearch.results?.length || 0,
          hit: rebuiltSearch.results?.some((item) => item.path === newPath) || false
        }
      : null,
    serverOutput: serverOutput.slice(-4000),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`background index freshness: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
