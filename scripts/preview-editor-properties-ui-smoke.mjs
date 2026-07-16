import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import { clickDockAction } from "./ui-helpers.mjs";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `preview-editor-properties-ui-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const textFile = path.join(fixture, "alpha-notes.txt");
const secondTextFile = path.join(fixture, "bravo-notes.md");
const imageFile = path.join(fixture, "sample-image.png");
const binaryFile = path.join(fixture, "sample-binary.bin");
const folder = path.join(fixture, "sample-folder");
const originalText = "original editor content\n";
const latestJsonPath = path.join(artifactsDir, "preview-editor-properties-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "preview-editor-properties-ui-latest.md");
const screenshotPath = path.join(artifactsDir, "preview-editor-properties-ui-latest.png");

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
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(textFile, originalText, "utf8");
  await fs.writeFile(secondTextFile, "# second preview\n", "utf8");
  await fs.writeFile(path.join(folder, "child.txt"), "one child\n", "utf8");
  await fs.writeFile(binaryFile, Buffer.from([0, 1, 2, 3, 4, 5, 0, 255]));
  await fs.writeFile(
    imageFile,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=",
      "base64"
    )
  );
}

function paneRow(page, name) {
  return page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: name }).first();
}

async function selectRow(page, name, modifiers = []) {
  const row = paneRow(page, name);
  await row.waitFor({ state: "visible", timeout: 10000 });
  await row.click({ modifiers });
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]')].some(
        (item) => item.textContent.includes(expected)
      ),
    name
  );
}

async function waitForInspector(page, predicateDescription, predicate) {
  const started = Date.now();
  let last;
  while (Date.now() - started < 10000) {
    last = await page.evaluate(() => ({
      text: document.querySelector("#inspector .inspector-body")?.textContent?.replace(/\s+/g, " ").trim() || "",
      html: document.querySelector("#inspector .inspector-body")?.innerHTML || "",
      image: Boolean(document.querySelector("#inspector .preview-image")),
      edit: Boolean(document.querySelector('#inspector [data-preview-action="edit-text"]')),
      viewer: Boolean(document.querySelector('#inspector [data-preview-action="viewer"]'))
    }));
    if (predicate(last)) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`${predicateDescription}: ${JSON.stringify(last)}`);
}

async function waitForFileText(filePath, expected) {
  const started = Date.now();
  let current = "";
  while (Date.now() - started < 10000) {
    current = await fs.readFile(filePath, "utf8");
    if (current === expected) return current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Expected ${JSON.stringify(expected)}, found ${JSON.stringify(current)}.`);
}

async function inspectLayout(page, selector) {
  return page.evaluate((targetSelector) => {
    const root = document.querySelector(targetSelector);
    const issues = [];
    for (const element of root?.querySelectorAll("button, input, select, textarea, label, strong, small, pre") || []) {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) continue;
      const isScrollSurface = element.matches("textarea, pre");
      const isControl = element.matches("input, select, textarea");
      const tinyControl = element.matches('input[type="checkbox"], input[type="radio"]');
      const intentionalEllipsis = style.textOverflow === "ellipsis" && (element.hasAttribute("title") || element.matches(".properties-row small"));
      const clipped = !isScrollSurface && !isControl && !intentionalEllipsis && (element.scrollWidth > element.clientWidth + 4 || element.scrollHeight > element.clientHeight + 4);
      const squished = tinyControl
        ? rect.width < 14 || rect.height < 14
        : element.matches("small")
          ? rect.width < 20 || rect.height < 11
          : rect.width < 20 || rect.height < 16;
      if (clipped || squished) {
        issues.push({
          tag: element.tagName.toLowerCase(),
          text: (element.textContent || element.value || "").replace(/\s+/g, " ").trim().slice(0, 100),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          clipped,
          squished
        });
      }
    }
    const rect = root?.getBoundingClientRect();
    return {
      issues,
      root: rect ? { width: Math.round(rect.width), height: Math.round(rect.height), right: Math.round(rect.right), bottom: Math.round(rect.bottom) } : null,
      viewport: { width: innerWidth, height: innerHeight }
    };
  }, selector);
}

async function expectDialog(page, action) {
  const pending = page.waitForEvent("dialog", { timeout: 4000 });
  action().catch(() => {});
  return pending;
}

async function closeDialog(page, id) {
  await page.locator(`[data-close-dialog="${id}"]`).click();
  await page.waitForFunction((dialogId) => !document.getElementById(dialogId)?.open, id);
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Preview, Viewer, Editor, and Properties UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const port = Number(process.env.PORT || "") || (await freePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const evidence = {};
  const pageErrors = [];
  const consoleErrors = [];
  const apiFailures = [];
  let expectedConflictFailures = 0;
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
    await waitForServer(baseUrl, server, () => serverOutput);
    await requestJson(baseUrl, "/api/state", {
      method: "POST",
      body: JSON.stringify({ settings: { inspector: true, inspectorAutoCollapse: false } })
    });
    browser = await chromium.launch({
      executablePath: process.env.EB_PREVIEW_UI_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("response", async (response) => {
      if (!response.url().includes("/api/") || response.status() < 400) return;
      const failure = { status: response.status(), url: response.url(), body: (await response.text().catch(() => "")).slice(0, 500) };
      if (response.url().includes("/api/text/save") && /changed on disk/i.test(failure.body)) {
        expectedConflictFailures += 1;
      } else {
        apiFailures.push(failure);
      }
    });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, { waitUntil: "domcontentloaded" });
    await paneRow(page, path.basename(textFile)).waitFor({ state: "visible", timeout: 10000 });

    await selectRow(page, path.basename(textFile));
    evidence.textPreview = await waitForInspector(page, "text preview", (value) => value.text.includes("original editor content"));
    check(
      checks,
      "preview-text-actions",
      evidence.textPreview.edit && evidence.textPreview.viewer && evidence.textPreview.text.includes("alpha-notes.txt"),
      evidence.textPreview.text
    );

    await selectRow(page, path.basename(imageFile));
    evidence.imagePreview = await waitForInspector(page, "image preview", (value) => value.image);
    check(checks, "preview-image", evidence.imagePreview.image && evidence.imagePreview.viewer, evidence.imagePreview.text);

    await selectRow(page, path.basename(folder));
    evidence.folderPreview = await waitForInspector(page, "folder preview", (value) => value.text.includes("sample-folder"));
    check(
      checks,
      "preview-folder-human-count",
      /1 item\b/.test(evidence.folderPreview.text) && !/1 items\b/.test(evidence.folderPreview.text),
      evidence.folderPreview.text
    );

    await selectRow(page, path.basename(binaryFile));
    evidence.binaryPreview = await waitForInspector(page, "binary preview", (value) => value.text.includes("sample-binary.bin"));
    check(
      checks,
      "preview-binary-friendly-fallback",
      /preview unavailable/i.test(evidence.binaryPreview.text) && !/\bbinary\s*$/.test(evidence.binaryPreview.text),
      evidence.binaryPreview.text
    );

    await selectRow(page, path.basename(textFile));
    await clickDockAction(page, "viewer");
    await page.waitForSelector("#viewer-dialog[open]", { timeout: 10000 });
    evidence.viewerInitial = await page.evaluate(() => ({
      title: document.getElementById("viewer-title")?.textContent || "",
      meta: document.getElementById("viewer-meta")?.textContent || "",
      body: document.getElementById("viewer-body")?.textContent || "",
      stripCount: document.querySelectorAll("#viewer-strip [data-viewer-path]").length
    }));
    check(
      checks,
      "viewer-opens-selection-with-neighbors",
      evidence.viewerInitial.title === "alpha-notes.txt" && evidence.viewerInitial.body.includes("original editor content") && evidence.viewerInitial.stripCount >= 3,
      JSON.stringify(evidence.viewerInitial)
    );
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => {
      const title = document.getElementById("viewer-title")?.textContent || "";
      const selected = document.querySelector('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]')?.textContent || "";
      return title !== "alpha-notes.txt" && selected.includes(title);
    });
    evidence.viewerNext = await page.evaluate(() => ({
      title: document.getElementById("viewer-title")?.textContent || "",
      meta: document.getElementById("viewer-meta")?.textContent || "",
      selected: document.querySelector('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]')?.textContent || ""
    }));
    check(
      checks,
      "viewer-keyboard-navigation-syncs-selection",
      evidence.viewerNext.title && evidence.viewerNext.title !== "alpha-notes.txt" && evidence.viewerNext.selected.includes(evidence.viewerNext.title),
      JSON.stringify(evidence.viewerNext)
    );
    const viewerLayout = await inspectLayout(page, "#viewer-dialog");
    check(checks, "viewer-layout", viewerLayout.issues.length === 0, JSON.stringify(viewerLayout.issues));
    await closeDialog(page, "viewer-dialog");

    await selectRow(page, path.basename(textFile));
    await clickDockAction(page, "editText");
    await page.waitForSelector("#text-editor-dialog[open]", { timeout: 10000 });
    const editor = page.locator("#text-editor-content");
    check(checks, "editor-loads-selected-text", (await editor.inputValue()) === originalText, await page.locator("#text-editor-summary").textContent());

    const draft = "unsaved draft should survive\n";
    await editor.fill(draft);
    const reloadDismissed = await expectDialog(page, () => page.locator('[data-text-editor-action="reload"]').click());
    evidence.reloadPrompt = reloadDismissed.message();
    await reloadDismissed.dismiss();
    check(
      checks,
      "editor-reload-guards-unsaved-draft",
      /discard|unsaved/i.test(evidence.reloadPrompt) && (await editor.inputValue()) === draft,
      evidence.reloadPrompt
    );
    const reloadAccepted = await expectDialog(page, () => page.locator('[data-text-editor-action="reload"]').click());
    await reloadAccepted.accept();
    await page.waitForFunction((expected) => document.getElementById("text-editor-content")?.value === expected, originalText);
    check(checks, "editor-reload-works", (await editor.inputValue()) === originalText && /Reloaded/.test(await page.locator("#text-editor-summary").textContent()), await page.locator("#text-editor-summary").textContent());

    await editor.fill(draft);
    const closeDismissed = await expectDialog(page, () => page.locator('[data-close-dialog="text-editor-dialog"]').click());
    evidence.closePrompt = closeDismissed.message();
    await closeDismissed.dismiss();
    check(
      checks,
      "editor-close-guards-unsaved-draft",
      /discard|unsaved/i.test(evidence.closePrompt) && (await page.locator("#text-editor-dialog").getAttribute("open")) !== null && (await editor.inputValue()) === draft,
      evidence.closePrompt
    );
    const closeAccepted = await expectDialog(page, () => page.locator('[data-close-dialog="text-editor-dialog"]').click());
    await closeAccepted.accept();
    await page.waitForFunction(() => !document.getElementById("text-editor-dialog")?.open);

    await clickDockAction(page, "editText");
    await page.waitForSelector("#text-editor-dialog[open]", { timeout: 10000 });
    const savedText = "saved by the built-in editor\n";
    await editor.fill(savedText);
    await page.locator("#text-editor-form").evaluate((form) => form.requestSubmit());
    await waitForFileText(textFile, savedText);
    await page.waitForFunction(() =>
      /Saved/.test(document.getElementById("text-editor-summary")?.textContent || "") &&
      /Text saved/.test(document.getElementById("toast")?.textContent || "")
    );
    check(
      checks,
      "editor-save-mutates-disk-with-feedback",
      /Saved/.test(await page.locator("#text-editor-summary").textContent()) && /Text saved/.test(await page.locator("#toast").textContent()),
      `${await page.locator("#text-editor-summary").textContent()} / ${await page.locator("#toast").textContent()}`
    );
    const editorLayout = await inspectLayout(page, "#text-editor-dialog");
    check(checks, "editor-layout", editorLayout.issues.length === 0, JSON.stringify(editorLayout.issues));
    await closeDialog(page, "text-editor-dialog");

    await clickDockAction(page, "ops");
    await page.waitForSelector("#ops-dialog[open]", { timeout: 10000 });
    const savedOperation = page.locator("#operation-list .operation-row").filter({ hasText: "Edit alpha-notes.txt" }).first();
    await savedOperation.waitFor({ state: "visible" });
    evidence.editOperation = (await savedOperation.textContent()).replace(/\s+/g, " ").trim();
    check(
      checks,
      "editor-save-is-journaled-and-undoable",
      /alpha-notes\.txt/.test(evidence.editOperation) &&
        !/edit-text/.test(evidence.editOperation) &&
        (await savedOperation.locator("[data-undo-operation]").count()) === 1,
      evidence.editOperation
    );
    await savedOperation.locator("[data-undo-operation]").click();
    await waitForFileText(textFile, originalText);
    await page.waitForFunction(() => /Undo complete: restored 1 item/.test(document.getElementById("toast")?.textContent || ""));
    check(checks, "editor-undo-restores-original", /Undo complete: restored 1 item/.test(await page.locator("#toast").textContent()), await page.locator("#toast").textContent());
    await closeDialog(page, "ops-dialog");

    await selectRow(page, path.basename(textFile));
    await clickDockAction(page, "editText");
    await page.waitForSelector("#text-editor-dialog[open]", { timeout: 10000 });
    await page.waitForTimeout(20);
    const diskVersion = "external disk version\n";
    await fs.writeFile(textFile, diskVersion, "utf8");
    await editor.fill("editor version after conflict\n");
    await page.locator("#text-editor-form").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => /changed on disk/i.test(document.getElementById("text-editor-summary")?.textContent || ""));
    const overwriteButton = page.locator('[data-text-editor-action="force-save"]');
    evidence.conflict = {
      summary: await page.locator("#text-editor-summary").textContent(),
      overwriteVisible: await overwriteButton.isVisible(),
      diskText: await fs.readFile(textFile, "utf8")
    };
    check(
      checks,
      "editor-conflict-preserves-disk-and-offers-explicit-overwrite",
      evidence.conflict.diskText === diskVersion && evidence.conflict.overwriteVisible && /changed on disk/i.test(evidence.conflict.summary),
      JSON.stringify(evidence.conflict)
    );
    await overwriteButton.click();
    await waitForFileText(textFile, "editor version after conflict\n");
    await page.waitForFunction(() =>
      /Saved/.test(document.getElementById("text-editor-summary")?.textContent || "") &&
      /Text saved/.test(document.getElementById("toast")?.textContent || "")
    );
    check(checks, "editor-explicit-conflict-overwrite", /Text saved/.test(await page.locator("#toast").textContent()), await page.locator("#toast").textContent());
    await closeDialog(page, "text-editor-dialog");

    await selectRow(page, path.basename(textFile));
    await clickDockAction(page, "properties");
    await page.waitForSelector("#properties-dialog[open]", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll("#properties-results .properties-row").length === 1);
    await page.locator("#properties-hash").check();
    await page.locator("#properties-form").evaluate((form) => form.requestSubmit());
    const expectedHash = createHash("sha256").update("editor version after conflict\n").digest("hex");
    await page.waitForFunction((hash) => document.getElementById("properties-results")?.textContent?.includes(hash), expectedHash);
    evidence.fileProperties = await page.evaluate(() => ({
      summary: document.getElementById("properties-summary")?.textContent?.replace(/\s+/g, " ").trim() || "",
      row: document.getElementById("properties-results")?.textContent?.replace(/\s+/g, " ").trim() || ""
    }));
    check(
      checks,
      "properties-file-hash",
      evidence.fileProperties.summary.includes("1/1") &&
        evidence.fileProperties.row.includes(expectedHash) &&
        /1 file \/ 0 folders/.test(evidence.fileProperties.row),
      JSON.stringify(evidence.fileProperties)
    );
    await page.locator("#properties-diagnose").click();
    await page.waitForFunction(() => /Healthy/.test(document.getElementById("properties-diagnostics")?.textContent || ""));
    evidence.diagnostics = (await page.locator("#properties-diagnostics").textContent()).replace(/\s+/g, " ").trim();
    check(
      checks,
      "properties-path-diagnostics",
      /Healthy/.test(evidence.diagnostics) && /Reachable/.test(evidence.diagnostics) && /EntriesFile/.test(evidence.diagnostics),
      evidence.diagnostics
    );
    const propertiesLayout = await inspectLayout(page, "#properties-dialog");
    check(checks, "properties-layout", propertiesLayout.issues.length === 0, JSON.stringify(propertiesLayout.issues));
    await closeDialog(page, "properties-dialog");

    await selectRow(page, path.basename(folder));
    await clickDockAction(page, "properties");
    await page.waitForFunction(() => /Files\s*1/i.test(document.getElementById("properties-summary")?.textContent || ""));
    evidence.folderProperties = (await page.locator("#properties-summary").textContent()).replace(/\s+/g, " ").trim();
    check(checks, "properties-folder-recursive", /Files\s*1/.test(evidence.folderProperties) && /Scanned\s*1/.test(evidence.folderProperties), evidence.folderProperties);
    await closeDialog(page, "properties-dialog");

    await selectRow(page, path.basename(textFile));
    await selectRow(page, path.basename(secondTextFile), ["Control"]);
    await clickDockAction(page, "properties");
    await page.waitForFunction(() => /Selected\s*2\/2/.test(document.getElementById("properties-summary")?.textContent || ""));
    evidence.multiProperties = await page.locator("#properties-summary").textContent();
    check(
      checks,
      "properties-multi-selection-human-count",
      /Selected\s*2\/2/.test(evidence.multiProperties) && !/item\(s\)/.test(evidence.multiProperties),
      evidence.multiProperties
    );
    await closeDialog(page, "properties-dialog");

    const inspectorLayout = await inspectLayout(page, "#inspector");
    check(checks, "preview-layout", inspectorLayout.issues.length === 0, JSON.stringify(inspectorLayout.issues));
    check(checks, "browser-page-errors-clean", pageErrors.length === 0, JSON.stringify(pageErrors));
    const actionableConsoleErrors = consoleErrors.filter((message) => !/Failed to load resource:.*500 \(Internal Server Error\)/.test(message));
    check(checks, "browser-console-errors-clean", actionableConsoleErrors.length === 0 && expectedConflictFailures === 1, JSON.stringify({ consoleErrors, actionableConsoleErrors }));
    check(checks, "unexpected-api-failures-clean", apiFailures.length === 0 && expectedConflictFailures === 1, JSON.stringify({ apiFailures, expectedConflictFailures }));
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (error) {
    check(checks, "smoke-execution", false, error.stack || error.message);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }

  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    warn: checks.filter((item) => item.status === "warn").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
  const report = {
    generatedAt: new Date().toISOString(),
    status: summary.fail ? "fail" : "pass",
    baseUrl,
    evidence,
    pageErrors,
    consoleErrors,
    apiFailures,
    expectedConflictFailures,
    serverOutput: serverOutput.slice(-5000),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(latestMdPath, markdownReport(report));
  console.log(`preview/editor/properties UI smoke: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
