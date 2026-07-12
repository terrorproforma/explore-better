import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `folder-index-corruption-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
const indexRoot = path.join(appData, "ExploreBetter", "Index");
const latestJsonPath = path.join(artifactsDir, "folder-index-corruption-latest.json");
const latestMdPath = path.join(artifactsDir, "folder-index-corruption-latest.md");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_FOLDER_INDEX_CORRUPTION_KEEP_FIXTURE === "1";
}

function pathIdentity(itemPath) {
  const resolved = path.resolve(itemPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function folderIndexFile(folderPath) {
  const id = crypto.createHash("sha256").update(pathIdentity(folderPath)).digest("hex").slice(0, 32);
  return path.join(indexRoot, `${id}.json`);
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
  if (!ok) {
    throw new Error(`${id}: ${detail}`);
  }
}

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${serverOutput}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}: ${serverOutput}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 1500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function prepareFixture() {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const target = path.join(fixtureRoot, "speed-index-repair-target.txt");
  await fs.writeFile(target, "active folder index corruption repair proof\n", "utf8");
  await fs.writeFile(path.join(fixtureRoot, "plain-control.txt"), "control\n", "utf8");
  return { target };
}

async function buildIndex(baseUrl) {
  return requestJson(baseUrl, "/api/index/build", {
    method: "POST",
    body: JSON.stringify({
      path: fixtureRoot,
      wait: true,
      includeDimensions: false,
      includeLinks: false
    })
  });
}

async function status(baseUrl) {
  return requestJson(baseUrl, `/api/index/status?${new URLSearchParams({ path: fixtureRoot })}`);
}

async function search(baseUrl, query) {
  return requestJson(baseUrl, `/api/index/search?${new URLSearchParams({ path: fixtureRoot, q: query, limit: "20" })}`);
}

function hasHit(searchResult, targetPath) {
  return (searchResult.results || []).some((item) => item.path === targetPath);
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# Folder Index Corruption Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}

Index file: ${report.indexFile}
Corrupt JSON quarantine: ${report.corruptJson?.quarantinedPath || "none"}
Bad schema quarantine: ${report.badSchema?.quarantinedPath || "none"}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const checks = [];
  const fixture = await prepareFixture();
  const indexFile = folderIndexFile(fixtureRoot);
  const port = Number(optionValue("--port", process.env.PORT || 59000 + Math.floor(Math.random() * 4000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  let initialBuild = null;
  let initialSearch = null;
  let corruptJsonStatus = null;
  let corruptJsonSearch = null;
  let rebuildAfterJson = null;
  let badSchemaStatus = null;
  let rebuildAfterSchema = null;
  let finalSearch = null;
  try {
    await waitForServer(baseUrl, server);
    initialBuild = await buildIndex(baseUrl);
    initialSearch = await search(baseUrl, "repair-target");
    check(checks, "initial-index-built", initialBuild.index?.count >= 2 && initialBuild.job?.status === "complete", `count=${initialBuild.index?.count}; status=${initialBuild.job?.status}.`);
    check(checks, "initial-search-hit", hasHit(initialSearch, fixture.target), `returned=${initialSearch.results?.length || 0}.`);

    await fs.writeFile(indexFile, "{ broken folder index", "utf8");
    corruptJsonStatus = await status(baseUrl);
    corruptJsonSearch = await search(baseUrl, "repair-target");
    check(checks, "corrupt-json-status-structured", corruptJsonStatus.indexed === false && corruptJsonStatus.indexRead?.corrupt === true, `indexed=${corruptJsonStatus.indexed}; corrupt=${corruptJsonStatus.indexRead?.corrupt}.`);
    check(checks, "corrupt-json-quarantined", Boolean(corruptJsonStatus.indexRead?.quarantinedPath), `quarantine=${corruptJsonStatus.indexRead?.quarantinedPath || "missing"}.`);
    check(checks, "corrupt-json-search-safe", corruptJsonSearch.indexed === false && (corruptJsonSearch.results || []).length === 0 && corruptJsonSearch.indexRead?.missing === true, `indexed=${corruptJsonSearch.indexed}; missing=${corruptJsonSearch.indexRead?.missing}.`);

    rebuildAfterJson = await buildIndex(baseUrl);
    check(checks, "rebuild-after-corrupt-json", rebuildAfterJson.index?.count >= 2, `count=${rebuildAfterJson.index?.count}.`);

    await fs.writeFile(
      indexFile,
      JSON.stringify({ version: 1, path: fixtureRoot, pathKey: "wrong-path", entries: "not an array" }, null, 2),
      "utf8"
    );
    badSchemaStatus = await status(baseUrl);
    check(checks, "bad-schema-status-structured", badSchemaStatus.indexed === false && badSchemaStatus.indexRead?.corrupt === true && badSchemaStatus.indexRead?.error === "invalid-folder-index-schema", `indexed=${badSchemaStatus.indexed}; error=${badSchemaStatus.indexRead?.error}.`);
    check(checks, "bad-schema-quarantined", Boolean(badSchemaStatus.indexRead?.quarantinedPath), `quarantine=${badSchemaStatus.indexRead?.quarantinedPath || "missing"}.`);

    rebuildAfterSchema = await buildIndex(baseUrl);
    finalSearch = await search(baseUrl, "repair-target");
    const finalPersisted = JSON.parse(await fs.readFile(indexFile, "utf8"));
    check(checks, "rebuild-after-bad-schema", rebuildAfterSchema.index?.count >= 2 && finalPersisted.version === 1 && Array.isArray(finalPersisted.entries), `count=${rebuildAfterSchema.index?.count}; persistedEntries=${finalPersisted.entries?.length || 0}.`);
    check(checks, "final-search-hit", finalSearch.indexed === true && hasHit(finalSearch, fixture.target), `returned=${finalSearch.results?.length || 0}.`);

    const summary = {
      pass: checks.filter((item) => item.status === "pass").length,
      warn: checks.filter((item) => item.status === "warn").length,
      fail: checks.filter((item) => item.status === "fail").length
    };
    const report = {
      generatedAt: new Date().toISOString(),
      status: summary.fail ? "fail" : "pass",
      runRoot,
      fixtureRoot,
      indexFile,
      paths: fixture,
      initialBuild: initialBuild.index,
      corruptJson: {
        error: corruptJsonStatus.indexRead?.error || null,
        quarantinedPath: corruptJsonStatus.indexRead?.quarantinedPath || null,
        searchSafe: corruptJsonSearch.indexed === false
      },
      badSchema: {
        error: badSchemaStatus.indexRead?.error || null,
        quarantinedPath: badSchemaStatus.indexRead?.quarantinedPath || null
      },
      final: {
        count: rebuildAfterSchema.index?.count || 0,
        searchReturned: finalSearch.results?.length || 0
      },
      serverOutput: serverOutput.slice(-4000),
      checks,
      summary
    };
    await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
    console.log(`folder index corruption: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
    console.log(`wrote ${latestJsonPath}`);
    console.log(`wrote ${latestMdPath}`);
    if (summary.fail > 0) {
      process.exitCode = 1;
    }
  } finally {
    await stopServer(server);
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
