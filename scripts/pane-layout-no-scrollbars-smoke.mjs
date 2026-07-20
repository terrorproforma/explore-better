import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `pane-layout-no-scrollbars-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "pane-layout-no-scrollbars-latest.json");
const latestMdPath = path.join(artifactsDir, "pane-layout-no-scrollbars-latest.md");

const viewports = [
  { name: "wide", width: 1500, height: 760 },
  { name: "screenshot-like", width: 1360, height: 620 },
  { name: "compact", width: 1100, height: 740 }
];

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function edgePath() {
  return optionValue("--browser", process.env.EB_PANE_LAYOUT_BROWSER || "") || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
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

async function waitForServer(baseUrl, child, getOutput) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${getOutput()}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}: ${getOutput()}`);
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

async function prepareFixture() {
  const deep = path.join(fixture, "Users", "angus", "Downloads");
  const docs = path.join(fixture, "Users", "angus", "Documents");
  await fs.mkdir(deep, { recursive: true });
  await fs.mkdir(docs, { recursive: true });
  for (let index = 0; index < 36; index += 1) {
    await fs.writeFile(path.join(deep, `download-${String(index).padStart(2, "0")}-layout-stress-file.txt`), "layout\n", "utf8");
    await fs.writeFile(path.join(docs, `document-${String(index).padStart(2, "0")}.md`), "# layout\n", "utf8");
  }
  await fs.mkdir(appData, { recursive: true });
  return { left: deep, right: docs };
}

async function inspectPaneChrome(page) {
  return page.evaluate(() => {
    const selectors = [".tabbar", ".tab-strip", ".pathbar", ".breadcrumb-strip", ".toolbar", ".file-head"];
    const reports = [];
    const issues = [];
    for (const pane of document.querySelectorAll(".pane")) {
      const paneName = pane.getAttribute("data-pane") || "unknown";
      for (const selector of selectors) {
        const element = pane.querySelector(selector);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const xScrollable = ["auto", "scroll"].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 3;
        const yScrollable = ["auto", "scroll"].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 3;
        const cramped =
          selector !== ".file-head" &&
          element.scrollHeight > element.clientHeight + 8 &&
          !["visible", "clip"].includes(style.overflowY);
        const childrenOutside = [...element.children].filter((child) => {
          const childRect = child.getBoundingClientRect();
          if (childRect.width <= 0 || childRect.height <= 0) return false;
          return childRect.left < rect.left - 4 || childRect.right > rect.right + 4;
        }).length;
        const currentBreadcrumbRect = element.querySelector(".breadcrumb-button.current")?.getBoundingClientRect();
        const currentBreadcrumbVisible =
          selector !== ".breadcrumb-strip" ||
          Boolean(
            currentBreadcrumbRect &&
              currentBreadcrumbRect.left >= rect.left - 1 &&
              currentBreadcrumbRect.right <= rect.right + 1
          );
        const activeTabRect = element.querySelector(".tab.active")?.getBoundingClientRect();
        const activeTabVisible =
          selector !== ".tab-strip" ||
          Boolean(activeTabRect && activeTabRect.left >= rect.left - 1 && activeTabRect.right <= rect.right + 1);
        const intentionalBreadcrumbScroll =
          selector === ".breadcrumb-strip" && xScrollable && style.scrollbarWidth === "none" && currentBreadcrumbVisible;
        const intentionalTabScroll = false;
        const intentionalHorizontalScroll = intentionalBreadcrumbScroll || intentionalTabScroll;
        const sample = {
          pane: paneName,
          selector,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          scrollbarWidth: style.scrollbarWidth,
          gridTemplateColumns: style.gridTemplateColumns,
          configuredColumns: element.style.getPropertyValue("--file-columns"),
          childWidths: [...element.children].map((child) => Math.round(child.getBoundingClientRect().width)),
          xScrollable,
          yScrollable,
          cramped,
          childrenOutside,
          currentBreadcrumbVisible,
          activeTabVisible,
          intentionalBreadcrumbScroll,
          intentionalTabScroll
        };
        reports.push(sample);
        if ((xScrollable && !intentionalHorizontalScroll) || yScrollable || cramped || (childrenOutside && !intentionalHorizontalScroll)) {
          issues.push(sample);
        }
      }
    }
    return { reports, issues };
  });
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Pane Layout No-Scrollbars Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixturePaths = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 50000 + Math.floor(Math.random() * 9000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  let serverOutput = "";
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  let browser = null;
  const viewportReports = [];
  try {
    await waitForServer(baseUrl, server, () => serverOutput);
    await requestJson(baseUrl, "/api/state", {
      method: "POST",
      body: JSON.stringify({ settings: { layoutMode: "vertical", inspector: false } })
    });
    browser = await chromium.launch({ executablePath: edgePath(), headless: true });
    const page = await browser.newPage();
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixturePaths.left)}&right=${encodeURIComponent(fixturePaths.right)}`, {
        waitUntil: "domcontentloaded"
      });
      await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
      await page.waitForSelector('.pane[data-pane="right"] [data-entry-path]', { timeout: 10000 });
      for (let index = 0; index < 12; index += 1) {
        await page.click('[data-new-tab="left"]');
      }
      await page.waitForTimeout(250);
      const chrome = await inspectPaneChrome(page);
      const tabState = await page.evaluate(() => {
        const tabbar = document.querySelector('[data-tabs="left"]');
        const strip = tabbar.querySelector('[data-tab-strip="left"]');
        const tabs = [...strip.querySelectorAll(".tab")];
        const visibleTabs = tabs.filter((tab) => !tab.classList.contains("tab-responsive-hidden"));
        const hiddenTabs = tabs.filter((tab) => tab.classList.contains("tab-responsive-hidden"));
        const active = strip.querySelector(".tab.active");
        const stripRect = strip.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        const style = getComputedStyle(strip);
        const toggle = tabbar.querySelector('[data-tab-overflow-toggle="left"]');
        return {
          tabbarHeight: Math.round(tabbar.getBoundingClientRect().height),
          tabCount: tabs.length,
          visibleTabCount: visibleTabs.length,
          hiddenTabCount: hiddenTabs.length,
          minTabWidth: Math.round(Math.min(...visibleTabs.map((tab) => tab.getBoundingClientRect().width))),
          maxTabWidth: Math.round(Math.max(...visibleTabs.map((tab) => tab.getBoundingClientRect().width))),
          scrollable: strip.scrollWidth > strip.clientWidth + 1,
          scrollLeft: Math.round(strip.scrollLeft),
          activeOffsetLeft: Math.round(active.offsetLeft),
          activeLeft: Math.round(activeRect.left),
          activeRight: Math.round(activeRect.right),
          stripLeft: Math.round(stripRect.left),
          stripRight: Math.round(stripRect.right),
          scrollbarWidth: style.scrollbarWidth,
          overflowY: style.overflowY,
          activeVisible: activeRect.left >= stripRect.left - 1 && activeRect.right <= stripRect.right + 1,
          overflowToggleVisible: !toggle.hidden,
          overflowLabel: toggle.getAttribute("aria-label")
        };
      });
      check(
        checks,
        `compact-tabs-${viewport.name}`,
        tabState.tabCount >= 13 &&
          tabState.visibleTabCount >= 1 &&
          tabState.hiddenTabCount >= 1 &&
          tabState.tabbarHeight <= 40 &&
          tabState.minTabWidth >= 67 &&
          tabState.maxTabWidth <= 169,
        JSON.stringify(tabState)
      );
      check(
        checks,
        `tab-overflow-chrome-${viewport.name}`,
        !tabState.scrollable &&
          tabState.scrollbarWidth === "none" &&
          tabState.overflowY === "hidden" &&
          tabState.activeVisible &&
          tabState.overflowToggleVisible &&
          tabState.overflowLabel === `Show all ${tabState.tabCount} tabs (${tabState.hiddenTabCount} hidden)`,
        JSON.stringify(tabState)
      );
      await page.click('[data-tab-overflow-toggle="left"]');
      const tabMenuState = await page.evaluate(() => {
        const menu = document.querySelector('[data-tab-overflow-menu="left"]');
        const rect = menu.getBoundingClientRect();
        return {
          visible: !menu.hidden,
          items: menu.querySelectorAll("button").length,
          activeItems: menu.querySelectorAll("button.active").length,
          insideViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
        };
      });
      check(
        checks,
        `tab-overflow-menu-${viewport.name}`,
        tabMenuState.visible &&
          tabMenuState.items === tabState.tabCount &&
          tabMenuState.activeItems === 1 &&
          tabMenuState.insideViewport,
        JSON.stringify(tabMenuState)
      );
      await page.keyboard.press("Escape");
      const tabMenuClosed = await page.evaluate(() => ({
        hidden: document.querySelector('[data-tab-overflow-menu="left"]').hidden,
        focusRestored: document.activeElement === document.querySelector('[data-tab-overflow-toggle="left"]')
      }));
      check(
        checks,
        `tab-overflow-keyboard-${viewport.name}`,
        tabMenuClosed.hidden && tabMenuClosed.focusRestored,
        JSON.stringify(tabMenuClosed)
      );
      const screenshot = path.join(artifactsDir, `pane-layout-no-scrollbars-${viewport.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      viewportReports.push({ ...viewport, screenshot, ...chrome });
      check(
        checks,
        `pane-chrome-${viewport.name}`,
        chrome.issues.length === 0,
        chrome.issues.length ? JSON.stringify(chrome.issues.slice(0, 6)) : "no pane header scrollbars or overflow"
      );
      console.log(`${viewport.name}: ${chrome.issues.length} pane chrome issue(s)`);
    }
  } catch (error) {
    check(checks, "smoke-execution", false, error.message);
  } finally {
    await browser?.close().catch(() => {});
    await stopServer(server);
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }

  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
  const report = {
    generatedAt: new Date().toISOString(),
    status: summary.fail ? "fail" : "pass",
    baseUrl,
    fixturePaths,
    viewportReports,
    serverOutput: serverOutput.slice(-4000),
    checks,
    summary
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(latestMdPath, markdownReport(report));
  console.log(`pane layout no-scrollbars smoke: ${summary.pass} pass, ${summary.fail} fail`);
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
