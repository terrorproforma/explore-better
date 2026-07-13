import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `command-center-ui-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "command-center-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "command-center-ui-latest.md");
const desktopScreenshotPath = path.join(artifactsDir, "command-center-desktop.png");
const mobileScreenshotPath = path.join(artifactsDir, "command-center-mobile.png");

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) throw new Error(`Server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/roots`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Server did not start at ${baseUrl}`);
}

function edgePath() {
  return process.env.EB_COMMAND_CENTER_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
}

function markdown(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Command Center UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function paletteSnapshot(page) {
  return page.evaluate(() => ({
    open: document.getElementById("command-dialog")?.open === true,
    focused: document.activeElement?.id || "",
    view: document.querySelector("[data-command-view].active")?.dataset.commandView || "",
    summary: document.getElementById("command-result-summary")?.textContent?.trim() || "",
    resultCount: document.querySelectorAll("[data-palette-index]").length,
    groups: [...document.querySelectorAll(".command-group-heading")].map((item) => item.textContent.trim()),
    items: [...document.querySelectorAll("[data-palette-index]")].slice(0, 8).map((item) => item.textContent.trim().replace(/\s+/g, " ")),
    pins: [...document.querySelectorAll("[data-command-pin].pinned")].map((item) => item.getAttribute("aria-label")),
    storage: localStorage.getItem("explore-better-command-center-v1") || ""
  }));
}

async function main() {
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(path.join(fixture, "alpha.txt"), "alpha\n");
  const port = Number(process.env.PORT || 49000 + Math.floor(Math.random() * 8000));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const pageErrors = [];
  const consoleErrors = [];
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let browser;
  const evidence = {};
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ executablePath: edgePath(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await page.evaluate(() => localStorage.removeItem("explore-better-command-center-v1"));
    await page.keyboard.press("Control+P");
    await page.waitForSelector("#command-dialog[open]");
    evidence.initial = await paletteSnapshot(page);
    check(checks, "opens-focused", evidence.initial.open && evidence.initial.focused === "command-input", JSON.stringify(evidence.initial));
    check(checks, "view-segments", evidence.initial.view === "all" && /result/.test(evidence.initial.summary), JSON.stringify(evidence.initial));

    await page.keyboard.type("disk map");
    evidence.diskMap = await paletteSnapshot(page);
    check(
      checks,
      "disk-map-discoverable",
      /Open Disk Map/i.test(evidence.diskMap.items[0] || ""),
      `First result: ${evidence.diskMap.items[0] || "none"}.`
    );
    await page.locator("#command-input").fill("");

    await page.keyboard.type("hsp");
    evidence.fuzzy = await paletteSnapshot(page);
    check(
      checks,
      "fuzzy-acronym-match",
      /Horizontal split panes/i.test(evidence.fuzzy.items[0] || "") && evidence.fuzzy.resultCount <= 5,
      `First result: ${evidence.fuzzy.items[0] || "none"}; ${evidence.fuzzy.resultCount} total result(s).`
    );
    await page.keyboard.press("Control+d");
    evidence.pinned = await paletteSnapshot(page);
    check(
      checks,
      "keyboard-pin",
      evidence.pinned.pins.some((label) => /Unpin Horizontal split panes/i.test(label || "")) && /horizontal-split-panes/.test(evidence.pinned.storage),
      JSON.stringify(evidence.pinned)
    );
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".workbench")?.classList.contains("layout-horizontal"));
    check(checks, "executes-selected", !await page.locator("#command-dialog").evaluate((dialog) => dialog.open), "Horizontal layout applied.");

    await page.keyboard.press("Control+P");
    evidence.reopened = await paletteSnapshot(page);
    await page.screenshot({ path: desktopScreenshotPath });
    check(
      checks,
      "pinned-ranks-first",
      evidence.reopened.groups[0] === "Pinned" && /Horizontal split panes/i.test(evidence.reopened.items[0] || ""),
      JSON.stringify(evidence.reopened)
    );
    await page.locator('[data-command-view="recent"]').click();
    evidence.recent = await paletteSnapshot(page);
    check(
      checks,
      "recent-view",
      evidence.recent.view === "recent" && evidence.recent.groups[0] === "Recent" && /Horizontal split panes/i.test(evidence.recent.items[0] || ""),
      JSON.stringify(evidence.recent)
    );
    await page.locator('[data-command-view="pinned"]').click();
    evidence.pinnedView = await paletteSnapshot(page);
    check(
      checks,
      "pinned-view",
      evidence.pinnedView.view === "pinned" && evidence.pinnedView.items.length === 1 && /Horizontal split panes/i.test(evidence.pinnedView.items[0]),
      JSON.stringify(evidence.pinnedView)
    );

    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await page.keyboard.press("Control+P");
    evidence.persisted = await paletteSnapshot(page);
    check(
      checks,
      "history-persists-reload",
      evidence.persisted.groups[0] === "Pinned" && evidence.persisted.pins.length === 1,
      JSON.stringify(evidence.persisted)
    );

    await page.setViewportSize({ width: 390, height: 760 });
    await page.screenshot({ path: mobileScreenshotPath });
    const mobile = await page.evaluate(() => {
      const dialog = document.getElementById("command-dialog").getBoundingClientRect();
      const controls = [...document.querySelectorAll("#command-dialog button, #command-dialog input")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, left: rect.left, right: rect.right };
      });
      const results = document.getElementById("command-results");
      return {
        dialog: { left: dialog.left, top: dialog.top, right: dialog.right, bottom: dialog.bottom },
        badControls: controls.filter((rect) => rect.width < 24 || rect.height < 24 || rect.left < dialog.left - 1 || rect.right > dialog.right + 1),
        resultsScrollable: results.scrollHeight > results.clientHeight && ["auto", "scroll"].includes(getComputedStyle(results).overflowY)
      };
    });
    evidence.mobile = mobile;
    check(
      checks,
      "mobile-fit",
      mobile.dialog.left >= 0 && mobile.dialog.top >= 0 && mobile.dialog.right <= 391 && mobile.dialog.bottom <= 761 && mobile.badControls.length === 0 && mobile.resultsScrollable,
      JSON.stringify(mobile)
    );
    const pinLabels = await page.locator("[data-command-pin]").evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
    check(checks, "pin-accessible-names", pinLabels.length > 0 && pinLabels.every(Boolean), `${pinLabels.length} labeled pin control(s).`);
    check(checks, "runtime-clean", pageErrors.length === 0 && consoleErrors.length === 0, `${pageErrors.length} page and ${consoleErrors.length} console error(s).`);
  } catch (error) {
    check(checks, "smoke-execution", false, error.message);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }

  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
  const report = {
    generatedAt: new Date().toISOString(),
    status: summary.fail ? "fail" : "pass",
    summary,
    checks,
    evidence,
    screenshots: { desktop: desktopScreenshotPath, mobile: mobileScreenshotPath },
    pageErrors,
    consoleErrors
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(latestMdPath, markdown(report));
  console.log(`command center UI smoke: ${summary.pass} pass, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
