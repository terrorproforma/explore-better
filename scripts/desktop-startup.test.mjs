import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import http from "node:http";

const main = await readFile(process.env.EB_DESKTOP_MAIN_SOURCE || new URL("../electron-main.mjs", import.meta.url), "utf8");
const section = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)));
const gate = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(overrides = {}) {
  const events = [];
  const context = vm.createContext({
    desktopClosing: false, desktopServerStartPromise: null, backendRecoveryPromise: null,
    embeddedServer: null, embeddedServerModule: null, serverProcess: null,
    process: { platform: "linux", defaultApp: true },
    ensureDesktopPort: async () => { events.push("port"); },
    serverIsReady: async () => false,
    loadServerModule: async () => ({ startServer: async () => { events.push("start"); return {}; }, stopServer: async () => { events.push("native-stop"); } }),
    waitForServer: async () => true,
    rememberBackendEvent: () => {},
    stopBackendMonitor: () => {},
    stopChildBackendProcess: async () => {},
    closeEmbeddedServer: async () => { events.push("http-close"); },
    spawn: () => { throw new Error("Unexpected fallback child"); },
    console: { log() {}, warn() {}, error() {} },
    ...overrides
  });
  vm.runInContext(section("async function ensureServer(", "async function recoverBackend(").replaceAll('await import("./server.mjs")', "await loadServerModule()") +
    section("async function recoverBackend(", "function startBackendMonitor(") +
    section("async function stopServer(", "async function exitSmoke("), context);
  return { context, events, ensure: () => context.ensureServer(), stop: () => context.stopServer() };
}

test("desktop shutdown rejects new startup and recovery before acquiring resources", async () => {
  const h = harness({ desktopClosing: true });
  await assert.rejects(h.ensure(), /closing/);
  await assert.rejects(h.context.recoverBackend(), /closing/);
  assert.deepEqual(h.events, []);
});

test("concurrent desktop startup is shared and shutdown drains pending port allocation", async () => {
  const port = gate(); let allocations = 0;
  const h = harness({ ensureDesktopPort: () => { allocations++; return port.promise; } });
  const first = h.ensure(), second = h.ensure();
  const rejected = Promise.all([assert.rejects(first, /closing/), assert.rejects(second, /closing/)]);
  assert.equal(allocations, 1);
  h.context.desktopClosing = true;
  let stopped = false;
  const shutdown = h.stop().then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false);
  assert.deepEqual(h.events, []);
  port.resolve();
  await rejected;
  await shutdown;
  assert.deepEqual(h.events, ["http-close"]);
});

test("a health probe finishing after quit cannot start a backend", async () => {
  const health = gate();
  const h = harness({ serverIsReady: () => health.promise });
  const startup = h.ensure();
  const rejected = assert.rejects(startup, /closing/);
  await tick();
  h.context.desktopClosing = true;
  health.resolve(false);
  await rejected;
  assert.deepEqual(h.events, ["port"]);
});

test("failed embedded startup during quit cannot launch a fallback and cleanup waits for it", async () => {
  const start = gate();
  let nativeStopped = false;
  const h = harness({ loadServerModule: async () => ({ startServer: () => start.promise, stopServer: async () => { nativeStopped = true; } }) });
  const startup = h.ensure();
  const rejected = assert.rejects(startup, /closing/);
  await tick();
  h.context.desktopClosing = true;
  const shutdown = h.stop();
  await tick();
  assert.equal(nativeStopped, false);
  start.reject(new Error("Startup interrupted"));
  await rejected;
  await shutdown;
  assert.equal(nativeStopped, true);
});

test("a ready backend finishing during quit does not resume window startup", async () => {
  const ready = gate();
  const h = harness({ waitForServer: () => ready.promise });
  const startup = h.ensure();
  const rejected = assert.rejects(startup, /closing/);
  await tick();
  h.context.desktopClosing = true;
  ready.resolve(true);
  await rejected;
  await h.stop();
  assert.deepEqual(h.events, ["port", "start", "http-close", "native-stop"]);
});

function childHarness() {
  const child = new EventEmitter(), sent = [];
  let timeout;
  Object.assign(child, { exitCode: null, signalCode: null, connected: true, kills: 0,
    kill() { this.kills++; }, send(message, callback) { sent.push(message.type); callback(null); } });
  const context = vm.createContext({ serverProcess: child, setTimeout: callback => { timeout = callback; return {}; }, clearTimeout() {} });
  vm.runInContext(section("function stopChildBackendProcess(", "async function stopServer("), context);
  return { child, sent, context, stop: () => context.stopChildBackendProcess(), expire: () => timeout() };
}

test("child backend shutdown waits for clean exit after requesting native cleanup", async () => {
  const h = childHarness(); let finished = false;
  const stopped = h.stop().then(() => { finished = true; });
  await tick();
  assert.deepEqual(h.sent, ["explore-better:shutdown"]);
  assert.equal(finished, false);
  assert.equal(h.child.kills, 0);
  h.child.emit("close", 0);
  await stopped;
  assert.equal(h.context.serverProcess, null);
});

test("child backend timeout rejects instead of authorizing installation", async () => {
  const h = childHarness();
  const rejected = assert.rejects(h.stop(), /did not finish shutdown/);
  h.expire();
  await rejected;
  assert.equal(h.child.kills, 1);
});

test("failed child exit still allows embedded cleanup but rejects shutdown", async () => {
  const child = childHarness();
  const h = harness({ stopChildBackendProcess: child.stop });
  const rejected = assert.rejects(h.stop(), /before confirming clean shutdown/);
  await tick();
  child.child.emit("close", 1);
  await rejected;
  assert.deepEqual(h.events, ["http-close"]);
});

async function withHealthServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const context = vm.createContext({
    http, setTimeout, clearTimeout,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    backendApiCapability: "health-fixture-capability",
    backendHealthTimeoutMs: 100,
    desktopInstanceToken: "health-fixture-instance"
  });
  vm.runInContext(section("function serverIsReady(", "async function backendStatus("), context);
  try { await callback((timeoutMs) => context.serverIsReady(timeoutMs)); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function boundedHealthProbe(probe) {
  let timeout;
  try {
    return await Promise.race([probe, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Health probe did not settle within the test deadline")), 1500);
    })]);
  } finally { clearTimeout(timeout); }
}

test("health probe rejects a response aborted after headers and partial JSON", async () => {
  await withHealthServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":');
    setImmediate(() => response.destroy());
  }, async probe => assert.equal(await boundedHealthProbe(probe(100)), false));
});

test("health probe rejects a normally closed response with a truncated declared body", async () => {
  await withHealthServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": "1000", connection: "close" });
    response.end('{"ok":true');
  }, async probe => assert.equal(await boundedHealthProbe(probe(100)), false));
});

test("health probe has an overall deadline while response chunks keep arriving", async () => {
  let chunks = 0;
  await withHealthServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
    const timer = setInterval(() => { chunks++; response.write(" "); }, 15);
    response.once("close", () => clearInterval(timer));
  }, async probe => {
    assert.equal(await boundedHealthProbe(probe(150)), false);
    assert.ok(chunks > 1, "The fixture must exercise an active stream, not an idle socket");
  });
});

test("health probe accepts complete authenticated health including a chunked response", async () => {
  let receivedCapability;
  await withHealthServer((request, response) => {
    receivedCapability = request.headers["x-explore-better-capability"];
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":true,');
    setImmediate(() => response.end('"desktopInstanceToken":"health-fixture-instance"}'));
  }, async probe => {
    assert.equal(await boundedHealthProbe(probe(1000)), true);
    assert.equal(receivedCapability, "health-fixture-capability");
  });
});

test("health probe rejects complete invalid or mismatched responses", async () => {
  const replies = [
    { code: 200, body: "invalid JSON" },
    { code: 200, body: JSON.stringify({ ok: true, desktopInstanceToken: "other-instance" }) },
    { code: 503, body: JSON.stringify({ ok: true, desktopInstanceToken: "health-fixture-instance" }) }
  ];
  await withHealthServer((_request, response) => {
    const reply = replies.shift();
    response.writeHead(reply.code, { "content-type": "application/json" }); response.end(reply.body);
  }, async probe => {
    for (let index = 0; index < 3; index++) assert.equal(await boundedHealthProbe(probe(1000)), false);
  });
});
