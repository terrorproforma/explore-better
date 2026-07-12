import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const artifactsDir = path.join(workspace, "artifacts");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(artifactsDir, `filesystem-objects-${stamp}`);
const fixtureRoot = path.join(runRoot, "fixture");
const sourceDir = path.join(fixtureRoot, "sources");
const linkDir = path.join(fixtureRoot, "links");
const appData = path.join(runRoot, "appdata");
const shortcutReaderPath = path.join(runRoot, "read-shortcut.ps1");
let serverOutput = "";

function optionValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function keepFixture() {
  return process.argv.includes("--keep-fixture") || process.env.EB_FILESYSTEM_OBJECTS_KEEP_FIXTURE === "1";
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function pathExists(itemPath) {
  try {
    await fs.lstat(itemPath);
    return true;
  } catch {
    return false;
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

function startServer(port) {
  serverOutput = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: workspace,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), LOCALAPPDATA: appData, APPDATA: appData },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  return child;
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
  await fs.mkdir(path.join(sourceDir, "source-folder"), { recursive: true });
  await fs.mkdir(linkDir, { recursive: true });
  const sourceFile = path.join(sourceDir, "source-file.txt");
  const sourceFolder = path.join(sourceDir, "source-folder");
  await fs.writeFile(sourceFile, "source hardlink body\n", "utf8");
  await fs.writeFile(path.join(sourceFolder, "inside.txt"), "source folder body\n", "utf8");
  return { sourceFile, sourceFolder };
}

async function readShortcut(shortcutPath) {
  await fs.writeFile(
    shortcutReaderPath,
    `param([string]$ShortcutPath)
$ErrorActionPreference = "Stop"
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
[pscustomobject]@{
  TargetPath = $Shortcut.TargetPath
  WorkingDirectory = $Shortcut.WorkingDirectory
} | ConvertTo-Json -Compress
`,
    "utf8"
  );
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", shortcutReaderPath, shortcutPath],
      { timeout: 10000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || stdout || error.message).trim()));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

function assertCompletedOperation(response, type, message) {
  assert(response.operation?.type === type, `${message}: operation type should be ${type}.`);
  assert(response.operation?.status === "completed", `${message}: operation should complete.`);
  assert(response.operation?.id, `${message}: operation should have an id.`);
  assert(response.operation?.undo?.type === "trash-created", `${message}: operation should be undoable.`);
}

function findCreated(response, linkKind) {
  return response.created?.find((item) => item.linkKind === linkKind);
}

function findListed(listing, itemPath) {
  return listing.entries?.find((entry) => entry.path === itemPath);
}

function clearPathMessage(error) {
  return error.data?.error || error.message || String(error);
}

function symlinkDeniedCleanly(message) {
  return /privilege|permission|denied|not permitted|EPERM|EACCES|required privilege/i.test(message);
}

async function waitForBackgroundComplete(baseUrl, rootId) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const overview = await requestJson(baseUrl, "/api/background-indexes");
    const root = overview.roots?.find((item) => item.id === rootId);
    assert(root, "Background index root should remain registered.");
    if (root.job?.status === "error") {
      throw new Error(root.job.error || "Background link index failed.");
    }
    if (!root.job || root.job.status === "complete") {
      return root;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Background link index did not complete in time.");
}

async function undoOperation(baseUrl, operationId, label) {
  const response = await requestJson(baseUrl, "/api/operation/undo", {
    method: "POST",
    body: JSON.stringify({ operationId })
  });
  assert(response.operation?.status === "completed", `${label}: undo operation should complete.`);
  return response;
}

async function main() {
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(appData, { recursive: true });
  const fixture = await prepareFixture();
  const port = Number(optionValue("--port", process.env.PORT || 52000 + Math.floor(Math.random() * 10000)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = startServer(port);
  const undoIds = [];
  let symlink = { status: "not-run" };
  try {
    await waitForServer(baseUrl, server);

    const shortcut = await requestJson(baseUrl, "/api/shortcut/create", {
      method: "POST",
      body: JSON.stringify({
        paths: [fixture.sourceFile, fixture.sourceFolder],
        targetDir: linkDir,
        conflictMode: "unique"
      })
    });
    assertCompletedOperation(shortcut, "shortcut-create", "Shortcut creation");
    assert(shortcut.created?.length === 2, "Shortcut creation should create a file and folder shortcut.");
    undoIds.push({ id: shortcut.operation.id, label: "shortcut" });
    const shortcutTargets = [];
    for (const created of shortcut.created) {
      assert(await pathExists(created.dest), `Shortcut should exist: ${created.dest}`);
      const target = await readShortcut(created.dest);
      shortcutTargets.push({ path: created.dest, ...target });
      assert(
        [fixture.sourceFile, fixture.sourceFolder].some((source) => path.resolve(source).toLowerCase() === path.resolve(target.TargetPath).toLowerCase()),
        `Shortcut target should point at one of the source items: ${target.TargetPath}`
      );
    }

    const autoLinks = await requestJson(baseUrl, "/api/link/create", {
      method: "POST",
      body: JSON.stringify({
        paths: [fixture.sourceFile, fixture.sourceFolder],
        targetDir: linkDir,
        linkKind: "auto",
        conflictMode: "unique"
      })
    });
    assertCompletedOperation(autoLinks, "link-create", "Auto link creation");
    const hardlink = findCreated(autoLinks, "hardlink");
    const junction = findCreated(autoLinks, "junction");
    assert(hardlink?.dest, "Auto link creation should create a hard link for files.");
    assert(junction?.dest, "Auto link creation should create a junction for folders.");
    undoIds.push({ id: autoLinks.operation.id, label: "auto links" });

    const sourceFileStats = await fs.stat(fixture.sourceFile);
    const hardlinkStats = await fs.stat(hardlink.dest);
    assert(hardlinkStats.nlink >= 2 || sourceFileStats.nlink >= 2, "Hard link count should be visible after creation.");
    assert((await fs.readFile(hardlink.dest, "utf8")) === "source hardlink body\n", "Hard link should read source file contents.");
    const junctionLstat = await fs.lstat(junction.dest);
    assert(junctionLstat.isSymbolicLink(), "Junction should be reported as a reparse/symlink entry by lstat.");
    assert((await fs.readFile(path.join(junction.dest, "inside.txt"), "utf8")) === "source folder body\n", "Junction should expose source folder contents.");

    try {
      const symlinkResponse = await requestJson(baseUrl, "/api/link/create", {
        method: "POST",
        body: JSON.stringify({
          paths: [fixture.sourceFile],
          targetDir: linkDir,
          linkKind: "symlink",
          conflictMode: "unique"
        })
      });
      assertCompletedOperation(symlinkResponse, "link-create", "Symlink creation");
      const created = findCreated(symlinkResponse, "symlink");
      assert(created?.dest, "Symlink creation should report a created symlink.");
      assert((await fs.lstat(created.dest)).isSymbolicLink(), "Created symlink should be a symbolic link.");
      symlink = { status: "created", created };
      undoIds.push({ id: symlinkResponse.operation.id, label: "symlink" });
    } catch (error) {
      const message = clearPathMessage(error);
      assert(symlinkDeniedCleanly(message), `Symlink failure should be a clear Windows permission/privilege error, got: ${message}`);
      symlink = { status: "denied-cleanly", error: message };
    }

    const listing = await requestJson(
      baseUrl,
      `/api/list?${new URLSearchParams({ path: linkDir, includeLinks: "true", includeSignature: "true" })}`
    );
    const hardlinkEntry = findListed(listing, hardlink.dest);
    const junctionEntry = findListed(listing, junction.dest);
    assert(hardlinkEntry?.linkType === "Hard Link", `Listing should mark hardlink as Hard Link, got ${hardlinkEntry?.linkType}.`);
    assert(Number(hardlinkEntry.linkCount || 0) >= 2, "Listing should include hard-link count.");
    assert(junctionEntry?.isSymlink === true, "Listing should mark junction as a symlink/reparse entry.");
    assert(/Link/.test(junctionEntry.linkType || ""), `Listing should mark junction with a link type, got ${junctionEntry?.linkType}.`);
    assert(
      String(junctionEntry.linkTarget || junctionEntry.linkTargetRaw || "").toLowerCase().includes("source-folder"),
      "Listing should include the junction target."
    );
    if (symlink.status === "created") {
      const symlinkEntry = findListed(listing, symlink.created.dest);
      assert(symlinkEntry?.isSymlink === true, "Listing should mark file symlink as symlink.");
      assert(/Link/.test(symlinkEntry.linkType || ""), `Listing should mark file symlink with link type, got ${symlinkEntry?.linkType}.`);
    }

    const indexBuild = await requestJson(baseUrl, "/api/index/build", {
      method: "POST",
      body: JSON.stringify({ path: linkDir, wait: true, showHidden: true, includeLinks: true })
    });
    assert(indexBuild.index?.includeLinks === true, "Folder index should warm link metadata.");
    const indexSearch = await requestJson(
      baseUrl,
      `/api/index/search?${new URLSearchParams({ path: linkDir, q: "source-folder", limit: "20" })}`
    );
    assert(indexSearch.indexed === true, "Folder index search should be served from the warm index.");
    assert(indexSearch.results?.some((item) => item.path === junction.dest), "Folder index search should find the junction by target metadata.");

    const backgroundStart = await requestJson(baseUrl, "/api/background-indexes/start", {
      method: "POST",
      body: JSON.stringify({
        path: linkDir,
        recursive: false,
        includeDimensions: false,
        includeLinks: true,
        includeContent: false,
        maxFolders: 1,
        maxEntries: 1000
      })
    });
    const rootId = backgroundStart.job?.rootId || backgroundStart.root?.id || backgroundStart.roots?.[0]?.id;
    assert(rootId, "Background link index should return a root id.");
    const backgroundRoot = await waitForBackgroundComplete(baseUrl, rootId);
    assert(backgroundRoot.search?.includeLinks === true, "Background index should preserve includeLinks=true.");
    const backgroundSearch = await requestJson(
      baseUrl,
      `/api/background-indexes/search?${new URLSearchParams({ rootId, q: "source-folder", limit: "20" })}`
    );
    assert(backgroundSearch.indexed === true, "Background link search should use the warm aggregate store.");
    assert(backgroundSearch.results?.some((item) => item.path === junction.dest), "Background index search should find the junction by target metadata.");

    for (const item of [...undoIds].reverse()) {
      await undoOperation(baseUrl, item.id, item.label);
    }
    for (const created of [...shortcut.created, ...autoLinks.created, ...(symlink.created ? [symlink.created] : [])]) {
      assert(!(await pathExists(created.dest)), `Undo should remove created object: ${created.dest}`);
    }
    assert(await pathExists(fixture.sourceFile), "Undo should leave the source file intact.");
    assert(await pathExists(path.join(fixture.sourceFolder, "inside.txt")), "Undo should leave the source folder intact.");

    const report = {
      generatedAt: new Date().toISOString(),
      fixtureRoot,
      shortcut: {
        created: shortcut.created,
        targets: shortcutTargets,
        operation: {
          id: shortcut.operation.id,
          status: shortcut.operation.status,
          undo: shortcut.operation.undo?.type || null
        }
      },
      links: {
        created: autoLinks.created,
        hardlinkNlink: hardlinkStats.nlink,
        sourceNlink: sourceFileStats.nlink,
        operation: {
          id: autoLinks.operation.id,
          status: autoLinks.operation.status,
          undo: autoLinks.operation.undo?.type || null
        }
      },
      symlink,
      listing: {
        includeLinks: listing.includeLinks,
        entries: listing.entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          isSymlink: entry.isSymlink,
          linkType: entry.linkType,
          linkTarget: entry.linkTarget,
          linkCount: entry.linkCount
        }))
      },
      index: {
        folder: indexBuild.index,
        searchTiming: indexSearch.timing,
        returned: indexSearch.results?.length || 0
      },
      background: {
        root: backgroundRoot.search || backgroundRoot.lastStats || null,
        searchTiming: backgroundSearch.timing,
        returned: backgroundSearch.results?.length || 0
      },
      undo: {
        removedCreatedObjects: true,
        sourcesIntact: true
      }
    };
    const outputPath = path.join(artifactsDir, "filesystem-objects-latest.json");
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`shortcuts: ${shortcut.created.length}`);
    console.log(`links: ${autoLinks.created.map((item) => item.linkKind).join(", ")}`);
    console.log(`symlink: ${symlink.status}`);
    console.log(`index search: ${indexSearch.timing?.searchMs} ms / ${indexSearch.results?.length || 0} result(s)`);
    console.log(`background search: ${backgroundSearch.timing?.searchMs} ms / ${backgroundSearch.results?.length || 0} result(s)`);
    console.log(`wrote ${outputPath}`);
  } finally {
    await stopServer(server);
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
