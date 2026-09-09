import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpAutomationService } from "../mcp/automation-service.mjs";
import { createMcpBridgeService } from "../mcp-bridge-service.mjs";
import { createMcpClientConfigurator } from "../mcp-client-config.mjs";

async function fixture(t) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const temp = await fs.realpath(await fs.mkdtemp(path.join(tempRoot, "eb-mcp-lifecycle-")));
  const folder = path.join(temp, "files");
  const appDataRoot = path.join(temp, "state");
  const services = [];
  await fs.mkdir(folder);
  const sample = path.join(folder, "sample.txt");
  await fs.writeFile(sample, "An ordinary text fixture.\n");
  t.after(async () => {
    for (const service of services) await service.listAudit();
    const resolved = path.resolve(temp);
    assert(resolved.startsWith(tempRoot + path.sep) && path.basename(resolved).startsWith("eb-mcp-lifecycle-"));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  });
  return {
    temp, folder, sample,
    async service(overrides = {}) {
      const service = await createMcpAutomationService({
        appDataRoot, internalRoots: [appDataRoot], resolveUserPath: (value) => path.resolve(value), ...overrides
      });
      services.push(service);
      return service;
    }
  };
}

async function profileFor(service, folder) {
  await service.configure({ enabled: true });
  return service.upsertProfile({ name: "Lifecycle fixture", roots: [folder] });
}

test("temporary configuration read failures preserve existing profiles and remain retryable", async (t) => {
  const f = await fixture(t);
  const original = await f.service();
  const profile = await profileFor(original, f.folder);
  const before = await fs.readFile(original.paths.configFile);
  for (const code of ["EBUSY", "EPERM"]) {
    const service = await f.service();
    const readFile = fs.readFile;
    fs.readFile = async (file, ...args) => {
      if (file === original.paths.configFile) throw Object.assign(new Error("Fixture configuration is temporarily unavailable."), { code });
      return readFile(file, ...args);
    };
    try {
      await assert.rejects(service.configure({ auditRetentionDays: 14 }), { code });
    } finally { fs.readFile = readFile; }
    assert((await fs.readFile(original.paths.configFile)).equals(before));
    assert.equal((await service.getConfiguration()).profiles[0].id, profile.id);
    assert(!(await fs.readdir(original.paths.automationRoot)).some(name => name.includes(".corrupt-")));
  }
});

test("failed configuration replacement preserves the current file and removes staging bytes", async (t) => {
  const f = await fixture(t);
  const service = await f.service();
  const profile = await profileFor(service, f.folder);
  const before = await fs.readFile(service.paths.configFile);
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    if (destination === service.paths.configFile) throw Object.assign(new Error("Fixture configuration replacement is busy."), { code: "EBUSY" });
    return rename(source, destination);
  };
  try {
    await assert.rejects(service.configure({ enabled: false }), { code: "EBUSY" });
  } finally { fs.rename = rename; }
  assert((await fs.readFile(service.paths.configFile)).equals(before));
  assert(!(await fs.readdir(service.paths.automationRoot)).some(name => name.endsWith(".tmp")));
  assert.equal((await service.getConfiguration()).enabled, true);
  await service.configure({ auditRetentionDays: 14 });
  assert.equal((await service.getConfiguration()).profiles[0].id, profile.id);
});

test("malformed configuration recovery preserves the original bytes before resetting", async (t) => {
  const f = await fixture(t);
  const service = await f.service();
  await fs.mkdir(service.paths.automationRoot, { recursive: true });
  const malformed = "{ an incomplete configuration";
  await fs.writeFile(service.paths.configFile, malformed);
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    if (source === service.paths.configFile) throw Object.assign(new Error("Fixture backup is busy."), { code: "EBUSY" });
    return rename(source, destination);
  };
  try {
    await assert.rejects(service.configure({ enabled: true }), { code: "EBUSY" });
  } finally { fs.rename = rename; }
  assert.equal(await fs.readFile(service.paths.configFile, "utf8"), malformed);
  assert.equal((await service.getConfiguration()).enabled, false);
  const backup = (await fs.readdir(service.paths.automationRoot)).find(name => name.includes(".corrupt-"));
  assert.equal(await fs.readFile(path.join(service.paths.automationRoot, backup), "utf8"), malformed);
});

async function subscriptionBridge(f) {
  const createServer = net.createServer;
  let accept;
  net.createServer = (handler) => {
    accept = handler;
    const server = new EventEmitter();
    server.listening = false;
    server.listen = () => { server.listening = true; queueMicrotask(() => server.emit("listening")); };
    server.close = (callback) => { server.listening = false; callback(); };
    return server;
  };
  const bridge = createMcpBridgeService({
    manifestPath: path.join(f.temp, "bridge.json"), appVersion: "fixture", getContext: () => ({}),
    backend: { setMcpUiDispatcher: async () => {} }
  });
  const close = async () => { try { await bridge.stop(); } finally { net.createServer = createServer; } };
  try {
    await bridge.start();
    const manifest = JSON.parse(await fs.readFile(bridge.manifestPath, "utf8"));
    return { bridge, close, connect() {
      const responses = [], socket = new EventEmitter();
      let sequence = 0;
      Object.assign(socket, { destroyed: false, writable: true, writableLength: 0,
        setNoDelay() {}, setEncoding() {}, write(frame) { responses.push(JSON.parse(frame)); return true; },
        destroy() { this.destroyed = true; this.writable = false; this.emit("close"); } });
      accept(socket);
      socket.emit("data", `${JSON.stringify({ version: 2, op: "hello", id: "hello", nonce: manifest.nonce })}\n`);
      return { responses, async request(op, uri) {
        const id = `subscription-${sequence++}`;
        socket.emit("data", `${JSON.stringify({ op, uri, id })}\n`);
        await new Promise(resolve => setImmediate(resolve));
        return responses.find(response => response.id === id);
      } };
    } };
  } catch (error) { await close(); throw error; }
}

test("resource subscriptions are bounded per connection and unsubscribing frees capacity", async (t) => {
  const f = await fixture(t), h = await subscriptionBridge(f);
  try {
    const client = h.connect(), other = h.connect();
    for (let index = 0; index < 256; index++) {
      assert.equal((await client.request("subscribe", `explore-better://jobs/fixture-${index}`)).type, "result");
    }
    assert.equal((await client.request("subscribe", "explore-better://jobs/fixture-0")).type, "result", "duplicates do not consume another slot");
    assert.equal((await client.request("subscribe", "explore-better://jobs/next")).error?.code, "LIMIT_EXCEEDED");
    assert.equal((await other.request("subscribe", "explore-better://jobs/next")).type, "result", "limits apply independently to each connection");
    assert.equal((await client.request("unsubscribe", "explore-better://jobs/fixture-0")).type, "result");
    assert.equal((await client.request("subscribe", "explore-better://jobs/next")).type, "result");
    assert.equal(h.bridge.publishResourceUpdate("explore-better://jobs/fixture-0"), 0);
    assert.equal(h.bridge.publishResourceUpdate("explore-better://jobs/next"), 2);
  } finally { await h.close(); }
});

test("overlong subscription URIs are rejected without creating a shortened alias", async (t) => {
  const f = await fixture(t), h = await subscriptionBridge(f);
  try {
    const client = h.connect();
    const uri = `explore-better://jobs/${"x".repeat(2050)}`;
    assert.equal((await client.request("subscribe", uri)).error?.code, "LIMIT_EXCEEDED");
    assert.equal(h.bridge.publishResourceUpdate(uri.slice(0, 2048)), 0);
    assert.equal((await client.request("subscribe", "é".repeat(1025))).error?.code, "LIMIT_EXCEEDED", "the length limit uses UTF-8 bytes");
    assert.equal((await client.request("subscribe", {})).error?.code, "INVALID_REQUEST");
  } finally { await h.close(); }
});

test("completed jobs retain their permission binding and results after host restart", async (t) => {
  const f = await fixture(t);
  const report = { items: [{ path: f.sample, checksum: "fixture" }], counts: { files: 1 } };
  const service = await f.service({ checksumReport: async () => report });
  const profile = await profileFor(service, f.folder);
  const request = { profileId: profile.id, sessionId: "fixture" };
  const started = await service.invoke({ ...request, tool: "compute_checksums", args: { paths: [f.sample] } });
  const jobId = started.data.job.id;
  let current;
  for (let attempt = 0; attempt < 100; attempt++) {
    current = await service.invoke({ ...request, tool: "get_job", args: { jobId } });
    if (current.data.status === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(current.data.status, "complete");
  const restarted = await f.service();
  const recovered = await restarted.invoke({ ...request, tool: "get_job", args: { jobId } });
  assert.deepEqual(recovered.data.result, report);
  await restarted.upsertProfile({ ...profile, tools: profile.tools.filter((name) => name !== "compute_checksums") });
  await assert.rejects(restarted.invoke({ ...request, tool: "get_job", args: { jobId } }), { code: "PLAN_CHANGED" });
});

test("recursive path inspection propagates an already canceled request", async (t) => {
  const f = await fixture(t);
  const service = await f.service({
    propertiesReport: async (_body, { signal } = {}) => {
      signal?.throwIfAborted();
      return { items: [] };
    }
  });
  const profile = await profileFor(service, f.folder);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.invoke({
    profileId: profile.id, sessionId: "fixture", tool: "inspect_paths",
    args: { paths: [f.folder], recursive: true }, signal: controller.signal
  }), { name: "AbortError" });
});

test("UI waits enforce profile revocation before returning their final context", async (t) => {
  const f = await fixture(t);
  const service = await f.service();
  const profile = await profileFor(service, f.folder);
  service.setUiDispatcher(async () => {
    await service.revokeProfile(profile.id);
    return { matched: true, context: {} };
  });
  await assert.rejects(service.invoke({
    profileId: profile.id, sessionId: "fixture", tool: "wait_for_ui", args: { timeoutMs: 100 }
  }), { code: "UNKNOWN_PROFILE" });
});

test("configured junction roots follow their current target on the next request", async (t) => {
  const f = await fixture(t);
  const first = path.join(f.folder, "first");
  const second = path.join(f.folder, "second");
  const link = path.join(f.temp, "workspace-link");
  await fs.mkdir(first);
  await fs.mkdir(second);
  await fs.symlink(first, link, process.platform === "win32" ? "junction" : "dir");
  const service = await f.service({ listDirectory: async (itemPath) => ({ path: itemPath, entries: [], window: { total: 0 } }) });
  const profile = await profileFor(service, link);
  const request = { profileId: profile.id, sessionId: "fixture", tool: "list_directory", args: { path: link } };
  assert.equal((await service.invoke(request)).data.path, await fs.realpath(first));
  await fs.unlink(link);
  await fs.symlink(second, link, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await service.invoke(request)).data.path, await fs.realpath(second), "The configured logical root remains valid after its target changes.");
});

test("locked sidecar upgrades keep only the pending binary, without abandoned staging files", async (t) => {
  const f = await fixture(t);
  const runtime = {
    packaged: false, appPath: path.join(f.temp, "app"), executablePath: path.join(f.temp, "app.exe"),
    homeDir: path.join(f.temp, "home"), localAppData: path.join(f.temp, "local"), roamingAppData: path.join(f.temp, "roaming")
  };
  const configurator = createMcpClientConfigurator(runtime);
  await fs.mkdir(path.dirname(configurator.sourceSidecar), { recursive: true });
  await fs.writeFile(configurator.sourceSidecar, "Previous fixture sidecar bytes.");
  await configurator.deploy();
  const next = Buffer.from("Updated fixture sidecar bytes.");
  await fs.writeFile(configurator.sourceSidecar, next);
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    if (destination === configurator.stableSidecar) throw Object.assign(new Error("Fixture executable is in use."), { code: "EBUSY" });
    return rename(source, destination);
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) assert.equal((await configurator.deploy()).pending, true);
  } finally {
    fs.rename = rename;
  }
  const entries = await fs.readdir(path.dirname(configurator.stableSidecar));
  assert.deepEqual(entries.sort(), ["ExploreBetterMcp.exe", "ExploreBetterMcp.pending.exe"].sort());
  assert((await fs.readFile(path.join(path.dirname(configurator.stableSidecar), "ExploreBetterMcp.pending.exe"))).equals(next));
});

test("stopping while dispatcher setup is pending cannot revive the bridge", async (t) => {
  const f = await fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let created = 0;
  const createServer = net.createServer;
  // A local fake avoids leaving a real listener behind when testing broken lifecycle code.
  net.createServer = () => {
    created++;
    const server = new EventEmitter();
    server.listening = false;
    server.listen = () => { server.listening = true; queueMicrotask(() => server.emit("listening")); };
    server.close = (callback) => { server.listening = false; callback(); };
    return server;
  };
  const bridge = createMcpBridgeService({
    manifestPath: path.join(f.temp, "bridge.json"), appVersion: "fixture",
    backend: { setMcpUiDispatcher: () => gate }, getContext: () => ({})
  });
  try {
    const starting = bridge.start();
    const rejected = assert.rejects(starting, /disposed|stopped/i);
    const stopped = bridge.stop();
    await stopped;
    release();
    await rejected;
    assert.equal(created, 0, "Shutdown must prevent deferred listener creation.");
    assert.equal(await fs.readFile(bridge.manifestPath).then(() => true, () => false), false);
  } finally {
    release();
    await bridge.stop();
    net.createServer = createServer;
  }
});

test("concurrent startup shares one listener and one dispatcher setup", async (t) => {
  const f = await fixture(t);
  let setups = 0;
  const bridge = createMcpBridgeService({
    manifestPath: path.join(f.temp, "bridge.json"), appVersion: "fixture",
    backend: { setMcpUiDispatcher: async () => { setups++; } }, getContext: () => ({})
  });
  try {
    const states = await Promise.all([bridge.start(), bridge.start(), bridge.start()]);
    assert.equal(setups, 1);
    assert(states.every((state) => state.running));
    await bridge.stop();
    assert.equal(bridge.status().running, false);
  } finally {
    await bridge.stop();
  }
});

test("failed manifest publication closes its listener, removes staging files, and permits retry", async (t) => {
  const f = await fixture(t);
  const bridge = createMcpBridgeService({
    manifestPath: path.join(f.temp, "bridge.json"), appVersion: "fixture",
    backend: { setMcpUiDispatcher: async () => {} }, getContext: () => ({})
  });
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    if (destination === bridge.manifestPath) throw Object.assign(new Error("Fixture manifest is temporarily busy."), { code: "EBUSY" });
    return rename(source, destination);
  };
  try {
    await assert.rejects(bridge.start(), { code: "EBUSY" });
    assert.equal(bridge.status().running, false);
    assert(!(await fs.readdir(f.temp)).some((name) => name.endsWith(".tmp")));
    fs.rename = rename;
    assert.equal((await bridge.start()).running, true);
  } finally {
    fs.rename = rename;
    await bridge.stop();
  }
});

test("shutdown closes clients that have not completed their handshake", async (t) => {
  const f = await fixture(t);
  const bridge = createMcpBridgeService({
    manifestPath: path.join(f.temp, "bridge.json"), appVersion: "fixture",
    backend: { setMcpUiDispatcher: async () => {} }, getContext: () => ({})
  });
  let socket;
  try {
    await bridge.start();
    socket = net.createConnection(bridge.pipeName);
    socket.on("error", () => {});
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const before = Date.now();
    await bridge.stop();
    assert(Date.now() - before < 1000, "Shutdown must not wait for the five-second handshake timeout.");
  } finally {
    socket?.destroy();
    await bridge.stop();
  }
});

test("the frame limit applies separately when a read completes one frame and begins the next", async (t) => {
  const f = await fixture(t);
  const createServer = net.createServer;
  let accept;
  net.createServer = (handler) => {
    accept = handler;
    const server = new EventEmitter();
    server.listening = false;
    server.listen = () => { server.listening = true; queueMicrotask(() => server.emit("listening")); };
    server.close = (callback) => { server.listening = false; callback(); };
    return server;
  };
  const responses = [];
  const socket = new EventEmitter();
  Object.assign(socket, {
    destroyed: false, writable: true, writableLength: 0,
    setNoDelay() {}, setEncoding() {},
    write(frame) { responses.push(JSON.parse(frame)); return true; },
    destroy() { this.destroyed = true; this.writable = false; this.emit("close"); }
  });
  const bridge = createMcpBridgeService({
    manifestPath: path.join(f.temp, "bridge.json"), appVersion: "fixture", getContext: () => ({}),
    backend: { setMcpUiDispatcher: async () => {}, invokeMcpAutomation: async () => ({ accepted: true }) }
  });
  try {
    await bridge.start();
    const manifest = JSON.parse(await fs.readFile(bridge.manifestPath, "utf8"));
    accept(socket);
    socket.emit("data", `${JSON.stringify({ version: 2, op: "hello", id: "hello", nonce: manifest.nonce })}\n`);
    const empty = `${JSON.stringify({ op: "invoke", id: "large", tool: "fixture", args: { text: "" } })}\n`;
    const large = `${JSON.stringify({ op: "invoke", id: "large", tool: "fixture", args: { text: "x".repeat(4 * 1024 * 1024 - 16 - Buffer.byteLength(empty)) } })}\n`;
    const split = large.length - 32768;
    socket.emit("data", large.slice(0, split));
    socket.emit("data", large.slice(split) + `${JSON.stringify({ op: "ping", id: "next" })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(socket.destroyed, false, "Two individually valid frames must not be rejected as one oversized frame.");
    assert(responses.some((response) => response.id === "large" && response.result.accepted));
    assert(responses.some((response) => response.id === "next" && response.result.pong));
    socket.emit("data", " ".repeat(4 * 1024 * 1024) + "\n");
    assert.equal(socket.destroyed, true, "An individually oversized frame still fails before whitespace trimming.");
  } finally {
    await bridge.stop();
    net.createServer = createServer;
  }
});
