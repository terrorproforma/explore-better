import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `state-corruption-recovery-${stamp}`);
const latestJsonPath = path.join(artifactsDir, "state-corruption-recovery-latest.json");
const latestMdPath = path.join(artifactsDir, "state-corruption-recovery-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_STATE_CORRUPTION_KEEP_FIXTURE === "1";
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

async function waitForServer(baseUrl, child, outputRef) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${outputRef()}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}: ${outputRef()}`);
}

function startServer(port, appData) {
  const output = { text: "" };
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => {
    output.text += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output.text += chunk.toString();
  });
  return { child, output };
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

function aliasNames(state) {
  return (state.aliases || []).map((alias) => alias.name).sort();
}

function hasAlias(state, name) {
  return aliasNames(state).includes(name);
}

async function tempStateFiles(stateDir) {
  try {
    const names = await fs.readdir(stateDir);
    return names
      .filter((name) => /^state\.json(?:\.bak)?\..+\.tmp$/i.test(name))
      .map((name) => path.join(stateDir, name));
  } catch {
    return [];
  }
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function seedState(aliasName, aliasPath, settings = {}) {
  const now = new Date().toISOString();
  return {
    updatedAt: now,
    settings: {
      density: "compact",
      startupMode: "last",
      openGesture: "double",
      ...settings
    },
    aliases: [
      {
        id: `alias-${aliasName}`,
        name: aliasName,
        path: aliasPath,
        description: `${aliasName} marker`,
        updatedAt: now
      }
    ],
    operations: [
      {
        id: `op-${aliasName}`,
        type: "copy",
        label: `Completed seed ${aliasName}`,
        status: "completed",
        createdAt: now,
        startedAt: now,
        finishedAt: now,
        progress: { unit: "items", total: 1, completed: 1, phase: "Completed", updatedAt: now },
        result: { copied: 1, items: [] },
        error: null
      }
    ]
  };
}

async function backupRestoreScenario(checks, port) {
  const scenarioRoot = path.join(runRoot, "backup-restore");
  const fixtureRoot = path.join(scenarioRoot, "fixture");
  const appData = path.join(scenarioRoot, "appdata");
  const stateDir = path.join(appData, "ExploreBetter");
  const statePath = path.join(stateDir, "state.json");
  const backupPath = path.join(stateDir, "state.json.bak");
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(fixtureRoot, "marker.txt"), "state backup marker\n", "utf8");
  await fs.writeFile(statePath, `${JSON.stringify(seedState("backupseed", fixtureRoot), null, 2)}\n`, "utf8");

  const first = startServer(port, appData);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl, first.child, () => first.output.text);
    const initial = await requestJson(baseUrl, "/api/state");
    check(checks, "seed-state-loaded", initial.settings?.density === "compact" && hasAlias(initial, "backupseed"), "Seed state loaded with compact density and backupseed alias.");

    const saved = await requestJson(baseUrl, "/api/state", {
      method: "POST",
      body: JSON.stringify({
        settings: { density: "spacious", startupMode: "homeDownloads" },
        aliases: [{ name: "currentstate", path: fixtureRoot, description: "current marker" }]
      })
    });
    check(checks, "current-state-saved", saved.settings?.density === "spacious" && hasAlias(saved, "currentstate"), "Current state saved after initial seed.");
  } finally {
    await stopServer(first.child);
  }

  const backup = await readJsonFile(backupPath);
  const current = await readJsonFile(statePath);
  check(checks, "backup-created", backup.settings?.density === "compact" && hasAlias(backup, "backupseed"), "Backup contains the last valid pre-save state.");
  check(checks, "current-state-before-corruption-readable", current.settings?.density === "spacious" && hasAlias(current, "currentstate"), "Current state is readable before corruption.");

  await fs.writeFile(statePath, "{\n  \"settings\": { \"density\": \"spacious\" },\n  \"aliases\": [\n", "utf8");

  const second = startServer(port, appData);
  try {
    await waitForServer(baseUrl, second.child, () => second.output.text);
    const restored = await requestJson(baseUrl, "/api/state");
    check(checks, "corrupt-state-restored-from-backup", restored.settings?.density === "compact" && hasAlias(restored, "backupseed") && !hasAlias(restored, "currentstate"), "Invalid state.json restored from state.json.bak.");

    const restoredPersisted = await readJsonFile(statePath);
    check(checks, "restored-state-persisted-readable", restoredPersisted.settings?.density === "compact" && hasAlias(restoredPersisted, "backupseed"), "Restored backup was copied back to state.json as readable JSON.");

    const afterRestore = await requestJson(baseUrl, "/api/state", {
      method: "POST",
      body: JSON.stringify({
        settings: { density: "comfortable", startupMode: "workspaceHome" },
        aliases: [{ name: "afterrestore", path: fixtureRoot, description: "after restore marker" }]
      })
    });
    check(checks, "post-restore-write-succeeds", afterRestore.settings?.density === "comfortable" && hasAlias(afterRestore, "afterrestore"), "State writes continue after backup restore.");
    check(checks, "temp-files-clean-after-backup-restore", (await tempStateFiles(stateDir)).length === 0, "No state temp files remain after backup restore and write.");

    return {
      appData,
      statePath,
      backupPath,
      restoredDensity: restored.settings?.density,
      afterRestoreDensity: afterRestore.settings?.density,
      serverWarnings: second.output.text
        .split(/\r?\n/)
        .filter((line) => /state|backup|read failure|unreadable|Could not/i.test(line))
        .slice(-20)
    };
  } finally {
    await stopServer(second.child);
  }
}

async function noBackupFallbackScenario(checks, port) {
  const scenarioRoot = path.join(runRoot, "no-backup-fallback");
  const fixtureRoot = path.join(scenarioRoot, "fixture");
  const appData = path.join(scenarioRoot, "appdata");
  const stateDir = path.join(appData, "ExploreBetter");
  const statePath = path.join(stateDir, "state.json");
  const backupPath = path.join(stateDir, "state.json.bak");
  await fs.mkdir(fixtureRoot, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(statePath, "{ broken json without backup", "utf8");
  await fs.rm(backupPath, { force: true }).catch(() => {});

  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port, appData);
  try {
    await waitForServer(baseUrl, server.child, () => server.output.text);
    const fallback = await requestJson(baseUrl, "/api/state");
    check(checks, "corrupt-state-without-backup-falls-back", fallback.settings?.density === "comfortable" && Array.isArray(fallback.operations), "Corrupt state without backup returns a normalized default state.");

    const firstSave = await requestJson(baseUrl, "/api/state", {
      method: "POST",
      body: JSON.stringify({
        settings: { density: "compact", startupMode: "documentsDownloads" },
        aliases: [{ name: "fallbackone", path: fixtureRoot, description: "first fallback marker" }]
      })
    });
    check(checks, "fallback-write-succeeds", firstSave.settings?.density === "compact" && hasAlias(firstSave, "fallbackone"), "First save after fallback writes valid state.");
    const firstPersisted = await readJsonFile(statePath);
    check(checks, "fallback-write-persisted-readable", firstPersisted.settings?.density === "compact" && hasAlias(firstPersisted, "fallbackone"), "First fallback save replaced corrupt state.json with readable JSON.");

    let backupHealthyAfterFallback = true;
    if (await pathExists(backupPath)) {
      try {
        await readJsonFile(backupPath);
      } catch {
        backupHealthyAfterFallback = false;
      }
    }
    check(checks, "unreadable-current-not-backed-up", backupHealthyAfterFallback, "Unreadable current state was not preserved as a corrupt backup.");

    const secondSave = await requestJson(baseUrl, "/api/state", {
      method: "POST",
      body: JSON.stringify({
        settings: { density: "spacious", startupMode: "workspaceHome" },
        aliases: [{ name: "fallbacktwo", path: fixtureRoot, description: "second fallback marker" }]
      })
    });
    check(checks, "fallback-second-write-succeeds", secondSave.settings?.density === "spacious" && hasAlias(secondSave, "fallbacktwo"), "Second save after fallback also succeeds.");
    const healedBackup = await readJsonFile(backupPath);
    check(checks, "backup-heals-after-valid-save", healedBackup.settings?.density === "compact" && hasAlias(healedBackup, "fallbackone"), "A later valid save refreshes state.json.bak from the last readable state.");
    check(checks, "temp-files-clean-after-fallback", (await tempStateFiles(stateDir)).length === 0, "No state temp files remain after fallback writes.");

    return {
      appData,
      statePath,
      backupPath,
      fallbackDensity: fallback.settings?.density,
      firstSaveDensity: firstSave.settings?.density,
      secondSaveDensity: secondSave.settings?.density,
      serverWarnings: server.output.text
        .split(/\r?\n/)
        .filter((line) => /state|backup|read failure|unreadable|Could not/i.test(line))
        .slice(-20)
    };
  } finally {
    await stopServer(server.child);
  }
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Explore Better State Corruption Recovery

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Scenarios

- Backup restore: corrupt \`state.json\` restored from a valid \`state.json.bak\`, then saved again.
- No-backup fallback: corrupt \`state.json\` without a backup returned defaults, replaced the corrupt file on save, avoided preserving a corrupt backup, then healed the backup after a later valid save.
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const portBase = Number(optionValue("--port", process.env.PORT || 58_000 + Math.floor(Math.random() * 2000)));
  const report = {
    generatedAt: new Date().toISOString(),
    runRoot,
    scenarios: {},
    checks
  };

  try {
    report.scenarios.backupRestore = await backupRestoreScenario(checks, portBase);
    report.scenarios.noBackupFallback = await noBackupFallbackScenario(checks, portBase + 1);
  } catch (error) {
    if (!checks.some((item) => item.id === "smoke-execution" && item.status === "fail")) {
      checks.push({ id: "smoke-execution", status: "fail", detail: error.message });
    }
    report.error = error.stack || error.message;
  } finally {
    report.summary = {
      pass: checks.filter((item) => item.status === "pass").length,
      warn: checks.filter((item) => item.status === "warn").length,
      fail: checks.filter((item) => item.status === "fail").length
    };
    report.status = report.summary.fail ? "fail" : "pass";
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
    console.log(`state corruption recovery: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (report.summary.fail) {
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
