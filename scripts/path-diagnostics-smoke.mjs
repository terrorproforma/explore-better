import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `path-diagnostics-${stamp}`);
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
  return process.argv.includes("--keep-fixture") || process.env.EB_PATH_DIAGNOSTICS_KEEP_FIXTURE === "1";
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

async function prepareFixture() {
  await fs.mkdir(path.join(fixture, "nested"), { recursive: true });
  await fs.writeFile(path.join(fixture, "alpha.txt"), "alpha\n", "utf8");
  await fs.writeFile(path.join(fixture, "beta.log"), "beta\n", "utf8");
  await fs.writeFile(path.join(fixture, "nested", "inside.txt"), "inside\n", "utf8");
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 57000 + Math.floor(Math.random() * 5000)));
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

  try {
    await waitForServer(baseUrl, server);
    const directory = await requestJson(
      baseUrl,
      `/api/path/diagnostics?${new URLSearchParams({ path: fixture, timeoutMs: "2500", sampleLimit: "5" })}`
    );
    assert(directory.check === true, "Directory diagnostics should run checks by default.");
    assert(directory.exists === true && directory.reachable === true, "Fixture directory should be reachable.");
    assert(directory.targetKind === "directory", "Fixture should be reported as a directory.");
    assert(directory.readable === true, "Fixture directory should be readable.");
    assert(directory.entryCount >= 3, "Fixture directory should report sampled entries.");
    assert(directory.sample.some((item) => item.name === "alpha.txt"), "Directory sample should include fixture file.");
    assert(Number.isFinite(Number(directory.timings?.totalMs)), "Directory diagnostics should include total timing.");
    assert(Array.isArray(directory.recommendations) && directory.recommendations.length, "Directory diagnostics should include recommendations.");

    const filePath = path.join(fixture, "alpha.txt");
    const file = await requestJson(
      baseUrl,
      `/api/path/diagnostics?${new URLSearchParams({ path: filePath, timeoutMs: "2500", watch: "false" })}`
    );
    assert(file.targetKind === "file", "File diagnostics should report files.");
    assert(file.selectedPath === file.resolved, "File diagnostics should identify the selected file path.");
    assert(file.isFile === true && file.isDirectory === false, "File diagnostics should set file/directory booleans.");

    const missing = await requestJson(
      baseUrl,
      `/api/path/diagnostics?${new URLSearchParams({ path: path.join(fixture, "missing"), timeoutMs: "500", watch: "false" })}`
    );
    assert(missing.exists === false && missing.reachable === false, "Missing path should not be reachable.");
    assert(missing.errors.some((item) => item.stage === "stat"), "Missing path should include a stat error.");

    const unc = await requestJson(
      baseUrl,
      `/api/path/diagnostics?${new URLSearchParams({ path: "\\\\offline-smoke\\share\\folder", check: "false" })}`
    );
    assert(unc.check === false, "UNC parse smoke should run in parse-only mode.");
    assert(unc.errors.length === 0, "UNC parse-only mode should not touch the filesystem.");
    if (process.platform === "win32") {
      assert(unc.kind === "unc", `UNC parse should classify as unc on Windows, got ${unc.kind}.`);
      assert(unc.server === "offline-smoke" && unc.share === "share", "UNC parse should expose server and share.");
      assert(unc.isNetwork === true, "UNC parse should mark network paths.");
    }

    const output = {
      generatedAt: new Date().toISOString(),
      fixture,
      directory,
      file,
      missing,
      unc
    };
    const outputPath = path.join(artifactsDir, "path-diagnostics-latest.json");
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
    console.log(`wrote ${outputPath}`);
    console.log("path diagnostics smoke passed");
  } finally {
    if (server.exitCode === null) {
      server.kill();
    }
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true });
    } else {
      console.log(`kept fixture at ${runRoot}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  if (serverOutput) {
    console.error(serverOutput);
  }
  process.exitCode = 1;
});
