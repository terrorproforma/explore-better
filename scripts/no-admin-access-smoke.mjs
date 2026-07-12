import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `no-admin-access-${stamp}`);
const fakeHome = path.join(runRoot, "user");
const appData = path.join(runRoot, "appdata");
const latestJsonPath = path.join(artifactsDir, "no-admin-access-latest.json");
const latestMdPath = path.join(artifactsDir, "no-admin-access-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function check(checks, id, ok, detail) {
  checks.push({ id, status: ok ? "pass" : "fail", detail });
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
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function waitForServer(baseUrl, child, getOutput) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${getOutput()}`);
    }
    try {
      await requestJson(baseUrl, "/api/roots");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error(`Server did not start at ${baseUrl}: ${getOutput()}`);
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
  await fs.mkdir(path.join(fakeHome, "Documents"), { recursive: true });
  await fs.mkdir(path.join(fakeHome, "Videos"), { recursive: true });
  await fs.writeFile(path.join(fakeHome, "Videos", "normal-user-video.txt"), "redirected without admin\n", "utf8");
  await fs.mkdir(appData, { recursive: true });
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${item.id} | ${String(item.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# No-Admin Access Smoke

Generated: ${report.generatedAt}

Summary: ${report.summary.pass} pass, ${report.summary.fail} fail.

| Status | Check | Detail |
| --- | --- | --- |
${rows}
`;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 50000 + Math.floor(Math.random() * 9000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const legacyVideosPath = path.join(fakeHome, "Documents", "My Videos");
  const expectedVideosPath = path.join(fakeHome, "Videos");
  const checks = [];
  let serverOutput = "";
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      LOCALAPPDATA: appData,
      APPDATA: appData
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  let listing = null;
  let analysis = null;
  try {
    await waitForServer(baseUrl, server, () => serverOutput);
    listing = await requestJson(baseUrl, `/api/list?path=${encodeURIComponent(legacyVideosPath)}`);
    analysis = await requestJson(baseUrl, "/api/size-analysis", {
      method: "POST",
      body: JSON.stringify({ path: legacyVideosPath, maxEntries: 1000 })
    });

    check(checks, "legacy-folder-listing-status", listing.path === expectedVideosPath, `listed ${listing.path}`);
    check(checks, "legacy-folder-redirect-note", listing.redirectedFrom === legacyVideosPath, `redirectedFrom ${listing.redirectedFrom}`);
    check(checks, "legacy-folder-no-access-error", !listing.accessError, listing.accessError?.message || "no access error");
    check(
      checks,
      "legacy-folder-entry-visible",
      (listing.entries || []).some((entry) => entry.name === "normal-user-video.txt"),
      `${(listing.entries || []).length} entries`
    );
    check(checks, "analyzer-redirect-status", analysis.path === expectedVideosPath, `analyzed ${analysis.path}`);
    check(checks, "analyzer-no-access-error", !analysis.accessError, analysis.accessError?.message || "no access error");
    check(checks, "analyzer-bytes", Number(analysis.summary?.bytes || 0) > 0, `${analysis.summary?.bytes || 0} bytes`);
  } catch (error) {
    check(checks, "smoke-execution", false, error.message);
  } finally {
    await stopServer(server);
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }

  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    fail: checks.filter((item) => item.status === "fail").length
  };
  const report = {
    generatedAt: new Date().toISOString(),
    status: summary.fail ? "fail" : "pass",
    baseUrl,
    legacyVideosPath,
    expectedVideosPath,
    listing,
    analysis,
    serverOutput: serverOutput.slice(-4000),
    checks,
    summary
  };
  await fs.writeFile(latestJsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(latestMdPath, markdownReport(report));
  console.log(`no-admin access smoke: ${summary.pass} pass, ${summary.fail} fail`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (summary.fail > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
