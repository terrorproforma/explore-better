import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `elevation-ui-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const latestJsonPath = path.join(artifactsDir, "elevation-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "elevation-ui-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_ELEVATION_UI_BROWSER || "") ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  );
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_ELEVATION_UI_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function pathExists(itemPath) {
  try {
    await fs.access(itemPath);
    return true;
  } catch {
    return false;
  }
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
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function waitForServer(baseUrl, child, getOutput) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${getOutput()}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}: ${getOutput()}`);
}

async function waitForNodeCondition(fn, label, timeoutMs = 10000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last?.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function waitForPageResult(page, fn, label, timeoutMs = 10000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await page.evaluate(fn);
    if (last?.ok) return last;
    await page.waitForTimeout(80);
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

function recoveryItem(itemPath, index, reason = "Access is denied.") {
  return {
    index,
    path: itemPath,
    name: path.basename(itemPath),
    reason
  };
}

async function seedState() {
  const deleteDir = path.join(fixtureRoot, "protected-delete");
  const copySource = path.join(fixtureRoot, "copy-source");
  const copyTarget = path.join(fixtureRoot, "copy-target");
  await Promise.all([deleteDir, copySource, copyTarget].map((dir) => fs.mkdir(dir, { recursive: true })));

  const deletePaths = ["locked-a.txt", "locked-b.txt"].map((name) => path.join(deleteDir, name));
  const copyPaths = ["admin-copy.txt"].map((name) => path.join(copySource, name));
  for (const itemPath of [...deletePaths, ...copyPaths]) {
    await fs.writeFile(itemPath, `${path.basename(itemPath)}\n`, "utf8");
  }

  const now = new Date().toISOString();
  const state = {
    version: 1,
    updatedAt: now,
    operations: [
      {
        id: "failed-delete-elevation-ui",
        type: "delete",
        label: "Delete protected files",
        status: "failed",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        result: {
          error: "Access is denied.",
          recovery: {
            type: "delete",
            targetDir: null,
            completedCount: 0,
            remainingCount: deletePaths.length,
            completed: [],
            failed: recoveryItem(deletePaths[0], 0),
            remaining: deletePaths.map((itemPath, index) => recoveryItem(itemPath, index)),
            retry: {
              type: "delete",
              body: { paths: deletePaths }
            },
            canRetryRemaining: true
          }
        },
        error: "Access is denied.",
        undo: null,
        progress: null,
        retry: {
          type: "delete",
          body: { paths: deletePaths },
          createdAt: now
        },
        retryOf: null
      },
      {
        id: "failed-copy-elevation-ui",
        type: "copy",
        label: "Copy protected file",
        status: "failed",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        result: {
          error: "Access is denied.",
          recovery: {
            type: "copy",
            targetDir: copyTarget,
            completedCount: 0,
            remainingCount: copyPaths.length,
            completed: [],
            failed: recoveryItem(copyPaths[0], 0),
            remaining: copyPaths.map((itemPath, index) => recoveryItem(itemPath, index)),
            retry: {
              type: "copy",
              body: { paths: copyPaths, targetDir: copyTarget }
            },
            canRetryRemaining: true
          }
        },
        error: "Access is denied.",
        undo: null,
        progress: null,
        retry: {
          type: "copy",
          body: { paths: copyPaths, targetDir: copyTarget },
          createdAt: now
        },
        retryOf: null
      }
    ]
  };
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return { deletePaths, copyPaths, copyTarget };
}

function operationById(state, id) {
  return (state.operations || []).find((operation) => operation.id === id) || null;
}

function summarizeOperation(operation = {}) {
  const recovery = operation.result?.recovery || null;
  return {
    id: operation.id || "",
    type: operation.type || "",
    status: operation.status || "",
    label: operation.label || "",
    elevation: recovery?.elevation || null,
    remainingCount: recovery?.remainingCount || 0,
    canRetryRemaining: recovery?.canRetryRemaining === true
  };
}

async function opsSnapshot(page) {
  return page.evaluate(() => {
    const text = (element) => (element?.textContent || "").trim().replace(/\s+/g, " ");
    return {
      open: document.getElementById("ops-dialog")?.open === true,
      rows: [...document.querySelectorAll("#operation-list .operation-row")].map((row) => ({
        title: text(row.querySelector("strong")),
        status: text(row.querySelector(".operation-status")),
        recovery: text(row.querySelector(".operation-recovery")),
        actions: [...row.querySelectorAll(".operation-actions button")].map((button) => ({
          text: text(button),
          disabled: button.disabled,
          detailsId: button.getAttribute("data-operation-details") || "",
          elevateId: button.getAttribute("data-elevated-retry-operation") || ""
        }))
      }))
    };
  });
}

async function detailsSnapshot(page) {
  return page.evaluate(() => {
    const text = (element) => (element?.textContent || "").trim().replace(/\s+/g, " ");
    const summary = [...document.querySelectorAll("#operation-details-dialog[open] .operation-details-summary > div")].map((cell) => ({
      label: text(cell.querySelector("span")),
      value: text(cell.querySelector("strong"))
    }));
    const sections = [...document.querySelectorAll("#operation-details-dialog[open] .operation-details-section")].map((section) => ({
      heading: text(section.querySelector(".operation-details-section-head strong")),
      meta: text(section.querySelector(".operation-details-section-head span")),
      text: text(section),
      rows: [...section.querySelectorAll(".operation-detail-row")].map((row) => ({
        text: text(row),
        selected: row.classList.contains("selected")
      }))
    }));
    const actions = [...document.querySelectorAll("#operation-details-dialog[open] [data-operation-details-action]")].map(
      (button) => ({
        action: button.getAttribute("data-operation-details-action") || "",
        text: text(button),
        disabled: button.disabled
      })
    );
    return {
      open: document.getElementById("operation-details-dialog")?.open === true,
      title: text(document.getElementById("operation-details-title")),
      meta: text(document.getElementById("operation-details-meta")),
      bodyText: text(document.getElementById("operation-details-body")),
      summary,
      sections,
      actions,
      remainingRows: sections.find((section) => section.heading === "Remaining Work")?.rows || [],
      elevationSection: sections.find((section) => section.heading === "Elevated Helper") || null
    };
  });
}

async function inspectElevationLayout(page) {
  return page.evaluate(() => {
    const issues = [];
    const samples = [];
    const text = (element) => (element?.textContent || "").trim().replace(/\s+/g, " ");
    const selectors = [
      ["#ops-dialog[open] .operation-elevate", "ops-elevate"],
      ["#operation-details-dialog[open] .operation-elevate", "details-elevate"],
      ["#operation-details-dialog[open] .operation-elevation-summary > div", "elevation-summary"],
      ["#operation-details-dialog[open] .operation-elevation-command", "elevation-command"]
    ];
    for (const [selector, area] of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) continue;
        const sample = {
          area,
          text: text(element).slice(0, 120),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          clipped: element.scrollWidth > element.clientWidth + 4 || element.scrollHeight > element.clientHeight + 4,
          squished: rect.width < 28 || rect.height < 22
        };
        samples.push(sample);
        if (sample.clipped || sample.squished) issues.push(sample);
      }
    }
    return { issues, samples };
  });
}

function actionById(snapshot, action) {
  return (snapshot.actions || []).find((item) => item.action === action) || null;
}

function summaryValue(snapshot, label) {
  return (snapshot.summary || []).find((item) => item.label === label)?.value || "";
}

function rowByTitle(snapshot, title) {
  return (snapshot.rows || []).find((row) => row.title === title) || null;
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Elevation UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Elevated Request

| Field | Value |
| --- | --- |
| Operation | ${report.intercept?.operationId || "n/a"} |
| UI requested launch | ${report.intercept?.launchRequested ?? "n/a"} |
| Smoke launch rewrite | ${report.intercept?.launchRewrittenTo ?? "n/a"} |
| Indexes | ${(report.intercept?.indexes || []).join(", ") || "none"} |

## Prepared Helper

| Field | Value |
| --- | --- |
| Status | ${report.prepared?.status || "n/a"} |
| Item count | ${report.prepared?.itemCount ?? "n/a"} |
| Payload hash verified | ${report.prepared?.payloadHashVerified ?? "n/a"} |
| Log path | ${report.prepared?.logPath || "n/a"} |
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixture = await seedState();
  const port = Number(optionValue("--port", process.env.PORT || 55000 + Math.floor(Math.random() * 9000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const checks = [];
  const consoleMessages = [];
  const pageErrors = [];
  const apiRequests = [];
  const apiResponses = [];
  let serverOutput = "";
  let browser = null;
  let opsInitial = null;
  let detailsInitial = null;
  let detailsAfterClear = null;
  let detailsAfterSelectAll = null;
  let detailsAfterElevate = null;
  let layout = { issues: [], samples: [] };
  let prepared = null;
  let intercept = null;

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
    const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        consoleMessages.push({ type: message.type(), text: message.text() });
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    page.on("response", (response) => {
      try {
        const parsed = new URL(response.url());
        if (parsed.pathname === "/api/operation/elevated-retry") {
          apiResponses.push({ status: response.status(), url: response.url() });
        }
      } catch {
        // Ignore browser protocol noise.
      }
    });
    await page.route("**/api/operation/elevated-retry", async (route) => {
      const request = route.request();
      const rawBody = request.postData() || "{}";
      const body = JSON.parse(rawBody);
      apiRequests.push(body);
      intercept = {
        operationId: body.operationId || "",
        indexes: Array.isArray(body.indexes) ? body.indexes : [],
        launchRequested: body.launch === true,
        launchRewrittenTo: false
      };
      await route.continue({
        postData: JSON.stringify({ ...body, launch: false })
      });
    });

    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixtureRoot)}&right=${encodeURIComponent(fixtureRoot)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await page.evaluate(() => document.querySelector('[data-global-action="ops"]')?.scrollIntoView({ block: "nearest" }));
    await page.locator('[data-global-action="ops"]').click({ timeout: 5000 });
    await waitForPageResult(
      page,
      () => ({
        ok:
          document.getElementById("ops-dialog")?.open === true &&
          document.querySelectorAll("#operation-list .operation-row").length >= 2,
        rows: document.querySelectorAll("#operation-list .operation-row").length
      }),
      "ops dialog rows"
    );
    opsInitial = await opsSnapshot(page);
    const copyRow = rowByTitle(opsInitial, "Copy protected file");
    const deleteRow = rowByTitle(opsInitial, "Delete protected files");
    check(checks, "ops-copy-elevate-visible", Boolean(copyRow?.actions?.some((item) => item.elevateId === "failed-copy-elevation-ui")), "Copy row exposes Elevate Remaining.");
    check(checks, "ops-delete-elevate-visible", Boolean(deleteRow?.actions?.some((item) => item.elevateId === "failed-delete-elevation-ui")), "Delete row exposes Elevate Remaining.");

    await page.locator('[data-operation-details="failed-delete-elevation-ui"]').click({ timeout: 5000 });
    await waitForPageResult(
      page,
      () => ({
        ok:
          document.getElementById("operation-details-dialog")?.open === true &&
          /Delete protected files/.test(document.getElementById("operation-details-title")?.textContent || ""),
        title: document.getElementById("operation-details-title")?.textContent || ""
      }),
      "delete details open"
    );
    detailsInitial = await detailsSnapshot(page);
    check(
      checks,
      "details-elevate-ready",
      summaryValue(detailsInitial, "Elevated") === "Ready",
      `Details summary reports elevated helper ${summaryValue(detailsInitial, "Elevated") || "missing"}.`
    );
    check(
      checks,
      "details-selected-elevate-enabled",
      actionById(detailsInitial, "elevate-selected")?.disabled === false && actionById(detailsInitial, "elevate-remaining")?.disabled === false,
      "Elevate Selected and Elevate All start enabled with all remaining work selected."
    );

    await page.locator('[data-operation-details-action="select-none"]').click({ timeout: 5000 });
    detailsAfterClear = await detailsSnapshot(page);
    check(
      checks,
      "details-clear-disables-selected-elevation",
      actionById(detailsAfterClear, "elevate-selected")?.disabled === true && actionById(detailsAfterClear, "elevate-remaining")?.disabled === false,
      "Clearing selected remaining work disables Elevate Selected but keeps Elevate All available."
    );

    await page.locator('[data-operation-details-action="select-all"]').click({ timeout: 5000 });
    detailsAfterSelectAll = await detailsSnapshot(page);
    check(
      checks,
      "details-select-all-enables-selected-elevation",
      actionById(detailsAfterSelectAll, "elevate-selected")?.disabled === false &&
        detailsAfterSelectAll.remainingRows.every((row) => row.selected === true),
      "Select All selects remaining rows and enables Elevate Selected."
    );

    await page.locator('[data-operation-details-action="elevate-selected"]').click({ timeout: 5000 });
    const elevationState = await waitForNodeCondition(async () => {
      const state = await requestJson(baseUrl, "/api/state");
      const operation = operationById(state, "failed-delete-elevation-ui");
      const elevation = operation?.result?.recovery?.elevation || null;
      return {
        ok: elevation?.status === "prepared",
        operation: summarizeOperation(operation)
      };
    }, "elevation prepared state");
    await waitForPageResult(
      page,
      () => ({
        ok: /Elevated Helper/.test(document.getElementById("operation-details-body")?.textContent || ""),
        body: document.getElementById("operation-details-body")?.textContent || ""
      }),
      "elevation section visible"
    );
    detailsAfterElevate = await detailsSnapshot(page);
    layout = await inspectElevationLayout(page);
    const elevation = elevationState.operation.elevation || {};
    const helperPaths = [elevation.scriptPath, elevation.payloadPath, elevation.manifestPath, elevation.launcherPath].filter(Boolean);
    const helperExists = [];
    for (const helperPath of helperPaths) {
      helperExists.push({ path: helperPath, exists: await pathExists(helperPath) });
    }
    const payloadText = elevation.payloadPath ? await fs.readFile(elevation.payloadPath, "utf8") : "";
    const manifest = elevation.manifestPath ? JSON.parse(await fs.readFile(elevation.manifestPath, "utf8")) : {};
    const payloadHash = payloadText ? crypto.createHash("sha256").update(payloadText).digest("hex") : "";
    prepared = {
      ...elevation,
      helperExists,
      payloadHashVerified: Boolean(payloadHash && manifest.payloadSha256 === payloadHash),
      payloadItemCount: payloadText ? JSON.parse(payloadText).items?.length || 0 : 0
    };

    check(checks, "ui-requested-launch-true", intercept?.launchRequested === true, "Browser UI requested launch=true.");
    check(checks, "smoke-rewrote-launch-false", intercept?.launchRewrittenTo === false, "Smoke rewrote launch=false to avoid UAC.");
    check(
      checks,
      "ui-sent-selected-indexes",
      Array.isArray(intercept?.indexes) && intercept.indexes.length === fixture.deletePaths.length,
      `UI sent ${intercept?.indexes?.length || 0} selected index(es).`
    );
    check(checks, "elevation-state-prepared", prepared.status === "prepared", `Recorded status was ${prepared.status || "missing"}.`);
    check(checks, "elevation-helper-files-exist", helperExists.every((item) => item.exists), `${helperExists.filter((item) => item.exists).length}/${helperExists.length} helper file(s) exist.`);
    check(checks, "elevation-payload-hash", prepared.payloadHashVerified === true, "Payload hash matches manifest.");
    check(checks, "elevation-payload-item-count", prepared.payloadItemCount === fixture.deletePaths.length, `Payload item count ${prepared.payloadItemCount}.`);
    check(checks, "details-elevation-section-visible", Boolean(detailsAfterElevate.elevationSection), "Operation details show the Elevated Helper section.");
    check(checks, "elevation-layout-clean", layout.issues.length === 0, `${layout.issues.length} elevation layout issue(s).`);
    check(checks, "browser-console-clean", pageErrors.length === 0, `${pageErrors.length} page error(s).`);
  } catch (error) {
    check(checks, "smoke-execution", false, error.message);
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
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
    fixtureRoot,
    opsInitial,
    detailsInitial,
    detailsAfterClear,
    detailsAfterSelectAll,
    detailsAfterElevate,
    intercept,
    apiRequests,
    apiResponses,
    prepared,
    layout,
    consoleMessages,
    pageErrors,
    serverOutput: serverOutput.slice(-4000),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`elevation UI smoke: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
