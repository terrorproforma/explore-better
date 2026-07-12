import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `shell-verbs-${stamp}`);
const fixture = path.join(runRoot, "fixture");
const appData = path.join(runRoot, "appdata");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_SHELL_VERBS_KEEP_FIXTURE === "1";
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

async function prepareFixture() {
  await fs.mkdir(fixture, { recursive: true });
  const filePath = path.join(fixture, "shell-verb-target.txt");
  await fs.writeFile(filePath, "shell verb smoke\n", "utf8");
  return { filePath };
}

function preferredDryRunVerb(verbs) {
  return (
    verbs.find((item) => item.canonical === "properties") ||
    verbs.find((item) => item.canonical === "open") ||
    verbs.find((item) => !item.isDangerous) ||
    verbs[0]
  );
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const prepared = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 57500 + Math.floor(Math.random() * 4500)));
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
    const verbs = await requestJson(
      baseUrl,
      `/api/shell/verbs?${new URLSearchParams({ path: prepared.filePath })}`
    );
    assert(verbs.platform === process.platform, "Shell verb API should report the current platform.");
    if (process.platform === "win32") {
      assert(verbs.available === true, "Shell verbs should be available on Windows.");
      assert(verbs.path === prepared.filePath, "Shell verb list should resolve the requested file.");
      assert(verbs.targetKind === "file", "Shell verb target should be reported as a file.");
      assert(Array.isArray(verbs.verbs) && verbs.verbs.length > 0, "Windows file should expose at least one shell verb.");
      assert(
        verbs.verbs.every((item) => item.id && item.name && Number.isFinite(Number(item.rawIndex))),
        "Shell verbs should include stable id, name, and raw index."
      );
      const verb = preferredDryRunVerb(verbs.verbs);
      const dryRun = await requestJson(baseUrl, "/api/shell/verb", {
        method: "POST",
        body: JSON.stringify({
          path: prepared.filePath,
          verbId: verb.id,
          verbName: verb.name,
          dryRun: true
        })
      });
      assert(dryRun.ok === true, "Dry-run shell verb invocation should return ok.");
      assert(dryRun.dryRun === true && dryRun.invoked === false, "Dry run should not invoke the shell verb.");
      assert(dryRun.verb?.name === verb.name, "Dry-run response should echo the selected verb.");
    } else {
      assert(verbs.available === false, "Non-Windows shell verbs should report unavailable.");
      assert(Array.isArray(verbs.verbs) && verbs.verbs.length === 0, "Non-Windows shell verbs should be empty.");
    }

    const output = {
      generatedAt: new Date().toISOString(),
      fixture,
      filePath: prepared.filePath,
      verbs
    };
    const outputPath = path.join(artifactsDir, "shell-verbs-latest.json");
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
    console.log(`wrote ${outputPath}`);
    console.log("shell verbs smoke passed");
  } finally {
    if (server.exitCode === null) {
      server.kill();
    }
    if (!keepFixture()) {
      await fs.rm(runRoot, { recursive: true, force: true });
    } else {
      console.log(`kept fixture at ${runRoot}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  if (serverOutput) {
    console.error(serverOutput);
  }
  process.exitCode = 1;
});
