import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `windows-recycle-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_WINDOWS_RECYCLE_KEEP_FIXTURE === "1";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function pathKey(itemPath) {
  return String(itemPath || "").replace(/[\\/]+$/, "").toLowerCase();
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
  while (Date.now() - started < 10000) {
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

async function waitForFile(filePath, shouldExist) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
    if (exists === shouldExist) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 160));
  }
  return false;
}

async function waitForRecycleItem(baseUrl, originalPath, name) {
  const originalKey = pathKey(originalPath);
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const data = await requestJson(baseUrl, "/api/windows-recycle-bin?limit=2000");
    assert(data.available !== false, data.reason || "Windows Recycle Bin should be available.");
    const item = (data.items || []).find((candidate) => {
      if (pathKey(candidate.originalPath) === originalKey) {
        return true;
      }
      return candidate.name === name && pathKey(path.join(candidate.originalLocation || "", candidate.name)) === originalKey;
    });
    if (item) {
      return { data, item };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Could not find recycled fixture ${originalPath}`);
}

async function main() {
  if (process.platform !== "win32") {
    console.log("Windows Recycle Bin smoke skipped on non-Windows platform.");
    return;
  }

  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(fixture, { recursive: true });
  const fileName = `explore-better-recycle-smoke-${stamp}.txt`;
  const filePath = path.join(fixture, fileName);
  await fs.writeFile(filePath, "windows recycle smoke\n", "utf8");

  const port = Number(optionValue("--port", process.env.PORT || 57000 + Math.floor(Math.random() * 3000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  let recyclePath = "";
  try {
    await waitForServer(baseUrl, server);
    const before = await requestJson(baseUrl, "/api/windows-recycle-bin?limit=50");
    assert(before.available !== false, before.reason || "Windows Recycle Bin should list before recycle.");

    const recycleResult = await requestJson(baseUrl, "/api/recycle", {
      method: "POST",
      body: JSON.stringify({ paths: [filePath] })
    });
    assert(recycleResult.recycled?.includes(filePath), "Recycle operation should report the fixture path.");
    assert(await waitForFile(filePath, false), "Fixture should leave its original location after recycle.");

    const { data: listed, item } = await waitForRecycleItem(baseUrl, filePath, fileName);
    recyclePath = item.path;
    assert(item.name === fileName, "Recycle list should preserve the original file name.");
    assert(item.path, "Recycle list should include the shell recycle path.");
    assert(item.dateDeletedText, "Recycle list should include Date Deleted text.");

    const dryRun = await requestJson(baseUrl, "/api/windows-recycle-bin/restore", {
      method: "POST",
      body: JSON.stringify({ paths: [recyclePath], dryRun: true })
    });
    assert(dryRun.dryRun === true, "Restore dry-run should report dryRun=true.");
    assert(dryRun.matched?.length === 1, "Restore dry-run should match the recycled fixture.");
    assert(await waitForFile(filePath, false), "Dry-run restore must not move the file.");

    const restored = await requestJson(baseUrl, "/api/windows-recycle-bin/restore", {
      method: "POST",
      body: JSON.stringify({ paths: [recyclePath] })
    });
    assert(restored.restored?.length === 1, "Restore should report one restored item.");
    assert(restored.operation?.type === "windows-recycle-restore", "Restore should be recorded in Ops.");
    assert(await waitForFile(filePath, true), "Fixture should return to its original location after restore.");

    const outputPath = path.join(artifactsDir, "windows-recycle-latest.json");
    await fs.writeFile(
      outputPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          before: { total: before.total, count: before.count, truncated: before.truncated },
          listed: { total: listed.total, count: listed.count, truncated: listed.truncated },
          fixture: { filePath, recyclePath, name: item.name, dateDeletedText: item.dateDeletedText },
          dryRun: { matched: dryRun.matched?.length || 0 },
          operation: {
            id: restored.operation?.id,
            type: restored.operation?.type,
            status: restored.operation?.status
          }
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`recycle item: ${item.name}`);
    console.log(`recycle path: ${recyclePath}`);
    console.log(`restored operation: ${restored.operation?.id || "none"}`);
    console.log(`wrote ${outputPath}`);
  } finally {
    server.kill();
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (serverOutput) {
    console.error(serverOutput);
  }
  process.exitCode = 1;
});
