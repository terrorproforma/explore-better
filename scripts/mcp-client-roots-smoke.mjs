import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createBackendFixture, root } from "./mcp-smoke-helpers.mjs";
import { createMcpBridgeService } from "../mcp-bridge-service.mjs";

const fixture = await createBackendFixture();
const bridge = createMcpBridgeService({ manifestPath: path.join(fixture.temp, "manifest.json"), appVersion: "test", backend: fixture.backend, getContext: () => ({ live: false, contextRevision: 1 }) });
let sidecar, lines;
try {
  const workspace = path.join(fixture.fixture, "client-workspace");
  await fs.mkdir(workspace);
  const inside = path.join(workspace, "inside.txt");
  const outside = path.join(fixture.fixture, "outside-client.txt");
  await fs.writeFile(inside, "inside fixture"); await fs.writeFile(outside, "outside fixture");
  await bridge.start();
  sidecar = spawn(path.join(root, "native", "bin", "ExploreBetterMcp.exe"), ["--profile", fixture.profile.id, "--manifest", bridge.manifestPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let mode = "normal", nextId = 0, stderr = "";
  const pending = new Map();
  sidecar.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
  sidecar.stdin.on("error", () => {});
  const send = message => sidecar.stdin.write(JSON.stringify(message) + "\n");
  lines = readline.createInterface({ input: sidecar.stdout });
  lines.on("line", line => {
    const frame = JSON.parse(line);
    if (frame.method === "roots/list") {
      if (mode === "timeout") return;
      if (mode === "error") send({ jsonrpc: "2.0", id: frame.id, error: { code: -32603, message: "Temporary roots unavailable" } });
      else send({ jsonrpc: "2.0", id: frame.id, result: { roots: mode === "empty" ? [] : [{ uri: pathToFileURL(workspace).href, name: "Workspace" }] } });
    } else if (frame.method === "ping" && frame.id !== undefined) send({ jsonrpc: "2.0", id: frame.id, result: {} });
    else if (pending.has(frame.id)) { const done = pending.get(frame.id); pending.delete(frame.id); done(frame); }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${stderr}`)); }, 15000);
    pending.set(id, frame => { clearTimeout(timer); resolve(frame); });
    send({ jsonrpc: "2.0", id, method, params });
  });
  await call("initialize", { protocolVersion: "2025-11-25", capabilities: { roots: { listChanged: true } }, clientInfo: { name: "Root scope regression", version: "1" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  const read = file => call("tools/call", { name: "read_text", arguments: { path: file } });
  const allowed = await read(inside);
  assert.equal(allowed.result.structuredContent.data.text, "inside fixture");
  const excluded = await read(outside);
  assert.equal(excluded.result.structuredContent.error.code, "OUTSIDE_ROOTS");
  for (const value of ["error", "empty", "timeout"]) {
    mode = value;
    const result = await read(inside);
    assert.equal(result.result.isError, true, `${value} roots must not expand access`);
    assert.equal(result.result.structuredContent.error.code, value === "empty" ? "OUTSIDE_ROOTS" : "CLIENT_ROOTS_UNAVAILABLE");
  }
  mode = "normal";
  assert.equal((await read(inside)).result.structuredContent.data.text, "inside fixture");
  console.log("MCP client roots: 6 passed (supported, excluded, empty, error, timeout, recovery).");
} finally {
  lines?.close();
  if (sidecar && sidecar.exitCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => { sidecar.kill(); resolve(); }, 5000);
      sidecar.once("exit", () => { clearTimeout(timer); resolve(); });
      sidecar.stdin.end();
    });
  }
  await bridge.stop(); await fixture.cleanup();
}
process.exit(0);
