import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { clickDockAction } from "./ui-helpers.mjs";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `default-explorer-ui-${stamp}`);
const appData = path.join(runRoot, "AppData");
const latestJsonPath = path.join(artifactsDir, "default-explorer-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "default-explorer-ui-latest.md");
const viewports = [
  { name: "desktop", width: 1366, height: 768 },
  { name: "narrow", width: 720, height: 900 }
];

function edgePath() {
  return process.env.EB_DEFAULT_EXPLORER_UI_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function waitForServer(baseUrl, child, output) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited with ${child.exitCode}: ${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/roots`);
      if (response.ok) return;
    } catch {
      // The backend is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Server did not start at ${baseUrl}: ${output()}`);
}

async function integrationSnapshot(page) {
  return page.evaluate(() => {
    const dialog = document.getElementById("integration-dialog");
    const prompt = document.getElementById("default-explorer-dialog");
    const strip = dialog?.querySelector(".integration-default-action");
    const makeDefault = strip?.querySelector('[data-integration-action="folderDefault"]');
    const restorePrevious = strip?.querySelector('[data-integration-action="removeFolderDefault"]');
    const restoreBackup = dialog?.querySelector('[data-integration-action="restoreShell"]');
    const rect = (element) => {
      const box = element?.getBoundingClientRect();
      return box
        ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }
        : null;
    };
    const dialogBox = rect(dialog);
    const stripBox = rect(strip);
    const buttonBoxes = [makeDefault, restorePrevious].map(rect);
    const labels = [...(dialog?.querySelectorAll("button") || [])].map((button) => button.textContent.trim());
    const controlOverflow = buttonBoxes.some(
      (box) => !box || !stripBox || box.left < stripBox.left - 1 || box.right > stripBox.right + 1
    );
    return {
      dialogOpen: dialog?.open === true,
      promptOpen: prompt?.open === true,
      promptConfigured:
        Boolean(prompt?.querySelector('[data-default-explorer-choice="keep"]')) &&
        Boolean(prompt?.querySelector('[data-default-explorer-choice="default"]')) &&
        prompt?.textContent.includes("Programs that explicitly run explorer.exe"),
      dialogBox,
      stripBox,
      buttonBoxes,
      labels,
      topRestoreCount: labels.filter((label) => label === "Restore Previous").length,
      restoreBackupLabel: restoreBackup?.textContent.trim() || "",
      makeDefaultLabel: makeDefault?.textContent.trim() || "",
      limitationVisible: strip?.textContent.includes("explicitly run explorer.exe") === true,
      dialogWithinViewport:
        Boolean(dialogBox) &&
        dialogBox.left >= -1 &&
        dialogBox.right <= window.innerWidth + 1 &&
        dialogBox.top >= -1 &&
        dialogBox.bottom <= window.innerHeight + 1,
      horizontalOverflow:
        document.documentElement.scrollWidth > window.innerWidth + 1 ||
        (dialog ? dialog.scrollWidth > dialog.clientWidth + 1 : true) ||
        (strip ? strip.scrollWidth > strip.clientWidth + 1 : true) ||
        controlOverflow
    };
  });
}

function markdownReport(report) {
  const lines = [
    "# Default Explorer UI Smoke",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.`,
    "",
    "| Status | Check | Detail |",
    "| --- | --- | --- |"
  ];
  for (const item of report.checks) {
    lines.push(`| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replaceAll("|", "\\|")} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  // The full acceptance runner probes a usable loopback port before launching
  // each suite. Honour that port instead of picking another Windows port at
  // random, which can land inside an excluded/reserved range and fail EACCES.
  const configuredPort = Number.parseInt(process.env.PORT || "", 10);
  const port = Number.isInteger(configuredPort) && configuredPort > 0
    ? configuredPort
    : 52000 + Math.floor(Math.random() * 8000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const snapshots = [];
  const pageErrors = [];
  let serverOutput = "";
  let browser = null;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServer(baseUrl, server, () => serverOutput);
    browser = await chromium.launch({ executablePath: edgePath(), headless: true });
    const promptContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await promptContext.route("**/api/integration/status", async (route) => {
      const response = await route.fetch();
      const status = await response.json();
      status.registry = { ...(status.registry || {}), folderDefaultEnabled: false };
      await route.fulfill({ response, json: status });
    });
    await promptContext.addInitScript(() => {
      window.exploreBetterDesktop = {
        appInfo: async () => ({ packaged: true, smoke: false })
      };
    });
    const promptPage = await promptContext.newPage();
    promptPage.on("pageerror", (error) => pageErrors.push(`prompt: ${error.message}`));
    await promptPage.goto(`${baseUrl}/?left=${encodeURIComponent(workspace)}&right=${encodeURIComponent(workspace)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await promptPage.waitForSelector("#default-explorer-dialog[open]", { timeout: 10000 });
    const promptScreenshot = path.join(artifactsDir, "default-explorer-prompt-desktop.png");
    await promptPage.screenshot({ path: promptScreenshot });
    const promptSnapshot = await integrationSnapshot(promptPage);
    snapshots.push({ viewport: { name: "prompt", width: 1366, height: 768 }, screenshot: promptScreenshot, ...promptSnapshot });
    check(checks, "packaged-prompt-open", promptSnapshot.promptOpen, "Packaged first launch offers the default-file-manager choice.");
    check(checks, "packaged-prompt-complete", promptSnapshot.promptConfigured, "First-run choice includes both actions and the explorer.exe limitation.");
    await promptContext.close();

    const page = await browser.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${baseUrl}/?left=${encodeURIComponent(workspace)}&right=${encodeURIComponent(workspace)}`, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });
      await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
      await page.waitForTimeout(350);
      await clickDockAction(page, "integration", { timeout: 5000 });
      await page.waitForSelector("#integration-dialog[open]", { timeout: 5000 });
      const snapshot = await integrationSnapshot(page);
      const screenshot = path.join(artifactsDir, `default-explorer-ui-${viewport.name}.png`);
      await page.screenshot({ path: screenshot });
      snapshots.push({ viewport, screenshot, ...snapshot });
      check(checks, `${viewport.name}-dialog-open`, snapshot.dialogOpen, "Integration Center opens from the command shelf.");
      check(checks, `${viewport.name}-prompt-packaged-only`, !snapshot.promptOpen, "First-run prompt stays closed in browser mode.");
      check(checks, `${viewport.name}-prompt-complete`, snapshot.promptConfigured, "Packaged prompt has both choices and the explorer.exe limitation.");
      check(checks, `${viewport.name}-default-controls`, snapshot.makeDefaultLabel === "Make Default" && snapshot.topRestoreCount === 1 && snapshot.restoreBackupLabel === "Restore Backup", "Default, previous-handler restore, and technical backup restore controls are unambiguous.");
      check(checks, `${viewport.name}-limitation-visible`, snapshot.limitationVisible, "Hard-coded explorer.exe behavior is disclosed beside the action.");
      check(checks, `${viewport.name}-layout`, snapshot.dialogWithinViewport && !snapshot.horizontalOverflow, "Dialog and default controls fit without horizontal overflow.");
    }
    check(checks, "page-errors", pageErrors.length === 0, `${pageErrors.length} browser page error(s).`);
  } catch (error) {
    check(checks, "smoke-execution", false, error.stack || error.message);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }

  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
  const report = {
    generatedAt: new Date().toISOString(),
    status: summary.fail ? "fail" : "pass",
    baseUrl,
    snapshots,
    pageErrors,
    serverOutput: serverOutput.slice(-4000),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`default Explorer UI smoke: ${summary.pass} pass, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
