import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { clickDockAction } from "./ui-helpers.mjs";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `ops-recovery-ui-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const latestJsonPath = path.join(artifactsDir, "ops-recovery-ui-latest.json");
const latestMdPath = path.join(artifactsDir, "ops-recovery-ui-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_OPS_RECOVERY_UI_BROWSER || "") ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  );
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_OPS_RECOVERY_UI_KEEP_FIXTURE === "1";
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

async function seedState() {
  const copySource = path.join(fixtureRoot, "copy-source");
  const copyTarget = path.join(fixtureRoot, "copy-target");
  const transferSource = path.join(fixtureRoot, "transfer-source");
  const transferTarget = path.join(fixtureRoot, "transfer-target");
  const syncLeft = path.join(fixtureRoot, "sync-left");
  const syncRight = path.join(fixtureRoot, "sync-right");
  await Promise.all(
    [copySource, copyTarget, transferSource, transferTarget, syncLeft, syncRight].map((dir) =>
      fs.mkdir(dir, { recursive: true })
    )
  );

  const copyPaths = ["a.txt", "b.txt", "c.txt"].map((name) => path.join(copySource, name));
  for (const itemPath of copyPaths) {
    await fs.writeFile(itemPath, `${path.basename(itemPath)}\n`, "utf8");
  }
  const transferDone = path.join(transferSource, "done.txt");
  const transferRemaining = path.join(transferSource, "remaining.txt");
  await fs.writeFile(transferDone, "done\n", "utf8");
  await fs.writeFile(transferRemaining, "remaining\n", "utf8");
  await fs.writeFile(path.join(syncLeft, "one.txt"), "one\n", "utf8");
  await fs.writeFile(path.join(syncLeft, "two.txt"), "two\n", "utf8");
  await fs.writeFile(path.join(syncLeft, "three.txt"), "three\n", "utf8");

  const now = new Date().toISOString();
  const state = {
    version: 1,
    updatedAt: now,
    operations: [
      {
        id: "running-copy",
        type: "copy",
        label: "Copy files",
        status: "running",
        createdAt: now,
        startedAt: now,
        finishedAt: null,
        result: null,
        error: null,
        undo: null,
        progress: {
          unit: "items",
          total: copyPaths.length,
          completed: 1,
          phase: "Copying",
          current: "b.txt",
          currentPath: copyPaths[1],
          updatedAt: now
        },
        retry: {
          type: "copy",
          body: {
            paths: copyPaths,
            targetDir: copyTarget
          },
          createdAt: now
        },
        retryOf: null
      },
      {
        id: "paused-transfer",
        type: "transfer",
        label: "Transfer file",
        status: "paused",
        createdAt: now,
        startedAt: now,
        finishedAt: null,
        result: {
          mode: "copy",
          transferred: [path.join(transferTarget, "done.txt")],
          recovery: {
            type: "transfer",
            targetDir: transferTarget,
            completedCount: 1,
            remainingCount: 1,
            completed: [
              {
                index: 0,
                path: transferDone,
                name: "done.txt",
                dest: path.join(transferTarget, "done.txt")
              }
            ],
            failed: null,
            remaining: [
              {
                index: 1,
                path: transferRemaining,
                name: "remaining.txt"
              }
            ],
            retry: {
              type: "transfer",
              body: {
                paths: [transferRemaining],
                targetDir: transferTarget,
                mode: "copy",
                conflictMode: "unique"
              }
            },
            canRetryRemaining: true
          }
        },
        error: null,
        undo: null,
        progress: {
          unit: "items",
          total: 2,
          completed: 1,
          phase: "Paused",
          currentPath: transferRemaining,
          updatedAt: now
        },
        retry: {
          type: "transfer",
          body: {
            paths: [transferDone, transferRemaining],
            targetDir: transferTarget,
            mode: "copy",
            conflictMode: "unique"
          },
          createdAt: now
        },
        retryOf: null
      },
      {
        id: "queued-sync",
        type: "sync",
        label: "Sync folders",
        status: "queued",
        createdAt: now,
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
        undo: null,
        progress: {
          unit: "items",
          total: 3,
          completed: 2,
          phase: "Queued",
          updatedAt: now
        },
        retry: {
          type: "sync",
          body: {
            leftPath: syncLeft,
            rightPath: syncRight,
            direction: "leftToRight",
            overwrite: true,
            items: ["one.txt", "two.txt", "three.txt"]
          },
          createdAt: now
        },
        retryOf: null
      },
      {
        id: "completed-keep",
        type: "copy",
        label: "Completed copy",
        status: "completed",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        result: { copied: [] },
        error: null,
        undo: null,
        progress: {
          unit: "items",
          total: 0,
          completed: 0,
          phase: "Completed",
          updatedAt: now
        },
        retry: null,
        retryOf: null
      }
    ]
  };
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  return { copyPaths, copyTarget, transferRemaining, transferTarget, syncLeft, syncRight };
}

function operationById(state, id) {
  return (state.operations || []).find((operation) => operation.id === id) || null;
}

function recoveredSummary(state) {
  return ["running-copy", "paused-transfer", "queued-sync"].map((id) => {
    const operation = operationById(state, id) || {};
    const recovery = operation.result?.recovery || {};
    return {
      id,
      type: recovery.type || operation.type || "",
      status: operation.status || "",
      interrupted: recovery.interrupted === true,
      partialCompletionUnverified: recovery.partialCompletionUnverified === true,
      canRetryRemaining: recovery.canRetryRemaining === true,
      completedCount: Number(recovery.completedCount || 0),
      remainingCount: Number(recovery.remainingCount || 0),
      error: operation.error || ""
    };
  });
}

function summarizeOperation(operation = {}) {
  return {
    id: operation.id || "",
    type: operation.type || "",
    status: operation.status || "",
    label: operation.label || "",
    retryOf: operation.retryOf || null,
    progressPhase: operation.progress?.phase || "",
    resultKeys: Object.keys(operation.result || {}),
    recovery: operation.result?.recovery
      ? {
          type: operation.result.recovery.type || "",
          completedCount: operation.result.recovery.completedCount || 0,
          remainingCount: operation.result.recovery.remainingCount || 0,
          interrupted: operation.result.recovery.interrupted === true,
          lastSelectedRetryOperationId: operation.result.recovery.lastSelectedRetryOperationId || null,
          lastRetryOperationId: operation.result.recovery.lastRetryOperationId || null
        }
      : null
  };
}

async function opsSnapshot(page) {
  return page.evaluate(() => {
    const text = (element) => (element?.textContent || "").trim().replace(/\s+/g, " ");
    const rows = [...document.querySelectorAll("#operation-list .operation-row")].map((row) => ({
      title: text(row.querySelector("strong")),
      status: text(row.querySelector(".operation-status")),
      meta: [...row.querySelectorAll(".operation-meta span")].map(text),
      recovery: text(row.querySelector(".operation-recovery")),
      hasRecovery: Boolean(row.querySelector(".operation-recovery")),
      actions: [...row.querySelectorAll(".operation-actions button")].map((button) => ({
        text: text(button),
        disabled: button.disabled,
        retryRemainingId: button.getAttribute("data-retry-remaining-operation") || "",
        detailsId: button.getAttribute("data-operation-details") || "",
        elevateId: button.getAttribute("data-elevated-retry-operation") || ""
      })),
      className: row.className
    }));
    return {
      open: document.getElementById("ops-dialog")?.open === true,
      readout: text(document.getElementById("operation-readout")),
      readoutClass: document.getElementById("operation-readout")?.className || "",
      rows
    };
  });
}

async function detailsSnapshot(page) {
  return page.evaluate(() => {
    const text = (element) => (element?.textContent || "").trim().replace(/\s+/g, " ");
    const body = document.getElementById("operation-details-body");
    const summary = [...document.querySelectorAll("#operation-details-dialog[open] .operation-details-summary > div")].map((cell) => ({
      label: text(cell.querySelector("span")),
      value: text(cell.querySelector("strong"))
    }));
    const sections = [...document.querySelectorAll("#operation-details-dialog[open] .operation-details-section")].map((section) => ({
      heading: text(section.querySelector(".operation-details-section-head strong")),
      meta: text(section.querySelector(".operation-details-section-head span")),
      rows: [...section.querySelectorAll(".operation-detail-row")].map((row) => ({
        text: text(row),
        selected: row.classList.contains("selected"),
        failed: row.classList.contains("failed"),
        handled: row.classList.contains("handled")
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
      bodyText: text(body),
      summary,
      sections,
      actions,
      remainingRows: sections.find((section) => section.heading === "Remaining Work")?.rows || [],
      failedRows: sections.find((section) => section.heading === "Failed Item")?.rows || [],
      completedRows: sections.find((section) => section.heading === "Completed Items")?.rows || []
    };
  });
}

async function inspectOpsLayout(page) {
  return page.evaluate(() => {
    const issues = [];
    const samples = [];
    const text = (element) => (element?.textContent || "").trim().replace(/\s+/g, " ");
    const boundary = (selector) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect?.();
      return rect ? { left: rect.left, right: rect.right } : null;
    };
    const opsBounds = boundary("#ops-dialog[open]");
    const detailsBounds = boundary("#operation-details-dialog[open]");
    const overflowSelectors = [
      ["#operation-list", "operation-list"],
      ["#operation-details-body", "operation-details-body"]
    ];
    for (const [selector, area] of overflowSelectors) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const sample = {
        area,
        text: "",
        width: Math.round(element.getBoundingClientRect().width),
        height: Math.round(element.getBoundingClientRect().height),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        clipped: element.scrollWidth > element.clientWidth + 4,
        squished: false
      };
      samples.push(sample);
      if (sample.clipped) issues.push(sample);
    }
    const selectors = [
      ["#ops-dialog[open] .operation-actions button", "ops-actions", opsBounds],
      ["#ops-dialog[open] .operation-status", "ops-status", opsBounds],
      ["#operation-details-dialog[open] .operation-details-actions button", "details-actions", detailsBounds],
      ["#operation-details-dialog[open] .operation-details-summary > div", "details-summary", detailsBounds],
      ["#operation-details-dialog[open] .operation-detail-kind", "details-kind", detailsBounds]
    ];
    for (const [selector, area, bounds] of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
          continue;
        }
        const sample = {
          area,
          text: text(element).slice(0, 120),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          clipped: element.scrollWidth > element.clientWidth + 4 || element.scrollHeight > element.clientHeight + 4,
          squished: rect.width < 28 || rect.height < 22,
          outsideDialog: Boolean(bounds && (rect.left < bounds.left - 4 || rect.right > bounds.right + 4))
        };
        samples.push(sample);
        if (sample.clipped || sample.squished || sample.outsideDialog) {
          issues.push(sample);
        }
      }
    }
    return { issues, samples };
  });
}

function actionById(snapshot, action) {
  return (snapshot.actions || []).find((item) => item.action === action) || null;
}

function rowByTitle(snapshot, title) {
  return (snapshot.rows || []).find((row) => row.title === title) || null;
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  const recoveredRows = (report.opsDialog?.rows || [])
    .filter((row) => row.hasRecovery)
    .map((row) => `| ${row.title} | ${row.status} | ${row.actions.map((action) => action.text).join(", ")} |`)
    .join("\n");
  return `# Ops Recovery UI Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Visible Recovery Rows

| Operation | Status | Actions |
| --- | --- | --- |
${recoveredRows}

## Retry Proof

| Field | Value |
| --- | --- |
| Source operation | ${report.retry?.sourceOperationId || "n/a"} |
| Retry operation | ${report.retry?.operation?.id || "n/a"} |
| Retry status | ${report.retry?.operation?.status || "n/a"} |
| Copied targets | ${(report.retry?.copiedTargets || []).join(", ") || "n/a"} |
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
  const apiEvents = [];
  let serverOutput = "";
  let backendState = null;
  let opsDialog = null;
  let detailsInitial = null;
  let detailsAfterClear = null;
  let detailsAfterSelectAll = null;
  let detailsAfterRetry = null;
  let opsAfterRetry = null;
  let layout = { issues: [], samples: [] };
  let retry = null;
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
    backendState = await requestJson(baseUrl, "/api/state");

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
        if (parsed.pathname.startsWith("/api/operation/")) {
          apiEvents.push({ endpoint: parsed.pathname, status: response.status() });
        }
      } catch {
        // Ignore non-URL protocol noise from the browser.
      }
    });

    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixtureRoot)}&right=${encodeURIComponent(fixtureRoot)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10000 });
    await clickDockAction(page, "ops", { timeout: 5000 });
    await waitForPageResult(
      page,
      () => ({
        ok:
          document.getElementById("ops-dialog")?.open === true &&
          document.querySelectorAll("#operation-list .operation-row").length >= 4,
        rows: document.querySelectorAll("#operation-list .operation-row").length
      }),
      "ops dialog rows"
    );
    opsDialog = await opsSnapshot(page);

    await page.locator('[data-operation-details="running-copy"]').click({ timeout: 5000 });
    await waitForPageResult(
      page,
      () => ({
        ok:
          document.getElementById("operation-details-dialog")?.open === true &&
          /Copy files/.test(document.getElementById("operation-details-title")?.textContent || ""),
        title: document.getElementById("operation-details-title")?.textContent || ""
      }),
      "copy details open"
    );
    detailsInitial = await detailsSnapshot(page);

    await page.locator('[data-operation-details-action="select-none"]').click({ timeout: 5000 });
    detailsAfterClear = await detailsSnapshot(page);
    await page.locator('[data-operation-details-action="select-all"]').click({ timeout: 5000 });
    detailsAfterSelectAll = await detailsSnapshot(page);
    layout = await inspectOpsLayout(page);

    await page.locator('[data-operation-details-action="retry-selected"]').click({ timeout: 5000 });
    const retryState = await waitForNodeCondition(async () => {
      const state = await requestJson(baseUrl, "/api/state");
      const operation = (state.operations || []).find((item) => item.retryOf === "running-copy");
      const source = summarizeOperation(operationById(state, "running-copy"));
      return {
        ok:
          operation?.status === "completed" &&
          source.recovery?.lastSelectedRetryOperationId === operation.id,
        operation: summarizeOperation(operation),
        source
      };
    }, "selected recovery retry operation");
    await waitForNodeCondition(
      async () => ({
        ok: apiEvents.some((event) => event.endpoint === "/api/operation/retry-selected" && event.status === 200),
        events: apiEvents
      }),
      "selected recovery retry response"
    );
    detailsAfterRetry = await detailsSnapshot(page);
    opsAfterRetry = await opsSnapshot(page);

    const copiedTargets = [
      path.join(fixture.copyTarget, "b.txt"),
      path.join(fixture.copyTarget, "c.txt")
    ];
    const copiedTargetStatuses = await Promise.all(copiedTargets.map((target) => pathExists(target)));
    retry = {
      sourceOperationId: "running-copy",
      operation: retryState.operation,
      sourceAfterRetry: retryState.source,
      copiedTargets,
      copiedTargetStatuses
    };

    const recoveries = recoveredSummary(backendState);
    const copyRow = rowByTitle(opsDialog, "Copy files");
    const transferRow = rowByTitle(opsDialog, "Transfer file");
    const syncRow = rowByTitle(opsDialog, "Sync folders");
    const completedRow = rowByTitle(opsDialog, "Completed copy");
    check(
      checks,
      "backend-recovered-interrupted-ops",
      recoveries.length === 3 &&
        recoveries.every(
          (item) =>
            item.status === "failed" &&
            item.interrupted === true &&
            item.partialCompletionUnverified === true &&
            item.canRetryRemaining === true
        ),
      recoveries.map((item) => `${item.id}:${item.status}:${item.remainingCount}`).join(", ")
    );
    check(
      checks,
      "ops-button-opened-history",
      opsDialog.open === true && (opsDialog.rows || []).length >= 4,
      `open=${opsDialog.open}; rows=${opsDialog.rows?.length || 0}; readout=${opsDialog.readout}.`
    );
    check(
      checks,
      "visible-interrupted-rows",
      [copyRow, transferRow, syncRow].every(
        (row) =>
          row?.status === "failed" &&
          row.hasRecovery === true &&
          /Recovery/i.test(row.recovery) &&
          row.actions.some((action) => action.text === "Details") &&
          row.actions.some((action) => /Retry Remaining/i.test(action.text))
      ),
      [copyRow, transferRow, syncRow].map((row) => `${row?.title || "missing"}:${row?.status || ""}`).join(", ")
    );
    check(
      checks,
      "completed-row-unchanged",
      completedRow?.status === "completed" && !completedRow?.hasRecovery,
      `completed status=${completedRow?.status || "missing"}; hasRecovery=${completedRow?.hasRecovery === true}.`
    );
    check(
      checks,
      "details-show-recovery-and-actions",
      detailsInitial.open === true &&
        detailsInitial.title === "Copy files" &&
        detailsInitial.summary.some((item) => item.label === "Status" && item.value === "failed") &&
        detailsInitial.summary.some((item) => item.label === "Remaining" && item.value === "2") &&
        detailsInitial.remainingRows.length === 2 &&
        detailsInitial.failedRows.length === 1 &&
        actionById(detailsInitial, "retry-selected")?.disabled === false &&
        actionById(detailsInitial, "retry-remaining")?.disabled === false &&
        actionById(detailsInitial, "elevate-selected")?.disabled === false,
      `remaining=${detailsInitial.remainingRows.length}; failed=${detailsInitial.failedRows.length}; actions=${detailsInitial.actions
        .map((item) => `${item.action}:${item.disabled ? "disabled" : "enabled"}`)
        .join(", ")}.`
    );
    check(
      checks,
      "details-selection-buttons-responsive",
      detailsAfterClear.remainingRows.every((row) => row.selected === false) &&
        actionById(detailsAfterClear, "retry-selected")?.disabled === true &&
        detailsAfterSelectAll.remainingRows.length === 2 &&
        detailsAfterSelectAll.remainingRows.every((row) => row.selected === true) &&
        actionById(detailsAfterSelectAll, "retry-selected")?.disabled === false,
      `clear selected=${detailsAfterClear.remainingRows.filter((row) => row.selected).length}; select-all selected=${detailsAfterSelectAll.remainingRows.filter((row) => row.selected).length}.`
    );
    check(
      checks,
      "retry-selected-click-created-operation",
      retry.operation?.retryOf === "running-copy" &&
        retry.operation?.status === "completed" &&
        retry.sourceAfterRetry?.recovery?.lastSelectedRetryOperationId === retry.operation.id,
      `retry=${retry.operation?.id || "missing"}; status=${retry.operation?.status || "missing"}; sourceSelectedRetry=${retry.sourceAfterRetry?.recovery?.lastSelectedRetryOperationId || "missing"}.`
    );
    check(
      checks,
      "retry-selected-copied-targets",
      retry.copiedTargetStatuses.every(Boolean),
      retry.copiedTargets.map((target, index) => `${path.basename(target)}=${retry.copiedTargetStatuses[index]}`).join(", ")
    );
    check(
      checks,
      "ops-layout-clean",
      layout.issues.length === 0,
      `${layout.issues.length} clipped/squished/out-of-dialog Ops control(s).`
    );
    check(checks, "browser-console-clean", pageErrors.length === 0, `${pageErrors.length} page error(s).`);
    check(
      checks,
      "operation-endpoints-hit",
      apiEvents.some((event) => event.endpoint === "/api/operation/retry-selected" && event.status === 200),
      JSON.stringify(apiEvents)
    );
  } catch (error) {
    check(checks, "smoke-execution", false, error.message);
  } finally {
    await browser?.close().catch(() => {});
    if (server.exitCode === null) {
      server.kill();
    }
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
    appData,
    backendRecovery: backendState ? recoveredSummary(backendState) : [],
    opsDialog,
    details: {
      initial: detailsInitial,
      afterClear: detailsAfterClear,
      afterSelectAll: detailsAfterSelectAll,
      afterRetry: detailsAfterRetry
    },
    opsAfterRetry,
    retry,
    layout,
    apiEvents,
    consoleMessages,
    pageErrors,
    serverOutput: serverOutput.slice(-4000),
    summary,
    checks
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  console.log(`ops recovery UI smoke: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
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
