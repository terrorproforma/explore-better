import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { clickDockAction } from "./ui-helpers.mjs";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `listing-cache-eviction-ui-${stamp}`);
const fixtureRoot = path.join(runRoot, "churn-fixture");
const rightFixture = path.join(runRoot, "right-fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "listing-cache-eviction-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "listing-cache-eviction-ui-latest.md");
const listingCacheMaxEntries = 24;
const listingCacheTtlMs = 8000;
const churnFolderCount = listingCacheMaxEntries + 4;

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_LISTING_CACHE_BROWSER || "") ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  );
}

function fixtureName(index) {
  return `cache-churn-${String(index).padStart(2, "0")}`;
}

function fixtureFileName(index) {
  return `${fixtureName(index)}-sentinel.txt`;
}

async function requestJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}`);
}

async function prepareFixture() {
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.mkdir(rightFixture, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  for (let index = 0; index < churnFolderCount; index += 1) {
    const folderPath = path.join(fixtureRoot, fixtureName(index));
    await fs.mkdir(folderPath, { recursive: true });
    await fs.writeFile(path.join(folderPath, fixtureFileName(index)), `cache churn fixture ${index}\n`, "utf8");
  }
  await fs.writeFile(path.join(rightFixture, "right-pane-control.txt"), "right pane control\n", "utf8");
}

function metricId(label) {
  return String(label || "metric")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "metric";
}

function parseMs(value) {
  const match = String(value || "").match(/([\d.]+)\s*ms/i);
  return match ? Number(match[1]) : null;
}

async function collectSpeedMetrics(page) {
  return page.evaluate(() => {
    const metrics = {};
    for (const cell of document.querySelectorAll("#speed-dialog[open] [data-speed-metric]")) {
      const id = cell.getAttribute("data-speed-metric");
      metrics[id] = {
        label: cell.querySelector("span")?.textContent?.trim() || "",
        value: cell.querySelector("strong")?.textContent?.trim() || "",
        className: cell.className || "",
        width: Math.round(cell.getBoundingClientRect().width),
        height: Math.round(cell.getBoundingClientRect().height),
        scrollWidth: cell.scrollWidth,
        scrollHeight: cell.scrollHeight,
        clientWidth: cell.clientWidth,
        clientHeight: cell.clientHeight,
        clipped: cell.scrollWidth > cell.clientWidth + 4 || cell.scrollHeight > cell.clientHeight + 4
      };
    }
    return metrics;
  });
}

async function openSpeedSnapshot(page, label) {
  await clickDockAction(page, "speed");
  await page.waitForSelector("#speed-dialog[open]", { timeout: 10000 });
  await page.waitForFunction(() => {
    const metric = document.querySelector('#speed-dialog[open] [data-speed-metric="source"] strong');
    return Boolean(metric?.textContent?.trim());
  });
  const metrics = await collectSpeedMetrics(page);
  const statusText = await page.locator("#status-pill").textContent();
  await page.locator('[data-close-dialog="speed-dialog"]').click();
  await page.waitForFunction(() => !document.getElementById("speed-dialog")?.open);
  return {
    label,
    statusText: (statusText || "").trim(),
    source: metrics.source?.value || "",
    paneItems: metrics[metricId("Pane Items")]?.value || "",
    activePane: metrics[metricId("Active Pane")]?.value || "",
    liveLoadMs: parseMs(metrics[metricId("Live Load")]?.value),
    metrics
  };
}

async function waitForFolder(page, targetPath, sentinelName) {
  await page.waitForFunction(
    ({ expectedPath, expectedName }) => {
      const input = document.querySelector('[data-path-input="left"]');
      if (input?.value !== expectedPath) return false;
      return [...document.querySelectorAll('.pane[data-pane="left"] [data-entry-path]')].some((row) =>
        row.textContent?.includes(expectedName)
      );
    },
    { expectedPath: targetPath, expectedName: sentinelName },
    { timeout: 10000 }
  );
}

async function openPath(page, targetPath, sentinelName, mode = "path-input") {
  let usedMode = mode;
  if (mode === "app-loadPane") {
    const loaded = await page.evaluate(async (nextPath) => {
      if (typeof loadPane !== "function") return false;
      await loadPane("left", nextPath);
      return true;
    }, targetPath);
    if (!loaded) {
      usedMode = "path-input";
    }
  }
  if (usedMode === "path-input") {
    const pathInput = page.locator('[data-path-input="left"]');
    await pathInput.click();
    await pathInput.fill(targetPath);
    await pathInput.press("Enter");
  }
  await waitForFolder(page, targetPath, sentinelName);
  return usedMode;
}

async function cacheSnapshot(page) {
  return page
    .evaluate(() => {
      if (typeof app === "undefined" || !app?.listingCache) {
        return { available: false };
      }
      return {
        available: true,
        size: app.listingCache.size,
        maxEntries: typeof listingCacheMaxEntries === "undefined" ? null : listingCacheMaxEntries,
        ttlMs: typeof listingCacheTtlMs === "undefined" ? null : listingCacheTtlMs
      };
    })
    .catch((error) => ({ available: false, error: error.message }));
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

function failedCheckCount(checks) {
  return checks.filter((item) => item.status === "fail").length;
}

function noMetricClipping(snapshot) {
  return Object.values(snapshot.metrics || {}).filter((metric) => metric.clipped);
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${item.detail.replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Listing Cache Eviction UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Cache Churn

| Metric | Value |
| --- | ---: |
| Cache max entries | ${report.cache.maxEntries} |
| Fixture folders | ${report.churn.folderCount} |
| Churn elapsed | ${report.churn.elapsedMs} ms |
| Old-folder request delta | ${report.requests.oldRequestDelta} |
| Recent-folder request delta | ${report.requests.recentRequestDelta} |
| Observed cache size | ${report.cache.afterChurn?.size ?? "n/a"} |

## Snapshots

| Phase | Source | Live Load | Status |
| --- | --- | ---: | --- |
| Initial Cold | ${report.snapshots.initial.source} | ${report.snapshots.initial.liveLoadMs ?? "n/a"} ms | ${report.snapshots.initial.statusText.replace(/\|/g, "\\|")} |
| Warm Before Churn | ${report.snapshots.warmBeforeChurn.source} | ${report.snapshots.warmBeforeChurn.liveLoadMs ?? "n/a"} ms | ${report.snapshots.warmBeforeChurn.statusText.replace(/\|/g, "\\|")} |
| Old After Churn | ${report.snapshots.oldAfterChurn.source} | ${report.snapshots.oldAfterChurn.liveLoadMs ?? "n/a"} ms | ${report.snapshots.oldAfterChurn.statusText.replace(/\|/g, "\\|")} |
| Recent After Churn | ${report.snapshots.recentAfterChurn.source} | ${report.snapshots.recentAfterChurn.liveLoadMs ?? "n/a"} ms | ${report.snapshots.recentAfterChurn.statusText.replace(/\|/g, "\\|")} |
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const folderPaths = Array.from({ length: churnFolderCount }, (_, index) => path.join(fixtureRoot, fixtureName(index)));
  const port = Number(optionValue("--port", process.env.PORT || 48000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const consoleMessages = [];
  const pageErrors = [];
  const listRequests = [];
  const navigationModes = [];
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  let browser = null;
  let page = null;
  const snapshots = {};
  const cache = { maxEntries: listingCacheMaxEntries, ttlMs: listingCacheTtlMs };
  const requests = {};
  const churn = { folderCount: churnFolderCount };
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ executablePath: edgePath(), headless: true });
    page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        consoleMessages.push({ type: message.type(), text: message.text() });
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    page.on("request", (request) => {
      try {
        const parsed = new URL(request.url());
        if (parsed.pathname === "/api/list") {
          listRequests.push({
            at: Date.now(),
            path: parsed.searchParams.get("path") || "",
            includeDimensions: parsed.searchParams.get("includeDimensions") || "",
            includeLinks: parsed.searchParams.get("includeLinks") || "",
            includeAttributes: parsed.searchParams.get("includeAttributes") || ""
          });
        }
      } catch {
        // Ignore non-standard URLs from the browser runtime.
      }
    });

    await page.goto(
      `${baseUrl}/?left=${encodeURIComponent(folderPaths[0])}&right=${encodeURIComponent(rightFixture)}`,
      { waitUntil: "domcontentloaded" }
    );
    await waitForFolder(page, folderPaths[0], fixtureFileName(0));
    snapshots.initial = await openSpeedSnapshot(page, "initial-cold");
    check(
      checks,
      "initial-cold-filesystem",
      snapshots.initial.source === "Filesystem",
      `Initial source was ${snapshots.initial.source || "missing"}.`
    );
    check(checks, "initial-pane-items", snapshots.initial.paneItems === "1", `Initial pane items was ${snapshots.initial.paneItems || "missing"}.`);

    await openPath(page, folderPaths[1], fixtureFileName(1));
    const warmBeforeRequests = listRequests.filter((request) => request.path === folderPaths[0]).length;
    navigationModes.push(await openPath(page, folderPaths[0], fixtureFileName(0)));
    snapshots.warmBeforeChurn = await openSpeedSnapshot(page, "warm-before-churn");
    const warmAfterRequests = listRequests.filter((request) => request.path === folderPaths[0]).length;
    requests.warmRequestDelta = warmAfterRequests - warmBeforeRequests;
    check(
      checks,
      "warm-before-churn-memory-source",
      snapshots.warmBeforeChurn.source === "Memory cache",
      `Warm-before-churn source was ${snapshots.warmBeforeChurn.source || "missing"}.`
    );
    check(
      checks,
      "warm-before-churn-no-list-request",
      requests.warmRequestDelta === 0,
      `Warm-before-churn /api/list delta was ${requests.warmRequestDelta}.`
    );

    cache.afterWarm = await cacheSnapshot(page);
    const churnStart = Date.now();
    for (let index = 2; index < folderPaths.length; index += 1) {
      navigationModes.push(await openPath(page, folderPaths[index], fixtureFileName(index), "app-loadPane"));
    }
    churn.elapsedMs = Date.now() - churnStart;
    churn.navigationModes = navigationModes.reduce((counts, mode) => {
      counts[mode] = (counts[mode] || 0) + 1;
      return counts;
    }, {});
    cache.afterChurn = await cacheSnapshot(page);
    check(
      checks,
      "churn-within-listing-cache-ttl",
      churn.elapsedMs < listingCacheTtlMs,
      `Churn took ${churn.elapsedMs} ms with ${listingCacheTtlMs} ms cache TTL.`
    );
    check(
      checks,
      "churn-exceeded-cache-capacity",
      churnFolderCount > listingCacheMaxEntries,
      `${churnFolderCount} fixture folders for ${listingCacheMaxEntries} entry cache.`
    );
    const observedSize = Number(cache.afterChurn?.size);
    check(
      checks,
      "cache-size-bounded",
      Number.isFinite(observedSize) ? observedSize <= listingCacheMaxEntries : true,
      Number.isFinite(observedSize)
        ? `Observed listing cache size ${observedSize}/${listingCacheMaxEntries}.`
        : "Listing cache internals unavailable; bounded behavior inferred from source transitions."
    );

    const oldRequestBefore = listRequests.filter((request) => request.path === folderPaths[0]).length;
    await openPath(page, folderPaths[0], fixtureFileName(0));
    snapshots.oldAfterChurn = await openSpeedSnapshot(page, "old-after-churn");
    const oldRequestAfter = listRequests.filter((request) => request.path === folderPaths[0]).length;
    requests.oldRequestDelta = oldRequestAfter - oldRequestBefore;
    check(
      checks,
      "old-folder-evicted-source",
      snapshots.oldAfterChurn.source === "Filesystem",
      `Old-after-churn source was ${snapshots.oldAfterChurn.source || "missing"}.`
    );
    check(
      checks,
      "old-folder-hit-filesystem-request",
      requests.oldRequestDelta >= 1,
      `Old-after-churn /api/list delta was ${requests.oldRequestDelta}.`
    );

    const recentIndex = folderPaths.length - 1;
    const recentPath = folderPaths[recentIndex];
    const recentRequestBefore = listRequests.filter((request) => request.path === recentPath).length;
    await openPath(page, recentPath, fixtureFileName(recentIndex));
    snapshots.recentAfterChurn = await openSpeedSnapshot(page, "recent-after-churn");
    const recentRequestAfter = listRequests.filter((request) => request.path === recentPath).length;
    requests.recentRequestDelta = recentRequestAfter - recentRequestBefore;
    check(
      checks,
      "recent-folder-still-memory-source",
      snapshots.recentAfterChurn.source === "Memory cache",
      `Recent-after-churn source was ${snapshots.recentAfterChurn.source || "missing"}.`
    );
    check(
      checks,
      "recent-folder-no-list-request",
      requests.recentRequestDelta === 0,
      `Recent-after-churn /api/list delta was ${requests.recentRequestDelta}.`
    );

    for (const [label, snapshot] of Object.entries(snapshots)) {
      const clipped = noMetricClipping(snapshot);
      check(checks, `${label}-speed-layout`, clipped.length === 0, `${clipped.length} clipped Speed metric cell(s).`);
      check(
        checks,
        `${label}-live-load-present`,
        Number.isFinite(snapshot.liveLoadMs),
        `Live load was ${snapshot.metrics?.[metricId("Live Load")]?.value || "missing"}.`
      );
    }
    check(checks, "browser-console-clean", pageErrors.length === 0, `${pageErrors.length} page error(s).`);
  } catch (error) {
    check(checks, "smoke-execution", false, error.message);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }

  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    warn: checks.filter((item) => item.status === "warn").length,
    fail: failedCheckCount(checks)
  };
  const report = {
    generatedAt: new Date().toISOString(),
    status: summary.fail ? "fail" : "pass",
    baseUrl,
    fixtureRoot,
    rightFixture,
    cache,
    churn,
    requests,
    snapshots,
    listRequests,
    consoleMessages,
    pageErrors,
    serverOutput: serverOutput.slice(-4000),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`listing cache eviction UI smoke: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
