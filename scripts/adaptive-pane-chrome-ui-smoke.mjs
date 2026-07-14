import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `adaptive-pane-chrome-${stamp}`);
const fixture = path.join(runRoot, "fixture", "level-one", "level-two");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "adaptive-pane-chrome-latest.json");
const latestMdPath = path.join(artifactsDir, "adaptive-pane-chrome-latest.md");
const compactScreenshotPath = path.join(artifactsDir, "adaptive-pane-chrome.png");
const overlayScreenshotPath = path.join(artifactsDir, "adaptive-pane-breadcrumb-overlay.png");
const dockScreenshotPath = path.join(artifactsDir, "adaptive-dock-overflow.png");
const inspectorScreenshotPath = path.join(artifactsDir, "adaptive-preview-rail.png");

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

function markdown(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Adaptive Pane Chrome UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function paneGeometry(page, paneName) {
  return page.evaluate((name) => {
    const pane = document.querySelector(`.pane[data-pane="${name}"]`);
    const paneBounds = pane.getBoundingClientRect();
    const rect = (selector) => {
      const value = pane.querySelector(selector)?.getBoundingClientRect();
      return value ? { width: Math.round(value.width), height: Math.round(value.height), top: Math.round(value.top), bottom: Math.round(value.bottom) } : null;
    };
    const breadcrumbs = pane.querySelector(".breadcrumb-strip");
    const toolbar = pane.querySelector(".toolbar");
    const toggle = pane.querySelector("[data-compact-breadcrumbs]");
    return {
      pane: { width: Math.round(paneBounds.width), height: Math.round(paneBounds.height), top: Math.round(paneBounds.top), bottom: Math.round(paneBounds.bottom) },
      tabs: rect(".tabbar"),
      pathbar: rect(".pathbar"),
      toolbar: rect(".toolbar"),
      fileHead: rect(".file-head"),
      list: rect(".file-list"),
      breadcrumbsDisplay: getComputedStyle(breadcrumbs).display,
      breadcrumbsPosition: getComputedStyle(breadcrumbs).position,
      expanded: toggle.getAttribute("aria-expanded"),
      toggle: rect("[data-compact-breadcrumbs]"),
      toolbarOverflow: Math.max(0, toolbar.scrollWidth - toolbar.clientWidth),
      active: pane.classList.contains("active"),
      activeShadow: getComputedStyle(pane).boxShadow
    };
  }, paneName);
}

async function dockGeometry(page) {
  return page.evaluate(() => {
    const dock = document.querySelector(".command-dock");
    const strip = document.querySelector(".dock-action-strip");
    const toggle = document.getElementById("dock-overflow-toggle");
    const menu = document.getElementById("dock-overflow-menu");
    const stripRect = strip?.getBoundingClientRect();
    const menuRect = menu && !menu.hidden ? menu.getBoundingClientRect() : null;
    const visibleButtons = [...(strip?.querySelectorAll("button") || [])].filter((button) => {
      const style = getComputedStyle(button);
      return !button.hidden && style.display !== "none" && button.getBoundingClientRect().width > 0;
    });
    const hiddenActions = [...(strip?.querySelectorAll(".dock-responsive-hidden") || [])];
    const menuItems = [...(menu?.querySelectorAll("[data-dock-overflow-item]") || [])];
    return {
      dockHeight: Math.round(dock?.getBoundingClientRect().height || 0),
      stripWidth: Math.round(stripRect?.width || 0),
      overflowX: Math.max(0, Math.round((strip?.scrollWidth || 0) - (strip?.clientWidth || 0))),
      overflowY: Math.max(0, Math.round((strip?.scrollHeight || 0) - (strip?.clientHeight || 0))),
      visibleInside: visibleButtons.every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.left >= stripRect.left - 1 && rect.right <= stripRect.right + 1 && rect.top >= stripRect.top - 1 && rect.bottom <= stripRect.bottom + 1;
      }),
      hiddenCount: hiddenActions.length,
      menuCount: menuItems.length,
      countText: document.getElementById("dock-overflow-count")?.textContent || "",
      toggleHidden: toggle?.hidden === true,
      expanded: toggle?.getAttribute("aria-expanded") || "false",
      menuHidden: menu?.hidden !== false,
      menuOverflowX: menu && !menu.hidden ? Math.max(0, Math.round(menu.scrollWidth - menu.clientWidth)) : 0,
      menuOverflowY: menu && !menu.hidden ? Math.max(0, Math.round(menu.scrollHeight - menu.clientHeight)) : 0,
      menuInsideViewport:
        !menuRect ||
        (menuRect.left >= 7 && menuRect.right <= window.innerWidth - 7 && menuRect.top >= 7 && menuRect.bottom <= window.innerHeight - 7),
      opsInMenu: Boolean(menu?.querySelector('[data-overflow-global-action="ops"]')),
      focusId: document.activeElement?.id || ""
    };
  });
}

async function inspectorGeometry(page) {
  return page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    const inspector = document.getElementById("inspector");
    const body = inspector?.querySelector(".inspector-body");
    const bounds = inspector?.getBoundingClientRect();
    return {
      collapsed: shell?.classList.contains("inspector-auto-collapsed") === true,
      inspectorCollapsed: inspector?.classList.contains("auto-collapsed") === true,
      width: Math.round(bounds?.width || 0),
      height: Math.round(bounds?.height || 0),
      bodyDisplay: body ? getComputedStyle(body).display : "missing",
      bodyText: body?.textContent?.trim() || "",
      ariaLabel: inspector?.getAttribute("aria-label") || ""
    };
  });
}

async function waitForStableInspectorPreview(page, marker, timeoutMs = 10000, stableMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const ready = await page.evaluate((expected) => {
      const body = document.querySelector("#inspector .inspector-body");
      return Boolean(body && !body.querySelector(".preview-loading") && body.textContent?.includes(expected));
    }, marker);
    if (ready) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= stableMs) return;
    } else {
      stableSince = 0;
    }
    await page.waitForTimeout(50);
  }
  throw new Error(`Inspector preview did not remain ready for ${stableMs} ms.`);
}

async function main() {
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  for (let index = 0; index < 24; index += 1) {
    await fs.writeFile(path.join(fixture, `sample-${String(index).padStart(2, "0")}.txt`), `sample ${index}\n`);
  }
  const port = Number(process.env.PORT || 50000 + Math.floor(Math.random() * 7000));
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
      executablePath: process.env.EB_ADAPTIVE_PANE_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector(".app-shell")?.classList.contains("inspector-auto-collapsed"));
    evidence.inspectorEmpty = await inspectorGeometry(page);
    await page.screenshot({ path: inspectorScreenshotPath });
    check(
      checks,
      "empty-preview-yields-space",
      evidence.inspectorEmpty.collapsed && evidence.inspectorEmpty.inspectorCollapsed && evidence.inspectorEmpty.width === 42 && evidence.inspectorEmpty.bodyDisplay === "none",
      JSON.stringify(evidence.inspectorEmpty)
    );
    const firstLeftRow = page.locator('.pane[data-pane="left"] [data-entry-path]').first();
    await firstLeftRow.click();
    await page.waitForFunction(() => !document.querySelector(".app-shell")?.classList.contains("inspector-auto-collapsed"));
    await waitForStableInspectorPreview(page, "sample-");
    evidence.inspectorSelected = await inspectorGeometry(page);
    check(
      checks,
      "selection-restores-preview",
      !evidence.inspectorSelected.collapsed && evidence.inspectorSelected.width >= 180 && evidence.inspectorSelected.bodyDisplay !== "none" && evidence.inspectorSelected.bodyText.includes("sample-"),
      JSON.stringify(evidence.inspectorSelected)
    );
    await firstLeftRow.click({ modifiers: ["Control"] });
    await page.waitForFunction(() => document.querySelector(".app-shell")?.classList.contains("inspector-auto-collapsed"));
    evidence.inspectorCleared = await inspectorGeometry(page);
    check(checks, "cleared-selection-collapses-preview", evidence.inspectorCleared.width === 42, JSON.stringify(evidence.inspectorCleared));
    await page.locator('[data-list="left"]').focus();
    await page.keyboard.press("Control+Shift+2");
    await page.waitForFunction(() => document.querySelector(".workbench")?.classList.contains("layout-horizontal"));
    await page.keyboard.press("Control+t");
    await page.waitForFunction(() => document.querySelectorAll('.pane[data-pane="left"] .tab').length === 2);
    await page.screenshot({ path: compactScreenshotPath });

    evidence.left = await paneGeometry(page, "left");
    evidence.right = await paneGeometry(page, "right");
    for (const paneName of ["left", "right"]) {
      const geometry = evidence[paneName];
      check(
        checks,
        `${paneName}-compact-row-heights`,
        geometry.tabs.height <= 33 && geometry.pathbar.height <= 39 && geometry.toolbar.height <= 37 && geometry.fileHead.height <= 29,
        JSON.stringify(geometry)
      );
      check(checks, `${paneName}-listing-space`, geometry.list.height >= 150, `List height ${geometry.list.height}px in ${geometry.pane.height}px pane.`);
      check(
        checks,
        `${paneName}-breadcrumbs-collapsed`,
        geometry.breadcrumbsDisplay === "none" && geometry.toggle.width >= 24 && geometry.toggle.height >= 24 && geometry.expanded === "false",
        JSON.stringify(geometry)
      );
      check(checks, `${paneName}-toolbar-fits`, geometry.toolbarOverflow <= 1, `Toolbar overflow ${geometry.toolbarOverflow}px.`);
    }
    check(
      checks,
      "active-pane-edge",
      evidence.left.active && evidence.left.activeShadow !== "none",
      `Active=${evidence.left.active}; shadow=${evidence.left.activeShadow}.`
    );

    const listHeightBefore = evidence.left.list.height;
    await page.locator('[data-compact-breadcrumbs="left"]').click();
    await page.waitForFunction(() => document.querySelector('.pane[data-pane="left"]')?.classList.contains("compact-breadcrumbs-open"));
    evidence.overlay = await paneGeometry(page, "left");
    await page.screenshot({ path: overlayScreenshotPath });
    check(
      checks,
      "overlay-preserves-list-height",
      evidence.overlay.breadcrumbsDisplay === "flex" && evidence.overlay.breadcrumbsPosition === "absolute" && Math.abs(evidence.overlay.list.height - listHeightBefore) <= 1,
      JSON.stringify(evidence.overlay)
    );
    check(checks, "overlay-expanded-state", evidence.overlay.expanded === "true", `aria-expanded=${evidence.overlay.expanded}.`);

    const ancestor = await page.locator('[data-breadcrumbs="left"] [data-breadcrumb-path]').evaluateAll((items) => {
      const candidates = items.map((item) => item.getAttribute("data-breadcrumb-path")).filter(Boolean);
      return candidates.length > 1 ? candidates[candidates.length - 2] : candidates[0];
    });
    await page.locator('[data-breadcrumbs="left"] [data-breadcrumb-path]').evaluateAll((items, target) => {
      const match = items.find((item) => item.getAttribute("data-breadcrumb-path") === target);
      if (!match) throw new Error(`Breadcrumb target not found: ${target}`);
      match.click();
    }, ancestor);
    await page.waitForFunction((target) => document.querySelector('[data-path-input="left"]')?.value === target, ancestor);
    evidence.afterAncestor = await paneGeometry(page, "left");
    check(
      checks,
      "overlay-ancestor-navigation",
      evidence.afterAncestor.breadcrumbsDisplay === "none" && evidence.afterAncestor.expanded === "false",
      `Navigated to ${ancestor}; expanded=${evidence.afterAncestor.expanded}.`
    );

    await page.locator('[data-compact-breadcrumbs="left"]').click();
    await page.keyboard.press("Escape");
    evidence.afterEscape = await paneGeometry(page, "left");
    check(checks, "overlay-escape-closes", evidence.afterEscape.breadcrumbsDisplay === "none" && evidence.afterEscape.expanded === "false", JSON.stringify(evidence.afterEscape));

    const tabControls = await page.evaluate(() => ({
      lockText: document.querySelector('.pane[data-pane="left"] .tab-lock')?.textContent?.trim() || "",
      lockLabel: document.querySelector('.pane[data-pane="left"] .tab-lock')?.getAttribute("aria-label") || "",
      closeLabels: [...document.querySelectorAll('.pane[data-pane="left"] .tab-close')].map((item) => item.getAttribute("aria-label"))
    }));
    evidence.tabControls = tabControls;
    check(
      checks,
      "tab-icons-accessible",
      tabControls.lockText === "" && /Lock tab|Unlock tab/.test(tabControls.lockLabel) && tabControls.closeLabels.length === 2 && tabControls.closeLabels.every(Boolean),
      JSON.stringify(tabControls)
    );
    await page.locator('[data-list="left"]').focus();
    await page.keyboard.press("Control+Shift+1");
    await page.waitForFunction(() => document.querySelector(".workbench")?.classList.contains("layout-vertical"));
    evidence.vertical = await paneGeometry(page, "left");
    check(
      checks,
      "vertical-keeps-full-breadcrumbs",
      evidence.vertical.breadcrumbsDisplay === "flex" && evidence.vertical.toggle.width === 0 && evidence.vertical.toggle.height === 0,
      JSON.stringify(evidence.vertical)
    );

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForFunction(() => document.getElementById("inspector")?.getBoundingClientRect().height <= 43);
    evidence.inspectorResponsive = await inspectorGeometry(page);
    check(
      checks,
      "responsive-empty-preview-is-rail",
      evidence.inspectorResponsive.collapsed && evidence.inspectorResponsive.height === 42 && evidence.inspectorResponsive.width >= 600,
      JSON.stringify(evidence.inspectorResponsive)
    );

    await page.setViewportSize({ width: 1066, height: 860 });
    await page.waitForFunction(() => {
      const toggle = document.getElementById("dock-overflow-toggle");
      const strip = document.querySelector(".dock-action-strip");
      const visibleButtons = [...(strip?.querySelectorAll("button") || [])].filter((button) => {
        const style = getComputedStyle(button);
        return !button.hidden && style.display !== "none" && button.getBoundingClientRect().width > 0;
      });
      const bounds = strip?.getBoundingClientRect();
      return (
        toggle &&
        !toggle.hidden &&
        Number(document.getElementById("dock-overflow-count")?.textContent || 0) > 0 &&
        strip.scrollWidth <= strip.clientWidth + 1 &&
        strip.scrollHeight <= strip.clientHeight + 1 &&
        visibleButtons.every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
        })
      );
    });
    evidence.dockClosed = await dockGeometry(page);
    check(
      checks,
      "dock-overflow-contained",
      evidence.dockClosed.overflowX === 0 && evidence.dockClosed.overflowY === 0 && evidence.dockClosed.visibleInside,
      JSON.stringify(evidence.dockClosed)
    );
    check(
      checks,
      "dock-overflow-counts-match",
      evidence.dockClosed.hiddenCount > 0 &&
        evidence.dockClosed.hiddenCount === evidence.dockClosed.menuCount &&
        evidence.dockClosed.countText === String(evidence.dockClosed.hiddenCount),
      JSON.stringify(evidence.dockClosed)
    );
    await page.locator("#dock-overflow-toggle").click();
    await page.waitForSelector("#dock-overflow-menu:not([hidden])");
    evidence.dockOpen = await dockGeometry(page);
    await page.screenshot({ path: dockScreenshotPath });
    check(
      checks,
      "dock-menu-contained",
      evidence.dockOpen.expanded === "true" &&
        !evidence.dockOpen.menuHidden &&
        evidence.dockOpen.menuInsideViewport &&
        evidence.dockOpen.menuOverflowX === 0 &&
        evidence.dockOpen.menuOverflowY === 0,
      JSON.stringify(evidence.dockOpen)
    );
    check(checks, "dock-menu-complete", evidence.dockOpen.opsInMenu, JSON.stringify(evidence.dockOpen));
    await page.locator('#dock-overflow-menu [data-overflow-global-action="ops"]').click();
    await page.waitForSelector("#ops-dialog[open]");
    check(checks, "dock-menu-action-executes", await page.locator("#ops-dialog").evaluate((dialog) => dialog.open), "Opened Ops from overflow.");
    await page.locator('[data-close-dialog="ops-dialog"]').click();
    const dockToggle = page.locator("#dock-overflow-toggle");
    await dockToggle.waitFor({ state: "visible" });
    await dockToggle.press("Enter");
    await page.waitForSelector("#dock-overflow-menu:not([hidden])");
    await page.keyboard.press("Escape");
    evidence.dockKeyboardClosed = await dockGeometry(page);
    check(
      checks,
      "dock-menu-keyboard-close",
      evidence.dockKeyboardClosed.menuHidden && evidence.dockKeyboardClosed.expanded === "false" && evidence.dockKeyboardClosed.focusId === "dock-overflow-toggle",
      JSON.stringify(evidence.dockKeyboardClosed)
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
    screenshots: { compact: compactScreenshotPath, overlay: overlayScreenshotPath, dock: dockScreenshotPath },
    pageErrors
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(latestMdPath, markdown(report));
  console.log(`adaptive pane chrome UI smoke: ${summary.pass} pass, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
