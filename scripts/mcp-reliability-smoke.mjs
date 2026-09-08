import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { createMcpAutomationService } from "../mcp/automation-service.mjs";
import { createMcpBridgeService } from "../mcp-bridge-service.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "eb-mcp-reliability-"));
const folder = path.join(temp, "files");
const appDataRoot = path.join(temp, "state");
const jobsRoot = path.join(appDataRoot, "MCP", "jobs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check) => {
  const until = Date.now() + 5000;
  while (Date.now() < until) { if (await check()) return; await delay(5); }
  throw new Error("The reliability fixture did not settle.");
};
let bridge;
const sockets = new Set();
try {
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(jobsRoot, { recursive: true });
  const expired = path.join(jobsRoot, `${crypto.randomUUID()}.json`);
  await fs.writeFile(expired, "{}");
  const old = new Date(Date.now() - 2 * 86_400_000);
  await fs.utimes(expired, old, old);
  for (let index = 0; index < 105; index += 1) await fs.writeFile(path.join(jobsRoot, `${crypto.randomUUID()}.json`), "{}");
  let active = 0;
  const workers = [];
  let workerResult = { items: [] };
  const service = await createMcpAutomationService({
    appDataRoot, internalRoots: [appDataRoot], resolveUserPath: (value) => path.resolve(value),
    advancedSearch: async ({ limit }) => ({ entries: [], scanned: 100, truncated: true, limit }),
    checksumReport: async (_body, { signal }) => {
      assert(signal instanceof AbortSignal, "Workers receive their cancellation signal.");
      active += 1;
      let finish;
      const done = new Promise((resolve) => { finish = resolve; });
      workers.push({ signal, finish });
      try { await done; return workerResult; } finally { active -= 1; }
    }
  });
  assert.equal(await fs.access(expired).then(() => true, () => false), false, "Startup removes expired persisted jobs.");
  assert((await fs.readdir(jobsRoot)).length <= 100, "Retained job count is bounded on startup.");
  await service.configure({ enabled: true });
  const profile = await service.upsertProfile({ name: "Reliability fixture", roots: [folder] });
  const invoke = (tool, args = {}) => service.invoke({ profileId: profile.id, sessionId: "fixture", tool, args });
  let rendererRevision = 20, appliedUiActions = 0, advanceDuringDispatch = false;
  const descriptionToken = JSON.stringify({ pane: "left", paths: [folder] });
  service.setUiDispatcher(async (action) => {
    if (action.type === "describe") return { pane: "left", paths: [folder], contextRevision: rendererRevision, descriptionToken };
    assert.equal(action.expectedDescriptionToken, descriptionToken);
    assert.equal(action.expectedContextRevision, rendererRevision);
    if (advanceDuringDispatch) {
      advanceDuringDispatch = false; rendererRevision += 1;
      throw Object.assign(new Error("A pending renderer context update completed before dispatch."), { code: "STALE_CONTEXT" });
    }
    appliedUiActions += 1;
    return { contextRevision: rendererRevision, startingContextRevision: rendererRevision };
  });
  const freshView = await invoke("set_ui_view", { view: "operations" });
  assert.equal(freshView.data.startingContextRevision, 20, "Implicit UI actions use actual renderer state rather than the older published context.");
  await assert.rejects(invoke("invoke_ui_action", { actionId: "pane.activate", expectedContextRevision: 19 }), { code: "STALE_CONTEXT" });
  const freshExplicit = await invoke("invoke_ui_action", { actionId: "pane.activate", expectedContextRevision: 20 });
  assert.equal(freshExplicit.data.startingContextRevision, 20, "An explicit current renderer revision is valid even if its published snapshot lags.");
  advanceDuringDispatch = true;
  const retried = await invoke("set_ui_view", { view: "operations", visible: false });
  assert.equal(retried.data.startingContextRevision, 21);
  assert.equal(appliedUiActions, 3, "A pre-dispatch freshness retry performs the UI action once.");

  const content = "A café 😀 Ελληνικά 日本語 Z";
  for (const encoding of ["utf8", "utf16le", "latin1"]) {
    const file = path.join(folder, `${encoding}.txt`);
    const bytes = encoding === "utf16le"
      ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, encoding)])
      : Buffer.from(encoding === "latin1" ? "café latin text" : content, encoding);
    await fs.writeFile(file, bytes);
    for (const maxBytes of [1, 2, 3, 5, 7, 10]) {
      let offset = 0, joined = "", pages = 0;
      while (offset < bytes.length) {
        const page = (await invoke("read_text", { path: file, offset, maxBytes, encoding: encoding === "latin1" ? encoding : "auto" })).data;
        assert(page.nextOffset > offset, "Every text page advances by complete characters.");
        joined += page.text; offset = page.nextOffset; pages += 1;
        assert(pages <= bytes.length, "Text paging terminates.");
      }
      assert.equal(joined, bytes.toString(encoding), `${encoding} survives paging at ${maxBytes} bytes.`);
    }
  }

  const search = await invoke("search_files", { path: folder, query: "absent", maxScanned: 100, limit: 10 });
  assert.equal(search.status, "partial");
  assert.equal(search.nextCursor, undefined, "Scan exhaustion ends pagination.");
  assert(search.warnings.length > 0);

  const sample = path.join(folder, "utf8.txt");
  const jobIds = [];
  for (let index = 0; index < 3; index += 1) {
    jobIds.push((await invoke("compute_checksums", { paths: [sample] })).data.job.id);
  }
  await waitFor(() => workers.length === 3);
  for (const jobId of jobIds) await invoke("cancel_job", { jobId });
  assert(workers.every((worker) => worker.signal.aborted));
  assert.equal(active, 3, "Fixture workers are still finishing cancellation cleanup.");
  await assert.rejects(invoke("compute_checksums", { paths: [sample] }), { code: "LIMIT_EXCEEDED" });
  workers.forEach((worker) => worker.finish());
  await waitFor(() => active === 0);
  workerResult = {
    items: Array.from({ length: 400 }, (_, index) => ({ index, description: "x".repeat(8000) })),
    topFolders: Array.from({ length: 400 }, (_, index) => ({ index, description: "y".repeat(8000) }))
  };
  const resultJob = (await invoke("compute_checksums", { paths: [sample] })).data.job.id;
  await waitFor(() => workers.length === 4);
  workers[3].finish();
  let result;
  await waitFor(async () => { result = await invoke("get_job", { jobId: resultJob, limit: 500 }); return result.data.status === "complete"; });
  assert(Buffer.byteLength(JSON.stringify(result)) < 4 * 1024 * 1024, "All result sections fit one bridge response.");
  assert(result.data.nextCursor, "Large multi-section jobs retain a continuation.");
  const second = await invoke("get_job", { jobId: resultJob, limit: 500, cursor: result.data.nextCursor });
  assert(second.data.result.items[0].index > result.data.result.items.at(-1).index);
  assert(second.data.result.topFolders[0].index > result.data.result.topFolders.at(-1).index);

  bridge = createMcpBridgeService({
    manifestPath: path.join(temp, "manifest.json"), appVersion: "fixture", getContext: () => ({}),
    backend: { setMcpUiDispatcher: async () => {}, invokeMcpAutomation: async (request) => request.args }
  });
  await bridge.start();
  const manifest = JSON.parse(await fs.readFile(bridge.manifestPath, "utf8"));
  const connect = async () => {
    const socket = net.createConnection(bridge.pipeName);
    sockets.add(socket); socket.on("error", () => {}); socket.setEncoding("utf8");
    const frames = []; let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line) frames.push(JSON.parse(line));
      }
    });
    await new Promise((resolve) => socket.once("connect", resolve));
    return { socket, frames };
  };
  const valid = await connect();
  valid.socket.write(`${JSON.stringify({ version: 2, op: "hello", id: "hello", nonce: manifest.nonce })}\n`);
  await waitFor(() => valid.frames.length);
  const expected = "Unicode 😀 café 日本語";
  const frame = Buffer.from(`${JSON.stringify({ op: "invoke", id: "unicode", tool: "fixture", args: { text: expected } })}\n`);
  const split = frame.indexOf(Buffer.from("😀")) + 2;
  valid.socket.write(frame.subarray(0, split)); await delay(10); valid.socket.write(frame.subarray(split));
  await waitFor(() => valid.frames.some((item) => item.id === "unicode"));
  assert.equal(valid.frames.find((item) => item.id === "unicode").result.text, expected);
  const shape = await connect(); shape.socket.write("null\n");
  await waitFor(() => shape.frames.length);
  assert.equal(shape.frames[0].error.code, "INVALID_REQUEST", "Non-object frames receive a bounded protocol error.");
  valid.socket.write(`${JSON.stringify({ op: "ping", id: "still-ready" })}\n`);
  await waitFor(() => valid.frames.some((item) => item.id === "still-ready"));
  await service.listAudit();
  console.log("MCP reliability smoke passed: Unicode and text paging, terminating searches, worker cancellation budgets, bounded results, retained jobs, and protocol validation.");
} finally {
  for (const socket of sockets) socket.destroy();
  await bridge?.stop();
  const resolved = path.resolve(temp);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("eb-mcp-reliability-"));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}
