import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `scripting-api-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const leftDir = path.join(fixtureRoot, "left-pane");
const rightDir = path.join(fixtureRoot, "right-pane");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_SCRIPTING_BROWSER || "") ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  );
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_SCRIPTING_KEEP_FIXTURE === "1";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function pathExists(itemPath) {
  try {
    await fs.access(itemPath);
    return true;
  } catch {
    return false;
  }
}

async function waitForPath(itemPath, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await pathExists(itemPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${serverOutput}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}: ${serverOutput}`);
}

function startServer(port) {
  serverOutput = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  return child;
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

function directScriptCode() {
  return `
await api.emit("script-api:start", {
  activePane: context.activePane,
  otherPath: context.otherPath,
  left: context.panes.left.path,
  right: context.panes.right.path
});
await api.progress({ phase: "Inspecting panes", completed: 1, total: 4 });
const listing = await api.list(context.path);
const outputDir = await api.mkdir(context.otherPath, "script-api-output");
const notePath = await api.writeText(
  path.join(outputDir, "script-note.txt"),
  JSON.stringify({
    activePane: context.activePane,
    activePath: context.activePath,
    otherPath: context.otherPath,
    selected: context.selectedPaths
  }, null, 2)
);
await api.progress({ phase: "Copying selection", completed: 3, total: 4 });
const copied = await api.copy(context.selectedPaths, outputDir);
await api.emit("script-api:done", { copied: copied.length, notePath });
return {
  activePane: context.activePane,
  activePath: context.activePath,
  otherPath: context.otherPath,
  leftPath: context.panes.left.path,
  rightPath: context.panes.right.path,
  selectedCount: api.selected().length,
  listed: listing.entries.length,
  copied,
  notePath
};`;
}

function toolbarScriptCode(outputFileName) {
  return `
await api.emit("toolbar:clicked", {
  activePane: context.activePane,
  path: context.path,
  otherPath: context.otherPath
});
const outputPath = path.join(context.otherPath, ${JSON.stringify(outputFileName)});
await api.writeText(outputPath, JSON.stringify({
  activePane: context.activePane,
  activePath: context.activePath,
  otherPath: context.otherPath,
  leftPath: context.panes.left.path,
  rightPath: context.panes.right.path
}, null, 2));
return { toolbar: true, outputPath, otherPath: context.otherPath };`;
}

async function prepareFixture() {
  await fs.mkdir(leftDir, { recursive: true });
  await fs.mkdir(rightDir, { recursive: true });
  const selectedFile = path.join(leftDir, "selected-source.txt");
  await fs.writeFile(selectedFile, "selected from left pane\n", "utf8");
  await fs.writeFile(path.join(leftDir, "visible-extra.txt"), "extra listing row\n", "utf8");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        scripts: [
          {
            id: "toolbar-script-smoke",
            name: "Toolbar Smoke",
            description: "Writes a marker into the other pane.",
            showInToolbar: true,
            code: toolbarScriptCode("toolbar-script-ran.json"),
            updatedAt: new Date().toISOString()
          }
        ],
        operations: []
      },
      null,
      2
    ),
    "utf8"
  );
  return { selectedFile };
}

async function runDirectScript(baseUrl, fixture) {
  const result = await requestJson(baseUrl, "/api/script", {
    method: "POST",
    body: JSON.stringify({
      code: directScriptCode(),
      scriptId: "direct-script-api-smoke",
      name: "Direct Script API Smoke",
      activePane: "left",
      activePath: leftDir,
      contextPath: leftDir,
      otherPath: rightDir,
      selectedPaths: [fixture.selectedFile],
      panes: {
        left: { path: leftDir, selectedPaths: [fixture.selectedFile], focusedPath: fixture.selectedFile },
        right: { path: rightDir, selectedPaths: [], focusedPath: null }
      },
      timeoutMs: 15000
    })
  });
  assert(result.operation?.type === "script", "Direct script should be recorded as a script operation.");
  assert(result.operation?.status === "completed", "Direct script operation should complete.");
  assert(result.scriptId === "direct-script-api-smoke", "Direct script id should be recorded.");
  assert(result.selectedCount === 1, "Direct script operation should record selected count.");
  assert(result.events?.some((event) => event.name === "script-api:start"), "Direct script should emit a start event.");
  assert(result.events?.some((event) => event.name === "script-api:done"), "Direct script should emit a done event.");
  assert(result.result?.activePane === "left", "Direct script should see the active pane.");
  assert(result.result?.otherPath === rightDir, "Direct script should see the other pane path.");
  assert(result.result?.selectedCount === 1, "Direct script api.selected() should return selected paths.");
  assert(result.result?.listed >= 2, "Direct script should list the active pane.");
  const outputDir = path.join(rightDir, "script-api-output");
  const notePath = path.join(outputDir, "script-note.txt");
  const copiedPath = path.join(outputDir, "selected-source.txt");
  assert(await pathExists(notePath), "Direct script should write text output.");
  assert(await pathExists(copiedPath), "Direct script should copy selected file into the other pane.");
  const note = JSON.parse(await fs.readFile(notePath, "utf8"));
  assert(note.otherPath === rightDir, "Written script note should include other pane path.");
  return { result, notePath, copiedPath };
}

async function runToolbarScriptInBrowser(baseUrl) {
  const browser = await chromium.launch({
    executablePath: edgePath(),
    headless: true
  });
  const consoleErrors = [];
  const pageErrors = [];
  const outputPath = path.join(rightDir, "toolbar-script-ran.json");
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const url = `${baseUrl}/?${new URLSearchParams({ left: leftDir, right: rightDir })}`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__exploreBetterStartup?.completedAt), { timeout: 15000 });
    const button = page.locator('[data-run-script="toolbar-script-smoke"]');
    await button.waitFor({ state: "visible", timeout: 15000 });
    const label = await button.textContent();
    await button.click();
    assert(await waitForPath(outputPath, 15000), "Toolbar script should write its marker file.");
    const marker = JSON.parse(await fs.readFile(outputPath, "utf8"));
    assert(marker.activePane === "left", "Toolbar script should receive active pane from the browser.");
    assert(marker.otherPath === rightDir, "Toolbar script should receive browser other pane path.");
    return { label: label?.trim() || "", marker, outputPath, consoleErrors, pageErrors };
  } finally {
    await browser.close();
  }
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  const fixture = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 53000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port);
  try {
    await waitForServer(baseUrl, server);
    const direct = await runDirectScript(baseUrl, fixture);
    const toolbar = await runToolbarScriptInBrowser(baseUrl);
    assert(toolbar.consoleErrors.length === 0, `Browser console errors: ${toolbar.consoleErrors.join("; ")}`);
    assert(toolbar.pageErrors.length === 0, `Browser page errors: ${toolbar.pageErrors.join("; ")}`);
    const state = await requestJson(baseUrl, "/api/state");
    const latestScripts = state.scripts || [];
    const latestOperations = state.operations || [];
    assert(latestScripts.some((script) => script.id === "toolbar-script-smoke" && script.showInToolbar), "Saved toolbar script should remain in state.");
    assert(latestOperations.some((operation) => operation.type === "script" && operation.status === "completed"), "State should include completed script operations.");
    const report = {
      generatedAt: new Date().toISOString(),
      fixtureRoot,
      leftDir,
      rightDir,
      direct: {
        scriptId: direct.result.scriptId,
        selectedCount: direct.result.selectedCount,
        events: direct.result.events,
        result: direct.result.result,
        progress: direct.result.operation?.progress,
        notePath: direct.notePath,
        copiedPath: direct.copiedPath
      },
      toolbar,
      state: {
        scripts: latestScripts.map((script) => ({
          id: script.id,
          name: script.name,
          showInToolbar: script.showInToolbar
        })),
        scriptOperations: latestOperations
          .filter((operation) => operation.type === "script")
          .map((operation) => ({
            id: operation.id,
            status: operation.status,
            label: operation.label,
            progress: operation.progress,
            result: operation.result
          }))
      }
    };
    const outputPath = path.join(artifactsDir, "scripting-api-latest.json");
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`direct events: ${direct.result.events.map((event) => event.name).join(", ")}`);
    console.log(`direct selected: ${direct.result.result.selectedCount}`);
    console.log(`toolbar button: ${toolbar.label}`);
    console.log(`toolbar output: ${toolbar.outputPath}`);
    console.log(`wrote ${outputPath}`);
  } finally {
    await stopServer(server);
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (serverOutput) {
    console.error(serverOutput);
  }
  process.exitCode = 1;
});
