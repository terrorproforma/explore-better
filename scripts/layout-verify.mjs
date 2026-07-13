import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import { clickDockAction } from "./ui-helpers.mjs";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `layout-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");

const viewports = [
  { name: "desktop", width: 1440, height: 920 },
  { name: "small-desktop", width: 1024, height: 760 },
  { name: "tablet", width: 820, height: 900 },
  { name: "mobile", width: 390, height: 844 }
];

const stressLayoutSizes = {
  navWidth: 246,
  inspectorWidth: 212,
  leftPaneWeight: 1.08,
  rightPaneWeight: 0.92,
  topPaneWeight: 1,
  bottomPaneWeight: 1,
  dockHeight: 140
};

const stressFavorites = [
  "Quarterly Media Intake With A Very Long Favorite Name",
  "Engineering Downloads Review Queue",
  "Photo Archive Triage And Metadata",
  "Network Share Scratch Mirror",
  "Release Packaging Workspace"
].map((name, index) => ({
  id: `layout-favorite-${index}`,
  name,
  path: fixture,
  color: ["teal", "gold", "ember", "violet", "green"][index % 5]
}));

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
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
      throw new Error(`Server exited early with ${child.exitCode} at ${baseUrl}: ${getOutput()}`);
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

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  if (!port) throw new Error("Windows did not assign an available layout-test port.");
  return port;
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
  await fs.mkdir(path.join(fixture, "Folder With A Very Long Name For Header Verification"), { recursive: true });
  await fs.mkdir(path.join(fixture, "Another Folder With Labels And Metadata"), { recursive: true });
  await fs.writeFile(
    path.join(fixture, "Folder With A Very Long Name For Header Verification", "inside-double-click.txt"),
    "opened by double click\n"
  );
  await fs.writeFile(
    path.join(fixture, "very-long-file-name-that-should-not-break-header-layout-000001.txt"),
    "layout verifier\n"
  );
  await fs.writeFile(path.join(fixture, "needle-layout-search-target.md"), "# layout\n");
  await fs.mkdir(appData, { recursive: true });
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_LAYOUT_BROWSER || "") ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  );
}

async function inspectLayout(page, mode = "workbench") {
  return page.evaluate((targetMode) => {
    const selectors =
      targetMode === "speed"
        ? [
            ["#speed-dialog[open] .speed-actions button", "speed-actions"],
            ["#speed-dialog[open] #speed-query", "speed-query"],
            ["#speed-dialog[open] .speed-metrics > div", "speed-metrics"],
            ["#speed-dialog[open] .speed-results", "speed-results"]
          ]
        : [
            [".pane.active .pathbar > button.icon-button", "pathbar"],
            [".pane.active .pathbar > input", "pathbar"],
            [".pane.active .breadcrumb-button", "breadcrumbs"],
            [".pane.active .breadcrumb-menu-button", "breadcrumbs"],
            [".pane.active .toolbar button", "toolbar"],
            [".pane.active .toolbar input", "toolbar"],
            [".pane.active .toolbar select", "toolbar"],
            [".pane.active .file-head button", "file-head"],
            [".dock-action-strip > button:not([hidden])", "dock"],
            [".dock-action-strip > select", "dock"],
            [".dock-mode-strip > label", "dock"],
            [".dock-context > button, .dock-context > span", "dock"],
            [".layout-toggle button", "layout-toggle"]
          ];
    const issues = [];
    const samples = [];
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const clippedText = (element, area) => {
      if (element.matches("input, select, textarea")) {
        return false;
      }
      if (area === "file-head") {
        const title = element.querySelector(".column-title");
        return Boolean(title && title.textContent.trim().length > 2 && title.scrollWidth > title.clientWidth + 4);
      }
      if (area === "breadcrumbs") {
        return false;
      }
      if (element.classList.contains("pane-command")) {
        return false;
      }
      const text = (element.innerText || element.textContent || element.value || "").trim();
      return text.length > 2 && element.scrollWidth > element.clientWidth + 4;
    };
    for (const [selector, area] of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const text = (element.innerText || element.textContent || element.value || "").trim().replace(/\s+/g, " ");
        const isCollapsedToggle =
          element.classList.contains("dock-toggle") && getComputedStyle(element.querySelector("span")).display === "none";
        const isCollapsedStatus =
          element.classList.contains("dock-status") &&
          getComputedStyle(element.querySelector(".dock-status-value"))?.display === "none";
        const isIcon =
          text.length <= 2 ||
          isCollapsedToggle ||
          isCollapsedStatus ||
          element.classList.contains("icon-button") ||
          element.classList.contains("pane-command") ||
          Boolean(element.querySelector(".view-glyph, .layout-glyph"));
        const minWidth = area === "breadcrumbs" ? (isIcon ? 20 : 30) : isIcon ? 24 : 36;
        const minHeight = area === "breadcrumbs" ? 20 : 24;
        const clipped = clippedText(element, area);
        const squished = rect.width < minWidth || rect.height < minHeight;
        const verticallyLost = rect.bottom < 0 || rect.top > viewport.height;
        samples.push({
          area,
          text,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          clipped,
          squished
        });
        const viewportFailure = targetMode === "speed" || !["dock", "toolbar", "layout-toggle"].includes(area);
        if (clipped || squished || (viewportFailure && verticallyLost)) {
          issues.push({
            area,
            text,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            clipped,
            squished,
            verticallyLost
          });
        }
      }
    }
    return {
      mode: targetMode,
      viewport,
      issues,
      samples,
      scroll: {
        toolbar: {
          clientWidth: document.querySelector(".toolbar")?.clientWidth || 0,
          scrollWidth: document.querySelector(".toolbar")?.scrollWidth || 0
        },
        pathbar: {
          clientWidth: document.querySelector(".pathbar")?.clientWidth || 0,
          scrollWidth: document.querySelector(".pathbar")?.scrollWidth || 0
        },
        dock: {
          clientHeight: document.querySelector(".command-dock")?.clientHeight || 0,
          scrollHeight: document.querySelector(".command-dock")?.scrollHeight || 0
        },
        breadcrumbs: {
          clientWidth: document.querySelector(".pane.active .breadcrumb-strip")?.clientWidth || 0,
          scrollWidth: document.querySelector(".pane.active .breadcrumb-strip")?.scrollWidth || 0
        }
      }
    };
  }, mode);
}

async function inspectTopbarReachability(page) {
  return page.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const rectData = (rect) => ({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom)
    });
    const textFor = (element) =>
      (element.innerText || element.textContent || element.value || element.getAttribute("aria-label") || element.title || "")
        .trim()
        .replace(/\s+/g, " ");
    const topbar = document.querySelector(".topbar");
    const rootStrip = document.querySelector(".root-strip");
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const fixedElements = [...document.querySelectorAll(".topbar .brand, .topbar .status-pill")].filter(isVisible);
    const rootButtons = [...document.querySelectorAll(".root-strip button")].filter(isVisible);
    const issues = [];
    const samples = [];
    const topbarRect = topbar?.getBoundingClientRect();
    if (!topbar || !rootStrip || !topbarRect) {
      return {
        mode: "topbar-reachability",
        viewport,
        issues: [{ area: "topbar", text: "missing topbar or root strip", reason: "missing-container" }],
        samples,
        counts: { roots: 0, fixed: 0 }
      };
    }

    for (const element of fixedElements) {
      const rect = element.getBoundingClientRect();
      const text = textFor(element);
      const squished = rect.width < 56 || rect.height < 28;
      const outsideViewport = rect.left < -1 || rect.right > viewport.width + 1 || rect.top < -1 || rect.bottom > viewport.height + 1;
      const sample = {
        area: "topbar-fixed",
        text,
        rect: rectData(rect),
        squished,
        outsideViewport
      };
      samples.push(sample);
      if (squished || outsideViewport) {
        issues.push(sample);
      }
    }

    const initialScroll = rootStrip.scrollLeft;
    for (const element of rootButtons) {
      element.scrollIntoView({ block: "nearest", inline: "nearest" });
      const stripRect = rootStrip.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const text = textFor(element);
      const truncated = text.length > 2 && element.scrollWidth > element.clientWidth + 4;
      const squished = rect.width < (text.length <= 2 ? 24 : 38) || rect.height < 26;
      const outsideStrip =
        rect.left < stripRect.left - 1 ||
        rect.right > stripRect.right + 1 ||
        rect.top < stripRect.top - 1 ||
        rect.bottom > stripRect.bottom + 1;
      const outsideViewport =
        rect.left < -1 || rect.right > viewport.width + 1 || rect.top < -1 || rect.bottom > viewport.height + 1;
      const sample = {
        area: "topbar-roots",
        text,
        rect: rectData(rect),
        container: rectData(stripRect),
        truncated,
        squished,
        outsideStrip,
        outsideViewport
      };
      samples.push(sample);
      if (squished || outsideStrip || outsideViewport) {
        issues.push(sample);
      }
    }
    rootStrip.scrollLeft = initialScroll;

    return {
      mode: "topbar-reachability",
      viewport,
      issues,
      samples,
      counts: { roots: rootButtons.length, fixed: fixedElements.length },
      scroll: {
        rootStrip: {
          clientWidth: rootStrip.clientWidth,
          scrollWidth: rootStrip.scrollWidth
        },
        topbar: rectData(topbarRect)
      }
    };
  });
}

async function inspectChromeReachability(page) {
  return page.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const rectData = (rect) => ({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom)
    });
    const textFor = (element) =>
      (element.innerText || element.textContent || element.value || element.getAttribute("aria-label") || element.title || "")
        .trim()
        .replace(/\s+/g, " ");
    const regions = [
      {
        area: "toolbar-reachability",
        container: document.querySelector(".pane.active .toolbar"),
        selector: ".pane.active .toolbar button, .pane.active .toolbar input, .pane.active .toolbar select"
      },
      {
        area: "dock-action-reachability",
        container: document.querySelector(".dock-action-strip"),
        selector: ".dock-action-strip > button:not([hidden]), .dock-action-strip > select, .saved-command-strip > button:not([hidden])"
      },
      {
        area: "dock-mode-reachability",
        container: document.querySelector(".dock-mode-strip"),
        selector: ".dock-mode-strip > label, .layout-toggle > button"
      },
      {
        area: "dock-context-reachability",
        container: document.querySelector(".dock-context"),
        selector: ".dock-context > button, .dock-context > span"
      }
    ];
    const issues = [];
    const samples = [];
    for (const region of regions) {
      const container = region.container;
      if (!container) {
        issues.push({ area: region.area, text: "missing container", reason: "missing-container" });
        continue;
      }
      const elements = [...document.querySelectorAll(region.selector)].filter((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      const initialScroll = { left: container.scrollLeft, top: container.scrollTop };
      for (const element of elements) {
        element.scrollIntoView({ block: "nearest", inline: "nearest" });
        const containerRect = container.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        const text = textFor(element);
        const collapsedToggle =
          element.classList.contains("dock-toggle") && getComputedStyle(element.querySelector("span")).display === "none";
        const collapsedStatus =
          element.classList.contains("dock-status") &&
          getComputedStyle(element.querySelector(".dock-status-value"))?.display === "none";
        const iconOnly =
          collapsedToggle ||
          collapsedStatus ||
          element.classList.contains("icon-button") ||
          element.classList.contains("pane-command") ||
          Boolean(element.querySelector(".view-glyph, .layout-glyph"));
        const clipped =
          !iconOnly &&
          !element.matches("input, select, textarea") &&
          text.length > 2 &&
          element.scrollWidth > element.clientWidth + 4;
        const squished = rect.width < (iconOnly || text.length <= 2 ? 24 : 36) || rect.height < 24;
        const outsideContainer =
          rect.left < containerRect.left - 1 ||
          rect.right > containerRect.right + 1 ||
          rect.top < containerRect.top - 1 ||
          rect.bottom > containerRect.bottom + 1;
        const outsideViewport =
          rect.left < -1 || rect.right > viewport.width + 1 || rect.top < -1 || rect.bottom > viewport.height + 1;
        const sample = {
          area: region.area,
          text,
          rect: rectData(rect),
          container: rectData(containerRect),
          clipped,
          squished,
          outsideContainer,
          outsideViewport
        };
        samples.push(sample);
        if (clipped || squished || outsideContainer || outsideViewport) {
          issues.push(sample);
        }
      }
      container.scrollLeft = initialScroll.left;
      container.scrollTop = initialScroll.top;
    }
    return {
      mode: "chrome-reachability",
      viewport,
      issues,
      samples,
      counts: {
        toolbar: samples.filter((sample) => sample.area === "toolbar-reachability").length,
        dock: samples.filter((sample) => sample.area.startsWith("dock-")).length
      }
    };
  });
}

async function inspectPaneMoreMenu(page) {
  const summary = page.locator(".pane.active .pane-more > summary");
  await summary.click();
  await page.waitForFunction(() => document.querySelector(".pane.active .pane-more[open] .pane-more-menu")?.classList.contains("positioned"));
  const report = await page.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const menu = document.querySelector(".pane.active .pane-more[open] .pane-more-menu");
    const issues = [];
    const controls = [];
    if (!menu) {
      return { mode: "pane-more", viewport, issues: [{ area: "pane-more", reason: "missing-open-menu" }], controls };
    }
    const menuRect = menu.getBoundingClientRect();
    const paneRect = menu.closest(".pane")?.getBoundingClientRect();
    const outsideViewport = menuRect.left < -1 || menuRect.right > viewport.width + 1 || menuRect.top < -1 || menuRect.bottom > viewport.height + 1;
    if (outsideViewport) {
      issues.push({ area: "pane-more", reason: "outside-viewport", rect: { left: menuRect.left, top: menuRect.top, right: menuRect.right, bottom: menuRect.bottom } });
    }
    if (paneRect && (menuRect.left < paneRect.left - 1 || menuRect.right > paneRect.right + 1)) {
      issues.push({
        area: "pane-more",
        reason: "outside-pane-horizontal-bounds",
        rect: { left: menuRect.left, right: menuRect.right },
        pane: { left: paneRect.left, right: paneRect.right }
      });
    }
    for (const element of menu.querySelectorAll("button, select")) {
      const rect = element.getBoundingClientRect();
      const text = (element.textContent || element.value || element.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
      const clipped = !element.matches("select") && element.scrollWidth > element.clientWidth + 4;
      const outsideMenu = rect.left < menuRect.left - 1 || rect.right > menuRect.right + 1 || rect.top < menuRect.top - 1 || rect.bottom > menuRect.bottom + 1;
      const item = { text, clipped, outsideMenu, width: Math.round(rect.width), height: Math.round(rect.height) };
      controls.push(item);
      if (clipped || outsideMenu || rect.width < 36 || rect.height < 24) {
        issues.push({ area: "pane-more-control", ...item });
      }
    }
    return { mode: "pane-more", viewport, issues, controls };
  });
  await summary.click();
  return report;
}

async function verifyFocusWorkspace(page) {
  const before = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    paneWidth: [...document.querySelectorAll(".pane")].reduce((sum, pane) => sum + pane.getBoundingClientRect().width, 0),
    navDisplay: getComputedStyle(document.querySelector(".nav-rail")).display,
    inspectorDisplay: getComputedStyle(document.querySelector(".inspector")).display
  }));
  await page.locator('[data-topbar-action="focus"]').click();
  await page.waitForFunction(() => document.querySelector(".app-shell")?.classList.contains("focus-files"));
  const focused = await page.evaluate(() => ({
    paneWidth: [...document.querySelectorAll(".pane")].reduce((sum, pane) => sum + pane.getBoundingClientRect().width, 0),
    navDisplay: getComputedStyle(document.querySelector(".nav-rail")).display,
    inspectorDisplay: getComputedStyle(document.querySelector(".inspector")).display,
    pressed: document.querySelector('[data-topbar-action="focus"]')?.getAttribute("aria-pressed")
  }));
  await page.locator('[data-topbar-action="focus"]').click();
  await page.waitForFunction(() => !document.querySelector(".app-shell")?.classList.contains("focus-files"));
  const restored = await page.evaluate(() => ({
    navDisplay: getComputedStyle(document.querySelector(".nav-rail")).display,
    inspectorDisplay: getComputedStyle(document.querySelector(".inspector")).display,
    pressed: document.querySelector('[data-topbar-action="focus"]')?.getAttribute("aria-pressed")
  }));
  const issues = [];
  if (focused.navDisplay !== "none" || focused.inspectorDisplay !== "none" || focused.pressed !== "true") {
    issues.push({ area: "focus-workspace", reason: "chrome-not-hidden", focused });
  }
  if (before.viewportWidth >= 1000 && focused.paneWidth <= before.paneWidth + 100) {
    issues.push({ area: "focus-workspace", reason: "pane-area-did-not-grow", before, focused });
  }
  if (restored.navDisplay === "none" || restored.inspectorDisplay === "none" || restored.pressed !== "false") {
    issues.push({ area: "focus-workspace", reason: "chrome-not-restored", restored });
  }
  return { mode: "focus-workspace", before, focused, restored, issues };
}

async function clickHorizontalLayoutToggle(page) {
  const horizontalToggle = page.locator('[data-layout-mode="horizontal"]');
  const toggleCount = await horizontalToggle.count();
  if (toggleCount !== 1) {
    throw new Error(`Expected one horizontal layout toggle, found ${toggleCount}.`);
  }
  await horizontalToggle.scrollIntoViewIfNeeded();
  const toggleHitTarget = await horizontalToggle.evaluate((element) => {
    const data = (node) => {
      const rect = node?.getBoundingClientRect?.();
      return rect
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }
        : null;
    };
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      button: data(element),
      modeStrip: data(element.closest(".dock-mode-strip")),
      dock: data(element.closest(".command-dock")),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      hitTag: hit?.tagName || "",
      hitClass: hit?.className || "",
      hitOwnsButton: hit === element || element.contains(hit)
    };
  });
  if (!toggleHitTarget.hitOwnsButton) {
    throw new Error(`Horizontal layout toggle is not hit-testable: ${JSON.stringify(toggleHitTarget)}`);
  }
  await page.mouse.click(
    toggleHitTarget.button.x + toggleHitTarget.button.width / 2,
    toggleHitTarget.button.y + toggleHitTarget.button.height / 2
  );
  await page.waitForFunction(() => document.querySelector(".workbench")?.classList.contains("layout-horizontal"), {
    timeout: 5000
  });
}

async function verifyDoubleClickNavigation(page) {
  const folderName = "Folder With A Very Long Name For Header Verification";
  const targetPath = path.join(fixture, folderName);
  await clickHorizontalLayoutToggle(page);
  const row = page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: folderName });
  const rowCount = await row.count();
  if (rowCount !== 1) {
    throw new Error(`Expected one double-click test folder row, found ${rowCount}.`);
  }
  await row.waitFor({ state: "visible", timeout: 5000 });
  await row.scrollIntoViewIfNeeded();
  await row.dblclick();
  await page.waitForFunction(
    (expectedPath) => document.querySelector('[data-path-input="left"]')?.value === expectedPath,
    targetPath,
    { timeout: 5000 }
  );
  await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 5000 });
  const insideVisible = await page
    .locator('.pane[data-pane="left"] [data-entry-path]')
    .filter({ hasText: "inside-double-click.txt" })
    .count();
  if (insideVisible !== 1) {
    throw new Error(`Double-click opened ${targetPath}, but inside-double-click.txt was not visible.`);
  }
  return {
    doubleClickFolder: {
      folderName,
      targetPath,
      insideVisible: true
    }
  };
}

async function verifyFolderRowHitTarget(page) {
  const paneName = "left";
  const folderName = "Folder With A Very Long Name For Header Verification";
  await clickHorizontalLayoutToggle(page);
  const row = page.locator(`.pane[data-pane="${paneName}"] [data-entry-path]`).filter({ hasText: folderName });
  const rowCount = await row.count();
  if (rowCount !== 1) {
    throw new Error(`Expected one row hit-target test folder, found ${rowCount}.`);
  }
  await row.waitFor({ state: "visible", timeout: 5000 });
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(80);
  const report = await page.evaluate(
    ({ paneName: targetPane, folderName: targetFolder }) => {
      const rectData = (rect) => ({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom)
      });
      const pane = document.querySelector(`.pane[data-pane="${targetPane}"]`);
      const list = pane?.querySelector(".file-list");
      const row = [...(list?.querySelectorAll("[data-entry-path]") || [])].find((element) =>
        (element.textContent || "").includes(targetFolder)
      );
      if (!pane || !list || !row) {
        return {
          paneName: targetPane,
          folderName: targetFolder,
          missing: !pane ? "pane" : !list ? "file-list" : "row",
          hitMatches: false,
          visibleInsideList: false
        };
      }
      const listRect = list.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const viewportRect = {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight
      };
      const visibleBounds = {
        left: Math.max(listRect.left + 6, rowRect.left + 6, viewportRect.left + 6),
        right: Math.min(listRect.right - 6, rowRect.right - 6, viewportRect.right - 6),
        top: Math.max(listRect.top + 6, rowRect.top + 6, viewportRect.top + 6),
        bottom: Math.min(listRect.bottom - 6, rowRect.bottom - 6, viewportRect.bottom - 6)
      };
      const targetPath = row.getAttribute("data-entry-path") || "";
      const preferredX = Math.min(Math.max(rowRect.left + Math.min(82, rowRect.width / 2), visibleBounds.left), visibleBounds.right);
      const preferredY = Math.min(Math.max(rowRect.top + rowRect.height / 2, visibleBounds.top), visibleBounds.bottom);
      const width = Math.max(1, visibleBounds.right - visibleBounds.left);
      const candidateXs = [
        preferredX,
        visibleBounds.left + width * 0.18,
        visibleBounds.left + width * 0.35,
        visibleBounds.left + width * 0.52,
        visibleBounds.left + width * 0.68,
        visibleBounds.left + width * 0.84,
        visibleBounds.right - 1
      ];
      const candidateYs = [
        preferredY,
        Math.min(Math.max(rowRect.top + 10, visibleBounds.top), visibleBounds.bottom),
        Math.min(Math.max(rowRect.bottom - 10, visibleBounds.top), visibleBounds.bottom)
      ];
      const samples = [];
      let match = null;
      for (const y of candidateYs) {
        for (const x of candidateXs) {
          if (x < visibleBounds.left || x > visibleBounds.right || y < visibleBounds.top || y > visibleBounds.bottom) continue;
          const hit = document.elementFromPoint(x, y);
          const hitRow = hit?.closest("[data-entry-path]");
          const hitPath = hitRow?.getAttribute("data-entry-path") || "";
          const sample = {
            x: Math.round(x),
            y: Math.round(y),
            hitPath,
            hitText: (hitRow?.textContent || hit?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80)
          };
          samples.push(sample);
          if (hitPath === targetPath) {
            match = sample;
            break;
          }
        }
        if (match) break;
      }
      const chosen = match || samples[0] || { x: Math.round(preferredX), y: Math.round(preferredY), hitPath: "", hitText: "" };
      const visibleInsideList =
        chosen.x >= listRect.left &&
        chosen.x <= listRect.right &&
        chosen.y >= listRect.top &&
        chosen.y <= listRect.bottom &&
        chosen.x >= viewportRect.left &&
        chosen.x <= viewportRect.right &&
        chosen.y >= viewportRect.top &&
        chosen.y <= viewportRect.bottom &&
        visibleBounds.left <= visibleBounds.right &&
        visibleBounds.top <= visibleBounds.bottom &&
        rowRect.bottom > listRect.top &&
        rowRect.top < listRect.bottom;
      return {
        paneName: targetPane,
        folderName: targetFolder,
        targetPath,
        hitPath: chosen.hitPath,
        hitText: chosen.hitText,
        center: {
          x: chosen.x,
          y: chosen.y
        },
        samples,
        visibleBounds: {
          left: Math.round(visibleBounds.left),
          top: Math.round(visibleBounds.top),
          right: Math.round(visibleBounds.right),
          bottom: Math.round(visibleBounds.bottom)
        },
        listRect: rectData(listRect),
        rowRect: rectData(rowRect),
        hitMatches: Boolean(match),
        visibleInsideList
      };
    },
    { paneName, folderName }
  );
  if (!report.visibleInsideList || !report.hitMatches) {
    throw new Error(`Folder row hit target failed: ${JSON.stringify(report)}`);
  }
  return report;
}

async function verifySpeedTelemetry(page) {
  const telemetry = await page.evaluate(() => {
    const metrics = {};
    for (const cell of document.querySelectorAll("#speed-dialog[open] [data-speed-metric]")) {
      const id = cell.getAttribute("data-speed-metric");
      metrics[id] = {
        label: cell.querySelector("span")?.textContent?.trim() || "",
        value: cell.querySelector("strong")?.textContent?.trim() || "",
        className: cell.className || ""
      };
    }
    return metrics;
  });
  const required = ["active-pane", "pane-items", "source", "live-load", "read-stat", "filter-labels", "metadata"];
  const missing = required.filter((id) => !telemetry[id]?.value);
  if (missing.length) {
    throw new Error(`Speed telemetry is missing metric(s): ${missing.join(", ")}.`);
  }
  if (!/ms$/i.test(telemetry["live-load"].value)) {
    throw new Error(`Speed telemetry live-load is not a millisecond value: ${telemetry["live-load"].value}`);
  }
  if (!telemetry["source"].className.includes("speed-metric-live")) {
    throw new Error("Speed telemetry live metrics are not visually marked.");
  }
  return telemetry;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const requestedPort = optionValue("--port", process.env.PORT || "");
  const port = requestedPort ? Number(requestedPort) : await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
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

  const browser = await chromium.launch({ executablePath: edgePath(), headless: true });
  try {
    await waitForServer(baseUrl, server, () => serverOutput.trim());
    await requestJson(baseUrl, "/api/state", {
      method: "POST",
      body: JSON.stringify({ settings: { layoutSizes: stressLayoutSizes }, favorites: stressFavorites })
    });
    const page = await browser.newPage();
    const reports = [];
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(
        `${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`,
        { waitUntil: "domcontentloaded" }
      );
      await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
      const workbenchReport = await inspectLayout(page, "workbench");
      const topbarReachability = await inspectTopbarReachability(page);
      const chromeReachability = await inspectChromeReachability(page);
      const paneMore = await inspectPaneMoreMenu(page);
      const focusWorkspace = await verifyFocusWorkspace(page);
      const rowHitTargets = await verifyFolderRowHitTarget(page);
      const workbenchScreenshot = path.join(artifactsDir, `layout-${viewport.name}.png`);
      await page.screenshot({ path: workbenchScreenshot, fullPage: true });
      const interactions = await verifyDoubleClickNavigation(page);
      await clickDockAction(page, "speed");
      await page.waitForSelector("#speed-dialog[open]");
      const speedTelemetry = await verifySpeedTelemetry(page);
      const speedReport = await inspectLayout(page, "speed");
      const speedScreenshot = path.join(artifactsDir, `layout-${viewport.name}-speed.png`);
      await page.screenshot({ path: speedScreenshot, fullPage: true });
      const issues = [
        ...workbenchReport.issues.map((issue) => ({ mode: "workbench", ...issue })),
        ...topbarReachability.issues.map((issue) => ({ mode: "topbar-reachability", ...issue })),
        ...chromeReachability.issues.map((issue) => ({ mode: "chrome-reachability", ...issue })),
        ...paneMore.issues.map((issue) => ({ mode: "pane-more", ...issue })),
        ...focusWorkspace.issues.map((issue) => ({ mode: "focus-workspace", ...issue })),
        ...speedReport.issues.map((issue) => ({ mode: "speed", ...issue }))
      ];
      reports.push({
        ...viewport,
        screenshot: workbenchScreenshot,
        speedScreenshot,
        interactions,
        rowHitTargets,
        speedTelemetry,
        issues,
        workbench: workbenchReport,
        topbarReachability,
        chromeReachability,
        paneMore,
        focusWorkspace,
        speed: speedReport
      });
      console.log(`${viewport.name}: ${issues.length} layout issue(s), row hit target ok, double-click ok`);
    }
    const output = {
      generatedAt: new Date().toISOString(),
      fixture,
      reports
    };
    const jsonPath = path.join(artifactsDir, "layout-verification-latest.json");
    await fs.writeFile(jsonPath, JSON.stringify(output, null, 2));
    const issueCount = reports.reduce((sum, report) => sum + report.issues.length, 0);
    console.log(`wrote ${jsonPath}`);
    if (issueCount > 0) {
      console.error(
        JSON.stringify(
          reports.flatMap((report) => report.issues.map((issue) => ({ viewport: report.name, ...issue }))),
          null,
          2
        )
      );
      process.exitCode = 1;
    }
  } finally {
    await browser.close().catch(() => {});
    await stopServer(server);
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
