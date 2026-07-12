import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `background-index-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
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
  return process.argv.includes("--keep-fixture") || process.env.EB_BACKGROUND_INDEX_KEEP_FIXTURE === "1";
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
      throw new Error(`Server exited early with ${child.exitCode}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}`);
}

async function waitForBackgroundComplete(baseUrl, rootId) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const overview = await requestJson(baseUrl, "/api/background-indexes");
    const root = overview.roots.find((item) => item.id === rootId);
    assert(root, "Background root should remain registered.");
    if (root.job?.status === "error") {
      throw new Error(root.job.error || "Background index failed.");
    }
    if (!root.job || ["complete", "canceled"].includes(root.job.status)) {
      return root;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Background index did not complete in time.");
}

async function prepareFixture() {
  const nested = path.join(fixtureRoot, "nested");
  await fs.mkdir(nested, { recursive: true });
  const labelledPath = path.join(nested, "plain.txt");
  const filenamePath = path.join(nested, "needle-report.log");
  const contentPath = path.join(nested, "content-only.md");
  await fs.writeFile(path.join(fixtureRoot, "root-file.txt"), "root\n");
  await fs.writeFile(labelledPath, "ordinary name\n");
  await fs.writeFile(filenamePath, "needle by name\n");
  await fs.writeFile(contentPath, "This file has a quiet phrase: chrysanthemum invoice.\n");
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
            name: "Indexed",
            color: "teal",
            notes: "volcano ledger"
          }
        ],
        operations: []
      },
      null,
      2
    ),
    "utf8"
  );
  return { nested, labelledPath, filenamePath, contentPath };
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const fixture = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 52000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

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
    const rootId = started.job?.rootId || started.root?.id || started.roots?.[0]?.id;
    assert(rootId, "Start response should include a background root id.");
    const root = await waitForBackgroundComplete(baseUrl, rootId);
    assert(root.search?.folders >= 2 || root.lastStats?.folders >= 2, "Recursive index should include nested folders.");
    assert(root.search?.count >= 3 || root.lastStats?.count >= 3, "Background index should include fixture files.");
    assert(root.search?.contentIndexed >= 3 || root.lastStats?.contentIndexed >= 3, "Background index should include text content.");

    const nameSearch = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "needle-report", limit: "20" })}`
    );
    assert(nameSearch.indexed === true, "Background search should report indexed=true.");
    assert(
      nameSearch.results.some((item) => item.path === fixture.filenamePath),
      "Background search should find nested files by filename."
    );

    const labelSearch = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "volcano ledger", limit: "20" })}`
    );
    assert(
      labelSearch.results.some((item) => item.path === fixture.labelledPath),
      "Background search should find files by saved label notes."
    );

    const contentSearch = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ q: "chrysanthemum invoice", limit: "20" })}`
    );
    const contentResult = contentSearch.results.find((item) => item.path === fixture.contentPath);
    assert(contentResult, "Background search should find files by indexed text content.");
    assert(contentResult.matchSource === "content", "Content matches should report matchSource=content.");
    assert(/chrysanthemum invoice/i.test(contentResult.matchSnippet || ""), "Content matches should include a snippet.");

    const outputPath = path.join(artifactsDir, "background-index-latest.json");
    await fs.writeFile(
      outputPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          fixtureRoot,
          root: {
            id: root.id,
            path: root.path,
            search: root.search,
            lastStats: root.lastStats
          },
          nameSearch: nameSearch.timing,
          labelSearch: labelSearch.timing,
          contentSearch: contentSearch.timing
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`background root: ${root.path}`);
    console.log(`indexed folders: ${root.search?.folders || root.lastStats?.folders || 0}`);
    console.log(`indexed entries: ${root.search?.count || root.lastStats?.count || 0}`);
    console.log(`name search: ${nameSearch.timing.searchMs} ms / ${nameSearch.results.length} result(s)`);
    console.log(`label search: ${labelSearch.timing.searchMs} ms / ${labelSearch.results.length} result(s)`);
    console.log(`content search: ${contentSearch.timing.searchMs} ms / ${contentSearch.results.length} result(s)`);
    console.log(`wrote ${outputPath}`);
  } finally {
    server.kill();
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(serverOutput);
  console.error(error);
  process.exitCode = 1;
});
