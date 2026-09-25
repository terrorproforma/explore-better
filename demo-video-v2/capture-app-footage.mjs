// Records one continuous, real Explore Better session for the v6 demo cut.
//
// Safety: everything runs inside a disposable demo root (default C:\Demo, override with
// EB_DEMO_ROOT). The root must not exist yet, or must carry the marker this script writes,
// and it is removed afterwards. The app gets its own profile, LOCALAPPDATA, APPDATA and
// Electron user data inside that root, so the user's real files, settings and AI Bridge
// configuration are never read or written. Nothing touches the registry.
//
// A short root keeps every visible path clean ("C:\Demo\Project files") with no user name.
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const workDir = path.join(root, "demo-video-v2");
const captureDir = path.join(workDir, "capture");
const frameDir = path.join(captureDir, "frames");
const outputPath = path.join(captureDir, "explore-better-live-walkthrough.mp4");
const tracePath = path.join(captureDir, "ai-handoff-trace.json");
const electronApp = path.join(root, "node_modules", "electron", "dist", "electron.exe");
const repoSidecar = path.join(root, "native", "bin", "ExploreBetterMcp.exe");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const demoRoot = path.resolve(process.env.EB_DEMO_ROOT || "C:\\Demo");
const markerFile = path.join(demoRoot, ".explore-better-demo-workspace");
// CSS viewport: 1440x810 keeps the UI legible in a 1080p frame.
const viewport = { width: 1440, height: 810, scale: 2 };
// Rects are reported in the 1920x1080 edit space; the source is recorded at 2x so the edit
// can push in up to 1.5x without upscaling.
const output = { width: 1920, height: 1080, fps: 30 };
const source = { width: viewport.width * viewport.scale, height: viewport.height * viewport.scale };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findCodexCli() {
  if (process.env.EB_DEMO_MCP_CLIENT === "scripted") return null;
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  const found = spawnSync("where", ["codex"], { encoding: "utf8", windowsHide: true });
  const candidates = String(found.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => /\.exe$/i.test(line));
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(test, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await test();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(message);
}

async function prepareDemoRoot() {
  // A previous run's delete can stay pending until its child processes release their handles.
  for (let attempt = 0; attempt < 40 && existsSync(demoRoot) && !existsSync(markerFile); attempt += 1) await sleep(250);
  if (existsSync(demoRoot)) {
    if (!existsSync(markerFile)) {
      throw new Error(`${demoRoot} already exists and is not a previous demo workspace. Set EB_DEMO_ROOT to an unused folder.`);
    }
    await fs.rm(demoRoot, { recursive: true, force: true, maxRetries: 5 });
  }
  await fs.mkdir(demoRoot, { recursive: true });
  await fs.writeFile(markerFile, "Disposable Explore Better demo workspace. Safe to delete.\n");
}

function sizedFile(bytes, seed) {
  bytes = Math.round(bytes);
  const buffer = Buffer.allocUnsafe(bytes);
  let state = seed * 2654435761 >>> 0;
  for (let index = 0; index < bytes; index += 4096) {
    state = (state * 1664525 + 1013904223) >>> 0;
    buffer.fill(state & 0xff, index, Math.min(bytes, index + 4096));
  }
  return buffer;
}

async function createFixture() {
  const user = path.join(demoRoot, "User");
  const left = path.join(demoRoot, "Project files");
  const right = path.join(demoRoot, "Release ready");
  const picks = path.join(left, "Client picks");
  const rightPicks = path.join(right, "Client picks");
  const folders = [
    path.join(user, "Desktop"), path.join(user, "Documents"), path.join(user, "Downloads"),
    path.join(user, "AppData", "Local"), path.join(user, "AppData", "Roaming"),
    path.join(left, "01 Brand"), path.join(left, "02 Product"), path.join(left, "03 Research"),
    path.join(left, "04 Launch"), path.join(left, "Archive"), picks,
    path.join(right, "Approved"), path.join(right, "Final exports"), rightPicks
  ];
  for (const folder of folders) await fs.mkdir(folder, { recursive: true });
  const mb = 1024 * 1024;
  const files = [
    [path.join(left, "README.md"), "# Launch workspace\n\nSource assets, research and release planning for Explore Better.\n"],
    [path.join(left, "launch-plan.md"), "# Launch plan\n\n- Windows 11\n- Local-first\n- Humans + AI\n"],
    [path.join(left, "interface-notes.txt"), "Dual panes. Fast search. Recoverable operations.\n"],
    [path.join(left, "invoice-july.pdf"), sizedFile(1.4 * mb, 1)],
    [path.join(left, "invoice-june.pdf"), sizedFile(0.9 * mb, 2)],
    [path.join(left, "01 Brand", "explore-better-logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="240"><rect width="100%" height="100%" fill="#111715"/><text x="44" y="150" fill="#c7ff4a" font-size="84">Explore Better</text></svg>'],
    [path.join(left, "01 Brand", "brand-guidelines.pdf"), sizedFile(3.4 * mb, 3)],
    [path.join(left, "01 Brand", "icon-set.zip"), sizedFile(6.8 * mb, 4)],
    [path.join(left, "02 Product", "workspace-tour.mp4"), sizedFile(48 * mb, 5)],
    [path.join(left, "02 Product", "ai-bridge-demo.mp4"), sizedFile(31 * mb, 6)],
    [path.join(left, "02 Product", "ui-kit.fig"), sizedFile(9.2 * mb, 7)],
    [path.join(left, "03 Research", "search-benchmark.csv"), "tool,median_ms\nExplore Better MCP,9.8\nPowerShell,536.1\n"],
    [path.join(left, "03 Research", "customer-interviews.docx"), sizedFile(2.2 * mb, 8)],
    [path.join(left, "03 Research", "usability-sessions.mov"), sizedFile(22 * mb, 9)],
    [path.join(left, "04 Launch", "press-kit.zip"), sizedFile(14 * mb, 10)],
    [path.join(left, "04 Launch", "release-checklist.md"), "# Release checklist\n\n[x] Signed installer\n[x] Checksums published\n[x] Update feed live\n[ ] Announce\n"],
    [path.join(left, "04 Launch", "announcement-draft.md"), "Explore Better 0.2.7 is here.\n"],
    [path.join(left, "Archive", "explore-better-v1.exe"), sizedFile(11.4 * mb, 11)],
    [path.join(left, "Archive", "old-renders.zip"), sizedFile(26 * mb, 12)],
    [path.join(right, "interface-notes.txt"), "Previous release notes.\n"],
    [path.join(right, "Approved", "release-notes.md"), "Fast. Local-first. Visible. Recoverable.\n"],
    [path.join(right, "Final exports", "ExploreBetter-0.2.7-x64.exe"), sizedFile(14.2 * mb, 13)]
  ];
  for (const [file, contents] of files) await fs.writeFile(file, contents);
  // 420 photos keep the copy under the transfer planner's 500-path window and long enough
  // (four to six seconds) for live progress to be readable. Three already exist on the
  // release side, so the preview has real conflicts to resolve.
  for (let index = 0; index < 420; index += 1) {
    const name = `IMG_${4100 + index}.jpg`;
    await fs.writeFile(path.join(picks, name), sizedFile(70_000 + (index % 9) * 18_000, 100 + index));
  }
  for (const index of [0, 1, 2]) {
    await fs.copyFile(path.join(picks, `IMG_${4100 + index}.jpg`), path.join(rightPicks, `IMG_${4100 + index}.jpg`));
  }
  return { user, left, right, picks, rightPicks };
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} exited with ${code}`)));
  });
}

function aiPrompt(fixtureRoot) {
  return [
    "Use only the explore-better MCP server. Do not use shell, browser, or any other tool.",
    "Call get_context so you can see the live active pane.",
    `Then call search_files with path ${fixtureRoot}, query release-checklist, kind files, and limit 10; omit maxScanned.`,
    "Call show_in_explore_better for the release-checklist.md you found, in the active pane.",
    "Finish with exactly: Revealed the release checklist in your active Explore Better pane."
  ].join(" ");
}

async function runCodexHandoff({ codex, sidecar, localAppData, fixtureRoot, onTool }) {
  const args = [
    "exec", "--ephemeral", "--json", "--color", "never", "--sandbox", "read-only", "--skip-git-repo-check", "--cd", fixtureRoot,
    "-c", `mcp_servers.explore-better.command=${JSON.stringify(sidecar)}`,
    "-c", `mcp_servers.explore-better.args=${JSON.stringify(["--profile", "demo-readonly", "--app", electronApp, "--app-dir", root])}`,
    "-c", `mcp_servers.explore-better.env={LOCALAPPDATA=${JSON.stringify(localAppData)}}`,
    aiPrompt(fixtureRoot)
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(codex, args, { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const trace = [];
    let stdout = "";
    let stderr = "";
    const consume = (flush = false) => {
      const lines = stdout.split(/\r?\n/);
      stdout = flush ? "" : lines.pop() || "";
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const event = JSON.parse(line);
          trace.push(event);
          if (event?.item?.type === "mcp_tool_call") {
            const phase = event.type === "item.started" ? "start" : event.type === "item.completed" ? "complete" : "";
            if (phase) onTool(event.item.tool, phase, event.item);
          }
        } catch {}
      }
    };
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); consume(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", (code) => {
      consume(true);
      const calls = trace.filter((event) => event.type === "item.completed" && event.item?.type === "mcp_tool_call");
      if (code === 0 && calls.some((event) => event.item.tool === "show_in_explore_better" && event.item.status === "completed")) {
        resolve({ client: "Codex CLI", trace });
      } else {
        reject(new Error(`Codex handoff exited with ${code}: ${stderr.slice(-1200)}`));
      }
    });
  });
}

// Minimal, honest MCP client: the same three calls over stdio JSON-RPC to the app's own sidecar.
async function runScriptedHandoff({ sidecar, localAppData, fixtureRoot, onTool }) {
  const child = spawn(sidecar, ["--profile", "demo-readonly", "--app", electronApp, "--app-dir", root], {
    cwd: root,
    env: { ...process.env, LOCALAPPDATA: localAppData },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map();
  let nextId = 1;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === "ping" && message.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
      return;
    }
    const resolve = pending.get(String(message.id));
    if (resolve) { pending.delete(String(message.id)); resolve(message); }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out. ${stderr}`)), 20_000);
    pending.set(String(id), (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const trace = [];
  try {
    const init = await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "Explore Better demo MCP client", version: "1" } });
    if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    const tool = async (name, args) => {
      const item = { type: "mcp_tool_call", server: "explore-better", tool: name, arguments: args };
      onTool(name, "start", item);
      const response = await call("tools/call", { name, arguments: args });
      if (response.error || response.result?.isError) throw new Error(`${name} failed: ${JSON.stringify(response.error || response.result)}`);
      const completed = { ...item, result: { structured_content: response.result?.structuredContent }, status: "completed" };
      trace.push({ type: "item.completed", item: completed });
      onTool(name, "complete", completed);
      return response.result?.structuredContent;
    };
    await sleep(1200);
    await tool("get_context", {});
    await sleep(1400);
    const found = await tool("search_files", { path: fixtureRoot, query: "release-checklist", kind: "files", limit: 10 });
    const target = found?.data?.entries?.find((entry) => /release-checklist\.md$/i.test(entry.name))?.path;
    if (!target) throw new Error("search_files did not return release-checklist.md");
    await sleep(1400);
    await tool("show_in_explore_better", { path: target, pane: "active" });
    return { client: "MCP client (scripted)", trace };
  } finally {
    lines.close();
    child.stdin.end();
    await sleep(300);
    if (child.exitCode === null) child.kill();
  }
}

function summarizeCall(item) {
  const data = item?.result?.structured_content?.data || {};
  if (item.tool === "get_context") {
    const pane = data.activePane || "left";
    return { tool: item.tool, detail: `live / ${pane} pane / ${path.basename(data.panes?.[pane]?.path || "")}` };
  }
  if (item.tool === "search_files") {
    const count = Array.isArray(data.entries) ? data.entries.length : 0;
    return { tool: item.tool, detail: `${item.arguments?.query || ""} / ${count} match${count === 1 ? "" : "es"} / ${data.scanned ?? "?"} scanned` };
  }
  if (item.tool === "show_in_explore_better") {
    return { tool: item.tool, detail: `${path.basename(data.shown || item.arguments?.path || "")} / ${data.pane || "active"} pane` };
  }
  return { tool: item.tool, detail: "" };
}

await fs.access(electronApp);
await fs.rm(captureDir, { recursive: true, force: true });
await fs.mkdir(frameDir, { recursive: true });
await prepareDemoRoot();
const fixture = await createFixture();
const localAppData = path.join(fixture.user, "AppData", "Local");
const roamingAppData = path.join(fixture.user, "AppData", "Roaming");
const userData = path.join(roamingAppData, "Explore Better Demo");
await fs.mkdir(path.join(localAppData, "ExploreBetter", "MCP"), { recursive: true });
const now = new Date().toISOString();
await fs.writeFile(
  path.join(localAppData, "ExploreBetter", "MCP", "bridge-config.json"),
  `${JSON.stringify({
    version: 1,
    enabled: true,
    auditRetentionDays: 30,
    profiles: [{
      id: "demo-readonly",
      name: "Project files - read only",
      clientType: "codex",
      enabled: true,
      access: "read-only",
      roots: [fixture.left],
      tools: [
        "get_context", "list_locations", "show_in_explore_better", "list_directory", "search_files",
        "inspect_paths", "read_text", "compute_checksums", "get_index_status", "analyze_disk_usage",
        "find_duplicates", "compare_folders", "get_job", "cancel_job", "list_collections", "list_labels",
        "get_operation"
      ],
      allowPermanentDelete: false,
      createdAt: now,
      updatedAt: now,
      lastConnectedAt: null
    }],
    updatedAt: now
  }, null, 2)}\n`,
  "utf8"
);

const port = await freePort();
const app = spawn(electronApp, [
  root, fixture.left, "--no-updates", `--remote-debugging-port=${port}`,
  // Keep painting while other windows overlap the capture window.
  "--disable-features=CalculateNativeWinOcclusion", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"
], {
  cwd: root,
  env: {
    ...process.env,
    USERPROFILE: fixture.user,
    HOMEDRIVE: path.parse(fixture.user).root.replace(/\\$/, ""),
    HOMEPATH: fixture.user.slice(path.parse(fixture.user).root.length - 1),
    LOCALAPPDATA: localAppData,
    APPDATA: roamingAppData,
    EXPLORE_BETTER_USER_DATA_DIR: userData,
    EXPLORE_BETTER_WORKSPACE_ROOT: demoRoot,
    EXPLORE_BETTER_UPDATE_URL: ""
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
let logs = "";
app.stdout.on("data", (chunk) => { logs += chunk; });
app.stderr.on("data", (chunk) => { logs += chunk; });

let browser;
let client;
let writeQueue = Promise.resolve();
const frames = [];
let firstFrameWall = 0;
let firstFrameStamp = 0;
let captureStart = 0;
const markers = [];
const keys = [];
const rects = {};
const texts = {};
const clock = () => Number(((Date.now() - (firstFrameWall || captureStart)) / 1000).toFixed(3));
const mark = (id) => { markers.push({ id, seconds: clock() }); };

try {
  await waitFor(async () => {
    if (app.exitCode !== null) throw new Error(`Explore Better exited before CDP was ready (${app.exitCode}).`);
    return fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok, () => false);
  }, 30_000, "Timed out waiting for Explore Better.");
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await waitFor(
    () => browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url().startsWith("http://127.0.0.1")),
    30_000,
    "Explore Better renderer was not available through CDP."
  );
  client = await page.context().newCDPSession(page);
  await client.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.scale, mobile: false });
  await page.waitForSelector('.pane[data-pane="left"] [data-entry-path]', { timeout: 30_000 });

  const dismissPrompts = async () => {
    const dialog = page.locator("#default-explorer-dialog");
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.locator('[data-default-explorer-choice="keep"]').click();
      await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    }
  };
  const goTo = async (pane, target) => {
    await page.locator(`[data-path-input="${pane}"]`).fill(target);
    await page.locator(`[data-path-input="${pane}"]`).press("Enter");
    await page.waitForFunction(([name, expected]) => document.querySelector(`[data-path-input="${name}"]`)?.value === expected, [pane, target], { timeout: 15_000 });
  };
  await goTo("right", fixture.rightPicks);
  await page.waitForSelector('.pane[data-pane="right"] [data-entry-path]', { timeout: 30_000 });
  await dismissPrompts();

  // Warm the PTY so the terminal reveal is immediate on camera.
  await page.locator('[data-terminal-toggle="left"]').click();
  await page.locator('[data-terminal-drawer="left"] .xterm-helper-textarea').waitFor({ state: "attached", timeout: 20_000 });
  await page.waitForTimeout(2_500);
  await page.locator('[data-terminal-action="close"][data-pane="left"]').click();
  await page.locator('.pane[data-pane="left"] [data-entry-path$="README.md"]').click();
  await page.waitForTimeout(800);

  // A restrained lime pointer and a 30 fps repaint heartbeat. Neither changes app behaviour.
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      #demo-cursor { position:fixed; z-index:2147483647; width:16px; height:16px; border:2px solid #111715; border-radius:50%; background:#c7ff4a; pointer-events:none; transform:translate(-50%,-50%); box-shadow:0 2px 10px rgba(17,23,21,.35); transition:left .42s cubic-bezier(.2,.9,.25,1), top .42s cubic-bezier(.2,.9,.25,1), opacity .25s; }
      #demo-cursor.click::after { content:""; position:absolute; inset:-9px; border:2px solid #c7ff4a; border-radius:50%; animation:demo-ring .42s ease-out both; }
      #demo-cursor.hidden { opacity:0; }
      #demo-heartbeat { position:fixed; left:0; top:0; width:2px; height:2px; opacity:.01; background:#c7ff4a; pointer-events:none; }
      @keyframes demo-ring { from { transform:scale(.2); opacity:1; } to { transform:scale(1.55); opacity:0; } }
    `;
    document.head.appendChild(style);
    const cursor = document.createElement("div");
    cursor.id = "demo-cursor";
    cursor.style.left = "760px";
    cursor.style.top = "470px";
    document.body.appendChild(cursor);
    const beat = document.createElement("div");
    beat.id = "demo-heartbeat";
    document.body.appendChild(beat);
    let tick = 0;
    window.__demoHeartbeat = setInterval(() => {
      tick += 1;
      beat.style.transform = `translateX(${tick % 2}px)`;
    }, 33);
  });

  const scaleRect = (rect) => rect && {
    x: Math.round(rect.x * output.width / viewport.width),
    y: Math.round(rect.y * output.height / viewport.height),
    width: Math.round(rect.width * output.width / viewport.width),
    height: Math.round(rect.height * output.height / viewport.height)
  };
  const recordRect = async (id, selector) => {
    const rect = await page.locator(selector).first().boundingBox().catch(() => null);
    rects[id] = { seconds: clock(), ...scaleRect(rect) };
  };
  const recordText = async (id, selector) => {
    const text = await page.locator(selector).first().textContent({ timeout: 2_000 }).catch(() => "");
    texts[id] = String(text || "").replace(/\s+/g, " ").trim();
  };
  const cursor = async (visible) => page.evaluate((show) => document.getElementById("demo-cursor")?.classList.toggle("hidden", !show), visible);
  const moveCursor = async (locator) => {
    await locator.waitFor({ state: "visible", timeout: 15_000 });
    const box = await locator.boundingBox();
    if (box) {
      await page.evaluate(([x, y]) => {
        const node = document.getElementById("demo-cursor");
        node.classList.remove("hidden");
        node.style.left = `${x}px`;
        node.style.top = `${y}px`;
      }, [box.x + box.width / 2, box.y + box.height / 2]);
    }
    await page.waitForTimeout(470);
  };
  const click = async (target, options = {}) => {
    const locator = typeof target === "string" ? page.locator(target).first() : target;
    await dismissPrompts();
    await moveCursor(locator);
    await page.evaluate(() => {
      const node = document.getElementById("demo-cursor");
      node?.classList.remove("click");
      void node?.offsetWidth;
      node?.classList.add("click");
    });
    if (options.double) await locator.dblclick(); else await locator.click({ modifiers: options.modifiers });
    await page.waitForTimeout(options.settle ?? 380);
  };
  // Native <select> popups render outside the page surface, so pick the option directly
  // (the same change event a user selection fires) while the pointer rests on the control.
  const choose = async (selector, value) => {
    const locator = page.locator(selector).first();
    await moveCursor(locator);
    await page.evaluate(() => {
      const node = document.getElementById("demo-cursor");
      node?.classList.remove("click");
      void node?.offsetWidth;
      node?.classList.add("click");
    });
    await locator.selectOption(value);
    await page.waitForTimeout(420);
  };
  const press = async (combo, label = combo.replaceAll("+", " + ")) => {
    keys.push({ label, seconds: clock() });
    await page.keyboard.press(combo);
  };
  const leftRow = (suffix) => page.locator(`.pane[data-pane="left"] [data-entry-path$="${suffix}"]`).first();

  client.on("Page.screencastFrame", ({ data, sessionId, metadata }) => {
    client.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (!firstFrameWall) {
      firstFrameWall = Date.now();
      firstFrameStamp = metadata.timestamp;
    }
    const index = frames.length;
    const file = path.join(frameDir, `frame-${String(index).padStart(6, "0")}.jpg`);
    frames.push({ file, seconds: metadata.timestamp - firstFrameStamp });
    writeQueue = writeQueue.then(() => fs.writeFile(file, Buffer.from(data, "base64")));
  });
  captureStart = Date.now();
  await client.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: source.width, maxHeight: source.height, everyNthFrame: 1 });
  await waitFor(() => firstFrameWall, 10_000, "Screencast did not start.");
  await cursor(false);

  // 1. Establishing shot.
  mark("workspace");
  await page.waitForTimeout(2_600);

  // 2. Command palette into filtered search: files larger than 5 MB.
  mark("palette");
  await press("Control+P", "Ctrl + P");
  await page.locator("#command-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.type("search", { delay: 110 });
  await page.waitForTimeout(650);
  await press("Enter");
  await page.locator("#search-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(450);
  mark("search-form");
  await recordRect("searchDialog", "#search-dialog");
  await choose("#search-kind", "files");
  await choose("#search-size-op", "greater");
  await click("#search-size-value", { settle: 120 });
  await page.keyboard.type("5 MB", { delay: 120 });
  await page.waitForTimeout(350);
  await click('#search-form button[type="submit"]', { settle: 100 });
  await page.waitForFunction(() => /\d+ match/.test(document.querySelector("#search-summary")?.textContent || "") && document.querySelectorAll("#search-results [data-search-path], #search-results .search-row, #search-results > *").length > 0, null, { timeout: 20_000 });
  mark("search-results");
  await recordRect("searchResults", "#search-results");
  await recordRect("searchSummary", "#search-summary");
  await recordText("searchSummary", "#search-summary");
  await cursor(false);
  await page.waitForTimeout(1_300);
  await click('[data-close-dialog="search-dialog"]', { settle: 100 });
  mark("search-pane");
  await recordRect("leftPaneSearch", '.pane[data-pane="left"]');
  await cursor(false);
  await page.waitForTimeout(2_200);
  // Off camera (the edit cuts here): leave search mode by reopening the folder.
  await goTo("left", fixture.left);
  await page.waitForSelector('.pane[data-pane="left"] [data-entry-path$="README.md"]', { timeout: 15_000 });

  // 3. Disk Map with exact allocation.
  mark("disk-palette");
  await leftRow("README.md").click();
  // A multi-item selection makes the analyzer default to the whole folder, not one file.
  await page.keyboard.press("Control+A");
  await press("Control+P", "Ctrl + P");
  await page.locator("#command-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.type("disk map", { delay: 95 });
  await page.waitForTimeout(500);
  await press("Enter");
  await page.locator("#size-analysis-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator("#size-analysis-path, #size-analysis-dialog input").first().waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  mark("disk-scan");
  await click('[data-size-analysis-action="scan"]');
  await page.waitForFunction(() => {
    const text = document.querySelector("#size-analysis-summary")?.textContent || "";
    return !/Scanning/i.test(text) && document.querySelectorAll("#size-analysis-files .size-analysis-row").length > 0;
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(900);
  await click('[data-size-analysis-action="view-map"]');
  mark("disk-map");
  await cursor(false);
  await page.waitForTimeout(2_400);
  await click('[data-close-dialog="size-analysis-dialog"]');
  await page.waitForTimeout(350);

  // 4. Transfer preview with conflicts, then a real transactional copy with live progress.
  mark("transfer-select");
  await click(leftRow("Client picks"), { double: true, settle: 700 });
  await page.waitForFunction(() => document.querySelectorAll('.pane[data-pane="left"] [data-entry-path$=".jpg"]').length > 5, null, { timeout: 15_000 });
  await leftRow("IMG_4100.jpg").click();
  await press("Control+A", "Ctrl + A");
  await page.waitForTimeout(450);
  await press("F5");
  await page.locator("#transfer-dialog[open]").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const summary = document.querySelector("#transfer-summary")?.textContent || "";
    return /rename/i.test(summary) && document.querySelectorAll("#transfer-results .transfer-row").length > 0;
  }, null, { timeout: 20_000 });
  mark("transfer-preview");
  await recordRect("transferDialog", "#transfer-dialog");
  await recordRect("transferSummary", "#transfer-summary");
  await recordText("transferSummary", "#transfer-summary");
  await page.waitForTimeout(2_300);
  await click("#transfer-apply", { settle: 250 });
  mark("transfer-apply");
  await click('[data-close-dialog="transfer-dialog"]', { settle: 150 });
  await click('[data-topbar-action="ops"]', { settle: 100 });
  await page.locator("#ops-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  mark("ops-open");
  await recordRect("opsDialog", "#ops-dialog");
  await page.waitForSelector("#operation-list .operation-row .operation-progress", { timeout: 10_000 }).catch(() => {});
  await recordRect("opsHead", "#operation-list .operation-row");
  await recordRect("opsProgress", "#operation-list .operation-row .operation-progress");
  await cursor(false);
  await page.waitForFunction(() => /completed/i.test(document.querySelector("#operation-list .operation-row .operation-status")?.textContent || ""), null, { timeout: 60_000 });
  mark("ops-complete");
  await page.waitForTimeout(300);
  await recordRect("opsDone", "#operation-list .operation-row");
  texts.opsDoneMeta = (await page.locator("#operation-list .operation-row").first().locator(".operation-meta span").allTextContents()).map((item) => item.trim()).join(" / ");
  await page.waitForTimeout(1_700);
  await click('[data-close-dialog="ops-dialog"]');
  await leftRow("IMG_4100.jpg").click();
  await press("Backspace");
  await page.waitForFunction((expected) => document.querySelector('[data-path-input="left"]')?.value === expected, fixture.left, { timeout: 10_000 });
  await page.waitForTimeout(600);

  // 5. Safe rename refuses to overwrite.
  mark("rename");
  await click(leftRow("launch-plan.md"));
  await press("F2");
  await page.locator("[data-inline-rename]").waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForTimeout(350);
  await page.keyboard.press("Control+A");
  await page.keyboard.type("README.md", { delay: 105 });
  await page.waitForTimeout(300);
  await press("Enter");
  await page.waitForFunction(() => /already exists/i.test(document.getElementById("toast")?.textContent || ""), null, { timeout: 5_000 });
  mark("rename-refused");
  await recordRect("renameInput", "[data-inline-rename]");
  await recordRect("toast", "#toast");
  await recordText("toast", "#toast");
  await cursor(false);
  await page.waitForTimeout(2_000);
  await press("Escape", "Esc");
  await page.waitForTimeout(500);

  // 6. Keyboard-operable context menu with visible focus.
  mark("keyboard");
  await press("ArrowDown", "↓");
  await page.waitForTimeout(350);
  await press("Shift+F10", "Shift + F10");
  await page.locator("#context-menu:not([hidden])").waitFor({ state: "visible", timeout: 5_000 });
  mark("menu-open");
  await recordRect("menu", "#context-menu");
  for (let step = 0; step < 4; step += 1) {
    await page.waitForTimeout(420);
    await press("ArrowDown", "↓");
  }
  await page.waitForTimeout(900);
  await press("Escape", "Esc");
  await page.waitForTimeout(450);

  // 7. Folder-following terminal.
  mark("terminal");
  await click('[data-terminal-toggle="left"]');
  const terminal = page.locator('[data-terminal-drawer="left"]');
  await terminal.waitFor({ state: "visible", timeout: 15_000 });
  const textarea = terminal.locator(".xterm-helper-textarea");
  await textarea.waitFor({ state: "attached", timeout: 15_000 });
  await recordRect("terminalDrawer", '[data-terminal-drawer="left"]');
  await textarea.focus();
  await cursor(false);
  await page.waitForTimeout(300);
  await page.keyboard.type("Get-Location", { delay: 70 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1_300);
  mark("terminal-follow");
  await click(leftRow("04 Launch"), { double: true, settle: 1_100 });
  await textarea.focus();
  await cursor(false);
  await page.keyboard.type("Get-Content .\\release-checklist.md", { delay: 55 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2_300);
  await recordRect("terminalDrawerEnd", '[data-terminal-drawer="left"]');
  await click('[data-terminal-action="close"][data-pane="left"]');
  await goTo("left", fixture.left);
  await leftRow("README.md").click();
  await cursor(false);
  await page.waitForTimeout(700);

  // 8. Live AI context over the local MCP bridge.
  mark("ai-handoff");
  const sidecar = existsSync(path.join(localAppData, "ExploreBetter", "MCP", "bin", "ExploreBetterMcp.exe"))
    ? path.join(localAppData, "ExploreBetter", "MCP", "bin", "ExploreBetterMcp.exe")
    : repoSidecar;
  await fs.access(sidecar);
  const toolEvents = [];
  const onTool = (tool, phase, item) => {
    mark(`ai-${tool.replaceAll("_", "-")}-${phase}`);
    toolEvents.push({ tool, phase, seconds: markers.at(-1).seconds, ...(phase === "complete" ? summarizeCall(item) : {}) });
  };
  const codex = findCodexCli();
  let handoff;
  let codexError = null;
  if (codex) {
    try {
      handoff = await runCodexHandoff({ codex, sidecar, localAppData, fixtureRoot: fixture.left, onTool });
    } catch (error) {
      codexError = error.message;
      console.warn(`Codex handoff failed; falling back to the scripted MCP client. ${error.message}`);
    }
  }
  if (!handoff) {
    toolEvents.length = 0;
    handoff = await runScriptedHandoff({ sidecar, localAppData, fixtureRoot: fixture.left, onTool });
  }
  await page.waitForFunction(() => document.querySelector('[data-path-input="left"]')?.value?.endsWith("04 Launch"), null, { timeout: 15_000 }).catch(() => {});
  mark("ai-revealed");
  await recordRect("leftPane", '.pane[data-pane="left"]');
  await page.waitForTimeout(2_200);

  // 9. Scoped AI Bridge profile and its audit trail.
  mark("ai-bridge");
  await press("Control+P", "Ctrl + P");
  await page.locator("#command-dialog[open]").waitFor({ state: "visible", timeout: 10_000 });
  await page.keyboard.type("preferences", { delay: 80 });
  await page.waitForTimeout(500);
  await press("Enter");
  await page.locator("#preferences-dialog[open]").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const profileCount = document.querySelector("#preference-ai-profile")?.options.length || 0;
    const toolCount = document.querySelectorAll("#preference-ai-tools input").length;
    return Boolean(window.exploreBetterDesktop?.aiBridge) && profileCount > 0 && toolCount > 0;
  }, null, { timeout: 20_000 });
  await page.evaluate(() => document.querySelector(".ai-bridge-preferences")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  await page.waitForTimeout(900);
  mark("ai-bridge-profile");
  await recordRect("aiBridge", ".ai-bridge-preferences");
  await page.waitForTimeout(2_000);
  // Settings search narrows the section to its audit trail. (It also keeps the unpackaged
  // dev-build client snippet, which contains repository paths, out of frame.)
  await click("#preferences-search", { settle: 150 });
  await page.keyboard.type("audit", { delay: 110 });
  await page.waitForTimeout(500);
  const audit = page.locator(".ai-bridge-audit summary");
  await audit.waitFor({ state: "visible", timeout: 10_000 });
  await click(audit, { settle: 500 });
  const snippetVisible = await page.locator("#preference-ai-snippet").isVisible().catch(() => false);
  if (snippetVisible) throw new Error("The AI Bridge client snippet is still visible; it would show repository paths.");
  mark("ai-audit");
  await recordRect("aiAudit", ".ai-bridge-audit");
  await cursor(false);
  await page.waitForTimeout(3_200);
  mark("end");

  await client.send("Page.stopScreencast");
  await page.evaluate(() => clearInterval(window.__demoHeartbeat));
  await writeQueue;

  // Constant 30 fps from the real frame timestamps (screencast frames arrive irregularly).
  const concat = [];
  for (let index = 0; index < frames.length; index += 1) {
    const next = frames[index + 1]?.seconds ?? frames[index].seconds + 1 / output.fps;
    concat.push(`file '${frames[index].file.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`);
    concat.push(`duration ${Math.max(0.001, next - frames[index].seconds).toFixed(6)}`);
  }
  concat.push(`file '${frames.at(-1).file.replaceAll("\\", "/")}'`);
  const listPath = path.join(captureDir, "frames.txt");
  await fs.writeFile(listPath, `${concat.join("\n")}\n`);
  await run(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", `fps=${output.fps},scale=${source.width}:${source.height}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-profile:v", "high", "-movflags", "+faststart", outputPath
  ]);
  const duration = frames.at(-1).seconds;
  await fs.writeFile(tracePath, `${JSON.stringify({
    client: handoff.client,
    codexFallbackReason: codexError,
    prompt: aiPrompt(fixture.left),
    events: toolEvents,
    trace: handoff.trace
  }, null, 2)}\n`, "utf8");
  const manifest = {
    capturedAt: new Date().toISOString(),
    durationSeconds: Number(duration.toFixed(3)),
    sourceFrames: frames.length,
    sourceRate: Number((frames.length / duration).toFixed(3)),
    outputFrameRate: output.fps,
    viewport: `${viewport.width}x${viewport.height}@${viewport.scale.toFixed(4)}`,
    resolution: `${source.width}x${source.height}`,
    editSpace: `${output.width}x${output.height}`,
    demoRoot,
    aiClient: handoff.client,
    markers,
    keys,
    rects,
    texts,
    aiEvents: toolEvents,
    output: path.relative(root, outputPath),
    aiTrace: path.relative(root, tracePath)
  };
  await fs.writeFile(path.join(captureDir, "capture-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rm(frameDir, { recursive: true, force: true });
  await fs.rm(listPath, { force: true });
  console.log(JSON.stringify({ ...manifest, markers: markers.length, keys: keys.length }, null, 2));
} catch (error) {
  throw new Error(`${error.stack || error.message}\n${logs.slice(-4000)}`);
} finally {
  await browser?.close().catch(() => {});
  if (app.exitCode === null) spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await sleep(800);
  if (existsSync(markerFile)) await fs.rm(demoRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch((error) => console.warn(`Could not remove ${demoRoot}: ${error.message}`));
}
