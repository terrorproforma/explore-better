import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const root = process.cwd();
const artifacts = path.join(root, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifacts, `preferences-ui-${stamp}`);
const fixture = path.join(runRoot, "Preference Fixture");
const appData = path.join(runRoot, "appdata");
const outputJson = path.join(artifacts, "preferences-ui-latest.json");
const outputMarkdown = path.join(artifacts, "preferences-ui-latest.md");
const screenshotPath = path.join(artifacts, "preferences-ui-latest.png");

function addCheck(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function waitForServer(baseUrl, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    if (child.exitCode !== null) throw new Error(`Server exited early with ${child.exitCode}.`);
    try {
      if ((await fetch(`${baseUrl}/api/roots`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Preferences test server did not become ready.");
}

const desktopMock = `(() => {
  const profile = {
    id: 'profile-1',
    name: 'Test MCP Profile',
    clientType: 'codex',
    access: 'read-only',
    roots: ['C:\\\\Preference Fixture'],
    tools: ['get_context', 'set_ui_view'],
    allowPermanentDelete: false,
    enabled: true
  };
  const state = {
    contexts: [],
    action: null,
    upserts: [],
    configuration: { enabled: true, profiles: [profile] },
    contract: { tools: [
      { name: 'get_context', title: 'Get Context', description: 'Read the live app context.', access: 'read' },
      { name: 'set_ui_view', title: 'Control Views', description: 'Open and close named app views.', access: 'read' },
      { name: 'list_ui_actions', title: 'List UI Actions', description: 'List bounded semantic actions.', access: 'read' },
      { name: 'invoke_ui_action', title: 'Invoke UI Action', description: 'Run one bounded semantic action.', access: 'read' },
      { name: 'wait_for_ui', title: 'Wait for UI', description: 'Wait for a structured UI condition.', access: 'read' },
      { name: 'plan_delete', title: 'Plan Delete', description: 'Preview a deletion.', access: 'write' }
    ] }
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const status = () => ({
    configuration: clone(state.configuration),
    contract: clone(state.contract),
    deployment: {
      deployment: { path: 'C:\\\\ExploreBetterMcp.exe' },
      clients: ['codex', 'claude', 'cursor', 'vscode'].map((client) => ({ client, installed: false })),
      generic: { command: 'ExploreBetterMcp.exe', args: ['--profile', 'PROFILE_ID'] }
    }
  });
  window.__preferencesMock = state;
  window.exploreBetterDesktop = {
    aiBridge: {
      status: async () => status(),
      audit: async () => [],
      configure: async ({ enabled }) => { state.configuration.enabled = enabled === true; return status(); },
      upsertProfile: async (draft) => {
        const saved = { ...draft, id: draft.id || 'profile-' + (state.configuration.profiles.length + 1), enabled: true };
        const index = state.configuration.profiles.findIndex((item) => item.id === saved.id);
        if (index >= 0) state.configuration.profiles[index] = saved;
        else state.configuration.profiles.push(saved);
        state.upserts.push(clone(saved));
        return clone(saved);
      },
      revokeProfile: async (id) => {
        const target = state.configuration.profiles.find((item) => item.id === id);
        if (target) target.enabled = false;
        return target ? clone(target) : null;
      },
      installClient: async () => true,
      removeClient: async () => true,
      publishContext: (context) => {
        state.contexts.push(context);
        while (state.contexts.length > 100) state.contexts.shift();
        return true;
      },
      onAction: (listener) => { state.action = listener; return () => { state.action = null; }; }
    }
  };
})();`;

async function openPreferences(page) {
  const result = await page.evaluate(() => window.__preferencesMock.action({ type: "view", view: "preferences", visible: true }));
  if (result?.__exploreBetterUiError) throw new Error(`MCP could not open Preferences: ${result.__exploreBetterUiError.message}`);
  await page.waitForSelector("#preferences-dialog", { state: "visible" });
}

async function main() {
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(path.join(fixture, "visible.txt"), "visible\n", "utf8");
  await fs.writeFile(path.join(fixture, ".hidden.txt"), "hidden\n", "utf8");
  const port = 51_000 + Math.floor(Math.random() * 8_000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const pageErrors = [];
  const consoleErrors = [];
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let browser;
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({
      executablePath: process.env.EB_PREFERENCES_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.addInitScript({ content: desktopMock });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__exploreBetterStartup?.completedAt));
    await page.evaluate(() => document.querySelector('#default-explorer-dialog[open] [data-default-explorer-choice="keep"]')?.click());

    await openPreferences(page);
    const initial = await page.evaluate(() => {
      const dialog = document.getElementById("preferences-dialog");
      const scroller = document.querySelector(".preferences-scroll");
      const footer = document.querySelector(".preferences-actions");
      const dialogRect = dialog.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const headings = [...document.querySelectorAll(".preference-section-head strong")].map((item) => item.textContent.trim());
      return {
        dialogOverflow: getComputedStyle(dialog).overflowY,
        scrollerOverflow: getComputedStyle(scroller).overflowY,
        scrollable: scroller.scrollHeight > scroller.clientHeight,
        footerVisible: footerRect.top >= dialogRect.top && footerRect.bottom <= dialogRect.bottom,
        startupLayoutHidden: document.getElementById("preference-startup-layout-row").offsetParent === null,
        permissionsOpen: document.querySelector(".ai-bridge-permissions").open,
        permissionHeight: Math.round(document.querySelector(".ai-bridge-permissions").getBoundingClientRect().height),
        permissionSummary: document.querySelector(".ai-bridge-permissions summary")?.textContent?.trim() || "",
        headings,
        saveDisabled: document.querySelector('#preferences-form button[type="submit"]').disabled,
        status: document.getElementById("preferences-save-status").textContent.trim()
      };
    });
    addCheck(checks, "single-scroll-owner", initial.dialogOverflow === "hidden" && initial.scrollerOverflow === "auto" && initial.scrollable, JSON.stringify(initial));
    addCheck(checks, "persistent-save-footer", initial.footerVisible && initial.saveDisabled && initial.status === "All app preferences saved", JSON.stringify(initial));
    addCheck(checks, "conditional-startup-layout", initial.startupLayoutHidden, "Startup Layout stays hidden until Saved Layout is selected.");
    addCheck(checks, "plain-language-sections", JSON.stringify(initial.headings) === JSON.stringify(["Files and folders", "Windows integration", "Terminal", "AI Bridge"]), JSON.stringify(initial.headings));
    addCheck(checks, "advanced-permissions-collapsed", !initial.permissionsOpen && initial.permissionHeight < 60, JSON.stringify(initial));
    addCheck(checks, "existing-profile-new-permissions", /3 new permissions available/i.test(initial.permissionSummary), initial.permissionSummary);

    await page.fill("#preferences-search", "scrollback");
    const searchFiltered = await page.evaluate(() => ({
      terminalVisible: !document.querySelector('[data-preference-section="terminal"]').classList.contains("preference-search-hidden"),
      filesHidden: document.querySelector('[data-preference-section="files"]').classList.contains("preference-search-hidden"),
      noResults: !document.getElementById("preferences-no-results").hidden
    }));
    addCheck(checks, "search-filters-labels-and-help", searchFiltered.terminalVisible && searchFiltered.filesHidden && !searchFiltered.noResults, JSON.stringify(searchFiltered));
    await page.fill("#preferences-search", "definitely-no-such-setting");
    addCheck(checks, "search-no-results", await page.locator("#preferences-no-results").isVisible(), await page.textContent("#preferences-no-results"));
    await page.click("#preferences-search-clear");
    addCheck(checks, "search-clear-restores-sections", await page.evaluate(() => [...document.querySelectorAll("[data-preference-section]")].every((section) => !section.classList.contains("preference-search-hidden"))), "All Preferences sections restored.");

    await page.locator(".preferences-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const footerAfterScroll = await page.evaluate(() => {
      const dialog = document.getElementById("preferences-dialog").getBoundingClientRect();
      const footer = document.querySelector(".preferences-actions").getBoundingClientRect();
      return { visible: footer.top >= dialog.top && footer.bottom <= dialog.bottom, top: Math.round(footer.top), bottom: Math.round(footer.bottom) };
    });
    addCheck(checks, "footer-remains-visible", footerAfterScroll.visible, JSON.stringify(footerAfterScroll));

    const originalFontSize = await page.inputValue("#preference-terminal-font-size");
    await page.fill("#preference-terminal-font-size", originalFontSize === "16" ? "15" : "16");
    await page.waitForFunction(() => document.getElementById("preferences-summary")?.textContent === "Unsaved app preference changes");
    addCheck(checks, "dirty-state-feedback", await page.evaluate(() => !document.querySelector('#preferences-form button[type="submit"]').disabled && document.getElementById("preferences-save-status").textContent.includes("not saved")), await page.textContent("#preferences-save-status"));
    addCheck(checks, "section-changed-badge", await page.locator('[data-preference-changed="terminal"]').isVisible(), "Terminal section shows Changed.");

    const mcpClose = await page.evaluate(() => window.__preferencesMock.action({ type: "view", view: "preferences", visible: false }));
    addCheck(checks, "mcp-protects-unsaved-draft", mcpClose?.__exploreBetterUiError?.code === "UI_BLOCKED" && await page.locator("#preferences-dialog").evaluate((dialog) => dialog.open), JSON.stringify(mcpClose));

    let closePrompt = "";
    page.once("dialog", async (dialog) => { closePrompt = dialog.message(); await dialog.dismiss(); });
    await page.click('[data-close-dialog="preferences-dialog"]');
    addCheck(checks, "discard-cancel-preserves-draft", await page.locator("#preferences-dialog").evaluate((dialog) => dialog.open) && await page.inputValue("#preference-terminal-font-size") !== originalFontSize && closePrompt.includes("Discard"), closePrompt);
    page.once("dialog", (dialog) => dialog.accept());
    await page.click('[data-close-dialog="preferences-dialog"]');
    await page.waitForSelector("#preferences-dialog", { state: "hidden" });
    await openPreferences(page);
    addCheck(checks, "discard-accept-restores-saved", await page.inputValue("#preference-terminal-font-size") === originalFontSize, `${await page.inputValue("#preference-terminal-font-size")} restored`);

    await page.selectOption("#preference-density", "compact");
    await page.selectOption("#preference-open-gesture", "single");
    await page.selectOption("#preference-launch-mode", "native");
    await page.selectOption("#preference-shell-open-mode", "activeNewTab");
    await page.fill("#preference-terminal-font-size", "16");
    await page.selectOption("#preference-terminal-cursor", "bar");
    await page.fill("#preference-terminal-scrollback", "5000");
    await page.click('#preferences-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("preferences-save-status")?.textContent === "All app preferences saved");
    const savedState = await page.evaluate(async () => (await fetch("/api/state")).json());
    addCheck(checks, "save-applies-and-persists", savedState.settings.density === "compact" && savedState.settings.openGesture === "single" && savedState.settings.launchMode === "native" && savedState.settings.shellOpenMode === "activeNewTab" && savedState.settings.terminalFontSize === 16 && savedState.settings.terminalCursor === "bar" && savedState.settings.terminalScrollback === 5000, JSON.stringify(savedState.settings));

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__exploreBetterStartup?.completedAt));
    await openPreferences(page);
    const persisted = await page.evaluate(() => ({
      density: document.getElementById("preference-density").value,
      openGesture: document.getElementById("preference-open-gesture").value,
      launchMode: document.getElementById("preference-launch-mode").value,
      shellOpenMode: document.getElementById("preference-shell-open-mode").value,
      fontSize: document.getElementById("preference-terminal-font-size").value,
      cursor: document.getElementById("preference-terminal-cursor").value,
      scrollback: document.getElementById("preference-terminal-scrollback").value,
      clean: document.querySelector('#preferences-form button[type="submit"]').disabled
    }));
    addCheck(checks, "reload-restores-preferences", JSON.stringify(persisted) === JSON.stringify({ density: "compact", openGesture: "single", launchMode: "native", shellOpenMode: "activeNewTab", fontSize: "16", cursor: "bar", scrollback: "5000", clean: true }), JSON.stringify(persisted));

    await page.fill("#preference-ai-name", "Renamed MCP Profile");
    await page.waitForFunction(() => document.getElementById("preferences-summary")?.textContent === "Unsaved AI profile changes");
    addCheck(checks, "ai-draft-has-distinct-save-feedback", await page.evaluate(() => document.querySelector('#preferences-form button[type="submit"]').disabled && document.getElementById("preferences-save-status").textContent.includes("Save Profile")), await page.textContent("#preferences-save-status"));
    await page.click('[data-ai-bridge-action="save-profile"]');
    await page.waitForFunction(() => document.getElementById("preferences-summary")?.textContent.includes("Compact"));
    addCheck(checks, "ai-profile-save-clears-dirty-state", await page.evaluate(() => window.__preferencesMock.upserts.at(-1)?.name === "Renamed MCP Profile" && document.getElementById("preferences-save-status").textContent === "All app preferences saved"), JSON.stringify(await page.evaluate(() => window.__preferencesMock.upserts.at(-1))));

    await page.fill("#preference-terminal-font-size", "15");
    let scopedResetPrompt = "";
    page.once("dialog", async (dialog) => { scopedResetPrompt = dialog.message(); await dialog.dismiss(); });
    await page.click('[data-preferences-reset-section="terminal"]');
    addCheck(checks, "scoped-reset-cancel", await page.inputValue("#preference-terminal-font-size") === "15" && scopedResetPrompt.includes("Terminal"), scopedResetPrompt);
    page.once("dialog", (dialog) => dialog.accept());
    await page.click('[data-preferences-reset-section="terminal"]');
    await page.waitForFunction(() => document.getElementById("preference-terminal-font-size")?.value === "12" && document.getElementById("preferences-save-status")?.textContent.includes("not saved"));
    addCheck(checks, "scoped-reset-is-draft", await page.locator('[data-preference-changed="terminal"]').isVisible(), "Terminal defaults remain a draft until Save App Preferences.");

    let resetPrompt = "";
    page.once("dialog", async (dialog) => { resetPrompt = dialog.message(); await dialog.dismiss(); });
    await page.click('[data-preferences-action="reset"]');
    await page.waitForFunction(() => document.getElementById("toast")?.textContent.includes("canceled"));
    addCheck(checks, "reset-cancel-preserves-settings", await page.inputValue("#preference-density") === "compact" && resetPrompt.includes("Reset all app preferences"), resetPrompt);
    page.once("dialog", (dialog) => dialog.accept());
    await page.click('[data-preferences-action="reset"]');
    await page.waitForFunction(() => document.getElementById("preferences-save-status")?.textContent.includes("not saved") && document.getElementById("preference-density")?.value === "comfortable");
    addCheck(checks, "reset-confirm-restores-default-draft", await page.evaluate(() => document.getElementById("preference-density").value === "comfortable" && document.getElementById("preference-open-gesture").value === "double" && document.getElementById("preference-launch-mode").value === "appWindow" && document.getElementById("preference-terminal-font-size").value === "12"), "Confirmed reset restores defaults in the draft.");
    await page.click('#preferences-form button[type="submit"]');
    await page.waitForFunction(() => document.getElementById("preferences-save-status")?.textContent === "All app preferences saved");
    addCheck(checks, "reset-draft-requires-save", await page.evaluate(() => document.querySelector('#preferences-form button[type="submit"]').disabled), "Reset defaults persisted only after Save App Preferences.");

    await page.setViewportSize({ width: 430, height: 800 });
    const compact = await page.evaluate(() => {
      const dialog = document.getElementById("preferences-dialog").getBoundingClientRect();
      const footer = document.querySelector(".preferences-actions").getBoundingClientRect();
      const buttons = [...document.querySelectorAll(".preferences-actions button")].map((button) => button.getBoundingClientRect());
      return {
        dialogContained: dialog.left >= 0 && dialog.right <= innerWidth && dialog.top >= 0 && dialog.bottom <= innerHeight,
        footerContained: footer.left >= dialog.left && footer.right <= dialog.right && footer.bottom <= dialog.bottom,
        controlsContained: buttons.every((rect) => rect.left >= footer.left && rect.right <= footer.right),
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth)
      };
    });
    addCheck(checks, "compact-layout", compact.dialogContained && compact.footerContained && compact.controlsContained && compact.horizontalOverflow === 0, JSON.stringify(compact));

    await page.screenshot({ path: screenshotPath });
    addCheck(checks, "runtime-errors", pageErrors.length === 0 && consoleErrors.length === 0, JSON.stringify({ pageErrors, consoleErrors }));
    const passed = checks.filter((check) => check.status === "pass").length;
    const report = { generatedAt: new Date().toISOString(), passed, failed: checks.length - passed, checks, screenshot: screenshotPath };
    await fs.writeFile(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const markdown = [
      "# Preferences UI Verification",
      "",
      `Generated: ${report.generatedAt}`,
      "",
      `Result: ${passed}/${checks.length} checks passed.`,
      "",
      "| Check | Result |",
      "| --- | --- |",
      ...checks.map((check) => `| ${check.id} | ${check.status === "pass" ? "Passed" : `Failed: ${check.detail.replaceAll("|", "\\|")}`} |`),
      ""
    ].join("\n");
    await fs.writeFile(outputMarkdown, markdown, "utf8");
    console.log(`Preferences UI smoke: ${passed} pass, ${checks.length - passed} fail`);
    checks.forEach((check) => console.log(`${check.status.toUpperCase()} ${check.id}: ${check.detail}`));
    if (passed !== checks.length) process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    await new Promise((resolve) => server.once("exit", resolve)).catch(() => {});
  }
}

await main();
