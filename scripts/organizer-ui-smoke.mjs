import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import { clickDockAction } from "./ui-helpers.mjs";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `organizer-ui-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "organizer-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "organizer-ui-latest.md");

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

async function requestJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start at ${baseUrl}: ${output()}`);
}

async function prepareFixture() {
  await fs.mkdir(path.join(fixture, "folder"), { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(path.join(fixture, "alpha-report.txt"), "alpha\n", "utf8");
  await fs.writeFile(path.join(fixture, "bravo-notes.md"), "bravo\n", "utf8");
  await fs.writeFile(path.join(fixture, "charlie.log"), "charlie\n", "utf8");
}

function row(page, name) {
  return page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: name }).first();
}

async function clearSelection(page) {
  await page.locator('[data-list="left"]').focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+i");
  await page.waitForFunction(() => document.querySelectorAll('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]').length === 0);
}

async function selectRows(page, names) {
  await clearSelection(page);
  for (const [index, name] of names.entries()) {
    const target = row(page, name);
    await target.waitFor({ state: "visible", timeout: 10000 });
    await target.click({ modifiers: index ? ["Control"] : [] });
  }
  await page.waitForFunction(
    (count) => document.querySelectorAll('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]').length === count,
    names.length
  );
}

async function closeDialog(page, id) {
  await page.locator(`[data-close-dialog="${id}"]`).click();
  await page.waitForFunction((dialogId) => !document.getElementById(dialogId)?.open, id);
}

async function inspectDialogs(page, ids) {
  return page.evaluate((dialogIds) => {
    const issues = [];
    for (const id of dialogIds) {
      const root = document.getElementById(id);
      for (const element of root?.querySelectorAll("button, input, select, textarea, label") || []) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) continue;
        const tiny = element.matches('input[type="radio"], input[type="checkbox"]');
        const squished = tiny ? rect.width < 14 || rect.height < 14 : rect.width < 24 || rect.height < 18;
        const clipped = !element.matches("input, select, textarea") && (element.scrollWidth > element.clientWidth + 4 || element.scrollHeight > element.clientHeight + 4);
        if (squished || clipped) issues.push({ id, tag: element.tagName.toLowerCase(), text: element.textContent.trim().slice(0, 80), squished, clipped });
      }
    }
    return issues;
  }, ids);
}

function markdownReport(report) {
  const rows = report.checks.map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`).join("\n");
  return `# Organizer UI Smoke\n\nGenerated: ${report.generatedAt}\n\nSummary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.\n\n| Status | Check | Detail |\n| --- | --- | --- |\n${rows}\n`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const port = Number(process.env.PORT || "") || (await freePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const evidence = {};
  const pageErrors = [];
  const apiFailures = [];
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
    browser = await chromium.launch({ executablePath: process.env.EB_ORGANIZER_UI_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", async (response) => {
      if (response.url().includes("/api/") && response.status() >= 400) apiFailures.push({ status: response.status(), url: response.url(), body: (await response.text().catch(() => "")).slice(0, 300) });
    });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, { waitUntil: "domcontentloaded" });
    await row(page, "alpha-report.txt").waitFor({ state: "visible", timeout: 10000 });

    await selectRows(page, ["alpha-report.txt"]);
    await clickDockAction(page, "labels");
    await page.waitForSelector("#labels-dialog[open]");
    await page.locator("#label-name").fill("Needs review");
    await page.locator("#label-notes").fill("Product-test label");
    await page.locator('#labels-dialog label.label-gold').click();
    await page.locator("#label-form").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => /Labeled 1 item/.test(document.getElementById("toast")?.textContent || ""));
    evidence.label = await page.evaluate(() => ({
      toast: document.getElementById("toast")?.textContent || "",
      summary: document.getElementById("label-summary")?.textContent || "",
      existing: document.getElementById("label-existing-list")?.textContent.replace(/\s+/g, " ").trim() || "",
      pane: document.querySelector('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]')?.textContent.replace(/\s+/g, " ").trim() || ""
    }));
    check(checks, "label-apply-and-pane-badge", evidence.label.toast === "Labeled 1 item" && evidence.label.summary === "1 labeled" && /Needs review/.test(evidence.label.existing) && /Needs review/.test(evidence.label.pane), JSON.stringify(evidence.label));
    await page.locator('[data-label-action="clear"]').click();
    await page.waitForFunction(() => /Cleared 1 item/.test(document.getElementById("toast")?.textContent || ""));
    check(checks, "label-clear", (await page.locator("#label-summary").textContent()) === "0 labeled", await page.locator("#toast").textContent());
    await closeDialog(page, "labels-dialog");

    await selectRows(page, ["alpha-report.txt", "bravo-notes.md"]);
    await clickDockAction(page, "collections");
    await page.waitForSelector("#collections-dialog[open]");
    await page.locator("#collection-name").fill("Review files");
    await page.locator("#collection-description").fill("Cross-folder shortlist");
    await page.locator("#collection-form").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => /Collection saved/.test(document.getElementById("toast")?.textContent || ""));
    await page.locator('[data-collection-action="add"]').click();
    await page.waitForFunction(() => /Added 2 items/.test(document.getElementById("toast")?.textContent || ""));
    evidence.collection = await page.evaluate(() => ({
      summary: document.getElementById("collection-summary")?.textContent || "",
      list: document.getElementById("collection-list")?.textContent.replace(/\s+/g, " ").trim() || "",
      itemCount: document.querySelectorAll("#collection-items .collection-item-row").length,
      toast: document.getElementById("toast")?.textContent || ""
    }));
    check(checks, "collection-save-and-add", evidence.collection.summary === "1 saved" && /2 items/.test(evidence.collection.list) && evidence.collection.itemCount === 2 && evidence.collection.toast === "Added 2 items", JSON.stringify(evidence.collection));
    await page.locator('[data-collection-action="open"]').click();
    await page.waitForFunction(() => document.querySelector('.pane[data-pane="left"] .tab.active .tab-label')?.textContent.includes("Review files"));
    check(checks, "collection-opens-virtual-pane", (await page.locator('.pane[data-pane="left"] [data-entry-path]').count()) === 2, await page.locator('.pane[data-pane="left"] .tab.active').textContent());

    await page.locator('[data-path-input="left"]').fill(fixture);
    await page.locator('[data-path-input="left"]').press("Enter");
    await row(page, "alpha-report.txt").waitFor({ state: "visible" });
    await selectRows(page, ["alpha-report.txt", "bravo-notes.md"]);
    await clickDockAction(page, "selectionSets");
    await page.waitForSelector("#selection-sets-dialog[open]");
    await page.locator("#selection-set-name").fill("Two review files");
    await page.locator("#selection-set-form").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => /Selection set saved/.test(document.getElementById("selection-set-summary")?.textContent || ""));
    check(checks, "selection-set-save", (await page.locator("#selection-set-detail .selection-set-row").count()) === 2, await page.locator("#selection-set-summary").textContent());
    await closeDialog(page, "selection-sets-dialog");
    await clearSelection(page);
    await clickDockAction(page, "selectionSets");
    await page.locator('[data-selection-set-action="apply"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.pane[data-pane="left"] [data-entry-path][aria-selected="true"]').length === 2);
    check(checks, "selection-set-apply", /replace: 2 items/.test(await page.locator("#selection-set-summary").textContent()), await page.locator("#selection-set-summary").textContent());
    await closeDialog(page, "selection-sets-dialog");

    await clickDockAction(page, "basketAdd");
    await page.waitForFunction(() => /Basket: 2 added \/ 2 total/.test(document.getElementById("toast")?.textContent || ""));
    await clickDockAction(page, "basket");
    await page.waitForSelector("#basket-dialog[open]");
    check(checks, "basket-add-summary", (await page.locator("#basket-summary").textContent()) === "2 items" && (await page.locator("#basket-results .basket-row").count()) === 2, await page.locator("#basket-summary").textContent());
    await page.locator("#basket-results [data-basket-select]").first().check();
    await page.locator('[data-basket-action="remove"]').click();
    await page.waitForFunction(() => /Removed 1 basket item/.test(document.getElementById("toast")?.textContent || ""));
    check(checks, "basket-remove-selected", (await page.locator("#basket-summary").textContent()) === "1 item", await page.locator("#toast").textContent());
    await closeDialog(page, "basket-dialog");

    await clickDockAction(page, "filters");
    await page.waitForSelector("#filters-dialog[open]");
    await page.locator('[data-filter-preset-action="new"]').click();
    await page.locator("#filter-preset-name").fill("Alpha only");
    await page.locator("#filter-preset-text").fill("alpha");
    await page.locator("#filter-preset-form").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => /Filter preset saved: Alpha only/.test(document.getElementById("toast")?.textContent || ""));
    await page.locator('[data-filter-preset-action="apply"]').click();
    await closeDialog(page, "filters-dialog");
    await page.waitForFunction(() => document.querySelectorAll('.pane[data-pane="left"] [data-entry-path]').length === 1);
    check(checks, "filter-preset-save-and-apply", /alpha-report\.txt/.test(await page.locator('.pane[data-pane="left"] [data-entry-path]').textContent()), await page.locator('[data-filter="left"]').inputValue());
    await clickDockAction(page, "filters");
    await page.locator('[data-filter-preset-action="clear-pane"]').click();
    await closeDialog(page, "filters-dialog");
    await page.waitForFunction(() => document.querySelectorAll('.pane[data-pane="left"] [data-entry-path]').length === 4);
    check(checks, "filter-preset-clear", (await page.locator('[data-filter="left"]').inputValue()) === "", await page.locator("#toast").textContent());

    const savedState = await requestJson(baseUrl, "/api/state");
    check(checks, "organizer-state-persisted", savedState.collections?.length === 1 && savedState.selectionSets?.length === 1 && savedState.filterPresets?.length === 1 && savedState.fileBasket?.length === 1 && savedState.labels?.length === 0, JSON.stringify({ collections: savedState.collections?.length, selectionSets: savedState.selectionSets?.length, filterPresets: savedState.filterPresets?.length, basket: savedState.fileBasket?.length, labels: savedState.labels?.length }));
    const layoutIssues = await inspectDialogs(page, ["labels-dialog", "collections-dialog", "selection-sets-dialog", "basket-dialog", "filters-dialog"]);
    check(checks, "organizer-dialog-layout", layoutIssues.length === 0, JSON.stringify(layoutIssues));
    check(checks, "organizer-page-errors-clean", pageErrors.length === 0, JSON.stringify(pageErrors));
    check(checks, "organizer-api-errors-clean", apiFailures.length === 0, JSON.stringify(apiFailures));
  } catch (error) {
    check(checks, "smoke-execution", false, error.stack || error.message);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }

  const summary = { pass: checks.filter((item) => item.status === "pass").length, warn: 0, fail: checks.filter((item) => item.status === "fail").length };
  const report = { generatedAt: new Date().toISOString(), status: summary.fail ? "fail" : "pass", evidence, pageErrors, apiFailures, serverOutput: serverOutput.slice(-4000), summary, checks };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await fs.writeFile(latestMdPath, markdownReport(report));
  console.log(`organizer UI smoke: ${summary.pass} pass, 0 warn, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
