import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import { clickDockAction } from "./ui-helpers.mjs";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `trash-recovery-ui-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const appTrashFile = path.join(fixture, `app-trash-ui-${stamp}.txt`);
const undoFile = path.join(fixture, `undo-trash-ui-${stamp}.txt`);
const recycleFile = path.join(fixture, `windows-recycle-ui-${stamp}.txt`);
const latestJsonPath = path.join(artifactsDir, "trash-recovery-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "trash-recovery-ui-latest.md");
const screenshotPath = path.join(artifactsDir, "trash-recovery-ui-latest.png");

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

async function fileExists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

async function waitForFile(filePath, expected) {
  const started = Date.now();
  while (Date.now() - started < 12000) {
    if ((await fileExists(filePath)) === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function clickPaneAction(page, action) {
  await page.evaluate((name) => {
    const button = document.querySelector(`.pane[data-pane="left"] [data-action="${name}"]`);
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      throw new Error(`Pane action ${name} is unavailable.`);
    }
    button.click();
  }, action);
}

async function selectFixtureRow(page, name) {
  const row = page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: name }).first();
  await row.waitFor({ state: "visible", timeout: 10000 });
  await row.click();
}

async function waitForToast(page, pattern) {
  try {
    await page.waitForFunction(
      ([source, flags]) => {
        const matcher = new RegExp(source, flags);
        const current = document.getElementById("toast")?.textContent || "";
        return matcher.test(current) || (window.__trashToastLog || []).some((message) => matcher.test(message));
      },
      [pattern.source, pattern.flags],
      { timeout: 10000 }
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      current: document.getElementById("toast")?.textContent || "",
      log: window.__trashToastLog || [],
      status: document.getElementById("status-pill")?.textContent || "",
      busy: [...document.querySelectorAll(".pane")].map((pane) => ({ pane: pane.dataset.pane, busy: pane.getAttribute("aria-busy") }))
    }));
    throw new Error(`${error.message}; toast diagnostic=${JSON.stringify(diagnostic)}`);
  }
  return page.evaluate(
    ([source, flags]) => {
      const matcher = new RegExp(source, flags);
      return [...(window.__trashToastLog || [])].reverse().find((message) => matcher.test(message)) || "";
    },
    [pattern.source, pattern.flags]
  );
}

async function resetToastEvidence(page) {
  await page.evaluate(() => {
    window.__trashToastLog = [];
    const toast = document.getElementById("toast");
    if (toast) toast.textContent = "";
  });
}

function pathKey(value) {
  return String(value || "").replace(/[\\/]+$/, "").toLowerCase();
}

async function findRecycleItem(baseUrl, originalPath) {
  const wanted = pathKey(originalPath);
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const data = await requestJson(baseUrl, "/api/windows-recycle-bin?limit=2000");
    const item = (data.items || []).find((candidate) => pathKey(candidate.originalPath) === wanted);
    if (item) return item;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function inspectTrashDialog(page) {
  return page.evaluate(() => {
    const dialog = document.getElementById("trash-dialog");
    const visibleControls = [...dialog.querySelectorAll("button, input")].filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    const issues = visibleControls
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: (element.textContent || element.getAttribute("aria-label") || "").trim(),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          checkbox: element instanceof HTMLInputElement && element.type === "checkbox",
          clipped: element.scrollWidth > element.clientWidth + 4 || element.scrollHeight > element.clientHeight + 4,
          outside: rect.left < dialog.getBoundingClientRect().left - 1 || rect.right > dialog.getBoundingClientRect().right + 1
        };
      })
      .filter((item) => item.clipped || item.outside || (!item.checkbox && (item.width < 18 || item.height < 18)));
    return {
      open: dialog.open,
      title: document.getElementById("trash-dialog-title")?.textContent?.trim() || "",
      summary: document.getElementById("trash-summary")?.textContent?.trim() || "",
      restore: document.querySelector('[data-trash-action="restore"]')?.textContent?.trim() || "",
      deleteHidden: document.querySelector('[data-trash-action="delete"]')?.hidden === true,
      openWindows: document.querySelector('[data-trash-action="open-windows"]')?.textContent?.trim() || "",
      issues
    };
  });
}

function markdown(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Trash Recovery UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function main() {
  if (process.platform !== "win32") {
    console.log("Trash recovery UI smoke skipped on non-Windows platform.");
    return;
  }
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  await fs.writeFile(appTrashFile, "app trash UI proof\n", "utf8");
  await fs.writeFile(undoFile, "operation undo UI proof\n", "utf8");
  await fs.writeFile(recycleFile, "Windows Recycle Bin UI proof\n", "utf8");

  const port = Number(process.env.PORT || "") || await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const evidence = {};
  const pageErrors = [];
  const apiFailures = [];
  let serverOutput = "";
  let recyclePath = "";
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
      body: JSON.stringify({ settings: { confirmTrash: false, inspector: false } })
    });
    browser = await chromium.launch({
      executablePath: process.env.EB_TRASH_UI_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1366, height: 860 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("response", async (response) => {
      if (response.url().includes("/api/") && response.status() >= 400) {
        apiFailures.push({ status: response.status(), url: response.url(), body: (await response.text().catch(() => "")).slice(0, 500) });
      }
    });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture)}&right=${encodeURIComponent(fixture)}`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      window.__trashToastLog = [];
      const toast = document.getElementById("toast");
      new MutationObserver(() => {
        const message = toast?.textContent?.trim();
        if (message) window.__trashToastLog.push(message);
      }).observe(toast, { childList: true, characterData: true, subtree: true });
    });

    await selectFixtureRow(page, path.basename(appTrashFile));
    await resetToastEvidence(page);
    await clickPaneAction(page, "trash");
    check(checks, "app-trash-move-with-confirmation-disabled", await waitForFile(appTrashFile, false), await waitForToast(page, /Moved 1 item to App Trash/));

    await clickDockAction(page, "appTrash");
    await page.locator("#trash-dialog").waitFor({ state: "visible" });
    const appView = await inspectTrashDialog(page);
    evidence.appView = appView;
    check(checks, "app-trash-language", appView.title === "App Trash" && appView.restore === "Restore to Active Folder" && !appView.deleteHidden, JSON.stringify(appView));
    const appRow = page.locator(".trash-row").filter({ hasText: path.basename(appTrashFile) }).first();
    await appRow.locator('[data-trash-select]').check();
    await resetToastEvidence(page);
    await page.locator('[data-trash-action="restore"]').click();
    check(checks, "app-trash-restore-to-active", await waitForFile(appTrashFile, true), await waitForToast(page, /Restored 1 item/));

    await page.locator('[data-close-dialog="trash-dialog"]').click();
    await selectFixtureRow(page, path.basename(appTrashFile));
    await clickPaneAction(page, "trash");
    await waitForFile(appTrashFile, false);
    await clickDockAction(page, "appTrash");
    const deleteRow = page.locator(".trash-row").filter({ hasText: path.basename(appTrashFile) }).first();
    await deleteRow.locator('[data-trash-select]').check();
    await resetToastEvidence(page);
    const canceledPrompt = page.waitForEvent("dialog");
    const canceledClick = page.locator('[data-trash-action="delete"]').click();
    const canceledDialog = await canceledPrompt;
    const canceledText = canceledDialog.message();
    await canceledDialog.dismiss();
    await canceledClick;
    await waitForToast(page, /Permanent delete canceled/);
    check(checks, "permanent-delete-always-typed", canceledDialog.type() === "prompt" && /Type DELETE/.test(canceledText), canceledText);
    check(checks, "permanent-delete-cancel-preserves-item", await deleteRow.isVisible(), "App Trash item remains after dismissing the typed confirmation.");

    await resetToastEvidence(page);
    const acceptedPrompt = page.waitForEvent("dialog");
    const acceptedClick = page.locator('[data-trash-action="delete"]').click();
    const acceptedDialog = await acceptedPrompt;
    await acceptedDialog.accept("DELETE");
    await acceptedClick;
    await page.waitForFunction((name) => ![...document.querySelectorAll(".trash-row")].some((row) => row.textContent.includes(name)), path.basename(appTrashFile));
    check(checks, "permanent-delete-confirmed", !(await fileExists(appTrashFile)) && /Permanently deleted 1 item/.test(await page.locator("#toast").textContent()), await page.locator("#trash-summary").textContent());

    await page.locator('[data-close-dialog="trash-dialog"]').click();
    await selectFixtureRow(page, path.basename(undoFile));
    await resetToastEvidence(page);
    await clickPaneAction(page, "trash");
    await waitForFile(undoFile, false);
    await clickDockAction(page, "ops");
    await page.locator("#ops-dialog").waitFor({ state: "visible" });
    const undoButton = page.locator("#operation-list [data-undo-operation]").first();
    await undoButton.waitFor({ state: "visible" });
    await resetToastEvidence(page);
    await undoButton.click();
    const undoToast = await waitForToast(page, /Undo complete: restored 1 item/);
    check(checks, "operation-undo-restores-item", await waitForFile(undoFile, true), undoToast);
    const operationLabels = await page.locator("#operation-list .operation-row > div:first-child > strong").allTextContents();
    check(checks, "operation-labels-plain", operationLabels.some((label) => label === "Undo Move 1 item to App Trash") && operationLabels.every((label) => !/item\(s\)|[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(label)), JSON.stringify(operationLabels.slice(0, 6)));
    await page.locator('[data-close-dialog="ops-dialog"]').click();

    await selectFixtureRow(page, path.basename(recycleFile));
    await selectFixtureRow(page, path.basename(recycleFile));
    await resetToastEvidence(page);
    const recycleConfirm = page.waitForEvent("dialog");
    const recycleClick = clickPaneAction(page, "recycle");
    const recycleDialog = await recycleConfirm;
    await recycleDialog.accept();
    await recycleClick;
    check(checks, "windows-recycle-move", await waitForFile(recycleFile, false), recycleDialog.message());
    const recycleItem = await findRecycleItem(baseUrl, recycleFile);
    if (!recycleItem) throw new Error("Recycled UI fixture did not appear in the Windows Recycle Bin.");
    recyclePath = recycleItem.path;
    check(checks, "windows-recycle-date-readable", Boolean(recycleItem.dateDeletedText) && !recycleItem.dateDeletedText.includes("?"), recycleItem.dateDeletedText);

    await clickDockAction(page, "appTrash");
    await page.locator('[data-trash-mode="windows"]').click();
    const windowsRow = page.locator(".windows-trash-row").filter({ hasText: path.basename(recycleFile) }).first();
    await windowsRow.waitFor({ state: "visible", timeout: 15000 });
    const windowsView = await inspectTrashDialog(page);
    evidence.windowsView = windowsView;
    check(checks, "windows-recycle-language", windowsView.title === "Windows Recycle Bin" && windowsView.restore === "Restore to Original Folder" && windowsView.deleteHidden && windowsView.openWindows === "Open in File Explorer", JSON.stringify(windowsView));
    check(checks, "windows-recycle-extension-visible", (await windowsRow.textContent()).includes(path.basename(recycleFile)), await windowsRow.textContent());
    await windowsRow.locator('[data-windows-recycle-select]').check();
    await resetToastEvidence(page);
    await page.locator('[data-trash-action="restore"]').click();
    check(checks, "windows-recycle-restore-original", await waitForFile(recycleFile, true), await waitForToast(page, /Restored 1 item/));
    recyclePath = "";

    const layout = await inspectTrashDialog(page);
    evidence.layout = layout;
    check(checks, "trash-dialog-layout", layout.issues.length === 0, JSON.stringify(layout.issues));
    check(checks, "browser-console-clean", pageErrors.length === 0, JSON.stringify(pageErrors));
    check(checks, "api-requests-clean", apiFailures.length === 0, JSON.stringify(apiFailures));
    await page.screenshot({ path: screenshotPath });
  } finally {
    await browser?.close().catch(() => {});
    if (recyclePath) {
      await requestJson(baseUrl, "/api/windows-recycle-bin/restore", {
        method: "POST",
        body: JSON.stringify({ paths: [recyclePath] })
      }).catch(() => {});
    }
    server.kill();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      pass: checks.filter((item) => item.status === "pass").length,
      fail: checks.filter((item) => item.status === "fail").length
    },
    checks,
    evidence,
    screenshotPath
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(latestMdPath, markdown(report), "utf8");
  console.log(markdown(report));
  if (report.summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
