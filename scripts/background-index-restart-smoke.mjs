import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `background-index-restart-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const nested = path.join(fixtureRoot, "nested");
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
const statePath = path.join(stateDir, "state.json");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_BACKGROUND_INDEX_RESTART_KEEP_FIXTURE === "1";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
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

async function waitForBackgroundComplete(baseUrl, rootId) {
  const started = Date.now();
  while (Date.now() - started < 25000) {
    const overview = await requestJson(baseUrl, "/api/background-indexes");
    const root = overview.roots.find((item) => item.id === rootId);
    assert(root, "Background root should remain registered.");
    if (root.job?.status === "error") {
      throw new Error(root.job.error || "Background index failed.");
    }
    if (!root.job || root.job.status === "complete") {
      return root;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Background index did not complete in time.");
}

function startServer(port) {
  serverOutput = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
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
  await fs.mkdir(nested, { recursive: true });
  const labelledPath = path.join(nested, "plain.txt");
  const filenamePath = path.join(nested, "persistent-needle-report.log");
  const contentPath = path.join(nested, "content-after-restart.md");
  await fs.writeFile(path.join(fixtureRoot, "root-file.txt"), "root\n", "utf8");
  await fs.writeFile(labelledPath, "ordinary name\n", "utf8");
  await fs.writeFile(filenamePath, "needle by name\n", "utf8");
  await fs.writeFile(contentPath, "This file survives restart with phrase: obsidian invoice.\n", "utf8");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        labels: [
          {
            path: labelledPath,
            name: "Restarted",
            color: "gold",
            notes: "aurora ledger"
          }
        ],
        operations: []
      },
      null,
      2
    ),
    "utf8"
  );
  return { labelledPath, filenamePath, contentPath };
}

function assertHit(search, targetPath, message) {
  assert(search.indexed === true, `${message}: search should report indexed=true.`);
  assert(
    search.results.some((item) => item.path === targetPath),
    `${message}: expected hit ${targetPath}.`
  );
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixture = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || "49351"));
  const baseUrl = `http://127.0.0.1:${port}`;
  let server = startServer(port);
  let rootId = "";
  let before = null;
  let after = null;
  try {
    await waitForServer(baseUrl, server);
    const started = await requestJson(baseUrl, "/api/background-indexes/start", {
      method: "POST",
      body: JSON.stringify({
        path: fixtureRoot,
        recursive: true,
        includeDimensions: false,
        includeLinks: false,
        includeContent: true,
        maxContentBytes: 4096,
        maxContentFiles: 20,
        maxFolders: 10,
        maxEntries: 1000
      })
    });
    rootId = started.job?.rootId || started.root?.id || started.roots?.[0]?.id;
    assert(rootId, "Start response should include a root id.");
    const completedRoot = await waitForBackgroundComplete(baseUrl, rootId);
    assert(completedRoot.search?.count >= 4, "Initial search store should include fixture files.");
    assert(completedRoot.search?.contentIndexed >= 3, "Initial search store should include text content.");

    const beforeName = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "persistent-needle-report", rootId, limit: "20" })}`
    );
    const beforeLabel = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "aurora ledger", rootId, limit: "20" })}`
    );
    const beforeContent = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "obsidian invoice", rootId, limit: "20" })}`
    );
    assertHit(beforeName, fixture.filenamePath, "Before restart filename search");
    assertHit(beforeLabel, fixture.labelledPath, "Before restart label search");
    assertHit(beforeContent, fixture.contentPath, "Before restart content search");
    before = {
      overview: completedRoot,
      nameTiming: beforeName.timing,
      labelTiming: beforeLabel.timing,
      contentTiming: beforeContent.timing
    };

    await stopServer(server);
    server = startServer(port);
    await waitForServer(baseUrl, server);

    const overview = await requestJson(baseUrl, "/api/background-indexes");
    const restoredRoot = overview.roots.find((item) => item.id === rootId);
    assert(restoredRoot, "Restarted server should reload saved background index root.");
    assert(!restoredRoot.job, "Restarted server should not need a running job to use the warm search store.");
    assert(restoredRoot.search?.count >= 4, "Restarted overview should attach persisted search-store summary.");
    assert(restoredRoot.search?.contentIndexed >= 3, "Restarted overview should preserve content-index summary.");

    const afterName = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "persistent-needle-report", rootId, limit: "20" })}`
    );
    const afterLabel = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "aurora ledger", rootId, limit: "20" })}`
    );
    const afterContent = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "obsidian invoice", rootId, limit: "20" })}`
    );
    assertHit(afterName, fixture.filenamePath, "After restart filename search");
    assertHit(afterLabel, fixture.labelledPath, "After restart label search");
    assertHit(afterContent, fixture.contentPath, "After restart content search");
    assert(afterContent.results.find((item) => item.path === fixture.contentPath)?.matchSource === "content", "After restart content hit should report matchSource=content.");
    assert(/obsidian invoice/i.test(afterContent.results.find((item) => item.path === fixture.contentPath)?.matchSnippet || ""), "After restart content hit should preserve a snippet.");
    after = {
      overview: restoredRoot,
      nameTiming: afterName.timing,
      labelTiming: afterLabel.timing,
      contentTiming: afterContent.timing
    };

    const outputPath = path.join(artifactsDir, "background-index-restart-latest.json");
    await fs.writeFile(
      outputPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          fixtureRoot,
          rootId,
          before,
          after,
          paths: fixture
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`background root: ${rootId}`);
    console.log(`after restart name search: ${after.nameTiming.searchMs} ms`);
    console.log(`after restart label search: ${after.labelTiming.searchMs} ms`);
    console.log(`after restart content search: ${after.contentTiming.searchMs} ms`);
    console.log(`wrote ${outputPath}`);
  } finally {
    await stopServer(server);
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (serverOutput) {
    console.error(serverOutput);
  }
  process.exitCode = 1;
});
