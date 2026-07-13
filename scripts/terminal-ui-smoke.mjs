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
  const state = { creates: [], writes: [], resizes: [], syncs: [], restarts: [], disposes: [], sessions: new Map(), listeners: new Set(), next: 1 };
  const emit = (message) => state.listeners.forEach((listener) => listener(message));
  const metadata = (request, id) => ({ sessionId: id, profileId: request.profileId === 'auto' ? 'windows-powershell' : request.profileId, profileLabel: request.profileId === 'command-prompt' ? 'Command Prompt' : 'Windows PowerShell', elevation: request.elevation, cwd: request.cwd });
  window.__terminalMock = state;
  window.exploreBetterDesktop = {
    getPathForFile: () => '',
    terminal: {
      capabilities: async () => ({ available: true, defaultProfileId: 'windows-powershell', elevationAvailable: true, profiles: [{ id: 'windows-powershell', label: 'Windows PowerShell' }, { id: 'command-prompt', label: 'Command Prompt' }] }),
      create: async (request) => {
        const id = 'mock-session-' + state.next++;
        state.creates.push({ ...request, sessionId: id });
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

    await page.click('[data-topbar-action="palette"]');
    await page.fill('#command-input', 'Open preferences');
    await page.press('#command-input', 'Enter');
    await page.selectOption('#preference-terminal-theme', 'high-contrast');
    await page.click('#preferences-form button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('[data-terminal-drawer="left"]').classList.contains('theme-high-contrast'));
    addCheck(checks, "high-contrast-live-theme", await page.evaluate(() => document.querySelector('[data-terminal-drawer="left"]').classList.contains('theme-high-contrast')), "High Contrast applies to the live terminal.");
    await page.click('[data-close-dialog="preferences-dialog"]');
    await page.click('[data-topbar-action="palette"]');
    await page.fill('#command-input', 'Open preferences');
    await page.press('#command-input', 'Enter');
    await page.selectOption('#preference-terminal-theme', 'dark');
    await page.click('#preferences-form button[type="submit"]');
    await page.waitForFunction(() => !document.querySelector('[data-terminal-drawer="left"]').classList.contains('theme-high-contrast'));
    await page.click('[data-close-dialog="preferences-dialog"]');

    const createsBeforeShortcut = await page.evaluate(() => window.__terminalMock.creates.length);
    await page.locator('body').press('Control+Backquote');
    await page.waitForFunction(() => document.querySelector('[data-terminal-drawer="left"]').hidden);
    await page.locator('body').press('Control+Backquote');
    await page.waitForFunction((before) => window.__terminalMock.creates.length === before + 1 && !document.querySelector('[data-terminal-drawer="left"]').hidden, createsBeforeShortcut);
    addCheck(checks, "keyboard-toggle", await page.evaluate((before) => window.__terminalMock.creates.length === before + 1 && !document.querySelector('[data-terminal-drawer="left"]').hidden, createsBeforeShortcut), "Ctrl+Backquote closes and lazily reopens the active tab terminal.");

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const disposedBeforeFinalClose = await page.evaluate(() => window.__terminalMock.disposes.length);
    await page.click('[data-terminal-action="close"][data-pane="left"]');
    await page.click('[data-terminal-action="close"][data-pane="right"]');
    await page.waitForFunction(() => window.__terminalMock.sessions.size === 1);
    addCheck(checks, "visible-session-cleanup", await page.evaluate((before) => window.__terminalMock.disposes.length === before + 2, disposedBeforeFinalClose), "Closing each visible drawer disposes its active session; the inactive tab remains alive.");
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
