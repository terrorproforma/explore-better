import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `zip-browse-${stamp}`);
const sourceRoot = path.join(runRoot, "source");
const appData = path.join(runRoot, "appdata");
const zipPath = path.join(runRoot, "fixture.zip");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_ZIP_BROWSE_KEEP_FIXTURE === "1";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function psQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
      }
    });
  });
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
  await fs.mkdir(path.join(sourceRoot, "nested", "deep"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "root-file.txt"), "root file\n", "utf8");
  await fs.writeFile(path.join(sourceRoot, "spaced name.md"), "# spaced\n", "utf8");
  await fs.writeFile(path.join(sourceRoot, "nested", "inside.txt"), "inside\n", "utf8");
  await fs.writeFile(path.join(sourceRoot, "nested", "deep", "final.log"), "final\n", "utf8");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$source = ${psQuoted(sourceRoot)}`,
    `$dest = ${psQuoted(zipPath)}`,
    "Compress-Archive -Path (Join-Path -Path $source -ChildPath '*') -DestinationPath $dest -Force"
  ].join("; ");
  await runProcess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

function itemByName(listing, name) {
  return (listing.entries || []).find((entry) => entry.name === name);
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 59000 + Math.floor(Math.random() * 2500)));
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
    const root = await requestJson(
      baseUrl,
      `/api/archive/list?${new URLSearchParams({ path: zipPath, limit: "1000" })}`
    );
    assert(root.virtual === true && root.virtualType === "zip", "ZIP listing should report virtual zip mode.");
    assert(root.path.startsWith("zip://"), "ZIP root should expose a virtual path.");
    assert(root.parent === path.dirname(zipPath), "ZIP root parent should be the real containing folder.");
    const nested = itemByName(root, "nested");
    const rootFile = itemByName(root, "root-file.txt");
    const spaced = itemByName(root, "spaced name.md");
    assert(nested?.isDirectory, "ZIP root should include inferred nested folders.");
    assert(rootFile?.isFile && rootFile.kind === "Text", "ZIP root should include root files with kinds.");
    assert(spaced?.extension === ".md", "ZIP listing should preserve names with spaces.");
    assert(nested.path.startsWith("zip://") && nested.innerPath === "nested", "ZIP child folder should be virtual.");

    const nestedListing = await requestJson(
      baseUrl,
      `/api/archive/list?${new URLSearchParams({ path: zipPath, innerPath: "nested", limit: "1000" })}`
    );
    assert(nestedListing.parent === root.path, "Nested ZIP parent should point back to the ZIP root.");
    assert(itemByName(nestedListing, "inside.txt")?.isFile, "Nested ZIP folder should list direct files.");
    assert(itemByName(nestedListing, "deep")?.isDirectory, "Nested ZIP folder should list child folders.");

    const deepListing = await requestJson(
      baseUrl,
      `/api/archive/list?${new URLSearchParams({ path: zipPath, innerPath: "nested/deep", limit: "1000" })}`
    );
    assert(deepListing.parent === nested.path, "Deep ZIP parent should point to the nested virtual folder.");
    assert(itemByName(deepListing, "final.log")?.isFile, "Deep ZIP folder should list files.");
    assert(deepListing.timing?.scanMs >= 0, "ZIP listing should include scan timing.");

    const outputPath = path.join(artifactsDir, "zip-browse-latest.json");
    await fs.writeFile(
      outputPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          zipPath,
          root: {
            path: root.path,
            parent: root.parent,
            count: root.count,
            scannedEntries: root.scannedEntries,
            truncated: root.truncated,
            timing: root.timing
          },
          nested: {
            path: nestedListing.path,
            parent: nestedListing.parent,
            count: nestedListing.count,
            timing: nestedListing.timing
          },
          deep: {
            path: deepListing.path,
            parent: deepListing.parent,
            count: deepListing.count,
            timing: deepListing.timing
          }
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`zip root: ${root.count} item(s), scanned ${root.scannedEntries}`);
    console.log(`nested: ${nestedListing.count} item(s)`);
    console.log(`deep: ${deepListing.count} item(s)`);
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
