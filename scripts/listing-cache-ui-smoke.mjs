import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { clickDockAction } from "./ui-helpers.mjs";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `listing-cache-ui-${stamp}`);
const leftFixture = path.join(runRoot, "left-fixture");
const rightFixture = path.join(runRoot, "right-fixture");
const childFolderName = "Cache Target Folder";
const childFolder = path.join(leftFixture, childFolderName);
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "listing-cache-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "listing-cache-ui-latest.md");

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
  await fs.mkdir(childFolder, { recursive: true });
  await fs.mkdir(rightFixture, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(path.join(childFolder, "inside-cache-target.txt"), "opened child folder\n");
  await fs.writeFile(path.join(leftFixture, "alpha-root.txt"), "root alpha\n");
  await fs.writeFile(path.join(leftFixture, "beta-root.txt"), "root beta\n");
  await fs.writeFile(path.join(leftFixture, "gamma-root.md"), "# root gamma\n");
  await fs.writeFile(path.join(rightFixture, "right-pane-control.txt"), "right pane control\n");
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
  const summaryText = await page.locator("#speed-summary").textContent().catch(() => "");
  await page.locator('[data-close-dialog="speed-dialog"]').click();
  await page.waitForFunction(() => !document.getElementById("speed-dialog")?.open);
  return {
    label,
    statusText: (statusText || "").trim(),
    summaryText: (summaryText || "").trim(),
    source: metrics.source?.value || "",
    paneItems: metrics[metricId("Pane Items")]?.value || "",
    activePane: metrics[metricId("Active Pane")]?.value || "",
    liveLoadMs: parseMs(metrics[metricId("Live Load")]?.value),
    metrics
  };
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
  const cold = report.cold || {};
  const warm = report.warm || {};
  return `# Listing Cache UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Snapshots

| Phase | Source | Pane Items | Live Load | Status |
| --- | --- | --- | --- | --- |
| Cold | ${cold.source || "n/a"} | ${cold.paneItems || "n/a"} | ${cold.liveLoadMs ?? "n/a"} ms | ${String(cold.statusText || "n/a").replace(/\|/g, "\\|")} |
| Warm Revisit | ${warm.source || "n/a"} | ${warm.paneItems || "n/a"} | ${warm.liveLoadMs ?? "n/a"} ms | ${String(warm.statusText || "n/a").replace(/\|/g, "\\|")} |
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 48000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const consoleMessages = [];
  const pageErrors = [];
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
  let cold = null;
  let warm = null;
  const navigation = {};
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

    await page.goto(
      `${baseUrl}/?left=${encodeURIComponent(leftFixture)}&right=${encodeURIComponent(rightFixture)}`,
      { waitUntil: "domcontentloaded" }
    );
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await page.locator('[data-path-input="left"]').click();
    cold = await openSpeedSnapshot(page, "cold");
    check(checks, "cold-filesystem-source", cold.source === "Filesystem", `Cold source was ${cold.source || "missing"}.`);
    check(checks, "cold-active-pane", cold.activePane === "left", `Cold active pane was ${cold.activePane || "missing"}.`);
    check(checks, "cold-pane-items", cold.paneItems === "4", `Cold root item count was ${cold.paneItems || "missing"}.`);
    check(
      checks,
      "cold-live-load",
      Number.isFinite(cold.liveLoadMs),
      `Cold live load was ${cold.metrics?.[metricId("Live Load")]?.value || "missing"}.`
    );
    const coldClipped = noMetricClipping(cold);
    check(checks, "cold-speed-layout", coldClipped.length === 0, `${coldClipped.length} clipped Speed metric cell(s).`);

    const childRow = page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: childFolderName });
    const childCount = await childRow.count();
    check(checks, "child-folder-visible", childCount === 1, `Found ${childCount} child folder row(s).`);
    if (childCount !== 1) {
      throw new Error(`Expected one ${childFolderName} row, found ${childCount}.`);
    }
    const childBox = await childRow.boundingBox();
    if (!childBox) throw new Error(`Could not locate ${childFolderName} for a physical double-click.`);
    const clickPoint = {
      x: childBox.x + Math.min(40, childBox.width / 2),
      y: childBox.y + childBox.height / 2
    };
    await page.mouse.dblclick(clickPoint.x, clickPoint.y, { delay: 40 });
    await page.waitForFunction(
      (expectedPath) => document.querySelector('[data-path-input="left"]')?.value === expectedPath,
      childFolder,
      { timeout: 10000 }
    );
    const insideVisible = await page
      .locator('.pane[data-pane="left"] [data-entry-path]')
      .filter({ hasText: "inside-cache-target.txt" })
      .count();
    navigation.childPath = childFolder;
    navigation.insideVisible = insideVisible === 1;
    check(checks, "double-click-opened-folder", insideVisible === 1, `inside-cache-target.txt visible count ${insideVisible}.`);

    const pathInput = page.locator('[data-path-input="left"]');
    await pathInput.fill(leftFixture);
    await pathInput.press("Enter");
    await page.waitForFunction(
      (expectedPath) => document.querySelector('[data-path-input="left"]')?.value === expectedPath,
      leftFixture,
      { timeout: 10000 }
    );
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("#status-pill")?.textContent?.includes("/ cached"));
    warm = await openSpeedSnapshot(page, "warm-revisit");
    check(checks, "warm-memory-source", warm.source === "Memory cache", `Warm source was ${warm.source || "missing"}.`);
    check(checks, "warm-status-cached", /cached/i.test(warm.statusText), `Warm status was ${warm.statusText || "missing"}.`);
    check(checks, "warm-pane-items", warm.paneItems === "4", `Warm root item count was ${warm.paneItems || "missing"}.`);
    check(
      checks,
      "warm-live-load",
      Number.isFinite(warm.liveLoadMs),
      `Warm live load was ${warm.metrics?.[metricId("Live Load")]?.value || "missing"}.`
    );
    const warmClipped = noMetricClipping(warm);
    check(checks, "warm-speed-layout", warmClipped.length === 0, `${warmClipped.length} clipped Speed metric cell(s).`);
    const missingPath = path.join(runRoot, "missing-folder");
    await pathInput.fill(missingPath);
    await pathInput.press("Enter");
    await page.waitForFunction(
      () => document.querySelector("#status-pill")?.textContent?.includes("Could not open"),
      { timeout: 10000 }
    );
    const missingPathState = await page.evaluate(() => ({
      status: document.querySelector("#status-pill")?.textContent || "",
      path: document.querySelector('[data-path-input="left"]')?.value || "",
      rows: document.querySelectorAll('.pane[data-pane="left"] [data-entry-path]').length
    }));
    check(checks, "missing-path-status", /Could not open/.test(missingPathState.status), missingPathState.status);
    check(checks, "missing-path-restores-current", missingPathState.path === leftFixture, missingPathState.path);
    check(checks, "missing-path-preserves-list", missingPathState.rows === 4, `${missingPathState.rows} rows`);
    check(checks, "browser-console-clean", pageErrors.length === 0, `${pageErrors.length} page error(s).`);
  } catch (error) {
    navigation.failureSnapshot = await page?.evaluate(() => ({
      leftPath: document.querySelector('[data-path-input="left"]')?.value || "",
      status: document.querySelector("#status-pill")?.textContent || "",
      toast: document.querySelector("#toast")?.textContent || "",
      selected: document.querySelector('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]')?.dataset?.entryPath || "",
      selectedKind: document.querySelector('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]')?.dataset?.entryKind || ""
    })).catch(() => null);
    check(checks, "smoke-execution", false, error.message);
  } finally {
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
    navigation,
    cold,
    warm,
    consoleMessages,
    pageErrors,
    serverOutput: serverOutput.slice(-4000),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(latestMdPath, markdownReport(report));
  console.log(`listing cache UI smoke: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
