import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `speed-index-ui-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const nested = path.join(fixture, "nested");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const latestJsonPath = path.join(artifactsDir, "speed-index-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "speed-index-ui-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_SPEED_INDEX_UI_BROWSER || "") ||
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

async function prepareFixture() {
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  const labelledPath = path.join(fixture, "labelled-speed-target.txt");
  const filenamePath = path.join(fixture, "speed-needle-alpha.log");
  const contentPath = path.join(nested, "content-background-only.md");
  await fs.writeFile(labelledPath, "ordinary labelled file\n");
  await fs.writeFile(filenamePath, "filename target\n");
  await fs.writeFile(contentPath, "This nested file contains obsidian invoice terms for background content search.\n");
  const stalePath = path.join(nested, "post-build-stale-cache-proof.md");
  await fs.writeFile(path.join(fixture, "plain-control.txt"), "control\n");
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
  return { labelledPath, filenamePath, contentPath, stalePath };
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function waitForResult(page, fn, label, timeoutMs = 20000, ...args) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await page.evaluate(fn, ...args);
    if (last?.ok) return last;
    await page.waitForTimeout(120);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function speedSnapshot(page) {
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
        clientWidth: cell.clientWidth,
        clipped: cell.scrollWidth > cell.clientWidth + 4
      };
    }
    const resultButtons = [...document.querySelectorAll("#speed-results [data-speed-open]")].map((button) => ({
      text: button.textContent.trim().replace(/\s+/g, " "),
      path: button.getAttribute("data-speed-open") || ""
    }));
    const backgroundRows = [...document.querySelectorAll("#speed-background-list .speed-bg-row")].map((row) => ({
      text: row.textContent.trim().replace(/\s+/g, " "),
      running: row.classList.contains("running")
    }));
    return {
      open: document.getElementById("speed-dialog")?.open === true,
      path: document.getElementById("speed-path")?.textContent?.trim() || "",
      summary: document.getElementById("speed-summary")?.textContent?.trim() || "",
      query: document.getElementById("speed-query")?.value || "",
      metrics,
      resultButtons,
      backgroundRows,
      activeElementId: document.activeElement?.id || ""
    };
  });
}

async function inspectSpeedLayout(page) {
  return page.evaluate(() => {
    const selectors = [
      ["#speed-dialog[open] .speed-actions button", "speed-actions"],
      ["#speed-dialog[open] .speed-options label", "speed-options"],
      ["#speed-dialog[open] #speed-query", "speed-query"],
      ["#speed-dialog[open] .speed-metrics > div", "speed-metrics"],
      ["#speed-dialog[open] .speed-results button", "speed-results"],
      ["#speed-dialog[open] .speed-bg-row", "speed-background"]
    ];
    const issues = [];
    const samples = [];
    for (const [selector, area] of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const formControl = element.matches("input, select, textarea") || element.querySelector("input, select, textarea");
        const text = (element.innerText || element.textContent || element.value || "").trim().replace(/\s+/g, " ");
        const clipped =
          !formControl && (element.scrollWidth > element.clientWidth + 4 || element.scrollHeight > element.clientHeight + 4);
        const squished = rect.width < 28 || rect.height < 22;
        const sample = {
          area,
          text: text.slice(0, 120),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          clipped,
          squished
        };
        samples.push(sample);
        if (clipped || squished) {
          issues.push(sample);
        }
      }
    }
    return { issues, samples };
  });
}

function endpointFromUrl(requestUrl) {
  try {
    const parsed = new URL(requestUrl);
    if (parsed.pathname.startsWith("/api/index") || parsed.pathname.startsWith("/api/background-indexes")) {
      return parsed.pathname;
    }
  } catch {
    return "";
  }
  return "";
}

function endpointCounts(events) {
  return events.reduce((counts, event) => {
    counts[event.endpoint] = (counts[event.endpoint] || 0) + 1;
    return counts;
  }, {});
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Speed Index UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Index Results

| Stage | Summary |
| --- | --- |
| Build | ${String(report.folderIndex?.summary || "n/a").replace(/\|/g, "\\|")} |
| Folder search | ${String(report.folderSearch?.resultButtons?.[0]?.text || "n/a").replace(/\|/g, "\\|")} |
| Background search | ${String(report.backgroundSearch?.resultButtons?.[0]?.text || "n/a").replace(/\|/g, "\\|")} |
| Background auto rebuild | ${String(report.backgroundStale?.backgroundRows?.[0]?.text || "n/a").replace(/\|/g, "\\|")} |
| Recovered search | ${String(report.backgroundRecoveredSearch?.resultButtons?.[0]?.text || "n/a").replace(/\|/g, "\\|")} |
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixturePaths = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 48000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const consoleMessages = [];
  const pageErrors = [];
  const apiEvents = [];
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      EXPLORE_BETTER_BACKGROUND_FRESHNESS_TTL_MS: "500"
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

  let browser = null;
  let initial = null;
  let folderIndex = null;
  let folderSearch = null;
  let background = null;
  let backgroundSearch = null;
  let backgroundAutoRebuild = null;
  let backgroundStale = null;
  let backgroundRecovered = null;
  let backgroundRecoveredSearch = null;
  let layout = null;
  try {
    await waitForServer(baseUrl, server, () => serverOutput);
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

    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await page.locator('[data-global-action="speed"]').click();
    await page.waitForSelector("#speed-dialog[open]", { timeout: 10000 });
    initial = await waitForResult(
      page,
      () => {
        const summary = document.getElementById("speed-summary")?.textContent?.trim() || "";
        return {
          ok: /Not indexed|items/i.test(summary),
          summary
        };
      },
      "speed dialog initial status"
    );
    initial.snapshot = await speedSnapshot(page);

    await page.locator("#speed-index-dimensions").setChecked(false);
    await page.locator("#speed-index-content").setChecked(true);
    await page.locator("#speed-bg-max-folders").fill("20");
    await page.locator("#speed-bg-max-entries").fill("2000");
    await page.locator("#speed-bg-content-kb").fill("64");
    await page.locator('[data-speed-action="build"]').click();
    await waitForResult(
      page,
      () => {
        const indexed = document.querySelector('#speed-dialog[open] [data-speed-metric="indexed"] strong')?.textContent || "";
        const summary = document.getElementById("speed-summary")?.textContent?.trim() || "";
        return {
          ok: Number.parseInt(indexed, 10) >= 3 && /items/i.test(summary),
          indexed,
          summary
        };
      },
      "folder index built"
    );
    folderIndex = await speedSnapshot(page);

    await page.locator("#speed-query").fill("aurora ledger");
    await page.locator('[data-speed-action="search"]').click();
    await waitForResult(
      page,
      (expectedPath) => {
        const resultButtons = [...document.querySelectorAll("#speed-results [data-speed-open]")].map((button) => ({
          text: button.textContent.trim().replace(/\s+/g, " "),
          path: button.getAttribute("data-speed-open") || ""
        }));
        return {
          ok: resultButtons.some((item) => item.path === expectedPath),
          resultButtons
        };
      },
      "folder index label-note search",
      10000,
      fixturePaths.labelledPath
    ).catch(async () => {
      return waitForResult(
        page,
        () => {
          const resultButtons = [...document.querySelectorAll("#speed-results [data-speed-open]")].map((button) => ({
            text: button.textContent.trim().replace(/\s+/g, " "),
            path: button.getAttribute("data-speed-open") || ""
          }));
          return {
            ok: resultButtons.some((item) => item.text.includes("labelled-speed-target.txt")),
            resultButtons
          };
        },
        "folder index visible search fallback"
      );
    });
    folderSearch = await speedSnapshot(page);

    await page.locator('[data-speed-action="background-add"]').click();
    await waitForResult(
      page,
      () => {
        const backgroundRows = [...document.querySelectorAll("#speed-background-list .speed-bg-row")].map((row) => ({
          text: row.textContent.trim().replace(/\s+/g, " "),
          running: row.classList.contains("running")
        }));
        const text = backgroundRows.map((row) => row.text).join(" ");
        return {
          ok: backgroundRows.length >= 1 && !backgroundRows.some((row) => row.running) && /\d+ items/.test(text),
          backgroundRows
        };
      },
      "background index completed",
      30000
    );
    background = await speedSnapshot(page);

    await page.locator("#speed-query").fill("obsidian invoice");
    await page.locator('[data-speed-action="background-search"]').click();
    await waitForResult(
      page,
      (expectedPath) => {
        const resultButtons = [...document.querySelectorAll("#speed-results [data-speed-open]")].map((button) => ({
          text: button.textContent.trim().replace(/\s+/g, " "),
          path: button.getAttribute("data-speed-open") || ""
        }));
        return {
          ok:
            resultButtons.some((item) => item.path === expectedPath) &&
            resultButtons.some((item) => /obsidian invoice/i.test(item.text)),
          resultButtons
        };
      },
      "background content search",
      10000,
      fixturePaths.contentPath
    ).catch(async () =>
      waitForResult(
        page,
        () => {
          const resultButtons = [...document.querySelectorAll("#speed-results [data-speed-open]")].map((button) => ({
            text: button.textContent.trim().replace(/\s+/g, " "),
            path: button.getAttribute("data-speed-open") || ""
          }));
          return {
            ok: resultButtons.some((item) => item.text.includes("content-background-only.md")),
            resultButtons
          };
        },
        "background content visible search fallback"
      )
    );
    backgroundSearch = await speedSnapshot(page);

    await fs.writeFile(
      fixturePaths.stalePath,
      "This file was added after background indexing and should trigger stale cache self heal: velvet compass.\n",
      "utf8"
    );
    await page.waitForTimeout(750);
    await page.locator('[data-speed-action="background-refresh"]').click();
    backgroundAutoRebuild = await waitForResult(
      page,
      () => {
        const backgroundRows = [...document.querySelectorAll("#speed-background-list .speed-bg-row")].map((row) => ({
          text: row.textContent.trim().replace(/\s+/g, " "),
          running: row.classList.contains("running")
        }));
        const staleMetric = document.querySelector('#speed-dialog[open] [data-speed-metric="bg-stale"] strong')?.textContent || "";
        return {
          ok:
            backgroundRows.some((row) => /Stale:|Auto rebuild|Running/i.test(row.text) || row.running) ||
            Number.parseInt(staleMetric || "0", 10) >= 1,
          backgroundRows,
          staleMetric
        };
      },
      "background auto rebuild visible",
      10000
    );
    backgroundStale = await speedSnapshot(page);
    await waitForResult(
      page,
      () => {
        const backgroundRows = [...document.querySelectorAll("#speed-background-list .speed-bg-row")].map((row) => ({
          text: row.textContent.trim().replace(/\s+/g, " "),
          running: row.classList.contains("running")
        }));
        return {
          ok:
            backgroundRows.length >= 1 &&
            !backgroundRows.some((row) => row.running) &&
            backgroundRows.some((row) => /Fresh/i.test(row.text) || !/Stale:/i.test(row.text)),
          backgroundRows
        };
      },
      "background auto rebuild complete",
      30000
    );
    backgroundRecovered = await speedSnapshot(page);

    await page.locator("#speed-query").fill("velvet compass");
    await page.locator('[data-speed-action="background-search"]').click();
    await waitForResult(
      page,
      (expectedPath) => {
        const resultButtons = [...document.querySelectorAll("#speed-results [data-speed-open]")].map((button) => ({
          text: button.textContent.trim().replace(/\s+/g, " "),
          path: button.getAttribute("data-speed-open") || ""
        }));
        return {
          ok:
            resultButtons.some((item) => item.path === expectedPath) &&
            resultButtons.some((item) => /velvet compass/i.test(item.text)),
          resultButtons
        };
      },
      "background auto rebuild search",
      10000,
      fixturePaths.stalePath
    );
    backgroundRecoveredSearch = await speedSnapshot(page);

    layout = await inspectSpeedLayout(page);
    check(
      checks,
      "speed-dialog-opened",
      initial.snapshot?.open === true && initial.snapshot?.activeElementId === "speed-query",
      `open=${initial.snapshot?.open}; focus=${initial.snapshot?.activeElementId}.`
    );
    check(
      checks,
      "folder-index-built-from-ui",
      Number.parseInt(folderIndex.metrics?.indexed?.value || "0", 10) >= 3 &&
        Number.parseInt(folderIndex.metrics?.build?.value || "0", 10) >= 0,
      `summary=${folderIndex.summary}; indexed=${folderIndex.metrics?.indexed?.value || "missing"}; build=${folderIndex.metrics?.build?.value || "missing"}.`
    );
    check(
      checks,
      "folder-index-label-search",
      folderSearch.resultButtons?.some((item) => item.path === fixturePaths.labelledPath || item.text.includes("labelled-speed-target.txt")),
      `${folderSearch.resultButtons?.length || 0} result(s) for aurora ledger.`
    );
    check(
      checks,
      "background-index-added-from-ui",
      background.backgroundRows?.length >= 1 && !background.backgroundRows.some((row) => row.running),
      `${background.backgroundRows?.length || 0} background row(s); running=${background.backgroundRows?.some((row) => row.running)}.`
    );
    check(
      checks,
      "background-watcher-visible",
      background.backgroundRows?.some((row) => /Watching \d+ folder/i.test(row.text)) &&
        Number.parseInt(background.metrics?.["bg-watched"]?.value || "0", 10) >= 1,
      `${background.backgroundRows?.length || 0} background row(s); BG Watched=${background.metrics?.["bg-watched"]?.value || "missing"}.`
    );
    check(
      checks,
      "background-content-search",
      backgroundSearch.resultButtons?.some(
        (item) =>
          item.path === fixturePaths.contentPath ||
          (item.text.includes("content-background-only.md") && /obsidian invoice/i.test(item.text))
      ),
      `${backgroundSearch.resultButtons?.length || 0} result(s) for obsidian invoice.`
    );
    check(
      checks,
      "background-auto-rebuild-visible",
      backgroundAutoRebuild?.backgroundRows?.some((row) => /Stale:|Auto rebuild|Running/i.test(row.text) || row.running) ||
        Number.parseInt(backgroundAutoRebuild?.staleMetric || "0", 10) >= 1,
      `${backgroundAutoRebuild?.backgroundRows?.length || 0} background row(s); BG Stale=${backgroundAutoRebuild?.staleMetric || "missing"}.`
    );
    check(
      checks,
      "background-auto-rebuild-search",
      backgroundRecoveredSearch?.resultButtons?.some((item) => item.path === fixturePaths.stalePath && /velvet compass/i.test(item.text)),
      `${backgroundRecoveredSearch?.resultButtons?.length || 0} recovered result(s) for velvet compass.`
    );
    const counts = endpointCounts(apiEvents);
    check(
      checks,
      "speed-api-endpoints-hit",
      counts["/api/index/build"] >= 1 &&
        counts["/api/index/search"] >= 1 &&
        counts["/api/background-indexes/start"] >= 1 &&
        counts["/api/background-indexes/search"] >= 1,
      JSON.stringify(counts)
    );
    check(checks, "speed-dialog-layout", layout.issues.length === 0, `${layout.issues.length} clipped/squished Speed control(s).`);
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
    fixturePaths,
    initial,
    folderIndex,
    folderSearch,
    background,
    backgroundSearch,
    backgroundAutoRebuild,
    backgroundStale,
    backgroundRecovered,
    backgroundRecoveredSearch,
    layout,
    apiEvents,
    endpointCounts: endpointCounts(apiEvents),
    consoleMessages,
    pageErrors,
    serverOutput: serverOutput.slice(-4000),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(latestMdPath, markdownReport(report));
  console.log(`speed index UI smoke: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
