import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { clickDockAction } from "./ui-helpers.mjs";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `listing-prefetch-ui-${stamp}`);
const leftFixture = path.join(runRoot, "left-fixture");
const rightFixture = path.join(runRoot, "right-fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "listing-prefetch-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "listing-prefetch-ui-latest.md");
const prefetchFolderCount = 14;
const listingPrefetchMaxActive = 2;
const targetIndex = 0;

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

function folderName(index) {
  return `prefetch-target-${String(index).padStart(2, "0")}`;
}

function sentinelName(index) {
  return `${folderName(index)}-inside.txt`;
}

function defer() {
  let resolve = null;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  await fs.mkdir(leftFixture, { recursive: true });
  await fs.mkdir(rightFixture, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  for (let index = 0; index < prefetchFolderCount; index += 1) {
    const folderPath = path.join(leftFixture, folderName(index));
    await fs.mkdir(folderPath, { recursive: true });
    await fs.writeFile(path.join(folderPath, sentinelName(index)), `prefetched folder ${index}\n`, "utf8");
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

async function waitForFolder(page, targetPath, expectedName) {
  await page.waitForFunction(
    ({ pathValue, name }) => {
      const input = document.querySelector('[data-path-input="left"]');
      if (input?.value !== pathValue) return false;
      return [...document.querySelectorAll('.pane[data-pane="left"] [data-entry-path]')].some((row) =>
        row.textContent?.includes(name)
      );
    },
    { pathValue: targetPath, name: expectedName },
    { timeout: 10000 }
  );
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

function noMetricClipping(snapshot) {
  return Object.values(snapshot.metrics || {}).filter((metric) => metric.clipped);
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${item.detail.replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Listing Prefetch UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Prefetch

| Metric | Value |
| --- | ---: |
| Hovered folders | ${report.prefetch.hoveredFolders} |
| Started while held | ${report.prefetch.startedWhileHeld} |
| Max active budget | ${report.prefetch.maxActive} |
| Target request delta on open | ${report.prefetch.targetOpenRequestDelta} |
| Target source after open | ${report.snapshots.afterOpen?.source || "n/a"} |

## Snapshots

| Phase | Source | Live Load | Status |
| --- | --- | ---: | --- |
| Initial | ${report.snapshots.initial?.source || "n/a"} | ${report.snapshots.initial?.liveLoadMs ?? "n/a"} ms | ${String(report.snapshots.initial?.statusText || "n/a").replace(/\|/g, "\\|")} |
| After Prefetch Open | ${report.snapshots.afterOpen?.source || "n/a"} | ${report.snapshots.afterOpen?.liveLoadMs ?? "n/a"} ms | ${String(report.snapshots.afterOpen?.statusText || "n/a").replace(/\|/g, "\\|")} |
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 48000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const folderPaths = Array.from({ length: prefetchFolderCount }, (_, index) => path.join(leftFixture, folderName(index)));
  const targetPath = folderPaths[targetIndex];
  const targetSentinel = sentinelName(targetIndex);
  const checks = [];
  const consoleMessages = [];
  const pageErrors = [];
  const listRequests = [];
  const heldRoutes = [];
  const routeRelease = defer();
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
  const prefetch = {
    hoveredFolders: prefetchFolderCount,
    maxActive: listingPrefetchMaxActive
  };
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
          listRequests.push({ at: Date.now(), path: parsed.searchParams.get("path") || "" });
        }
      } catch {
        // Ignore browser-internal URLs.
      }
    });
    await page.route("**/api/list?**", async (route) => {
      const parsed = new URL(route.request().url());
      const requestedPath = parsed.searchParams.get("path") || "";
      if (folderPaths.includes(requestedPath)) {
        heldRoutes.push({ path: requestedPath, at: Date.now() });
        await routeRelease.promise;
      }
      await route.continue();
    });

    await page.goto(
      `${baseUrl}/?left=${encodeURIComponent(leftFixture)}&right=${encodeURIComponent(rightFixture)}`,
      { waitUntil: "domcontentloaded" }
    );
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await page.waitForFunction(
      (minimum) => document.querySelectorAll('.pane[data-pane="left"] [data-entry-path]').length >= minimum,
      prefetchFolderCount,
      { timeout: 10000 }
    );
    snapshots.initial = await openSpeedSnapshot(page, "initial");
    check(checks, "initial-filesystem-source", snapshots.initial.source === "Filesystem", `Initial source was ${snapshots.initial.source || "missing"}.`);
    check(
      checks,
      "initial-folder-count",
      snapshots.initial.paneItems === String(prefetchFolderCount),
      `Initial pane item count was ${snapshots.initial.paneItems || "missing"}.`
    );

    for (let index = 0; index < prefetchFolderCount; index += 1) {
      await page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: folderName(index) }).hover();
    }
    await page.waitForTimeout(650);
    prefetch.startedWhileHeld = heldRoutes.length;
    prefetch.heldPaths = heldRoutes.map((item) => item.path);
    check(
      checks,
      "prefetch-started",
      prefetch.startedWhileHeld >= 1,
      `${prefetch.startedWhileHeld} prefetch request(s) started while held.`
    );
    check(
      checks,
      "prefetch-active-bound",
      prefetch.startedWhileHeld <= listingPrefetchMaxActive,
      `${prefetch.startedWhileHeld} prefetch request(s) started with max active ${listingPrefetchMaxActive}.`
    );
    check(
      checks,
      "target-prefetch-started",
      heldRoutes.some((item) => item.path === targetPath),
      `Target prefetch ${heldRoutes.some((item) => item.path === targetPath) ? "started" : "did not start"}.`
    );

    const targetResponse = page.waitForResponse((response) => {
      try {
        const parsed = new URL(response.url());
        return parsed.pathname === "/api/list" && parsed.searchParams.get("path") === targetPath && response.status() === 200;
      } catch {
        return false;
      }
    });
    routeRelease.resolve();
    await targetResponse;
    await page.waitForTimeout(120);

    const targetRequestsBeforeOpen = listRequests.filter((request) => request.path === targetPath).length;
    await page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: folderName(targetIndex) }).dblclick();
    await waitForFolder(page, targetPath, targetSentinel);
    snapshots.afterOpen = await openSpeedSnapshot(page, "after-prefetch-open");
    const targetRequestsAfterOpen = listRequests.filter((request) => request.path === targetPath).length;
    prefetch.targetOpenRequestDelta = targetRequestsAfterOpen - targetRequestsBeforeOpen;

    check(
      checks,
      "open-used-prefetched-cache",
      snapshots.afterOpen.source === "Memory cache",
      `After-open source was ${snapshots.afterOpen.source || "missing"}.`
    );
    check(
      checks,
      "open-did-not-fetch-target-again",
      prefetch.targetOpenRequestDelta === 0,
      `Target /api/list delta on open was ${prefetch.targetOpenRequestDelta}.`
    );
    check(
      checks,
      "opened-target-folder",
      snapshots.afterOpen.paneItems === "1",
      `After-open pane item count was ${snapshots.afterOpen.paneItems || "missing"}.`
    );

    for (const [label, snapshot] of Object.entries(snapshots)) {
      const clipped = noMetricClipping(snapshot);
      check(checks, `${label}-speed-layout`, clipped.length === 0, `${clipped.length} clipped Speed metric cell(s).`);
      check(checks, `${label}-live-load-present`, Number.isFinite(snapshot.liveLoadMs), `Live load was ${snapshot.liveLoadMs ?? "missing"}.`);
    }
    check(checks, "browser-console-clean", pageErrors.length === 0, `${pageErrors.length} page error(s).`);
  } catch (error) {
    routeRelease.resolve();
    check(checks, "smoke-execution", false, error.message);
  } finally {
    routeRelease.resolve();
    await browser?.close().catch(() => {});
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
    baseUrl,
    leftFixture,
    rightFixture,
    targetPath,
    prefetch,
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
  console.log(`listing prefetch UI smoke: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
