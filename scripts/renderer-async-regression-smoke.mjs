import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import vm from "node:vm";
import * as THREE from "three";
import { chromium } from "playwright-core";

const root = process.cwd();
const run = path.join(root, "artifacts", `renderer-async-${Date.now()}`);
const fixture = path.join(run, "Files"), target = path.join(run, "Target"), appData = path.join(run, "appdata");
await Promise.all([fixture, target, appData].map(folder => fs.mkdir(folder, { recursive: true })));
for (const name of ["alpha.txt", "beta.txt"]) await fs.writeFile(path.join(fixture, name), `Original ${name}\n`);
await fs.writeFile(path.join(target, "target.txt"), "Target fixture\n");
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.mjs"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), APPDATA: appData, LOCALAPPDATA: appData } });
let output = "", browser;
server.stdout.on("data", data => { output += data; }); server.stderr.on("data", data => { output += data; });
const checks = [], gates = [];
const gate = () => {
  let release, arrive;
  const allowed = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { arrive = resolve; });
  const value = { release, arrive, allowed, received }; gates.push(value); return value;
};
const entry = (folder, name) => ({ name, path: path.join(folder, name), parent: folder, isFile: true, isDirectory: false, kind: "Text", size: 1, modified: 1 });
const result = (folder, name) => ({ root: folder, entries: [entry(folder, name)], scanned: 1, skipped: [] });
const ui = (page, request) => page.evaluate(request => window.__testUiAction(request), request);
const view = (page, name) => ui(page, { type: "view", view: name, pane: "left" });
const submit = (page, id) => page.locator(`#${id}-form`).evaluate(form => form.requestSubmit());
const select = (page, name) => page.locator(`[data-list="left"] [data-entry-path=${JSON.stringify(path.join(fixture, name))}]`).click();
const closeDialog = (page, id) => page.locator(`#${id}-dialog`).evaluate(dialog => dialog.close());
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function freshPage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => {
    window.__desktopEvents = {};
    const terminal = { writes: [], creates: 0, disposes: [], event: null };
    window.__terminal = terminal;
    window.exploreBetterDesktop = {
      aiBridge: { publishContext() {}, onAction(handler) { window.__testUiAction = handler; } },
      onShellOpen(handler) { window.__desktopEvents.shellOpen = handler; },
      onBackendRecovered(handler) { window.__desktopEvents.recovered = handler; },
      terminal: {
        capabilities: async () => ({ available: true, profiles: [{ id: "command-prompt", label: "Command Prompt" }] }),
        create: async request => ({ sessionId: `fixture-${++terminal.creates}`, cwd: request.cwd, profileId: "command-prompt", profileLabel: "Command Prompt" }),
        dispose: async id => { terminal.disposes.push(id); if (terminal.disposeWait) await new Promise(resolve => { terminal.disposeRelease = resolve; }); return true; },
        onEvent: listener => { terminal.event = listener; return () => {}; },
        write: (id, data) => terminal.writes.push({ id, data }), resize() {}, syncDirectory: async () => ({})
      }
    };
  });
  await page.route("**/api/windows/devices?**", route => route.fulfill({ json: { status: "ready", groups: {}, counts: {} } }));
  await page.goto(`${url}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(target)}`);
  await page.waitForFunction(() => Boolean(window.__exploreBetterStartup?.completedAt));
  return page;
}
async function test(id, callback) {
  let page, timeout;
  try { page = await freshPage(); await Promise.race([callback(page), new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out: ${id}`)), 30000);
  })]); checks.push({ id, ok: true }); }
  catch (error) { checks.push({ id, ok: false, detail: error.stack }); }
  finally { clearTimeout(timeout); gates.forEach(value => value.release()); await page?.close(); }
}
try {
  for (let index = 0; index < 150; index++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    if (server.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: process.env.EB_INTERACTION_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  await test("latest-search-response-wins", async page => {
    const old = gate();
    await page.route("**/api/search", async route => {
      const body = route.request().postDataJSON();
      if (body.query === "old") { old.arrive(); await old.allowed; }
      await route.fulfill({ json: result(fixture, `${body.query}.txt`) }).catch(() => {});
    });
    await view(page, "search"); await page.locator("#search-name").fill("old"); await submit(page, "search"); await old.received;
    await page.locator("#search-name").fill("new"); await submit(page, "search");
    await page.waitForFunction(() => document.getElementById("search-results").textContent.includes("new.txt"));
    old.release(); await settle(page); await page.waitForTimeout(100);
    assert.match(await page.locator('[data-list="left"]').innerText(), /new\.txt/);
    assert.doesNotMatch(await page.locator('[data-list="left"]').innerText(), /old\.txt/);
  });
  await test("closed-search-cannot-replace-new-tab", async page => {
    const old = gate();
    await page.route("**/api/search", async route => { old.arrive(); await old.allowed; await route.fulfill({ json: result(fixture, "stale.txt") }).catch(() => {}); });
    await view(page, "search"); await submit(page, "search"); await old.received; await closeDialog(page, "search");
    await ui(page, { type: "show", pane: "left", path: target, mode: "newTab" });
    old.release(); await settle(page); await page.waitForTimeout(100);
    assert.match(await page.locator('[data-list="left"]').innerText(), /target\.txt/);
    assert.doesNotMatch(await page.locator('[data-list="left"]').innerText(), /stale\.txt/);
  });
  for (const kind of ["bulk", "transfer"]) await test(`${kind}-closed-apply-cannot-submit-new-dialog`, async page => {
    const api = kind === "bulk" ? "bulk-rename" : "transfer", old = gate(), commits = [];
    let defer = false;
    await page.route(`**/api/${api}/preview`, async route => {
      if (defer) { defer = false; old.arrive(); await old.allowed; }
      await route.fulfill({ json: { canApply: true, items: [], counts: {}, planDigest: "fixture", applyToken: "fixture" } }).catch(() => {});
    });
    await page.route(`**/api/${api}`, async route => { commits.push(route.request().postDataJSON()); await route.fulfill({ json: { renamed: [], transferred: [], mode: "copy" } }); });
    await select(page, "alpha.txt"); await view(page, kind === "bulk" ? "bulkRename" : "transfer");
    await page.locator(`#${kind}-apply`).waitFor({ state: "visible" });
    await page.waitForFunction(kind => !document.getElementById(`${kind}-apply`).disabled, kind);
    defer = true; await page.locator(`#${kind}-apply`).click(); await old.received;
    await closeDialog(page, kind); await select(page, "beta.txt"); await view(page, kind === "bulk" ? "bulkRename" : "transfer");
    await page.waitForFunction(kind => !document.getElementById(`${kind}-apply`).disabled, kind);
    old.release(); await settle(page); await page.waitForTimeout(100);
    assert.equal(commits.length, 0, `stale Apply submitted ${JSON.stringify(commits)}`);
    assert.ok(await page.locator(`#${kind}-dialog`).evaluate(dialog => dialog.open));
  });
  await test("desktop-events-preserve-draft-and-focus", async page => {
    await select(page, "alpha.txt"); await view(page, "editor");
    await page.waitForFunction(() => !document.getElementById("text-editor-content").disabled);
    await page.locator("#text-editor-content").fill("Unsaved desktop draft");
    await page.evaluate(targetPath => window.__desktopEvents.shellOpen({ targetPath, shellMode: "activeNewTab" }), target);
    await page.evaluate(() => window.__desktopEvents.recovered({}));
    assert.equal(await page.locator("#text-editor-content").inputValue(), "Unsaved desktop draft");
    assert.equal(await page.evaluate(() => document.activeElement.id), "text-editor-content");
    assert.ok(await page.locator("#text-editor-dialog").evaluate(dialog => dialog.open));
    assert.ok(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }));
  });
  await test("all-dialogs-have-accessible-names", async page => {
    const unnamed = await page.evaluate(() => [...document.querySelectorAll("dialog")].filter(dialog => {
      if (dialog.getAttribute("aria-label")?.trim()) return false;
      return !(dialog.getAttribute("aria-labelledby") || "").split(/\s+/).some(id => document.getElementById(id)?.textContent?.trim());
    }).map(dialog => dialog.id));
    assert.deepEqual(unnamed, []);
  });
  for (const kind of ["flat", "duplicates"]) await test(`closed-${kind}-cannot-replace-new-tab`, async page => {
    const old = gate();
    await page.route(`**/api/${kind}`, async route => { old.arrive(); await old.allowed; await route.fulfill({ json: { ...result(fixture, "stale.txt"), groups: [], groupCount: 0 } }).catch(() => {}); });
    await view(page, kind); await submit(page, kind); await old.received; await closeDialog(page, kind);
    await ui(page, { type: "show", pane: "left", path: target, mode: "newTab" });
    old.release(); await settle(page); await page.waitForTimeout(100);
    assert.match(await page.locator('[data-list="left"]').innerText(), /target\.txt/);
  });
  await test("compare-response-cannot-revive-old-criteria", async page => {
    const old = gate();
    await page.route("**/api/compare", async route => { old.arrive(); await old.allowed; await route.fulfill({ json: { entries: [{ relative: "stale-compare.txt", status: "leftOnly" }], counts: {} } }).catch(() => {}); });
    await view(page, "compare"); await submit(page, "compare"); await old.received;
    await page.locator("#compare-left").fill(target); old.release(); await settle(page); await page.waitForTimeout(100);
    assert.doesNotMatch(await page.locator("#compare-results").innerText(), /stale-compare/);
    assert.ok(await page.locator("#compare-sync-apply").isDisabled());
  });
  await test("operation-poll-keeps-keyboard-focus", async page => {
    let completed = 0;
    await page.route("**/api/state", async route => {
      const response = await route.fetch(), state = await response.json();
      state.operations = [{ id: "fixture-operation", type: "copy", label: "Fixture operation", status: "running", progress: { total: 10, completed }, undo: {} }];
      await route.fulfill({ json: state });
    });
    await page.locator('[data-topbar-action="ops"]').first().dispatchEvent("click");
    await page.waitForSelector("#ops-dialog[open]");
    const button = page.locator('[data-cancel-operation="fixture-operation"]'); await button.focus();
    completed = 1; await page.evaluate(() => window.__desktopEvents.recovered({}));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.cancelOperation), "fixture-operation");
    assert.match(await page.locator("#operation-list").innerText(), /1\/10/);
  });
  await test("cached-tab-activation-cancels-old-navigation", async page => {
    const pendingPath = path.join(run, "Pending"), old = gate();
    await fs.mkdir(pendingPath, { recursive: true }); await fs.writeFile(path.join(pendingPath, "pending.txt"), "pending");
    await ui(page, { type: "show", pane: "left", path: target, mode: "newTab" });
    await ui(page, { type: "semantic", actionId: "tab.select", pane: "left", inputs: { index: 0 } });
    await page.route("**/api/list?**", async route => {
      if (new URL(route.request().url()).searchParams.get("path") !== pendingPath) return route.continue();
      old.arrive(); await old.allowed; await route.fulfill({ json: { path: pendingPath, entries: [entry(pendingPath, "pending.txt")], parent: run } }).catch(() => {});
    });
    await page.evaluate(path => { window.__pendingNavigation = window.__testUiAction({ type: "show", pane: "left", path }); }, pendingPath);
    await old.received;
    await ui(page, { type: "semantic", actionId: "tab.select", pane: "left", inputs: { index: 1 } });
    old.release(); await page.evaluate(() => window.__pendingNavigation);
    await ui(page, { type: "semantic", actionId: "tab.select", pane: "left", inputs: { index: 0 } });
    assert.match(await page.locator('[data-list="left"]').innerText(), /alpha\.txt/);
    assert.doesNotMatch(await page.locator('[data-list="left"]').innerText(), /pending\.txt/);
  });
  await test("terminal-paste-shortcut-runs-once", async page => {
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: { readText: async () => "clipboard fixture", writeText: async () => {} } }));
    await page.locator('[data-terminal-toggle="left"]').click();
    await page.waitForSelector('[data-terminal-host="left"] .xterm-helper-textarea', { state: "attached" });
    await page.locator('[data-terminal-host="left"] .xterm-helper-textarea').focus();
    await page.keyboard.press("Control+Shift+V"); await settle(page);
    const writes = await page.evaluate(() => window.__terminal.writes.filter(item => item.data.includes("clipboard fixture")));
    assert.equal(writes.length, 1, JSON.stringify(writes));
  });
  for (const outcome of ["canceled", "created"]) await test(`terminal-reopen-waits-for-${outcome}-restart`, async page => {
    await page.locator('[data-terminal-toggle="left"]').click();
    await page.waitForSelector('[data-terminal-host="left"] .xterm-helper-textarea', { state: "attached" });
    await page.evaluate(outcome => {
      const bridge = window.exploreBetterDesktop.terminal, terminal = window.__terminal;
      const create = bridge.create, dispose = bridge.dispose;
      terminal.earlyCreates = 0;
      terminal.restarts = 0;
      bridge.create = async request => {
        if (terminal.restartPending || terminal.cleanupPending) {
          terminal.earlyCreates++;
          throw new Error("This tab already owns a terminal.");
        }
        return create(request);
      };
      bridge.restart = async (id, request) => {
        terminal.restarts++;
        terminal.restartPending = true;
        await new Promise(resolve => { terminal.restartRelease = resolve; });
        terminal.restartPending = false;
        if (outcome === "canceled") throw new Error("Terminal was closed while starting.");
        return { sessionId: "fixture-restarted", cwd: request.cwd, profileId: "command-prompt", profileLabel: "Command Prompt" };
      };
      bridge.dispose = async id => {
        if (id === "fixture-restarted") {
          terminal.cleanupPending = true;
          await new Promise(resolve => { terminal.cleanupRelease = resolve; });
          terminal.cleanupPending = false;
        }
        return dispose(id);
      };
    }, outcome);
    await page.locator('[data-terminal-action="restart"][data-pane="left"]').click();
    await page.waitForFunction(() => window.__terminal.restartPending);
    await page.locator('[data-terminal-action="restart"][data-pane="left"]').dispatchEvent("click");
    await page.locator('[data-terminal-action="close"][data-pane="left"]').click();
    await page.waitForFunction(() => window.__terminal.disposes.length === 1);
    await page.locator('[data-terminal-toggle="left"]').click();
    await settle(page);
    assert.equal(await page.evaluate(() => window.__terminal.creates), 1);
    assert.equal(await page.evaluate(() => window.__terminal.restarts), 1);
    await page.evaluate(() => window.__terminal.restartRelease());
    if (outcome === "created") {
      await page.waitForFunction(() => window.__terminal.cleanupPending);
      await settle(page);
      assert.equal(await page.evaluate(() => window.__terminal.creates), 1, "Reopen must also wait for disposal of the late restarted session");
      await page.evaluate(() => window.__terminal.cleanupRelease());
    }
    await page.waitForFunction(() => window.__terminal.creates === 2);
    assert.equal(await page.evaluate(() => window.__terminal.earlyCreates), 0);
    await page.waitForFunction(() => !document.querySelector('[data-terminal-action="restart"][data-pane="left"]').disabled);
  });
  await test("concurrent-tab-close-removes-only-original-tab", async page => {
    await ui(page, { type: "show", pane: "left", path: target, mode: "newTab" });
    await ui(page, { type: "show", pane: "left", path: fixture, mode: "newTab" });
    await page.locator('[data-terminal-toggle="left"]').click();
    await page.waitForSelector('[data-terminal-host="left"] .xterm-helper-textarea', { state: "attached" });
    await page.evaluate(() => { window.__terminal.disposeWait = true; window.__firstClose = window.__testUiAction({ type: "semantic", actionId: "tab.close", pane: "left", inputs: {} }); });
    await page.waitForFunction(() => typeof window.__terminal.disposeRelease === "function");
    await ui(page, { type: "semantic", actionId: "tab.close", pane: "left", inputs: {} });
    await page.evaluate(() => window.__terminal.disposeRelease()); await page.evaluate(() => window.__firstClose);
    const description = await ui(page, { type: "describe", request: { type: "semantic", actionId: "tab.select", pane: "left", inputs: { index: 1 } } });
    assert.ok(description.paths.includes(target), JSON.stringify(description));
  });
  const source = await fs.readFile(path.join(root, "public", "app.js"), "utf8");
  try {
    const start = source.indexOf("function queueEarlyTerminalEvent("), end = source.indexOf("function handleTerminalEvent(", start);
    const terminals = { sessions: new Map(), earlyEvents: new Map(), retiredSessions: new Set(), bySessionId: new Map() };
    const context = vm.createContext({ app: { terminals } }); vm.runInContext(source.slice(start, end), context);
    vm.runInContext('for(let i=0;i<10000;i++) queueEarlyTerminalEvent({sessionId:`late-${i}`,type:"data",data:"late"})', context);
    assert.equal(terminals.earlyEvents.size, 0);
    terminals.sessions.set("pending", { starting: true });
    vm.runInContext('for(let i=0;i<100;i++) queueEarlyTerminalEvent({sessionId:`pending-${i}`,type:"data",data:"x".repeat(500000)})', context);
    assert.ok(terminals.earlyEvents.size <= 16);
    assert.ok([...terminals.earlyEvents.values()].every(queue => queue.reduce((sum, item) => sum + (item.data?.length || 0), 0) <= 262144));
    vm.runInContext('retireTerminalSession("retired"); queueEarlyTerminalEvent({sessionId:"retired",type:"data",data:"late"})', context);
    assert.ok(!terminals.earlyEvents.has("retired"));
    checks.push({ id: "early-terminal-events-have-bounded-lifetime", ok: true });
  } catch (error) { checks.push({ id: "early-terminal-events-have-bounded-lifetime", ok: false, detail: error.stack }); }
  try {
    const start = source.indexOf("function flattenedModelArray("), end = source.indexOf("function modelMaterial(", start);
    const geometry = vm.runInNewContext(`${source.slice(start, end)}; stepModelGeometry({attributes:{position:{array:[0,0,0,1,0,0,1,1,0,0,1,0]}},index:{array:[0,1,2,0,2,3]}})`, { THREE, Uint32Array });
    assert.deepEqual(Array.from(geometry.getAttribute("normal").array), [0,0,1,0,0,1,0,0,1,0,0,1]); geometry.dispose();
    checks.push({ id: "indexed-step-normals-use-triangles", ok: true });
  } catch (error) { checks.push({ id: "indexed-step-normals-use-triangles", ok: false, detail: error.stack }); }
} catch (error) { checks.push({ id: "runtime", ok: false, detail: error.stack }); }
finally {
  gates.forEach(value => value.release()); await browser?.close(); server.kill();
  const report = { checks, run };
  await fs.writeFile(path.join(root, "artifacts", process.env.EB_ASYNC_REPORT || "renderer-async-regression-latest.json"), JSON.stringify(report, null, 2));
  console.log(`Renderer async regressions: ${checks.filter(item => item.ok).length} pass, ${checks.filter(item => !item.ok).length} fail`);
  checks.filter(item => !item.ok).forEach(item => console.error(`${item.id}: ${item.detail}`));
  if (checks.some(item => !item.ok)) process.exitCode = 1;
}
