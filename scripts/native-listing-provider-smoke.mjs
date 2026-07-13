import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifacts = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifacts, `native-listing-provider-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const latest = path.join(artifacts, "native-listing-provider-latest.json");
const port = Number(process.env.PORT || 48731);

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
}

async function requestJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`, { headers: { "content-type": "application/json" } });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function startServer(extraEnv = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: path.join(runRoot, `appdata-${crypto.randomUUID()}`),
      EXPLORE_BETTER_NATIVE_LISTING_THRESHOLD: "500",
      EXPLORE_BETTER_STREAMING_WINDOW: "0",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}: ${output}`);
    try {
      await requestJson(baseUrl, "/api/roots");
      return { child, baseUrl };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
  child.kill();
  throw new Error(`Server did not start: ${output}`);
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.kill();
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500))
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

async function prepareFixture() {
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(path.join(fixture, "folder"));
  const writes = [];
  for (let index = 0; index < 600; index += 1) {
    writes.push(fs.writeFile(path.join(fixture, `sample-${String(index).padStart(4, "0")}.txt`), `native ${index}\n`));
  }
  await Promise.all(writes);
}

function listRoute(format = "") {
  const query = new URLSearchParams({
    path: fixture,
    showHidden: "true",
    includeDimensions: "false",
    includeLinks: "false",
    includeAttributes: "false",
    includeSignature: "false",
    bypassCache: "true"
  });
  if (format) query.set("format", format);
  return `/api/list?${query}`;
}

function windowListRoute(limit = 120) {
  const query = new URLSearchParams({
    path: fixture,
    showHidden: "true",
    includeDimensions: "false",
    includeLinks: "false",
    includeAttributes: "false",
    includeSignature: "false",
    bypassCache: "true",
    offset: "0",
    limit: String(limit)
  });
  return `/api/list?${query}`;
}

async function main() {
  await fs.mkdir(artifacts, { recursive: true });
  await prepareFixture();
  const checks = [];
  let nativeServer;
  let fallbackServer;
  try {
    nativeServer = await startServer();
    const nativeWindow = await requestJson(nativeServer.baseUrl, windowListRoute());
    check(
      checks,
      "native-window-provider-selected",
      nativeWindow.timing?.provider === "win32-find-files-window",
      nativeWindow.timing?.provider || "missing"
    );
    check(
      checks,
      "native-window-bounded-payload",
      nativeWindow.entries.length === 120 && nativeWindow.window?.total === 601 && nativeWindow.window?.hasMore === true,
      `${nativeWindow.entries.length}/${nativeWindow.window?.total || 0} entries`
    );
    check(
      checks,
      "native-window-serialized-prefix-only",
      nativeWindow.timing?.native?.serializedEntries === 120,
      `${nativeWindow.timing?.native?.serializedEntries || 0} serialized entries`
    );
    const native = await requestJson(nativeServer.baseUrl, listRoute());
    const sample = native.entries.find((entry) => entry.name === "sample-0042.txt");
    const folder = native.entries.find((entry) => entry.name === "folder");
    const sampleStats = await fs.stat(path.join(fixture, "sample-0042.txt"));
    check(checks, "native-provider-selected", native.timing?.provider === "win32-find-files-full", native.timing?.provider || "missing");
    check(checks, "native-entry-count", native.entries.length === 601, `${native.entries.length} entries`);
    check(checks, "native-file-size", sample?.size === sampleStats.size, `${sample?.size} bytes`);
    check(checks, "native-file-timestamp", Math.abs(Number(sample?.modified || 0) - sampleStats.mtimeMs) < 2, `${sample?.modified} vs ${sampleStats.mtimeMs}`);
    check(checks, "native-folder-kind", folder?.isDirectory === true && folder?.kind === "Folder", JSON.stringify(folder));
    check(
      checks,
      "native-helper-process-reused",
      native.timing?.native?.clientReused === true &&
        native.timing?.native?.helperPid === nativeWindow.timing?.native?.helperPid,
      `${nativeWindow.timing?.native?.helperPid || "none"} -> ${native.timing?.native?.helperPid || "none"}`
    );

    const compact = await requestJson(nativeServer.baseUrl, listRoute("compact-v1"));
    check(checks, "compact-version", compact.entryFormat === "compact-v1", compact.entryFormat || "missing");
    check(checks, "compact-entry-count", !compact.entries && compact.entryRows?.length === 601, `${compact.entryRows?.length || 0} rows`);
    const longestCompactRow = Math.max(0, ...(compact.entryRows || []).map((row) => row.length));
    check(checks, "compact-trailing-defaults-trimmed", longestCompactRow <= 9, `${longestCompactRow} fields`);
    const compactV2 = await requestJson(nativeServer.baseUrl, listRoute("compact-v2"));
    const compactBytes = Buffer.byteLength(JSON.stringify(compact));
    const compactV2Bytes = Buffer.byteLength(JSON.stringify(compactV2));
    const sampleV2 = compactV2.entryRows?.find((row) => row?.[0] === "sample-0042.txt");
    check(checks, "compact-v2-version", compactV2.entryFormat === "compact-v2", compactV2.entryFormat || "missing");
    check(
      checks,
      "compact-v2-entry-count",
      !compactV2.entries && compactV2.entryRows?.length === 601,
      `${compactV2.entryRows?.length || 0} rows`
    );
    check(
      checks,
      "compact-v2-dictionaries",
      compactV2.entryDictionaries?.extensions?.includes(".txt") && compactV2.entryDictionaries?.kinds?.includes("Text"),
      JSON.stringify(compactV2.entryDictionaries || {})
    );
    check(checks, "compact-v2-numeric-time", Number.isFinite(sampleV2?.[5]), `${sampleV2?.[5]}`);
    check(
      checks,
      "compact-v2-smaller",
      compactV2Bytes < compactBytes * 0.9,
      `${compactV2Bytes} vs ${compactBytes} bytes (${Math.round((compactV2Bytes / compactBytes) * 100)}%)`
    );
    await stopServer(nativeServer.child);
    nativeServer = null;

    const brokenHelper = path.join(runRoot, "broken-helper.exe");
    await fs.writeFile(brokenHelper, "not an executable", "utf8");
    fallbackServer = await startServer({ EXPLORE_BETTER_FS_HELPER: brokenHelper });
    const fallback = await requestJson(fallbackServer.baseUrl, listRoute());
    check(checks, "node-fallback-selected", fallback.timing?.provider === "node", fallback.timing?.provider || "missing");
    check(checks, "node-fallback-diagnostic", Boolean(fallback.timing?.nativeProviderFallback), fallback.timing?.nativeProviderFallback || "missing");
    check(checks, "node-fallback-complete", fallback.entries.length === 601, `${fallback.entries.length} entries`);

    const report = {
      generatedAt: new Date().toISOString(),
      fixture,
      nativeTiming: native.timing,
      nativeWindowTiming: nativeWindow.timing,
      compactBytesEstimate: compactBytes,
      compactV2BytesEstimate: compactV2Bytes,
      fallbackTiming: fallback.timing,
      checks,
      summary: {
        pass: checks.filter((item) => item.status === "pass").length,
        fail: checks.filter((item) => item.status === "fail").length
      }
    };
    await fs.writeFile(latest, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Native listing provider: ${report.summary.pass} pass, ${report.summary.fail} fail`);
    console.log(`Native browse ${Number(native.timing?.statMs || 0).toFixed(1)} ms; fallback ${Number(fallback.timing?.statMs || 0).toFixed(1)} ms`);
    if (report.summary.fail) process.exitCode = 1;
  } finally {
    await stopServer(nativeServer?.child);
    await stopServer(fallbackServer?.child);
    await fs.rm(runRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
