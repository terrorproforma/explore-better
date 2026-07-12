import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `scripting-mutation-cache-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const leftDir = path.join(fixtureRoot, "left-pane");
const rightDir = path.join(fixtureRoot, "right-pane");
const nested = path.join(rightDir, "nested");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "scripting-mutation-cache-latest.json");
const latestMdPath = path.join(artifactsDir, "scripting-mutation-cache-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_SCRIPTING_MUTATION_KEEP_FIXTURE === "1";
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
  await fs.mkdir(leftDir, { recursive: true });
  await fs.mkdir(nested, { recursive: true });
  const selectedFile = path.join(leftDir, "selected-source.txt");
  const initialIndexed = path.join(nested, "initial-indexed.txt");
  await fs.writeFile(selectedFile, "selected file copied by trusted script\n", "utf8");
  await fs.writeFile(path.join(leftDir, "visible-extra.txt"), "left listing row\n", "utf8");
  await fs.writeFile(initialIndexed, "initial script mutation index target: amber ledger\n", "utf8");
  await fs.writeFile(path.join(rightDir, "right-root.txt"), "right pane warm listing root\n", "utf8");
  await fs.mkdir(appData, { recursive: true });
  return { selectedFile, initialIndexed };
}

function directScriptCode() {
  return `
const outputDir = await api.mkdir(context.otherPath, "script-mutation-output");
const notePath = await api.writeText(
  path.join(outputDir, "script-index-note.txt"),
  "trusted script background index target: violet receipt\\n"
);
const copied = await api.copy(context.selectedPaths, outputDir);
return { outputDir, notePath, copied };
`;
}

function listRoute(dir) {
  return `/api/list?${new URLSearchParams({ path: dir, showHidden: "true", includeSignature: "true" })}`;
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Scripting Mutation Cache Smoke

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
  const port = Number(optionValue("--port", process.env.PORT || 54500 + Math.floor(Math.random() * 4000)));
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
  let coldList = null;
  let warmList = null;
  let scriptResult = null;
  let afterScriptList = null;
  let postScriptWarmList = null;
  const postScriptWarmAttempts = [];
  let rebuiltOverview = null;
  let rebuiltSearch = null;
  const outputDir = path.join(rightDir, "script-mutation-output");
  const notePath = path.join(outputDir, "script-index-note.txt");
  const copiedPath = path.join(outputDir, "selected-source.txt");
  try {
    await waitForServer(baseUrl, server);
    const started = await requestJson(baseUrl, "/api/background-indexes/start", {
      method: "POST",
      body: JSON.stringify({
        path: rightDir,
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

    const route = listRoute(rightDir);
    coldList = await requestJson(baseUrl, route);
    warmList = await requestJson(baseUrl, route);
    check(checks, "listing-cache-warmed-before-script", warmList.cache?.hit === true, `hit=${warmList.cache?.hit}; scanned=${warmList.scanned}.`);

    scriptResult = await requestJson(baseUrl, "/api/script", {
      method: "POST",
      body: JSON.stringify({
        code: directScriptCode(),
        scriptId: "scripting-mutation-cache-smoke",
        name: "Scripting Mutation Cache Smoke",
        activePane: "left",
        activePath: leftDir,
        contextPath: leftDir,
        otherPath: rightDir,
        selectedPaths: [fixture.selectedFile],
        panes: {
          left: { path: leftDir, selectedPaths: [fixture.selectedFile], focusedPath: fixture.selectedFile },
          right: { path: rightDir, selectedPaths: [], focusedPath: null }
        },
        timeoutMs: 15000
      })
    });
    const cacheInvalidation = scriptResult.cacheInvalidation || scriptResult.operation?.result?.cacheInvalidation;
    const backgroundInvalidation =
      scriptResult.backgroundIndexInvalidation || scriptResult.operation?.result?.backgroundIndexInvalidation;
    const affectedRoot = (backgroundInvalidation?.roots || []).find((root) => root.id === rootId);
    check(
      checks,
      "script-operation-completed",
      scriptResult.operation?.status === "completed" && scriptResult.result?.notePath === notePath,
      `status=${scriptResult.operation?.status}; note=${scriptResult.result?.notePath}.`
    );
    check(
      checks,
      "script-result-reports-listing-invalidation",
      Number(cacheInvalidation?.invalidated || 0) >= 1 && (cacheInvalidation?.dirs || []).some((dir) => dir === rightDir),
      JSON.stringify(cacheInvalidation || null)
    );
    check(
      checks,
      "script-result-reports-background-index-invalidation",
      Number(backgroundInvalidation?.affected || 0) >= 1 && affectedRoot,
      JSON.stringify(backgroundInvalidation || null)
    );
    check(
      checks,
      "script-auto-rebuild-scheduled-without-watcher",
      affectedRoot?.autoRebuild?.source === "script" &&
        (affectedRoot?.autoRebuild?.scheduled === true || affectedRoot?.autoRebuild?.active === true),
      JSON.stringify(affectedRoot?.autoRebuild || null)
    );

    afterScriptList = await requestJson(baseUrl, route);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      postScriptWarmList = await requestJson(baseUrl, route);
      postScriptWarmAttempts.push({
        attempt: attempt + 1,
        cache: postScriptWarmList.cache,
        returned: postScriptWarmList.entries?.length || 0,
        scanned: postScriptWarmList.scanned
      });
      if (postScriptWarmList.cache?.hit === true) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    check(
      checks,
      "script-listing-cache-invalidated-before-next-list",
      afterScriptList.cache?.hit !== true && afterScriptList.entries.some((entry) => entry.path === outputDir),
      `hit=${afterScriptList.cache?.hit}; missReason=${afterScriptList.cache?.missReason}; rows=${afterScriptList.entries?.length || 0}.`
    );
    check(
      checks,
      "script-listing-cache-rewarms-after-miss",
      postScriptWarmList.cache?.hit === true,
      `hit=${postScriptWarmList.cache?.hit}; attempts=${postScriptWarmAttempts.length}; reason=${postScriptWarmList.cache?.reason || "n/a"}.`
    );

    rebuiltOverview = await waitForBackgroundComplete(baseUrl, rootId);
    rebuiltSearch = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "violet receipt", rootId, limit: "20" })}`
    );
    check(
      checks,
      "script-rebuild-recorded-on-root",
      rebuiltOverview.lastAutoRebuildReason === "script" && rebuiltOverview.lastAutoRebuildAt,
      `reason=${rebuiltOverview.lastAutoRebuildReason}; at=${rebuiltOverview.lastAutoRebuildAt}.`
    );
    check(
      checks,
      "script-rebuild-fresh-without-watcher",
      rebuiltOverview.freshness?.status === "fresh" && rebuiltOverview.watcher?.enabled === false,
      `fresh=${rebuiltOverview.freshness?.status}; watcher=${JSON.stringify(rebuiltOverview.watcher || null)}.`
    );
    check(
      checks,
      "script-rebuild-search-finds-written-file",
      rebuiltSearch.freshness?.stale === false && rebuiltSearch.results.some((item) => item.path === notePath),
      `stale=${rebuiltSearch.freshness?.stale}; returned=${rebuiltSearch.results?.length || 0}.`
    );
    check(
      checks,
      "script-mutated-files-exist",
      (await fs.stat(notePath)).isFile() && (await fs.stat(copiedPath)).isFile(),
      `note=${notePath}; copied=${copiedPath}.`
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
    leftDir,
    rightDir,
    rootId,
    paths: { ...fixture, outputDir, notePath, copiedPath },
    initialOverview,
    listing: {
      cold: coldList ? { cache: coldList.cache, returned: coldList.entries?.length || 0, scanned: coldList.scanned } : null,
      warm: warmList ? { cache: warmList.cache, returned: warmList.entries?.length || 0, scanned: warmList.scanned } : null,
      afterScript: afterScriptList
        ? { cache: afterScriptList.cache, returned: afterScriptList.entries?.length || 0, scanned: afterScriptList.scanned }
        : null,
      postScriptWarm: postScriptWarmList
        ? { cache: postScriptWarmList.cache, returned: postScriptWarmList.entries?.length || 0, scanned: postScriptWarmList.scanned }
        : null,
      postScriptWarmAttempts
    },
    scriptOperation: scriptResult?.operation || null,
    scriptResult: scriptResult
      ? {
          scriptId: scriptResult.scriptId,
          selectedCount: scriptResult.selectedCount,
          result: scriptResult.result,
          cacheInvalidation: scriptResult.cacheInvalidation,
          backgroundIndexInvalidation: scriptResult.backgroundIndexInvalidation
        }
      : null,
    rebuiltOverview,
    rebuiltSearch: rebuiltSearch
      ? {
          freshness: rebuiltSearch.freshness,
          timing: rebuiltSearch.timing,
          returned: rebuiltSearch.results?.length || 0,
          hit: rebuiltSearch.results?.some((item) => item.path === notePath) || false
        }
      : null,
    serverOutput: serverOutput.slice(-4000),
    checks,
    summary
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`scripting mutation cache: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  const checks = [{ id: "scripting-mutation-cache-error", status: "fail", detail: error.stack || error.message }];
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
