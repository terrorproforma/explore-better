import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prefix = "EB_NATIVE_LIFECYCLE ";
const cycles = 12;
const terminalCount = 2;
const timeoutMs = 60_000;
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const publish = message => new Promise(resolve => process.stdout.write(`${prefix}${JSON.stringify(message)}\n`, resolve));

function nativeSession(nodePty, cwd) {
  const terminal = nodePty.spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), ["/D"], {
    cwd, cols: 100, rows: 28, useConpty: true, useConptyDll: true,
    env: { ...process.env, PROMPT: "EB_NATIVE_READY>" }
  });
  let output = "";
  let exitResult;
  const waiters = new Set();
  const exited = new Promise(resolve => terminal.onExit(result => {
    exitResult = result;
    for (const waiter of waiters) waiter.fail(new Error("Native terminal exited before the expected output."));
    resolve(result);
  }));
  terminal.onData(data => {
    output = `${output}${data}`.slice(-64 * 1024);
    // Reply as a terminal would, avoiding ConPTY's device-query fallback delay.
    if (data.includes("\x1b[c")) terminal.write("\x1b[?1;2c");
    for (const waiter of waiters) if (output.includes(waiter.text)) waiter.finish();
  });
  return {
    terminal, exited,
    output: () => output,
    waitFor(text) {
      if (output.includes(text)) return Promise.resolve();
      if (exitResult) return Promise.reject(new Error("Native terminal exited before the expected output."));
      return new Promise((resolve, reject) => {
        const finish = callback => { clearTimeout(timer); waiters.delete(waiter); callback(); };
        const waiter = { text, finish: () => finish(resolve), fail: error => finish(() => reject(error)) };
        const timer = setTimeout(() => waiter.fail(new Error(`Native terminal did not produce ${text}.`)), 10_000);
        waiters.add(waiter);
      });
    }
  };
}

async function childMain() {
  const { app } = require("electron");
  const runRoot = process.env.EXPLORE_BETTER_NATIVE_LIFECYCLE_DIR;
  app.setPath("userData", path.join(runRoot, "appdata", "Electron"));
  app.disableHardwareAcceleration();
  try {
    await app.whenReady();
    const nodePty = require("node-pty");
    const version = require("node-pty/package.json").version;
    assert.equal(version, JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies["node-pty"], "native dependency must match the exact package pin");
    await publish({ type: "started", version });
    const summaries = [];
    let nativeModule;
    for (let cycle = 0; cycle < cycles; cycle++) {
      const sessions = Array.from({ length: terminalCount }, () => nativeSession(nodePty, path.join(runRoot, "Workspace α")));
      await Promise.all(sessions.map(session => session.waitFor("EB_NATIVE_READY>")));
      if (!nativeModule) {
        const loaded = Object.keys(require.cache).find(file => path.basename(file).toLowerCase() === "conpty.node");
        assert.ok(loaded, "the actual ConPTY native module must be loaded");
        const prebuild = path.join(path.dirname(require.resolve("node-pty/package.json")), "prebuilds", `${process.platform}-${process.arch}`, "conpty.node");
        nativeModule = { path: loaded, sha256: hash(loaded), expectedPrebuild: prebuild };
        assert.equal(nativeModule.sha256, hash(prebuild), "an old build/Release module must not shadow the pinned prebuild");
      }
      const pids = sessions.map(session => session.terminal.pid);
      assert.ok(pids.every(pid => Number.isInteger(pid) && pid > 0), "all shells must have real PIDs after readiness");
      assert.equal(new Set(pids).size, terminalCount, "each terminal owns a separate shell");
      await Promise.all(sessions.map(async (session, index) => {
        const identity = `${cycle}_${index}`;
        const first = `EB_NATIVE_${identity}_ONE`;
        const second = `EB_NATIVE_${identity}_TWO`;
        session.terminal.write(`set "EB_NATIVE_STATE=${identity}"\r`);
        session.terminal.write("for %A in (ONE) do @echo EB_NATIVE_%EB_NATIVE_STATE%_%A\r");
        await session.waitFor(first);
        session.terminal.write("for %A in (TWO) do @echo EB_NATIVE_%EB_NATIVE_STATE%_%A\r");
        await session.waitFor(second);
        assert.ok(session.output().indexOf(first) < session.output().indexOf(second), "successive writes retain shell state and output order");
      }));
      // Closely spaced exits exercise the native handle-table race fixed by
      // microsoft/node-pty#922; completion must come from actual onExit events.
      for (const session of sessions) session.terminal.kill();
      const exits = await Promise.all(sessions.map(session => session.exited));
      assert.ok(exits.every(result => Number.isInteger(result.exitCode)), "all native exits must be observed");
      summaries.push({ cycle, pids, exits });
      await publish({ type: "cycle-complete", cycle, pids, exits });
    }
    await publish({ type: "complete", version, electron: process.versions.electron, nativeModule, cycles: summaries, terminalExits: summaries.length * terminalCount });
    app.exit(0);
  } catch (error) {
    // Keep this owned process alive until the parent terminates its whole tree,
    // including any shells whose native cleanup failed.
    const hold = setInterval(() => {}, 1000);
    await publish({ type: "failed", error: error.stack || error.message });
    await new Promise(() => {});
    clearInterval(hold);
  }
}

async function parentMain() {
  const artifacts = path.join(root, "artifacts");
  await mkdir(artifacts, { recursive: true });
  const runRoot = await mkdtemp(path.join(artifacts, "terminal-native-lifecycle-"));
  const appData = path.join(runRoot, "appdata");
  await Promise.all([mkdir(path.join(runRoot, "Workspace α"), { recursive: true }), mkdir(appData, { recursive: true })]);
  const started = Date.now();
  const child = spawn(path.join(root, "node_modules", "electron", "dist", "electron.exe"), [fileURLToPath(import.meta.url), "--terminal-native-lifecycle-child"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData, EXPLORE_BETTER_NATIVE_LIFECYCLE_DIR: runRoot }
  });
  let stdout = "", stderr = "", buffer = "", completion, failure, timedOut = false, stopping = false;
  const stopTree = () => {
    if (stopping || !child.pid || child.exitCode !== null) return;
    stopping = true;
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
  };
  child.stdout.on("data", chunk => {
    stdout += chunk;
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith(prefix)) continue;
      try {
        const message = JSON.parse(line.slice(prefix.length));
        if (message.type === "complete") completion = message;
        if (message.type === "failed") { failure = message.error; stopTree(); }
      } catch (error) { failure = error.message; stopTree(); }
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; stopTree(); }, timeoutMs);
  const result = await new Promise(resolve => {
    child.once("error", error => resolve({ code: null, error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const passed = result.code === 0 && !timedOut && !failure && completion?.terminalExits === cycles * terminalCount;
  const report = { passed, durationMs: Date.now() - started, runRoot, timedOut, ...result, failure, completion, stdout, stderr };
  await writeFile(path.join(runRoot, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(artifacts, "terminal-native-lifecycle-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (!passed) throw new Error(`Native terminal lifecycle failed: ${failure || result.error || (timedOut ? "hard timeout" : `exit ${result.code}`)}. See ${runRoot}`);
  console.log(`Native terminal lifecycle passed: ${cycles} cycles, ${completion.terminalExits} actual exits; node-pty ${completion.version}; ${completion.nativeModule.sha256}.`);
}

if (process.platform !== "win32") console.log("Native terminal lifecycle skipped: Windows only.");
// Electron waits for its ESM entry to finish before emitting app readiness.
else if (process.versions.electron && process.argv.includes("--terminal-native-lifecycle-child")) childMain();
else await parentMain();
