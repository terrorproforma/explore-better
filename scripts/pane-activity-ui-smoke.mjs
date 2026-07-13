import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifacts = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifacts, `pane-activity-ui-${stamp}`);
const leftFixture = path.join(runRoot, "left");
const rightFixture = path.join(runRoot, "right");
const appData = path.join(runRoot, "appdata");
const latest = path.join(artifacts, "pane-activity-ui-latest.json");
const screenshot = path.join(artifacts, "pane-activity-ui.png");

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function requestJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`, { headers: { "content-type": "application/json" } });
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

async function prepareFixtures() {
  await fs.mkdir(leftFixture, { recursive: true });
  await fs.mkdir(rightFixture, { recursive: true });
  await fs.writeFile(path.join(leftFixture, "alpha.txt"), "alpha\n");
  await fs.writeFile(path.join(leftFixture, "beta.txt"), "beta\n");
  const batch = [];
  for (let index = 0; index < 350; index += 1) {
    batch.push(fs.writeFile(path.join(rightFixture, `right-${String(index).padStart(4, "0")}.txt`), `right ${index}\n`));
  }
  await Promise.all(batch);
}

async function activitySnapshot(page) {
  return page.evaluate(() => {
    const snapshot = (paneName) => {
      const pane = document.querySelector(`.pane[data-pane="${paneName}"]`);
      const tabbar = pane?.querySelector(".tabbar");
      const activity = pane?.querySelector(`[data-pane-activity="${paneName}"]`);
      const role = pane?.querySelector(`[data-pane-role="${paneName}"]`);
      const cluster = pane?.querySelector(".pane-status-cluster");
      const tabRect = tabbar?.getBoundingClientRect();
      const clusterRect = cluster?.getBoundingClientRect();
      const activityRect = activity?.getBoundingClientRect();
      const roleRect = role?.getBoundingClientRect();
      return {
        phase: [...(activity?.classList || [])].find((name) => ["idle", "loading", "hydrating", "ready", "error"].includes(name)) || "",
        text: activity?.textContent?.trim() || "",
        label: activity?.getAttribute("aria-label") || "",
        busy: pane?.getAttribute("aria-busy") || "",
        rows: pane?.querySelectorAll("[data-entry-path]").length || 0,
        clusterInside:
          Boolean(tabRect && clusterRect) &&
          clusterRect.left >= tabRect.left - 1 &&
          clusterRect.right <= tabRect.right + 1 &&
          clusterRect.top >= tabRect.top - 1 &&
          clusterRect.bottom <= tabRect.bottom + 1,
        controlsSeparate: Boolean(activityRect && roleRect) && activityRect.right <= roleRect.left + 1
      };
    };
    return {
      left: snapshot("left"),
      right: snapshot("right"),
      globalStatus: document.getElementById("status-pill")?.textContent || "",
      leftPath: document.querySelector('[data-path-input="left"]')?.value || ""
    };
  });
}

async function main() {
  await prepareFixtures();
  await fs.mkdir(appData, { recursive: true });
  const port = Number(process.env.PORT || 48661);
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = { value: "" };
  const checks = [];
  const pageErrors = [];
  const consoleErrors = [];
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => (output.value += chunk.toString()));
  child.stderr.on("data", (chunk) => (output.value += chunk.toString()));
  let browser;
  let releaseRightHydration;
  let releaseLeftWindow;
  const rightHydrationGate = new Promise((resolve) => (releaseRightHydration = resolve));
  const leftWindowGate = new Promise((resolve) => (releaseLeftWindow = resolve));
  const evidence = {};
  try {
    await waitForServer(baseUrl, child, output);
    browser = await chromium.launch({
      executablePath: process.env.EB_PANE_ACTIVITY_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      headless: true
    });
    const page = await browser.newPage({ viewport: { width: 1024, height: 760 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.route("**/api/list**", async (route) => {
      const url = new URL(route.request().url());
      const isRight = url.searchParams.get("path") === rightFixture;
      const isLeft = url.searchParams.get("path") === leftFixture;
      const isWindow = url.searchParams.has("offset") || url.searchParams.has("limit");
      const isFull = !url.searchParams.has("offset") && !url.searchParams.has("limit");
      if (isLeft && isWindow) {
        await leftWindowGate;
      }
      if (isRight && isFull && url.searchParams.get("format") === "compact-v2") {
        await rightHydrationGate;
      }
      await route.continue();
    });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(leftFixture)}&right=${encodeURIComponent(rightFixture)}`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForFunction(() => {
      const left = document.querySelector('[data-pane-activity="left"]');
      return left?.classList.contains("loading") && left.closest(".pane")?.getAttribute("aria-busy") === "true";
    }, null, { timeout: 10000 });
    evidence.bootstrap = await activitySnapshot(page);
    check(
      checks,
      "bootstrap-status-before-first-response",
      evidence.bootstrap.left.phase === "loading" && evidence.bootstrap.left.text === "Loading" && evidence.bootstrap.left.clusterInside,
      JSON.stringify(evidence.bootstrap.left)
    );
    releaseLeftWindow();
    await page.waitForFunction(() => {
      const left = document.querySelector('[data-pane-activity="left"]');
      const right = document.querySelector('[data-pane-activity="right"]');
      return left?.classList.contains("ready") && right?.classList.contains("hydrating");
    }, null, { timeout: 30000 });
    evidence.split = await activitySnapshot(page);
    check(checks, "left-ready-while-right-busy", evidence.split.left.phase === "ready" && evidence.split.left.busy === "false", JSON.stringify(evidence.split.left));
    check(
      checks,
      "right-hydration-progress",
      evidence.split.right.phase === "hydrating" &&
        evidence.split.right.busy === "true" &&
        evidence.split.right.text === "48+" &&
        /first 48 items while the exact total loads/i.test(evidence.split.right.label),
      JSON.stringify(evidence.split.right)
    );
    check(checks, "active-pane-owns-global-status", /^2 items/.test(evidence.split.globalStatus) && !/loading full list/i.test(evidence.split.globalStatus), evidence.split.globalStatus);
    check(checks, "status-clusters-fit", evidence.split.left.clusterInside && evidence.split.right.clusterInside && evidence.split.left.controlsSeparate && evidence.split.right.controlsSeparate, JSON.stringify(evidence.split));

    releaseRightHydration();
    await page.waitForFunction(
      () => document.querySelector('[data-pane-activity="right"]')?.classList.contains("ready"),
      null,
      { timeout: 30000 }
    );
    evidence.complete = await activitySnapshot(page);
    check(checks, "right-completes", evidence.complete.right.busy === "false" && /^350\s*\//.test(evidence.complete.right.text), JSON.stringify(evidence.complete.right));
    check(checks, "left-status-preserved", /^2\s*\//.test(evidence.complete.left.text), JSON.stringify(evidence.complete.left));

    const input = page.locator('[data-path-input="left"]');
    await input.fill(path.join(runRoot, "missing"));
    await input.press("Enter");
    await page.waitForFunction(
      () => document.querySelector('[data-pane-activity="left"]')?.classList.contains("error"),
      null,
      { timeout: 10000 }
    );
    evidence.error = await activitySnapshot(page);
    check(checks, "missing-path-pane-error", evidence.error.left.busy === "false" && /could not open/i.test(evidence.error.left.label), JSON.stringify(evidence.error.left));
    check(checks, "missing-path-preserves-pane", evidence.error.leftPath === leftFixture && evidence.error.left.rows === 2, JSON.stringify(evidence.error));
    check(checks, "missing-path-global-error", /Could not open/.test(evidence.error.globalStatus), evidence.error.globalStatus);
    const unexpectedConsoleErrors = consoleErrors.filter(
      (message) => !/Failed to load resource: the server responded with a status of 500/i.test(message)
    );
    check(
      checks,
      "runtime-clean",
      pageErrors.length === 0 && unexpectedConsoleErrors.length === 0,
      `${pageErrors.length} page, ${unexpectedConsoleErrors.length} unexpected console, and ${consoleErrors.length - unexpectedConsoleErrors.length} expected network error(s)`
    );
    await page.screenshot({ path: screenshot, fullPage: true });
  } catch (error) {
    releaseLeftWindow?.();
    releaseRightHydration?.();
    check(checks, "smoke-execution", false, error.message);
  } finally {
    releaseLeftWindow?.();
    releaseRightHydration?.();
    await browser?.close().catch(() => {});
    child.kill();
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      pass: checks.filter((item) => item.status === "pass").length,
      fail: checks.filter((item) => item.status === "fail").length
    },
    checks,
    evidence,
    screenshot,
    pageErrors,
    consoleErrors
  };
  await fs.writeFile(latest, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`pane activity UI smoke: ${report.summary.pass} pass, ${report.summary.fail} fail`);
  console.log(`wrote ${latest}`);
  if (report.summary.fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
