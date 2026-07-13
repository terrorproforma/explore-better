import http from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `release-update-feed-desktop-${stamp}`);
const appData = path.join(runRoot, "appdata");
const feedRoot = path.join(workspace, "dist", "update-feed");
const latestJsonPath = path.join(artifactsDir, "release-update-feed-desktop-latest.json");
const latestMdPath = path.join(artifactsDir, "release-update-feed-desktop-latest.md");

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_RELEASE_UPDATE_FEED_DESKTOP_KEEP_FIXTURE === "1";
}

function limitedAppend(current, chunk, limit = 42000) {
  const next = current + chunk.toString();
  return next.length <= limit ? next : next.slice(next.length - limit);
}

async function pathExists(itemPath) {
  try {
    await fs.access(itemPath);
    return true;
  } catch {
    return false;
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".yml" || ext === ".yaml") return "text/yaml; charset=utf-8";
  if (ext === ".exe" || ext === ".blockmap") return "application/octet-stream";
  return "text/plain; charset=utf-8";
}

async function startFeedServer(port) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    const relative = decodeURIComponent(url.pathname.replace(/^\/+/, "")) || "latest.yml";
    const filePath = path.join(feedRoot, relative);
    requests.push({ method: req.method, path: url.pathname, at: new Date().toISOString() });
    try {
      const data = await fs.readFile(filePath);
      res.writeHead(200, {
        "content-type": contentType(filePath),
        "content-length": data.length,
        "cache-control": "no-store"
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${listeningPort}/`,
    requests,
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

function runCommand(command, args, { timeoutMs = 90000, env = {} } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let stdout = "";
    let stderr = "";
    let settled = false;
    try {
      child = spawn(command, args, {
        cwd: workspace,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      resolve({ code: null, error: error.message, stdout, stderr });
      return;
    }
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = limitedAppend(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = limitedAppend(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code: null, error: error.message, stdout, stderr });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseUpdateCheck(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith("Explore Better update check:"));
  if (!line) return null;
  const data = {};
  for (const match of line.matchAll(/([A-Za-z]+)=([^ ]*)/g)) {
    data[match[1]] = match[2];
  }
  return {
    line,
    event: data.event || "",
    version: data.version || "",
    available: data.available === "true"
  };
}

function check(status, id, label, detail, data = {}) {
  return { status, id, label, detail, ...data };
}

function tableValue(value) {
  return String(value || "")
    .replaceAll("|", "\\|")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function markdownReport(report) {
  const rows = report.checks
    .map((item) => `| ${item.status.toUpperCase()} | ${tableValue(item.label)} | ${tableValue(item.detail)} |`)
    .join("\n");
  return `# Explore Better Release Update Feed Desktop Smoke

Generated: ${report.generatedAt}

Status: ${report.status}

Feed: \`${report.feed.url}\`

| Status | Check | Detail |
| --- | --- | --- |
${rows}

## Update Check

\`${report.updateCheck?.line || "missing"}\`

## Feed Requests

${report.feed.requests.map((request) => `- ${request.method} ${request.path}`).join("\n") || "- none"}
`;
}

async function main() {
  await fs.mkdir(appData, { recursive: true });
  await fs.mkdir(artifactsDir, { recursive: true });
  const pkg = JSON.parse(await fs.readFile(path.join(workspace, "package.json"), "utf8"));
  const configuredFeedPort = optionValue("--feed-port", process.env.EB_RELEASE_UPDATE_FEED_PORT || "");
  const configuredAppPort = optionValue("--app-port", process.env.PORT || "");
  const feedPort = configuredFeedPort ? Number(configuredFeedPort) : 0;
  const appPort = configuredAppPort ? Number(configuredAppPort) : await freeLoopbackPort();
  const latestYmlPath = path.join(feedRoot, "latest.yml");
  const latestYml = (await pathExists(latestYmlPath)) ? await fs.readFile(latestYmlPath, "utf8") : "";
  const feed = await startFeedServer(feedPort);
  const command = process.platform === "win32" ? "cmd.exe" : "npm";
  const args =
    process.platform === "win32" ? ["/d", "/s", "/c", "npm run desktop:smoke-update-feed"] : ["run", "desktop:smoke-update-feed"];
  let result = null;
  try {
    result = await runCommand(command, args, {
      timeoutMs: Number(optionValue("--timeout-ms", process.env.EB_RELEASE_UPDATE_FEED_TIMEOUT_MS || "90000")),
      env: {
        HOST: "127.0.0.1",
        PORT: String(appPort),
        LOCALAPPDATA: appData,
        APPDATA: appData,
        EXPLORE_BETTER_USER_DATA_DIR: path.join(appData, "ElectronUserData"),
        EXPLORE_BETTER_UPDATE_URL: feed.url,
        EXPLORE_BETTER_FORCE_DEV_UPDATE_CONFIG: "1",
        EXPLORE_BETTER_UPDATE_EXPECTED_EVENT: "not-available"
      }
    });
  } finally {
    await feed.close();
  }
  const updateCheck = parseUpdateCheck(result.stdout);
  const checks = [];
  checks.push(
    check(
      latestYml.includes(`version: ${pkg.version}`) && latestYml.includes("sha512:") ? "pass" : "fail",
      "generated-feed-present",
      "Generated release feed is present",
      latestYml ? `latest.yml for ${pkg.version}.` : "Missing dist/update-feed/latest.yml."
    )
  );
  checks.push(
    check(
      result.code === 0 && !result.timedOut && !result.error ? "pass" : "fail",
      "desktop-release-feed-smoke-exit",
      "Desktop release-feed smoke exits cleanly",
      result.timedOut ? "Timed out." : result.error || `Exit ${result.code}.`
    )
  );
  checks.push(
    check(
      result.stdout.includes("Explore Better update bridge: configured") ? "pass" : "fail",
      "release-feed-bridge-configured",
      "Update bridge sees generated release feed",
      result.stdout.includes("Explore Better update bridge: configured") ? "Bridge configured." : "Missing configured bridge output."
    )
  );
  checks.push(
    check(
      updateCheck?.event === "not-available" && updateCheck?.version === pkg.version && updateCheck?.available === false ? "pass" : "fail",
      "release-feed-not-available",
      "Generated release feed reports current version as not available",
      updateCheck ? `event=${updateCheck.event}, version=${updateCheck.version}, available=${updateCheck.available}` : "Missing update check line."
    )
  );
  checks.push(
    check(
      feed.requests.some((request) => request.path === "/latest.yml") ? "pass" : "fail",
      "release-feed-requested-latest",
      "Updater requested generated latest.yml",
      feed.requests.map((request) => request.path).join(", ") || "No requests."
    )
  );
  const failures = checks.filter((item) => item.status === "fail");
  const report = {
    generatedAt: new Date().toISOString(),
    workspace,
    runRoot,
    appData,
    status: failures.length ? "fail" : "pass",
    command,
    args,
    feed: {
      url: feed.url,
      root: feedRoot,
      expectedVersion: pkg.version,
      requests: feed.requests
    },
    checks,
    updateCheck,
    result: {
      code: result.code,
      timedOut: Boolean(result.timedOut),
      error: result.error || null,
      stdout: result.stdout,
      stderr: result.stderr
    }
  };
  await fs.writeFile(latestJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(latestMdPath, markdownReport(report), "utf8");
  if (!keepFixture()) {
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
  console.log(`release update feed desktop smoke: ${report.status} (${checks.length - failures.length}/${checks.length} checks passed)`);
  console.log(`wrote ${latestJsonPath}`);
  console.log(`wrote ${latestMdPath}`);
  if (failures.length) {
    console.error(`failures: ${failures.map((item) => `${item.id}: ${item.detail}`).join("; ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
