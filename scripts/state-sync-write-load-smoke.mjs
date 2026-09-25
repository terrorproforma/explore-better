import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";

// Regressions for state.json sync and write load:
// (a) server-side label changes survive renderer navigation saves,
// (b) a copy of many small files keeps journal writes bounded while progress stays visible,
// (c) null rows in stored lists do not break loading or trigger backup/default overwrites.
const root = process.cwd();
const run = path.join(root, "artifacts", `state-sync-write-load-${Date.now()}`);
const checks = [];
const servers = new Set();
const check = (id, ok, detail = "") => {
  checks.push({ id, ok: Boolean(ok), detail });
  assert.ok(ok, `${id}: ${detail}`);
};

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(appData) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      APPDATA: appData,
      LOCALAPPDATA: appData,
      EB_TEST_STATE_WRITE_COUNTER: "1"
    }
  });
  const server = { child, url, output: "" };
  child.stdout.on("data", (data) => { server.output += data; });
  child.stderr.on("data", (data) => { server.output += data; });
  servers.add(server);
  for (let index = 0; index < 150; index += 1) {
    if (child.exitCode !== null) throw new Error(server.output);
    try {
      if ((await fetch(`${url}/api/roots`)).ok) return server;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start: ${server.output}`);
}

async function stopServer(server) {
  if (!server) return;
  servers.delete(server);
  if (server.child.exitCode !== null) return;
  server.child.kill();
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    server.child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

async function api(server, route, body) {
  const response = await fetch(`${server.url}${route}`, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${route}: ${data.error || response.status}`);
  return data;
}

const stateWrites = async (server) => (await api(server, "/api/operations")).stateWrites;
const hasLabel = (state, itemPath) =>
  (state.labels || []).some((label) => label.path.toLowerCase() === itemPath.toLowerCase());

async function labelsSurviveNavigationSaves() {
  const appData = path.join(run, "labels-appdata");
  const fixture = path.join(run, "labels-fixture");
  const moveTarget = path.join(fixture, "target");
  await fs.mkdir(moveTarget, { recursive: true });
  const files = ["one.txt", "two.txt", "moved.txt"].map((name) => path.join(fixture, name));
  await Promise.all(files.map((file) => fs.writeFile(file, "label fixture\n")));
  const server = await startServer(appData);
  try {
    const initial = await api(server, "/api/state");
    const layout = initial.layout;
    await api(server, "/api/state", { layout, labels: [{ path: files[0], name: "Renderer", color: "gold" }] });
    await api(server, "/api/labels/apply", { paths: [files[1], files[2]], name: "Server", color: "teal" });
    const moved = (await api(server, "/api/move", { paths: [files[2]], targetDir: moveTarget })).operation;
    check("move-completed", moved?.status === "completed", JSON.stringify(moved?.status));

    const beforeNavigation = await stateWrites(server);
    layout.panes.left.tabs[0].path = fixture;
    const saved = await api(server, "/api/state", { layout });
    const afterNavigation = await stateWrites(server);
    const movedPath = path.join(moveTarget, "moved.txt");
    check("navigation-save-keeps-server-label", hasLabel(saved, files[1]), JSON.stringify(saved.labels));
    check("navigation-save-keeps-transfer-label", hasLabel(saved, movedPath) && !hasLabel(saved, files[2]), JSON.stringify(saved.labels));
    check("navigation-save-keeps-renderer-label", hasLabel(saved, files[0]), JSON.stringify(saved.labels));
    check("navigation-save-writes-once", afterNavigation - beforeNavigation === 1, `${beforeNavigation} -> ${afterNavigation}`);

    await api(server, "/api/state", { layout });
    await api(server, "/api/state", { layout, labels: saved.labels });
    check("unchanged-save-skips-write", (await stateWrites(server)) === afterNavigation, `${afterNavigation} -> ${await stateWrites(server)}`);

    const persisted = JSON.parse(await fs.readFile(path.join(appData, "ExploreBetter", "state.json"), "utf8"));
    check("persisted-labels-intact", hasLabel(persisted, files[1]) && hasLabel(persisted, movedPath), JSON.stringify(persisted.labels));
  } finally {
    await stopServer(server);
  }
}

async function rendererNavigationKeepsServerLabels() {
  const browserPath = process.env.EB_INTERACTION_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  if (!existsSync(browserPath)) {
    checks.push({ id: "renderer-navigation-keeps-server-label", ok: true, detail: "skipped: no browser" });
    return;
  }
  const { chromium } = await import("playwright-core");
  const appData = path.join(run, "renderer-appdata");
  const left = path.join(run, "renderer-left");
  const right = path.join(run, "renderer-right");
  const other = path.join(run, "renderer-other");
  await Promise.all([left, right, other].map((folder) => fs.mkdir(folder, { recursive: true })));
  const labeled = path.join(left, "server-labeled.txt");
  await fs.writeFile(labeled, "labeled\n");
  const server = await startServer(appData);
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(() => {
      window.exploreBetterDesktop = { aiBridge: { publishContext() {}, onAction(handler) { window.__testUiAction = handler; } } };
    });
    await page.goto(`${server.url}/?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`);
    await page.waitForFunction(() => Boolean(window.__exploreBetterStartup?.completedAt));
    await page.waitForTimeout(600);
    await api(server, "/api/labels/apply", { paths: [labeled], name: "Server", color: "violet" });
    const posted = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/state") && request.method() === "POST") posted.push(JSON.parse(request.postData() || "{}"));
    });
    const saveResponse = page.waitForResponse((response) => response.url().endsWith("/api/state") && response.request().method() === "POST");
    await page.evaluate((target) => window.__testUiAction({ type: "show", pane: "left", path: target }), other);
    await saveResponse;
    await page.waitForTimeout(400);
    const state = await api(server, "/api/state");
    check("renderer-navigation-keeps-server-label", hasLabel(state, labeled), JSON.stringify(state.labels));
    check("renderer-navigation-sends-changed-fields-only", posted.length > 0 && posted.every((body) => !("labels" in body)), JSON.stringify(posted.map((body) => Object.keys(body))));
  } finally {
    await browser.close();
    await stopServer(server);
  }
}

async function copyWriteLoadIsBounded() {
  const appData = path.join(run, "copy-appdata");
  const source = path.join(run, "copy-source");
  const target = path.join(run, "copy-target");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(target, { recursive: true });
  const count = 3000;
  const paths = Array.from({ length: count }, (_, index) => path.join(source, `f${String(index).padStart(4, "0")}.txt`));
  for (let index = 0; index < paths.length; index += 200) {
    await Promise.all(paths.slice(index, index + 200).map((file) => fs.writeFile(file, "x")));
  }
  const server = await startServer(appData);
  try {
    await api(server, "/api/state", { settings: { density: "compact" } });
    const before = await stateWrites(server);
    const started = Date.now();
    const copy = api(server, "/api/copy", { paths, targetDir: target });
    let sawProgress = false;
    let done = false;
    copy.finally(() => { done = true; }).catch(() => {});
    while (!done) {
      const { operations } = await api(server, "/api/operations");
      const active = operations.find((operation) => operation.type === "copy" && operation.status === "running");
      if (active && active.progress?.completed > 0 && active.progress.completed < count) sawProgress = true;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const result = (await copy).operation;
    const elapsedMs = Date.now() - started;
    const writes = (await stateWrites(server)) - before;
    check("copy-completed", result?.status === "completed" && result.progress?.completed === count, JSON.stringify({ status: result?.status, progress: result?.progress }));
    check("copy-live-progress-visible", sawProgress, "running copy showed in-memory progress through /api/operations");
    const bound = 12 + Math.ceil(elapsedMs / 1000) * 3;
    check("copy-state-writes-bounded", writes <= bound, `${writes} state writes for ${count} files in ${elapsedMs} ms (bound ${bound})`);
    const persisted = JSON.parse(await fs.readFile(path.join(appData, "ExploreBetter", "state.json"), "utf8"));
    const stored = persisted.operations.find((operation) => operation.id === result.id);
    check("copy-final-state-persisted", stored?.status === "completed" && stored.progress?.completed === count, JSON.stringify(stored?.progress));
    const copied = (await fs.readdir(target)).length;
    check("copy-files-present", copied === count, `${copied} files`);
    return { writes, elapsedMs };
  } finally {
    await stopServer(server);
  }
}

async function nullRowsDoNotBreakLoad() {
  const appData = path.join(run, "null-appdata");
  const stateDir = path.join(appData, "ExploreBetter");
  await fs.mkdir(stateDir, { recursive: true });
  const statePath = path.join(stateDir, "state.json");
  const backupPath = path.join(stateDir, "state.json.bak");
  const now = new Date().toISOString();
  const seed = {
    updatedAt: now,
    settings: { density: "spacious" },
    aliases: [{ id: "alias-keep", name: "keepme", path: run, updatedAt: now }],
    commands: [null, { id: "cmd-keep", name: "Keep Command", kind: "cmd", command: "echo keep" }, 7],
    scripts: [null, { id: "script-keep", name: "Keep Script", code: "return 1;", updatedAt: now }],
    favorites: [null, { id: "fav-keep", name: "Fav", path: run, color: "teal" }],
    collections: [null],
    layouts: [null],
    recentLocations: [null, run],
    labels: [null]
  };
  const seedText = JSON.stringify(seed, null, 2);
  await fs.writeFile(statePath, seedText, "utf8");
  await fs.writeFile(backupPath, JSON.stringify({ settings: { density: "compact" } }), "utf8");
  const server = await startServer(appData);
  try {
    const state = await api(server, "/api/state");
    check("null-rows-load-current-state", state.settings?.density === "spacious" && state.aliases.some((alias) => alias.name === "keepme"), JSON.stringify(state.settings));
    check("null-rows-dropped", state.commands.length === 1 && state.commands[0].id === "cmd-keep" && state.scripts.length === 1 && state.favorites.length === 1 && state.collections.length === 0 && state.layouts.length === 0, JSON.stringify({ commands: state.commands, scripts: state.scripts }));
    check("null-rows-string-recent-kept", state.recentLocations.length === 1, JSON.stringify(state.recentLocations));
    check("null-rows-not-overwritten-on-load", (await fs.readFile(statePath, "utf8")) === seedText, "state.json untouched by a read");
    const backup = JSON.parse(await fs.readFile(backupPath, "utf8"));
    check("null-rows-backup-not-restored", backup.settings?.density === "compact", JSON.stringify(backup));
    const saved = await api(server, "/api/state", { commands: [null, { id: "cmd-new", name: "New", kind: "powershell", command: "Write-Output 1" }] });
    check("null-rows-post-accepted", saved.commands.length === 1 && saved.commands[0].id === "cmd-new", JSON.stringify(saved.commands));
  } finally {
    await stopServer(server);
  }
}

let summary = {};
try {
  await fs.mkdir(run, { recursive: true });
  await labelsSurviveNavigationSaves();
  await rendererNavigationKeepsServerLabels();
  summary = await copyWriteLoadIsBounded();
  await nullRowsDoNotBreakLoad();
} catch (error) {
  if (!checks.some((item) => !item.ok)) checks.push({ id: "runtime", ok: false, detail: error.stack });
  for (const server of servers) console.error(server.output);
  process.exitCode = 1;
} finally {
  await Promise.all([...servers].map(stopServer));
  await fs.writeFile(path.join(root, "artifacts", "state-sync-write-load-latest.json"), JSON.stringify({ checks, summary, run }, null, 2));
  console.log(`State sync/write load: ${checks.filter((item) => item.ok).length} pass, ${checks.filter((item) => !item.ok).length} fail`);
  if (summary.writes !== undefined) console.log(`copy of 3000 files: ${summary.writes} state writes in ${summary.elapsedMs} ms`);
  checks.filter((item) => !item.ok).forEach((item) => console.error(item.id, item.detail));
  if (!process.exitCode) await fs.rm(run, { recursive: true, force: true }).catch(() => {});
}
