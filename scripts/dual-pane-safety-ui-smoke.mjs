import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `dual-pane-safety-${stamp}`);
const leftFixture = path.join(runRoot, "left-source");
const rightFixture = path.join(runRoot, "right-target");
const appData = path.join(runRoot, "appdata");
const sourcePath = path.join(leftFixture, "transfer-proof.txt");
const copiedPath = path.join(rightFixture, "transfer-proof.txt");
const latestJsonPath = path.join(artifactsDir, "dual-pane-safety-latest.json");
const latestMdPath = path.join(artifactsDir, "dual-pane-safety-latest.md");
const horizontalScreenshotPath = path.join(artifactsDir, "dual-pane-source-target-horizontal.png");
const verticalScreenshotPath = path.join(artifactsDir, "dual-pane-source-target-vertical.png");

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

async function requestJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function waitFor(page, fn, label, timeoutMs = 10000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await page.evaluate(fn);
    if (last?.ok) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function paneSafetyState(page) {
  return page.evaluate(() => {
    const panes = {};
    for (const paneName of ["left", "right"]) {
      const pane = document.querySelector(`.pane[data-pane="${paneName}"]`);
      const badge = pane.querySelector("[data-pane-role]");
      const actions = {};
      for (const action of ["rename", "copy-other", "move-other", "recycle", "bulk-rename", "label", "trash", "delete"]) {
        const button = pane.querySelector(`[data-action="${action}"]`);
        actions[action] = {
          disabled: button.disabled,
          title: button.title,
          ariaLabel: button.getAttribute("aria-label"),
          direction: button.dataset.transferDirection || "",
          selectionCount: Number(button.dataset.selectionCount || 0)
        };
      }
      const tabbar = pane.querySelector(".tabbar");
      panes[paneName] = {
        role: badge.textContent.trim(),
        roleLabel: badge.getAttribute("aria-label"),
        roleClass: badge.className,
        active: pane.classList.contains("active"),
        hasSelection: pane.classList.contains("has-selection"),
        tabbarOverflow: Math.max(0, tabbar.scrollWidth - tabbar.clientWidth),
        actions
      };
    }
    return { layout: document.querySelector(".workbench")?.className || "", panes };
  });
}

function markdown(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Dual-Pane Safety UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(leftFixture, { recursive: true });
  await fs.mkdir(rightFixture, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(sourcePath, "dual pane transfer proof\n");
  await fs.writeFile(path.join(rightFixture, "target-only.txt"), "target\n");
  const port = Number(process.env.PORT || 51000 + Math.floor(Math.random() * 6000));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const evidence = {};
  const pageErrors = [];
  const apiFailures = [];
  const listResponses = [];
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let browser;
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({
      executablePath: process.env.EB_DUAL_PANE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", async (response) => {
      if (!response.url().includes("/api/")) return;
      if (response.status() >= 400) {
        apiFailures.push({
          status: response.status(),
          url: response.url(),
          body: (await response.text().catch(() => "")).slice(0, 800)
        });
      } else if (response.url().includes("/api/list?")) {
        const data = await response.json().catch(() => ({}));
        listResponses.push({
          url: response.url(),
          path: data.path || "",
          entries: Number(data.entries?.length || data.entryRows?.length || 0),
          names: (data.entries || []).slice(0, 5).map((item) => item.name)
        });
      }
    });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(leftFixture)}&right=${encodeURIComponent(rightFixture)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`[data-entry-path="${sourcePath.replaceAll("\\", "\\\\")}"]`, { timeout: 10000 }).catch(async () => {
      await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    });
    await page.locator('[data-list="left"]').focus();
    await page.keyboard.press("Control+Shift+2");
    await page.waitForFunction(() => document.querySelector(".workbench")?.classList.contains("layout-horizontal"));

    evidence.initial = await paneSafetyState(page);
    evidence.initialListings = await page.evaluate(() => Object.entries(window.__exploreBetterInitialListings || {}).map(([route, record]) => ({
      route,
      consumed: Number(record?.consumed || 0),
      panes: [...(record?.panes || [])]
    })));
    const initialDisabled = ["rename", "copy-other", "move-other", "recycle", "bulk-rename", "label", "trash", "delete"].every(
      (action) => evidence.initial.panes.left.actions[action].disabled && evidence.initial.panes.right.actions[action].disabled
    );
    check(checks, "initial-source-target", evidence.initial.panes.left.role === "SOURCE" && evidence.initial.panes.right.role === "TARGET", JSON.stringify(evidence.initial));
    check(checks, "empty-selection-disabled", initialDisabled, JSON.stringify(evidence.initial.panes));
    check(
      checks,
      "empty-selection-reasons",
      /Select items to copy to the bottom pane/.test(evidence.initial.panes.left.actions["copy-other"].title) &&
        evidence.initial.panes.left.actions["copy-other"].title === evidence.initial.panes.left.actions["copy-other"].ariaLabel,
      evidence.initial.panes.left.actions["copy-other"].title
    );

    await page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: "transfer-proof.txt" }).click();
    evidence.leftSelected = await paneSafetyState(page);
    await page.screenshot({ path: horizontalScreenshotPath });
    const leftActions = evidence.leftSelected.panes.left.actions;
    check(
      checks,
      "horizontal-source-direction",
      evidence.leftSelected.panes.left.role === "SOURCE" && leftActions["copy-other"].direction === "down" && /bottom pane/.test(leftActions["copy-other"].title),
      JSON.stringify(evidence.leftSelected.panes.left)
    );
    check(
      checks,
      "selection-enables-actions",
      ["rename", "copy-other", "move-other", "recycle", "bulk-rename", "label", "trash", "delete"].every((action) => !leftActions[action].disabled) &&
        Object.values(leftActions).every((action) => action.selectionCount === 1),
      JSON.stringify(leftActions)
    );

    await page.locator('.pane[data-pane="left"] [data-action="copy-other"]').click();
    try {
      await waitFor(
        page,
        () => ({
          ok: [...document.querySelectorAll('.pane[data-pane="right"] [data-entry-path]')].some((item) => item.textContent.includes("transfer-proof.txt"))
        }),
        "copy appeared in target pane"
      );
    } catch (error) {
      const ui = await page.evaluate(() => ({
        status: document.getElementById("status-pill")?.textContent || "",
        toast: document.getElementById("toast")?.textContent || "",
        transferOpen: document.getElementById("transfer-dialog")?.open === true,
        transferSummary: document.getElementById("transfer-summary")?.textContent || "",
        initialListings: Object.entries(window.__exploreBetterInitialListings || {}).map(([route, record]) => ({
          route,
          consumed: Number(record?.consumed || 0),
          panes: Number(record?.panes?.size || 0)
        }))
      }));
      const copiedOnDisk = await fs.access(copiedPath).then(() => true, () => false);
      const cachedListing = await requestJson(baseUrl, `/api/list?path=${encodeURIComponent(rightFixture)}&showHidden=true`);
      const freshListing = await requestJson(baseUrl, `/api/list?path=${encodeURIComponent(rightFixture)}&showHidden=true&bypassCache=true`);
      const listingNames = (listing) => (listing.entries || []).map((item) => item.name);
      throw new Error(`${error.message}; copiedOnDisk=${copiedOnDisk}; ui=${JSON.stringify(ui)}; cached=${JSON.stringify(listingNames(cachedListing))}; fresh=${JSON.stringify(listingNames(freshListing))}; listResponses=${JSON.stringify(listResponses)}; apiFailures=${JSON.stringify(apiFailures)}`);
    }
    const copiedBytes = await fs.readFile(copiedPath, "utf8");
    check(checks, "copy-follows-target", copiedBytes === "dual pane transfer proof\n", `Copied bytes: ${JSON.stringify(copiedBytes)}.`);

    await page.locator('.pane[data-pane="right"] [data-entry-path]').filter({ hasText: "transfer-proof.txt" }).click();
    evidence.rightSelected = await paneSafetyState(page);
    const rightActions = evidence.rightSelected.panes.right.actions;
    check(
      checks,
      "source-role-follows-focus",
      evidence.rightSelected.panes.right.role === "SOURCE" && evidence.rightSelected.panes.left.role === "TARGET",
      JSON.stringify(evidence.rightSelected.panes)
    );
    check(
      checks,
      "horizontal-reverse-direction",
      rightActions["copy-other"].direction === "up" && /top pane/.test(rightActions["copy-other"].title),
      JSON.stringify(rightActions["copy-other"])
    );

    await page.keyboard.press("Control+Shift+1");
    await page.waitForFunction(() => document.querySelector(".workbench")?.classList.contains("layout-vertical"));
    evidence.verticalRight = await paneSafetyState(page);
    await page.screenshot({ path: verticalScreenshotPath });
    check(
      checks,
      "vertical-right-direction",
      evidence.verticalRight.panes.right.actions["copy-other"].direction === "left" && /left pane/.test(evidence.verticalRight.panes.right.actions["copy-other"].title),
      JSON.stringify(evidence.verticalRight.panes.right.actions["copy-other"])
    );

    await page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: "transfer-proof.txt" }).click();
    evidence.verticalLeft = await paneSafetyState(page);
    check(
      checks,
      "vertical-left-direction",
      evidence.verticalLeft.panes.left.role === "SOURCE" && evidence.verticalLeft.panes.left.actions["move-other"].direction === "right" &&
        /right pane/.test(evidence.verticalLeft.panes.left.actions["move-other"].title),
      JSON.stringify(evidence.verticalLeft.panes.left.actions["move-other"])
    );
    check(
      checks,
      "role-badges-fit-tabs",
      evidence.verticalLeft.panes.left.tabbarOverflow <= 1 && evidence.verticalLeft.panes.right.tabbarOverflow <= 1,
      `Left overflow ${evidence.verticalLeft.panes.left.tabbarOverflow}px; right ${evidence.verticalLeft.panes.right.tabbarOverflow}px.`
    );

    await page.locator('[data-list="left"]').focus();
    await page.keyboard.press("Escape");
    evidence.cleared = await paneSafetyState(page);
    check(
      checks,
      "clear-selection-disables-again",
      evidence.cleared.panes.left.actions["copy-other"].disabled && evidence.cleared.panes.left.actions["copy-other"].selectionCount === 0,
      JSON.stringify(evidence.cleared.panes.left.actions["copy-other"])
    );
    check(checks, "runtime-clean", pageErrors.length === 0, `${pageErrors.length} page error(s).`);
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
    screenshots: { horizontal: horizontalScreenshotPath, vertical: verticalScreenshotPath },
    pageErrors,
    apiFailures,
    listResponses
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(latestMdPath, markdown(report));
  console.log(`dual-pane safety UI smoke: ${summary.pass} pass, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
