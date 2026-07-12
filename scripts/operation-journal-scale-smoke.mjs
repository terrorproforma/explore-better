import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `operation-journal-scale-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
const latestJsonPath = path.join(artifactsDir, "operation-journal-scale-latest.json");
const latestMdPath = path.join(artifactsDir, "operation-journal-scale-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function numberOption(name, envName, fallback) {
  const value = Number(optionValue(name, process.env[envName] || fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_OPERATION_JOURNAL_SCALE_KEEP_FIXTURE === "1";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
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

function completedOperation(id, createdAt) {
  return {
    id,
    type: "copy",
    label: `Historical copy ${id}`,
    status: "completed",
    createdAt,
    startedAt: createdAt,
    finishedAt: createdAt,
    result: { copied: 1, items: [{ from: `seed-${id}.txt`, to: `dest-${id}.txt` }] },
    error: null,
    undo: { type: "trash-created", items: [] },
    progress: {
      unit: "items",
      total: 1,
      completed: 1,
      phase: "Completed",
      updatedAt: createdAt
    },
    retry: {
      type: "copy",
      body: {
        paths: [path.join(fixtureRoot, "seed-source.txt")],
        targetDir: path.join(fixtureRoot, "seed-target")
      },
      createdAt
    },
    retryOf: null
  };
}

function interruptedOperation(id, status, createdAt, sourcePath, targetDir, completed = 0) {
  return {
    id,
    type: "copy",
    label: `Interrupted copy ${id}`,
    status,
    createdAt,
    startedAt: status === "queued" ? null : createdAt,
    finishedAt: null,
    result: null,
    error: null,
    undo: null,
    progress: {
      unit: "items",
      total: 2,
      completed,
      phase: status === "paused" ? "Paused" : status === "running" ? "Copying" : "Queued",
      updatedAt: createdAt
    },
    retry: {
      type: "copy",
      body: {
        paths: [sourcePath, path.join(fixtureRoot, "missing-later.txt")],
        targetDir
      },
      createdAt
    },
    retryOf: null
  };
}

async function seedState(seedCount) {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "seed-source.txt"), "seed source\n", "utf8");
  await fs.mkdir(path.join(fixtureRoot, "seed-target"), { recursive: true });
  await fs.mkdir(path.join(fixtureRoot, "create-target"), { recursive: true });
  const sourcePath = path.join(fixtureRoot, "seed-source.txt");
  const targetDir = path.join(fixtureRoot, "seed-target");
  const now = Date.now();
  const operations = [];
  for (let index = 0; index < seedCount; index += 1) {
    const id = `seed-op-${String(index).padStart(3, "0")}`;
    const createdAt = new Date(now - index * 1000).toISOString();
    if (index === 1) {
      operations.push(interruptedOperation(id, "running", createdAt, sourcePath, targetDir, 1));
    } else if (index === 2) {
      operations.push(interruptedOperation(id, "queued", createdAt, sourcePath, targetDir, 0));
    } else if (index === 3) {
      operations.push(interruptedOperation(id, "paused", createdAt, sourcePath, targetDir, 1));
    } else {
      operations.push(completedOperation(id, createdAt));
    }
  }
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        operations
      },
      null,
      2
    ),
    "utf8"
  );
  return { operations, sourcePath, targetDir, createTarget: path.join(fixtureRoot, "create-target") };
}

function byId(state, id) {
  return (state.operations || []).find((operation) => operation.id === id) || null;
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

function markdownReport(report) {
  const checkRows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Operation Journal Scale Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${checkRows}

Seeded operations: ${report.seeded.count}
Bounded operations after startup: ${report.afterStartup.count}
Bounded operations after new operation: ${report.afterCreate.count}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const seedCount = numberOption("--seed-count", "EB_OPERATION_JOURNAL_SCALE_SEED_COUNT", 150);
  const port = Number(optionValue("--port", process.env.PORT || 57000 + Math.floor(Math.random() * 5000)));
  const fixture = await seedState(seedCount);
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

  try {
    await waitForServer(baseUrl, server);
    const startupState = await requestJson(baseUrl, "/api/state");
    const persistedStartup = JSON.parse(await fs.readFile(statePath, "utf8"));
    const created = await requestJson(baseUrl, "/api/file/create", {
      method: "POST",
      body: JSON.stringify({
        path: fixture.createTarget,
        name: "after-saturation.txt",
        content: "created after saturated operation journal\n"
      })
    });
    const afterCreateState = await requestJson(baseUrl, "/api/state");
    const persistedAfterCreate = JSON.parse(await fs.readFile(statePath, "utf8"));
    const interruptedIds = ["seed-op-001", "seed-op-002", "seed-op-003"];
    const recovered = interruptedIds.map((id) => byId(startupState, id));
    const checks = [];

    check(checks, "seed-count-large", seedCount > 100, `seeded ${seedCount} operations.`);
    check(checks, "startup-trimmed-to-bound", startupState.operations?.length === 100, `count=${startupState.operations?.length || 0}.`);
    check(
      checks,
      "startup-persisted-trimmed",
      persistedStartup.operations?.length === 100,
      `persisted count=${persistedStartup.operations?.length || 0}.`
    );
    check(checks, "newest-preserved", byId(startupState, "seed-op-000") !== null, "seed-op-000 is still present.");
    check(checks, "oldest-truncated", byId(startupState, "seed-op-149") === null, "seed-op-149 is absent after trim.");
    check(
      checks,
      "interrupted-recovered",
      recovered.every((operation) => operation?.status === "failed" && operation?.result?.recovery?.interrupted === true),
      recovered.map((operation) => `${operation?.id || "missing"}=${operation?.status || "missing"}`).join(", ")
    );
    check(
      checks,
      "recovery-retry-metadata",
      recovered.every((operation) => operation?.result?.recovery?.canRetryRemaining === true && operation?.result?.recovery?.retry?.body?.targetDir),
      "recovered interrupted rows expose retry metadata."
    );
    check(
      checks,
      "fresh-operation-completed",
      created.operation?.status === "completed" && created.operation?.type === "create-file",
      `type=${created.operation?.type || "missing"} status=${created.operation?.status || "missing"}.`
    );
    check(
      checks,
      "fresh-operation-first",
      afterCreateState.operations?.[0]?.id === created.operation?.id,
      `first=${afterCreateState.operations?.[0]?.id || "missing"} created=${created.operation?.id || "missing"}.`
    );
    check(
      checks,
      "after-create-still-bounded",
      afterCreateState.operations?.length === 100 && persistedAfterCreate.operations?.length === 100,
      `api=${afterCreateState.operations?.length || 0}; persisted=${persistedAfterCreate.operations?.length || 0}.`
    );
    check(checks, "trim-window-advanced", byId(afterCreateState, "seed-op-099") === null, "seed-op-099 dropped when fresh operation was added.");
    check(checks, "recent-history-still-present", byId(afterCreateState, "seed-op-098") !== null, "seed-op-098 remains as the oldest retained seed row.");
    check(
      checks,
      "api-persisted-match",
      JSON.stringify(afterCreateState.operations) === JSON.stringify(persistedAfterCreate.operations),
      "API state and state.json operations match after saturated write."
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
      fixtureRoot,
      appData,
      seeded: {
        count: seedCount,
        firstId: fixture.operations[0]?.id || null,
        lastId: fixture.operations[fixture.operations.length - 1]?.id || null
      },
      afterStartup: {
        count: startupState.operations?.length || 0,
        firstId: startupState.operations?.[0]?.id || null,
        lastId: startupState.operations?.at?.(-1)?.id || startupState.operations?.[startupState.operations.length - 1]?.id || null,
        recovered: recovered.map((operation) => ({
          id: operation?.id || null,
          status: operation?.status || null,
          interrupted: operation?.result?.recovery?.interrupted === true,
          remainingCount: operation?.result?.recovery?.remainingCount ?? null
        }))
      },
      afterCreate: {
        count: afterCreateState.operations?.length || 0,
        firstId: afterCreateState.operations?.[0]?.id || null,
        lastId: afterCreateState.operations?.at?.(-1)?.id || afterCreateState.operations?.[afterCreateState.operations.length - 1]?.id || null,
        createdOperationId: created.operation?.id || null,
        createdPath: created.path || created.operation?.result?.path || null
      },
      checks
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`seeded operations: ${seedCount}`);
    console.log(`startup count: ${report.afterStartup.count}`);
    console.log(`after create count: ${report.afterCreate.count}`);
    console.log(`created operation: ${report.afterCreate.createdOperationId}`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail) {
      process.exitCode = 1;
    }
  } finally {
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
