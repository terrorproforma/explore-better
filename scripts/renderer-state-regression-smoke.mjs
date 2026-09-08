import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright-core";

const root = process.cwd();
const run = path.join(root, "artifacts", `renderer-state-${Date.now()}`);
const fixture = path.join(run, "Files");
const target = path.join(run, "Target");
const large = path.join(run, "a".repeat(110));
const appData = path.join(run, "appdata");
const deviceLeft = path.join(run, "DevicesLeft"), deviceRight = path.join(run, "DevicesRight");
const deviceLeftChild = path.join(deviceLeft, "child"), deviceRightChild = path.join(deviceRight, "child");
const devicePreview = path.join(deviceRightChild, "preview.txt");
await Promise.all([fixture, target, large, appData, deviceLeftChild, deviceRightChild].map(folder => fs.mkdir(folder, { recursive: true })));
await fs.writeFile(devicePreview, "Ordinary fixture preview\n");
const alpha = path.join(fixture, "alpha.txt"), beta = path.join(fixture, "beta.txt");
await fs.writeFile(alpha, "original alpha\n");
await fs.writeFile(beta, "original beta\n");
await Promise.all(Array.from({ length: 350 }, (_, index) => fs.writeFile(path.join(fixture, `item-${String(index).padStart(3, "0")}.txt`), "item")));
const port = await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), APPDATA: appData, LOCALAPPDATA: appData }
});
let output = "", browser;
server.stdout.on("data", data => { output += data; }); server.stderr.on("data", data => { output += data; });
const checks = [];
const check = (id, ok, detail = "") => { checks.push({ id, ok, detail }); assert.ok(ok, `${id}: ${detail}`); };
const gate = () => {
  let release, arrive;
  const allowed = new Promise(resolve => { release = resolve; });
  const received = new Promise(resolve => { arrive = resolve; });
  return { release, arrive, allowed, received };
};
try {
  let ready = false;
  for (let index = 0; index < 150; index++) {
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch {}
    if (server.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, output);
  browser = await chromium.launch({ executablePath: process.env.EB_INTERACTION_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.addInitScript(() => {
    const state = { creates: [], disposes: [], sessions: new Map(), wait: false, release: null, next: 1 };
    window.__testTerminal = state;
    window.exploreBetterDesktop = {
      aiBridge: { publishContext() {}, onAction(handler) { window.__testUiAction = handler; } },
      terminal: {
        capabilities: async () => ({ available: true, profiles: [{ id: "command-prompt", label: "Command Prompt" }] }),
        create: async request => {
          const id = `test-${state.next++}`; state.creates.push(id);
          if (state.wait) await new Promise(resolve => { state.release = resolve; });
          state.sessions.set(id, request);
          return { sessionId: id, cwd: request.cwd, profileId: "command-prompt", profileLabel: "Command Prompt" };
        },
        dispose: async id => { state.disposes.push(id); state.sessions.delete(id); return true; },
        onEvent: () => () => {}, write() {}, resize() {}, syncDirectory: async () => ({})
      }
    };
  });
  let systemClipboard = { mode: "copy", paths: [], sequence: 1 };
  let saveGate = null, transferGate = null, previewApplies = false;
  const previewPaths = [], clearRequests = [];
  await page.route("**/api/windows/devices?**", route => route.fulfill({ json: {
    status: "ready", generatedAt: new Date().toISOString(), counts: {}, networkLoaded: true,
    groups: { drives: [{ id: "fixture-device", name: "Fixture device", path: deviceRightChild, capabilities: { browseInApp: true } }] }
  } }));
  await page.route("**/api/clipboard/files", async route => {
    if (route.request().method() === "POST") systemClipboard = { ...JSON.parse(route.request().postData()), sequence: systemClipboard.sequence + 1 };
    await route.fulfill({ json: { ok: true, ...systemClipboard } });
  });
  await page.route("**/api/clipboard/files/clear", async route => {
    const body = JSON.parse(route.request().postData() || "{}"); clearRequests.push(body);
    const cleared = body.expectedSequence === undefined || body.expectedSequence === systemClipboard.sequence;
    if (cleared) systemClipboard = { mode: "copy", paths: [], sequence: systemClipboard.sequence + 1 };
    await route.fulfill({ json: { ok: true, cleared } });
  });
  await page.route("**/api/transfer/preview", async route => {
    previewPaths.push(JSON.parse(route.request().postData()).paths);
    await route.fulfill({ json: { canApply: previewApplies, items: [], counts: { skip: previewApplies ? 0 : 1 }, planDigest: "test-plan", applyToken: "test-token" } });
  });
  await page.route("**/api/transfer", async route => {
    const active = transferGate; active?.arrive(); if (active) await active.allowed;
    await route.fulfill({ json: { transferred: [alpha], skipped: [] } });
  });
  await page.route("**/api/text/save", async route => {
    const active = saveGate; const response = await route.fetch(); active?.arrive(); if (active) await active.allowed;
    await route.fulfill({ response });
  });
  await page.goto(`${url}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(target)}`);
  await page.waitForFunction(() => Boolean(window.__exploreBetterStartup?.completedAt));
  const list = page.locator('[data-list="left"]');
  const select = async name => {
    await list.evaluate(element => { element.scrollTop = 0; });
    await list.locator(`[data-entry-path=${JSON.stringify(path.join(fixture, name))}]`).click();
  };
  const action = id => page.locator(`.command-dock [data-global-action="${id}"]`).dispatchEvent("click");
  const editor = page.locator("#text-editor-content");
  await select("alpha.txt"); await action("editText"); await page.waitForSelector("#text-editor-dialog[open]");
  saveGate = gate(); await editor.fill("saved snapshot\n"); await page.locator("#text-editor-form").evaluate(form => form.requestSubmit());
  await saveGate.received; await editor.fill("newer unsaved draft\n"); saveGate.release();
  await page.waitForFunction(() => /newer changes are unsaved/.test(document.getElementById("text-editor-summary").textContent));
  check("save-keeps-newer-edits-dirty", await fs.readFile(alpha, "utf8") === "saved snapshot\n" && await editor.inputValue() === "newer unsaved draft\n");
  for (const request of [{ type: "view", view: "editor", visible: false }, { type: "semantic", actionId: "dialog.closeActive", inputs: {} }]) {
    const result = await page.evaluate(request => window.__testUiAction(request), request);
    check(`mcp-${request.type}-keeps-unsaved-editor`, result.__exploreBetterUiError?.code === "UI_BLOCKED" && await page.locator("#text-editor-dialog").evaluate(dialog => dialog.open));
  }
  let discardPrompts = 0;
  const dismiss = async dialog => { discardPrompts++; await dialog.dismiss(); };
  page.once("dialog", dismiss); await page.locator('[data-close-dialog="text-editor-dialog"]').click();
  check("close-prompts-after-pending-save-edit", discardPrompts === 1 && await page.locator("#text-editor-dialog").evaluate(dialog => dialog.open));
  saveGate = gate(); await page.locator("#text-editor-form").evaluate(form => form.requestSubmit()); await saveGate.received;
  page.once("dialog", dialog => dialog.accept()); await page.locator('[data-close-dialog="text-editor-dialog"]').click();
  await select("beta.txt"); await action("editText"); await page.waitForSelector("#text-editor-dialog[open]"); await editor.fill("beta unsaved draft\n");
  const olderSaved = page.evaluate(() => new Promise(resolve => {
    const toast = document.getElementById("toast");
    const observer = new MutationObserver(() => { if (toast.textContent === "Text saved") { observer.disconnect(); resolve(); } });
    observer.observe(toast, { childList: true, characterData: true, subtree: true });
  }));
  saveGate.release(); await olderSaved;
  check("older-save-does-not-change-new-editor", await page.locator("#text-editor-path").inputValue() === beta && await editor.inputValue() === "beta unsaved draft\n");
  page.once("dialog", dismiss); await page.locator('[data-close-dialog="text-editor-dialog"]').click();
  check("new-editor-still-dirty-after-older-save", discardPrompts === 2 && await page.locator("#text-editor-dialog").evaluate(dialog => dialog.open));
  page.once("dialog", dialog => dialog.accept()); await page.locator('[data-close-dialog="text-editor-dialog"]').click();
  await select("alpha.txt"); const firstCopy = page.waitForResponse(response => response.url().endsWith("/api/clipboard/files") && response.request().method() === "POST"); await action("clipCopy"); await firstCopy;
  systemClipboard = { mode: "copy", paths: [beta], sequence: systemClipboard.sequence + 1 };
  await action("clipPaste"); await page.waitForFunction(() => /Paste skipped/.test(document.getElementById("toast").textContent));
  check("paste-uses-newer-system-clipboard", previewPaths.at(-1)?.[0] === beta);
  systemClipboard = { mode: "move", paths: [alpha], sequence: systemClipboard.sequence + 1 };
  const cutSequence = systemClipboard.sequence; previewApplies = true; transferGate = gate();
  await page.locator('[data-list="right"]').click(); await action("clipPaste"); await transferGate.received;
  await select("beta.txt"); const copied = page.waitForResponse(response => response.url().endsWith("/api/clipboard/files") && response.request().method() === "POST"); await action("clipCopy"); await copied;
  transferGate.release(); await page.waitForFunction(() => /pasted/.test(document.getElementById("toast").textContent));
  check("finished-cut-keeps-newer-clipboard", systemClipboard.paths[0] === beta && systemClipboard.mode === "copy" && clearRequests.at(-1)?.expectedSequence === cutSequence);
  await select("alpha.txt");
  const description = await page.evaluate(() => window.__testUiAction({ type: "describe", request: { type: "view", view: "editor", pane: "left" } }));
  check("describe-reports-implicit-editor-target", description.paths?.[0] === alpha && Number.isInteger(description.contextRevision), JSON.stringify({ description, alpha }));
  const stale = await page.evaluate(() => window.__testUiAction({ type: "semantic", actionId: "pane.activate", pane: "left", expectedContextRevision: -1 }));
  check("dispatcher-rejects-stale-authorization", stale.__exploreBetterUiError?.code === "STALE_CONTEXT");
  await select("beta.txt");
  const changedTarget = await page.evaluate(token => window.__testUiAction({ type: "view", view: "editor", pane: "left", expectedDescriptionToken: token }), description.descriptionToken);
  check("dispatcher-binds-the-actual-implicit-target", changedTarget.__exploreBetterUiError?.code === "STALE_CONTEXT" && await page.locator("#text-editor-dialog").evaluate(dialog => !dialog.open));
  await page.evaluate(() => { window.__testTerminal.wait = true; });
  await page.locator('[data-terminal-toggle="left"]').click(); await page.waitForFunction(() => Boolean(window.__testTerminal.release));
  await page.locator('[data-terminal-action="close"][data-pane="left"]').click();
  await page.locator('[data-terminal-toggle="left"]').click();
  check("reopening-waits-for-closed-creation", await page.evaluate(() => window.__testTerminal.creates.length) === 1);
  await page.evaluate(() => { window.__testTerminal.wait = false; window.__testTerminal.release(); });
  await page.waitForFunction(() => window.__testTerminal.creates.length === 2 && window.__testTerminal.disposes.length === 1);
  await page.waitForSelector('[data-terminal-host="left"] .xterm');
  check("closed-starting-terminal-is-disposed", await page.evaluate(() => window.__testTerminal.disposes[0] === window.__testTerminal.creates[0] && window.__testTerminal.sessions.size === 1));
  await page.locator('[data-terminal-action="close"][data-pane="left"]').click();
  for (const view of ["details", "compact", "tiles"]) {
    await page.locator(`[data-view-mode="${view}"][data-pane="left"]`).click(); await list.focus(); await page.keyboard.press("End");
    await list.evaluate(element => { element.scrollTop = 0; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const accessible = await list.evaluate(element => {
      const active = document.getElementById(element.getAttribute("aria-activedescendant"));
      return { exists: Boolean(active), position: active?.getAttribute("aria-posinset"), total: active?.getAttribute("aria-setsize"), count: element.querySelectorAll('[role="option"]').length };
    });
    check(`${view}-keeps-offscreen-active-option`, accessible.exists && accessible.position === accessible.total && Number(accessible.total) >= 352 && accessible.count < 200, JSON.stringify(accessible));
  }
  const model = await page.evaluate(async () => {
    const triangles = 100_001, buffer = new ArrayBuffer(84 + triangles * 50), view = new DataView(buffer); view.setUint32(80, triangles, true);
    for (let index = 0; index < triangles; index++) { const offset = 84 + index * 50; view.setFloat32(offset + 24, 1, true); view.setFloat32(offset + 40, 1, true); }
    let ticks = 0; const timer = setInterval(() => ticks++, 1); const worker = new Worker("/generated/model-worker.js");
    try { return await new Promise((resolve, reject) => { worker.onmessage = ({ data }) => resolve({ ticks, positions: data.positions?.length, edges: data.edges?.length || 0, error: data.error }); worker.onerror = reject; worker.postMessage({ buffer }, [buffer]); }); }
    finally { clearInterval(timer); worker.terminate(); }
  });
  check("large-stl-prepares-off-thread-with-bounded-edges", model.ticks > 0 && model.positions === 900_009 && model.edges === 0 && !model.error, JSON.stringify(model));
  const uiAction = request => page.evaluate(request => window.__testUiAction(request), request);
  const panePath = pane => page.locator(`[data-path-input="${pane}"]`).inputValue();
  const describedAction = request => page.evaluate(async request => {
    const descriptor = await window.__testUiAction({ type: "describe", request });
    const result = await window.__testUiAction({ ...request, expectedDescriptionToken: descriptor.descriptionToken, expectedContextRevision: descriptor.contextRevision });
    return { descriptor, result };
  }, request);
  for (const linked of [false, true]) {
    await uiAction({ type: "show", pane: "left", path: deviceLeft });
    await uiAction({ type: "show", pane: "right", path: deviceRight });
    if (linked) {
      await page.locator("#linked-navigation-toggle").check();
      await page.waitForFunction(() => document.getElementById("toast").textContent === "Linked panes on");
    }
    await uiAction({ type: "view", view: "devices", pane: "left" });
    await page.waitForFunction(() => document.getElementById("devices-refresh").disabled === false);
    const request = { type: "semantic", actionId: "devices.browse", pane: "right", inputs: { deviceId: "fixture-device", action: "browseInApp" } };
    const { descriptor, result } = await describedAction(request);
    const expectedPaths = linked ? [deviceRightChild, deviceLeftChild] : [deviceRightChild];
    check(`device-browse-${linked ? "linked" : "unlinked"}-describes-executed-targets`,
      !result.__exploreBetterUiError && JSON.stringify(descriptor.paths) === JSON.stringify(expectedPaths) &&
      await panePath("right") === deviceRightChild && await panePath("left") === (linked ? deviceLeftChild : deviceLeft) && result.state?.pane === "right",
      JSON.stringify({ descriptor, result, left: await panePath("left"), right: await panePath("right") }));
  }
  for (const [id, request, expected] of [
    ["show-new-tab", { type: "show", pane: "right", path: deviceRight, mode: "newTab" }, deviceRight],
    ["result-new-tab", { type: "semantic", pane: "right", actionId: "result.open", inputs: { path: deviceRightChild, mode: "newTab" } }, deviceRightChild]
  ]) {
    const { descriptor, result } = await describedAction(request);
    check(`${id}-does-not-describe-or-follow-linked-pane`, !result.__exploreBetterUiError &&
      JSON.stringify(descriptor.paths) === JSON.stringify([expected]) && await panePath("right") === expected && await panePath("left") === deviceLeftChild,
      JSON.stringify({ descriptor, result }));
  }
  await page.locator(`[data-list="right"] [data-entry-path=${JSON.stringify(devicePreview)}]`).click();
  const tabSelection = await describedAction({ type: "semantic", actionId: "tab.select", pane: "right", inputs: { index: 1 } });
  check("select-tab-does-not-describe-or-follow-linked-pane", !tabSelection.result.__exploreBetterUiError &&
    JSON.stringify(tabSelection.descriptor.paths) === JSON.stringify([deviceRight]) && await panePath("right") === deviceRight && await panePath("left") === deviceLeftChild,
    JSON.stringify(tabSelection));
  const closedMiddle = await describedAction({ type: "semantic", actionId: "tab.close", pane: "right", inputs: {} });
  check("close-middle-tab-describes-successor-and-preview", !closedMiddle.result.__exploreBetterUiError &&
    JSON.stringify(closedMiddle.descriptor.paths) === JSON.stringify([deviceRightChild, devicePreview]) && await panePath("right") === deviceRightChild,
    JSON.stringify(closedMiddle));
  const closedLast = await describedAction({ type: "semantic", actionId: "tab.close", pane: "right", inputs: {} });
  check("close-last-tab-describes-previous-tab", !closedLast.result.__exploreBetterUiError &&
    JSON.stringify(closedLast.descriptor.paths) === JSON.stringify([deviceRightChild]) && await panePath("right") === deviceRightChild && await panePath("left") === deviceLeftChild,
    JSON.stringify(closedLast));
  await page.close();

  const memoryPage = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const entries = Array.from({ length: 10_000 }, (_, index) => ({ name: `file-${String(index).padStart(5, "0")}.txt`, path: path.join(large, `file-${index}.txt`), parent: large, isFile: true, isDirectory: false, kind: "Text", size: 1, modified: 1 }));
  await memoryPage.route("**/api/list?**", route => route.fulfill({ json: { path: large, parent: run, entries, includeSignature: false } }));
  await memoryPage.goto(`${url}/?left=${encodeURIComponent(large)}&right=${encodeURIComponent(large)}`);
  await memoryPage.waitForFunction(() => Boolean(window.__exploreBetterStartup?.completedAt));
  const cdp = await memoryPage.context().newCDPSession(memoryPage);
  await cdp.send("HeapProfiler.collectGarbage"); const before = await cdp.send("Runtime.getHeapUsage");
  for (let index = 1; index <= 100; index++) await memoryPage.locator('[data-filter="left"]').fill("a".repeat(index));
  await cdp.send("HeapProfiler.collectGarbage"); const after = await cdp.send("Runtime.getHeapUsage");
  const growthMiB = (after.usedSize - before.usedSize) / 1024 / 1024;
  check("filter-history-has-bounded-retained-memory", growthMiB < 50, `${growthMiB.toFixed(1)} MiB after 100 filters over 10,000 entries`);
} catch (error) {
  if (!checks.some(item => !item.ok)) checks.push({ id: "runtime", ok: false, detail: error.stack });
  process.exitCode = 1;
} finally {
  await browser?.close(); server.kill();
  await fs.writeFile(path.join(root, "artifacts", "renderer-state-regression-latest.json"), JSON.stringify({ checks, run }, null, 2));
  console.log(`Renderer state regressions: ${checks.filter(item => item.ok).length} pass, ${checks.filter(item => !item.ok).length} fail`);
  checks.filter(item => !item.ok).forEach(item => console.error(item.detail || item.id));
}
