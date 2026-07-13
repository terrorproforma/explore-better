import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `interaction-resize-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "interaction-resize-latest.json");
const latestMdPath = path.join(artifactsDir, "interaction-resize-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_INTERACTION_RESIZE_KEEP_FIXTURE === "1";
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_INTERACTION_BROWSER || "") ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
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
  const childFolder = path.join(fixture, "open-me");
  await fs.mkdir(childFolder, { recursive: true });
  await fs.writeFile(path.join(childFolder, "inside.txt"), "opened after resize\n", "utf8");
  await fs.writeFile(path.join(fixture, "root-file.txt"), "root\n", "utf8");
  await fs.mkdir(appData, { recursive: true });
}

async function dragHandle(page, selector, deltaX, deltaY) {
  const handle = page.locator(selector);
  const count = await handle.count();
  assert(count === 1, `Expected one ${selector} handle, found ${count}.`);
  await handle.waitFor({ state: "visible", timeout: 5000 });
  const box = await handle.boundingBox();
  assert(box && box.width > 0 && box.height > 0, `${selector} handle should have a visible box.`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX / 2, startY + deltaY / 2, { steps: 6 });
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(350);
}

async function readGeometry(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      const box = element?.getBoundingClientRect?.();
      return box
        ? {
            x: Math.round(box.x * 10) / 10,
            y: Math.round(box.y * 10) / 10,
            width: Math.round(box.width * 10) / 10,
            height: Math.round(box.height * 10) / 10,
            right: Math.round(box.right * 10) / 10,
            bottom: Math.round(box.bottom * 10) / 10
          }
        : null;
    };
    const actionStrip = document.querySelector(".dock-action-strip");
    const actionStripRect = actionStrip?.getBoundingClientRect?.();
    const visibleActions = [...document.querySelectorAll(".dock-action-strip > button:not([hidden]), .saved-command-strip > button:not([hidden])")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          actionStripRect &&
          box.bottom > actionStripRect.top + 1 &&
          box.top < actionStripRect.bottom - 1
        );
      });
    const visibleActionRows = new Set(visibleActions.map((element) => Math.round(element.getBoundingClientRect().top)));
    const style = getComputedStyle(document.querySelector(".app-shell"));
    const status = (selector) => {
      const element = document.querySelector(selector);
      const box = element?.getBoundingClientRect?.();
      return element && box
        ? {
            text: element.innerText.trim().replace(/\s+/g, " "),
            title: element.getAttribute("title") || "",
            aria: element.getAttribute("aria-label") || "",
            active: element.classList.contains("active"),
            x: Math.round(box.x * 10) / 10,
            right: Math.round(box.right * 10) / 10,
            width: Math.round(box.width * 10) / 10
          }
        : null;
    };
    const dockContext = document.querySelector(".dock-context");
    const dockContextBox = dockContext?.getBoundingClientRect?.();
    return {
      layoutClass: document.querySelector(".workbench")?.className || "",
      activePath: document.querySelector('[data-path-input="left"]')?.value || "",
      nav: rect(".nav-rail"),
      leftPane: rect('.pane[data-pane="left"]'),
      rightPane: rect('.pane[data-pane="right"]'),
      inspector: rect(".inspector"),
      dock: rect(".command-dock"),
      dockContext: rect(".dock-context"),
      dockActions: rect(".dock-action-strip"),
      dockModes: rect(".dock-mode-strip"),
      visibleDockActions: visibleActions.length,
      visibleDockActionRows: visibleActionRows.size,
      dockStatus: {
        selection: status("#selection-readout"),
        clipboard: status("#clipboard-readout"),
        operations: status("#operation-readout"),
        contained:
          Boolean(dockContextBox) &&
          [...document.querySelectorAll(".dock-context > *")].every((element) => {
            const box = element.getBoundingClientRect();
            return box.left >= dockContextBox.left - 0.75 && box.right <= dockContextBox.right + 0.75;
          })
      },
      leftList: rect('.pane[data-pane="left"] .file-list'),
      vars: {
        navWidth: style.getPropertyValue("--nav-width").trim(),
        inspectorWidth: style.getPropertyValue("--inspector-width").trim(),
        leftPane: style.getPropertyValue("--left-pane-fr").trim(),
        rightPane: style.getPropertyValue("--right-pane-fr").trim(),
        topPane: style.getPropertyValue("--top-pane-fr").trim(),
        bottomPane: style.getPropertyValue("--bottom-pane-fr").trim(),
        dockHeight: style.getPropertyValue("--user-dock-height").trim()
      }
    };
  });
}

async function waitForState(baseUrl, predicate, label) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started < 7000) {
    lastState = await requestJson(baseUrl, "/api/state");
    if (predicate(lastState)) {
      return lastState;
    }
    await new Promise((resolve) => setTimeout(resolve, 140));
  }
  throw new Error(`Timed out waiting for state: ${label}. Last state: ${JSON.stringify(lastState?.settings?.layoutSizes)}`);
}

async function clickLayout(page, mode) {
  const button = page.locator(`[data-layout-mode="${mode}"]`);
  const count = await button.count();
  assert(count === 1, `Expected one ${mode} layout button, found ${count}.`);
  await button.click();
  await page.waitForFunction(
    (layoutMode) => document.querySelector(".workbench")?.classList.contains(`layout-${layoutMode}`),
    mode,
    { timeout: 5000 }
  );
}

async function verifyDoubleClick(page) {
  const targetPath = path.join(fixture, "open-me");
  const row = page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: "open-me" });
  const count = await row.count();
  assert(count === 1, `Expected one open-me folder row, found ${count}.`);
  await row.waitFor({ state: "visible", timeout: 5000 });
  await row.dblclick();
  await page.waitForFunction(
    (expectedPath) => document.querySelector('[data-path-input="left"]')?.value === expectedPath,
    targetPath,
    { timeout: 5000 }
  );
  const insideCount = await page
    .locator('.pane[data-pane="left"] [data-entry-path]')
    .filter({ hasText: "inside.txt" })
    .count();
  assert(insideCount === 1, "Double-click should open open-me and show inside.txt.");
  return {
    targetPath,
    insideVisible: true
  };
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 54500 + Math.floor(Math.random() * 9000)));
  const baseUrl = `http://127.0.0.1:${port}`;
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

  const browser = await chromium.launch({ executablePath: edgePath(), headless: true });
  try {
    await waitForServer(baseUrl, server, () => serverOutput);
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    const url = `${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await clickLayout(page, "vertical");
    const initial = await readGeometry(page);
    const initialState = await requestJson(baseUrl, "/api/state");
    assert(initial.visibleDockActionRows === 1, `Compact dock should expose one action row, found ${initial.visibleDockActionRows}.`);
    assert(initial.dockContext.width <= 232, `Compact status area should stay at or below 232px, found ${initial.dockContext.width}px.`);
    assert(initial.dockActions.width >= 600, `Command area should retain at least 600px, found ${initial.dockActions.width}px.`);
    assert(initial.dockStatus.contained, "Every compact status control should remain inside the status area.");
    assert(initial.dockStatus.selection.aria.includes("pane"), "Selection status should expose its pane in the accessible label.");
    assert(initial.dockStatus.clipboard.aria.includes("Clipboard"), "Clipboard status should expose full accessible detail.");
    assert(initial.dockStatus.operations.aria.includes("Activate to open operations"), "Operations status should describe its action.");

    const rootFile = page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: "root-file.txt" });
    assert((await rootFile.count()) === 1, "Expected one root-file.txt row for compact status testing.");
    await rootFile.click();
    await page.waitForFunction(() => document.querySelector("#selection-readout")?.classList.contains("active"));
    const selectedStatus = await readGeometry(page);
    assert(selectedStatus.inspector.width >= 180, `Selecting a file should restore Preview, found ${selectedStatus.inspector.width}px.`);
    assert(selectedStatus.dockStatus.selection.text.includes("1 selected"), `Selection status should compactly show one selected item: ${selectedStatus.dockStatus.selection.text}`);
    assert(selectedStatus.dockStatus.selection.aria.includes("1 selected"), "Selection status accessible detail should report the selected count.");
    assert(selectedStatus.dockStatus.selection.title.includes(fixture), "Selection status title should retain the full active path.");
    await rootFile.press("Control+C");
    await page.waitForFunction(() => document.querySelector("#clipboard-readout")?.classList.contains("active"));
    const clipboardStatus = await readGeometry(page);
    assert(clipboardStatus.dockStatus.clipboard.text === "Copy 1", `Clipboard status should compactly show Copy 1: ${clipboardStatus.dockStatus.clipboard.text}`);
    assert(clipboardStatus.dockStatus.clipboard.aria.includes("root-file.txt"), "Clipboard accessible detail should name the copied file.");
    assert(clipboardStatus.dockStatus.contained, "Active compact status controls should remain contained.");
    await page.locator("#selection-readout").click();
    assert(
      await page.evaluate(() => document.activeElement?.matches?.('.file-list[data-list="left"]')),
      "Selection status should focus the active pane list."
    );
    await page.locator("#operation-readout").click();
    await page.locator("#ops-dialog[open]").waitFor({ state: "visible", timeout: 5000 });
    await page.locator('[data-close-dialog="ops-dialog"]').click();

    await dragHandle(page, '[data-layout-resize="nav"]', 72, 0);
    const afterNav = await readGeometry(page);
    assert(afterNav.nav.width >= initial.nav.width + 45, `Navigator width did not grow enough: ${initial.nav.width} -> ${afterNav.nav.width}.`);
    const navState = await waitForState(
      baseUrl,
      (state) => state.settings?.layoutSizes?.navWidth >= (initialState.settings?.layoutSizes?.navWidth || 236) + 45,
      "nav resize persisted"
    );

    await dragHandle(page, '[data-layout-resize="panes"]', 96, 0);
    const afterPanes = await readGeometry(page);
    assert(afterPanes.leftPane.width >= afterNav.leftPane.width + 45, `Left pane width did not grow enough: ${afterNav.leftPane.width} -> ${afterPanes.leftPane.width}.`);
    assert(afterPanes.rightPane.width <= afterNav.rightPane.width - 25, `Right pane width did not shrink enough: ${afterNav.rightPane.width} -> ${afterPanes.rightPane.width}.`);
    const paneState = await waitForState(
      baseUrl,
      (state) => state.settings?.layoutSizes?.leftPaneWeight > state.settings?.layoutSizes?.rightPaneWeight,
      "pane split persisted"
    );

    await dragHandle(page, '[data-layout-resize="inspector"]', -76, 0);
    const afterInspector = await readGeometry(page);
    assert(
      afterInspector.inspector.width >= afterPanes.inspector.width + 40,
      `Inspector width did not grow enough: ${afterPanes.inspector.width} -> ${afterInspector.inspector.width}.`
    );
    const inspectorState = await waitForState(
      baseUrl,
      (state) => state.settings?.layoutSizes?.inspectorWidth >= (initialState.settings?.layoutSizes?.inspectorWidth || 300) + 40,
      "preview resize persisted"
    );

    await dragHandle(page, '[data-layout-resize="dock"]', 0, -56);
    const afterDock = await readGeometry(page);
    assert(afterDock.dock.height >= initial.dock.height + 35, `Dock height did not grow enough: ${initial.dock.height} -> ${afterDock.dock.height}.`);
    const dockState = await waitForState(
      baseUrl,
      (state) => state.settings?.layoutSizes?.dockHeight >= (initialState.settings?.layoutSizes?.dockHeight || 44) + 35,
      "dock resize persisted"
    );

    await dragHandle(page, '[data-layout-resize="dock"]', 0, -92);
    const afterTallDock = await readGeometry(page);
    assert(afterTallDock.dock.height >= 160, `Dock should resize past the old 140px ceiling: ${afterTallDock.dock.height}.`);
    assert(
      afterTallDock.visibleDockActionRows >= 3,
      `Tall dock should reveal at least three wrapped action rows, found ${afterTallDock.visibleDockActionRows}.`
    );
    assert(
      afterTallDock.visibleDockActionRows > initial.visibleDockActionRows,
      `Tall dock should reveal more action rows: ${initial.visibleDockActionRows} -> ${afterTallDock.visibleDockActionRows}.`
    );
    for (const [label, zone] of [
      ["context", afterTallDock.dockContext],
      ["actions", afterTallDock.dockActions],
      ["modes", afterTallDock.dockModes]
    ]) {
      assert(zone && zone.width >= 80 && zone.height >= 30, `Dock ${label} zone should remain reachable after resize.`);
      assert(zone.y >= afterTallDock.dock.y - 1 && zone.bottom <= afterTallDock.dock.bottom + 1, `Dock ${label} zone escaped the dock.`);
    }
    const tallDockState = await waitForState(
      baseUrl,
      (state) => state.settings?.layoutSizes?.dockHeight >= 160,
      "tall dock resize persisted"
    );

    await clickLayout(page, "horizontal");
    const beforeRows = await readGeometry(page);
    await dragHandle(page, '[data-layout-resize="paneRows"]', 0, 86);
    const afterRows = await readGeometry(page);
    assert(afterRows.leftPane.height >= beforeRows.leftPane.height + 35, `Top pane row did not grow enough: ${beforeRows.leftPane.height} -> ${afterRows.leftPane.height}.`);
    assert(afterRows.leftList.height >= 36, `Left file list should remain clickable after row resize; height=${afterRows.leftList.height}.`);
    const rowState = await waitForState(
      baseUrl,
      (state) => state.settings?.layoutSizes?.topPaneWeight > state.settings?.layoutSizes?.bottomPaneWeight,
      "horizontal row resize persisted"
    );

    const doubleClick = await verifyDoubleClick(page);
    await waitForState(baseUrl, (state) => state.layout?.paneLayout === "horizontal", "horizontal layout persisted");
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    const afterReload = await readGeometry(page);
    const reloadState = await requestJson(baseUrl, "/api/state");
    assert(afterReload.layoutClass.includes("layout-horizontal"), `Reload should restore horizontal layout: ${afterReload.layoutClass}.`);
    assert(afterReload.nav.width >= initial.nav.width + 35, "Reload should keep resized navigator width.");
    assert(afterReload.dock.height >= 160, "Reload should keep tall resized dock height.");
    assert(reloadState.settings?.layoutSizes?.dockHeight === tallDockState.settings.layoutSizes.dockHeight, "Reloaded state should keep dock height exactly.");

    const report = {
      generatedAt: new Date().toISOString(),
      fixture,
      appData,
      url,
      initial,
      afterNav,
      afterPanes,
      afterInspector,
      afterDock,
      afterTallDock,
      beforeRows,
      afterRows,
      afterReload,
      persisted: {
        nav: navState.settings.layoutSizes,
        panes: paneState.settings.layoutSizes,
        inspector: inspectorState.settings.layoutSizes,
        dock: dockState.settings.layoutSizes,
        tallDock: tallDockState.settings.layoutSizes,
        rows: rowState.settings.layoutSizes,
        reload: reloadState.settings.layoutSizes
      },
      interactions: {
        verticalLayoutButton: true,
        horizontalLayoutButton: true,
        navResize: true,
        paneResize: true,
        inspectorResize: true,
        dockResize: true,
        dockWrappedRows: afterTallDock.visibleDockActionRows,
        compactStatusContained: clipboardStatus.dockStatus.contained,
        compactStatusSelection: selectedStatus.dockStatus.selection,
        compactStatusClipboard: clipboardStatus.dockStatus.clipboard,
        dockSelectionFocus: true,
        dockOperationsOpen: true,
        paneRowResize: true,
        doubleClickFolder: doubleClick
      }
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(
      latestMdPath,
      `# Explore Better Interaction Resize Smoke

Generated: ${report.generatedAt}

Summary: resized navigator, pane split, preview, command dock, and horizontal pane rows in a real browser, then reloaded and verified persisted layout settings.

Verified:
- Navigator drag changed width from ${initial.nav.width}px to ${afterNav.nav.width}px.
- Pane splitter changed left/right widths from ${initial.leftPane.width}px/${initial.rightPane.width}px to ${afterPanes.leftPane.width}px/${afterPanes.rightPane.width}px.
- Preview drag changed width from ${initial.inspector.width}px to ${afterInspector.inspector.width}px.
- Command dock drag changed height from ${initial.dock.height}px to ${afterDock.dock.height}px, then revealed ${afterTallDock.visibleDockActionRows} wrapped action rows at ${afterTallDock.dock.height}px while keeping context and modes anchored.
- Compact status controls used ${initial.dockContext.width}px, left ${initial.dockActions.width}px for commands, stayed contained, and exposed full selection/clipboard/operations detail to assistive technology.
- Selecting and copying \`root-file.txt\` changed the visible statuses to \`${selectedStatus.dockStatus.selection.text}\` and \`${clipboardStatus.dockStatus.clipboard.text}\`.
- Dock status controls focused the active file list and opened Operations recovery.
- Horizontal pane row drag kept the left file list clickable at ${afterRows.leftList.height}px.
- Double-click opened \`${doubleClick.targetPath}\` and showed \`inside.txt\`.
- Reload restored horizontal layout and resized geometry from persisted state.

Artifacts:
- JSON: \`${latestJsonPath}\`
- Fixture: \`${fixture}\`
`,
      "utf8"
    );
    console.log(`nav width: ${initial.nav.width} -> ${afterNav.nav.width}`);
    console.log(`pane widths: ${initial.leftPane.width}/${initial.rightPane.width} -> ${afterPanes.leftPane.width}/${afterPanes.rightPane.width}`);
    console.log(`preview width: ${initial.inspector.width} -> ${afterInspector.inspector.width}`);
    console.log(`dock height: ${initial.dock.height} -> ${afterDock.dock.height} -> ${afterTallDock.dock.height}`);
    console.log(`dock action rows: ${initial.visibleDockActionRows} -> ${afterTallDock.visibleDockActionRows}`);
    console.log(`row list height: ${afterRows.leftList.height}`);
    console.log("double-click ok");
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
  } finally {
    await browser.close().catch(() => {});
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
