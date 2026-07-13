import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifacts = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifacts, `startup-recovery-ui-${stamp}`);
const appData = path.join(runRoot, "appdata");
const stateRoot = path.join(appData, "ExploreBetter");
const existingParent = path.join(runRoot, "existing-parent");
const missingSavedPath = path.join(existingParent, "removed-session", "deep-folder");
const rightFixture = path.join(runRoot, "right-pane");
const latestJson = path.join(artifacts, "startup-recovery-ui-latest.json");
const latestMd = path.join(artifacts, "startup-recovery-ui-latest.md");
const screenshot = path.join(artifacts, "startup-recovery-ui.png");

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function requestJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function waitForServer(baseUrl, child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}: ${output.value}`);
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  throw new Error(`Server did not start: ${output.value}`);
}

async function prepareFixture() {
  await fs.mkdir(existingParent, { recursive: true });
  await fs.mkdir(rightFixture, { recursive: true });
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(path.join(existingParent, "recovered-parent-marker.txt"), "recovered\n");
  await fs.writeFile(path.join(rightFixture, "right-pane-marker.txt"), "right\n");
  await fs.writeFile(
    path.join(stateRoot, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        layout: {
          activePane: "left",
          paneLayout: "horizontal",
          panes: {
            left: { activeTab: 0, tabs: [{ path: missingSavedPath, locked: false }] },
            right: { activeTab: 0, tabs: [{ path: rightFixture, locked: false }] }
          }
        },
        settings: { startupMode: "last", focusMode: true },
        operations: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function pageSnapshot(page) {
  return page.evaluate(() => ({
    ready: Boolean(window.__exploreBetterStartup),
    status: document.getElementById("status-pill")?.textContent?.trim() || "",
    leftPath: document.querySelector('[data-path-input="left"]')?.value || "",
    rightPath: document.querySelector('[data-path-input="right"]')?.value || "",
    leftActivity: document.querySelector('[data-pane-activity="left"]')?.getAttribute("aria-label") || "",
    rightActivity: document.querySelector('[data-pane-activity="right"]')?.getAttribute("aria-label") || "",
    leftRows: [...document.querySelectorAll('[data-list="left"] [data-entry-path]')].map((row) => row.textContent || ""),
    rightRows: [...document.querySelectorAll('[data-list="right"] [data-entry-path]')].map((row) => row.textContent || ""),
    rootsVisible: getComputedStyle(document.getElementById("root-strip")).display !== "none",
    rootScrollbarsHidden: getComputedStyle(document.getElementById("root-strip")).scrollbarWidth === "none",
    paneCommandWidths: [...document.querySelectorAll('.pane[data-pane="left"] .pane-command')].map(
      (button) => Math.round(button.getBoundingClientRect().width)
    )
  }));
}

function markdown(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Startup Recovery UI Smoke\n\nGenerated: ${report.generatedAt}\n\nSummary: ${report.summary.pass} pass, ${report.summary.fail} fail.\n\n| Status | Check | Detail |\n| --- | --- | --- |\n${rows}\n`;
}

async function main() {
  await prepareFixture();
  const port = Number(process.env.PORT || 48673);
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = { value: "" };
  const checks = [];
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      EXPLORE_BETTER_WORKSPACE_ROOT: existingParent,
      EXPLORE_BETTER_WORKSPACE_LABEL: "Recovery Workspace"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => (output.value += chunk.toString()));
  child.stderr.on("data", (chunk) => (output.value += chunk.toString()));
  let browser;
  try {
    await waitForServer(baseUrl, child, output);
    const roots = await requestJson(baseUrl, "/api/roots");
    check(
      checks,
      "configured-workspace-is-launcher-independent",
      roots.cwd === existingParent && roots.shortcuts?.some((item) => item.name === "Recovery Workspace" && item.path === existingParent),
      `${roots.cwd} / ${(roots.shortcuts || []).map((item) => item.name).join(", ")}`
    );
    browser = await chromium.launch({
      executablePath:
        process.env.EB_STARTUP_RECOVERY_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__exploreBetterStartup), { timeout: 20000 });
    const recovered = await pageSnapshot(page);
    check(checks, "missing-saved-path-recovers", recovered.leftPath === existingParent, recovered.leftPath);
    check(
      checks,
      "nearest-existing-ancestor-used",
      recovered.leftRows.some((row) => row.includes("recovered-parent-marker.txt")),
      `${recovered.leftRows.length} rows`
    );
    check(
      checks,
      "other-pane-still-loads",
      recovered.rightPath === rightFixture && recovered.rightRows.some((row) => row.includes("right-pane-marker.txt")),
      `${recovered.rightPath} / ${recovered.rightRows.length} rows`
    );
    check(
      checks,
      "startup-finishes-recovered",
      recovered.ready && /^Left pane recovered to /i.test(recovered.status),
      recovered.status
    );
    check(checks, "focus-hides-root-strip", recovered.rootsVisible === false, String(recovered.rootsVisible));
    check(
      checks,
      "pane-commands-have-stable-icon-width",
      recovered.paneCommandWidths.length === 6 && recovered.paneCommandWidths.every((width) => width === 34),
      recovered.paneCommandWidths.join(",")
    );
    check(checks, "root-scrollbar-style-hidden", recovered.rootScrollbarsHidden, String(recovered.rootScrollbarsHidden));
    await page.screenshot({ path: screenshot });

    await new Promise((resolve) => setTimeout(resolve, 500));
    const savedState = await requestJson(baseUrl, "/api/state");
    const savedLeftPath = savedState.layout?.panes?.left?.tabs?.[savedState.layout?.panes?.left?.activeTab || 0]?.path;
    check(checks, "recovered-path-is-persisted", savedLeftPath === existingParent, String(savedLeftPath || "missing"));

    const explicitPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await explicitPage.goto(
      `${baseUrl}/?left=${encodeURIComponent(missingSavedPath)}&right=${encodeURIComponent(rightFixture)}`,
      { waitUntil: "domcontentloaded" }
    );
    await explicitPage.waitForFunction(
      () => document.querySelector('[data-pane-activity="left"]')?.classList.contains("error"),
      { timeout: 10000 }
    );
    const explicit = await pageSnapshot(explicitPage);
    check(
      checks,
      "explicit-missing-target-is-not-rewritten",
      explicit.leftPath !== existingParent && /could not open/i.test(explicit.leftActivity),
      `${explicit.leftPath || "empty"} / ${explicit.leftActivity}`
    );
    await explicitPage.close();

    const report = {
      generatedAt: new Date().toISOString(),
      missingSavedPath,
      recoveredPath: recovered.leftPath,
      screenshot,
      checks,
      summary: {
        pass: checks.filter((item) => item.status === "pass").length,
        fail: checks.filter((item) => item.status === "fail").length
      }
    };
    await fs.writeFile(latestJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMd, markdown(report), "utf8");
    console.log(`startup recovery UI smoke: ${report.summary.pass} pass, ${report.summary.fail} fail`);
    console.log(`wrote ${latestJson}`);
    if (report.summary.fail) process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await fs.rm(runRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
