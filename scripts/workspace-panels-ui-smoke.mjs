import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifacts = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifacts, `workspace-panels-ui-${stamp}`);
const appData = path.join(runRoot, "appdata");
const leftFixture = path.join(runRoot, "left");
const rightFixture = path.join(runRoot, "right");
const latestJson = path.join(artifacts, "workspace-panels-ui-latest.json");
const latestMd = path.join(artifacts, "workspace-panels-ui-latest.md");
const screenshot = path.join(artifacts, "workspace-panels-ui.png");

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
  await fs.mkdir(leftFixture, { recursive: true });
  await fs.mkdir(rightFixture, { recursive: true });
  await fs.writeFile(path.join(leftFixture, "left-marker.txt"), "left\n", "utf8");
  await fs.writeFile(path.join(rightFixture, "right-marker.txt"), "right\n", "utf8");
}

async function snapshot(page) {
  return page.evaluate(() => {
    const geometry = (selector) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return rect
        ? { display: getComputedStyle(element).display, x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null;
    };
    return {
      shell: document.querySelector(".app-shell")?.className || "",
      layout: document.querySelector(".workbench")?.className || "",
      navigator: geometry(".nav-rail"),
      left: geometry('.pane[data-pane="left"]'),
      right: geometry('.pane[data-pane="right"]'),
      preview: geometry(".inspector"),
      panelButtons: [...document.querySelectorAll(".panel-visibility-toggle [data-panel-action]")].map((button) => ({
        panel: button.dataset.panelAction,
        label: button.getAttribute("aria-label"),
        pressed: button.getAttribute("aria-pressed"),
        disabled: button.disabled,
        width: Math.round(button.getBoundingClientRect().width)
      })),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  });
}

function markdown(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replaceAll("|", "\\|")} |`)
    .join("\n");
  return `# Workspace Panels UI Smoke\n\nGenerated: ${report.generatedAt}\n\nSummary: ${report.summary.pass} pass, ${report.summary.fail} fail.\n\n| Status | Check | Detail |\n| --- | --- | --- |\n${rows}\n`;
}

async function main() {
  await prepareFixture();
  const port = Number(process.env.PORT || 48691);
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = { value: "" };
  const checks = [];
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => (output.value += chunk.toString()));
  child.stderr.on("data", (chunk) => (output.value += chunk.toString()));
  let browser;
  try {
    await waitForServer(baseUrl, child, output);
    browser = await chromium.launch({
      executablePath: process.env.EB_WORKSPACE_PANELS_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(leftFixture)}&right=${encodeURIComponent(rightFixture)}`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForFunction(() => Boolean(window.__exploreBetterStartup), { timeout: 20000 });

    const initial = await snapshot(page);
    check(checks, "panels-start-visible", initial.navigator.display !== "none" && initial.preview.display !== "none", `${initial.navigator.display}/${initial.preview.display}`);
    check(checks, "panel-buttons-stable", initial.panelButtons.length === 2 && initial.panelButtons.every((item) => item.width === 32), JSON.stringify(initial.panelButtons));

    await page.locator('.nav-rail [data-panel-action="navigator"]').click();
    await page.waitForFunction(() => document.querySelector(".app-shell")?.classList.contains("navigator-off"));
    const navHidden = await snapshot(page);
    check(checks, "navigator-header-collapses", navHidden.navigator.display === "none" && navHidden.shell.includes("navigator-off"), navHidden.shell);
    check(checks, "navigator-collapse-reclaims-width", navHidden.left.width >= initial.left.width * 1.25, `${initial.left.width.toFixed(1)} -> ${navHidden.left.width.toFixed(1)}`);
    check(checks, "navigator-toggle-updates", navHidden.panelButtons[0]?.label === "Show navigator" && navHidden.panelButtons[0]?.pressed === "false", JSON.stringify(navHidden.panelButtons[0]));

    await page.locator('.inspector [data-panel-action="preview"]').click();
    await page.waitForFunction(() => document.querySelector(".app-shell")?.classList.contains("inspector-off"));
    const bothHidden = await snapshot(page);
    check(checks, "preview-header-collapses", bothHidden.preview.display === "none" && bothHidden.shell.includes("inspector-off"), bothHidden.shell);
    check(checks, "preview-collapse-reclaims-height", bothHidden.left.height + bothHidden.right.height > navHidden.left.height + navHidden.right.height, `${(navHidden.left.height + navHidden.right.height).toFixed(1)} -> ${(bothHidden.left.height + bothHidden.right.height).toFixed(1)}`);
    check(checks, "no-workspace-overflow", !bothHidden.horizontalOverflow, String(bothHidden.horizontalOverflow));

    for (const mode of ["vertical", "horizontal", "single"]) {
      await page.locator(`[data-layout-mode="${mode}"]`).click();
      await page.waitForFunction((expected) => document.querySelector(".workbench")?.classList.contains(`layout-${expected}`), mode);
      const current = await snapshot(page);
      const visiblePanes = [current.left, current.right].filter((item) => item?.display !== "none");
      check(
        checks,
        `collapsed-panels-fit-${mode}`,
        visiblePanes.length === (mode === "single" ? 1 : 2) && visiblePanes.every((item) => item.width > 0 && item.height > 0) && !current.horizontalOverflow,
        JSON.stringify({ layout: current.layout, visiblePanes, overflow: current.horizontalOverflow })
      );
    }

    await page.locator('[data-layout-mode="horizontal"]').click();
    await page.waitForFunction(() => document.querySelector(".workbench")?.classList.contains("layout-horizontal"));
    await page.locator('[data-topbar-action="focus"]').click();
    await page.waitForFunction(() => document.querySelector(".app-shell")?.classList.contains("focus-files"));
    const focused = await snapshot(page);
    check(checks, "focus-disables-panel-controls", focused.panelButtons.every((item) => item.disabled), JSON.stringify(focused.panelButtons));
    await page.locator('[data-topbar-action="focus"]').click();
    await page.waitForFunction(() => !document.querySelector(".app-shell")?.classList.contains("focus-files"));
    const focusRestored = await snapshot(page);
    check(checks, "focus-preserves-individual-panel-state", focusRestored.navigator.display === "none" && focusRestored.preview.display === "none", focusRestored.shell);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__exploreBetterStartup), { timeout: 20000 });
    const persisted = await snapshot(page);
    const saved = await requestJson(baseUrl, "/api/state");
    check(
      checks,
      "panel-state-persists",
      persisted.navigator.display === "none" && persisted.preview.display === "none" && saved.settings?.navigator === false && saved.settings?.inspector === false,
      `${persisted.shell} / ${saved.settings?.navigator}/${saved.settings?.inspector}`
    );

    await page.locator('.panel-visibility-toggle [data-panel-action="navigator"]').click();
    await page.waitForFunction(() => !document.querySelector(".app-shell")?.classList.contains("navigator-off"));
    await page.locator('.panel-visibility-toggle [data-panel-action="preview"]').click();
    await page.waitForFunction(() => !document.querySelector(".app-shell")?.classList.contains("inspector-off"));
    const restored = await snapshot(page);
    check(checks, "dock-controls-restore-panels", restored.navigator.display !== "none" && restored.preview.display !== "none", restored.shell);
    await page.screenshot({ path: screenshot });

    const report = {
      generatedAt: new Date().toISOString(),
      screenshot,
      geometry: { initial, navHidden, bothHidden, restored },
      checks,
      summary: {
        pass: checks.filter((item) => item.status === "pass").length,
        fail: checks.filter((item) => item.status === "fail").length
      }
    };
    await fs.writeFile(latestJson, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMd, markdown(report), "utf8");
    console.log(`workspace panels UI smoke: ${report.summary.pass} pass, ${report.summary.fail} fail`);
    console.log(`wrote ${latestJson}`);
    if (report.summary.fail) process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    child.kill();
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await fs.rm(runRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
