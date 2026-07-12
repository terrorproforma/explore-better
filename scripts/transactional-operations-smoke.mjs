import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const data = JSON.parse((await response.text()) || "{}");
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function startServer({ port, appData, env = {} }) {
  const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early: ${output.join("")}`);
    try {
      await requestJson(`http://127.0.0.1:${port}`, "/api/roots");
      return { child, output };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Server startup timed out: ${output.join("")}`);
}

async function stopServer(server) {
  const child = server?.child;
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}

async function partialPaths(directory) {
  const names = await fs.readdir(directory);
  return names.filter((name) => name.includes(".explore-better-") && name.endsWith(".partial"));
}

async function main() {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "explore-better-transactions-"));
  const appData = path.join(fixture, "appdata");
  const sourceRoot = path.join(fixture, "source");
  const targetRoot = path.join(fixture, "target");
  await fs.mkdir(path.join(sourceRoot, "project"), { recursive: true });
  await fs.mkdir(path.join(targetRoot, "project"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "project", "new.txt"), "new bytes\n");
  await fs.writeFile(path.join(targetRoot, "project", "original.txt"), "original bytes\n");
  const checks = [];
  let server;
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    server = await startServer({ port, appData, env: { EB_TEST_FAIL_STAGING_RENAME: "1" } });
    const transferBody = {
      paths: [path.join(sourceRoot, "project")],
      targetDir: targetRoot,
      mode: "copy",
      conflictMode: "overwrite"
    };
    const preview = await requestJson(baseUrl, "/api/transfer/preview", { method: "POST", body: JSON.stringify(transferBody) });
    await requestJson(baseUrl, "/api/transfer", {
      method: "POST",
      body: JSON.stringify({ ...transferBody, expectedPlanDigest: preview.planDigest })
    }).catch(() => null);
    const transferState = await requestJson(baseUrl, "/api/state");
    const failedTransfer = transferState.operations?.find((operation) => operation.type === "transfer");
    assert(failedTransfer?.status === "failed", "Injected staging rename should fail the transfer operation.");
    assert((await fs.readFile(path.join(targetRoot, "project", "original.txt"), "utf8")) === "original bytes\n", "Overwrite failure must restore original bytes.");
    assert(!(await fs.stat(path.join(targetRoot, "project", "new.txt")).then(() => true).catch(() => false)), "Failed overwrite must not expose staged bytes.");
    assert((await partialPaths(targetRoot)).length === 0, "Failed overwrite must remove sibling staging paths.");
    checks.push({ name: "directory overwrite rollback restores original byte-for-byte", pass: true });
  } finally {
    await stopServer(server);
    server = null;
  }

  const moveSource = path.join(sourceRoot, "cross-volume.txt");
  const moveTarget = path.join(targetRoot, "cross-volume.txt");
  await fs.writeFile(moveSource, "move once\n");
  try {
    server = await startServer({
      port,
      appData,
      env: { EB_TEST_FORCE_CROSS_VOLUME_MOVE: "1", EB_TEST_FAIL_SOURCE_REMOVAL: "1" }
    });
    await requestJson(baseUrl, "/api/move", {
      method: "POST",
      body: JSON.stringify({ paths: [moveSource], targetDir: targetRoot })
    }).catch(() => null);
    const moveState = await requestJson(baseUrl, "/api/state");
    const failedMove = moveState.operations?.find((operation) => operation.type === "move");
    assert(failedMove?.status === "failed", "Injected source removal should fail the move operation.");
    assert(await fs.stat(moveSource).then(() => true).catch(() => false), "Pending move source must remain after failed removal.");
    assert((await fs.readFile(moveTarget, "utf8")) === "move once\n", "Committed move destination must remain intact.");
    assert(failedMove?.result?.recovery?.sourceRemovalPending === true, "Recovery must record source-removal-pending.");
    assert(failedMove?.result?.recovery?.retry?.type === "move-resume", "Recovery must retry removal instead of copying again.");
    const failedOperationId = failedMove.id;
    await stopServer(server);
    server = await startServer({ port, appData, env: { EB_TEST_FORCE_CROSS_VOLUME_MOVE: "1" } });
    const resumed = await requestJson(baseUrl, "/api/operation/retry-remaining", {
      method: "POST",
      body: JSON.stringify({ operationId: failedOperationId })
    });
    assert(resumed.operation?.status === "completed", "Source-removal resume should complete.");
    assert(!(await fs.stat(moveSource).then(() => true).catch(() => false)), "Resume must remove only the pending source.");
    assert((await fs.readFile(moveTarget, "utf8")) === "move once\n", "Resume must not recopy or alter the committed destination.");
    assert((await partialPaths(targetRoot)).length === 0, "Cross-volume move must leave no staging path.");
    checks.push({ name: "cross-volume retry removes source without recopying destination", pass: true });
  } finally {
    await stopServer(server);
  }

  const report = { generatedAt: new Date().toISOString(), fixture, checks, summary: { passed: checks.length, failed: 0 } };
  const artifactDir = path.join(root, "artifacts");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, "transactional-operations-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const check of checks) console.log(`PASS ${check.name}`);
  console.log(`Transactional operations: ${checks.length} pass, 0 fail`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
