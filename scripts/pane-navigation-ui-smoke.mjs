import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `pane-navigation-${stamp}`);
const leftRoot = path.join(runRoot, "left-root");
const currentPath = path.join(leftRoot, "current-folder");
const childPath = path.join(currentPath, "child-folder");
const siblingPath = path.join(leftRoot, "sibling-folder");
const rightRoot = path.join(runRoot, "right-root");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "pane-navigation-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "pane-navigation-ui-latest.md");
const screenshotPath = path.join(artifactsDir, "pane-navigation-ui-latest.png");

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
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

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) throw new Error(`Server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/roots`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start at ${baseUrl}`);
}

function markdown(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Pane Navigation UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function paneState(page, paneName = "left") {
  return page.evaluate((name) => {
    const pane = document.querySelector(`.pane[data-pane="${name}"]`);
    const list = pane.querySelector(`[data-list="${name}"]`);
    const tabs = [...pane.querySelectorAll(".tab")];
    return {
      path: pane.querySelector(`[data-path-input="${name}"]`)?.value || "",
      view: ["details", "compact", "tiles"].find((mode) => list.classList.contains(`view-${mode}`)) || "",
      names: [...list.querySelectorAll("[data-entry-path]")].map((item) => item.textContent.trim()),
      selected: [...list.querySelectorAll('[data-entry-path][aria-selected="true"]')].map((item) => item.getAttribute("data-entry-path")),
      tabCount: tabs.length,
      activeTabIndex: tabs.findIndex((item) => item.classList.contains("active")),
      activeTabLocked: pane.querySelector(".tab.active")?.classList.contains("locked") === true,
      tabPaths: tabs.map((item) => item.getAttribute("title") || ""),
      sortText: pane.querySelector('.file-head [data-column-id="name"]')?.textContent?.trim() || "",
      activity: pane.querySelector(`[data-pane-activity="${name}"]`)?.getAttribute("aria-label") || ""
    };
  }, paneName);
}

async function selectedCount(page, paneName = "left") {
  return page.locator(`.pane[data-pane="${paneName}"] [data-entry-path][aria-selected="true"]`).count();
}

async function enterPanePath(page, paneName, targetPath) {
  const input = page.locator(`[data-path-input="${paneName}"]`);
  await input.fill(targetPath);
  await input.press("Enter");
  await page.waitForFunction(
    ({ pane, expected }) => {
      const paneElement = document.querySelector(`.pane[data-pane="${pane}"]`);
      return (
        paneElement?.querySelector(`[data-path-input="${pane}"]`)?.value === expected &&
        paneElement?.querySelector(".tab.active")?.getAttribute("title") === expected &&
        paneElement?.getAttribute("aria-busy") !== "true"
      );
    },
    { pane: paneName, expected: targetPath }
  );
}

async function main() {
  await Promise.all([
    fs.mkdir(childPath, { recursive: true }),
    fs.mkdir(siblingPath, { recursive: true }),
    fs.mkdir(rightRoot, { recursive: true }),
    fs.mkdir(appData, { recursive: true })
  ]);
  await Promise.all([
    fs.writeFile(path.join(currentPath, "alpha-01.txt"), "alpha one\n"),
    fs.writeFile(path.join(currentPath, "alpha-02.txt"), "alpha two\n"),
    fs.writeFile(path.join(currentPath, "notes.md"), "# notes\n"),
    fs.writeFile(path.join(currentPath, "photo.jpg"), "not really a jpeg\n"),
    fs.writeFile(path.join(childPath, "nested.txt"), "nested\n"),
    fs.writeFile(path.join(siblingPath, "sibling.txt"), "sibling\n")
  ]);

  const port = Number(process.env.PORT || 0) || await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const evidence = {};
  const pageErrors = [];
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
      executablePath: process.env.EB_PANE_NAVIGATION_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(currentPath)}&right=${encodeURIComponent(rightRoot)}`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10_000 });

    evidence.initial = await paneState(page);
    check(
      checks,
      "initial-path-tab-and-breadcrumb",
      evidence.initial.path === currentPath && evidence.initial.tabCount === 1 && evidence.initial.view === "details" &&
        (await page.locator('.pane[data-pane="left"] .breadcrumb-button.current').textContent())?.trim() === "current-folder",
      JSON.stringify(evidence.initial)
    );

    const alphaRow = page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: "alpha-01.txt" });
    await alphaRow.click();
    await page.locator('[data-view-mode="compact"][data-pane="left"]').click();
    evidence.compact = await paneState(page);
    await page.locator('[data-view-mode="tiles"][data-pane="left"]').click();
    evidence.tiles = await paneState(page);
    await page.locator('[data-view-mode="details"][data-pane="left"]').click();
    evidence.detailsRestored = await paneState(page);
    const selectedAlpha = path.join(currentPath, "alpha-01.txt");
    check(
      checks,
      "view-modes-preserve-selection",
      evidence.compact.view === "compact" && evidence.tiles.view === "tiles" && evidence.detailsRestored.view === "details" &&
        [evidence.compact, evidence.tiles, evidence.detailsRestored].every((state) => state.selected.length === 1 && state.selected[0] === selectedAlpha),
      JSON.stringify({ compact: evidence.compact.selected, tiles: evidence.tiles.selected, details: evidence.detailsRestored.selected })
    );

    const nameHeader = page.locator('.pane[data-pane="left"] .file-head [data-column-id="name"]');
    await nameHeader.click();
    evidence.sortDescending = await paneState(page);
    await nameHeader.click();
    evidence.sortAscending = await paneState(page);
    check(
      checks,
      "sort-direction-is-visible-and-reversible",
      /Z-A/.test(evidence.sortDescending.sortText) && /A-Z/.test(evidence.sortAscending.sortText),
      `${evidence.sortDescending.sortText} -> ${evidence.sortAscending.sortText}`
    );

    await page.locator('[data-list="left"]').focus();
    await page.keyboard.press("Control+a");
    evidence.selectAllCount = await selectedCount(page);
    await page.keyboard.press("Control+i");
    evidence.invertAllCount = await selectedCount(page);
    check(
      checks,
      "select-all-and-invert",
      evidence.selectAllCount === 5 && evidence.invertAllCount === 0,
      `all=${evidence.selectAllCount}; inverted=${evidence.invertAllCount}`
    );

    await page.locator('[data-list="left"]').focus();
    await page.keyboard.press("Control+Shift+m");
    await page.waitForFunction(() => document.getElementById("select-dialog")?.open === true);
    await page.locator("#select-pattern").fill("*.txt");
    await page.waitForFunction(() => document.querySelectorAll("#select-preview .select-preview-row").length === 2);
    evidence.maskPreview = await page.evaluate(() => ({
      summary: document.getElementById("select-summary")?.textContent || "",
      rows: [...document.querySelectorAll("#select-preview .select-preview-row")].map((item) => item.textContent.trim())
    }));
    await page.locator("#select-form").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelectorAll('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]').length === 2);
    evidence.maskSelected = await paneState(page);
    check(
      checks,
      "advanced-mask-preview-and-apply",
      evidence.maskPreview.rows.length === 2 && evidence.maskSelected.selected.length === 2 &&
        evidence.maskSelected.selected.every((item) => item.endsWith(".txt")),
      JSON.stringify({ preview: evidence.maskPreview, selected: evidence.maskSelected.selected })
    );
    await page.locator('[data-close-dialog="select-dialog"]').click();

    const pathInput = page.locator('[data-path-input="left"]');
    const missingPath = path.join(currentPath, "missing-folder");
    await pathInput.fill(missingPath);
    await pathInput.press("Enter");
    await page.waitForFunction(
      ({ expectedPath }) =>
        document.querySelector('[data-path-input="left"]')?.value === expectedPath &&
        document.getElementById("status-pill")?.textContent?.startsWith("Folder not found"),
      { expectedPath: currentPath }
    );
    evidence.invalidPath = await page.evaluate(() => ({
      path: document.querySelector('[data-path-input="left"]')?.value || "",
      status: document.getElementById("status-pill")?.textContent || "",
      toast: document.getElementById("toast")?.textContent || "",
      activity: document.querySelector('[data-pane-activity="left"]')?.getAttribute("aria-label") || ""
    }));
    check(
      checks,
      "invalid-path-restores-input-with-feedback",
      evidence.invalidPath.path === currentPath && evidence.invalidPath.status === `Folder not found: ${missingPath}` &&
        evidence.invalidPath.toast === "Folder not found" && /folder not found/i.test(evidence.invalidPath.activity) &&
        !/ENOENT|stat '/.test(`${evidence.invalidPath.status} ${evidence.invalidPath.toast} ${evidence.invalidPath.activity}`),
      JSON.stringify(evidence.invalidPath)
    );

    const currentMenuButton = page.locator('.pane[data-pane="left"] [data-breadcrumb-menu-path]').last();
    await currentMenuButton.click();
    await page.waitForFunction(() => !document.getElementById("breadcrumb-menu")?.hidden && document.querySelectorAll("#breadcrumb-menu [data-breadcrumb-child-path]").length > 0);
    evidence.breadcrumbMenu = await page.evaluate(() => ({
      title: document.querySelector("#breadcrumb-menu .breadcrumb-menu-title")?.textContent?.trim() || "",
      children: [...document.querySelectorAll("#breadcrumb-menu [data-breadcrumb-child-path]")].map((item) => item.textContent.trim())
    }));
    await page.locator(`#breadcrumb-menu [data-breadcrumb-child-other-path="${childPath.replaceAll("\\", "\\\\")}"]`).click().catch(async () => {
      await page.locator("#breadcrumb-menu [data-breadcrumb-child-other-path]").filter({ hasText: "child-folder" }).click();
    });
    await page.waitForFunction((expected) => document.querySelector('[data-path-input="right"]')?.value === expected, childPath);
    evidence.rightAfterBreadcrumb = await paneState(page, "right");
    check(
      checks,
      "breadcrumb-menu-opens-child-in-other-pane",
      evidence.breadcrumbMenu.children.some((item) => item.includes("child-folder")) && evidence.rightAfterBreadcrumb.path === childPath,
      JSON.stringify({ menu: evidence.breadcrumbMenu, rightPath: evidence.rightAfterBreadcrumb.path })
    );

    await enterPanePath(page, "left", leftRoot);
    await enterPanePath(page, "left", currentPath);
    evidence.validPath = await paneState(page);
    check(
      checks,
      "valid-path-entry-navigates-and-recovers",
      evidence.validPath.path === currentPath && /loaded|items/i.test(evidence.validPath.activity),
      JSON.stringify({ path: evidence.validPath.path, activity: evidence.validPath.activity })
    );

    await page.locator('[data-list="left"]').focus();
    await page.keyboard.press("Control+t");
    await page.waitForFunction(() => document.querySelectorAll('.pane[data-pane="left"] .tab').length === 2);
    await page.locator('.pane[data-pane="left"] .tab.active .tab-lock').click();
    await page.waitForFunction(() => document.querySelector('.pane[data-pane="left"] .tab.active')?.classList.contains("locked"));
    await enterPanePath(page, "left", leftRoot);
    await page.waitForFunction(() => document.querySelectorAll('.pane[data-pane="left"] .tab').length === 3);
    evidence.lockedBranch = await paneState(page);
    check(
      checks,
      "locked-tab-navigation-branches",
      evidence.lockedBranch.tabCount === 3 && !evidence.lockedBranch.activeTabLocked &&
        evidence.lockedBranch.tabPaths.filter((item) => item === currentPath).length === 2 && evidence.lockedBranch.path === leftRoot,
      JSON.stringify(evidence.lockedBranch)
    );

    await page.locator('[data-list="left"]').focus();
    await page.keyboard.press("Control+w");
    await page.waitForFunction(() => document.querySelectorAll('.pane[data-pane="left"] .tab').length === 2);
    await page.keyboard.press("Control+Shift+t");
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.pane[data-pane="left"] .tab').length === 3 && document.querySelector('[data-path-input="left"]')?.value === expected,
      leftRoot
    );
    evidence.reopened = await paneState(page);
    const reopenedActiveIndex = evidence.reopened.activeTabIndex;
    await page.locator('[data-list="left"]').focus();
    await page.keyboard.press("Control+PageUp");
    await page.waitForFunction((previousIndex) => {
      const tabs = [...document.querySelectorAll('.pane[data-pane="left"] .tab')];
      return tabs.findIndex((item) => item.classList.contains("active")) !== previousIndex;
    }, reopenedActiveIndex);
    evidence.cycled = await paneState(page);
    check(
      checks,
      "close-reopen-and-cycle-tabs",
      evidence.reopened.tabCount === 3 && evidence.reopened.path === leftRoot && evidence.cycled.activeTabIndex !== reopenedActiveIndex,
      JSON.stringify({ reopened: evidence.reopened, cycled: evidence.cycled })
    );

    await enterPanePath(page, "left", leftRoot);
    const beforeMiddleTabCount = (await paneState(page)).tabCount;
    await page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: "sibling-folder" }).click({ button: "middle" });
    await page.waitForFunction(
      ({ count, expected }) => document.querySelectorAll('.pane[data-pane="left"] .tab').length === count + 1 && document.querySelector('[data-path-input="left"]')?.value === expected,
      { count: beforeMiddleTabCount, expected: siblingPath }
    );
    evidence.middleOpened = await paneState(page);
    check(
      checks,
      "middle-click-folder-opens-new-tab",
      evidence.middleOpened.tabCount === beforeMiddleTabCount + 1 && evidence.middleOpened.path === siblingPath,
      JSON.stringify(evidence.middleOpened)
    );

    while ((await paneState(page)).tabCount > 1) {
      await page.locator('[data-list="left"]').focus();
      await page.keyboard.press("Control+w");
      await page.waitForTimeout(40);
    }
    await page.locator('[data-list="left"]').focus();
    await page.keyboard.press("Control+w");
    await page.waitForFunction(() => document.getElementById("toast")?.textContent === "Keep at least one tab open");
    evidence.minimumTab = await paneState(page);
    check(checks, "minimum-one-tab-is-enforced", evidence.minimumTab.tabCount === 1, JSON.stringify(evidence.minimumTab));

    await page.screenshot({ path: screenshotPath });
    check(checks, "runtime-clean", pageErrors.length === 0, `${pageErrors.length} page error(s)`);
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
    pageErrors,
    screenshot: screenshotPath
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(latestMdPath, markdown(report));
  console.log(`pane navigation UI smoke: ${summary.pass} pass, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
