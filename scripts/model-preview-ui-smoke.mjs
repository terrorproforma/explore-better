import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `model-preview-ui-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const stlName = "sample-model.stl";
const stepName = "sample-model.step";
const stlPath = path.join(fixture, stlName);
const stepPath = path.join(fixture, stepName);
const latestJsonPath = path.join(artifactsDir, "model-preview-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "model-preview-ui-latest.md");
const screenshotPath = path.join(artifactsDir, "model-preview-step-latest.png");

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_MODEL_PREVIEW_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function waitForServer(baseUrl, child, output) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) throw new Error(`Server exited early with ${child.exitCode}: ${output()}`);
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Server did not start at ${baseUrl}: ${output()}`);
}

async function prepareFixture() {
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  const sourceRoot = path.join(workspace, "node_modules", "occt-import-js", "test", "testfiles", "cube-10x10mm");
  await fs.copyFile(path.join(sourceRoot, "Cube 10x10.stl"), stlPath);
  await fs.copyFile(path.join(sourceRoot, "Cube 10x10.stp"), stepPath);
}

function paneRow(page, name) {
  return page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: name }).first();
}

async function selectRow(page, name) {
  const row = paneRow(page, name);
  await row.waitFor({ state: "visible", timeout: 10000 });
  await row.click();
  await page.waitForFunction(
    (expected) => [...document.querySelectorAll('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]')]
      .some((item) => item.textContent.includes(expected)),
    name
  );
}

async function modelEvidence(page, scope, timeoutMs = 60000) {
  await page.waitForFunction(
    ({ targetScope }) => document.querySelector(`[data-model-viewport="${targetScope}"]`)?.dataset.modelState === "ready",
    { targetScope: scope },
    { timeout: timeoutMs }
  );
  return page.evaluate((targetScope) => {
    const root = document.querySelector(`[data-model-viewport="${targetScope}"]`);
    const canvas = root?.querySelector("canvas");
    const rect = canvas?.getBoundingClientRect();
    return {
      state: root?.dataset.modelState || "missing",
      meshes: Number(root?.dataset.meshCount || 0),
      triangles: Number(root?.dataset.triangleCount || 0),
      status: root?.querySelector("[data-model-status]")?.textContent || "",
      canvas: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null,
      controls: [...(root?.querySelectorAll("[data-model-action]") || [])].map((button) => ({
        action: button.dataset.modelAction,
        pressed: button.getAttribute("aria-pressed")
      }))
    };
  }, scope);
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# STL And STEP 3D Preview UI Smoke\n\nGenerated: ${report.generatedAt}\n\nSummary: ${report.summary.pass} pass, ${report.summary.fail} fail.\n\n| Status | Check | Detail |\n| --- | --- | --- |\n${rows}\n`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const build = spawnSync(process.execPath, [path.join(workspace, "scripts", "build-app.mjs")], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true
  });
  if (build.status !== 0) throw new Error(`Renderer build failed: ${build.stderr || build.stdout}`);
  const port = Number(process.env.PORT || "") || (await freePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const evidence = {};
  const pageErrors = [];
  const consoleErrors = [];
  const apiFailures = [];
  const previewRequests = [];
  let serverOutput = "";
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

  let browser;
  try {
    evidence.generatedAssets = Object.fromEntries(await Promise.all([
      "model-runtime.js",
      "occt-import-js-worker.js",
      "occt-import-js.js",
      "occt-import-js.wasm",
      "license.occt-import-js.txt",
      "license.occt.txt",
      "license.three.txt"
    ].map(async (name) => [name, (await fs.stat(path.join(workspace, "public", "generated", name))).size])));
    check(
      checks,
      "local-runtime-assets-built",
      evidence.generatedAssets["model-runtime.js"] > 100_000 &&
        evidence.generatedAssets["occt-import-js.wasm"] > 1_000_000 &&
        evidence.generatedAssets["license.occt-import-js.txt"] > 1_000 &&
        evidence.generatedAssets["license.three.txt"] > 500,
      JSON.stringify(evidence.generatedAssets)
    );
    await waitForServer(baseUrl, server, () => serverOutput);
    const [stlPreview, stepPreview] = await Promise.all([
      requestJson(baseUrl, `/api/preview?path=${encodeURIComponent(stlPath)}`),
      requestJson(baseUrl, `/api/preview?path=${encodeURIComponent(stepPath)}`)
    ]);
    evidence.api = { stlPreview, stepPreview };
    check(checks, "preview-contract", stlPreview.type === "model" && stlPreview.format === "stl" && stepPreview.type === "model" && stepPreview.format === "step", JSON.stringify(evidence.api));

    await requestJson(baseUrl, "/api/state", {
      method: "POST",
      body: JSON.stringify({ settings: { inspector: true, inspectorAutoCollapse: false } })
    });
    browser = await chromium.launch({
      executablePath: process.env.EB_MODEL_PREVIEW_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true,
      args: ["--use-angle=swiftshader"]
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      if (request.url().includes("/api/preview?")) previewRequests.push(request.url());
    });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("response", async (response) => {
      if (!response.url().includes("/api/") || response.status() < 400) return;
      apiFailures.push({ status: response.status(), url: response.url(), body: (await response.text().catch(() => "")).slice(0, 500) });
    });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__exploreBetterStartup), null, { timeout: 30000 });

    evidence.rows = await page.evaluate(() => [...document.querySelectorAll('.pane[data-pane="left"] [data-entry-path]')].map((row) => row.textContent.replace(/\s+/g, " ").trim()));
    check(checks, "listing-classifies-models", evidence.rows.filter((row) => /3D Model/.test(row)).length === 2, JSON.stringify(evidence.rows));

    await selectRow(page, stlName);
    evidence.stlInspector = await modelEvidence(page, "inspector", 30000);
    check(checks, "stl-inspector-renders", evidence.stlInspector.state === "ready" && evidence.stlInspector.meshes === 1 && evidence.stlInspector.triangles >= 12 && evidence.stlInspector.canvas?.width >= 200 && evidence.stlInspector.canvas?.height >= 200, JSON.stringify(evidence.stlInspector));
    check(checks, "model-controls-complete", ["fit", "iso", "front", "top", "zoom-out", "zoom-in", "edges"].every((action) => evidence.stlInspector.controls.some((control) => control.action === action)), JSON.stringify(evidence.stlInspector.controls));
    await page.evaluate(() => { window.__modelPreviewInspectorCanvas = document.querySelector('[data-model-viewport="inspector"] canvas'); });
    const inspectorPreviewRequestsBefore = previewRequests.length;
    await paneRow(page, stlName).click();
    await page.waitForTimeout(350);
    evidence.stableInspectorRefresh = await page.evaluate(() => ({
      sameCanvas: window.__modelPreviewInspectorCanvas === document.querySelector('[data-model-viewport="inspector"] canvas'),
      state: document.querySelector('[data-model-viewport="inspector"]')?.dataset.modelState || "missing"
    }));
    const inspectorPreviewRequestDelta = previewRequests.length - inspectorPreviewRequestsBefore;
    check(
      checks,
      "unchanged-selection-reuses-inspector",
      evidence.stableInspectorRefresh.sameCanvas && evidence.stableInspectorRefresh.state === "ready" && inspectorPreviewRequestDelta === 0,
      `${JSON.stringify(evidence.stableInspectorRefresh)} previewRequests=${inspectorPreviewRequestDelta}`
    );

    await page.locator('#inspector [data-preview-action="viewer"]').click();
    await page.waitForSelector("#viewer-dialog[open]", { timeout: 10000 });
    evidence.stlViewer = await modelEvidence(page, "viewer", 30000);
    check(checks, "stl-large-viewer-renders", evidence.stlViewer.state === "ready" && evidence.stlViewer.canvas?.width >= 800 && evidence.stlViewer.canvas?.height >= 400, JSON.stringify(evidence.stlViewer));
    await page.evaluate(() => { window.__modelPreviewViewerCanvas = document.querySelector('[data-model-viewport="viewer"] canvas'); });
    const viewerPreviewRequestsBefore = previewRequests.length;
    await page.locator('#viewer-strip .viewer-strip-item.active').click();
    await page.waitForTimeout(250);
    evidence.stableActiveViewer = await page.evaluate(() => ({
      sameCanvas: window.__modelPreviewViewerCanvas === document.querySelector('[data-model-viewport="viewer"] canvas'),
      state: document.querySelector('[data-model-viewport="viewer"]')?.dataset.modelState || "missing"
    }));
    const viewerPreviewRequestDelta = previewRequests.length - viewerPreviewRequestsBefore;
    check(
      checks,
      "active-viewer-selection-does-not-reload",
      evidence.stableActiveViewer.sameCanvas && evidence.stableActiveViewer.state === "ready" && viewerPreviewRequestDelta === 0,
      `${JSON.stringify(evidence.stableActiveViewer)} previewRequests=${viewerPreviewRequestDelta}`
    );
    const viewerModel = page.locator('[data-model-viewport="viewer"]');
    for (const action of ["front", "top", "iso", "zoom-in", "zoom-out", "fit"]) {
      await viewerModel.locator(`[data-model-action="${action}"]`).click();
    }
    const edges = viewerModel.locator('[data-model-action="edges"]');
    await edges.click();
    const edgesOff = await edges.getAttribute("aria-pressed");
    await edges.click();
    const edgesOn = await edges.getAttribute("aria-pressed");
    check(checks, "model-controls-operate", edgesOff === "false" && edgesOn === "true", `edges=${edgesOff}->${edgesOn}`);

    await page.locator("#viewer-strip [data-viewer-path]").filter({ hasText: stepName }).click();
    evidence.stepViewer = await modelEvidence(page, "viewer", 60000);
    check(checks, "step-worker-renders", evidence.stepViewer.state === "ready" && evidence.stepViewer.meshes >= 1 && evidence.stepViewer.triangles >= 12 && /^STEP\b/.test(evidence.stepViewer.status), JSON.stringify(evidence.stepViewer));
    check(checks, "viewer-replaces-webgl-cleanly", await page.locator('#viewer-body [data-model-viewport="viewer"] canvas').count() === 1, `viewer canvases=${await page.locator('#viewer-body canvas').count()}`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    await page.locator('[data-close-dialog="viewer-dialog"]').click();
    await page.waitForFunction(
      () => !document.getElementById("viewer-dialog")?.open && !document.querySelector("#viewer-body canvas"),
      null,
      { timeout: 5000 }
    );
    check(checks, "viewer-disposes-on-close", await page.locator("#viewer-body canvas").count() === 0, `viewer canvases=${await page.locator("#viewer-body canvas").count()}`);
    check(checks, "browser-page-errors-clean", pageErrors.length === 0, JSON.stringify(pageErrors));
    check(checks, "browser-console-errors-clean", consoleErrors.length === 0, JSON.stringify(consoleErrors));
    check(checks, "api-failures-clean", apiFailures.length === 0, JSON.stringify(apiFailures));
  } catch (error) {
    check(checks, "smoke-execution", false, error.stack || error.message);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
  const report = { generatedAt: new Date().toISOString(), summary, checks, evidence, pageErrors, consoleErrors, apiFailures, screenshot: screenshotPath };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`model preview UI smoke: ${summary.pass} pass, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
