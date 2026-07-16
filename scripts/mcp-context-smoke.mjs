import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright-core";
import { assert, startElectronMcp, waitFor } from "./mcp-smoke-helpers.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const build = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", "build-app.mjs")], {
  cwd: process.cwd(),
  encoding: "utf8",
  windowsHide: true
});
assert(build.status === 0, `Renderer build failed before MCP context verification: ${build.stderr || build.stdout}`);

const debugPort = await freePort();
let browser = null;
let harness = null;
try {
  harness = await startElectronMcp({
    visible: true,
    electronArgs: [`--remote-debugging-port=${debugPort}`],
    beforeSidecar: async ({ logs }) => {
      await waitFor(async () => {
        try {
          const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
          if (!targets.ok) return false;
          const pages = await targets.json();
          return pages.some((target) => target.type === "page" && target.url?.startsWith("http://127.0.0.1"));
        } catch {
          return false;
        }
      }, 30_000, 150);
      try {
        const versionResponse = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        const version = await versionResponse.json();
        assert(versionResponse.ok && version.webSocketDebuggerUrl, "Electron CDP version endpoint did not expose a WebSocket URL.");
        await new Promise((resolve) => setTimeout(resolve, 500));
        let connectedBrowser = null;
        let connectError = null;
        for (let attempt = 0; attempt < 2 && !connectedBrowser; attempt += 1) {
          try {
            connectedBrowser = await chromium.connectOverCDP(version.webSocketDebuggerUrl, { timeout: 45_000 });
          } catch (error) {
            connectError = error;
            if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 750));
          }
        }
        if (!connectedBrowser) throw connectError || new Error("Electron CDP connection did not return a browser.");
        const connectedPage = await waitFor(() => {
          return connectedBrowser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith("http://127.0.0.1")) || null;
        }, 30_000, 150);
        await connectedPage.waitForFunction(() => Boolean(window.__exploreBetterStartup), null, { timeout: 30_000 });
        return { browser: connectedBrowser, page: connectedPage };
      } catch (error) {
        throw new Error(`Electron CDP connection failed before MCP sidecar startup. ${error.message}\n${logs()}`);
      }
    }
  });
  browser = harness.beforeSidecarResult.browser;
  const page = harness.beforeSidecarResult.page;

  const tools = await harness.call("tools/list", {});
  const exposedNames = tools.result?.tools?.map((tool) => tool.name).sort() || [];
  const permittedNames = [...harness.profile.tools].sort();
  assert(JSON.stringify(exposedNames) === JSON.stringify(permittedNames), "Desktop MCP sidecar tool discovery did not match the active profile.");
  assert(!exposedNames.includes("apply_operation") && !exposedNames.includes("plan_create"), "Read-only MCP discovery exposed write tools.");
  const live = await waitFor(async () => {
    const response = await harness.call("tools/call", { name: "get_context", arguments: {} });
    return response.result?.structuredContent?.data?.live ? response : null;
  }, 30_000, 250);
  assert(live.result.structuredContent.data.panes.left.tabs[0].id, "Live context is missing stable tab IDs.");
  const openedOperations = await harness.call("tools/call", {
    name: "set_ui_view",
    arguments: { view: "operations", visible: true }
  });
  assert(!openedOperations.result?.isError, `MCP could not open Operations: ${JSON.stringify(openedOperations.result)}`);
  const operationsContext = await waitFor(async () => {
    const response = await harness.call("tools/call", { name: "get_context", arguments: {} });
    return response.result?.structuredContent?.data?.ui?.openDialogs?.some((item) => item.id === "ops-dialog") ? response : null;
  }, 15_000, 200);
  assert(operationsContext.result.structuredContent.data.ui.openDialogs.find((item) => item.id === "ops-dialog")?.title === "Operations", "MCP-opened Operations view was not observable through get_context.");
  const closedOperations = await harness.call("tools/call", {
    name: "set_ui_view",
    arguments: { view: "operations", visible: false }
  });
  assert(!closedOperations.result?.isError, `MCP could not close Operations: ${JSON.stringify(closedOperations.result)}`);
  await waitFor(async () => {
    const response = await harness.call("tools/call", { name: "get_context", arguments: {} });
    return response.result?.structuredContent?.data?.ui?.openDialogs?.some((item) => item.id === "ops-dialog") ? null : response;
  }, 15_000, 200);
  const openedCollections = await harness.call("tools/call", {
    name: "set_ui_view",
    arguments: { view: "collections", visible: true, pane: "left" }
  });
  assert(!openedCollections.result?.isError, `MCP could not open Collections: ${JSON.stringify(openedCollections.result)}`);
  const collectionsContext = await waitFor(async () => {
    const response = await harness.call("tools/call", { name: "get_context", arguments: {} });
    return response.result?.structuredContent?.data?.ui?.openDialogs?.some((item) => item.id === "collections-dialog") ? response : null;
  }, 15_000, 200);
  const collectionsDialog = collectionsContext.result.structuredContent.data.ui.openDialogs.find(
    (item) => item.id === "collections-dialog"
  );
  assert(collectionsDialog?.title === "Collections", "MCP-opened Collections view was not observable through get_context.");
  assert(
    collectionsDialog.controls.some((item) => item.label === "Add Selection"),
    "Collections controls were not visible through MCP context."
  );
  const closedCollections = await harness.call("tools/call", {
    name: "set_ui_view",
    arguments: { view: "collections", visible: false, pane: "left" }
  });
  assert(!closedCollections.result?.isError, `MCP could not close Collections: ${JSON.stringify(closedCollections.result)}`);
  const attributesWithoutSelection = await harness.call("tools/call", {
    name: "set_ui_view",
    arguments: { view: "attributes", visible: true, pane: "left" }
  });
  assert(
    attributesWithoutSelection.result?.isError && JSON.stringify(attributesWithoutSelection.result).includes("UI_PRECONDITION"),
    `MCP view control did not report its missing-selection precondition: ${JSON.stringify(attributesWithoutSelection.result)}`
  );
  const openedSearch = await harness.call("tools/call", {
    name: "set_ui_view",
    arguments: { view: "search", visible: true }
  });
  assert(!openedSearch.result?.isError, `MCP could not open Search: ${JSON.stringify(openedSearch.result)}`);
  const blockedBySearch = await harness.call("tools/call", {
    name: "set_ui_view",
    arguments: { view: "operations", visible: true }
  });
  assert(
    blockedBySearch.result?.isError && JSON.stringify(blockedBySearch.result).includes("UI_BLOCKED"),
    `MCP view control did not reject a conflicting modal dialog: ${JSON.stringify(blockedBySearch.result)}`
  );
  const closedSearch = await harness.call("tools/call", {
    name: "set_ui_view",
    arguments: { view: "search", visible: false }
  });
  assert(!closedSearch.result?.isError, `MCP could not close Search: ${JSON.stringify(closedSearch.result)}`);
  await page.evaluate(() => {
    const prompt = document.getElementById("default-explorer-dialog");
    if (prompt?.open) prompt.querySelector('[data-default-explorer-choice="keep"]')?.click();
    document.querySelector('[data-topbar-action="palette"]')?.click();
  });
  await page.waitForFunction(() => document.getElementById("command-dialog")?.open === true, null, { timeout: 15_000 });
  const visibleDialog = await waitFor(async () => {
    const response = await harness.call("tools/call", { name: "get_context", arguments: {} });
    const dialog = response.result?.structuredContent?.data?.ui?.openDialogs?.find((item) => item.id === "command-dialog");
    return dialog ? response : null;
  }, 15_000, 200);
  const visibleUi = visibleDialog.result.structuredContent.data.ui;
  const commandDialog = visibleUi.openDialogs.find((item) => item.id === "command-dialog");
  assert(commandDialog.title === "Command Center", "MCP UI context did not expose the visible dialog title.");
  assert(commandDialog.controls.some((control) => control.id === "command-input"), "MCP UI context did not expose bounded dialog controls.");
  assert(visibleUi.lastInteraction?.action === "data-topbar-action" && visibleUi.lastInteraction?.actionValue === "palette", "MCP UI context did not report the user's Command Center interaction.");
  const navigatorSectionIds = visibleUi.navigator.sections.map((section) => section.id);
  assert(navigatorSectionIds.indexOf("folder-tree-title") < navigatorSectionIds.indexOf("nav-drives-title"), "MCP Navigator context did not preserve visible section order.");
  assert(!navigatorSectionIds.includes("nav-shell-title"), "MCP Navigator context still exposes the removed duplicate Shell section.");
  assert(visibleUi.navigator.sections.find((section) => section.id === "folder-tree-title")?.title === "Folder Tree", "MCP Navigator context mixed Folder Tree actions into its title.");
  assert(visibleUi.navigator.scroll?.overflowY === "auto", "MCP Navigator context did not identify the rail as the vertical scroll owner.");
  assert(visibleUi.navigator.sections.find((section) => section.id === "folder-tree-title")?.scroll?.overflowY === "visible", "MCP Navigator context reported a nested Folder Tree scrollbar.");
  assert(visibleUi.navigator.sections.find((section) => section.id === "nav-recents-title")?.scroll?.overflowY === "visible", "MCP Navigator context reported a nested Recent scrollbar.");
  assert(
    Number.isInteger(visibleUi.navigator.folderTree?.renderedNodes) && visibleUi.navigator.folderTree.renderedNodes >= 0,
    `MCP Navigator context did not expose bounded Folder Tree state: ${JSON.stringify(visibleUi.navigator)}`
  );
  assert(visibleUi.navigator.folderTree.errorCount === 0 && Array.isArray(visibleUi.navigator.folderTree.messages), "MCP Navigator context exposed invalid Folder Tree error/message state.");
  assert(visibleUi.terminals.length === 2 && visibleUi.terminals.every((terminal) => terminal.visible === false), "MCP terminal context did not report the high-level closed state.");
  await page.evaluate(() => document.getElementById("command-dialog")?.close());
  await waitFor(async () => {
    const response = await harness.call("tools/call", { name: "get_context", arguments: {} });
    return response.result?.structuredContent?.data?.ui?.openDialogs?.some((item) => item.id === "command-dialog") ? null : response;
  }, 15_000, 200);
  await page.evaluate(() => document.querySelector('[data-topbar-action="palette"]')?.click());
  await page.locator("#command-input").fill("Open Devices & Windows locations");
  const windowsLocationsCommand = page.locator(".command-item").filter({ hasText: "Open Devices & Windows locations" }).first();
  await windowsLocationsCommand.waitFor({ state: "visible", timeout: 15_000 });
  await windowsLocationsCommand.click();
  await page.waitForFunction(() => document.getElementById("devices-dialog")?.open === true, null, { timeout: 15_000 });
  await page.waitForFunction(() => !/^Checking connected devices/.test(document.getElementById("devices-summary")?.textContent || ""), null, { timeout: 20_000 });
  const windowsLocationsUi = await page.evaluate(() => ({
    title: document.querySelector("#devices-dialog .dialog-head strong")?.textContent?.trim(),
    networkLoaded: document.getElementById("devices-load-network")?.textContent?.includes("loaded") === true,
    rowActions: [...document.querySelectorAll("#devices-groups .device-card-actions button")].map((button) => button.textContent.trim())
  }));
  assert(windowsLocationsUi.title === "Devices & Windows locations", "The device dashboard uses an unexpected title.");
  assert(windowsLocationsUi.networkLoaded === false, "The device dashboard probed the Network provider during initial loading.");
  assert(!windowsLocationsUi.rowActions.some((label) => ["Browse", "Pane", "Open"].includes(label)), "The device dashboard exposes ambiguous row actions.");
  const windowsLocationsContext = await waitFor(async () => {
    const response = await harness.call("tools/call", { name: "get_context", arguments: {} });
    return response.result?.structuredContent?.data?.ui?.openDialogs?.some((item) => item.id === "devices-dialog") ? response : null;
  }, 15_000, 200);
  assert(windowsLocationsContext.result.structuredContent.data.ui.openDialogs.find((item) => item.id === "devices-dialog")?.title === "Devices & Windows locations", "MCP did not expose the Devices dashboard.");
  await page.evaluate(() => document.getElementById("devices-dialog")?.close());
  await page.locator('[data-path-input="left"]').press("Control+a");
  const pathInteractionContext = await waitFor(async () => {
    const response = await harness.call("tools/call", { name: "get_context", arguments: {} });
    const interaction = response.result?.structuredContent?.data?.ui?.lastInteraction;
    return interaction?.action === "data-path-input" ? response : null;
  }, 15_000, 200);
  assert(
    pathInteractionContext.result.structuredContent.data.ui.lastInteraction.actionValue === "left",
    "MCP path-input interaction did not preserve its safe pane identifier."
  );
  const child = path.join(harness.fixture, "child");
  await fs.mkdir(child);
  const shown = await harness.call("tools/call", { name: "show_in_explore_better", arguments: { path: child, pane: "left", mode: "newTab" } });
  assert(!shown.result?.isError, `Desktop UI action failed: ${JSON.stringify(shown.result)}`);
  const navigated = await waitFor(async () => {
    const response = await harness.call("tools/call", { name: "get_context", arguments: {} });
    return response.result?.structuredContent?.data?.panes?.left?.path === child ? response : null;
  }, 15_000, 200);
  assert(navigated.result.structuredContent.data.panes.left.tabs.length >= 2, "New-tab AI navigation did not preserve the original tab.");
  const official = spawnSync("go", ["run", "./cmd/conformance", "--sidecar", path.join(process.cwd(), "native", "bin", "ExploreBetterMcp.exe"), "--profile", harness.profile.id, "--manifest", harness.manifest, "--expected-tools", String(harness.profile.tools.length)], {
    cwd: path.join(process.cwd(), "native", "mcpserver"),
    env: harness.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000
  });
  assert(official.status === 0, `Official Go SDK client conformance failed: ${official.stderr || official.stdout}`);
  assert(JSON.parse(official.stdout.trim()).tools === harness.profile.tools.length, "Official Go SDK client returned a tool list that differs from the active profile.");
  console.log("MCP context smoke passed: live UI state, MCP view open/close, dialog controls, interactions, simplified Navigator, Windows locations UX, authorized navigation, and official Go SDK client conformance.");
} finally {
  await browser?.close().catch(() => {});
  await harness?.close();
}
