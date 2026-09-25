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
    for (const chunk of body === undefined ? [] : [].concat(body)) request.write(chunk);
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

function rawRequestStatus({ port, method = "GET", requestPath = "/", headers = {}, body }) {
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
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function spawnServer({ port, appData, output, env = {} }) {
  const child = spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      LOCALAPPDATA: appData,
      EXPLORE_BETTER_DISABLE_STATE_WATCH: "1",
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  return child;
}

async function main() {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "explore-better-security-"));
  const appData = path.join(fixture, "AppData");
  const target = path.join(fixture, "target");
  await fs.mkdir(target, { recursive: true });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const capability = "security-smoke-capability-0123456789abcdef";
  const output = [];
  const child = spawnServer({
    port,
    appData,
    output,
    env: { EXPLORE_BETTER_API_CAPABILITY: capability, EXPLORE_BETTER_REQUIRE_API_CAPABILITY: "1" }
  });
  let standaloneChild = null;

  const checks = [];
  const check = (name, pass, details = {}) => checks.push({ name, pass: Boolean(pass), ...details });
  try {
    const uiResponse = await waitForUi(baseUrl);
    check("Desktop-mode UI does not hand out the launch capability cookie", uiResponse.headers["set-cookie"] === undefined);
    const cookie = `ExploreBetterCapability=${capability}`;
    check("CSP blocks untrusted script sources", String(uiResponse.headers["content-security-policy"] || "").includes("script-src 'self'"));
    check("CSP blocks form submissions", String(uiResponse.headers["content-security-policy"] || "").includes("form-action 'none'"));

    const absoluteFormName = "absolute-form.txt";
    const absoluteForm = await rawRequestStatus({ port, method: "POST",
      requestPath: `${baseUrl}/api/file/create`,
      headers: { host: `127.0.0.1:${port}`, "content-type": "text/plain" },
      body: JSON.stringify({ path: target, name: absoluteFormName })
    });
    check("Absolute-form request target is rejected", absoluteForm === 400, { status: absoluteForm });
    check("Absolute-form request produced no mutation", !(await fs.stat(path.join(target, absoluteFormName)).then(() => true).catch(() => false)));
    for (const requestPath of ["//evil.example/api/roots", "/\\evil.example/api/roots"]) {
      const status = await rawRequestStatus({ port, requestPath, headers: { host: `127.0.0.1:${port}` } });
      check(`Authority-shaped request target ${JSON.stringify(requestPath)} is rejected`, status === 400, { status });
    }
    const dotSegments = await rawRequestStatus({ port, requestPath: "/static/../api/roots", headers: { host: `127.0.0.1:${port}` } });
    check("Dot-segment API path still requires the launch capability", dotSegments === 403, { status: dotSegments });

    const wrongCapability = await httpRequest({ baseUrl, requestPath: "/api/roots",
      headers: { "x-explore-better-capability": `${capability.slice(0, -1)}x` } });
    check("Wrong launch capability is rejected", wrongCapability.status === 403, { status: wrongCapability.status });
    const headerCapability = await httpRequest({ baseUrl, requestPath: "/api/roots",
      headers: { "x-explore-better-capability": capability } });
    check("Launch capability header is accepted", headerCapability.status === 200, { status: headerCapability.status });
    check("JSON API responses disable content sniffing", headerCapability.headers["x-content-type-options"] === "nosniff");

    const malformed = await httpRequest({ baseUrl, requestPath: "/api/file/create",
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{\"path\":"
    });
    check("Malformed JSON body is rejected with 400", malformed.status === 400, { status: malformed.status });

    const unicodeName = "unicode-multichunk.txt";
    const unicodeContent = "漢字テスト😀".repeat(20_000);
    const unicodeBody = Buffer.from(JSON.stringify({ path: target, name: unicodeName, content: unicodeContent }));
    const unicode = await httpRequest({ baseUrl, requestPath: "/api/file/create",
      method: "POST",
      headers: { "content-type": "application/json", cookie, "content-length": unicodeBody.length },
      body: [unicodeBody.subarray(0, 65_537), unicodeBody.subarray(65_537, 131_075), unicodeBody.subarray(131_075)],
      timeoutMs: 10_000
    });
    check("Multi-chunk UTF-8 body is accepted", unicode.status === 200, { status: unicode.status });
    check("Multi-chunk UTF-8 body round-trips byte-for-byte",
      unicodeBody.length > 200_000 && (await fs.readFile(path.join(target, unicodeName), "utf8").catch(() => "")) === unicodeContent);

    const scriptSource = path.join(target, "payload.js");
    await fs.writeFile(scriptSource, "window.pwned = true;\n");
    const rawPath = `/api/raw?path=${encodeURIComponent(scriptSource)}`;
    const rawScript = await httpRequest({ baseUrl, requestPath: rawPath, headers: { cookie } });
    check("Raw JavaScript is served as plain text", rawScript.status === 200 && String(rawScript.headers["content-type"]).startsWith("text/plain"), { status: rawScript.status });
    const rawAsScript = await httpRequest({ baseUrl, requestPath: rawPath, headers: { cookie, "sec-fetch-dest": "script", "sec-fetch-site": "same-origin" } });
    check("Raw files cannot be loaded as scripts", rawAsScript.status === 403, { status: rawAsScript.status });
    const rawAsStyle = await httpRequest({ baseUrl, requestPath: rawPath, headers: { cookie, "sec-fetch-dest": "style", "sec-fetch-site": "same-origin" } });
    check("Raw files cannot be loaded as stylesheets", rawAsStyle.status === 403, { status: rawAsStyle.status });
    const rawAsImage = await httpRequest({ baseUrl, requestPath: rawPath, headers: { cookie, "sec-fetch-dest": "image", "sec-fetch-site": "same-origin" } });
    check("Raw files still load as images/media", rawAsImage.status === 200, { status: rawAsImage.status });
    const rawRange = await httpRequest({ baseUrl, requestPath: rawPath, headers: { cookie, range: "bytes=0-5" } });
    check("Raw range requests still stream", rawRange.status === 206, { status: rawRange.status });

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

    const directMissingCapability = await httpRequest({ baseUrl, requestPath: "/api/roots" });
    check("Production direct-loopback request without launch capability is rejected", directMissingCapability.status === 403, { status: directMissingCapability.status });

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

    const largeRaw = path.join(target, "large.bin");
    await fs.writeFile(largeRaw, Buffer.alloc(8 * 1024 * 1024, 7));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => {
        const request = http.get(new URL(`/api/raw?path=${encodeURIComponent(largeRaw)}`, baseUrl), { headers: { cookie }, agent: false }, (response) => {
          response.once("data", () => { request.destroy(); resolve(); });
          response.once("end", resolve);
        });
        request.once("error", resolve);
      });
    }
    await fs.rm(largeRaw, { maxRetries: 10, retryDelay: 100 });
    const afterAbort = await httpRequest({ baseUrl, requestPath: "/api/roots", headers: { cookie } });
    check("Aborted raw streams release the file and keep the server alive",
      afterAbort.status === 200 && !(await fs.stat(largeRaw).then(() => true).catch(() => false)), { status: afterAbort.status });

    const standalonePort = await freePort();
    const standaloneUrl = `http://127.0.0.1:${standalonePort}`;
    standaloneChild = spawnServer({
      port: standalonePort,
      appData: path.join(fixture, "StandaloneAppData"),
      output,
      env: { EXPLORE_BETTER_API_CAPABILITY: "", EXPLORE_BETTER_REQUIRE_API_CAPABILITY: "" }
    });
    const standaloneUi = await waitForUi(standaloneUrl);
    const standaloneCookie = String(standaloneUi.headers["set-cookie"] || "").split(";", 1)[0];
    check("Standalone UI still issues a launch capability cookie", standaloneCookie.startsWith("ExploreBetterCapability="));
    const standaloneBrowser = await httpRequest({ baseUrl: standaloneUrl, requestPath: "/api/roots",
      headers: { cookie: standaloneCookie, "sec-fetch-site": "same-origin" } });
    check("Standalone browser request with the issued cookie succeeds", standaloneBrowser.status === 200, { status: standaloneBrowser.status });
  } catch (error) {
    error.serverOutput = output.join("").trim().slice(-4000);
    throw error;
  } finally {
    await stopTree(child);
    await stopTree(standaloneChild);
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
