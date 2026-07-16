import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `terminal-ui-${stamp}`);
const fixture = path.join(runRoot, "Folder With Spaces Ω");
const childFolder = path.join(fixture, "Nested Folder");
const appData = path.join(runRoot, "appdata");
const screenshotPath = path.join(artifactsDir, "terminal-ui-latest.png");
const reportPath = path.join(artifactsDir, "terminal-ui-latest.json");

function addCheck(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function waitForServer(baseUrl, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 12000) {
    if (child.exitCode !== null) throw new Error(`Server exited early with ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/api/roots`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become ready.");
}

const terminalMockScript = `(() => {
  const state = { creates: [], writes: [], resizes: [], syncs: [], restarts: [], disposes: [], sessions: new Map(), listeners: new Set(), contexts: [], next: 1, failNextCreate: '', failNextRestart: '' };
  const emit = (message) => state.listeners.forEach((listener) => listener(message));
  state.emit = emit;
  const metadata = (request, id) => ({ sessionId: id, profileId: request.profileId === 'auto' ? 'windows-powershell' : request.profileId, profileLabel: request.profileId === 'command-prompt' ? 'Command Prompt' : 'Windows PowerShell', elevation: request.elevation, cwd: request.cwd });
  window.__terminalMock = state;
  window.exploreBetterDesktop = {
    getPathForFile: (file) => ({
      'cmd-drop.txt': 'C:\\\\Folder With Spaces\\\\cmd-drop.txt',
      'ps-drop.txt': "C:\\\\Folder With Spaces\\\\O'Brien.txt"
    })[file?.name] || '',
    aiBridge: {
      publishContext: (context) => {
        state.contexts.push(context);
        while (state.contexts.length > 100) state.contexts.shift();
        return true;
      }
    },
    terminal: {
      capabilities: async () => ({ available: true, defaultProfileId: 'windows-powershell', elevationAvailable: true, profiles: [{ id: 'windows-powershell', label: 'Windows PowerShell' }, { id: 'command-prompt', label: 'Command Prompt' }] }),
      create: async (request) => {
        const id = 'mock-session-' + state.next++;
        state.creates.push({ ...request, sessionId: id });
        if (state.failNextCreate) {
          const message = state.failNextCreate;
          state.failNextCreate = '';
          throw new Error(message);
        }
        state.sessions.set(id, request);
        setTimeout(() => emit({ sessionId: id, type: 'data', data: 'Mock terminal ready\\r\\n' }), 0);
        return metadata(request, id);
      },
      write: (sessionId, data) => { state.writes.push({ sessionId, data }); emit({ sessionId, type: 'data', data }); if (/[\\r\\n]/.test(data)) { emit({ sessionId, type: 'busy', busy: true }); setTimeout(() => emit({ sessionId, type: 'busy', busy: false }), 10); } return true; },
      resize: (sessionId, cols, rows) => { state.resizes.push({ sessionId, cols, rows }); return true; },
      syncDirectory: async (sessionId, cwd) => { state.syncs.push({ sessionId, cwd }); emit({ sessionId, type: 'cwd', cwd }); return { queued: false, cwd }; },
      restart: async (sessionId, request) => {
        const id = 'mock-session-' + state.next++;
        state.restarts.push({ from: sessionId, ...request, sessionId: id });
        if (state.failNextRestart) {
          const message = state.failNextRestart;
          state.failNextRestart = '';
          throw new Error(message);
        }
        state.sessions.delete(sessionId);
        state.sessions.set(id, request);
        return metadata(request, id);
      },
      dispose: async (sessionId) => { state.disposes.push(sessionId); state.sessions.delete(sessionId); return true; },
      onEvent: (listener) => { state.listeners.add(listener); return () => state.listeners.delete(listener); }
    }
  };
})();`;

async function main() {
  await fs.mkdir(childFolder, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(path.join(fixture, "sample.txt"), "terminal fixture\n");
  const port = 51000 + Math.floor(Math.random() * 8000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const errors = [];
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
      executablePath: process.env.EB_TERMINAL_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseUrl });
    const externalTerminalRequests = [];
    await page.route("**/api/open-with", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const payload = route.request().postDataJSON();
      if (payload?.mode !== "terminal") return route.continue();
      externalTerminalRequests.push(payload);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ mode: "terminal", launched: true }) });
    });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript({ content: terminalMockScript });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__exploreBetterStartup?.completedAt));

    addCheck(checks, "lazy-zero-sessions", await page.evaluate(() => window.__terminalMock.creates.length === 0), "No terminal is created during startup.");
    await page.click('[data-terminal-toggle="left"]');
    await page.waitForSelector('[data-terminal-drawer="left"] .xterm canvas');
    await page.waitForFunction(() => window.__terminalMock.creates.length === 1);
    const left = await page.evaluate(() => {
      const drawer = document.querySelector('[data-terminal-drawer="left"]');
      const list = document.querySelector('[data-list="left"]');
      const pane = document.querySelector('.pane[data-pane="left"]');
      return { hidden: drawer.hidden, height: Math.round(drawer.getBoundingClientRect().height), listHeight: Math.round(list.getBoundingClientRect().height), overflow: Math.max(0, pane.scrollHeight - pane.clientHeight), cwd: document.querySelector('[data-terminal-cwd="left"]')?.textContent || '' };
    });
    addCheck(checks, "left-drawer-layout", !left.hidden && left.height >= 140 && left.listHeight > 40 && left.overflow === 0, JSON.stringify(left));
    const initialChrome = await page.evaluate(() => {
      const drawer = document.querySelector('[data-terminal-drawer="left"]');
      const controls = drawer.querySelector('.terminal-controls');
      return {
        searchHidden: document.querySelector('[data-terminal-search-panel="left"]').hidden,
        elevationHidden: document.querySelector('[data-terminal-elevation="left"]').hidden,
        controlsOverflow: Math.max(0, controls.scrollWidth - controls.clientWidth),
        visibleControls: [...controls.querySelectorAll('select, button')].filter((element) => {
          const rect = element.getBoundingClientRect();
          const drawerRect = drawer.getBoundingClientRect();
          return rect.width > 0 && rect.left >= drawerRect.left && rect.right <= drawerRect.right;
        }).length
      };
    });
    addCheck(checks, "compact-header-state", initialChrome.searchHidden && initialChrome.elevationHidden && initialChrome.controlsOverflow === 0 && initialChrome.visibleControls === 8, JSON.stringify(initialChrome));

    await page.click('[data-terminal-toggle="right"]');
    await page.waitForSelector('[data-terminal-drawer="right"] .xterm canvas');
    await page.waitForFunction(() => window.__terminalMock.creates.length === 2);
    addCheck(checks, "simultaneous-panes", await page.evaluate(() => !document.querySelector('[data-terminal-drawer="left"]').hidden && !document.querySelector('[data-terminal-drawer="right"]').hidden), "Both pane drawers remain visible.");

    await page.click('[data-new-tab="left"]');
    await page.waitForFunction(() => window.__terminalMock.creates.length === 3);
    const tabIds = await page.evaluate(() => window.__terminalMock.creates.map((item) => item.tabId));
    addCheck(checks, "per-tab-runtime-identity", new Set(tabIds).size === 3, JSON.stringify(tabIds));
    await page.click('[data-tab="0"][data-pane="left"]');
    await page.waitForFunction(() => document.querySelector('[data-tab="0"][data-pane="left"]')?.closest('.tab')?.classList.contains('active'));
    addCheck(checks, "tab-session-preserved", await page.evaluate(() => window.__terminalMock.creates.length === 3 && Boolean(document.querySelector('[data-terminal-drawer="left"] .xterm canvas'))), "Returning to the first tab reattaches its existing renderer.");

    await page.fill('[data-path-input="left"]', childFolder);
    await page.press('[data-path-input="left"]', "Enter");
    await page.waitForFunction((target) => window.__terminalMock.syncs.some((item) => item.cwd === target), childFolder);
    addCheck(checks, "folder-follow-quoted-boundary", await page.evaluate((target) => window.__terminalMock.syncs.at(-1)?.cwd === target, childFolder), childFolder);

    const beforeHeight = await page.locator('[data-terminal-drawer="left"]').evaluate((element) => element.getBoundingClientRect().height);
    const grip = await page.locator('[data-layout-resize="terminal-left"]').boundingBox();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, grip.y - 35, { steps: 4 });
    await page.mouse.up();
    const afterHeight = await page.locator('[data-terminal-drawer="left"]').evaluate((element) => element.getBoundingClientRect().height);
    addCheck(checks, "drawer-resize", afterHeight > beforeHeight + 15, `${Math.round(beforeHeight)}px -> ${Math.round(afterHeight)}px`);

    await page.selectOption('[data-terminal-profile="left"]', "command-prompt");
    await page.waitForFunction(() => window.__terminalMock.restarts.length === 1);
    addCheck(checks, "profile-transactional-restart", await page.evaluate(() => window.__terminalMock.restarts[0]?.profileId === "command-prompt"), "Profile change restarts only the active tab terminal.");

    await page.click('[data-terminal-action="administrator"][data-pane="left"]');
    await page.waitForFunction(() => window.__terminalMock.restarts.length === 2);
    const elevationState = await page.evaluate(() => ({
      requested: window.__terminalMock.restarts.at(-1)?.elevation,
      badgeHidden: document.querySelector('[data-terminal-elevation="left"]').hidden,
      drawerElevated: document.querySelector('[data-terminal-drawer="left"]').classList.contains('elevated')
    }));
    addCheck(checks, "administrator-transactional-restart", elevationState.requested === "administrator" && !elevationState.badgeHidden && elevationState.drawerElevated, JSON.stringify(elevationState));

    await page.evaluate(() => { window.__terminalMock.failNextRestart = "Mock restart failed"; });
    await page.click('[data-terminal-action="restart"][data-pane="left"]');
    await page.waitForFunction(() => document.querySelector('[data-terminal-title="left"]')?.textContent?.includes("Error"));
    const restartFailure = await page.evaluate(() => ({
      title: document.querySelector('[data-terminal-title="left"]')?.textContent || "",
      accessibleLabel: document.querySelector('[data-terminal-title="left"]')?.getAttribute("aria-label") || "",
      toast: document.getElementById("toast")?.textContent || ""
    }));
    addCheck(checks, "restart-failure-feedback", restartFailure.title.includes("Error") && restartFailure.accessibleLabel.includes("Mock restart failed") && restartFailure.toast.includes("Mock restart failed"), JSON.stringify(restartFailure));
    await page.click('[data-terminal-action="restart"][data-pane="left"]');
    await page.waitForFunction(() => document.querySelector('[data-terminal-title="left"]')?.textContent?.includes("Ready"));
    addCheck(checks, "restart-recovery", await page.evaluate(() => window.__terminalMock.restarts.length === 4 && document.querySelector('[data-terminal-title="left"]')?.textContent?.includes("Ready")), "A retry replaces the failed restart and returns to Ready.");

    await page.locator('[data-terminal-drawer="left"] .terminal-session-surface').evaluate((host) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["cmd"], "cmd-drop.txt", { type: "text/plain" }));
      host.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    addCheck(checks, "command-prompt-drop-quoting", await page.evaluate(() => window.__terminalMock.writes.at(-1)?.data === '"C:\\Folder With Spaces\\cmd-drop.txt"'), JSON.stringify(await page.evaluate(() => window.__terminalMock.writes.at(-1))));
    await page.selectOption('[data-terminal-profile="left"]', "windows-powershell");
    await page.waitForFunction(() => window.__terminalMock.restarts.length === 5 && document.querySelector('[data-terminal-title="left"]')?.textContent?.includes("Ready"));
    await page.locator('[data-terminal-drawer="left"] .terminal-session-surface').evaluate((host) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["powershell"], "ps-drop.txt", { type: "text/plain" }));
      host.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    addCheck(checks, "powershell-drop-quoting", await page.evaluate(() => window.__terminalMock.writes.at(-1)?.data === "'C:\\Folder With Spaces\\O''Brien.txt'"), JSON.stringify(await page.evaluate(() => window.__terminalMock.writes.at(-1))));

    const rightDisposesBeforeFailure = await page.evaluate(() => window.__terminalMock.disposes.length);
    await page.click('[data-terminal-action="close"][data-pane="right"]');
    await page.waitForFunction(() => document.querySelector('[data-terminal-drawer="right"]')?.hidden === true);
    await page.evaluate(() => { window.__terminalMock.failNextCreate = "Mock terminal startup failed"; });
    await page.click('[data-terminal-toggle="right"]');
    await page.waitForFunction(() => document.querySelector('[data-terminal-title="right"]')?.textContent?.includes("Error"));
    const startupFailure = await page.evaluate(() => ({
      title: document.querySelector('[data-terminal-title="right"]')?.textContent || "",
      placeholder: document.querySelector('[data-terminal-placeholder="right"]')?.textContent || "",
      disposed: window.__terminalMock.disposes.length
    }));
    addCheck(checks, "startup-failure-feedback", startupFailure.title.includes("Error") && startupFailure.placeholder === "Mock terminal startup failed" && startupFailure.disposed === rightDisposesBeforeFailure + 1, JSON.stringify(startupFailure));
    await page.click('[data-terminal-action="restart"][data-pane="right"]');
    await page.waitForFunction(() => document.querySelector('[data-terminal-title="right"]')?.textContent?.includes("Ready") && Boolean(document.querySelector('[data-terminal-drawer="right"] .xterm canvas')));
    addCheck(checks, "startup-recovery", await page.evaluate(() => document.querySelector('[data-terminal-title="right"]')?.textContent?.includes("Ready")), "Restart recovers the failed terminal in place.");

    await page.click('[data-terminal-action="search"][data-pane="left"]');
    await page.fill('[data-terminal-search="left"]', "Mock terminal ready");
    await page.click('[data-terminal-action="search-next"][data-pane="left"]');
    addCheck(checks, "terminal-search", await page.evaluate(() => !document.querySelector('[data-terminal-search-panel="left"]')?.hidden && document.querySelector('[data-terminal-search="left"]')?.value === "Mock terminal ready"), "Search opens, accepts a query, and advances without leaving the terminal.");
    const terminalTextarea = page.locator('[data-terminal-drawer="left"] .xterm-helper-textarea');
    await terminalTextarea.focus();
    await terminalTextarea.evaluate((textarea) => textarea.dispatchEvent(new KeyboardEvent("keydown", {
      key: "C",
      code: "KeyC",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })));
    await page.waitForTimeout(50);
    const copiedTerminalText = await page.evaluate(() => navigator.clipboard.readText());
    addCheck(checks, "terminal-copy-shortcut", copiedTerminalText === "Mock terminal ready", JSON.stringify(copiedTerminalText));
    await page.evaluate(() => navigator.clipboard.writeText("clipboard paste Ω"));
    const writesBeforePaste = await page.evaluate(() => window.__terminalMock.writes.length);
    await terminalTextarea.focus();
    await terminalTextarea.evaluate((textarea) => textarea.dispatchEvent(new KeyboardEvent("keydown", {
      key: "V",
      code: "KeyV",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true
    })));
    await page.waitForFunction((before) => window.__terminalMock.writes.length === before + 1, writesBeforePaste, { timeout: 5000 });
    addCheck(checks, "terminal-paste-shortcut", await page.evaluate(() => window.__terminalMock.writes.at(-1)?.data === "clipboard paste Ω"), JSON.stringify(await page.evaluate(() => window.__terminalMock.writes.at(-1))));
    await page.click('[data-terminal-action="clear"][data-pane="left"]');
    await page.waitForTimeout(50);
    addCheck(checks, "terminal-clear", await page.evaluate(() => !(document.querySelector('[data-terminal-drawer="left"] .xterm-rows')?.textContent || "").includes("Mock terminal ready")), "Clear removes prior output from the active terminal view.");

    await page.click('[data-topbar-action="palette"]');
    await page.fill('#command-input', 'Open preferences');
    await page.press('#command-input', 'Enter');
    await page.selectOption('#preference-terminal-theme', 'high-contrast');
    await page.fill('#preference-terminal-font-size', '15');
    await page.selectOption('#preference-terminal-cursor', 'bar');
    await page.fill('#preference-terminal-scrollback', '5000');
    await page.uncheck('#preference-terminal-follow');
    await page.click('#preferences-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('[data-terminal-drawer="left"]').classList.contains('theme-high-contrast'));
    addCheck(checks, "high-contrast-live-theme", await page.evaluate(() => document.querySelector('[data-terminal-drawer="left"]').classList.contains('theme-high-contrast')), "High Contrast applies to the live terminal.");
    await page.click('[data-close-dialog="preferences-dialog"]');

    const syncsBeforeFollowDisabled = await page.evaluate(() => window.__terminalMock.syncs.length);
    await page.fill('[data-path-input="left"]', fixture);
    await page.press('[data-path-input="left"]', "Enter");
    await page.waitForFunction((target) => document.querySelector('[data-path-input="left"]')?.value === target, fixture);
    await page.click('[data-terminal-action="open-folder"][data-pane="left"]');
    await page.waitForFunction((target) => document.querySelector('[data-path-input="left"]')?.value === target, childFolder);
    addCheck(checks, "open-terminal-folder", await page.evaluate(({ target, syncsBefore }) => document.querySelector('[data-path-input="left"]')?.value === target && window.__terminalMock.syncs.length === syncsBefore, { target: childFolder, syncsBefore: syncsBeforeFollowDisabled }), "With folder following disabled, Open Folder returns the pane to the terminal's independent folder.");

    await page.click('[data-terminal-action="external"][data-pane="left"]');
    await page.waitForFunction(() => document.getElementById("toast")?.textContent === "External terminal opened");
    addCheck(checks, "external-terminal-handoff", externalTerminalRequests.length === 1 && externalTerminalRequests[0].mode === "terminal" && externalTerminalRequests[0].paths?.[0] === childFolder, JSON.stringify(externalTerminalRequests[0]));

    await page.click('[data-topbar-action="palette"]');
    await page.fill('#command-input', 'Open preferences');
    await page.press('#command-input', 'Enter');
    await page.selectOption('#preference-terminal-theme', 'dark');
    await page.check('#preference-terminal-follow');
    await page.click('#preferences-form button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('[data-terminal-drawer="left"]').classList.contains('theme-high-contrast'));
    await page.click('[data-close-dialog="preferences-dialog"]');

    const terminalBeforeShortcut = await page.evaluate(() => ({
      creates: window.__terminalMock.creates.length,
      disposes: window.__terminalMock.disposes.length
    }));
    await page.locator('body').press('Control+Backquote');
    await page.waitForFunction(() => document.querySelector('[data-terminal-drawer="left"]').hidden);
    await page.waitForFunction(() => window.__terminalMock.contexts.at(-1)?.ui?.terminals?.find((terminal) => terminal.pane === "left")?.visible === false);
    const hiddenMcpState = await page.evaluate(() => window.__terminalMock.contexts.at(-1)?.ui?.terminals?.find((terminal) => terminal.pane === "left"));
    await page.locator('body').press('Control+Backquote');
    await page.waitForFunction((before) => window.__terminalMock.creates.length === before.creates && window.__terminalMock.disposes.length === before.disposes && !document.querySelector('[data-terminal-drawer="left"]').hidden, terminalBeforeShortcut);
    addCheck(checks, "keyboard-toggle-preserves-session", await page.evaluate((before) => window.__terminalMock.creates.length === before.creates && window.__terminalMock.disposes.length === before.disposes && !document.querySelector('[data-terminal-drawer="left"]').hidden, terminalBeforeShortcut), "Ctrl+Backquote hides and restores the same terminal without ending it.");
    addCheck(checks, "hidden-session-mcp-state", hiddenMcpState?.visible === false && hiddenMcpState?.session === true && hiddenMcpState?.state === "ready", JSON.stringify(hiddenMcpState));

    await page.evaluate(() => {
      const right = window.__terminalMock.creates.at(-1)?.sessionId;
      window.__terminalMock.emit({ sessionId: right, type: "busy", busy: true });
    });
    page.once("dialog", (dialog) => dialog.dismiss());
    const rightDisposesBeforeBusyClose = await page.evaluate(() => window.__terminalMock.disposes.length);
    await page.click('[data-terminal-action="close"][data-pane="right"]');
    addCheck(checks, "busy-close-cancel", await page.evaluate((before) => !document.querySelector('[data-terminal-drawer="right"]')?.hidden && window.__terminalMock.disposes.length === before, rightDisposesBeforeBusyClose), "Cancel keeps a busy terminal and its child-process session open.");
    await page.evaluate(() => {
      const right = window.__terminalMock.creates.at(-1)?.sessionId;
      window.__terminalMock.emit({ sessionId: right, type: "busy", busy: false });
    });

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const disposedBeforeFinalClose = await page.evaluate(() => window.__terminalMock.disposes.length);
    await page.click('[data-terminal-action="close"][data-pane="left"]');
    await page.click('[data-terminal-action="close"][data-pane="right"]');
    await page.waitForFunction(() => window.__terminalMock.sessions.size === 1);
    addCheck(checks, "visible-session-cleanup", await page.evaluate((before) => window.__terminalMock.disposes.length === before + 2, disposedBeforeFinalClose), "Closing each visible drawer disposes its active session; the inactive tab remains alive.");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__exploreBetterStartup?.completedAt));
    await page.click('[data-topbar-action="palette"]');
    await page.fill('#command-input', 'Open preferences');
    await page.press('#command-input', 'Enter');
    const persistedTerminalPreferences = await page.evaluate(() => ({
      theme: document.getElementById("preference-terminal-theme")?.value,
      fontSize: document.getElementById("preference-terminal-font-size")?.value,
      cursor: document.getElementById("preference-terminal-cursor")?.value,
      scrollback: document.getElementById("preference-terminal-scrollback")?.value,
      follow: document.getElementById("preference-terminal-follow")?.checked
    }));
    addCheck(checks, "terminal-preferences-persist", persistedTerminalPreferences.theme === "dark" && persistedTerminalPreferences.fontSize === "15" && persistedTerminalPreferences.cursor === "bar" && persistedTerminalPreferences.scrollback === "5000" && persistedTerminalPreferences.follow === true, JSON.stringify(persistedTerminalPreferences));
    await page.click('[data-close-dialog="preferences-dialog"]');
    addCheck(checks, "renderer-errors", errors.length === 0, errors.join(" | ") || "No page errors.");
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    await Promise.race([new Promise((resolve) => server.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  const report = { generatedAt: new Date().toISOString(), checks, summary: { pass: checks.filter((item) => item.status === "pass").length, fail: checks.filter((item) => item.status === "fail").length }, screenshotPath };
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Terminal UI smoke: ${report.summary.pass} pass, ${report.summary.fail} fail`);
  for (const item of checks) console.log(`${item.status.toUpperCase()} ${item.id}: ${item.detail}`);
  if (report.summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
