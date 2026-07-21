import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

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

function edgePath() {
  return optionValue("--browser", process.env.EB_ZIP_BROWSE_BROWSER || "") || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
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

async function waitForPath(itemPath, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fs.access(itemPath).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${itemPath}`);
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

  let browser = null;
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

    browser = await chromium.launch({ executablePath: edgePath(), headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    await page.goto(`${baseUrl}/?left=${encodeURIComponent(runRoot)}&right=${encodeURIComponent(sourceRoot)}`, {
      waitUntil: "domcontentloaded"
    });
    const zipRow = page.locator('.pane[data-pane="left"] [data-entry-path]').filter({ hasText: "fixture.zip" });
    await zipRow.waitFor({ state: "visible", timeout: 10000 });
    await zipRow.click({ button: "right" });
    const extractHereButton = page.locator('#context-menu [data-context-action="extract-here"]');
    assert(await extractHereButton.isVisible(), "ZIP context menu should expose Extract Here.");
    assert((await extractHereButton.textContent())?.trim() === "Extract Here", "ZIP context action should use the explicit Extract Here label.");
    await page.locator('#context-menu [data-context-action="archive"]').click();
    await page.waitForFunction(() => document.getElementById("archive-dialog")?.open === true);
    const dialogDefaults = await page.evaluate(() => {
      const hereButton = document.querySelector('[data-archive-target="here-extract"]');
      return {
        archive: document.getElementById("archive-path")?.value || "",
        target: document.getElementById("archive-extract-target")?.value || "",
        folder: document.getElementById("archive-folder")?.value || "",
        hereButtonVisible: Boolean(hereButton && !hereButton.hidden)
      };
    });
    assert(dialogDefaults.archive === zipPath, "Archive dialog should retain the selected ZIP path.");
    assert(dialogDefaults.target === runRoot, "Archive dialog should default extraction to the ZIP containing folder.");
    assert(dialogDefaults.folder === "fixture", "Archive dialog should keep extraction in a safe archive-named sibling folder.");
    assert(dialogDefaults.hereButtonVisible, "Archive dialog should expose an explicit Here target button.");
    await page.locator('[data-close-dialog="archive-dialog"]').click();
    await page.waitForFunction(() => document.getElementById("archive-dialog")?.open === false);
    await zipRow.click({ button: "right" });
    await extractHereButton.click();
    const extractedDir = path.join(runRoot, "fixture");
    await waitForPath(path.join(extractedDir, "root-file.txt"));
    await waitForPath(path.join(extractedDir, "nested", "deep", "final.log"));
    await page.waitForFunction(() => /Extracted here to fixture/i.test(document.getElementById("toast")?.textContent || ""));
    const state = await requestJson(baseUrl, "/api/state");
    const extractOperation = (state.operations || []).find((operation) => operation.type === "archive-extract");
    assert(extractOperation?.status === "completed", "Extract Here should complete as a journaled archive extraction.");
    assert(extractOperation?.retry?.body?.targetDir === runRoot, "Extract Here should target the ZIP containing folder.");
    assert(
      !(await fs.access(path.join(sourceRoot, "fixture")).then(() => true, () => false)),
      "Extract Here must not use the other pane as its target."
    );
    const ui = await page.evaluate(() => ({
      dialogOpen: document.getElementById("archive-dialog")?.open === true,
      toast: document.getElementById("toast")?.textContent || "",
      leftPath: document.querySelector('[data-path-input="left"]')?.value || "",
      rightPath: document.querySelector('[data-path-input="right"]')?.value || ""
    }));
    assert(!ui.dialogOpen, "Extract Here should run directly without opening the archive dialog.");
    assert(/Extracted here to fixture/i.test(ui.toast), "Extract Here should report the created sibling folder.");

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
          },
          extractHere: {
            action: "Extract Here",
            archive: zipPath,
            targetDir: runRoot,
            extractedDir,
            operationId: extractOperation.id,
            status: extractOperation.status,
            dialogDefaults,
            ui
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
    console.log(`extract here: ${extractedDir}`);
    console.log(`wrote ${outputPath}`);
  } finally {
    await browser?.close().catch(() => {});
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
