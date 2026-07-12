import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `shell-namespace-${stamp}`);
const appData = path.join(runRoot, "appdata");
const stateDir = path.join(appData, "ExploreBetter");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_SHELL_NAMESPACE_KEEP_FIXTURE === "1";
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

async function readNamespace(baseUrl, target, limit = 20) {
  const params = new URLSearchParams({ target, limit: String(limit) });
  const started = performance.now();
  const report = await requestJson(baseUrl, `/api/shell/namespace?${params}`);
  return { ...report, elapsedMs: Math.round(performance.now() - started) };
}

async function main() {
  await fs.mkdir(stateDir, { recursive: true });
  const port = Number(optionValue("--port", process.env.PORT || 56000 + Math.floor(Math.random() * 4000)));
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

  try {
    await waitForServer(baseUrl, server);
    const thisPc = await readNamespace(baseUrl, "thisPc", 32);
    assert(thisPc.platform === process.platform, "Shell namespace API should report the current platform.");
    assert(Array.isArray(thisPc.items), "This PC namespace should return an items array.");

    const output = {
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      namespaces: {
        thisPc: {
          available: thisPc.available,
          target: thisPc.target,
          count: thisPc.items.length,
          total: thisPc.total,
          truncated: thisPc.truncated,
          elapsedMs: thisPc.elapsedMs,
          sample: thisPc.items.slice(0, 6).map((item) => ({
            name: item.name,
            path: item.path,
            kind: item.kind,
            canBrowse: item.canBrowse,
            canOpenPane: item.canOpenPane
          }))
        }
      }
    };

    if (process.platform !== "win32") {
      assert(thisPc.available === false, "Non-Windows platforms should mark shell namespaces unavailable.");
    } else {
      assert(thisPc.available === true, `Windows should expose the This PC shell namespace: ${thisPc.reason || "unavailable"}`);
      assert(thisPc.target === "shell:MyComputerFolder", "This PC should resolve to shell:MyComputerFolder.");
      assert(thisPc.items.length > 0, "This PC should contain at least one shell item.");
      assert(
        thisPc.items.some((item) => item.canOpenPane && item.isFileSystem && item.path),
        "This PC should include at least one filesystem-backed item that can open in a pane."
      );
      const openable = thisPc.items.find((item) => item.canOpen && (item.openTarget || item.path));
      assert(openable, "This PC should include at least one item that can be dry-run opened.");
      const dryRun = await requestJson(baseUrl, "/api/shell/namespace/open", {
        method: "POST",
        body: JSON.stringify({ target: openable.openTarget || openable.path, dryRun: true })
      });
      assert(dryRun.ok === true && dryRun.dryRun === true, "Shell namespace dry-run open should validate.");
      assert(dryRun.target === (openable.openTarget || openable.path), "Dry-run should preserve the selected target.");

      const network = await readNamespace(baseUrl, "network", 12);
      assert(Array.isArray(network.items), "Network namespace should return an items array even when empty.");
      assert(network.elapsedMs < 5000, `Network namespace should be bounded under 5s, got ${network.elapsedMs}ms.`);
      const networkWarm = await readNamespace(baseUrl, "network", 12);
      assert(networkWarm.cached === true, "Second Network namespace read should come from the short-lived cache.");
      assert(networkWarm.elapsedMs < 750, `Cached Network namespace read should be fast, got ${networkWarm.elapsedMs}ms.`);
      output.namespaces.network = {
        available: network.available,
        reason: network.reason,
        target: network.target,
        count: network.items.length,
        total: network.total,
        truncated: network.truncated,
        elapsedMs: network.elapsedMs,
        warmElapsedMs: networkWarm.elapsedMs,
        warmCached: networkWarm.cached === true,
        sample: network.items.slice(0, 6).map((item) => ({ name: item.name, path: item.path, kind: item.kind }))
      };

      const libraries = await readNamespace(baseUrl, "libraries", 12);
      assert(Array.isArray(libraries.items), "Libraries namespace should return an items array even when empty.");
      const librariesWarm = await readNamespace(baseUrl, "libraries", 12);
      assert(librariesWarm.cached === true, "Second Libraries namespace read should come from the short-lived cache.");
      output.namespaces.libraries = {
        available: libraries.available,
        reason: libraries.reason,
        target: libraries.target,
        count: libraries.items.length,
        total: libraries.total,
        truncated: libraries.truncated,
        elapsedMs: libraries.elapsedMs,
        warmElapsedMs: librariesWarm.elapsedMs,
        warmCached: librariesWarm.cached === true,
        sample: libraries.items.slice(0, 6).map((item) => ({ name: item.name, path: item.path, kind: item.kind }))
      };
    }

    const outputPath = path.join(artifactsDir, "shell-namespace-latest.json");
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
    console.log(`This PC items: ${output.namespaces.thisPc.count}`);
    if (output.namespaces.network) console.log(`Network items: ${output.namespaces.network.count}`);
    if (output.namespaces.libraries) console.log(`Libraries items: ${output.namespaces.libraries.count}`);
    console.log(`wrote ${outputPath}`);
  } finally {
    server.kill();
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
