import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `operation-pause-resume-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const sourceDir = path.join(fixtureRoot, "source");
const targetDir = path.join(fixtureRoot, "target");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "operation-pause-resume-latest.json");
const latestMdPath = path.join(artifactsDir, "operation-pause-resume-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_OPERATION_PAUSE_KEEP_FIXTURE === "1";
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
  if (!ok) {
    throw new Error(`${id}: ${detail}`);
  }
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
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function waitForServer(baseUrl, child) {
  const started = performance.now();
  while (performance.now() - started < 10000) {
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

function operationById(state, id) {
  return (state.operations || []).find((operation) => operation.id === id) || null;
}

async function waitForOperation(baseUrl, predicate, timeoutMs = 15000) {
  const started = performance.now();
  let lastState = null;
  while (performance.now() - started < timeoutMs) {
    const state = await requestJson(baseUrl, "/api/state");
    lastState = state;
    const operation = (state.operations || []).find(predicate);
    if (operation) {
      return { state, operation };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for operation. Last operations: ${JSON.stringify(lastState?.operations?.slice?.(0, 5) || [])}`);
}

async function prepareFixture(count) {
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
  const paths = [];
  for (let index = 0; index < count; index += 1) {
    const itemPath = path.join(sourceDir, `pause-copy-${String(index).padStart(2, "0")}.txt`);
    await fs.writeFile(itemPath, `pause resume source ${index}\n`, "utf8");
    paths.push(itemPath);
  }
  return { paths };
}

async function listTargetNames() {
  try {
    return (await fs.readdir(targetDir)).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Operation Pause Resume Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

Paused operation: ${report.operation.operationId}
Completed before pause: ${report.pause.completedBeforePause}
Targets while paused: ${report.pause.targetNamesWhilePaused.length}
Final copied files: ${report.resume.targetNamesAfterResume.length}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fileCount = Number(optionValue("--count", process.env.EB_OPERATION_PAUSE_COUNT || "5"));
  const fixture = await prepareFixture(Number.isFinite(fileCount) && fileCount >= 3 ? Math.round(fileCount) : 5);
  const checks = [];
  const port = Number(optionValue("--port", process.env.PORT || 49000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      EB_TEST_OPERATION_DELAY_MS: process.env.EB_TEST_OPERATION_DELAY_MS || "1800",
      EB_TEST_OPERATION_DELAY_AFTER_ITEMS: process.env.EB_TEST_OPERATION_DELAY_AFTER_ITEMS || "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  let delayedOperation = null;
  let pauseResponse = null;
  let stateWhilePaused = null;
  let resumeResponse = null;
  let copyResponse = null;
  let finalState = null;
  let targetNamesAtPause = [];
  let targetNamesWhilePaused = [];
  let targetNamesAfterResume = [];
  let copyPromise = null;
  let completedBeforePause = 0;
  try {
    await waitForServer(baseUrl, server);
    copyPromise = requestJson(baseUrl, "/api/copy", {
      method: "POST",
      body: JSON.stringify({
        paths: fixture.paths,
        targetDir
      })
    });
    copyPromise.catch(() => {});

    delayedOperation = (
      await waitForOperation(
        baseUrl,
        (operation) => operation.type === "copy" && operation.status === "running" && operation.progress?.phase === "Test delay"
      )
    ).operation;
    completedBeforePause = Number(delayedOperation.progress?.completed || 0);
    targetNamesAtPause = await listTargetNames();
    check(
      checks,
      "copy-entered-pause-window",
      completedBeforePause >= 1 && completedBeforePause < fixture.paths.length,
      `completed=${completedBeforePause}.`
    );
    check(checks, "pause-window-target-count", targetNamesAtPause.length === completedBeforePause, `targets=${targetNamesAtPause.join(",")}.`);

    pauseResponse = await requestJson(baseUrl, "/api/operation/pause", {
      method: "POST",
      body: JSON.stringify({ operationId: delayedOperation.id })
    });
    check(checks, "pause-request-accepted", pauseResponse.operation?.status === "paused", `status=${pauseResponse.operation?.status || "missing"}.`);
    check(checks, "pause-recorded-timestamp", Boolean(pauseResponse.operation?.pausedAt), `pausedAt=${pauseResponse.operation?.pausedAt || "missing"}.`);

    await new Promise((resolve) => setTimeout(resolve, 2600));
    stateWhilePaused = await requestJson(baseUrl, "/api/state");
    const pausedOperation = operationById(stateWhilePaused, delayedOperation.id);
    targetNamesWhilePaused = await listTargetNames();
    check(checks, "operation-still-paused", pausedOperation?.status === "paused", `status=${pausedOperation?.status || "missing"}.`);
    check(
      checks,
      "pause-held-target-count",
      targetNamesWhilePaused.length === completedBeforePause,
      `before=${targetNamesAtPause.length}; while=${targetNamesWhilePaused.length}.`
    );
    check(
      checks,
      "pause-preserved-recovery-window",
      pausedOperation?.result?.recovery?.remainingCount === fixture.paths.length - completedBeforePause,
      `remaining=${pausedOperation?.result?.recovery?.remainingCount || 0}.`
    );

    resumeResponse = await requestJson(baseUrl, "/api/operation/resume", {
      method: "POST",
      body: JSON.stringify({ operationId: delayedOperation.id })
    });
    check(checks, "resume-request-accepted", resumeResponse.operation?.status === "running", `status=${resumeResponse.operation?.status || "missing"}.`);
    check(checks, "resume-recorded-timestamp", Boolean(resumeResponse.operation?.resumedAt), `resumedAt=${resumeResponse.operation?.resumedAt || "missing"}.`);

    copyResponse = await copyPromise;
    finalState = await requestJson(baseUrl, "/api/state");
    const finalOperation = operationById(finalState, delayedOperation.id) || copyResponse.operation;
    targetNamesAfterResume = await listTargetNames();
    const expectedNames = fixture.paths.map((itemPath) => path.basename(itemPath)).sort((a, b) => a.localeCompare(b));
    check(checks, "copy-completed-after-resume", finalOperation?.status === "completed", `status=${finalOperation?.status || "missing"}.`);
    check(checks, "final-kept-paused-at", Boolean(finalOperation?.pausedAt), `pausedAt=${finalOperation?.pausedAt || "missing"}.`);
    check(checks, "final-kept-resumed-at", Boolean(finalOperation?.resumedAt), `resumedAt=${finalOperation?.resumedAt || "missing"}.`);
    check(checks, "final-target-count", targetNamesAfterResume.length === expectedNames.length, `targets=${targetNamesAfterResume.join(",")}.`);
    check(
      checks,
      "final-target-set-exact",
      JSON.stringify(targetNamesAfterResume) === JSON.stringify(expectedNames),
      `expected=${expectedNames.join(",")}; actual=${targetNamesAfterResume.join(",")}.`
    );
    for (const sourcePath of fixture.paths) {
      check(checks, `target-exists-${path.basename(sourcePath)}`, await pathExists(path.join(targetDir, path.basename(sourcePath))), path.basename(sourcePath));
    }
    const persisted = JSON.parse(await fs.readFile(path.join(appData, "ExploreBetter", "state.json"), "utf8"));
    check(
      checks,
      "api-persisted-match",
      JSON.stringify(finalState.operations) === JSON.stringify(persisted.operations),
      "API and persisted operations match after pause/resume."
    );

    const summary = {
      pass: checks.filter((item) => item.status === "pass").length,
      warn: checks.filter((item) => item.status === "warn").length,
      fail: checks.filter((item) => item.status === "fail").length
    };
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      summary,
      runRoot,
      fixtureRoot,
      sourceDir,
      targetDir,
      fixture: {
        count: fixture.paths.length,
        paths: fixture.paths
      },
      operation: {
        operationId: delayedOperation.id,
        finalStatus: finalOperation?.status || null,
        pausedAt: finalOperation?.pausedAt || null,
        resumedAt: finalOperation?.resumedAt || null
      },
      pause: {
        completedBeforePause,
        targetNamesAtPause,
        targetNamesWhilePaused,
        remainingWhilePaused: operationById(stateWhilePaused, delayedOperation.id)?.result?.recovery?.remainingCount || 0
      },
      resume: {
        targetNamesAfterResume,
        copied: copyResponse?.copied || copyResponse?.operation?.result?.copied || []
      },
      checks,
      serverOutput: serverOutput.slice(-4000)
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`operation pause/resume: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (copyPromise) {
      await Promise.race([
        copyPromise.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 250))
      ]);
    }
    await stopServer(server);
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(serverOutput);
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
