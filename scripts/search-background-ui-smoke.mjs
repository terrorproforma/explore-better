import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import { clickDockAction } from "./ui-helpers.mjs";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `search-background-ui-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const otherFixture = path.join(runRoot, "other-fixture");
const nested = path.join(fixture, "nested");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const latestJsonPath = path.join(artifactsDir, "search-background-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "search-background-ui-latest.md");
const screenshotPath = path.join(artifactsDir, "search-dialog-latest.png");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_SEARCH_BACKGROUND_UI_BROWSER || "") ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  );
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
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

async function waitForServer(baseUrl, child, serverOutputRef) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${serverOutputRef()}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}: ${serverOutputRef()}`);
}

async function waitForBackgroundComplete(baseUrl, rootId) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const overview = await requestJson(baseUrl, "/api/background-indexes");
    const root = overview.roots.find((item) => item.id === rootId);
    if (!root) throw new Error(`Background root ${rootId} disappeared.`);
    if (root.job?.status === "error") throw new Error(root.job.error || "Background index failed.");
    if (!root.job || root.job.status === "complete" || root.job.status === "canceled") return root;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Background root ${rootId} did not complete.`);
}

async function startBackgroundRoot(baseUrl, rootPath) {
  const started = await requestJson(baseUrl, "/api/background-indexes/start", {
    method: "POST",
    body: JSON.stringify({
      path: rootPath,
      recursive: true,
      includeDimensions: false,
      includeLinks: false,
      includeContent: true,
      maxContentBytes: 8192,
      maxContentFiles: 40,
      maxFolders: 20,
      maxEntries: 2000
    })
  });
  const rootId = started.job?.rootId || started.root?.id || started.roots?.[0]?.id;
  if (!rootId) throw new Error("Background index start response did not include a root id.");
  return waitForBackgroundComplete(baseUrl, rootId);
}

async function prepareFixture() {
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(otherFixture, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  const labelledPath = path.join(fixture, "labelled-cache-target.txt");
  const contentPath = path.join(nested, "content-background-cache-only.md");
  const otherContentPath = path.join(otherFixture, "content-background-cache-other.md");
  await fs.writeFile(path.join(fixture, "plain-root.txt"), "plain root\n", "utf8");
  await fs.writeFile(labelledPath, "ordinary labelled cache target\n", "utf8");
  await fs.writeFile(contentPath, "The normal Search dialog should find obsidian invoice from the warm cache.\n", "utf8");
  await fs.writeFile(otherContentPath, "This other root also says obsidian invoice and must stay scoped out.\n", "utf8");
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        labels: [
          {
            path: labelledPath,
            name: "Indexed",
            color: "teal",
            notes: "aurora ledger"
          }
        ],
        operations: []
      },
      null,
      2
    ),
    "utf8"
  );
  return { labelledPath, contentPath, otherContentPath };
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function waitForResult(page, fn, label, timeoutMs = 12000, arg = undefined) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await page.evaluate(fn, arg);
    if (last?.ok) return last;
    await page.waitForTimeout(120);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

function endpointFromUrl(requestUrl) {
  try {
    const parsed = new URL(requestUrl);
    if (parsed.pathname === "/api/search" || parsed.pathname === "/api/background-indexes/search") {
      return parsed.pathname;
    }
  } catch {}
  return "";
}

function endpointCounts(events) {
  return events.reduce((counts, event) => {
    counts[event.endpoint] = (counts[event.endpoint] || 0) + 1;
    return counts;
  }, {});
}

async function inspectSearchLayout(page) {
  return page.evaluate(() => {
    const dialog = document.getElementById("search-dialog");
    const issues = [];
    const samples = [];
    const selector = "button, input, select, label, .search-preset-strip span, .search-summary, .search-result-row";
    for (const element of dialog?.querySelectorAll(selector) || []) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const text = (element.innerText || element.textContent || element.value || "").trim().replace(/\s+/g, " ");
      const formControl = element.matches("input, select, textarea");
      const tinyControl = element.matches('input[type="checkbox"], input[type="radio"]');
      const clipped = !formControl && (element.scrollWidth > element.clientWidth + 4 || element.scrollHeight > element.clientHeight + 4);
      const squished = tinyControl ? rect.width < 14 || rect.height < 14 : rect.width < 24 || rect.height < 18;
      const sample = {
        tag: element.tagName.toLowerCase(),
        text: text.slice(0, 100),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        clipped,
        squished
      };
      samples.push(sample);
      if (clipped || squished) issues.push(sample);
    }
    return { issues, samples };
  });
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Search Background UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Visible Searches

| Search | Summary | Rows |
| --- | --- | ---: |
| Content | ${String(report.contentSearch?.summary || "n/a").replace(/\|/g, "\\|")} | ${report.contentSearch?.rowCount || 0} |
| Label notes | ${String(report.labelSearch?.summary || "n/a").replace(/\|/g, "\\|")} | ${report.labelSearch?.rowCount || 0} |
| Direct scan | ${String(report.scanSearch?.summary || "n/a").replace(/\|/g, "\\|")} | ${report.scanSearch?.rowCount || 0} |
| No matches | ${String(report.emptySearch?.summary || "n/a").replace(/\|/g, "\\|")} | ${report.emptySearch?.rowCount || 0} |
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixturePaths = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || "")) || await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const consoleMessages = [];
  const pageErrors = [];
  const apiEvents = [];
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
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

  let browser = null;
  let contentSearch = null;
  let labelSearch = null;
  let scanSearch = null;
  let emptySearch = null;
  let layout = null;
  let backgroundRoots = [];
  try {
    await waitForServer(baseUrl, server, () => serverOutput);
    backgroundRoots = [
      await startBackgroundRoot(baseUrl, fixture),
      await startBackgroundRoot(baseUrl, otherFixture)
    ];

    browser = await chromium.launch({ executablePath: edgePath(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        consoleMessages.push({ type: message.type(), text: message.text() });
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    page.on("response", (response) => {
      const endpoint = endpointFromUrl(response.url());
      if (!endpoint) return;
      apiEvents.push({ endpoint, status: response.status(), url: response.url() });
    });

    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(otherFixture)}`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await page.locator('.pane[data-pane="left"] .tab.active .tab-lock').click();
    await page.waitForFunction(() => document.querySelector('.pane[data-pane="left"] .tab.active')?.classList.contains("locked"));
    await clickDockAction(page, "search");
    await page.waitForSelector("#search-dialog[open]", { timeout: 10000 });

    const initial = await page.evaluate(() => ({
      open: document.getElementById("search-dialog")?.open === true,
      root: document.getElementById("search-root")?.value || "",
      warmChecked: document.getElementById("search-background-cache")?.checked === true
    }));

    await page.locator("#search-kind").selectOption("text");
    await page.locator("#search-limit").fill("20");
    await page.locator("#search-content").fill("obsidian invoice");
    await page.locator('#search-form button[type="submit"]').click();
    contentSearch = await waitForResult(
      page,
      ({ expectedPath, excludedPath }) => {
        const summary = document.getElementById("search-summary")?.textContent?.trim() || "";
        const rows = [...document.querySelectorAll("#search-results [data-search-path]")].map((row) => ({
          path: row.getAttribute("data-search-path") || "",
          text: row.textContent.trim().replace(/\s+/g, " ")
        }));
        const paneRows = [...document.querySelectorAll('.pane[data-pane="left"] [data-entry-path]')].map(
          (row) => row.getAttribute("data-entry-path") || ""
        );
        return {
          ok:
            /Search index/i.test(summary) &&
            /content match/i.test(summary) &&
            rows.some((row) => row.path === expectedPath && /obsidian invoice/i.test(row.text)) &&
            !rows.some((row) => row.path === excludedPath) &&
            paneRows.includes(expectedPath),
          summary,
          rowCount: rows.length,
          rows,
          paneRows: paneRows.slice(0, 20)
        };
      },
      "warm cache content search",
      12000,
      { expectedPath: fixturePaths.contentPath, excludedPath: fixturePaths.otherContentPath }
    );
    const lockedSearchTabs = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.pane[data-pane="left"] .tab')];
      return {
        count: tabs.length,
        locked: tabs.filter((tab) => tab.classList.contains("locked")).map((tab) => tab.getAttribute("title") || ""),
        activeTitle: tabs.find((tab) => tab.classList.contains("active"))?.textContent?.trim() || ""
      };
    });

    await page.locator("#search-name").fill("aurora ledger");
    await page.locator("#search-content").fill("");
    await page.locator('#search-form button[type="submit"]').click();
    labelSearch = await waitForResult(
      page,
      ({ expectedPath }) => {
        const summary = document.getElementById("search-summary")?.textContent?.trim() || "";
        const rows = [...document.querySelectorAll("#search-results [data-search-path]")].map((row) => ({
          path: row.getAttribute("data-search-path") || "",
          text: row.textContent.trim().replace(/\s+/g, " ")
        }));
        return {
          ok: /Search index/i.test(summary) && rows.some((row) => row.path === expectedPath && /aurora ledger/i.test(row.text)),
          summary,
          rowCount: rows.length,
          rows
        };
      },
      "warm cache label-note search",
      12000,
      { expectedPath: fixturePaths.labelledPath }
    );

    await page.locator("#search-background-cache").setChecked(false);
    await page.locator("#search-name").fill("plain-root");
    await page.locator('#search-form button[type="submit"]').click();
    scanSearch = await waitForResult(
      page,
      ({ expectedPath }) => {
        const summary = document.getElementById("search-summary")?.textContent?.trim() || "";
        const rows = [...document.querySelectorAll("#search-results [data-search-path]")].map((row) => ({
          path: row.getAttribute("data-search-path") || "",
          text: row.textContent.trim().replace(/\s+/g, " ")
        }));
        return {
          ok: rows.some((row) => row.path === expectedPath) && /^1 match\b/i.test(summary),
          summary,
          rowCount: rows.length,
          rows
        };
      },
      "direct scan search",
      12000,
      { expectedPath: path.join(fixture, "plain-root.txt") }
    );
    await page.screenshot({ path: screenshotPath });

    await page.locator("#search-name").fill("definitely-no-result-needle");
    await page.locator('#search-form button[type="submit"]').click();
    emptySearch = await waitForResult(
      page,
      () => {
        const summary = document.getElementById("search-summary")?.textContent?.trim() || "";
        const rows = document.querySelectorAll("#search-results [data-search-path]").length;
        const empty = document.querySelector("#search-results .empty-state")?.textContent?.trim() || "";
        return { ok: /^0 matches\b/i.test(summary) && rows === 0 && empty === "No matches", summary, rowCount: rows, empty };
      },
      "empty direct search"
    );

    layout = await inspectSearchLayout(page);
    const counts = endpointCounts(apiEvents);
    const searchEndpointHits = apiEvents.filter((event) => event.endpoint === "/api/search").length;
    check(checks, "search-dialog-opened", initial.open && initial.root === fixture, `open=${initial.open}; root=${initial.root}.`);
    check(checks, "warm-cache-default-on", initial.warmChecked, `warmChecked=${initial.warmChecked}.`);
    check(
      checks,
      "warm-content-search-visible",
      contentSearch.rows.some((row) => row.path === fixturePaths.contentPath) &&
        !contentSearch.rows.some((row) => row.path === fixturePaths.otherContentPath),
      `${contentSearch.rowCount} row(s); summary=${contentSearch.summary}.`
    );
    check(
      checks,
      "locked-tab-search-branches",
      lockedSearchTabs.count === 2 && lockedSearchTabs.locked.length === 1 && lockedSearchTabs.locked[0] === fixture && /Search:/.test(lockedSearchTabs.activeTitle),
      JSON.stringify(lockedSearchTabs)
    );
    check(
      checks,
      "warm-label-note-search-visible",
      labelSearch.rows.some((row) => row.path === fixturePaths.labelledPath && /aurora ledger/i.test(row.text)),
      `${labelSearch.rowCount} row(s); summary=${labelSearch.summary}.`
    );
    check(
      checks,
      "direct-scan-search-visible",
      scanSearch.rows.some((row) => row.path === path.join(fixture, "plain-root.txt")) && !/\bscanned\b/i.test(scanSearch.summary),
      `${scanSearch.rowCount} row(s); summary=${scanSearch.summary}.`
    );
    check(
      checks,
      "zero-results-state",
      emptySearch.rowCount === 0 && emptySearch.empty === "No matches" && /^0 matches\b/i.test(emptySearch.summary),
      `${emptySearch.summary}; empty=${emptySearch.empty}.`
    );
    check(
      checks,
      "search-dialog-used-background-endpoint",
      counts["/api/background-indexes/search"] >= 2 && searchEndpointHits >= 2,
      JSON.stringify(counts)
    );
    check(
      checks,
      "search-summary-is-plain-language",
      (contentSearch.summary.match(/Search index/gi) || []).length === 1 &&
        !/root stores|\bscanned\b|Warm cache/i.test(`${contentSearch.summary} ${labelSearch.summary}`),
      `${contentSearch.summary} | ${labelSearch.summary}`
    );
    check(checks, "search-dialog-layout", layout.issues.length === 0, `${layout.issues.length} clipped/squished Search control(s).`);
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
    fail: checks.filter((item) => item.status === "fail").length
  };
  const report = {
    generatedAt: new Date().toISOString(),
    status: summary.fail ? "fail" : "pass",
    baseUrl,
    fixture,
    otherFixture,
    fixturePaths,
    backgroundRoots: backgroundRoots.map((root) => ({
      id: root.id,
      path: root.path,
      search: root.search,
      lastStats: root.lastStats
    })),
    contentSearch,
    labelSearch,
    scanSearch,
    emptySearch,
    layout,
    apiEvents,
    endpointCounts: endpointCounts(apiEvents),
    consoleMessages,
    pageErrors,
    serverOutput: serverOutput.slice(-4000),
    summary,
    checks,
    screenshot: screenshotPath
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`search background UI smoke: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
