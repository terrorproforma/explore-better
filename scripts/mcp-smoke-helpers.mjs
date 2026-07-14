import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function waitFor(test, timeoutMs = 20_000, intervalMs = 80) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await test();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms.`);
}

export async function removeTreeEventually(target) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true, maxRetries: 2 });
      return;
    } catch (error) {
      if (!["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(error.code) || attempt === 11) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

export async function createBackendFixture({ access = "read-only", clientType = "generic", allowPermanentDelete = false } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mcp-backend-"));
  const fixture = path.join(temp, "authorized");
  const outside = path.join(temp, "outside");
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  process.env.LOCALAPPDATA = path.join(temp, "LocalAppData");
  process.env.EXPLORE_BETTER_WORKSPACE_ROOT = fixture;
  const backend = await import(`../server.mjs?mcp-smoke=${Date.now()}-${Math.random()}`);
  await backend.configureMcpBridge({ enabled: true });
  const profile = await backend.upsertMcpProfile({ name: "MCP smoke", access, clientType, roots: [fixture], allowPermanentDelete });
  const request = (tool, args = {}, overrides = {}) => backend.invokeMcpAutomation({
    profileId: profile.id,
    sessionId: "mcp-smoke-session",
    clientRoots: [],
    context: { live: false, contextRevision: 1 },
    tool,
    args,
    ...overrides
  });
  return {
    temp,
    fixture,
    outside,
    backend,
    profile,
    request,
    cleanup: async () => {
      await backend.stopServer().catch(() => {});
      await removeTreeEventually(temp);
    }
  };
}

export async function expectCode(task, code) {
  try {
    await task();
  } catch (error) {
    assert(error.code === code, `Expected ${code}, received ${error.code || error.message}.`);
    return error;
  }
  throw new Error(`Expected ${code}, but the request succeeded.`);
}

export async function waitForJob(request, jobId, timeoutMs = 30_000) {
  return waitFor(async () => {
    const result = await request("get_job", { jobId, limit: 500 });
    if (["error", "canceled"].includes(result.data.status)) throw new Error(`Job ${jobId} ended as ${result.data.status}.`);
    return result.data.status === "complete" ? result.data : null;
  }, timeoutMs);
}

export async function waitForOperation(request, operationId, timeoutMs = 30_000) {
  return waitFor(async () => {
    const result = await request("get_operation", { operationId });
    const operation = result.data.operation;
    if (operation.status === "failed") throw new Error(operation.error || `Operation ${operationId} failed.`);
    return ["completed", "canceled"].includes(operation.status) ? operation : null;
  }, timeoutMs);
}

export async function startElectronMcp({ visible = false } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mcp-electron-"));
  const fixture = path.join(temp, "authorized");
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, "hello.txt"), "hello MCP\n");
  const env = {
    ...process.env,
    LOCALAPPDATA: path.join(temp, "LocalAppData"),
    EXPLORE_BETTER_WORKSPACE_ROOT: fixture,
    EXPLORE_BETTER_USER_DATA_DIR: path.join(temp, "Electron"),
    EXPLORE_BETTER_DISABLE_GPU: "1",
    EXPLORE_BETTER_UPDATE_URL: ""
  };
  const previous = { LOCALAPPDATA: process.env.LOCALAPPDATA, EXPLORE_BETTER_WORKSPACE_ROOT: process.env.EXPLORE_BETTER_WORKSPACE_ROOT };
  process.env.LOCALAPPDATA = env.LOCALAPPDATA;
  process.env.EXPLORE_BETTER_WORKSPACE_ROOT = fixture;
  const backend = await import(`../server.mjs?mcp-electron=${Date.now()}-${Math.random()}`);
  await backend.configureMcpBridge({ enabled: true });
  const profile = await backend.upsertMcpProfile({ name: "Electron MCP", access: "read-only", roots: [fixture], clientType: "generic" });
  if (previous.LOCALAPPDATA === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous.LOCALAPPDATA;
  if (previous.EXPLORE_BETTER_WORKSPACE_ROOT === undefined) delete process.env.EXPLORE_BETTER_WORKSPACE_ROOT; else process.env.EXPLORE_BETTER_WORKSPACE_ROOT = previous.EXPLORE_BETTER_WORKSPACE_ROOT;

  const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
  const electron = spawn(electronExe, [root, ...(visible ? [] : ["--ai-host"]), "--no-updates"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: !visible });
  let electronLog = "";
  electron.stdout.on("data", (chunk) => { electronLog += chunk; });
  electron.stderr.on("data", (chunk) => { electronLog += chunk; });
  const manifest = path.join(env.LOCALAPPDATA, "ExploreBetter", "MCP", "bridge-v1.json");
  await waitFor(() => fs.access(manifest).then(() => true, () => false), 25_000);

  const sidecar = spawn(path.join(root, "native", "bin", "ExploreBetterMcp.exe"), ["--profile", profile.id, "--manifest", manifest], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let sidecarError = "";
  sidecar.stderr.on("data", (chunk) => { sidecarError += chunk; });
  const pending = new Map();
  let nextId = 1;
  let closing = false;
  const lines = readline.createInterface({ input: sidecar.stdout });
  sidecar.stdin.on("error", (error) => {
    if (!closing) sidecarError += `${error.message}\n`;
  });
  const writeSidecar = (message) => {
    if (closing || sidecar.exitCode !== null || sidecar.stdin.destroyed || !sidecar.stdin.writable) {
      return false;
    }
    sidecar.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error && !closing) sidecarError += `${error.message}\n`;
    });
    return true;
  };
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "ping" && message.id !== undefined) {
      writeSidecar({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    const record = pending.get(String(message.id));
    if (record) {
      pending.delete(String(message.id));
      record.resolve(message);
    }
  });
  const call = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(String(id));
        reject(new Error(`MCP ${method} timed out. ${sidecarError}`));
      }, 20_000);
      pending.set(String(id), {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      if (!writeSidecar({ jsonrpc: "2.0", id, method, params })) {
        clearTimeout(timer);
        pending.delete(String(id));
        reject(new Error(`MCP ${method} cannot run because the sidecar is closed. ${sidecarError}`));
      }
    });
  };
  const initialized = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Explore Better verifier", version: "1" } });
  assert(!initialized.error, `MCP initialize failed: ${JSON.stringify(initialized.error)}`);
  assert(writeSidecar({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }), "MCP sidecar closed during initialization.");

  async function close() {
    closing = true;
    lines.removeAllListeners("line");
    lines.close();
    for (const record of pending.values()) record.reject(new Error("MCP verifier closed."));
    pending.clear();
    if (!sidecar.stdin.destroyed && sidecar.stdin.writable) sidecar.stdin.end();
    await waitFor(() => sidecar.exitCode !== null || sidecar.killed, 3000).catch(() => {});
    if (sidecar.exitCode === null) sidecar.kill();
    if (electron.exitCode === null) spawnSync("taskkill", ["/PID", String(electron.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    await waitFor(() => electron.exitCode !== null || electron.killed, 5000).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 350));
    await removeTreeEventually(temp);
  }
  return { temp, fixture, env, profile, electron, sidecar, manifest, initialized, call, close, logs: () => ({ electronLog, sidecarError }) };
}
