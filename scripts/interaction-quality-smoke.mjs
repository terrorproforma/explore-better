import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright-core";

const root = process.cwd();
const run = path.join(root, "artifacts", `interaction-quality-${Date.now()}`);
const fixture = path.join(run, "Documents");
const empty = path.join(run, "Empty");
const appData = path.join(run, "appdata");
await Promise.all([fixture, empty, appData].map(folder => fs.mkdir(folder, { recursive: true })));
await Promise.all(Array.from({ length: 350 }, (_, i) => fs.writeFile(path.join(fixture, `Document ${String(i + 1).padStart(3, "0")}.txt`), `Document ${i + 1}\n`)));
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root, windowsHide: true,
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
  stdio: ["ignore", "pipe", "pipe"]
});
let output = "";
server.stdout.on("data", data => { output += data; });
server.stderr.on("data", data => { output += data; });
const checks = [];
const errors = [];
let browser;
const check = (id, condition, detail = "") => { checks.push({ id, status: condition ? "pass" : "fail", detail }); assert.ok(condition, `${id}: ${detail}`); };
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw new Error(output);
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Server did not start: ${output}`);
  browser = await chromium.launch({ executablePath: process.env.EB_INTERACTION_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  if (process.env.EB_INTERACTION_CPU_THROTTLE) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.EB_INTERACTION_CPU_THROTTLE) });
  }
  page.on("pageerror", error => errors.push(error.message));
  const start = async () => {
    await page.goto(`${url}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(empty)}`);
    await page.waitForFunction(() => Boolean(window.__exploreBetterStartup?.completedAt));
  };
  await start();
  check("short-status-keeps-wide-header-actions", await page.locator('.topbar-actions [data-topbar-action]:visible').count() === 5);
  check("pane-role-badges-fit-with-one-tab", await page.evaluate(() => [...document.querySelectorAll('.pane[data-pane]')].every(pane => {
    const badge = pane.querySelector('.pane-role-badge').getBoundingClientRect();
    return badge.width >= 54 && badge.right <= pane.getBoundingClientRect().right;
  })));
  check("tree-collapsed-by-default", await page.locator("#folder-tree").isHidden());
  await page.locator('[data-nav-action="toggle-tree"]').click();
  await start();
  check("tree-disclosure-persists", await page.locator("#folder-tree").isVisible());
  check("empty-folder-offers-creation", await page.locator('[data-list="right"] .file-empty-state [data-action="new-folder"]').isVisible());

  const list = page.locator('[data-list="left"]');
  await page.waitForSelector('[data-list="left"].virtualized');
  check("medium-folder-bounded-dom", await list.locator('[data-entry-path]').count() < 100);
  await page.locator('[data-tabs="left"] .tab-label').focus();
  await page.evaluate(() => {
    window.retainedChrome = ['[data-tabs="left"] .tab-label', '#root-strip button', '#folder-tree .tree-main', '.pane[data-pane="left"] [data-sort="name"]'].map(selector => ({ selector, node: document.querySelector(selector) }));
  });
  const refresh = async () => {
    const response = page.waitForResponse(response => response.url().includes("/api/list?") && response.ok());
    await page.locator('[data-action="refresh"][data-pane="left"]').dispatchEvent("click");
    await response;
    await page.waitForFunction(() => document.querySelector('.pane[data-pane="left"]')?.getAttribute("aria-busy") === "false");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await refresh();
  check("refresh-preserves-navigation-dom", await page.evaluate(() => window.retainedChrome.every(({selector, node}) => node === document.querySelector(selector) && node.isConnected)));
  check("refresh-preserves-keyboard-focus", await page.evaluate(() => document.activeElement === window.retainedChrome[0].node));

  await list.locator('[data-entry-path]').nth(3).click();
  const selectedPath = await list.locator('.selected').getAttribute('data-entry-path');
  await refresh();
  check("refresh-preserves-selection", await list.locator('.selected').getAttribute('data-entry-path') === selectedPath);
  await fs.writeFile(selectedPath, "updated ".repeat(100));
  await refresh();
  check("refresh-shows-changed-metadata", (await list.locator('.selected').innerText()).includes("800 B"));

  for (const view of ["details", "compact", "tiles"]) {
    await page.locator(`[data-view-mode="${view}"][data-pane="left"]`).click();
    await list.evaluate(element => { element.scrollTop = 1500; });
    await page.waitForTimeout(80);
    await list.evaluate(element => {
      window.previousRows = new Map([...element.querySelectorAll('[data-entry-path]')].map(node => [node.dataset.entryPath, node]));
      element.scrollTop += 100;
    });
    await page.waitForTimeout(80);
    const reuse = await list.evaluate(element => {
      const overlapping = [...element.querySelectorAll('[data-entry-path]')].filter(node => window.previousRows.has(node.dataset.entryPath));
      return { overlap: overlapping.length, retained: overlapping.every(node => window.previousRows.get(node.dataset.entryPath) === node), rows: element.querySelectorAll('[data-entry-path]').length };
    });
    check(`${view}-scroll-reuses-overlap`, reuse.overlap > 10 && reuse.retained && reuse.rows < 200, JSON.stringify(reuse));
    await list.focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.querySelector('[data-list="left"] .focused')?.dataset.entryPath.endsWith("Document 350.txt"));
    check(`${view}-keyboard-reaches-last-file`, await list.locator('.focused').isVisible());
  }

  await page.locator('[data-view-mode="details"][data-pane="left"]').click();
  await list.focus();
  await page.keyboard.press("End");
  await list.locator('.focused').click();
  const scrollBeforeRefresh = await list.evaluate(node => node.scrollTop);
  await refresh();
  check("refresh-keeps-offscreen-selection", (await list.locator('.selected').getAttribute('data-entry-path')).endsWith("Document 350.txt"));
  check("refresh-keeps-scroll-position", Math.abs(await list.evaluate(node => node.scrollTop) - scrollBeforeRefresh) <= 1);
  const filter = page.locator('[data-filter="left"]');
  await filter.fill("not a real filename");
  check("no-results-explains-filter", (await list.innerText()).includes("No matching files"));
  await page.locator('[data-clear-pane-filters="left"]').click();
  check("clear-filters-restores-list-and-focus", await filter.inputValue() === "" && await filter.evaluate(node => document.activeElement === node) && await list.locator('[data-entry-path]').count() > 0);
  await filter.fill("Document 2");
  await filter.press("Escape");
  check("escape-clears-filter", await filter.inputValue() === "");
  await page.locator('.pane[data-pane="left"] [data-sort="name"]').click();
  await list.evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector('[data-list="left"] [data-entry-path]')?.dataset.entryPath.endsWith("Document 350.txt"));
  check("sort-updates-recycled-rows", (await list.locator('[data-entry-path]').first().getAttribute('data-entry-path')).endsWith("Document 350.txt"));

  // File clicks defer list focus for double-click navigation. A newer menu
  // interaction must keep focus after that timer's deadline, including Escape.
  await list.locator('[data-entry-path]').first().click();
  await page.locator("#dock-overflow-toggle").click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(750);
  check("delayed-row-focus-does-not-steal-menu-focus", await page.locator('#dock-overflow-toggle').evaluate(node => document.activeElement === node));

  await page.locator("#dock-overflow-toggle").click();
  const search = page.getByRole("searchbox", { name: "Find a shelf action" });
  check("overflow-focuses-search", await search.evaluate(node => document.activeElement === node));
  await search.fill("no action by this name");
  check("overflow-no-results", await page.locator('[data-dock-overflow-empty]').isVisible());
  await search.fill("Preferences");
  await page.setViewportSize({ width: 1100, height: 960 });
  await page.waitForTimeout(100);
  check("overflow-search-survives-resize", await search.inputValue() === "Preferences" && await search.evaluate(node => document.activeElement === node));
  check("overflow-finds-action", await page.locator('[data-dock-overflow-item]:visible').count() === 1);
  await search.press("ArrowDown");
  check("overflow-arrow-navigation", await page.locator('[data-overflow-global-action="preferences"]').evaluate(node => document.activeElement === node));
  await page.keyboard.press("Enter");
  await page.waitForSelector('#preferences-dialog[open]');
  check("overflow-runs-found-action", await page.locator('#preferences-dialog').isVisible());
  const focusState = () => page.evaluate(() => ({
    tag: document.activeElement?.tagName, id: document.activeElement?.id, role: document.activeElement?.getAttribute('role'),
    menuHidden: document.getElementById('dock-overflow-menu').hidden,
    toggleHidden: document.getElementById('dock-overflow-toggle').hidden,
    toggleWidth: document.getElementById('dock-overflow-toggle').getBoundingClientRect().width
  }));
  await page.locator('[data-close-dialog="preferences-dialog"]').click();
  await page.locator("#dock-overflow-toggle").click();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1120, height: 960 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const restoredFocus = await focusState();
  check("overflow-escape-restores-focus", restoredFocus.id === 'dock-overflow-toggle', JSON.stringify(restoredFocus));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#topbar-more-toggle').click();
  const topbarAction = await page.locator('#topbar-more-menu [data-topbar-action]').first().getAttribute('data-topbar-action');
  // A background operation can update status while a menu owns keyboard focus.
  await page.evaluate(async () => {
    document.getElementById("status-pill").textContent = "Folder refreshed";
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  check("topbar-menu-survives-status-update", await page.locator('#topbar-more-menu').isVisible());
  check("topbar-menu-preserves-focus", await page.locator(`#topbar-more-menu [data-topbar-action="${topbarAction}"]`).evaluate(node => document.activeElement === node));
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 410, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check("topbar-toggle-focus-survives-resize", await page.locator('#topbar-more-toggle').evaluate(node => document.activeElement === node));
  check("no-browser-errors", errors.length === 0, errors.join("\n"));
  await page.screenshot({ path: path.join(run, "workspace.png") });
} catch (error) {
  if (!checks.some(check => check.status === "fail")) checks.push({ id: "runtime", status: "fail", detail: error.stack });
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  await fs.writeFile(path.join(root, "artifacts", "interaction-quality-latest.json"), JSON.stringify({ checks, errors, run }, null, 2));
  console.log(`Interaction quality: ${checks.filter(check => check.status === "pass").length} pass, ${checks.filter(check => check.status === "fail").length} fail`);
  checks.filter(check => check.status === "fail").forEach(check => console.error(check.detail || check.id));
}
