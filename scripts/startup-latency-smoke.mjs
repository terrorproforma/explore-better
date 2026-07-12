import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `startup-latency-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "startup-latency-latest.json");
const latestMdPath = path.join(artifactsDir, "startup-latency-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function numberOption(name, envName, fallback) {
  const value = Number(optionValue(name, process.env[envName] || fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_STARTUP_KEEP_FIXTURE === "1";
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_STARTUP_BROWSER || "") ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  );
}

function budgets() {
  return {
    stdoutReadyMs: numberOption("--stdout-ready-ms", "EB_STARTUP_STDOUT_READY_MS", 2000),
    rootsReadyMs: numberOption("--roots-ready-ms", "EB_STARTUP_ROOTS_READY_MS", 2500),
    htmlWallMs: numberOption("--html-wall-ms", "EB_STARTUP_HTML_WALL_MS", 600),
    cssWallMs: numberOption("--css-wall-ms", "EB_STARTUP_CSS_WALL_MS", 600),
    appJsWallMs: numberOption("--app-js-wall-ms", "EB_STARTUP_APP_JS_WALL_MS", 900),
    firstListWallMs: numberOption("--first-list-wall-ms", "EB_STARTUP_FIRST_LIST_WALL_MS", 1200),
    pageDomWallMs: numberOption("--page-dom-wall-ms", "EB_STARTUP_PAGE_DOM_WALL_MS", 3500),
    firstRowsWallMs: numberOption("--first-rows-wall-ms", "EB_STARTUP_FIRST_ROWS_WALL_MS", 4500)
  };
}

function rounded(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null;
}

function randomPort() {
  return 56000 + Math.floor(Math.random() * 7000);
}

async function writeBatch(files) {
  await Promise.all(files.map(([file, text]) => fs.writeFile(file, text, "utf8")));
}

async function prepareFixture(count = 250) {
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.mkdir(path.join(appData, "ExploreBetter"), { recursive: true });
  await fs.writeFile(path.join(fixture, "00-open-me.txt"), "startup target\n", "utf8");
  const batch = [];
  for (let index = 0; index < count; index += 1) {
    const padded = String(index).padStart(4, "0");
    const ext = index % 19 === 0 ? ".md" : index % 13 === 0 ? ".json" : ".txt";
    batch.push([path.join(fixture, `startup-${padded}${ext}`), `startup fixture ${index}\n`]);
    if (batch.length >= 100) {
      await writeBatch(batch.splice(0));
    }
  }
  if (batch.length) {
    await writeBatch(batch);
  }
  await fs.writeFile(
    path.join(appData, "ExploreBetter", "state.json"),
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        layout: {
          activePane: "left",
          paneLayout: "vertical",
          panes: {
            left: { activeTab: 0, tabs: [{ path: fixture, locked: false }] },
            right: { activeTab: 0, tabs: [{ path: fixture, locked: false }] }
          }
        },
        operations: []
      },
      null,
      2
    ),
    "utf8"
  );
  return { count: count + 1, path: fixture };
}

async function requestRaw(baseUrl, route) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${route}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return {
    status: response.status,
    bytes: buffer.length,
    wallMs: rounded(performance.now() - started),
    contentType: response.headers.get("content-type") || ""
  };
}

async function requestJson(baseUrl, route, options = {}) {
  const started = performance.now();
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
  return {
    data,
    wallMs: rounded(performance.now() - started)
  };
}

function startServer(port) {
  serverOutput = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  return child;
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

async function waitForStdout(child, startedAt, needle = "Explore Better running") {
  while (performance.now() - startedAt < 6000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${serverOutput}`);
    }
    if (serverOutput.includes(needle)) {
      return rounded(performance.now() - startedAt);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Server did not print ${needle}: ${serverOutput}`);
}

async function waitForRoots(baseUrl, child, startedAt) {
  let attempts = 0;
  while (performance.now() - startedAt < 8000) {
    attempts += 1;
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${serverOutput}`);
    }
    try {
      const response = await requestJson(baseUrl, "/api/roots");
      return {
        sinceStartMs: rounded(performance.now() - startedAt),
        attempts,
        wallMs: response.wallMs,
        rootCount: response.data.roots?.length || 0
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error(`Server did not answer /api/roots at ${baseUrl}: ${serverOutput}`);
}

async function measureBrowser(baseUrl, fixturePath) {
  const launchStarted = performance.now();
  const browser = await chromium.launch({ executablePath: edgePath(), headless: true });
  const launchWallMs = rounded(performance.now() - launchStarted);
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const gotoStarted = performance.now();
  try {
    const pageUrl = `${baseUrl}/?left=${encodeURIComponent(fixturePath)}&right=${encodeURIComponent(fixturePath)}`;
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
    const domContentLoadedWallMs = rounded(performance.now() - gotoStarted);
    const rowsStarted = performance.now();
    await page.waitForFunction(
      (expectedPath) => document.querySelector('[data-path-input="left"]')?.value === expectedPath,
      fixturePath,
      { timeout: 10000 }
    );
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    const firstRowsWallMs = rounded(performance.now() - gotoStarted);
    const rowWaitWallMs = rounded(performance.now() - rowsStarted);
    const snapshot = await page.evaluate(() => {
      const entries = [...document.querySelectorAll('.pane[data-pane="left"] [data-entry-path]')];
      const pathInput = document.querySelector('[data-path-input="left"]');
      const status = document.querySelector("#status-text")?.textContent || document.querySelector(".status")?.textContent || "";
      return {
        renderedRows: entries.length,
        firstEntry: entries[0]?.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) || "",
        pathValue: pathInput?.value || "",
        status: status.trim().slice(0, 120),
        listHeight: Math.round(document.querySelector('[data-list="left"]')?.getBoundingClientRect().height || 0)
      };
    });
    return {
      launchWallMs,
      domContentLoadedWallMs,
      firstRowsWallMs,
      rowWaitWallMs,
      snapshot,
      consoleErrors,
      pageErrors,
      pageUrl
    };
  } finally {
    await browser.close();
  }
}

function addBudgetCheck(checks, name, actual, budget, detail = "") {
  const numeric = Number(actual);
  checks.push({
    status: Number.isFinite(numeric) && numeric <= budget ? "pass" : "fail",
    name,
    actual: rounded(numeric),
    budget,
    detail
  });
}

function addMinimumCheck(checks, name, actual, minimum, detail = "") {
  const numeric = Number(actual);
  checks.push({
    status: Number.isFinite(numeric) && numeric >= minimum ? "pass" : "fail",
    name,
    actual: rounded(numeric),
    budget: `>= ${minimum}`,
    detail
  });
}

function markdownReport(report) {
  const rows = report.checks
    .map((check) => `| ${check.status.toUpperCase()} | ${check.name} | ${check.actual ?? ""} | ${check.budget} | ${check.detail || ""} |`)
    .join("\n");
  return `# Explore Better Startup Latency

Generated: ${report.generatedAt}

Status: ${report.status}

Fixture: \`${report.fixture.path}\` (${report.fixture.count} entries)

| Status | Check | Actual | Budget | Detail |
| --- | --- | ---: | ---: | --- |
${rows}

## Measurements

- Server stdout ready: ${report.server.stdoutReadyMs} ms
- /api/roots ready: ${report.server.roots.sinceStartMs} ms (${report.server.roots.attempts} attempt(s), ${report.server.roots.wallMs} ms response)
- First HTML: ${report.assets.html.wallMs} ms, ${report.assets.html.bytes} bytes
- First CSS: ${report.assets.css.wallMs} ms, ${report.assets.css.bytes} bytes
- First app JS: ${report.assets.appJs.wallMs} ms, ${report.assets.appJs.bytes} bytes
- First fixture list: ${report.firstList.wallMs} ms, ${report.firstList.returned} entries
- Browser page DOMContentLoaded: ${report.browser.domContentLoadedWallMs} ms
- Browser first rows: ${report.browser.firstRowsWallMs} ms, ${report.browser.snapshot.renderedRows} rendered row(s)

Browser launch itself took ${report.browser.launchWallMs} ms and is reported but not budgeted because it measures the external test browser process, not Explore Better's renderer work.
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixtureInfo = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || randomPort()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port);
  const launchStarted = performance.now();
  let browser = null;
  try {
    const stdoutReadyMs = await waitForStdout(server, launchStarted);
    const roots = await waitForRoots(baseUrl, server, launchStarted);
    const html = await requestRaw(baseUrl, "/");
    const css = await requestRaw(baseUrl, "/styles.css");
    const appJs = await requestRaw(baseUrl, "/app.js");
    const firstListResponse = await requestJson(
      baseUrl,
      `/api/list?path=${encodeURIComponent(fixture)}&showHidden=true&metadataMode=fast`
    );
    const firstList = {
      wallMs: firstListResponse.wallMs,
      returned: firstListResponse.data.entries?.length || 0,
      totalMs: firstListResponse.data.timing?.totalMs || 0,
      scanned: firstListResponse.data.timing?.scanned || 0
    };
    browser = await measureBrowser(baseUrl, fixture);
    const limit = budgets();
    const checks = [];
    addBudgetCheck(checks, "Server stdout ready", stdoutReadyMs, limit.stdoutReadyMs, baseUrl);
    addBudgetCheck(checks, "/api/roots ready since process launch", roots.sinceStartMs, limit.rootsReadyMs, `${roots.rootCount} root(s)`);
    addBudgetCheck(checks, "First HTML response", html.wallMs, limit.htmlWallMs, `${html.bytes} bytes`);
    addBudgetCheck(checks, "First CSS response", css.wallMs, limit.cssWallMs, `${css.bytes} bytes`);
    addBudgetCheck(checks, "First app JS response", appJs.wallMs, limit.appJsWallMs, `${appJs.bytes} bytes`);
    addBudgetCheck(checks, "First fixture list response", firstList.wallMs, limit.firstListWallMs, `${firstList.returned} entries, API ${firstList.totalMs} ms`);
    addMinimumCheck(checks, "First fixture list returned entries", firstList.returned, fixtureInfo.count, fixture);
    addBudgetCheck(checks, "Browser DOMContentLoaded", browser.domContentLoadedWallMs, limit.pageDomWallMs, "after test browser exists");
    addBudgetCheck(checks, "Browser first visible rows", browser.firstRowsWallMs, limit.firstRowsWallMs, "after test browser exists");
    addMinimumCheck(checks, "Browser rendered rows", browser.snapshot.renderedRows, 1, browser.snapshot.pathValue);
    addMinimumCheck(checks, "Browser opened fixture pane", browser.snapshot.pathValue === fixture ? 1 : 0, 1, browser.snapshot.pathValue);
    addBudgetCheck(checks, "Browser console clean", browser.consoleErrors.length + browser.pageErrors.length, 0, "0 page/console errors expected");
    const failures = checks.filter((check) => check.status === "fail");
    const report = {
      generatedAt: new Date().toISOString(),
      workspace,
      status: failures.length ? "fail" : "pass",
      budgets: limit,
      baseUrl,
      fixture: fixtureInfo,
      server: {
        stdoutReadyMs,
        roots,
        outputTail: serverOutput.slice(-2000)
      },
      assets: { html, css, appJs },
      firstList,
      browser,
      checks,
      failures
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`startup latency: ${report.status} (${checks.length - failures.length}/${checks.length} checks passed)`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (failures.length) {
      console.error(`failures: ${failures.map((check) => `${check.name}: ${check.actual} > ${check.budget}`).join("; ")}`);
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
