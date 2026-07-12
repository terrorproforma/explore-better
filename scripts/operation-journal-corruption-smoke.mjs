import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `operation-journal-corruption-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const latestJsonPath = path.join(artifactsDir, "operation-journal-corruption-latest.json");
const latestMdPath = path.join(artifactsDir, "operation-journal-corruption-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function edgePath() {
  return (
    optionValue("--browser", process.env.EB_OPERATION_JOURNAL_CORRUPTION_BROWSER || "") ||
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  );
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_OPERATION_JOURNAL_CORRUPTION_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
  if (!ok) {
    throw new Error(`${id}: ${detail}`);
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
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${serverOutput}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}: ${serverOutput}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function seedState() {
  const copySource = path.join(fixtureRoot, "copy-source");
  const copyTarget = path.join(fixtureRoot, "copy-target");
  const createTarget = path.join(fixtureRoot, "create-target");
  await Promise.all([copySource, copyTarget, createTarget].map((dir) => fs.mkdir(dir, { recursive: true })));
  const first = path.join(copySource, "first.txt");
  const second = path.join(copySource, "second.txt");
  await fs.writeFile(first, "first\n", "utf8");
  await fs.writeFile(second, "second\n", "utf8");

  const now = new Date().toISOString();
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: now,
        operations: [
          "raw string row",
          null,
          42,
          {
            id: "bad-status",
            type: "",
            label: "x".repeat(600),
            status: "teleporting",
            createdAt: "not a date",
            startedAt: "also bad",
            finishedAt: "still bad",
            result: "r".repeat(30_000),
            error: null,
            undo: "not undo metadata",
            progress: {
              unit: "items",
              total: 999999999,
              completed: -4,
              phase: "p".repeat(300),
              current: "c".repeat(500),
              currentPath: "z".repeat(5000),
              updatedAt: "bad"
            },
            retry: {
              type: "copy",
              body: {
                paths: [],
                targetDir: ""
              }
            },
            retryOf: 123
          },
          {
            id: "running-copy",
            type: "copy",
            label: "Interrupted copy",
            status: "running",
            createdAt: now,
            startedAt: now,
            finishedAt: null,
            result: null,
            error: null,
            undo: null,
            progress: {
              unit: "items",
              total: 2,
              completed: 1,
              phase: "Copying",
              current: "second.txt",
              currentPath: second,
              updatedAt: now
            },
            retry: {
              type: "copy",
              body: {
                paths: [first, second],
                targetDir: copyTarget
              },
              createdAt: now
            },
            retryOf: null
          },
          {
            id: "valid-complete",
            type: "copy",
            label: "Valid complete",
            status: "completed",
            createdAt: now,
            startedAt: now,
            finishedAt: now,
            result: { copied: 1, items: [{ from: first, to: path.join(copyTarget, "first.txt") }] },
            error: null,
            undo: { type: "trash-created", items: [] },
            progress: {
              unit: "items",
              total: 1,
              completed: 1,
              phase: "Completed",
              updatedAt: now
            },
            retry: {
              type: "copy",
              body: {
                paths: [first],
                targetDir: copyTarget
              },
              createdAt: now
            },
            retryOf: null
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );
  return { copySource, copyTarget, createTarget, first, second };
}

function byId(state, id) {
  return (state.operations || []).find((operation) => operation.id === id) || null;
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Operation Journal Corruption Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

Rows after startup: ${report.afterStartup.count}
Rows after create: ${report.afterCreate.count}
Browser rows: ${report.browser.rows.length}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixture = await seedState();
  const checks = [];
  const port = Number(optionValue("--port", process.env.PORT || 57500 + Math.floor(Math.random() * 5000)));
  const baseUrl = `http://127.0.0.1:${port}`;
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

  const browser = await chromium.launch({ executablePath: edgePath(), headless: true });
  try {
    await waitForServer(baseUrl, server);
    const startup = await requestJson(baseUrl, "/api/state");
    const startupOperations = startup.operations || [];
    const badStatus = byId(startup, "bad-status");
    const runningCopy = byId(startup, "running-copy");
    const validComplete = byId(startup, "valid-complete");

    check(checks, "raw-rows-dropped", startupOperations.every((operation) => operation && typeof operation === "object" && !Array.isArray(operation)), "Non-object operation rows were removed.");
    check(checks, "valid-row-preserved", validComplete?.status === "completed" && validComplete?.undo?.type === "trash-created", "Valid completed operation and undo metadata survived sanitization.");
    check(checks, "malformed-row-normalized", badStatus?.status === "failed" && /malformed operation journal/i.test(badStatus?.error || ""), "Malformed status row was normalized to a visible failed operation.");
    check(checks, "malformed-fields-bounded", badStatus?.label?.length <= 240 && badStatus?.progress?.phase?.length <= 80 && badStatus?.progress?.currentPath?.length <= 2000, "Oversized operation label/progress fields were bounded.");
    check(checks, "invalid-retry-dropped", badStatus?.retry === null && badStatus?.undo === null, "Invalid retry and undo payloads were dropped.");
    check(checks, "interrupted-row-recovered", runningCopy?.status === "failed" && runningCopy?.result?.recovery?.interrupted === true && runningCopy?.result?.recovery?.remainingCount === 1, "Interrupted running operation was converted to recoverable failed state.");

    const pageErrors = [];
    const consoleErrors = [];
    const page = await browser.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) {
        consoleErrors.push(message.text());
      }
    });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(fixture.copySource)}&right=${encodeURIComponent(fixture.copyTarget)}`, {
      waitUntil: "domcontentloaded"
    });
    await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 10_000 });
    const opsButton = page.locator('[data-global-action="ops"]');
    await opsButton.scrollIntoViewIfNeeded();
    await opsButton.click();
    await page.waitForSelector("#ops-dialog[open]", { timeout: 5000 });
    const browserSnapshot = await page.evaluate(() => ({
      rows: [...document.querySelectorAll("#operation-list .operation-row")].map((row) => ({
        text: row.textContent.replace(/\s+/g, " ").trim(),
        status: row.querySelector(".operation-status")?.textContent?.trim() || "",
        hasRetryRemaining: Boolean(row.querySelector("[data-retry-remaining-operation]")),
        hasDetails: Boolean(row.querySelector("[data-operation-details]"))
      })),
      open: Boolean(document.querySelector("#ops-dialog[open]"))
    }));
    check(checks, "ops-dialog-rendered", browserSnapshot.open && browserSnapshot.rows.length >= 3, "Ops dialog rendered sanitized and recovered rows.");
    check(checks, "ops-dialog-recovery-actions", browserSnapshot.rows.some((row) => /Interrupted copy/.test(row.text) && row.status === "failed" && row.hasRetryRemaining && row.hasDetails), "Recovered operation exposes retry/detail actions in the browser UI.");
    check(checks, "ops-dialog-no-errors", pageErrors.length === 0 && consoleErrors.length === 0, "Ops dialog rendered without browser errors.");

    const created = await requestJson(baseUrl, "/api/file/create", {
      method: "POST",
      body: JSON.stringify({
        path: fixture.createTarget,
        name: "journal-still-writes.txt",
        content: "journal survived corruption\n",
        conflictMode: "fail"
      })
    });
    const afterCreate = await requestJson(baseUrl, "/api/state");
    const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
    check(checks, "new-operation-recorded", created.operation?.status === "completed" && afterCreate.operations?.[0]?.id === created.operation.id, "A new operation recorded after journal sanitization.");
    check(checks, "persisted-journal-clean", (persisted.operations || []).every((operation) => operation && typeof operation === "object" && operation.id && operation.status), "Persisted operation journal contains only structured rows after recovery write.");

    const summary = {
      pass: checks.filter((item) => item.status === "pass").length,
      warn: checks.filter((item) => item.status === "warn").length,
      fail: checks.filter((item) => item.status === "fail").length
    };
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixture,
      checks,
      summary,
      afterStartup: {
        count: startupOperations.length,
        ids: startupOperations.map((operation) => operation.id),
        badStatus,
        runningCopy
      },
      afterCreate: {
        count: afterCreate.operations?.length || 0,
        firstId: afterCreate.operations?.[0]?.id || null,
        createdOperationId: created.operation?.id || null
      },
      browser: {
        rows: browserSnapshot.rows,
        pageErrors,
        consoleErrors
      }
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`operation journal corruption: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail > 0) {
      process.exitCode = 1;
    }
  } finally {
    await browser.close().catch(() => {});
    await stopServer(server);
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
