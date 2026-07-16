import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import { assert, startElectronMcp, waitFor } from "./mcp-smoke-helpers.mjs";

const root = process.cwd();
const artifacts = path.join(root, "artifacts");
const contractPath = path.join(root, "mcp", "contracts-v1.json");
const outputJson = path.join(artifacts, "mcp-ui-views-latest.json");
const outputMarkdown = path.join(artifacts, "mcp-ui-views-latest.md");

const expectedDialogs = {
  operations: "ops-dialog",
  appTrash: "trash-dialog",
  windowsRecycleBin: "trash-dialog",
  search: "search-dialog",
  indexManager: "speed-dialog",
  diskUsage: "size-analysis-dialog",
  duplicates: "duplicates-dialog",
  compare: "compare-dialog",
  flat: "flat-dialog",
  viewer: "viewer-dialog",
  editor: "text-editor-dialog",
  properties: "properties-dialog",
  checksums: "checksums-dialog",
  collections: "collections-dialog",
  labels: "labels-dialog",
  filters: "filters-dialog",
  selectionSets: "selection-sets-dialog",
  basket: "basket-dialog",
  layouts: "layouts-dialog",
  tabGroups: "tab-groups-dialog",
  aliases: "aliases-dialog",
  snapshots: "snapshots-dialog",
  columns: "columns-dialog",
  formats: "formats-dialog",
  toolbar: "toolbar-dialog",
  hotkeys: "hotkeys-dialog",
  backup: "backup-dialog",
  tools: "tools-dialog",
  scripts: "script-dialog",
  attributes: "attributes-dialog",
  timestamps: "timestamps-dialog",
  openWith: "open-with-dialog",
  shellVerbs: "shell-verbs-dialog",
  transfer: "transfer-dialog",
  destination: "destination-dialog",
  archive: "archive-dialog",
  bulkRename: "bulk-dialog",
  integration: "integration-dialog",
  preferences: "preferences-dialog",
  commandCenter: "command-dialog",
  manual: "manual-dialog",
  devices: "devices-dialog",
  health: "health-dialog"
};

const requiresSelection = ["editor", "attributes", "timestamps", "transfer", "destination", "archive", "bulkRename"];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!port) throw new Error("Windows did not assign an MCP UI verification port.");
  return port;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function errorCode(response) {
  const serialized = JSON.stringify(response?.result || response || {});
  return serialized.match(/\b(UI_[A-Z_]+|INVALID_REQUEST|UI_UNAVAILABLE)\b/)?.[1] || "";
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  const setUiView = contract.tools.find((tool) => tool.name === "set_ui_view");
  const contractViews = setUiView?.inputSchema?.properties?.view?.enum || [];
  assert(contractViews.length > 0, "The MCP contract does not expose set_ui_view values.");
  assert(
    JSON.stringify([...contractViews].sort()) === JSON.stringify(Object.keys(expectedDialogs).sort()),
    "The MCP UI runtime matrix does not exactly match the contract view catalog."
  );

  const debugPort = await freePort();
  let browser = null;
  let harness = null;
  const pageErrors = [];
  const consoleErrors = [];
  const results = [];
  const preconditions = [];
  const preferenceDetailsVisibility = { collapsed: false, expanded: false, recollapsed: false };
  try {
    harness = await startElectronMcp({
      visible: true,
      electronArgs: [`--remote-debugging-port=${debugPort}`],
      prepareFixture: async (fixture) => {
        await fs.writeFile(path.join(fixture, "second.md"), "# Second previewable file\n", "utf8");
        await fs.mkdir(path.join(fixture, "folder"), { recursive: true });
        await fs.writeFile(path.join(fixture, "folder", "nested.txt"), "nested\n", "utf8");
      },
      beforeSidecar: async ({ logs }) => {
        await waitFor(async () => {
          try {
            const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
            if (!response.ok) return false;
            const targets = await response.json();
            return targets.some((target) => target.type === "page" && target.url?.startsWith("http://127.0.0.1"));
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
          const page = await waitFor(
            () => connectedBrowser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith("http://127.0.0.1")) || null,
            30_000,
            150
          );
          await page.waitForFunction(() => Boolean(window.__exploreBetterStartup), null, { timeout: 30_000 });
          await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 30_000 });
          await page.evaluate(() => {
            const prompt = document.getElementById("default-explorer-dialog");
            if (prompt?.open) prompt.querySelector('[data-default-explorer-choice="keep"]')?.click();
          });
          return { browser: connectedBrowser, page };
        } catch (error) {
          throw new Error(`Electron CDP setup failed before the MCP sidecar started. ${error.message}\n${logs()}`);
        }
      }
    });
    browser = harness.beforeSidecarResult.browser;
    const page = harness.beforeSidecarResult.page;
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    const callTool = (name, args = {}) => harness.call("tools/call", { name, arguments: args });
    const getContext = () => callTool("get_context", {});
    const waitForDialog = (dialogId, visible) =>
      waitFor(async () => {
        const response = await getContext();
        const dialogs = response.result?.structuredContent?.data?.ui?.openDialogs || [];
        const dialog = dialogs.find((item) => item.id === dialogId);
        return visible ? (dialog ? { response, dialog } : null) : (!dialog ? { response, dialog: null } : null);
      }, 15_000, 100);

    const initialContext = await getContext();
    assert((initialContext.result?.structuredContent?.data?.selection || []).length === 0, "MCP UI matrix did not start with an empty selection.");
    for (const view of requiresSelection) {
      const response = await callTool("set_ui_view", { view, visible: true, pane: "left" });
      const code = errorCode(response);
      preconditions.push({ view, code, rejected: response.result?.isError === true });
      assert(response.result?.isError === true && code === "UI_PRECONDITION", `${view} did not return UI_PRECONDITION without a selection: ${JSON.stringify(response.result)}`);
      assert(!(await page.locator(`#${expectedDialogs[view]}[open]`).count()), `${view} left its dialog open after a rejected precondition.`);
    }

    const helloPath = path.join(harness.fixture, "hello.txt");
    const shown = await callTool("show_in_explore_better", {
      path: harness.fixture,
      pane: "left",
      mode: "replace",
      select: helloPath
    });
    assert(!shown.result?.isError, `MCP could not establish the selected-file test state: ${JSON.stringify(shown.result)}`);
    await waitFor(async () => {
      const response = await getContext();
      return response.result?.structuredContent?.data?.selection?.includes(helloPath) ? response : null;
    }, 15_000, 100);

    for (const view of contractViews) {
      const dialogId = expectedDialogs[view];
      const openStarted = performance.now();
      const opened = await callTool("set_ui_view", { view, visible: true, pane: "left" });
      const openMs = performance.now() - openStarted;
      assert(!opened.result?.isError, `${view} failed to open through MCP: ${JSON.stringify(opened.result)}`);
      assert(opened.result?.structuredContent?.data?.dialogId === dialogId, `${view} returned the wrong dialog ID.`);
      assert(opened.result?.structuredContent?.data?.visible === true, `${view} did not report itself visible after opening.`);
      const observed = await waitForDialog(dialogId, true);
      assert(observed.dialog.title, `${view} exposed a blank dialog title through MCP context.`);
      assert(Array.isArray(observed.dialog.controls) && observed.dialog.controls.length > 0, `${view} exposed no bounded controls through MCP context.`);
      if (view === "preferences") {
        const hiddenPermissionControls = observed.dialog.controls.filter((control) => control.action === "data-ai-tool");
        const permissionsSummary = observed.dialog.controls.find((control) => control.tag === "summary" && control.label.startsWith("Tool permissions"));
        assert(permissionsSummary?.expanded === false, "Preferences did not expose its collapsed Tool permissions summary through MCP context.");
        assert(hiddenPermissionControls.length === 0, `Preferences exposed ${hiddenPermissionControls.length} controls hidden inside collapsed Tool permissions.`);
        assert(/^Tool permissions \d+ enabled \/ \d+ available$/.test(permissionsSummary.label), `Preferences exposed a malformed Tool permissions label: ${permissionsSummary.label}`);
        preferenceDetailsVisibility.collapsed = true;
        await page.locator(".ai-bridge-permissions > summary").click();
        const expandedPreferences = await waitFor(async () => {
          const response = await getContext();
          const dialog = response.result?.structuredContent?.data?.ui?.openDialogs?.find((item) => item.id === dialogId);
          const summary = dialog?.controls?.find((control) => control.tag === "summary" && control.label.startsWith("Tool permissions"));
          const tools = dialog?.controls?.filter((control) => control.action === "data-ai-tool") || [];
          return summary?.expanded === true && tools.length > 0 ? { summary, tools } : null;
        }, 15_000, 100);
        preferenceDetailsVisibility.expanded = expandedPreferences.tools.length === 32;
        assert(preferenceDetailsVisibility.expanded, `Expanded Tool permissions exposed ${expandedPreferences.tools.length}/32 controls through MCP context.`);
        await page.locator(".ai-bridge-permissions > summary").click();
        await waitFor(async () => {
          const response = await getContext();
          const dialog = response.result?.structuredContent?.data?.ui?.openDialogs?.find((item) => item.id === dialogId);
          const summary = dialog?.controls?.find((control) => control.tag === "summary" && control.label.startsWith("Tool permissions"));
          const tools = dialog?.controls?.filter((control) => control.action === "data-ai-tool") || [];
          return summary?.expanded === false && tools.length === 0 ? true : null;
        }, 15_000, 100);
        preferenceDetailsVisibility.recollapsed = true;
      }
      const domState = await page.locator(`#${dialogId}`).evaluate((dialog) => ({
        open: dialog.open === true,
        title: dialog.querySelector(".dialog-head strong, h1, h2")?.textContent?.trim() || "",
        width: Math.round(dialog.getBoundingClientRect().width),
        height: Math.round(dialog.getBoundingClientRect().height)
      }));
      assert(domState.open && domState.width > 0 && domState.height > 0, `${view} was not visibly rendered in Electron.`);

      const closeStarted = performance.now();
      const closed = await callTool("set_ui_view", { view, visible: false, pane: "left" });
      const closeMs = performance.now() - closeStarted;
      assert(!closed.result?.isError, `${view} failed to close through MCP: ${JSON.stringify(closed.result)}`);
      assert(closed.result?.structuredContent?.data?.visible === false, `${view} still reported itself visible after closing.`);
      await waitForDialog(dialogId, false);
      assert(!(await page.locator(`#${dialogId}[open]`).count()), `${view} remained open in Electron after MCP close.`);
      results.push({
        view,
        dialogId,
        title: observed.dialog.title,
        state: observed.dialog.state,
        controls: observed.dialog.controls.length,
        openMs: Number(openMs.toFixed(1)),
        closeMs: Number(closeMs.toFixed(1)),
        width: domState.width,
        height: domState.height
      });
    }

    const repeatOpen = await callTool("set_ui_view", { view: "operations", visible: true, pane: "left" });
    const idempotentOpen = await callTool("set_ui_view", { view: "operations", visible: true, pane: "left" });
    const repeatClose = await callTool("set_ui_view", { view: "operations", visible: false, pane: "left" });
    const idempotentClose = await callTool("set_ui_view", { view: "operations", visible: false, pane: "left" });
    assert(!repeatOpen.result?.isError && !idempotentOpen.result?.isError, "Repeated MCP view open was not idempotent.");
    assert(!repeatClose.result?.isError && !idempotentClose.result?.isError, "Repeated MCP view close was not idempotent.");

    await page.waitForTimeout(500);
    assert(pageErrors.length === 0, `MCP UI view matrix produced page errors: ${pageErrors.join(" | ")}`);
    assert(consoleErrors.length === 0, `MCP UI view matrix produced console errors: ${consoleErrors.join(" | ")}`);
    const openTimes = results.map((item) => item.openMs);
    const closeTimes = results.map((item) => item.closeMs);
    const performanceSummary = {
      openP50Ms: Number(percentile(openTimes, 0.5).toFixed(1)),
      openP95Ms: Number(percentile(openTimes, 0.95).toFixed(1)),
      openMaxMs: Number(Math.max(...openTimes).toFixed(1)),
      closeP95Ms: Number(percentile(closeTimes, 0.95).toFixed(1)),
      slowest: [...results].sort((left, right) => right.openMs - left.openMs).slice(0, 5).map(({ view, openMs }) => ({ view, openMs }))
    };
    assert(performanceSummary.openMaxMs < 10_000, `A named MCP view took ${performanceSummary.openMaxMs} ms to open.`);

    const report = {
      generatedAt: new Date().toISOString(),
      contractViewCount: contractViews.length,
      passed: results.length,
      preconditions,
      idempotence: { open: true, close: true },
      preferenceDetailsVisibility,
      performance: performanceSummary,
      pageErrors,
      consoleErrors,
      results
    };
    await fs.writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const markdown = [
      "# MCP UI View Matrix",
      "",
      `Generated: ${report.generatedAt}`,
      "",
      `Result: ${report.passed}/${report.contractViewCount} named views opened, appeared in live context, rendered in Electron, and closed.`,
      `Selection preconditions: ${preconditions.length}/${preconditions.length} returned UI_PRECONDITION before selection.`,
      `Preferences details visibility: collapsed controls hidden, 32/32 controls visible when expanded, then hidden after recollapse.`,
      `Latency: open p50 ${performanceSummary.openP50Ms} ms, p95 ${performanceSummary.openP95Ms} ms, max ${performanceSummary.openMaxMs} ms; close p95 ${performanceSummary.closeP95Ms} ms.`,
      "",
      "| View | Dialog | MCP title | State | Controls | Open | Close | Size |",
      "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
      ...results.map((item) => `| ${item.view} | ${item.dialogId} | ${item.title.replace(/\|/g, "\\|")} | ${item.state} | ${item.controls} | ${item.openMs} ms | ${item.closeMs} ms | ${item.width} x ${item.height} |`),
      ""
    ].join("\n");
    await fs.writeFile(outputMarkdown, markdown, "utf8");
    console.log(`MCP UI view matrix passed: ${results.length}/${contractViews.length} views, ${preconditions.length} preconditions, open p95=${performanceSummary.openP95Ms} ms.`);
    console.log(`wrote ${outputMarkdown}`);
  } finally {
    await browser?.close().catch(() => {});
    await harness?.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
