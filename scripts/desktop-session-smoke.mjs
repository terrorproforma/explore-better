import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const root = process.cwd();
const run = await fs.mkdtemp(path.join(root, "artifacts", "desktop-session-"));
const fixture = path.join(run, "Files"), target = path.join(run, "Opened from Windows"), appData = path.join(run, "appdata");
await Promise.all([fixture, target, appData].map(folder => fs.mkdir(folder, { recursive: true })));
await fs.writeFile(path.join(fixture, "draft.txt"), "original text\n");
await fs.writeFile(path.join(target, "target.txt"), "external folder\n");
let desktop, page;
const checks = [];
const check = (name, passed) => { checks.push({ name, passed }); assert.ok(passed, name); };
try {
  const env = { ...process.env, LOCALAPPDATA: appData, APPDATA: appData, EXPLORE_BETTER_USER_DATA_DIR: path.join(run, "electron"),
    EXPLORE_BETTER_WORKSPACE_ROOT: fixture, EXPLORE_BETTER_DISABLE_GPU: "1", EXPLORE_BETTER_DISABLE_STATE_WATCH: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: path.join(root, "node_modules", "electron", "dist", "electron.exe"),
    args: [root, fixture, "--shell-mode=leftReplace", "--no-updates"], env, timeout: 30_000 });
  page = await desktop.firstWindow();
  // Electron handles beforeunload through will-prevent-unload; suppress the
  // browser driver's automatic dialog reply racing that native decision.
  page.on("dialog", dialog => { if (dialog.type() !== "beforeunload") void dialog.dismiss().catch(() => {}); });
  await page.waitForFunction(() => Boolean(window.__exploreBetterStartup?.completedAt));
  await page.evaluate(() => {
    window.__sessionIdentity = crypto.randomUUID();
    window.__sessionTerminalEvents = [];
    window.exploreBetterDesktop.terminal.onEvent(event => window.__sessionTerminalEvents.push(event));
  });
  const identity = await page.evaluate(() => window.__sessionIdentity);
  const terminal = await page.evaluate(cwd => window.exploreBetterDesktop.terminal.create({ tabId: "desktop-session-test", cwd, profileId: "command-prompt", cols: 80, rows: 24 }), fixture);
  await page.waitForFunction(id => window.__sessionTerminalEvents.some(event => event.sessionId === id && event.type === "data"), terminal.sessionId);
  await page.locator('[data-list="left"] [data-entry-path]').filter({ hasText: "draft.txt" }).first().click();
  await page.locator('.command-dock [data-global-action="editText"]').dispatchEvent("click");
  await page.waitForSelector("#text-editor-dialog[open]");
  const editor = page.locator("#text-editor-content");
  await editor.fill("unsaved desktop draft\n");

  await desktop.evaluate(({ app }, root) => { app.emit("second-instance", {}, [process.execPath, root]); }, root);
  await page.waitForTimeout(150);
  check("second activation preserves the document and draft", await page.evaluate(() => window.__sessionIdentity) === identity && await editor.inputValue() === "unsaved desktop draft\n");

  await desktop.evaluate(({ app }, { root, target }) => { app.emit("second-instance", {}, [process.execPath, root, target, "--shell-mode=activeNewTab"]); }, { root, target });
  await page.waitForFunction(target => document.querySelector('[data-path-input="left"]')?.value === target, target);
  check("external folder opens without replacing the document", await page.evaluate(() => window.__sessionIdentity) === identity);
  check("external folder keeps the editor draft and its focus", await editor.inputValue() === "unsaved desktop draft\n" && await editor.evaluate(element => document.activeElement === element));

  const recovered = await page.evaluate(() => window.exploreBetterDesktop.restartBackend());
  check("backend recovery restores service without reloading", recovered.ready && await page.evaluate(() => window.__sessionIdentity) === identity);
  check("backend recovery retains the dirty editor", await editor.inputValue() === "unsaved desktop draft\n" && await page.locator("#text-editor-dialog").evaluate(element => element.open));
  await page.evaluate(id => window.exploreBetterDesktop.terminal.write(id, "echo EB_DESKTOP_SESSION_ALIVE\r"), terminal.sessionId);
  await page.waitForFunction(id => window.__sessionTerminalEvents.some(event => event.sessionId === id && event.type === "data" && event.data.includes("EB_DESKTOP_SESSION_ALIVE")), terminal.sessionId);
  check("native terminal survives activation and backend recovery", !(await page.evaluate(id => window.__sessionTerminalEvents.some(event => event.sessionId === id && event.type === "exit"), terminal.sessionId)));

  await desktop.evaluate(({ dialog, BrowserWindow }) => {
    globalThis.__sessionClosePrompts = 0;
    dialog.showMessageBoxSync = () => { globalThis.__sessionClosePrompts++; return 0; };
    BrowserWindow.getAllWindows()[0].close();
  });
  await page.waitForTimeout(150);
  check("canceling window close preserves unsaved changes", await desktop.evaluate(() => globalThis.__sessionClosePrompts) === 1 && await editor.inputValue() === "unsaved desktop draft\n");
  await page.evaluate(id => window.exploreBetterDesktop.terminal.write(id, "echo EB_CLOSE_CANCELED\r"), terminal.sessionId);
  await page.waitForFunction(id => window.__sessionTerminalEvents.some(event => event.sessionId === id && event.type === "data" && event.data.includes("EB_CLOSE_CANCELED")), terminal.sessionId);
  check("canceling close preserves the running terminal", !(await page.evaluate(id => window.__sessionTerminalEvents.some(event => event.sessionId === id && event.type === "exit"), terminal.sessionId)));
  await page.screenshot({ path: path.join(root, "artifacts", "desktop-session-latest.png") });
  await page.evaluate(id => window.exploreBetterDesktop.terminal.dispose(id), terminal.sessionId);
  await editor.fill("original text\n");
  await desktop.close(); desktop = null;
  console.log(`Desktop session: ${checks.length} passed.`);
} finally {
  if (desktop) {
    await desktop.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {});
    await desktop.close().catch(() => {});
  }
  await fs.writeFile(path.join(root, "artifacts", "desktop-session-latest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), passed: checks.length === 8 && checks.every(item => item.passed), checks, run }, null, 2));
}
