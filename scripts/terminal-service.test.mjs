import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { createTerminalAdapterEmitter, createTerminalService, runTerminalBroker } from "../terminal-service.mjs";
import { terminalMarkerDirectory, windowsArgumentList } from "../lib/terminal-protocol.mjs";

const artifacts = path.resolve("artifacts");
await mkdir(artifacts, { recursive: true });
const fixture = await mkdtemp(path.join(artifacts, "terminal-service-"));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

class Port extends EventEmitter {
  messages = [];
  start() {}
  postMessage(value) { this.messages.push(value); }
  close() { this.closed = true; }
}
class Channel { port1 = new Port(); port2 = new Port(); }
function adapter() {
  const item = createTerminalAdapterEmitter();
  const exit = deferred();
  item.exited = exit.promise;
  item.pid = 1234;
  item.writes = [];
  item.sizes = [];
  item.killCount = 0;
  item.write = data => item.writes.push(data);
  item.resize = (cols, rows) => item.sizes.push([cols, rows]);
  item.kill = () => { item.killCount++; item.emit("kill"); };
  item.finish = () => { exit.resolve({ exitCode: 0 }); item.emit("exit", { exitCode: 0, signal: 0 }); };
  return item;
}
function harness(factory = async () => adapter()) {
  const messages = [];
  const frame = { url: "http://127.0.0.1:54321/", postMessage: (...args) => messages.push(args) };
  const sender = { id: 1, mainFrame: frame, isDestroyed: () => false };
  const service = createTerminalService({ MessageChannelMain: Channel, getMainWindow: () => ({ webContents: sender }),
    getBaseUrl: () => "http://127.0.0.1:54321", runtime: {}, createAdapter: factory });
  return { service, frame, event: { sender, senderFrame: frame }, messages };
}
const request = { tabId: "terminal-tab-1234", cwd: fixture, profileId: process.platform === "win32" ? "command-prompt" : "auto" };
const windowsOnly = { skip: process.platform !== "win32" };

test("raw marker paths preserve percent sequences; only file URLs are decoded", () => {
  const directory = path.join(fixture, "100% complete", "a%20b α");
  assert.equal(terminalMarkerDirectory(directory), directory);
  assert.equal(terminalMarkerDirectory(pathToFileURL(directory).href, true), directory);
  assert.equal(terminalMarkerDirectory("file:///C:/bad%path", true), "");
  assert.equal(terminalMarkerDirectory("https://example.test/", true), "");
});

test("PowerShell launches preserve spaces, quotes, Unicode and trailing slashes", windowsOnly, async () => {
  const dir = path.join(fixture, "User With Space α");
  await mkdir(dir);
  const receiver = path.join(dir, "receive args.mjs");
  const output = path.join(dir, "args.json");
  await writeFile(receiver, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const values = ["one two", 'quote"here', "C:\\trailing\\", "100% α"];
  const ps = value => `'${value.replaceAll("'", "''")}'`;
  const command = `Start-Process -FilePath ${ps(process.execPath)} -WindowStyle Hidden -ArgumentList ${ps(windowsArgumentList([receiver, ...values]))} -Wait -RedirectStandardOutput ${ps(output)}`;
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", chunk => { error += chunk; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(error)));
  });
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), values);
});

test("overlapping creation admits only one terminal per tab", windowsOnly, async () => {
  const gate = deferred();
  const item = adapter();
  const h = harness(() => gate.promise);
  const first = h.service.create(h.event, request);
  await assert.rejects(h.service.create(h.event, request), /already owns/);
  gate.resolve(item);
  await first;
  assert.equal(h.service.sessionCount(), 1);
  h.service.disposeAll(); item.finish();
  assert.equal(await h.service.waitForIdle(), true);
});

test("window disposal during startup kills late PTY and publishes no port", windowsOnly, async () => {
  const started = deferred(), gate = deferred();
  const item = adapter();
  const h = harness(() => { started.resolve(); return gate.promise; });
  const creating = h.service.create(h.event, request);
  const rejected = assert.rejects(creating, /closed/);
  await started.promise;
  h.service.disposeWebContents(1);
  gate.resolve(item);
  await rejected;
  assert.equal(item.killCount, 1);
  assert.equal(h.messages.length, 0);
  assert.equal(h.service.sessionCount(), 0);
  assert.equal(await h.service.waitForIdle(5), false, "native exit is still outstanding");
  item.finish();
  assert.equal(await h.service.waitForIdle(), true);
});

test("navigation while starting invalidates the original renderer", windowsOnly, async () => {
  const started = deferred(), gate = deferred();
  const item = adapter();
  const h = harness(() => { started.resolve(); return gate.promise; });
  const creating = h.service.create(h.event, request);
  const rejected = assert.rejects(creating, /closed/);
  await started.promise;
  h.frame.url = "http://127.0.0.1:54321/api/raw?path=fixture.txt";
  gate.resolve(item);
  await rejected;
  assert.equal(item.killCount, 1);
  assert.equal(h.messages.length, 0);
  item.finish(); await h.service.waitForIdle();
});

test("closing a terminal during restart does not resurrect the replacement", windowsOnly, async () => {
  const original = adapter(), replacement = adapter(), gate = deferred(), started = deferred();
  let count = 0;
  const h = harness(() => ++count === 1 ? original : (started.resolve(), gate.promise));
  const first = await h.service.create(h.event, request);
  const restarting = h.service.restart(h.event, first.sessionId, request);
  const rejected = assert.rejects(restarting, /closed/);
  await started.promise;
  h.service.disposeForEvent(h.event, first.sessionId);
  original.finish(); gate.resolve(replacement);
  await rejected;
  assert.equal(replacement.killCount, 1);
  replacement.finish();
  assert.equal(await h.service.waitForIdle(), true);
});

test("raw and split file-URL markers update paths without throwing", windowsOnly, async () => {
  const item = adapter();
  const h = harness(async () => item);
  await h.service.create(h.event, request);
  const raw = path.join(fixture, "100% complete");
  assert.doesNotThrow(() => item.emit("data", `\x1b]9;9;${raw}\x07`));
  assert.equal(h.service.cwdForSmoke(), raw);
  const encoded = pathToFileURL(path.join(fixture, "a%20b α")).href;
  item.emit("data", `\x1b]7;${encoded.slice(0, 15)}`);
  item.emit("data", `${encoded.slice(15)}\x07`);
  assert.equal(h.service.cwdForSmoke(), path.join(fixture, "a%20b α"));
  assert.doesNotThrow(() => item.emit("data", "\x1b]7;file:///C:/bad%path\x07"));
  h.service.disposeAll(); item.finish(); await h.service.waitForIdle();
});

test("disposal waits for actual native exit, not removal from the map", windowsOnly, async () => {
  const item = adapter();
  const h = harness(async () => item);
  const created = await h.service.create(h.event, request);
  h.service.disposeForEvent(h.event, created.sessionId);
  assert.equal(h.service.sessionCount(), 0);
  assert.equal(await h.service.waitForIdle(5), false);
  item.finish();
  assert.equal(await h.service.waitForIdle(), true);
});

test("a native exit before adapter creation returns cannot leave a ready orphan", windowsOnly, async () => {
  const item = adapter();
  const h = harness(async () => {
    item.finish();
    return item;
  });
  await h.service.create(h.event, request);
  assert.equal(h.service.sessionCount(), 0);
  assert.equal(await h.service.waitForIdle(10), true);
  assert.equal(item.killCount, 0, "an exited native process needs no further kill");
  assert.doesNotThrow(() => item.emit("exit", { exitCode: 0, signal: 0 }));
  assert.doesNotThrow(() => item.emit("disconnect"));
  assert.equal(h.service.sessionCount(), 0);
});

test("terminal startup retains a bounded prompt and its markers until listeners attach", windowsOnly, async () => {
  const item = adapter();
  const cwd = path.join(fixture, "early prompt α");
  const prompt = `\x1b]633;EB;idle\x07\x1b]9;9;${cwd}\x07ready α> `;
  const h = harness(async () => {
    item.pushOutput("startup ".repeat(50_000));
    item.pushOutput(prompt);
    return item;
  });
  await h.service.create(h.event, request);
  const output = h.service.outputForSmoke();
  assert.equal(output.length, 256 * 1024, "startup retention stays bounded");
  assert.equal(output.endsWith(prompt), true);
  assert.equal(h.service.cwdForSmoke(), cwd);
  assert.equal((await h.service.syncForSmoke(fixture)).queued, false, "the buffered idle marker marks the prompt ready");
  item.activate();
  assert.equal(h.service.outputForSmoke(), output, "activation does not replay output twice");
  item.pushOutput("live output");
  assert.equal(h.service.outputForSmoke().endsWith("live output"), true);
  h.service.disposeAll(); item.finish();
  assert.equal(await h.service.waitForIdle(), true);
});

async function brokerManifest(pipeName) {
  const manifestPath = path.join(fixture, `broker-${randomUUID()}.json`);
  await writeFile(manifestPath, JSON.stringify({ version: 1, pipeName, nonce: "fixture-nonce", parentPid: process.pid,
    profileId: "command-prompt", cwd: fixture, cols: 100, rows: 28, createdAt: Date.now() }));
  return manifestPath;
}

async function brokerHarness(t, createAdapter, shutdownTimeoutMs = 1000) {
  const pipeName = `\\\\.\\pipe\\ExploreBetter-Broker-Test-${randomUUID()}`;
  const connected = deferred();
  const sockets = new Set();
  const messages = [];
  const events = new EventEmitter();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        messages.push(message);
        events.emit(message.type, message);
      }
    });
    connected.resolve(socket);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(pipeName);
  await once(server, "listening");
  const running = runTerminalBroker(await brokerManifest(pipeName), { createAdapter, shutdownTimeoutMs });
  running.catch(() => {});
  return { running, connected: connected.promise, messages,
    message: async type => messages.find(message => message.type === type) || (await once(events, type))[0] };
}

const brokerTest = { ...windowsOnly, timeout: 5000 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test("administrator broker does not create a PTY without a parent connection", brokerTest, async () => {
  let creations = 0;
  const pipeName = `\\\\.\\pipe\\ExploreBetter-Broker-Missing-${randomUUID()}`;
  await assert.rejects(runTerminalBroker(await brokerManifest(pipeName), {
    createAdapter: async () => { creations++; return adapter(); }
  }), /ENOENT|ECONNREFUSED/);
  assert.equal(creations, 0);
});

test("administrator broker preserves terminal messages and reports native exit", brokerTest, async t => {
  const item = adapter();
  const h = await brokerHarness(t, async () => item);
  const socket = await h.connected;
  assert.deepEqual(await h.message("hello"), { type: "hello", nonce: "fixture-nonce", parentPid: process.pid, pid: item.pid });
  item.emit("data", "terminal output α");
  assert.equal(Buffer.from((await h.message("data")).data, "base64").toString("utf8"), "terminal output α");
  socket.write(`${JSON.stringify({ type: "write", data: Buffer.from("input α").toString("base64") })}\n`);
  socket.write(`${JSON.stringify({ type: "resize", cols: 120, rows: 40 })}\n`);
  // The marker confirms that both preceding messages were consumed in order.
  const killed = once(item, "kill");
  socket.write(`${JSON.stringify({ type: "kill" })}\n`);
  await killed;
  assert.deepEqual(item.writes, ["input α"]);
  assert.deepEqual(item.sizes, [[120, 40]]);
  assert.equal(item.killCount, 1);
  item.finish();
  assert.equal((await h.message("exit")).exitCode, 0);
  await h.running;
  assert.equal(item.killCount, 1);
});

test("administrator broker keeps the exit channel open through a shutdown request", brokerTest, async t => {
  const item = adapter();
  const h = await brokerHarness(t, async () => item);
  const socket = await h.connected;
  await h.message("hello");
  let settled = false;
  h.running.finally(() => { settled = true; }).catch(() => {});
  const killed = once(item, "kill");
  socket.write(`${JSON.stringify({ type: "kill" })}\n`);
  await killed;
  await pause(30);
  assert.equal(settled, false, "a kill request is not native process exit");
  assert.equal(socket.destroyed, false, "the parent can still receive native exit");
  item.finish();
  assert.equal((await h.message("exit")).exitCode, 0);
  await h.running;
  assert.equal(item.killCount, 1);
});

test("administrator broker drains spontaneous native exit without killing again", brokerTest, async t => {
  const item = adapter();
  const h = await brokerHarness(t, async () => item);
  await h.message("hello");
  item.finish();
  assert.equal((await h.message("exit")).exitCode, 0);
  await h.running;
  assert.equal(item.killCount, 0);
});

test("administrator broker sends hello before buffered startup output", brokerTest, async t => {
  const item = adapter();
  const h = await brokerHarness(t, async () => {
    item.pushOutput("early native prompt α");
    return item;
  });
  assert.equal(Buffer.from((await h.message("data")).data, "base64").toString("utf8"), "early native prompt α");
  assert.deepEqual(h.messages.slice(0, 2).map(message => message.type), ["hello", "data"]);
  item.finish();
  await h.running;
});

test("administrator broker retires a late PTY after disconnect during creation", brokerTest, async t => {
  const item = adapter();
  const started = deferred(), aborted = deferred(), gate = deferred();
  const h = await brokerHarness(t, (_options, _runtime, signal) => {
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    started.resolve();
    return gate.promise;
  });
  const socket = await h.connected;
  await started.promise;
  socket.destroy();
  await aborted.promise;
  const killed = once(item, "kill");
  gate.resolve(item);
  await killed;
  let settled = false;
  h.running.finally(() => { settled = true; }).catch(() => {});
  await pause(30);
  assert.equal(settled, false, "late native creation must finish cleanup");
  item.finish();
  await h.running;
  assert.equal(item.killCount, 1);
  assert.equal(h.messages.length, 0, "no orphan session is announced");
});

test("administrator broker bounds cleanup when native exit never arrives", brokerTest, async t => {
  const item = adapter();
  const h = await brokerHarness(t, async () => item, 30);
  const socket = await h.connected;
  await h.message("hello");
  socket.end();
  await assert.rejects(h.running, /native exit timed out during cleanup/);
  assert.equal(item.killCount, 1);
  item.finish();
});

test("administrator broker waits for native cleanup after malformed input", brokerTest, async t => {
  const item = adapter();
  const h = await brokerHarness(t, async () => item);
  const socket = await h.connected;
  await h.message("hello");
  const killed = once(item, "kill");
  socket.write("invalid json\n");
  await killed;
  let settled = false;
  h.running.finally(() => { settled = true; }).catch(() => {});
  await pause(30);
  assert.equal(settled, false);
  item.finish();
  await assert.rejects(h.running, SyntaxError);
  assert.equal(item.killCount, 1);
});
