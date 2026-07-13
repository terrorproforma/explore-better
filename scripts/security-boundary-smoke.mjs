import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
  });
}

async function waitForUi(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await httpRequest({ baseUrl, timeoutMs: 1500 });
      if (response.status >= 200 && response.status < 300) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${lastError?.message || "timeout"}`);
}

function httpRequest({ baseUrl, method = "GET", requestPath = "/", headers = {}, body, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      new URL(requestPath, baseUrl),
      { method, headers, agent: false },
      (response) => {
        response.resume();
        response.once("end", () => resolve({ status: response.statusCode, headers: response.headers }));
      }
    );
    request.once("error", reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`HTTP ${method} ${requestPath} timed out.`)));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
}

function rawRequestStatus({ port, method = "GET", requestPath = "/", headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { hostname: "127.0.0.1", port, method, path: requestPath, headers },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      }
    );
    request.once("error", reject);
    request.setTimeout(3000, () => request.destroy(new Error("Raw HTTP probe timed out.")));
    request.end();
  });
}

async function main() {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "explore-better-security-"));
  const appData = path.join(fixture, "AppData");
  const target = path.join(fixture, "target");
  await fs.mkdir(target, { recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      EXPLORE_BETTER_DISABLE_STATE_WATCH: "1"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  const checks = [];
  const check = (name, pass, details = {}) => checks.push({ name, pass: Boolean(pass), ...details });
  try {
    const uiResponse = await waitForUi(baseUrl);
    const cookie = String(uiResponse.headers["set-cookie"] || "").split(";", 1)[0];
    check("UI issues a launch capability cookie", cookie.startsWith("ExploreBetterCapability="));
    check("CSP blocks untrusted script sources", String(uiResponse.headers["content-security-policy"] || "").includes("script-src 'self'"));

    const hostileName = "hostile-origin.txt";
    const hostile = await httpRequest({ baseUrl, requestPath: "/api/file/create",
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ path: target, name: hostileName })
    });
    check("Hostile-origin text/plain mutation is rejected", hostile.status === 403, { status: hostile.status });
    check("Hostile-origin request produced no mutation", !(await fs.stat(path.join(target, hostileName)).then(() => true).catch(() => false)));

    const missingCapability = await httpRequest({ baseUrl, requestPath: "/api/file/create",
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ path: target, name: "missing-capability.txt" })
    });
    check("Browser request without launch capability is rejected", missingCapability.status === 403, { status: missingCapability.status });

    const authorizedName = "authorized.txt";
    const authorized = await httpRequest({ baseUrl, requestPath: "/api/file/create",
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: baseUrl,
        "sec-fetch-site": "same-origin"
      },
      body: JSON.stringify({ path: target, name: authorizedName, content: "authorized" })
    });
    check("Same-origin capability mutation succeeds", authorized.status === 200, { status: authorized.status });
    check("Authorized mutation created the expected bytes", (await fs.readFile(path.join(target, authorizedName), "utf8")) === "authorized");

    const missingApplyToken = await httpRequest({ baseUrl, requestPath: "/api/transfer",
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: baseUrl, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ paths: [path.join(target, authorizedName)], targetDir: target, mode: "move", conflictMode: "unique" })
    });
    check("Browser transfer without a current preview token is rejected", missingApplyToken.status === 403, { status: missingApplyToken.status });

    const badHostStatus = await rawRequestStatus({ port, requestPath: "/api/roots", headers: { host: `evil.example:${port}` } });
    check("Invalid Host header is rejected", badHostStatus === 403, { status: badHostStatus });

    const unsupported = await httpRequest({ baseUrl, requestPath: "/api/roots", method: "PUT" });
    check("Unsupported API method is rejected before dispatch", unsupported.status === 405, { status: unsupported.status });
  } catch (error) {
    error.serverOutput = output.join("").trim().slice(-4000);
    throw error;
  } finally {
    await stopTree(child);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    checks,
    summary: {
      passed: checks.filter((item) => item.pass).length,
      failed: checks.filter((item) => !item.pass).length
    },
    serverOutput: output.join("").trim().slice(-4000)
  };
  const artifactDir = path.join(root, "artifacts");
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, "security-boundary-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const item of checks) {
    console.log(`${item.pass ? "PASS" : "FAIL"} ${item.name}${item.status ? ` (${item.status})` : ""}`);
  }
  console.log(`Security boundary: ${report.summary.passed} pass, ${report.summary.failed} fail`);
  if (report.summary.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (error.serverOutput) console.error(`Server output:\n${error.serverOutput}`);
  process.exitCode = 1;
});
