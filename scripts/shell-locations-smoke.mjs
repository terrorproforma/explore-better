import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `shell-locations-${stamp}`);
const fixture = path.join(runRoot, "fixture");
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
  return process.argv.includes("--keep-fixture") || process.env.EB_SHELL_KEEP_FIXTURE === "1";
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

async function expectFailure(promise, expectedStatus, message) {
  try {
    await promise;
  } catch (error) {
    assert(error.status === expectedStatus, `${message}: expected ${expectedStatus}, got ${error.status || error}`);
    return error;
  }
  throw new Error(`${message}: request unexpectedly succeeded`);
}

async function prepareFixture() {
  const libraryTarget = path.join(fixture, "Media Target");
  const librariesDir = path.join(appData, "Microsoft", "Windows", "Libraries");
  await fs.mkdir(libraryTarget, { recursive: true });
  await fs.mkdir(librariesDir, { recursive: true });
  await fs.mkdir(path.join(stateDir, "Trash"), { recursive: true });
  await fs.writeFile(path.join(libraryTarget, "inside-library.txt"), "library smoke\n", "utf8");
  const libraryXml = `<?xml version="1.0" encoding="UTF-8"?>
<libraryDescription>
  <name>Smoke Library</name>
  <searchConnectorDescriptionList>
    <searchConnectorDescription>
      <simpleLocation>
        <url>${pathToFileURL(libraryTarget).href}</url>
      </simpleLocation>
    </searchConnectorDescription>
  </searchConnectorDescriptionList>
</libraryDescription>`;
  await fs.writeFile(path.join(librariesDir, "Smoke Library.library-ms"), libraryXml, "utf8");
  return { libraryTarget };
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  const prepared = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 56000 + Math.floor(Math.random() * 4000)));
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
    const locations = await requestJson(baseUrl, "/api/shell/locations");
    assert(locations.platform === process.platform, "Shell API should report the current platform.");
    assert(Array.isArray(locations.specialFolders), "Shell API should include specialFolders.");
    assert(Array.isArray(locations.virtualFolders), "Shell API should include virtualFolders.");
    assert(Array.isArray(locations.navigation), "Shell API should include navigation rows.");

    const specialIds = new Set(locations.specialFolders.map((item) => item.id));
    assert(specialIds.has("home"), "Special folders should include Home.");
    assert(specialIds.has("appTrash"), "Special folders should include App Trash when the app trash path exists.");

    const virtualIds = new Set(locations.virtualFolders.map((item) => item.id));
    for (const id of ["thisPc", "libraries", "network", "recycleBin"]) {
      assert(virtualIds.has(id), `Virtual shell folders should include ${id}.`);
      const dryRun = await requestJson(baseUrl, "/api/shell/open", {
        method: "POST",
        body: JSON.stringify({ id, dryRun: true })
      });
      assert(dryRun.ok === true && dryRun.dryRun === true, `${id} dry-run should validate.`);
      assert(typeof dryRun.target === "string" && dryRun.target.startsWith("shell:"), `${id} should validate a shell target.`);
    }

    const smokeLibrary = locations.libraries.find((item) => item.name === "Smoke Library");
    if (process.platform === "win32") {
      assert(smokeLibrary, "Windows library discovery should find the seeded Smoke Library.");
      assert(smokeLibrary.path === prepared.libraryTarget, "Library discovery should expose the first real target folder.");
      const dryRun = await requestJson(baseUrl, "/api/shell/open", {
        method: "POST",
        body: JSON.stringify({ id: smokeLibrary.id, dryRun: true })
      });
      assert(dryRun.ok === true && dryRun.target.endsWith(".library-ms"), "Library dry-run should validate its library-ms file.");
    }

    await expectFailure(
      requestJson(baseUrl, "/api/shell/open", {
        method: "POST",
        body: JSON.stringify({ id: "not-allowed", dryRun: true })
      }),
      400,
      "Unknown shell IDs"
    );

    const outputPath = path.join(artifactsDir, "shell-locations-latest.json");
    await fs.writeFile(
      outputPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          platform: locations.platform,
          virtualFolders: locations.virtualFolders.map((item) => item.id),
          specialFolders: locations.specialFolders.map((item) => item.id),
          libraries: locations.libraries.map((item) => ({ id: item.id, name: item.name, path: item.path })),
          navigationCount: locations.navigation.length
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`virtual folders: ${locations.virtualFolders.map((item) => item.id).join(", ")}`);
    console.log(`special folders: ${locations.specialFolders.length}`);
    console.log(`libraries: ${locations.libraries.length}`);
    console.log(`navigation rows: ${locations.navigation.length}`);
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
