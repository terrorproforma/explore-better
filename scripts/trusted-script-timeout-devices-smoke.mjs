// Regression coverage for trusted-script timeouts, drive inventory caching and the EB_TEST_* hook gate.
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const data = JSON.parse((await response.text()) || "{}");
  return { ok: response.ok, status: response.status, data };
}

async function requestJson(baseUrl, route, options = {}) {
  const { ok, status, data } = await request(baseUrl, route, options);
  if (!ok) throw new Error(data.error || `HTTP ${status}`);
  return data;
}

async function startServer({ port, appData, env = {}, testHooks = false }) {
  const baseEnv = { ...process.env };
  delete baseEnv.EXPLORE_BETTER_TEST_HOOKS;
  const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root,
    env: {
      ...baseEnv,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      APPDATA: appData,
      ...(testHooks ? { EXPLORE_BETTER_TEST_HOOKS: "1" } : {}),
      ...env
    },
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
      await requestJson(`http://127.0.0.1:${port}`, "/api/health/report?probe=0");
      return { child, output };
    } catch {
      await delay(100);
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
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3000)]);
}

async function exists(itemPath) {
  return fs.stat(itemPath).then(() => true, () => false);
}

async function tickFiles(dir) {
  return (await fs.readdir(dir)).filter((name) => name.startsWith("tick-")).length;
}

async function runScript(baseUrl, dir, code, timeoutMs) {
  return request(baseUrl, "/api/script", {
    method: "POST",
    body: JSON.stringify({ code, name: "Timeout regression", activePath: dir, contextPath: dir, timeoutMs })
  });
}

async function checkScriptTimeout(baseUrl, fixture, checks) {
  const loopDir = path.join(fixture, "script-loop");
  await fs.mkdir(loopDir, { recursive: true });
  // Swallows every api error, so only the api itself can stop the writes after the timeout.
  const loop = await runScript(
    baseUrl,
    loopDir,
    `for (let i = 0; i < 40; i += 1) {
  try { await api.sleep(100); } catch {}
  try { await api.writeText(path.join(api.cwd(), "tick-" + i + ".txt"), String(i)); } catch {}
}
return "finished";`,
    1000
  );
  assert(!loop.ok && /timed out/i.test(loop.data.error || ""), `Looping script should time out: ${JSON.stringify(loop.data)}`);
  const atTimeout = await tickFiles(loopDir);
  await delay(3000);
  const later = await tickFiles(loopDir);
  assert(later === atTimeout, `Script kept writing after its timeout (${atTimeout} -> ${later} files).`);
  assert(later < 40, "Timed-out script should not have completed every write.");
  checks.push(`timed-out script stops mutating (${later} writes before timeout, none after)`);

  const lateDir = path.join(fixture, "script-late");
  await fs.mkdir(lateDir, { recursive: true });
  const late = await runScript(
    baseUrl,
    lateDir,
    `await api.sleep(2500);
await api.writeText(path.join(api.cwd(), "late.txt"), "late");`,
    1000
  );
  assert(!late.ok && /timed out/i.test(late.data.error || ""), "Sleeping script should time out.");
  await delay(2500);
  assert(!(await exists(path.join(lateDir, "late.txt"))), "api.sleep must throw once the script timed out.");
  checks.push("api.sleep aborts at the timeout so later writes never run");

  const state = await requestJson(baseUrl, "/api/state");
  const failed = (state.operations || []).filter((operation) => operation.type === "script");
  assert(failed.length >= 2 && failed.every((operation) => operation.status === "failed"), "Timed-out scripts should be recorded as failed, not canceled.");

  const quick = await runScript(baseUrl, lateDir, `console.log("hi"); await api.sleep(50); return 7;`, 5000);
  assert(quick.ok && quick.data.result === 7 && quick.data.logs?.[0] === "hi", "A normal script must still complete.");
  checks.push("normal scripts still complete and report results");
}

async function checkDriveInventoryCache(baseUrl, checks) {
  if (process.platform !== "win32") {
    checks.push("drive inventory cache (skipped: not Windows)");
    return;
  }
  const loads = async () => {
    const health = await requestJson(baseUrl, "/api/health/report?probe=0");
    return health.components.find((item) => item.id === "cache")?.metrics?.driveInventoryLoads;
  };
  const before = await loads();
  assert(before === 0, `No drive inventory should load at startup (saw ${before}).`);
  const [first, second] = await Promise.all([
    requestJson(baseUrl, "/api/windows/devices?refresh=0&includeNetwork=0"),
    requestJson(baseUrl, "/api/windows/devices?refresh=0&includeNetwork=0")
  ]);
  await requestJson(baseUrl, "/api/windows/devices?refresh=0&includeNetwork=0");
  await requestJson(baseUrl, "/api/windows/devices?refresh=1&includeNetwork=0");
  const after = await loads();
  assert(after === 1, `Concurrent and repeated device requests within the TTL should spawn one inventory (saw ${after}).`);
  assert(first.groups?.drives?.length === second.groups?.drives?.length, "Cached inventory should report the same drives.");
  checks.push("drive inventory is coalesced and cached (4 device requests -> 1 PowerShell load)");

  const roots = await requestJson(baseUrl, "/api/roots");
  assert(Array.isArray(roots.drives) && roots.drives.length > 0, "Roots should still list drives.");
  checks.push(`roots list ${roots.drives.length} drive(s) via parallel probes`);
}

async function checkMoveUnderHooks(baseUrl, fixture, name) {
  const source = path.join(fixture, `${name}.txt`);
  const targetDir = path.join(fixture, `${name}-target`);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(source, "move me\n");
  await request(baseUrl, "/api/move", { method: "POST", body: JSON.stringify({ paths: [source], targetDir }) });
  const state = await requestJson(baseUrl, "/api/state");
  const operation = (state.operations || []).find((item) => item.type === "move" && JSON.stringify(item).includes(`${name}.txt`));
  return { operation, sourceExists: await exists(source) };
}

async function main() {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "explore-better-trusted-timeout-"));
  const appData = path.join(fixture, "appdata");
  const checks = [];
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const failureEnv = { EB_TEST_FORCE_CROSS_VOLUME_MOVE: "1", EB_TEST_FAIL_SOURCE_REMOVAL: "1" };
  let server;
  try {
    // Failure-injection variables are present, but the opt-in flag is not: production behaviour.
    server = await startServer({ port, appData, env: failureEnv });
    await checkDriveInventoryCache(baseUrl, checks);
    const ungated = await checkMoveUnderHooks(baseUrl, fixture, "ungated");
    assert(ungated.operation?.status === "completed" && !ungated.sourceExists, "EB_TEST_* hooks must be ignored without EXPLORE_BETTER_TEST_HOOKS=1.");
    checks.push("EB_TEST_* failure injection is ignored without the test-hooks flag");
    await checkScriptTimeout(baseUrl, fixture, checks);
    await stopServer(server);
    server = await startServer({ port, appData: path.join(fixture, "appdata-hooks"), env: failureEnv, testHooks: true });
    const gated = await checkMoveUnderHooks(baseUrl, fixture, "gated");
    assert(gated.operation?.status === "failed" && gated.sourceExists, "EB_TEST_* hooks should still apply with EXPLORE_BETTER_TEST_HOOKS=1.");
    checks.push("EB_TEST_* failure injection still works with the test-hooks flag");
  } catch (error) {
    if (server?.output?.length) console.error(`Server output:\n${server.output.join("")}`);
    throw error;
  } finally {
    await stopServer(server);
    await fs.rm(fixture, { recursive: true, force: true }).catch(() => {});
  }
  for (const check of checks) console.log(`PASS ${check}`);
  console.log(`Trusted script timeout/devices/test-hooks smoke: ${checks.length} pass, 0 fail`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
